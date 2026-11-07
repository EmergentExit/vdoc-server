import type { BosonOptions } from '@vrealtime/boson';
import { ModelRegistry } from './model-registry';
import { bosonProvider } from './providers/boson';
import { cascadeClaudeProvider } from './providers/cascade';
import { fakeProvider, type FakeResponder } from './providers/fake';
import { openaiProvider } from './providers/openai';
import { gptLive } from './providers/gpt-live';
import { delegatedModel } from './worker/delegated-model';
import { createPiWorker, type WorkerThinking } from './worker/pi-worker';
import { createClaudeTalker } from './worker/talker';
import { createUtteranceRouter } from './worker/utterance-router';

export interface ModelRegistryOptions {
  readonly bosonApiKey?: string | undefined;
  readonly bosonSocket?: BosonOptions['socket'];
  readonly openaiApiKey?: string | undefined;
  /** On Cloudflare Workers, `fetchSocket()`: GPT-Live's auth header needs a fetch upgrade. */
  readonly openaiSocket?: BosonOptions['socket'];
  /** With `openaiApiKey` (speech), registers `cascade-claude`. */
  readonly anthropicApiKey?: string | undefined;
  /** Pi worker limits and model; optional for existing callers. */
  readonly workerAgent?: { readonly model: string; readonly thinking?: WorkerThinking; readonly prefetch?: boolean; readonly timeoutMs: number; readonly maxRequests: number; readonly talker?: { readonly model: string; readonly routerModel: string } | undefined } | undefined;
  /** Registers the scripted dev model. Never in production. */
  readonly fake?: false | { respond?: FakeResponder };
}

/** The providers a deployment can use, given the keys it has. */
export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const registry = new ModelRegistry();
  if (options.bosonApiKey) registry.register(bosonProvider({ apiKey: options.bosonApiKey, ...(options.bosonSocket ? { socket: options.bosonSocket } : {}) }));
  if (options.bosonApiKey && options.anthropicApiKey) {
    const performer = bosonProvider({ apiKey: options.bosonApiKey, ...(options.bosonSocket ? { socket: options.bosonSocket } : {}) });
    // Validate the configured worker model before admitting any realtime session.
    const worker = createPiWorker({ apiKey: options.anthropicApiKey, ...(options.workerAgent ? { model: options.workerAgent.model, maxRequests: options.workerAgent.maxRequests, ...(options.workerAgent.thinking ? { thinking: options.workerAgent.thinking } : {}), ...(options.workerAgent.prefetch ? { prefetch: true } : {}) } : {}) });
    // With a talker, turns that are not edits go to it; Pi still starts on every turn, so edits never wait.
    const talker = options.workerAgent?.talker;
    const conversation = talker ? { router: createUtteranceRouter({ apiKey: options.anthropicApiKey, model: talker.routerModel }), talker: createClaudeTalker({ apiKey: options.anthropicApiKey, model: talker.model }) } : undefined;
    // No utterance judge: words spoken mid-task go to Pi as an update (or stop it, for the plain stop phrases).
    registry.register({ id: 'boson-worker', create: choice => delegatedModel(performer.create(choice), worker, options.workerAgent?.timeoutMs, undefined, undefined, conversation) });
  }
  if (options.openaiApiKey && options.anthropicApiKey) {
    // GPT-Live listens and talks; the server routes every turn, Pi edits and the talker discusses.
    const worker = createPiWorker({ apiKey: options.anthropicApiKey, ...(options.workerAgent ? { model: options.workerAgent.model, maxRequests: options.workerAgent.maxRequests, ...(options.workerAgent.thinking ? { thinking: options.workerAgent.thinking } : {}), ...(options.workerAgent.prefetch ? { prefetch: true } : {}) } : {}) });
    const talker = options.workerAgent?.talker;
    const conversation = { voiceTalks: true, router: createUtteranceRouter({ apiKey: options.anthropicApiKey, ...(talker ? { model: talker.routerModel } : {}) }), talker: createClaudeTalker({ apiKey: options.anthropicApiKey, ...(talker ? { model: talker.model } : {}) }) };
    const voice = gptLive({ apiKey: options.openaiApiKey, ...(options.openaiSocket ? { socket: options.openaiSocket } : {}) });
    registry.register({ id: 'live-worker', create: () => delegatedModel(voice, worker, options.workerAgent?.timeoutMs, undefined, undefined, conversation) });
  }
  if (options.openaiApiKey) registry.register(openaiProvider({ apiKey: options.openaiApiKey }));
  if (options.anthropicApiKey && options.openaiApiKey) registry.register(cascadeClaudeProvider({ anthropicApiKey: options.anthropicApiKey, openaiApiKey: options.openaiApiKey }));
  if (options.fake) registry.register(fakeProvider(options.fake.respond ? { respond: options.fake.respond } : {}));
  return registry;
}
