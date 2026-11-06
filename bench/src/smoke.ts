/**
 * Harness check with the scripted fake model: no API keys, no cost, and no
 * meaning as a result. Each scripted answer exercises one path end to end
 * (server → governance → @vrealtime/client → vdoc host → checker):
 *   VD-FMT-001  correct edit                          → success
 *   VD-STR-005  correct table insert (new block ID)   → success
 *   VD-FMT-003  edit on the wrong paragraph           → failure with collateral
 *   VD-REF-006  history turn, then the correct edit   → success
 *   VD-MD-001   two deletions in one call             → governance asks to confirm; nothing written
 *
 *   npx tsx bench/src/smoke.ts [--out file.jsonl]   (--out appends the records, e.g. to try summarize.ts)
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FakeResponder } from '@vdoc-server/adapter-vrt';
import { hostBundlePath } from './build-host';
import { arg } from './cli';
import { configById } from './configs';
import { VdocHost } from './host/client';
import { loadBench } from './neutral';
import { ConfiguredServer, runTask } from './runner';
import { versions } from './run';

const bench = loadBench(resolve('bench/data/VDocs-Bench-v1.0'));
let session = { sessionId: '', revision: 0 };
const edit = (target: unknown, operations: unknown[]) => ({ name: 'apply_document_operations', arguments: { expectedSessionId: session.sessionId, expectedRevision: session.revision, target, operations } });
const scripts: Record<string, () => ReturnType<FakeResponder>> = {
  'VD-FMT-001': () => ({ say: '标题已加粗。', toolCalls: [edit({ kind: 'text', blockId: 'h1', start: 0, end: 5 }, [{ type: 'text.style', style: { bold: true } }])] }),
  'VD-STR-005': () => ({ say: '表格已插入。', toolCalls: [edit({ kind: 'block', id: 'p4' }, [{ type: 'block.insert', position: { anchorId: 'p4', relation: 'after' }, block: { kind: 'table', rows: 3, cols: 2, header: true, headerText: ['项目', '金额'], rowsText: [['交通费', '一百元'], ['材料费', '两百元']] } }])] }),
  'VD-FMT-003': () => ({ say: '已取消斜体。', toolCalls: [edit({ kind: 'text', blockId: 'p2', start: 0, end: 21 }, [{ type: 'text.style', style: { italic: false, bold: true } }])] }),
  'VD-REF-006': () => ({ say: '已标黄。', toolCalls: [edit({ kind: 'text', blockId: 'p2', start: 0, end: 11 }, [{ type: 'text.style', style: { highlight: '#FFFF00' } }])] }),
  'VD-MD-001': () => ({ say: '已删除。', toolCalls: [edit({ kind: 'block', id: 'p3' }, [{ type: 'block.delete', id: 'p3' }, { type: 'block.delete', id: 'p4' }])] }),
};
const expectations: Record<string, (r: Awaited<ReturnType<typeof runTask>>) => boolean> = {
  'VD-FMT-001': r => r.score.task_success === true,
  'VD-STR-005': r => r.score.task_success === true,
  'VD-FMT-003': r => r.score.task_success === false && r.score.collateral_edit,
  'VD-REF-006': r => r.score.task_success === true,
  'VD-MD-001': r => r.counts.writes_ok === 0 && r.score.task_success === false && !r.score.collateral_edit,
};
let current = '';
const responder: FakeResponder = text => {
  const task = bench.tasks.find(t => t.task_id === current)!;
  return text === task.instruction_text ? scripts[current]!() : { say: '好的，记住了。' };
};

const { bundle } = JSON.parse(readFileSync(hostBundlePath(), 'utf8')) as { bundle: string };
const host = await VdocHost.start(bundle);
const server = await ConfiguredServer.start(configById('fake'), {}, responder);
let failed = 0;
for (const id of Object.keys(scripts)) {
  current = id;
  const task = bench.tasks.find(t => t.task_id === id)!;
  const record = await runTask(bench, task, server, host, { repeatIndex: 0, seed: 0, versions: versions(), beforeSend: async h => { const e = await h.export(); session = { sessionId: e.sessionId, revision: e.revision }; } });
  if (arg('out')) appendFileSync(arg('out')!, JSON.stringify(record) + '\n');
  const ok = expectations[id]!(record);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${id}: ${record.outcome} success=${record.score.task_success} collateral=${record.score.collateral.join('; ') || 'none'} writes=${record.counts.writes_ok}/${record.counts.writes_ok + record.counts.writes_failed} end=${record.latency.turn_end}ms`);
  if (!ok) console.log(JSON.stringify({ steps: record.score.steps, tools: record.tool_calls, errors: record.client_errors, warnings: record.server_warnings, events: record.server_events.map(e => e.type) }, null, 1));
}
await server.close(); await host.close();
process.exitCode = failed ? 1 : 0;
