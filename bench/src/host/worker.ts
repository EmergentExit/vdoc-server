/**
 * Runs vdoc's own editor engine and realtime document tools headlessly, inside
 * a worker thread. Bundled against a pinned vdoc checkout by build-host.ts, so
 * `@/` resolves to that checkout. jsdom's browser globals stay in this thread:
 * the server's Anthropic SDK refuses to run where `window` exists.
 */
import './dom';
import { parentPort } from 'node:worker_threads';
import { Editor } from '@tiptap/core';
import { createExtensions } from '@/lib/editor/extensions';
import { DocumentEngine } from '@/lib/usecases/engine';
import { createRealtimeExecutor } from '@/lib/usecases/realtime-executor';
import { documentToolCatalog, realtimeDocumentTools } from '@/lib/usecases/document-tools';
import { toTiptap } from '../adapter';
import type { Doc } from '../neutral';
import type { HostRequest, HostResponse } from './protocol';

type Tools = ReturnType<typeof realtimeDocumentTools>;
let current: { editor: Editor; engine: DocumentEngine; tools: Tools; lifetime: AbortController; docId: string } | null = null;
const calls = new Map<string, AbortController>();

function dispose() {
  if (!current) return;
  current.lifetime.abort(); current.engine.destroy(); current.editor.destroy(); current = null;
}

async function load(doc: Doc, docId: string) {
  dispose();
  const editor = new Editor({ extensions: createExtensions(), content: toTiptap(doc) });
  // Stable IDs normalise on create; let that settle before the engine counts revisions (as vdoc's tests do).
  await new Promise(resolve => setTimeout(resolve, 0));
  const engine = new DocumentEngine(editor);
  const lifetime = new AbortController();
  const session = { docId, sessionId: engine.sessionId };
  const executor = createRealtimeExecutor(engine, { docId, actor: 'vdocs-bench', signal: lifetime.signal, currentDocument: () => session });
  current = { editor, engine, tools: realtimeDocumentTools(executor), lifetime, docId };
  return { sessionId: engine.sessionId, revision: engine.revision };
}

async function handle(request: HostRequest): Promise<unknown> {
  switch (request.op) {
    case 'catalog': return documentToolCatalog.map(({ name, description, parameters }) => ({ name, description, parameters }));
    case 'load': return load(request.doc, request.docId);
    case 'call': {
      if (!current) throw new Error('No document is loaded.');
      const tool = current.tools[request.name as keyof Tools];
      if (!tool) throw new Error(`Unknown tool ${request.name}`);
      const controller = new AbortController();
      calls.set(request.context.callId, controller);
      try { return await tool.run(request.args, { ...request.context, signal: controller.signal }); }
      finally { calls.delete(request.context.callId); }
    }
    case 'abort': calls.get(request.callId)?.abort(); return null;
    case 'export': {
      if (!current) throw new Error('No document is loaded.');
      return { json: current.editor.getJSON(), revision: current.engine.revision, sessionId: current.engine.sessionId,
        records: current.engine.records.map(({ id, label, source, time, revision, turnId }) => ({ id, label, source, time, revision, turnId })) };
    }
    case 'dispose': dispose(); return null;
  }
}

parentPort!.on('message', (request: HostRequest) => {
  handle(request).then(
    value => parentPort!.postMessage({ id: request.id, ok: true, value } satisfies HostResponse),
    (error: unknown) => parentPort!.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies HostResponse),
  );
});
