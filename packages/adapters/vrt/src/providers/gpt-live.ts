import { defaultSocketFactory, type ProviderSocket, type SocketFactory } from '@vrealtime/openai-compatible';
import { Emitter, RealtimeError, type AudioChunk, type Capabilities, type RealtimeEvent, type RealtimeModel, type RealtimeSession, type VadFactory } from '@vrealtime/core';
import { energyVad } from '@vrealtime/vad';

export const GPT_LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const PCM24 = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;

export const GPT_LIVE_CAPABILITIES: Capabilities = {
  input: { audio: true, text: true, formats: [PCM24] },
  output: { audio: true, text: false, formats: [PCM24] },
  turnDetection: { server: true, semantic: false, manual: false },
  inputTranscription: true,
  tools: { calls: false, argumentStreaming: false, autoReplyAfterResult: false },
  truncate: false,
  midSessionUpdate: { instructions: false, tools: false },
};

/**
 * An utterance is over once this much audio has gone out since its last word arrived. Words, not the
 * VAD, decide: the VAD can lose a soft last syllable. Arrival, not the words' own timestamps: GPT-Live's
 * timeline runs about half a second behind the audio we have sent, and words arrive up to ~0.45 s apart.
 */
const WORDS_DONE_MS = 650;
/** Speech the VAD heard but no words came for, this long after it stopped: noise. */
const NO_WORDS_MS = 2000;
/** The voice's reply is over after this much inaudible output. */
const REPLY_GAP_MS = 700;
/** GPT-Live takes at most 500 tokens per append; Chinese runs about one token a character, so stay well under. */
const APPEND_CHARS = 400;

export interface GptLiveOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  /** On Cloudflare Workers pass `fetchSocket()`: headers need a fetch upgrade. */
  socket?: SocketFactory;
  /** Finds where the user starts and stops talking; GPT-Live itself reports neither. */
  vad?: VadFactory;
}

/**
 * GPT-Live-1 as the voice of the assistant: a full-duplex model that listens, answers small talk and
 * says what it is given, while our server does the work. Its own delegation is not relied on: the
 * server starts work from the transcript. This adapter turns its continuous streams into the turn
 * events vRealTime expects:
 *   - user speech start and end come from a local VAD over the audio we forward;
 *   - the transcript of an utterance is final once the user stopped and its words settled;
 *   - each stretch of audible output becomes one response, ended by a short silence;
 *   - `sendText` hands GPT-Live words to say (commentary), answering its open delegation if any.
 */
export function gptLive(options: GptLiveOptions): RealtimeModel {
  return {
    provider: 'gpt-live', id: options.model ?? 'gpt-live-1', capabilities: GPT_LIVE_CAPABILITIES,
    async connect(config) {
      const socket = await (options.socket ?? defaultSocketFactory)(GPT_LIVE_URL, { Authorization: `Bearer ${options.apiKey}` });
      const emitter = new Emitter<RealtimeEvent>();
      const vad = (options.vad ?? energyVad())();
      let closed = false;
      const emit = (event: RealtimeEvent) => { if (!closed) emitter.emit(event); };
      const send = (event: Record<string, unknown>) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };

      let utterance = 0;
      /** Input audio sent so far, in ms: GPT-Live's timeline for the words it transcribes. */
      let sentMs = 0;
      /** The utterance being heard: its words so far, where the last one ended, and whether we told the runtime it began and ended. */
      let heard: { itemId: string; text: string; lastWordMs: number; stoppedMs?: number; started: boolean; ended: boolean; final: boolean } | undefined;
      /** Finalizes on wall time too, for when audio stops coming (the user paused the microphone). */
      let doneTimer: ReturnType<typeof setTimeout> | undefined;
      const fresh = () => ({ itemId: `live-utterance-${++utterance}`, text: '', lastWordMs: sentMs, started: false, ended: false, final: false });
      const finalize = () => {
        clearTimeout(doneTimer); doneTimer = undefined;
        if (!heard || heard.final) return;
        heard.final = true;
        // Words the VAD never noticed still make a turn: the runtime needs its start and end.
        if (!heard.started) { heard.started = true; emit({ type: 'input.speech.start', atMs: 0 }); }
        if (!heard.ended) { heard.ended = true; emit({ type: 'input.speech.end', atMs: 0 }); }
        emit({ type: 'input.transcript', itemId: heard.itemId, text: heard.text.trim(), final: true });
      };
      /** Whether the utterance is over: its words stopped a while ago (or none came after the VAD stopped). */
      const check = () => {
        if (!heard || heard.final || vad.speaking) return;
        if (heard.text ? sentMs - heard.lastWordMs >= WORDS_DONE_MS : heard.stoppedMs !== undefined && sentMs - heard.stoppedMs >= NO_WORDS_MS) finalize();
      };
      const armTimer = () => {
        clearTimeout(doneTimer);
        doneTimer = setTimeout(() => { if (heard && !heard.final && heard.text && !vad.speaking) finalize(); }, WORDS_DONE_MS + 500);
      };

      let reply = 0;
      /** The reply being spoken, and when it last made a sound. */
      let speaking: { responseId: string; itemId: string; lastSoundAt: number } | undefined;
      let gapTimer: ReturnType<typeof setTimeout> | undefined;
      const endReply = (status: 'done' | 'interrupted') => {
        clearTimeout(gapTimer); gapTimer = undefined;
        const current = speaking; speaking = undefined;
        if (current) emit({ type: 'response.end', responseId: current.responseId, status, stopReason: status === 'done' ? 'completed' : 'cancelled' });
      };
      /** The reply output belongs to, opened on demand; sound (or words) keeps it open a while longer. */
      const openReply = (sound: boolean) => {
        if (!speaking) {
          const n = ++reply;
          speaking = { responseId: `live-reply-${n}`, itemId: `live-reply-${n}-audio`, lastSoundAt: Date.now() };
          emit({ type: 'response.start', responseId: speaking.responseId });
          sound = true;
        }
        if (sound) {
          speaking.lastSoundAt = Date.now();
          clearTimeout(gapTimer);
          gapTimer = setTimeout(() => endReply('done'), REPLY_GAP_MS);
        }
        return speaking;
      };
      /** Delegations GPT-Live opened and nobody answered yet, oldest first. */
      const delegations: string[] = [];

      // Audio sent before `session.started` is dropped, which would shift its word timeline against ours.
      let started!: () => void;
      let sessionId = 'gpt-live';
      const ready = new Promise<void>(resolve => { started = resolve; });
      socket.addEventListener('message', message => {
        let event: { type?: string; delta?: string; delegation?: { id?: string }; error?: { message?: string; code?: string } };
        try { event = JSON.parse(String(message.data)); } catch { return; }
        switch (event.type) {
          case 'session.started': sessionId = (event as { session?: { id?: string } }).session?.id ?? 'gpt-live'; started(); break;
          case 'session.input_transcript.delta': {
            if (!heard || heard.final) heard = fresh();
            heard.text += event.delta ?? '';
            heard.lastWordMs = sentMs;
            emit({ type: 'input.transcript', itemId: heard.itemId, text: heard.text, final: false });
            armTimer();
            break;
          }
          case 'session.output_audio.delta': {
            const data = base64ToBytes(event.delta ?? '');
            const sound = audible(data);
            // Between replies the stream is silence: nothing to play.
            if (!speaking && !sound) break;
            const current = openReply(sound);
            emit({ type: 'output.audio', responseId: current.responseId, itemId: current.itemId, chunk: { data, format: PCM24 } });
            break;
          }
          case 'session.output_transcript.delta': {
            const current = openReply(true);
            emit({ type: 'output.transcript', responseId: current.responseId, itemId: current.itemId, delta: event.delta ?? '' });
            break;
          }
          case 'session.delegation.created': if (event.delegation?.id) delegations.push(event.delegation.id); break;
          case 'error': emit({ type: 'error', error: new RealtimeError('provider', event.error?.message ?? 'GPT-Live error', { providerCode: event.error?.code ?? 'error' }), recoverable: true }); break;
        }
      });
      socket.addEventListener('close', event => {
        if (closed) return;
        closed = true;
        emitter.emit({ type: 'error', error: new RealtimeError('connection', `GPT-Live closed (${event.code ?? ''})`), recoverable: false });
      });
      await opened(socket);
      send({ type: 'session.start', session: {
        model: options.model ?? 'gpt-live-1',
        ...(config.instructions ? { instructions: config.instructions } : {}),
        audio: { format: { type: 'audio/pcm', rate: 24000 }, ...(options.voice ? { output: { voice: options.voice } } : {}) },
        delegation: { type: 'client' },
      } });
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new RealtimeError('connection', 'GPT-Live did not start')), 15_000))]);

      const session: RealtimeSession = {
        capabilities: GPT_LIVE_CAPABILITIES,
        async update() { /* GPT-Live fixes its configuration at startup. */ },
        sendAudio(chunk: AudioChunk) {
          sentMs += chunk.format.encoding === 'pcm16' ? chunk.data.length / 2 / chunk.format.channels / chunk.format.sampleRate * 1000 : 0;
          const edge = vad.process(chunk);
          if (edge === 'start') {
            // Speaking again before the last words were final continues the same utterance.
            if (!heard || heard.final) heard = fresh();
            delete heard.stoppedMs;
            // The user talking over the reply: GPT-Live stops on its own; what was being said is over.
            if (speaking) endReply('interrupted');
            if (!heard.started) { heard.started = true; emit({ type: 'input.speech.start', atMs: 0 }); }
          } else if (edge === 'end' && heard && !heard.final) {
            heard.stoppedMs = sentMs;
            if (!heard.ended) { heard.ended = true; emit({ type: 'input.speech.end', atMs: 0 }); }
          }
          check();
          for (let offset = 0; offset < chunk.data.length; offset += 96_000) {
            send({ type: 'session.input_audio.append', audio: bytesToBase64(chunk.data.subarray(offset, Math.min(offset + 96_000, chunk.data.length))) });
          }
        },
        commitAudio() {},
        clearAudio() {},
        /** Words for GPT-Live to say, in its own voice and phrasing. */
        sendText(text: string) {
          const delegationId = delegations.shift() ?? null;
          for (const part of pieces(text, APPEND_CHARS)) send({ type: 'session.commentary.append', delegation_id: delegationId, content: part });
        },
        respond() {},
        submitToolResult() { /* No tools: the server does the work. */ },
        cancel() { if (speaking) endReply('interrupted'); },
        truncate() {},
        on: (type, listener) => emitter.on(type, listener),
        async close() {
          if (closed) return;
          closed = true;
          clearTimeout(doneTimer); clearTimeout(gapTimer);
          send({ type: 'session.close' });
          emitter.clear();
          setTimeout(() => socket.close(1000), 500);
        },
      };
      // Ready once the caller can listen for it.
      setTimeout(() => emit({ type: 'session.ready', sessionId }), 0);
      return session;
    },
  };
}

function opened(socket: ProviderSocket): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new RealtimeError('connection', 'GPT-Live connection failed')));
    socket.addEventListener('close', event => reject(new RealtimeError(event.code === 1008 ? 'auth' : 'connection', `GPT-Live closed before opening (${event.code ?? ''})`)));
  });
}

/** Splits text at sentence ends into pieces of at most `max` characters. */
export function pieces(text: string, max: number): string[] {
  const sentences = text.match(/[^。！？!?.\n]+[。！？!?.\n]*/g) ?? [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > max) { out.push(current); current = ''; }
    for (let start = 0; start < sentence.length; start += max) {
      const slice = sentence.slice(start, start + max);
      if (current.length + slice.length > max) { out.push(current); current = ''; }
      current += slice;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Louder than near-silence (PCM16 RMS above 300). */
export function audible(data: Uint8Array): boolean {
  const samples = data.length >> 1;
  if (!samples) return false;
  let sum = 0;
  for (let i = 0; i < samples; i++) { const v = (data[2 * i]! | data[2 * i + 1]! << 8) << 16 >> 16; sum += v * v; }
  return Math.sqrt(sum / samples) > 300;
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
