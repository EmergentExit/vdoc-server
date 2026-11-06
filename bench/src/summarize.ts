/**
 * Turns result files into the paper's tables (实验设计 实验一–三, README §3.3):
 * success and collateral rates with task-level bootstrap intervals, latency
 * medians and P95 (all observable runs and the successful subset, with n),
 * results by category and by single/multi-step, cost, failure reasons, paired
 * comparisons against a baseline configuration, and run-to-run consistency.
 *
 *   npx tsx bench/src/summarize.ts bench/results/a.jsonl [b.jsonl …] [--baseline S3]
 *
 * Writes <first file>.summary.md, .summary.json and .runs.csv (one row per run, for plots).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arg } from './cli';
import { loadBench, type Task } from './neutral';
import { runCost } from './pricing';
import type { RunRecord } from './runner';
import { bootstrapByTask, mean, median, quantile, std } from './stats';

const SEED = 261026;
const LATENCIES = ['first_tool_call', 'worker_first_request', 'first_write', 'last_write', 'turn_end'] as const;
type Latency = (typeof LATENCIES)[number];

interface Row {
  record: RunRecord; config: string; task: string; category: string; complexity: string; writing: boolean;
  success: boolean | null; cost: number; reason: string | null;
  /** Success had nobody answered a confirmation request: the document as it stood when governance first asked. */
  strict: boolean | null;
  /** Governance asked the user to confirm at least once. */
  asked: boolean;
}

/** One primary reason per failed run, most fundamental first (实验二 失败原因分类). A heuristic; the raw events stay in the results. */
export function failureReason(r: RunRecord): string | null {
  if (r.score.task_success !== false) return null;
  if (r.outcome === 'timeout') return 'TIMEOUT';
  if (r.outcome === 'error') return 'HARNESS_ERROR';
  const http = r.model_requests.find(m => m.status !== undefined && m.status >= 400);
  if (http) return `MODEL_HTTP_${http.status}`;
  const coded = r.client_errors.map(e => /^([A-Z][A-Z_]+):/.exec(e.message)?.[1]).find(Boolean);
  if (coded) return coded;
  const review = r.server_events.find(e => e.type === 'ToolCallReviewed' && e.fields.decision !== 'allow');
  if (review) return `GOVERNANCE_${String(review.fields.decision).toUpperCase()}`;
  if (r.counts.writes_ok === 0) {
    const tool = r.tool_calls.find(c => c.ok === false);
    return tool ? `TOOL_${/^([A-Z][A-Z_]+):/.exec(tool.error ?? '')?.[1] ?? 'FAILED'}` : 'NO_EDIT';
  }
  if (r.score.collateral_edit) return 'COLLATERAL_EDIT';
  return r.score.writing ? 'WRITING_CONSTRAINT' : 'WRONG_OR_INCOMPLETE';
}

function load(files: string[], tasks: Map<string, Task>): Row[] {
  return files.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    const record = JSON.parse(line) as RunRecord, task = tasks.get(record.task_id);
    return { record, config: record.system_config_id, task: record.task_id, category: task?.category ?? record.task_id.split('-')[1]!,
      complexity: task?.complexity ?? '?', writing: task ? task.evaluation_mode !== 'deterministic' : !!record.score.writing,
      success: record.score.task_success, cost: runCost(record.model_requests), reason: failureReason(record),
      strict: record.score_without_confirmation ? record.score_without_confirmation.task_success : record.score.task_success,
      asked: (record.confirmations?.length ?? 0) > 0 || record.server_events.some(e => e.type === 'ToolCallReviewed' && e.fields.decision === 'confirm') };
  }));
}

const byTask = (rows: readonly Row[]) => [...Map.groupBy(rows, r => r.task).values()];
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');
const ms = (x: number) => (Number.isFinite(x) ? (x >= 10_000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`) : '—');
const ci = ([lo, hi]: [number, number], f: (x: number) => string) => (Number.isFinite(lo) ? `[${f(lo)}, ${f(hi)}]` : '');
const table = (head: string[], rows: (string | number)[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const values = (rows: readonly Row[], key: Latency) => rows.map(r => r.record.latency[key]).filter((x): x is number => x !== null);

function successRate(rows: readonly Row[]) { const decided = rows.filter(r => r.success !== null); return decided.length ? decided.filter(r => r.success).length / decided.length : NaN; }

function overview(configs: string[], rows: Row[]) {
  const json: Record<string, unknown> = {};
  const lines = configs.map(config => {
    const all = rows.filter(r => r.config === config && !r.writing), groups = byTask(all);
    const rate = successRate(all), interval = bootstrapByTask(groups, s => successRate(s.flat()), SEED);
    const collateral = mean(all.map(r => +r.record.score.collateral_edit)), timeout = mean(all.map(r => +(r.record.outcome === 'timeout')));
    const partial = mean(all.map(r => r.record.score.partial_completion ?? NaN).filter(Number.isFinite));
    const loose = mean(all.map(r => +(r.record.score.content_equal === true)));
    const strict = mean(all.filter(r => r.strict !== null).map(r => +(r.strict === true))), asked = mean(all.map(r => +r.asked));
    json[config] = { runs: all.length, tasks: groups.length, success: rate, success_ci: interval, success_without_confirmation: strict, asked_to_confirm: asked, partial, collateral, timeout, content_equal: loose };
    return [config, all.length, groups.length, `${pct(rate)} ${ci(interval, pct)}`, pct(strict), pct(asked), pct(partial), pct(collateral), pct(timeout), pct(loose)];
  });
  return { json, md: table(['config', 'runs', 'tasks', 'success [95% CI]', 'success, nobody confirms', 'asked to confirm', 'partial', 'collateral', 'timeout', 'content equal'], lines) };
}

function latency(configs: string[], rows: Row[]) {
  const json: Record<string, unknown> = {};
  const lines = configs.flatMap(config => {
    const all = rows.filter(r => r.config === config), ok = all.filter(r => r.success === true);
    json[config] = Object.fromEntries(LATENCIES.map(key => [key, { n: values(all, key).length, median: median(values(all, key)), p95: quantile(values(all, key), 0.95), success_n: values(ok, key).length, success_median: median(values(ok, key)), success_p95: quantile(values(ok, key), 0.95) }]));
    return LATENCIES.map(key => [config, key, values(all, key).length, ms(median(values(all, key))), ms(quantile(values(all, key), 0.95)), values(ok, key).length, ms(median(values(ok, key))), ms(quantile(values(ok, key), 0.95))]);
  });
  return { json, md: table(['config', 'metric', 'n', 'median', 'P95', 'n (success)', 'median (success)', 'P95 (success)'], lines) };
}

function breakdown(configs: string[], rows: Row[], key: 'category' | 'complexity') {
  const keys = [...new Set(rows.map(r => r[key]))].sort();
  const lines = keys.map(k => [k, ...configs.map(config => {
    const cell = rows.filter(r => r.config === config && r[key] === k);
    const det = cell.filter(r => !r.writing);
    return cell.length ? `${det.length ? pct(successRate(det)) : 'graded later'} · ${ms(median(values(cell, 'turn_end')))} (n=${cell.length})` : '—';
  })]);
  return table([key, ...configs.map(c => `${c}: success · median end`)], lines);
}

function effort(configs: string[], rows: Row[]) {
  const json: Record<string, unknown> = {};
  const lines = configs.map(config => {
    const all = rows.filter(r => r.config === config), c = (f: (r: RunRecord) => number) => mean(all.map(r => f(r.record)));
    const total = all.reduce((s, r) => s + r.cost, 0);
    json[config] = { model_requests: c(r => r.counts.model_requests), tool_calls: c(r => r.counts.tool_calls), writes_failed: c(r => r.counts.writes_failed), input_tokens: c(r => r.counts.input_tokens), output_tokens: c(r => r.counts.output_tokens), cache_read_tokens: c(r => r.counts.cache_read_tokens), claude_usd_total: total, claude_usd_per_run: total / all.length };
    return [config, c(r => r.counts.model_requests).toFixed(2), c(r => r.counts.tool_calls).toFixed(2), c(r => r.counts.writes_failed).toFixed(2), Math.round(c(r => r.counts.input_tokens)), Math.round(c(r => r.counts.cache_read_tokens)), Math.round(c(r => r.counts.output_tokens)), `$${(total / all.length).toFixed(4)}`, `$${total.toFixed(2)}`];
  });
  return { json, md: table(['config', 'model requests', 'tool calls', 'failed writes', 'input tok', 'cache-read tok', 'output tok', 'Claude $/run', 'Claude $ total'], lines) };
}

function failures(configs: string[], rows: Row[]) {
  const reasons = [...new Set(rows.map(r => r.reason).filter((x): x is string => !!x))].sort();
  const json = Object.fromEntries(configs.map(config => [config, Object.fromEntries(reasons.map(reason => [reason, rows.filter(r => r.config === config && r.reason === reason).length]))]));
  return { json, md: reasons.length ? table(['reason', ...configs], reasons.map(reason => [reason, ...configs.map(c => json[c]![reason]!)])) : '_No failed runs._' };
}

/** B − A on the tasks both ran; positive Δ end time means B is slower. */
function paired(baseline: string, configs: string[], rows: Row[]) {
  const json: Record<string, unknown> = {};
  const lines = configs.filter(c => c !== baseline).map(other => {
    const tasks = [...new Set(rows.filter(r => r.config === baseline).map(r => r.task))].filter(t => rows.some(r => r.config === other && r.task === t));
    const groups = tasks.map(t => ({ a: rows.filter(r => r.task === t && r.config === baseline), b: rows.filter(r => r.task === t && r.config === other) }));
    const det = groups.filter(g => g.a.some(r => r.success !== null));
    const dSuccess = (s: readonly typeof groups[number][]) => successRate(s.flatMap(g => g.b)) - successRate(s.flatMap(g => g.a));
    const dEnd = (key: Latency) => (s: readonly typeof groups[number][]) => median(values(s.flatMap(g => g.b), key)) - median(values(s.flatMap(g => g.a), key));
    const wins = det.filter(g => successRate(g.b) > successRate(g.a)).length, losses = det.filter(g => successRate(g.b) < successRate(g.a)).length;
    const result = { tasks: tasks.length, d_success: dSuccess(det), d_success_ci: bootstrapByTask(det, dSuccess, SEED), d_turn_end: dEnd('turn_end')(groups), d_turn_end_ci: bootstrapByTask(groups, dEnd('turn_end'), SEED), d_last_write: dEnd('last_write')(groups), d_last_write_ci: bootstrapByTask(groups, dEnd('last_write'), SEED), tasks_better: wins, tasks_worse: losses };
    json[other] = result;
    const signedMs = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '−') + ms(Math.abs(x)) : '—');
    return [`${other} − ${baseline}`, tasks.length, `${result.d_success >= 0 ? '+' : ''}${pct(result.d_success)} ${ci(result.d_success_ci, pct)}`, `${wins} / ${losses}`, `${signedMs(result.d_turn_end)} ${ci(result.d_turn_end_ci, signedMs)}`, `${signedMs(result.d_last_write)} ${ci(result.d_last_write_ci, signedMs)}`];
  });
  return { json, md: lines.length ? table(['comparison', 'shared tasks', 'Δ success [95% CI]', 'tasks better / worse', 'Δ median end [95% CI]', 'Δ median last write [95% CI]'], lines) : '_Only one configuration._' };
}

/** How much repeats of one task disagree: the evidence for choosing the number of repeats. */
function consistency(configs: string[], rows: Row[]) {
  const json: Record<string, unknown> = {};
  const lines = configs.map(config => {
    const repeated = byTask(rows.filter(r => r.config === config)).filter(g => g.length > 1);
    const mixed = repeated.filter(g => g.some(r => r.success === true) && g.some(r => r.success === false)).length;
    const cv = repeated.map(g => { const v = values(g, 'turn_end'); return v.length > 1 ? std(v) / mean(v) : NaN; }).filter(Number.isFinite);
    json[config] = { tasks_with_repeats: repeated.length, tasks_mixed_outcome: mixed, median_turn_end_cv: median(cv) };
    return [config, repeated.length, repeated.length ? `${mixed} (${pct(mixed / repeated.length)})` : '—', Number.isFinite(median(cv)) ? median(cv).toFixed(2) : '—'];
  });
  return { json, md: table(['config', 'tasks run more than once', 'tasks with mixed success', 'median CV of end time'], lines) };
}

function csv(rows: Row[]): string {
  const head = ['run_id', 'config', 'task_id', 'category', 'complexity', 'writing', 'repeat', 'outcome', 'success', 'partial', 'collateral', 'content_equal', ...LATENCIES, 'model_requests', 'tool_calls', 'writes_ok', 'writes_failed', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'claude_usd', 'failure_reason', 'success_without_confirmation', 'confirmations'];
  const cell = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [head.join(','), ...rows.map(({ record: r, ...row }) => [r.run_id, row.config, row.task, row.category, row.complexity, row.writing, r.repeat_index, r.outcome, row.success, r.score.partial_completion, r.score.collateral_edit, r.score.content_equal,
    ...LATENCIES.map(k => r.latency[k]), r.counts.model_requests, r.counts.tool_calls, r.counts.writes_ok, r.counts.writes_failed, r.counts.input_tokens, r.counts.output_tokens, r.counts.cache_read_tokens, row.cost.toFixed(6), row.reason, row.strict, r.confirmations?.length ?? 0].map(cell).join(','))].join('\n') + '\n';
}

function main() {
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--')).map(f => resolve(f));
  if (!files.length) throw new Error('Usage: summarize.ts <results.jsonl> [more.jsonl …] [--baseline S3]');
  const bench = loadBench(resolve(arg('bench') ?? 'bench/data/VDocs-Bench-v1.0'));
  const rows = load(files, new Map(bench.tasks.map(t => [t.task_id, t])));
  const configs = [...new Set(rows.map(r => r.config))];
  const baseline = arg('baseline') ?? (configs.includes('S3') ? 'S3' : configs[0]!);
  const writing = rows.filter(r => r.writing);
  const sections = {
    overview: overview(configs, rows), latency: latency(configs, rows), effort: effort(configs, rows), failures: failures(configs, rows),
    paired: paired(baseline, configs, rows), consistency: consistency(configs, rows),
  };
  const versions = [...new Set(rows.map(r => JSON.stringify(r.record.versions)))];
  const md = [
    `# VDocs-Bench results`, '',
    `${rows.length} runs from ${files.length} file(s); benchmark ${[...new Set(rows.map(r => r.record.benchmark_version))].join(', ')}; ${rows[0]?.record.started_at.slice(0, 10)} – ${rows.at(-1)?.record.started_at.slice(0, 10)}.`,
    `Text input. "success" is after the harness answered any confirmation request with a yes; "nobody confirms" scores the document as it stood when confirmation was first asked. Success counts deterministic tasks only; intervals resample tasks (2000 rounds, seed ${SEED}). Latency is ms from sending the instruction; a moment that never came is left out, never counted as 0.`, '',
    '## Success, partial completion and collateral edits (deterministic tasks)', '', sections.overview.md, '',
    `## Paired against ${baseline}`, '', sections.paired.md, '',
    '## Latency', '', sections.latency.md, '',
    '## By category', '', breakdown(configs, rows, 'category'), '',
    '## Single vs multi-step', '', breakdown(configs, rows, 'complexity'), '',
    '## Requests, tokens and Claude cost', '', sections.effort.md, '', '_Claude list prices (bench/src/pricing.ts); Boson and OpenAI realtime usage is not included._', '',
    '## Failure reasons (one primary reason per failed run)', '', sections.failures.md, '',
    '## Run-to-run consistency', '', sections.consistency.md, '',
    `## Writing tasks`, '', writing.length ? `${writing.length} runs; ${writing.filter(r => r.success === false).length} already fail a hard constraint or edit outside their scope; ${writing.filter(r => r.success === null).length} await quality grading.` : '_None._', '',
    '## Versions', '', ...versions.map(v => `- \`${v}\``),
  ].join('\n');
  writeFileSync(`${files[0]}.summary.md`, md + '\n');
  writeFileSync(`${files[0]}.summary.json`, JSON.stringify({ files, baseline, configs, ...Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.json])) }, null, 2));
  writeFileSync(`${files[0]}.runs.csv`, csv(rows));
  console.log(md);
  console.log(`\n→ ${files[0]}.summary.md, .summary.json, .runs.csv`);
}

if (process.argv[1]?.endsWith('summarize.ts')) main();
