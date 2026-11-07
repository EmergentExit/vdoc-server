/**
 * How well the utterance router tells edits from discussion and small talk, and how long it takes.
 * Edits are every task instruction in VDocs-Bench (with the assistant's last line where the task has
 * history) plus the hand-written lines in bench/tasks/routing.jsonl; discussion and small talk come
 * from that file only. Text only: no audio, no document, no Pi.
 *
 *   npx tsx bench/src/router-eval.ts [--model claude-haiku-5-5] [--repeats 1] [--out bench/results/router.jsonl]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createUtteranceRouter, type UtteranceRoute } from '../../packages/adapters/vrt/src/worker/utterance-router';
import { arg } from './cli';
import { median, quantile } from './stats';

interface Sample { id: string; label: UtteranceRoute; utterance: string; lastReply?: string }

if (existsSync('.env')) process.loadEnvFile('.env');
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required.');
const model = arg('model') ?? 'claude-haiku-5-5';
const repeats = Number(arg('repeats') ?? 1);
const out = arg('out');

const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const samples: Sample[] = lines(resolve('bench/tasks/routing.jsonl')) as unknown as Sample[];
const benchTasks = resolve(arg('bench') ?? 'bench/data/VDocs-Bench-v1.0', 'tasks/main.jsonl');
if (existsSync(benchTasks)) {
  for (const task of lines(benchTasks) as unknown as { task_id: string; instruction_text: string; history: { role: string; content: string }[] }[]) {
    const lastReply = task.history.filter(turn => turn.role === 'assistant').at(-1)?.content;
    samples.push({ id: task.task_id, label: 'act', utterance: task.instruction_text, ...(lastReply ? { lastReply } : {}) });
  }
}

const router = createUtteranceRouter({ apiKey, model });
const results: { sample: Sample; route: UtteranceRoute; ms: number }[] = [];
for (let round = 0; round < repeats; round++) {
  for (const sample of samples) {
    const started = performance.now();
    const route = await router.route(sample.utterance, sample.lastReply ? { lastReply: sample.lastReply } : {}, AbortSignal.timeout(10_000));
    const ms = performance.now() - started;
    results.push({ sample, route, ms });
    if (out) appendFileSync(out, `${JSON.stringify({ id: sample.id, label: sample.label, route, ms: Math.round(ms), model })}\n`);
    if (route !== sample.label) console.log(`  ${sample.id} ${sample.label} → ${route}: ${sample.utterance}`);
  }
}

const labels: UtteranceRoute[] = ['act', 'discuss', 'chat'];
console.log(`\nmodel ${model}, ${samples.length} samples × ${repeats}`);
for (const label of labels) {
  const rows = results.filter(r => r.sample.label === label);
  const counts = labels.map(route => `${route} ${rows.filter(r => r.route === route).length}`).join(', ');
  console.log(`${label.padEnd(8)} n=${rows.length}: ${counts}`);
}
// What matters for routing: an edit sent away from Pi is lost time; a question sent to Pi only gets a shorter answer.
const acts = results.filter(r => r.sample.label === 'act'), talks = results.filter(r => r.sample.label !== 'act');
console.log(`edit recall ${(acts.filter(r => r.route === 'act').length / acts.length * 100).toFixed(1)}%, talk recall ${(talks.filter(r => r.route !== 'act').length / talks.length * 100).toFixed(1)}%`);
const ms = results.map(r => r.ms);
console.log(`latency median ${Math.round(median(ms))} ms, p90 ${Math.round(quantile(ms, 0.9))} ms`);
