/**
 * Batch runner: text input, one run at a time, configurations interleaved by a
 * seeded shuffle inside every task × repeat block (README §3.3).
 *
 *   npx tsx bench/src/run.ts --preset paper
 *   npx tsx bench/src/run.ts --configs S3,S3-noprefetch --tasks pilot --repeats 1
 *
 * --preset: paper | quick (see PRESETS); any other flag given overrides it.
 * --tasks: all | pilot | a category (FMT, REP, MD, STR, REF, MULTI, WRITE) | a task-list .json | comma-separated task IDs.
 * --no-confirm: do not answer governance's confirmation requests (by default the harness answers "确认", and keeps the strict score too).
 * --resume: keep the runs already in --out and run only the missing ones; runs a provider refused
 *   (bad key, no credit) are taken out of the file first (a backup is kept) and run again.
 * --allow-local: run even if the server or vdoc code differs from GitHub main (recorded with every run).
 * --budget: stop once the estimated Claude spend of this invocation reaches this many USD
 *   (Boson and OpenAI usage is not visible here; set a spend limit in each console too).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostBundlePath } from './build-host';
import { arg } from './cli';
import { configById } from './configs';
import { checkOnlineCode } from './online';
import { VdocHost } from './host/client';
import { recordModelRequests } from './model-requests';
import { runCost } from './pricing';
import { loadBench, type Task } from './neutral';
import { ConfiguredServer, runTask, type RunRecord } from './runner';
import { random, shuffled } from './stats';
import { rulesHash, workerEditingRules } from './s2-aligned';

/** README §6: the ten tasks of the first end-to-end trial. */
export const PILOT = ['VD-FMT-003', 'VD-FMT-009', 'VD-REP-004', 'VD-MD-001', 'VD-STR-005', 'VD-REF-006', 'VD-REF-010', 'VD-MULTI-011', 'VD-WRITE-003', 'VD-WRITE-015'];
export const SEED = 261026;

/** The agreed experiment sizes: "够写论文" and the cheaper go/no-go check before it. */
export const PRESETS: Record<string, { configs: string; tasks: string; repeats: number; out: string }> = {
  paper: { configs: 'S3,S2,R1,S3-noprefetch', tasks: 'bench/tasks/paper-60.json', repeats: 2, out: 'bench/results/paper.jsonl' },
  quick: { configs: 'S3,R1,S3-noprefetch', tasks: 'bench/tasks/paper-60.json', repeats: 1, out: 'bench/results/quick.jsonl' },
  /** After the fixes in vdoc-server #60/#61 and vdoc #133: the paper comparison plus thinking and model ablations. */
  paper2: { configs: 'S3,S2,R1,S3-noprefetch,S3-think-low,S3-think-high,S3-sonnet', tasks: 'bench/tasks/paper-60.json', repeats: 2, out: 'bench/results/paper-v2.jsonl' },
};

export function selectTasks(all: readonly Task[], spec: string): Task[] {
  if (spec === 'all') return [...all];
  if (spec === 'pilot') return PILOT.map(id => all.find(t => t.task_id === id)!).filter(Boolean);
  if (spec.endsWith('.json')) return selectTasks(all, (JSON.parse(readFileSync(resolve(spec), 'utf8')) as { tasks: string[] }).tasks.join(','));
  if (/^[A-Z]+$/.test(spec)) return all.filter(t => t.category === spec);
  const ids = spec.split(',');
  const unknown = ids.filter(id => !all.some(t => t.task_id === id));
  if (unknown.length) throw new Error(`Unknown task IDs: ${unknown.join(', ')}`);
  return ids.map(id => all.find(t => t.task_id === id)!);
}

/** A provider refused the request itself (bad key, no credit left): the run measured nothing about the system. */
export function providerRefused(record: Pick<RunRecord, 'model_requests' | 'client_errors'>): string | undefined {
  if (record.model_requests.some(r => r.status === 401 || r.status === 403)) return 'the model API rejected the key';
  return record.client_errors.map(e => e.message).find(m => /HTTP 40[13]|HTTP 429|Incorrect API key|invalid[ _-]?api[ _-]?key|authentication|no credits|insufficient[_ ]quota/i.test(m));
}
const runKey = (config: string, task: string, repeat: number) => `${config}|${task}|${repeat}`;

/** What the paper must state per run: code, vdoc and model versions (README §3.4). */
export function versions(extra: Record<string, string> = {}): Record<string, string> {
  const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const host = JSON.parse(readFileSync(hostBundlePath(), 'utf8')) as { vdocSha: string };
  return { server_sha: git('rev-parse', 'HEAD'), vdoc_sha: host.vdocSha, ...extra };
}

async function main() {
  const bench = loadBench(resolve(arg('bench') ?? 'bench/data/VDocs-Bench-v1.0'));
  const preset = arg('preset') === undefined ? undefined : PRESETS[arg('preset')!];
  if (arg('preset') !== undefined && !preset) throw new Error(`Unknown preset ${arg('preset')}. Known: ${Object.keys(PRESETS).join(', ')}`);
  const configs = (arg('configs') ?? preset?.configs ?? 'S3').split(',').map(configById);
  const tasks = selectTasks(bench.tasks, arg('tasks') ?? preset?.tasks ?? 'pilot');
  const repeats = Number(arg('repeats') ?? preset?.repeats ?? 1);
  const budget = arg('budget') === undefined ? Infinity : Number(arg('budget'));
  const out = resolve(arg('out') ?? preset?.out ?? `bench/results/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  // Resuming keeps the measured runs and drops the ones a provider refused, so they are run again.
  const done_ = new Set<string>();
  if (arg('resume') === 'true' && existsSync(out)) {
    const records = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as RunRecord);
    const kept = records.filter(r => !providerRefused(r));
    if (kept.length < records.length) {
      copyFileSync(out, `${out}.bak-${Date.now()}`);
      writeFileSync(out, kept.map(r => JSON.stringify(r) + '\n').join(''));
    }
    for (const r of kept) done_.add(runKey(r.system_config_id, r.task_id, r.repeat_index));
    console.log(`Resuming: ${kept.length} runs kept, ${records.length - kept.length} refused by a provider removed.`);
  }
  // A crash inside a provider library (e.g. a speech failure the cascade never awaited) must not end an unattended batch.
  process.on('unhandledRejection', error => console.log(`Unhandled rejection (run continues): ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`));
  // The code under test must be what is on GitHub (this repository's main and vdoc's main).
  const online = checkOnlineCode();
  if (online.problems.length && arg('allow-local') !== 'true') throw new Error(`Not the code on GitHub, so nothing was run:\n- ${online.problems.join('\n- ')}\n(--allow-local runs it anyway and records that.)`);
  console.log(online.problems.length ? `Running LOCAL code (--allow-local):\n- ${online.problems.join('\n- ')}` : `Code matches GitHub main: server ${online.serverSha.slice(0, 8)}, vdoc ${online.vdocSha.slice(0, 8)}`);
  if (existsSync('.env')) process.loadEnvFile('.env');
  recordModelRequests();
  const { bundle } = JSON.parse(readFileSync(hostBundlePath(), 'utf8')) as { bundle: string };
  const host = await VdocHost.start(bundle);
  const servers = new Map<string, ConfiguredServer>();
  for (const config of configs) servers.set(config.id, await ConfiguredServer.start(config, process.env));
  const autoConfirm = arg('no-confirm') !== 'true';
  const next = random(SEED), base = versions({ worker_model: process.env.VDOC_SERVER_WORKER_MODEL ?? 'claude-haiku-5-5 (default)', code_matches_github: online.problems.length ? 'no' : 'yes', auto_confirm: autoConfirm ? 'yes' : 'no' });
  console.log(`${tasks.length} task(s) × ${repeats} repeat(s) × ${configs.length} configuration(s) → ${out}`);
  let done = 0, spent = 0;
  const disabled = new Map<string, string>();
  runs: for (let repeat = 0; repeat < repeats; repeat++) for (const task of tasks) for (const config of shuffled(configs, next)) {
    if (done_.has(runKey(config.id, task.task_id, repeat)) || disabled.has(config.id)) continue;
    const record = await runTask(bench, task, servers.get(config.id)!, host, { repeatIndex: repeat, seed: SEED, autoConfirm, versions: { ...base, ...config.env, ...(config.variant ? { variant: config.variant, s2_rules_sha: rulesHash(workerEditingRules()) } : {}) } });
    // A provider that refuses (bad key, no credit) refuses every later run too: stop that configuration, keep the rest.
    const refused = providerRefused(record);
    if (refused) {
      disabled.set(config.id, refused);
      console.log(`Skipping ${config.id} from now on: ${refused.replace(/\s+/g, ' ').slice(0, 160)}. Fix it in .env or the provider's console, then rerun with --resume.`);
      if (disabled.size === configs.length) break runs;
      continue;
    }
    appendFileSync(out, JSON.stringify(record) + '\n');
    const s = record.score, cost = runCost(record.model_requests);
    spent += cost;
    console.log(`[${++done}] ${config.id} ${task.task_id} r${repeat}: ${record.outcome} success=${s.task_success}${record.confirmations.length ? ` (confirmed ×${record.confirmations.length}, strict=${record.score_without_confirmation?.task_success})` : ''} steps=${s.steps.map(x => x.pass === null ? '?' : x.pass ? '✓' : '✗').join('')} collateral=${s.collateral_edit} end=${record.latency.turn_end}ms requests=${record.counts.model_requests} tools=${record.counts.tool_calls} $${cost.toFixed(4)} (total $${spent.toFixed(3)})`);
    if (spent >= budget) { console.log(`Stopping: estimated Claude spend $${spent.toFixed(3)} reached the budget of $${budget}.`); break runs; }
  }
  for (const [id, reason] of disabled) console.log(`Not run: ${id} (${reason.replace(/\s+/g, ' ').slice(0, 120)}).`);
  for (const server of servers.values()) await server.close();
  await host.close();
}

if (process.argv[1]?.endsWith('run.ts')) await main();
