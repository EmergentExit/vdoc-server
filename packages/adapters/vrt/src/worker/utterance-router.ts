import Anthropic from '@anthropic-ai/sdk';

/** Who answers a new utterance. */
export type UtteranceRoute =
  /** Change the open document, or go ahead with a change already discussed or held for confirmation: Pi. */
  | 'act'
  /** A question, advice or discussion that needs thought or the document, without changing it: the talker. */
  | 'discuss'
  /** Greetings, thanks and small talk: the talker. */
  | 'chat';

export interface RouteContext {
  /** What the assistant said last, so "do it" and "yes" can be read against it. */
  lastReply?: string;
}

export interface UtteranceRouter {
  route(utterance: string, context: RouteContext, signal: AbortSignal): Promise<UtteranceRoute>;
}

const SYSTEM = `You route what a user said to a voice assistant that sits beside an open document.
Reply with exactly one word:
act - they want the document changed: write, add, insert, delete, replace, rewrite, polish, translate, format, move, list or tabulate content, create or clear a document, undo; or they agree to go ahead with a change the assistant proposed or asked to confirm ("yes", "do it", "write it like that").
discuss - they ask a question, want advice, an opinion, an explanation or a plan, or ask about the document, and do not ask for it to be changed now ("don't change anything yet" is discuss).
chat - greetings, thanks, feelings or small talk.
If unsure between act and anything else, answer act.`;

export interface UtteranceRouterOptions {
  apiKey: string;
  /** A fast model: this runs while the user waits for an answer that is not an edit. */
  model?: string;
  timeoutMs?: number;
  /** Provider call injection for deterministic tests. */
  completeFn?: (system: string, user: string, signal: AbortSignal) => Promise<string>;
}

/**
 * Decides whether Pi or the talker answers. Pi starts on every utterance at once, so an edit never waits
 * for this; only a turn routed away from Pi does. Any failure or unclear answer is `act`: Pi can still
 * answer a question, while a missed edit would leave the user's instruction undone.
 */
export function createUtteranceRouter(options: UtteranceRouterOptions): UtteranceRouter {
  const model = options.model ?? 'claude-haiku-5-5';
  const client = options.completeFn ? undefined : new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  const complete = options.completeFn ?? (async (system: string, user: string, signal: AbortSignal) => {
    const message = await client!.messages.create({
      model, max_tokens: 8, system,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: user }],
    }, { signal });
    return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
  });
  return {
    async route(utterance, context, signal) {
      try {
        const user = JSON.stringify({ ...(context.lastReply ? { assistantSaidLast: context.lastReply.slice(0, 1000) } : {}), userSaid: utterance.slice(0, 2000) });
        const answer = (await complete(SYSTEM, user, AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 3000)]))).trim().toLowerCase();
        return answer.startsWith('discuss') ? 'discuss' : answer.startsWith('chat') ? 'chat' : 'act';
      } catch {
        return 'act';
      }
    },
  };
}
