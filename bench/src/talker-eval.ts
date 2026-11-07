/**
 * How fast the talker answers the turns the router keeps away from Pi, per Claude model: the router's
 * time, then the talker's first text and its whole reply. Text only; speech adds the same on top for
 * every model. Discussion turns get one bench document, as the talker would after Pi's first read.
 *
 *   npx tsx bench/src/talker-eval.ts [--models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5] [--limit 30] [--out bench/results/talker.jsonl]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClaudeTalker } from '../../packages/adapters/vrt/src/worker/talker';
import { createUtteranceRouter } from '../../packages/adapters/vrt/src/worker/utterance-router';
import { arg } from './cli';
import { median, quantile } from './stats';

interface Sample { id: string; label: 'act' | 'discuss' | 'chat'; utterance: string }

if (existsSync('.env')) process.loadEnvFile('.env');
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required.');
const models = (arg('models') ?? 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5').split(',');
const limit = Number(arg('limit') ?? 30);
const out = arg('out');

const all = readFileSync(resolve('bench/tasks/routing.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Sample);
const discuss = all.filter(s => s.label === 'discuss'), chat = all.filter(s => s.label === 'chat');
const samples = [...discuss.slice(0, Math.ceil(limit * 2 / 3)), ...chat.slice(0, Math.floor(limit / 3))];
const documentPath = resolve(arg('bench') ?? 'bench/data/VDocs-Bench-v1.0', 'documents/intent-base.json');
const document = existsSync(documentPath) ? JSON.parse(readFileSync(documentPath, 'utf8')) as unknown : undefined;

const router = createUtteranceRouter({ apiKey });
for (const model of models) {
  const talker = createClaudeTalker({ apiKey, model });
  const rows: { routeMs: number; firstMs: number; replyMs: number; chars: number }[] = [];
  for (const sample of samples) {
    const started = performance.now();
    const route = await router.route(sample.utterance, {}, AbortSignal.timeout(10_000));
    const routeMs = performance.now() - started;
    let firstMs = NaN;
    try {
      const reply = await talker.reply({ route: route === 'act' ? 'discuss' : route, utterance: sample.utterance, conversation: [], ...(route !== 'chat' && document !== undefined ? { document } : {}) },
        { signal: AbortSignal.timeout(60_000), emit: () => { if (Number.isNaN(firstMs)) firstMs = performance.now() - started; } });
      const row = { routeMs, firstMs, replyMs: performance.now() - started, chars: reply.length };
      rows.push(row);
      if (out) appendFileSync(out, `${JSON.stringify({ model, id: sample.id, route, ...row, reply })}\n`);
    } catch (error) {
      console.log(`  ${model} ${sample.id} failed: ${(error as Error).message}`);
    }
  }
  const stat = (key: keyof typeof rows[number]) => `${Math.round(median(rows.map(r => r[key])))} / ${Math.round(quantile(rows.map(r => r[key]), 0.9))}`;
  console.log(`${model}: n=${rows.length}; median / p90 ms — route ${stat('routeMs')}, first text ${stat('firstMs')}, whole reply ${stat('replyMs')}; reply chars ${stat('chars')}`);
}
