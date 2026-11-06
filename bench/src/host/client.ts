import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { ClientTool, ClientToolContext } from '@vrealtime/client';
import { dropHostPlaceholders, fromTiptap } from '../adapter';
import type { Doc } from '../neutral';
import type { Exported, HostRequest, HostResponse, ToolEntry } from './protocol';

/** One tool call as the host saw it: monotonic times (performance.now()) and its outcome. */
export interface HostCall {
  callId: string; turnId: string; epoch: number; name: string; args: unknown;
  startedAt: number; endedAt?: number;
  ok?: boolean; error?: string;
  /** apply_document_operations / undo_turn that returned ok — the document actually changed. */
  committed?: boolean;
  aborted?: boolean;
}

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;

/** vdoc's real editor and document tools, running in a worker thread (see worker.ts). */
export class VdocHost {
  readonly calls: HostCall[] = [];
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private next = 1;
  private catalog: ToolEntry[] = [];
  private initialIds = new Set<string>();

  private constructor(bundle: string) {
    this.worker = new Worker(bundle);
    this.worker.on('message', (response: HostResponse) => {
      const waiter = this.pending.get(response.id); if (!waiter) return;
      this.pending.delete(response.id);
      if (response.ok) waiter.resolve(response.value); else waiter.reject(new Error(response.error));
    });
    this.worker.on('error', error => { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); });
  }

  /** `bundle` is the file build-host.ts wrote. */
  static async start(bundle: string): Promise<VdocHost> {
    const host = new VdocHost(bundle);
    host.catalog = await host.request({ op: 'catalog' }) as ToolEntry[];
    return host;
  }

  private request(message: Distribute<HostRequest>): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...message, id }); });
  }

  /** Resets to a fresh document and engine session; clears the call log. */
  async load(doc: Doc, docId: string): Promise<{ sessionId: string; revision: number }> {
    this.calls.length = 0;
    this.initialIds = new Set(doc.map(block => block.id));
    return await this.request({ op: 'load', doc, docId }) as { sessionId: string; revision: number };
  }

  /** The tools vdoc's browser client would register, backed by this host. */
  tools(): Record<string, ClientTool> {
    return Object.fromEntries(this.catalog.map(entry => [entry.name, {
      description: entry.description, parameters: entry.parameters,
      run: (args: unknown, context: ClientToolContext) => this.run(entry.name, args, context),
    }]));
  }

  private async run(name: string, args: unknown, context: ClientToolContext): Promise<unknown> {
    const call: HostCall = { callId: context.callId, turnId: context.turnId, epoch: context.epoch, name, args, startedAt: performance.now() };
    this.calls.push(call);
    const abort = () => { call.aborted = true; void this.request({ op: 'abort', callId: context.callId }); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const value = await this.request({ op: 'call', name, args, context: { callId: context.callId, turnId: context.turnId, epoch: context.epoch } });
      call.ok = true; call.committed = name === 'apply_document_operations' || name === 'undo_turn';
      return value;
    } catch (error) {
      // vdoc's tools throw for ok:false so the SDK reports a failure with this message.
      call.ok = false; call.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      call.endedAt = performance.now();
      context.signal.removeEventListener('abort', abort);
    }
  }

  async export(): Promise<Exported & { doc: Doc; removedPlaceholders: number }> {
    const exported = await this.request({ op: 'export' }) as Exported;
    const { doc, removed } = dropHostPlaceholders(fromTiptap(exported.json as never), this.initialIds);
    return { ...exported, doc, removedPlaceholders: removed };
  }

  async close(): Promise<void> {
    await this.request({ op: 'dispose' }).catch(() => {});
    await this.worker.terminate();
  }
}
