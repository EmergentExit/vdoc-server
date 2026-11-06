/**
 * Prepares the vdoc host: exports vdoc at a pinned commit into bench/.cache,
 * installs its locked dependencies, and bundles src/host/worker.ts against it.
 * Nothing in the vdoc checkout or this repository's source is modified.
 *
 *   npx tsx bench/src/build-host.ts [--vdoc ~/Desktop/Vdoc] [--ref origin/main]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { arg } from './cli';

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(BENCH, '.cache');

export const hostBundlePath = () => join(CACHE, 'host.json');

async function main() {
  const repo = resolve(arg('vdoc') ?? join(homedir(), 'Desktop/Vdoc'));
  const ref = arg('ref') ?? 'origin/main';
  // Experiments test what is on GitHub: refresh the remote branch before resolving it.
  if (ref.startsWith('origin/')) execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin', ref.slice('origin/'.length)], { stdio: 'inherit' });
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  const checkout = join(CACHE, `vdoc-${sha}`);
  if (!existsSync(join(checkout, 'package.json'))) {
    mkdirSync(checkout, { recursive: true });
    execFileSync('sh', ['-c', `git -C "${repo}" archive ${sha} | tar -x -C "${checkout}"`], { stdio: 'inherit' });
  }
  if (!existsSync(join(checkout, 'node_modules'))) execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, stdio: 'inherit' });
  // Inside the checkout so the external `jsdom` import resolves from vdoc's own node_modules.
  const outfile = join(checkout, 'vdocs-bench-host.mjs');
  await build({
    entryPoints: [join(BENCH, 'src/host/worker.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['jsdom'], alias: { '@': checkout }, nodePaths: [join(checkout, 'node_modules')], logLevel: 'warning',
    // Some CommonJS dependencies call require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  writeFileSync(hostBundlePath(), JSON.stringify({ vdocRepo: repo, vdocRef: ref, vdocSha: sha, bundle: outfile, builtAt: new Date().toISOString() }, null, 2));
  console.log(`vdoc ${sha} → ${outfile}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
