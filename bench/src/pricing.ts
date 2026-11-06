/**
 * Claude API list prices in USD per million tokens, for estimating what a run
 * cost. Source: Anthropic first-party rates as of 2026-10-06; check
 * https://platform.claude.com/docs/en/about-claude/pricing before quoting them.
 * Cache writes are the 5-minute rate (1.25× input), cache reads 0.1× input.
 * Boson and OpenAI realtime usage is not visible to the harness and not counted.
 */
interface Price { input: number; output: number; cacheWrite: number; cacheRead: number }
const price = (input: number, output: number): Price => ({ input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 });

const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': price(0.10, 0.50),
  'claude-sonnet-5-5': price(2, 10),
  'claude-opus-5-5': price(4, 20),
};
/** Haiku 5.5 bills a prompt over 100K tokens at a higher rate. */
const HAIKU_LONG = price(0.50, 2.50);

export interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** Estimated USD for one request; unknown models count at Sonnet 5.5 rates so the estimate errs high. */
export function requestCost(model: string | undefined, usage: Usage): number {
  const key = Object.keys(PRICES).find(id => model?.startsWith(id));
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const p = key === 'claude-haiku-5-5' && prompt > 100_000 ? HAIKU_LONG : PRICES[key ?? 'claude-sonnet-5-5']!;
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output
    + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite + (usage.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
}

export function runCost(requests: readonly { model?: string; usage: unknown }[]): number {
  return requests.reduce((sum, r) => sum + requestCost(r.model, r.usage as Usage), 0);
}
