/**
 * Synthesized user speech for voice runs: OpenAI gpt-4o-mini-tts, 24 kHz PCM16 mono, cached by text
 * in bench/.cache/tts so every system hears exactly the same audio.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SPEECH_RATE = 24000;
export const CHUNK_MS = 20;
export const CHUNK_BYTES = SPEECH_RATE * 2 * CHUNK_MS / 1000;

export async function speak(text: string, apiKey = process.env.OPENAI_API_KEY): Promise<Uint8Array> {
  const dir = resolve('bench/.cache/tts'), file = resolve(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to synthesize speech.');
  mkdirSync(dir, { recursive: true });
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'coral', input: text, response_format: 'pcm', instructions: '用自然的普通话口语说，像在对电脑里的助手说话。' }),
  });
  if (!response.ok) throw new Error(`TTS ${response.status}: ${await response.text()}`);
  const pcm = new Uint8Array(await response.arrayBuffer());
  writeFileSync(file, pcm);
  return pcm;
}

/** Byte offset just past the last 20 ms chunk louder than near-silence: synthesized speech ends with a quiet tail. */
export function voicedEnd(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  for (let end = view.byteLength; end > 0; end -= CHUNK_BYTES) {
    const start = Math.max(0, end - CHUNK_BYTES);
    let sum = 0;
    for (let i = start; i < end; i += 2) { const v = view.getInt16(i, true); sum += v * v; }
    if (Math.sqrt(sum / ((end - start) / 2)) > 300) return end;
  }
  return 0;
}

/**
 * A microphone that never stops: 20 ms frames at real-time speed, silence unless something is being said.
 * `say` queues speech and resolves when its last voiced frame has gone out.
 */
export function microphone(send: (frame: Uint8Array) => void) {
  const queue: { audio: Uint8Array; voiced: number; sent: number; done: (at: number) => void }[] = [];
  const started = performance.now();
  let frames = 0, stopped = false;
  const silence = new Uint8Array(CHUNK_BYTES);
  const tick = () => {
    if (stopped) return;
    const due = Math.floor((performance.now() - started) / CHUNK_MS) + 1;
    while (frames < due) {
      const current = queue[0];
      if (!current) { send(silence); frames++; continue; }
      const frame = new Uint8Array(CHUNK_BYTES);
      frame.set(current.audio.subarray(current.sent, Math.min(current.sent + CHUNK_BYTES, current.audio.length)));
      send(frame); frames++;
      current.sent += CHUNK_BYTES;
      if (current.sent >= current.voiced && current.done !== noop) { current.done(performance.now()); current.done = noop; }
      if (current.sent >= current.audio.length) queue.shift();
    }
    setTimeout(tick, CHUNK_MS / 2);
  };
  tick();
  return {
    say: (audio: Uint8Array) => new Promise<number>(done => { queue.push({ audio, voiced: Math.max(CHUNK_BYTES, voicedEnd(audio)), sent: 0, done }); }),
    stop: () => { stopped = true; },
  };
}
const noop = () => {};
