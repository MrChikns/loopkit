/**
 * summary-branch-resolution.test.ts — `loopctl summary --json` must not drop the dispatched
 * branch for a gate-parked item. The fold archives currentBuild into builds[] the moment an
 * item parks (see fold.ts's `item.parked` handler), so a parked item has NO currentBuild and
 * its branch lives only on the last builds[] entry. Resolving only `currentBuild?.branch`
 * fed the console's approve-button label an absent branch and mislabeled a merge-ready item
 * as "requeue for build". One-parser rule: cmdSummary resolves through the SAME shared chain
 * (resolveItemBranch: currentBuild?.branch ?? builds[last]?.branch) the approve verb's
 * branch-gone check uses, and reports whether that branch still exists (git rev-parse) so a
 * stale branch (worktree cleaned up) still truthfully requeues.
 *
 * Covers:
 *   - `loopctl summary --json`: a gate-parked item with an archived (builds[]) branch still
 *     carries `branch` and `branchAlive: true` in the active[] entry.
 *   - `loopctl summary --json`: a gate-parked item whose branch was deleted carries
 *     `branchAlive: false`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { appendEvents } from '../src/ledger.js';
import { makeEvent } from '../src/schema.js';

const execFileAsync = promisify(execFile);
// Compiled test lives at dist-test/test/; the CLI compiles to dist-test/src/cli.js (NOT dist/).
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-branch-res-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A real git repo with a fixture branch, so `git rev-parse --verify` behaves for real
 *  rather than being stubbed — matches how the approve verb's existing branchGone check
 *  is exercised. */
function makeRepoWithBranch(): { repoRoot: string; branch: string } {
  const repoRoot = join(makeTempDir(), 'repo');
  mkdirSync(join(repoRoot, '.ai', 'ledger'), { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  const branch = 'work/branch-resolution-fixture';
  g(['checkout', '-b', branch]);
  writeFileSync(join(repoRoot, 'src.txt'), 'fixture change', 'utf8');
  g(['add', 'src.txt']);
  g(['commit', '-m', 'feat: fixture']);
  g(['checkout', 'main']);
  return { repoRoot, branch };
}

/** The exact shape that hid the bug: state='parked'/parkKind='decision', a build in
 *  builds[] carrying `branch`, and currentBuild archived (undefined) by item.parked. */
async function seedGateParkedItem(ledgerDir: string, id: string, branch: string): Promise<void> {
  await appendEvents(ledgerDir, [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: 'do x' }, '2026-07-19T00:00:00Z'),
    makeEvent('cli', id, 'item.queued', { spec: 'do x' }, '2026-07-19T00:00:01Z'),
    makeEvent('dispatch', id, 'build.dispatched', { attempt: 1, pid: 1, branch }, '2026-07-19T00:00:02Z'),
    makeEvent('dispatch', id, 'item.parked', { reason: 'gate failed', parkKind: 'decision' }, '2026-07-19T00:00:03Z'),
  ]);
}

async function runSummary(repoRoot: string, ledgerDir: string): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'summary', '--json'], {
    cwd: repoRoot,
    env: { ...process.env, LOOPKIT_REPO: repoRoot, LOOPKIT_LEDGER: ledgerDir },
  });
  return JSON.parse(stdout);
}

test('summary --json: gate-parked item with an archived build carries branch + branchAlive:true', async () => {
  const { repoRoot, branch } = makeRepoWithBranch();
  const ledgerDir = join(repoRoot, '.ai', 'ledger');
  try {
    await seedGateParkedItem(ledgerDir, 'WI-901', branch);
    const summary = await runSummary(repoRoot, ledgerDir);
    const item = summary.active.find((a: any) => a.id === 'WI-901');
    assert.ok(item, 'gate-parked item must appear in active[]');
    assert.equal(item.state, 'parked');
    assert.equal(item.branch, branch, 'branch must be resolved from builds[] once currentBuild is archived');
    assert.equal(item.branchAlive, true, 'branch still exists in git');
  } finally {
    rmSync(dirname(repoRoot), { recursive: true, force: true });
  }
});

test('summary --json: gate-parked item whose branch was deleted carries branchAlive:false', async () => {
  const { repoRoot, branch } = makeRepoWithBranch();
  const ledgerDir = join(repoRoot, '.ai', 'ledger');
  try {
    spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
    await seedGateParkedItem(ledgerDir, 'WI-902', branch);
    const summary = await runSummary(repoRoot, ledgerDir);
    const item = summary.active.find((a: any) => a.id === 'WI-902');
    assert.ok(item, 'gate-parked item must appear in active[]');
    assert.equal(item.branch, branch, 'branch is still reported even though it is gone');
    assert.equal(item.branchAlive, false, 'deleted branch must be reported as not alive');
  } finally {
    rmSync(dirname(repoRoot), { recursive: true, force: true });
  }
});
