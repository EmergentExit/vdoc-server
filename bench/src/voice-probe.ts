/**
 * Voice front-end probe: plays the same synthesized Mandarin utterances, at real-time speed, into a voice
 * model and measures what the user would notice, from the end of their speech:
 *   - transcript: when the final words arrive and their character error rate against the script;
 *   - first audio: when the model starts to answer aloud;
 *   - delegation (GPT-Live-1 only): whether, and when, it hands the turn to our backend.
 * Every utterance gets a fresh session, so no turn leans on another.
 *
 *   npx tsx bench/src/voice-probe.ts --target live|boson [--limit 36] [--out bench/results/voice-live.jsonl]
 *
 * Speech is synthesized once with OpenAI gpt-4o-mini-tts and cached in bench/.cache/tts (24 kHz PCM16 mono).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { boson } from '@vrealtime/boson';
import { arg } from './cli';
import { mean, median, quantile } from './stats';

interface Utterance { id: string; label: 'act' | 'discuss' | 'chat'; text: string }
interface Probe {
  transcript: string; transcriptMs?: number; firstAudioMs?: number; delegatedMs?: number; reply: string; error?: string;
  /** Transcript items the utterance was split into (Boson). */
  items?: number;
}

if (existsSync('.env')) process.loadEnvFile('.env');
const target = arg('target') ?? 'live';
const limit = Number(arg('limit') ?? 36);
const out = arg('out') ?? `bench/results/voice-${target}.jsonl`;
const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) throw new Error('OPENAI_API_KEY is required (speech synthesis, and GPT-Live).');

const RATE = 24000, CHUNK_MS = 20, CHUNK_BYTES = RATE * 2 * CHUNK_MS / 1000;
/** After the user stops: how long we keep listening (sending silence) before the turn is scored. */
const LISTEN_MS = 8000;

function utterances(): Utterance[] {
  const rows = readFileSync(resolve('bench/tasks/routing.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { id: string; label: Utterance['label']; utterance: string });
  const pick = (label: Utterance['label'], n: number) => rows.filter(r => r.label === label && /[一-鿿]/.test(r.utterance)).slice(0, n).map(r => ({ id: r.id, label, text: r.utterance }));
  return [...pick('act', Math.round(limit / 2)), ...pick('discuss', Math.round(limit / 3)), ...pick('chat', limit - Math.round(limit / 2) - Math.round(limit / 3))];
}

async function speech(u: Utterance): Promise<Uint8Array> {
  const dir = resolve('bench/.cache/tts'), file = resolve(dir, `${u.id}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dir, { recursive: true });
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'coral', input: u.text, response_format: 'pcm', instructions: '用自然的普通话口语说，像在对电脑里的助手说话。' }),
  });
  if (!response.ok) throw new Error(`TTS ${response.status}: ${await response.text()}`);
  const pcm = new Uint8Array(await response.arrayBuffer());
  writeFileSync(file, pcm);
  return pcm;
}

/** Byte offset just past the last 20 ms chunk that is louder than near-silence: synthesized speech ends with a quiet tail. */
function voicedEnd(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  for (let end = view.byteLength; end > 0; end -= CHUNK_BYTES) {
    const start = Math.max(0, end - CHUNK_BYTES);
    let sum = 0;
    for (let i = start; i < end; i += 2) { const v = view.getInt16(i, true); sum += v * v; }
    if (Math.sqrt(sum / ((end - start) / 2)) > 300) return end;
  }
  return 0;
}

/** Sends `pcm` in 20 ms chunks at real-time speed, then silence until `stop` resolves; `speechEnd` is when its last voiced chunk went out. */
function play(pcm: Uint8Array, send: (chunk: Uint8Array) => void, stop: Promise<unknown>): { speechEnd: Promise<number> } {
  const lead = new Uint8Array(CHUNK_BYTES * 15); // 300 ms of silence before speaking
  const audio = new Uint8Array(lead.length + pcm.length + (pcm.length % 2));
  audio.set(lead); audio.set(pcm, lead.length);
  const voiced = lead.length + voicedEnd(pcm);
  let stopped = false; void stop.then(() => { stopped = true; });
  const speechEnd = new Promise<number>(resolveEnd => {
    const started = performance.now();
    let sent = 0, ended = false;
    const tick = () => {
      if (stopped) return;
      const due = Math.floor((performance.now() - started) / CHUNK_MS) + 1;
      while (sent < due) {
        const offset = sent * CHUNK_BYTES;
        send(offset < audio.length ? audio.subarray(offset, Math.min(offset + CHUNK_BYTES, audio.length)) : new Uint8Array(CHUNK_BYTES));
        sent++;
        if (!ended && (sent * CHUNK_BYTES) >= voiced) { ended = true; resolveEnd(performance.now()); }
      }
      setTimeout(tick, CHUNK_MS / 2);
    };
    tick();
  });
  return { speechEnd };
}

const LIVE_INSTRUCTIONS = `你是一个中文语音写作助手，用户正在编辑一篇文档（常常是论文）。用自然、简短的中文口语交流。
文档的任何修改（写、加、删、改、替换、润色、翻译、排版、移动、列表、表格、撤销）以及需要看文档内容才能回答的问题，都委派给后台；委派时只说一句很短的确认，比如"好，我来改"，不要自己编内容，也不要说已经完成。
闲聊直接用一句话回答。`;

async function probeLive(pcm: Uint8Array): Promise<Probe> {
  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { authorization: `Bearer ${openaiKey}` } });
  const result: Probe = { transcript: '', reply: '' };
  let finish!: () => void;
  const finished = new Promise<void>(r => { finish = r; });
  let speechEndAt = Infinity, lastTranscriptAt = 0, firstAudioAt = 0, delegatedAt = 0;
  ws.on('message', raw => {
    const event = JSON.parse(String(raw)) as { type: string; delta?: string; error?: { message: string; code: string } };
    const now = performance.now();
    if (event.type === 'session.input_transcript.delta') { result.transcript += event.delta ?? ''; lastTranscriptAt = now; }
    else if (event.type === 'session.output_transcript.delta') result.reply += event.delta ?? '';
    // A full-duplex model streams audio all the time; the answer starts at its first audible chunk after the user stopped.
    else if (event.type === 'session.output_audio.delta' && !firstAudioAt && now > speechEndAt && loud(Buffer.from(event.delta ?? '', 'base64'))) firstAudioAt = now;
    else if (event.type === 'session.delegation.created' && !delegatedAt) delegatedAt = now;
    else if (event.type === 'error') { result.error = `${event.error?.code}: ${event.error?.message}`; finish(); }
    else if (event.type === 'session.started') started();
  });
  ws.on('error', error => { result.error = String(error); finish(); });
  ws.on('close', () => finish());
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'session.start', session: { model: 'gpt-live-1', instructions: LIVE_INSTRUCTIONS, audio: { format: { type: 'audio/pcm', rate: RATE } }, delegation: { type: 'client' } } }));
  await Promise.race([ready, finished]);
  if (result.error) { ws.close(); return result; }
  const { speechEnd } = play(pcm, chunk => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.from(chunk).toString('base64') })); }, finished);
  speechEndAt = await speechEnd;
  setTimeout(finish, LISTEN_MS);
  await finished;
  if (lastTranscriptAt) result.transcriptMs = Math.round(lastTranscriptAt - speechEndAt);
  if (firstAudioAt) result.firstAudioMs = Math.round(firstAudioAt - speechEndAt);
  if (delegatedAt) result.delegatedMs = Math.round(delegatedAt - speechEndAt);
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'session.close' }));
  setTimeout(() => ws.terminate(), 1000);
  return result;
}

async function probeBoson(pcm: Uint8Array): Promise<Probe> {
  const apiKey = process.env.BOSON_API_KEY;
  if (!apiKey) throw new Error('BOSON_API_KEY is required.');
  const session = await boson({ apiKey }).connect({ instructions: '你是一个中文语音写作助手。用一两句自然的中文口语回答。', turnDetection: 'server', voice: 'default', inputTranscription: { language: 'zh' } });
  const result: Probe = { transcript: '', reply: '' };
  let finish!: () => void;
  const finished = new Promise<void>(r => { finish = r; });
  let speechEndAt = Infinity, transcriptAt = 0, firstAudioAt = 0;
  // Boson can split one utterance into several items at pauses: the user's words are all of them, in order.
  const items = new Map<string, string>();
  session.on('input.transcript', e => { items.set(e.itemId, e.text); result.transcript = [...items.values()].join(''); if (e.final) transcriptAt = performance.now(); });
  session.on('output.transcript', e => { result.reply += e.delta; });
  session.on('output.audio', e => { if (!firstAudioAt && performance.now() > speechEndAt && loud(e.chunk.data)) firstAudioAt = performance.now(); });
  session.on('error', e => { if (!e.recoverable) { result.error = e.error.message; finish(); } });
  const format = { encoding: 'pcm16' as const, sampleRate: RATE as 24000, channels: 1 as const };
  const { speechEnd } = play(pcm, data => session.sendAudio({ data, format }), finished);
  speechEndAt = await speechEnd;
  setTimeout(finish, LISTEN_MS);
  await finished;
  if (transcriptAt) result.transcriptMs = Math.round(transcriptAt - speechEndAt);
  if (firstAudioAt) result.firstAudioMs = Math.round(firstAudioAt - speechEndAt);
  result.items = items.size;
  await session.close().catch(() => {});
  return result;
}

/** Whether a PCM16 chunk is louder than near-silence. */
function loud(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength - (data.byteLength % 2));
  let sum = 0;
  for (let i = 0; i < view.byteLength; i += 2) { const v = view.getInt16(i, true); sum += v * v; }
  return Math.sqrt(sum / (view.byteLength / 2)) > 300;
}

/** Character error rate on Han characters, letters and digits only (punctuation and spaces ignored). */
function cer(reference: string, hypothesis: string): number {
  const norm = (s: string) => [...s.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '')];
  const a = norm(reference), b = norm(hypothesis);
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return a.length ? row[b.length]! / a.length : 0;
}

const rows: (Probe & { id: string; label: string; cer: number })[] = [];
for (const u of utterances()) {
  const pcm = await speech(u);
  const probe = target === 'boson' ? await probeBoson(pcm) : await probeLive(pcm);
  const row = { id: u.id, label: u.label, text: u.text, ...probe, cer: cer(u.text, probe.transcript) };
  rows.push(row);
  appendFileSync(out, `${JSON.stringify({ target, ...row })}\n`);
  console.log(`${u.id} ${u.label.padEnd(7)} cer=${row.cer.toFixed(2)} transcript=${probe.transcriptMs ?? '—'}ms audio=${probe.firstAudioMs ?? '—'}ms${target === 'live' ? ` delegated=${probe.delegatedMs ?? 'no'}` : ''}${probe.error ? ` ERROR ${probe.error}` : ''} | ${probe.transcript} → ${probe.reply.slice(0, 60)}`);
}

const ok = rows.filter(r => !r.error);
const ms = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? `${Math.round(median(v))} / ${Math.round(quantile(v, 0.9))} (n=${v.length})` : '—'; };
console.log(`\n${target}: ${ok.length}/${rows.length} sessions ok`);
console.log(`character error rate mean ${(mean(ok.map(r => r.cer)) * 100).toFixed(1)}%, exact ${ok.filter(r => r.cer === 0).length}/${ok.length}`);
console.log(`final transcript after speech end, median / p90 ms: ${ms(ok.map(r => r.transcriptMs))}`);
console.log(`first answer audio after speech end, median / p90 ms: ${ms(ok.map(r => r.firstAudioMs))}`);
if (target === 'boson') console.log(`utterances split into more than one transcript item: ${ok.filter(r => (r.items ?? 1) > 1).length}/${ok.length}`);
if (target === 'live') {
  for (const label of ['act', 'discuss', 'chat']) {
    const group = ok.filter(r => r.label === label);
    console.log(`${label}: delegated ${group.filter(r => r.delegatedMs !== undefined).length}/${group.length}, delegation after speech end ${ms(group.map(r => r.delegatedMs))}`);
  }
}
