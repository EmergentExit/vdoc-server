/**
 * Experiments run locally but must test exactly the code on GitHub: this
 * repository's main and vdoc's main. Before a batch starts, both are fetched
 * and compared; any difference stops the run unless --allow-local is given,
 * and the result is recorded with every run either way.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostBundlePath } from './build-host';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** What the server is built from; docs, bench/ and other untracked folders do not run. */
const SERVER_CODE = ['packages', 'apps/node', 'apps/worker', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json'];

export interface OnlineCheck { serverSha: string; vdocSha: string; problems: string[] }

export function checkOnlineCode(): OnlineCheck {
  const problems: string[] = [];
  try { git('fetch', '-q', 'origin', 'main'); } catch { problems.push('could not fetch this repository from GitHub'); }
  const serverSha = git('rev-parse', 'HEAD'), onlineServer = git('rev-parse', 'origin/main');
  if (serverSha !== onlineServer) problems.push(`this checkout is at ${serverSha.slice(0, 8)}, GitHub main is ${onlineServer.slice(0, 8)}: switch to main and pull`);
  const local = git('status', '--porcelain', '--untracked-files=all', '--', ...SERVER_CODE);
  if (local) problems.push(`local changes to server code:\n${local}`);

  const host = JSON.parse(readFileSync(hostBundlePath(), 'utf8')) as { vdocRepo: string; vdocSha: string };
  try { git('-C', host.vdocRepo, 'fetch', '-q', 'origin', 'main'); } catch { problems.push('could not fetch vdoc from GitHub'); }
  const onlineVdoc = git('-C', host.vdocRepo, 'rev-parse', 'origin/main');
  if (host.vdocSha !== onlineVdoc) problems.push(`the vdoc host was built from ${host.vdocSha.slice(0, 8)}, GitHub vdoc main is ${onlineVdoc.slice(0, 8)}: run bench/src/build-host.ts`);
  return { serverSha, vdocSha: host.vdocSha, problems };
}
