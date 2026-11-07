import { expect, it } from 'vitest';
import type { AudioChunk, RealtimeEvent, Vad } from '@vrealtime/core';
import type { ProviderSocket } from '@vrealtime/openai-compatible';
import { audible, gptLive, pieces } from '../src/providers/gpt-live';

const PCM = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;
const tone = (value: number): Uint8Array => { const data = new Uint8Array(960); for (let i = 0; i < 480; i++) { data[2 * i] = value & 0xff; data[2 * i + 1] = (value >> 8) & 0xff; } return data; };
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

/** A socket that is already open, records what is sent and lets the test play server events. */
function fakeSocket() {
  const listeners = new Map<string, ((event: { data?: unknown; code?: number }) => void)[]>();
  const sent: Record<string, unknown>[] = [];
  const socket: ProviderSocket = {
    readyState: 1,
    send: data => { sent.push(JSON.parse(data) as Record<string, unknown>); },
    close: () => {},
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  const receive = (event: Record<string, unknown>) => { for (const listener of listeners.get('message') ?? []) listener({ data: JSON.stringify(event) }); };
  return { socket, sent, receive };
}
/** A VAD that reports exactly the edges the test queues. */
function scriptedVad() {
  const edges: ('start' | 'end' | undefined)[] = [];
  let speaking = false;
  const vad: Vad = { process: () => { const edge = edges.shift(); if (edge) speaking = edge === 'start'; return edge; }, get speaking() { return speaking; }, reset: () => {} };
  return { factory: () => vad, edges };
}

async function connect() {
  const { socket, sent, receive } = fakeSocket();
  const { factory, edges } = scriptedVad();
  const connecting = gptLive({ apiKey: 'test', socket: () => socket, vad: factory }).connect({ instructions: 'Voice instructions.' });
  await Promise.resolve();
  receive({ type: 'session.started', session: { id: 'live_0' } });
  const session = await connecting;
  const events: RealtimeEvent[] = [];
  for (const type of ['session.ready', 'input.speech.start', 'input.speech.end', 'input.transcript', 'response.start', 'output.audio', 'output.transcript', 'response.end'] as const) session.on(type, event => events.push(event));
  const audio = (data = tone(0)): AudioChunk => ({ data, format: PCM });
  return { session, sent, receive, edges, events, audio };
}

it('starts GPT-Live with our instructions, client delegation and 24 kHz PCM, and forwards audio', async () => {
  const h = await connect();
  expect(h.sent[0]).toEqual({ type: 'session.start', session: { model: 'gpt-live-1', instructions: 'Voice instructions.', audio: { format: { type: 'audio/pcm', rate: 24000 } }, delegation: { type: 'client' } } });
  await expect.poll(() => h.events).toEqual([{ type: 'session.ready', sessionId: 'live_0' }]);
  h.session.sendAudio(h.audio(tone(2000)));
  expect(h.sent[1]).toEqual({ type: 'session.input_audio.append', audio: b64(tone(2000)) });
});

it('marks where the user spoke and makes the transcript final once no words have come for a while of audio', async () => {
  const h = await connect();
  const silence = (ms: number) => { for (let t = 0; t < ms; t += 20) h.session.sendAudio(h.audio()); };
  h.edges.push('start');
  silence(400);
  h.receive({ type: 'session.input_transcript.delta', delta: '把第二段', start_ms: 0, end_ms: 400 });
  // The VAD loses a soft last syllable: its end comes before the last word.
  h.edges.push('end');
  silence(400);
  h.receive({ type: 'session.input_transcript.delta', delta: '删掉', start_ms: 400, end_ms: 600 });
  silence(600);
  expect(h.events.map(e => e.type)).toEqual(['input.speech.start', 'input.transcript', 'input.speech.end', 'input.transcript']);
  silence(60);
  expect(h.events.at(-1)).toEqual({ type: 'input.transcript', itemId: 'live-utterance-1', text: '把第二段删掉', final: true });
});

it('still makes a turn of words the VAD never noticed, and ends noise that brought no words', async () => {
  const h = await connect();
  const silence = (ms: number) => { for (let t = 0; t < ms; t += 20) h.session.sendAudio(h.audio()); };
  h.receive({ type: 'session.input_transcript.delta', delta: '你好', start_ms: 0, end_ms: 200 });
  silence(1000);
  expect(h.events.map(e => e.type)).toEqual(['input.transcript', 'input.speech.start', 'input.speech.end', 'input.transcript']);
  expect(h.events.at(-1)).toMatchObject({ text: '你好', final: true });
  h.edges.push('start'); silence(20); h.edges.push('end'); silence(2100);
  expect(h.events.at(-1)).toEqual({ type: 'input.transcript', itemId: 'live-utterance-2', text: '', final: true });
});

it('turns each stretch of audible output into one response and drops the silence between them', async () => {
  const h = await connect();
  h.receive({ type: 'session.output_audio.delta', delta: b64(tone(0)) });
  expect(h.events).toEqual([]);
  h.receive({ type: 'session.output_audio.delta', delta: b64(tone(3000)) });
  h.receive({ type: 'session.output_transcript.delta', delta: '好，我来改。' });
  h.receive({ type: 'session.output_audio.delta', delta: b64(tone(0)) });
  expect(h.events.map(e => e.type)).toEqual(['response.start', 'output.audio', 'output.transcript', 'output.audio']);
  await expect.poll(() => h.events.at(-1)).toEqual({ type: 'response.end', responseId: 'live-reply-1', status: 'done', stopReason: 'completed' });
  h.receive({ type: 'session.output_audio.delta', delta: b64(tone(3000)) });
  expect(h.events.at(-2)).toEqual({ type: 'response.start', responseId: 'live-reply-2' });
});

it('ends the reply as interrupted when the user starts talking over it', async () => {
  const h = await connect();
  h.receive({ type: 'session.output_audio.delta', delta: b64(tone(3000)) });
  h.edges.push('start');
  h.session.sendAudio(h.audio());
  expect(h.events.slice(-2)).toEqual([{ type: 'response.end', responseId: 'live-reply-1', status: 'interrupted', stopReason: 'cancelled' }, { type: 'input.speech.start', atMs: 0 }]);
});

it('hands text to say as commentary, answering the oldest open delegation, in pieces GPT-Live accepts', async () => {
  const h = await connect();
  h.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
  h.session.sendText('已把第二段删掉。');
  h.session.sendText('第三章可以分两节。');
  expect(h.sent.slice(1)).toEqual([
    { type: 'session.commentary.append', delegation_id: 'del_1', content: '已把第二段删掉。' },
    { type: 'session.commentary.append', delegation_id: null, content: '第三章可以分两节。' },
  ]);
  expect(pieces('一二三。四五六。七八九十。', 7)).toEqual(['一二三。', '四五六。', '七八九十。']);
  expect(pieces('一二三四五六七八九十', 4)).toEqual(['一二三四', '五六七八', '九十']);
  expect(audible(tone(0))).toBe(false);
  expect(audible(tone(3000))).toBe(true);
});
