/**
 * Draws the paper's fixed task subset: 10 deterministic tasks from each of the
 * six editing categories, 5 single-step and 5 multi-step, seed 261026.
 * Writing tasks are left out, so no run needs an LLM grader.
 *
 *   npx tsx bench/src/make-subset.ts [--per-kind 5] [--out bench/tasks/paper-60.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { arg } from './cli';
import { loadBench } from './neutral';
import { random, shuffled } from './stats';

const SEED = 261026;
const bench = loadBench(resolve(arg('bench') ?? 'bench/data/VDocs-Bench-v1.0'));
const perKind = Number(arg('per-kind') ?? 5);
const out = resolve(arg('out') ?? 'bench/tasks/paper-60.json');
const next = random(SEED);
const categories = [...new Set(bench.tasks.filter(t => t.evaluation_mode === 'deterministic').map(t => t.category))];
const chosen = categories.flatMap(category => (['single', 'multi'] as const).flatMap(complexity => {
  const pool = bench.tasks.filter(t => t.category === category && t.complexity === complexity && t.evaluation_mode === 'deterministic');
  if (pool.length < perKind) throw new Error(`${category}/${complexity} has only ${pool.length} tasks`);
  return shuffled(pool, next).slice(0, perKind).map(t => t.task_id).sort();
}));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ benchmark_version: bench.version, seed: SEED, rule: `${perKind} single + ${perKind} multi deterministic tasks per editing category`, tasks: chosen }, null, 2) + '\n');
console.log(`${chosen.length} tasks → ${out}`);
