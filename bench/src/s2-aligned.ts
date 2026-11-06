/**
 * S2 aligned with S3 for the G2 comparison (实验设计 "G2 要对齐三样东西"), without
 * changing the server: the same cascade (OpenAI speech + Claude) as the
 * `cascade-claude` provider, but its Claude client rewrites each request so that
 * only the architecture differs from S3's Pi worker:
 *   - model: the configured one (Haiku 5.5, as S3's worker);
 *   - editing rules: vdoc's profile instructions (which both already share) plus
 *     the worker's own rules, minus the lines about the Actor-Worker hand-off;
 *   - thinking: what Pi sends for "off" — `thinking: disabled`, no effort;
 *   - prompt caching: the same three breakpoints Pi sets (last tool, system prompt,
 *     last message), so the tool definitions are reused across tasks as in S3.
 * The worker rules are read from the server source at run time, so they cannot drift.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { claudeText, ModelRegistry, type ModelProvider } from '@vdoc-server/adapter-vrt';
import { cascade } from '@vrealtime/cascade';
import { openaiStt, openaiTts } from '@vrealtime/openai';
import { energyVad } from '@vrealtime/vad';

const WORKER_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/adapters/vrt/src/worker/delegated-model.ts');
/** Lines that only make sense for a worker behind a voice front end. */
const HANDOFF_ONLY = /agent behind a voice assistant|envelope|userUpdate|previousTasks|awaitingConfirmation|Only your final reply reaches the user/;

/** The worker's editing rules, as S2 receives them. */
export function workerEditingRules(): string {
  const source = readFileSync(WORKER_SOURCE, 'utf8');
  const match = /const WORKER_INSTRUCTIONS = `([\s\S]*?)`;/.exec(source);
  if (!match) throw new Error(`WORKER_INSTRUCTIONS not found in ${WORKER_SOURCE}`);
  return match[1]!.split('\n').filter(line => !HANDOFF_ONLY.test(line)).join('\n');
}
export const rulesHash = (rules: string) => createHash('sha256').update(rules).digest('hex').slice(0, 12);

type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

const EPHEMERAL = { type: 'ephemeral' as const };
type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };

/** The rewrite, exported so it can be checked without a network call. */
export function alignRequest(params: StreamParams, rules: string): StreamParams {
  const { output_config: _effort, thinking: _thinking, ...rest } = params as StreamParams & { output_config?: unknown };
  const base = typeof rest.system === 'string' ? rest.system : (rest.system ?? []).map(block => block.text).join('\n\n');
  const system = [{ type: 'text' as const, text: base ? `${base}\n\n${rules}` : rules, cache_control: EPHEMERAL }];
  const tools = (rest.tools ?? []).map((tool, i, all) => (i === all.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool));
  const messages = (rest.messages as Message[]).map((message, i, all) => {
    if (i !== all.length - 1) return message;
    const content: Block[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...message.content];
    content[content.length - 1] = { ...content.at(-1), cache_control: EPHEMERAL };
    return { ...message, content };
  });
  return { ...rest, system, tools, messages, thinking: { type: 'disabled' } } as unknown as StreamParams;
}

export function alignedCascadeProvider(options: { anthropicApiKey: string; openaiApiKey: string }): ModelProvider {
  const rules = workerEditingRules(), real = new Anthropic({ apiKey: options.anthropicApiKey });
  const client = { beta: { messages: { stream: (params: StreamParams, request?: Parameters<Anthropic['beta']['messages']['stream']>[1]) => real.beta.messages.stream(alignRequest(params, rules), request) } } } as unknown as Pick<Anthropic, 'beta'>;
  return {
    id: 'cascade-claude',
    create: choice => cascade({
      stt: openaiStt({ apiKey: options.openaiApiKey }),
      llm: claudeText({ apiKey: options.anthropicApiKey, client, ...(choice.model ? { model: choice.model } : {}) }),
      tts: openaiTts({ apiKey: options.openaiApiKey }),
      vad: energyVad(),
    }),
  };
}

export function alignedS2Registry(keys: { anthropic?: string | undefined; openai?: string | undefined }): ModelRegistry {
  if (!keys.anthropic || !keys.openai) throw new Error('S2 needs ANTHROPIC_API_KEY and OPENAI_API_KEY (OpenAI does its speech recognition and synthesis).');
  return new ModelRegistry().register(alignedCascadeProvider({ anthropicApiKey: keys.anthropic, openaiApiKey: keys.openai }));
}
