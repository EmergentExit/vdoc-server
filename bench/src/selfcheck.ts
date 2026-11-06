/**
 * Acceptance checks for the host and checker (README §6), before any model runs:
 *  1. every initial and answer document survives neutral → vdoc → neutral unchanged;
 *  2. each answer, read back through vdoc with fresh IDs on its new blocks, scores as a success;
 *  3. the untouched initial document scores as missed, without collateral;
 *  4. a correct answer plus one edit to a protected block is caught as collateral.
 *
 *   npx tsx bench/src/selfcheck.ts [--bench bench/data/VDocs-Bench-v1.0]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sameDocument, score } from './checker';
import { arg } from './cli';
import { hostBundlePath } from './build-host';
import { VdocHost } from './host/client';
import { loadBench, type Doc } from './neutral';

const bench = loadBench(resolve(arg('bench') ?? 'bench/data/VDocs-Bench-v1.0'));
const { bundle } = JSON.parse(readFileSync(hostBundlePath(), 'utf8')) as { bundle: string };
const host = await VdocHost.start(bundle);
const failures: string[] = [];
const fail = (message: string) => { failures.push(message); console.log(`  ✗ ${message}`); };

async function throughVdoc(doc: Doc, label: string): Promise<Doc> {
  await host.load(doc, `selfcheck-${label}`);
  return (await host.export()).doc;
}

let roundtrips = 0, answers = 0, missed = 0, caught = 0;
for (const task of bench.tasks) {
  const initial = bench.initial(task), expected = bench.expected(task);
  const back = await throughVdoc(initial, task.task_id);
  if (!sameDocument(initial, back)) fail(`${task.task_id}: initial document changes through vdoc\n    ${JSON.stringify(initial)}\n    ${JSON.stringify(back)}`); else roundtrips++;
  if (!expected) {
    const untouched = score(task, initial, undefined, initial);
    if (untouched.collateral_edit) fail(`${task.task_id}: untouched writing task reports collateral ${untouched.collateral.join('; ')}`);
    continue;
  }
  const answer = await throughVdoc(expected, `${task.task_id}-answer`);
  if (!sameDocument(expected, answer)) { fail(`${task.task_id}: answer changes through vdoc\n    ${JSON.stringify(expected)}\n    ${JSON.stringify(answer)}`); continue; }
  roundtrips++;
  // A model's new blocks get vdoc-generated IDs, not the answer's logical ones.
  const initialIds = new Set(initial.map(b => b.id));
  const asModelWouldLeaveIt = answer.map(b => initialIds.has(b.id) ? b : { ...b, id: `b_${b.id}_generated` });
  const correct = score(task, initial, expected, asModelWouldLeaveIt);
  if (!correct.task_success || correct.spec_errors.length) fail(`${task.task_id}: correct answer not a success: ${JSON.stringify({ steps: correct.steps.filter(s => !s.pass), collateral: correct.collateral, spec: correct.spec_errors })}`); else answers++;
  const nothing = score(task, initial, expected, initial);
  if (nothing.task_success || nothing.collateral_edit || nothing.steps.some(s => s.pass)) fail(`${task.task_id}: untouched document: success=${nothing.task_success} collateral=${nothing.collateral.join('; ')} passing=${nothing.steps.filter(s => s.pass).map(s => s.step_id)}`); else missed++;
  // Collateral probe: underline the first character of the last block the answer leaves exactly as it was.
  const untouched = [...expected].reverse().find(b => { const i = initial.find(x => x.id === b.id); return i && sameDocument([i], [b]) && b.text; });
  if (untouched) {
    const mutated = asModelWouldLeaveIt.map(b => b.id === untouched.id ? { ...b, marks: [...b.marks, { start: 0, end: 1, attribute: 'underline' as const, value: !b.marks.some(m => m.attribute === 'underline' && m.start === 0) }] } : b);
    const result = score(task, initial, expected, mutated);
    if (!result.collateral_edit || result.task_success) fail(`${task.task_id}: underline on protected ${untouched.id} not caught`); else caught++;
  }
}
await host.close();
const deterministic = bench.tasks.filter(t => bench.expected(t)).length;
console.log(`\nround trips ${roundtrips}/${bench.tasks.length + deterministic}, answers scored as success ${answers}/${deterministic}, untouched scored as missed ${missed}/${deterministic}, collateral caught ${caught}`);
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exitCode = 1; }
