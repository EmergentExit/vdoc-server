import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FakeResponder } from '@vdoc-server/adapter-vrt';
import { JsonLogger } from '@vdoc-server/adapter-system';
import { loadConfig } from '@vdoc-server/config';
import type { DomainEvent } from '@vdoc-server/domain';
import { connect, type ClientSession } from '@vrealtime/client';
import { createNodeServer } from '../../apps/node/src/create';
import { startNodeServer } from '../../apps/node/src/node-server';
import { score, type Score } from './checker';
import type { SystemConfig } from './configs';
import type { VdocHost } from './host/client';
import { alignedS2Registry } from './s2-aligned';
import { modelRequests } from './model-requests';
import type { Bench, Doc, Task } from './neutral';
import { microphone } from './tts';

const CLIENT_KEY = 'vdocs-bench-client-key-0123456789';
/** README §3.3: from the moment the text is sent. */
export const TIMEOUTS = { edit: 60_000, writing: 180_000 };
/** Quiet time that ends a turn: idle, no running tool call. */
const SETTLE_MS = 1500;
/** README §3.3: observe this long after the end and read the document again. */
const LATE_WRITE_MS = 2000;
/** Governance asks the user before high-risk edits; the harness answers like a user who agrees, at most this often per run. */
const MAX_CONFIRMATIONS = 2;

interface Timed<T> { at: number; value: T }

/** One running server for one configuration, reached over real HTTP and WebSocket like vdoc's browser client. */
export class ConfiguredServer {
  readonly events: Timed<DomainEvent>[] = [];
  readonly logs: Timed<Record<string, unknown>>[] = [];
  private constructor(readonly config: SystemConfig, private readonly base: string, readonly close: () => Promise<void>) {}

  static async start(config: SystemConfig, baseEnv: Record<string, string | undefined>, fakeResponder?: FakeResponder): Promise<ConfiguredServer> {
    if (config.missing) throw new Error(`${config.id} needs ${config.missing}; it cannot run yet.`);
    const loaded = loadConfig({ ...baseEnv, ...config.env, VDOC_SERVER_ENV: 'test', VDOC_SERVER_CLIENTS: `vdocs-bench:${CLIENT_KEY}`, VDOC_SERVER_LOG_LEVEL: 'debug' });
    if (!loaded.ok) throw new Error(`${config.id}: ${loaded.errors.join('; ')}`);
    const holder: { server?: ConfiguredServer } = {};
    const record = { async publish(events: readonly DomainEvent[]) { const at = performance.now(); for (const value of events) holder.server?.events.push({ at, value }); } };
    const logger = new JsonLogger('debug', line => { try { holder.server?.logs.push({ at: performance.now(), value: JSON.parse(line) }); } catch { /* not JSON */ } });
    const models = config.variant === 's2-aligned' ? { models: alignedS2Registry(loaded.value.providerKeys) } : {};
    const server = await createNodeServer(loaded.value, { logger, subscribers: [record], telemetrySubscribers: [record], ...models, ...(fakeResponder ? { fakeResponder } : {}) });
    const running = await startNodeServer(server, { port: 0 });
    holder.server = new ConfiguredServer(config, `127.0.0.1:${running.port}`, running.close);
    return holder.server;
  }

  async open(documentId: string, host: VdocHost, title: string, language: string): Promise<ClientSession> {
    const response = await fetch(`http://${this.base}/v1/documents/${documentId}/voice-sessions`, { method: 'POST', headers: { authorization: `Bearer ${CLIENT_KEY}` } });
    if (response.status !== 201) throw new Error(`voice session: HTTP ${response.status} ${await response.text()}`);
    const granted = await response.json() as { grant: { token: string }; realtimePath: string };
    return connect(`ws://${this.base}${granted.realtimePath}`, { auth: granted.grant.token, reconnect: false, tools: host.tools(), context: { documentId, title, language } });
  }
}

/** One line of the results file (README §3.6). */
export interface RunRecord {
  run_id: string; task_id: string; benchmark_version: string; system_config_id: string; input_mode: 'text' | 'voice';
  repeat_index: number; seed: number; started_at: string;
  /** Voice runs: what the server transcribed of each spoken user turn, final transcripts in order. */
  heard?: string[];
  versions: Record<string, string>;
  initial_hash: string;
  instruction: string;
  outcome: 'completed' | 'timeout' | 'error';
  error?: string;
  /** Milliseconds from sending the instruction. null when the moment never came. */
  latency: {
    first_tool_call: number | null; first_read: number | null; first_write: number | null; last_write: number | null;
    worker_first_request: number | null; first_agent_text: number | null; turn_end: number | null;
  };
  counts: { tool_calls: number; writes_ok: number; writes_failed: number; model_requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number };
  tool_calls: { name: string; t: number; ms: number | null; ok: boolean | null; error?: string; turnId: string; epoch: number; aborted?: boolean }[];
  model_requests: { t: number; ms: number | null; status?: number; model?: string; usage: unknown; stop_reason?: string; params?: unknown; error?: string }[];
  agent_text: string;
  client_errors: { t: number; code: string; message: string }[];
  server_events: { t: number; type: string; fields: Record<string, unknown> }[];
  server_warnings: { t: number; level: string; message: string; code?: unknown }[];
  late_writes: number;
  removed_placeholders: number;
  final_document: Doc;
  score: Score;
  /** Each time governance asked for confirmation and the harness answered: ms from sending the instruction. */
  confirmations: { asked: number; answered: number; ended: number | null }[];
  /** The document scored as it stood when confirmation was first asked: the strict result had nobody answered. null if never asked. */
  score_without_confirmation: Score | null;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const isCjk = (text: string) => /[㐀-鿿]/.test(text);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the agent has been quiet: idle and no tool call running, for SETTLE_MS. Resolves with when the quiet began. */
async function settled(session: ClientSession, host: VdocHost, started: () => boolean, lastActivity: () => number, deadline: number): Promise<number | null> {
  for (;;) {
    const quiet = session.state === 'idle' && started() && host.calls.every(c => c.endedAt !== undefined);
    if (quiet && performance.now() - lastActivity() >= SETTLE_MS) return lastActivity();
    if (performance.now() > deadline) return null;
    await sleep(50);
  }
}

export interface RunOptions {
  repeatIndex: number; seed: number; versions: Record<string, string>; beforeSend?: (host: VdocHost) => Promise<void>;
  /** Answer governance's confirmation requests (default true). */
  autoConfirm?: boolean;
  /** Voice runs: speech for a user line. Every user turn is then spoken into a live microphone instead of typed,
   * and latency counts from the end of the spoken instruction. */
  speech?: (text: string) => Promise<Uint8Array>;
}

/** Runs one task once: fresh document, fresh voice session, history turns, the instruction, then scoring. */
export async function runTask(bench: Bench, task: Task, server: ConfiguredServer, host: VdocHost, options: RunOptions): Promise<RunRecord> {
  const initial = bench.initial(task), expected = bench.expected(task);
  const runId = randomUUID(), documentId = `bench-${task.task_id}-${runId.slice(0, 8)}`;
  await host.load(initial, documentId);
  const title = initial.find(b => b.type === 'heading')?.text ?? task.task_id;
  const session = await server.open(documentId, host, title, isCjk(task.instruction_text + title) ? 'zh' : 'en');
  let lastActivity = performance.now(), active = false, agentText = '', firstText: number | null = null;
  const clientErrors: RunRecord['client_errors'] = [];
  const touch = () => { lastActivity = performance.now(); };
  session.on('state', event => { touch(); if (event.state !== 'idle') active = true; });
  session.on('text', event => { touch(); firstText ??= performance.now(); agentText += event.delta; });
  session.on('tool.call', touch);
  session.on('tool.result', touch);
  session.on('error', event => { touch(); active = true; clientErrors.push({ t: performance.now(), code: event.code, message: event.message }); });
  const heard: string[] = [];
  session.on('transcript', event => { touch(); if (event.role === 'user' && event.final && event.text.trim()) heard.push(event.text); });
  const mic = options.speech ? microphone(frame => { if (session.connected) session.sendAudio(frame); }) : undefined;
  /** The user says (or types) a line; resolves when they have finished saying it. */
  const userSays = async (text: string): Promise<number> => {
    if (!mic || !options.speech) { session.sendText(text); return performance.now(); }
    const audio = await options.speech(text);
    return mic.say(audio);
  };

  const isWriting = task.evaluation_mode !== 'deterministic';
  const timeout = isWriting ? TIMEOUTS.writing : TIMEOUTS.edit;
  let outcome: RunRecord['outcome'] = 'completed', error: string | undefined;
  // Fixed history is sent as earlier user turns, the same way for every system.
  for (const turn of task.history.filter(t => t.role === 'user')) {
    active = false; await userSays(turn.content); touch();
    if (await settled(session, host, () => active, () => lastActivity, performance.now() + timeout) === null) { outcome = 'timeout'; error = 'history turn timed out'; }
  }
  const callsBefore = host.calls.length, eventsBefore = server.events.length, logsBefore = server.logs.length, requestsBefore = modelRequests.length;
  agentText = ''; firstText = null; clientErrors.length = 0;
  await options.beforeSend?.(host);
  const startedAt = new Date().toISOString();
  heard.length = 0;
  active = false;
  const sentAt = await userSays(task.instruction_text); touch();
  const since = (t: number | undefined | null) => (t === undefined || t === null ? null : Math.round(t - sentAt));
  let end = outcome === 'completed' ? await settled(session, host, () => active, () => lastActivity, sentAt + timeout) : null;
  if (end === null && outcome === 'completed') outcome = 'timeout';
  // A turn that ended on a confirmation request gets the user's "yes", once per request, the same for every system.
  const confirmations: RunRecord['confirmations'] = [];
  let beforeConfirmation: Doc | undefined, checked = eventsBefore;
  const askedSince = () => { const asked = server.events.slice(checked).find(({ value }) => value.type === 'ToolCallReviewed' && (value as unknown as { decision?: string }).decision === 'confirm'); checked = server.events.length; return asked?.at; };
  for (let asked = askedSince(); options.autoConfirm !== false && outcome === 'completed' && asked !== undefined && confirmations.length < MAX_CONFIRMATIONS; asked = askedSince()) {
    beforeConfirmation ??= (await host.export()).doc;
    active = false;
    const answered = await userSays(isCjk(task.instruction_text) ? '确认。' : 'Yes, go ahead.'); touch();
    const ended = await settled(session, host, () => active, () => lastActivity, answered + timeout);
    confirmations.push({ asked: since(asked)!, answered: since(answered)!, ended: since(ended) });
    if (ended === null) { outcome = 'timeout'; end = null; break; }
    end = ended;
  }
  let final = await host.export().catch((e: unknown) => { outcome = 'error'; error = String(e); return null; });
  const writesBefore = host.calls.filter(c => c.committed && c.ok).length;
  await sleep(LATE_WRITE_MS);
  const lateWrites = host.calls.filter(c => c.committed && c.ok).length - writesBefore;
  if (lateWrites) final = await host.export();
  mic?.stop();
  await session.close().catch(() => {});

  const calls = host.calls.slice(callsBefore);
  const writes = calls.filter(c => c.committed);
  const okWrites = writes.filter(c => c.ok);
  const requests = modelRequests.slice(requestsBefore).filter(r => r.startedAt >= sentAt);
  const doc = final?.doc ?? [];
  return {
    run_id: runId, task_id: task.task_id, benchmark_version: bench.version, system_config_id: server.config.id, input_mode: options.speech ? 'voice' : 'text',
    repeat_index: options.repeatIndex, seed: options.seed, started_at: startedAt, ...(options.speech ? { heard: [...heard] } : {}),
    versions: options.versions, initial_hash: hash(initial), instruction: task.instruction_text, outcome, ...(error ? { error } : {}),
    latency: {
      first_tool_call: since(calls[0]?.startedAt), first_read: since(calls.find(c => c.name.startsWith('read') || c.name === 'get_context')?.startedAt),
      first_write: since(okWrites[0]?.endedAt), last_write: since(okWrites.at(-1)?.endedAt),
      worker_first_request: since(requests[0]?.startedAt), first_agent_text: since(firstText), turn_end: since(end),
    },
    counts: {
      tool_calls: calls.length, writes_ok: okWrites.length, writes_failed: writes.length - okWrites.length, model_requests: requests.length,
      input_tokens: requests.reduce((n, r) => n + (r.usage.input_tokens ?? 0), 0), output_tokens: requests.reduce((n, r) => n + (r.usage.output_tokens ?? 0), 0),
      cache_read_tokens: requests.reduce((n, r) => n + (r.usage.cache_read_input_tokens ?? 0), 0),
    },
    tool_calls: calls.map(c => ({ name: c.name, t: since(c.startedAt)!, ms: c.endedAt === undefined ? null : Math.round(c.endedAt - c.startedAt), ok: c.ok ?? null, ...(c.error ? { error: c.error } : {}), turnId: c.turnId, epoch: c.epoch, ...(c.aborted ? { aborted: true } : {}) })),
    model_requests: requests.map(r => ({ t: since(r.startedAt)!, ms: r.endedAt === undefined ? null : Math.round(r.endedAt - r.startedAt), ...(r.status ? { status: r.status } : {}), ...(r.model ? { model: r.model } : {}), usage: r.usage, ...(r.stopReason ? { stop_reason: r.stopReason } : {}), ...(r.params ? { params: r.params } : {}), ...(r.error ? { error: r.error } : {}) })),
    agent_text: agentText, client_errors: clientErrors.map(e => ({ ...e, t: since(e.t)! })),
    server_events: server.events.slice(eventsBefore).map(({ at, value }) => { const { type, aggregateId: _, occurredAt: __, ...fields } = value as DomainEvent & Record<string, unknown>; return { t: since(at)!, type, fields }; }),
    server_warnings: server.logs.slice(logsBefore).filter(({ value }) => value.level === 'warn' || value.level === 'error').map(({ at, value }) => ({ t: since(at)!, level: String(value.level), message: String(value.message), ...(value.code !== undefined ? { code: value.code } : {}) })),
    late_writes: lateWrites, removed_placeholders: final?.removedPlaceholders ?? 0, final_document: doc,
    score: score(task, initial, expected, doc),
    confirmations, score_without_confirmation: beforeConfirmation ? score(task, initial, expected, beforeConfirmation) : null,
  };
}
