import { performance } from 'node:perf_hooks';

/**
 * Records the Worker's model requests without touching server code: wraps
 * global fetch and reads the usage out of a copy of each Anthropic response
 * stream. Requests are attributed to a run by time, so runs must not overlap.
 */
export interface ModelRequest {
  url: string;
  startedAt: number;
  /** Response headers arrived. */
  respondedAt?: number;
  endedAt?: number;
  status?: number;
  model?: string | undefined;
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  stopReason?: string | undefined;
  /** What the request asked for, without its content: shows which settings each system really used. */
  params?: RequestParams | undefined;
  error?: string;
}
export interface RequestParams { model?: string; thinking?: unknown; effort?: unknown; max_tokens?: number; cache_control?: boolean; system_chars: number; tools: number; tool_chars: number; messages: number }

function requestParams(body: unknown): RequestParams | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const p = JSON.parse(body) as { model?: string; thinking?: unknown; output_config?: { effort?: unknown }; max_tokens?: number; system?: unknown; tools?: unknown[]; messages?: unknown[]; cache_control?: unknown };
    return { model: p.model, thinking: p.thinking, effort: p.output_config?.effort, max_tokens: p.max_tokens, cache_control: JSON.stringify(p).includes('"cache_control"'),
      system_chars: JSON.stringify(p.system ?? '').length, tools: p.tools?.length ?? 0, tool_chars: JSON.stringify(p.tools ?? []).length, messages: p.messages?.length ?? 0 } as RequestParams;
  } catch { return undefined; }
}

export const modelRequests: ModelRequest[] = [];

export function recordModelRequests(hosts = ['api.anthropic.com']): void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!hosts.some(host => url.includes(host))) return original(input, init);
    const request: ModelRequest = { url, startedAt: performance.now(), usage: {}, params: requestParams(init?.body) };
    modelRequests.push(request);
    try {
      const response = await original(input, init);
      request.respondedAt = performance.now(); request.status = response.status;
      void readUsage(response.clone(), request);
      return response;
    } catch (error) {
      request.endedAt = performance.now(); request.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
}

async function readUsage(response: Response, request: ModelRequest): Promise<void> {
  try {
    const text = await response.text();
    for (const line of text.split('\n')) {
      const data = line.startsWith('data: ') ? line.slice(6) : line.startsWith('{') ? line : '';
      if (!data) continue;
      let event: { type?: string; message?: { model?: string; usage?: ModelRequest['usage'] }; usage?: ModelRequest['usage']; delta?: { stop_reason?: string }; model?: string; stop_reason?: string };
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === 'message_start' && event.message) { request.model = event.message.model; Object.assign(request.usage, event.message.usage); }
      else if (event.type === 'message_delta') { Object.assign(request.usage, event.usage); request.stopReason = event.delta?.stop_reason; }
      else if (!event.type || event.type === 'message') { request.model ??= event.model; Object.assign(request.usage, event.usage); request.stopReason ??= event.stop_reason; }
    }
  } catch (error) {
    request.error = error instanceof Error ? error.message : String(error);
  } finally {
    request.endedAt = performance.now();
  }
}
