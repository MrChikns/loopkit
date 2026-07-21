/**
 * target-approve-merge.test.ts — the reactor's approved-merge path is TARGET-aware.
 *
 * An approved item belonging to a registered target must resolve the target's repoPath
 * (same registration rule as the dispatch build lane), verify + merge its branch THERE,
 * gate with the TARGET MANIFEST's command in the merge worktree, and advance the
 * manifest's defaultBranch in the target repo. Decisive negative: a same-named branch
 * sitting in the plane's own cwd must NOT satisfy the branch check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { runReactor } from '../src/beats/reactor.js';
import { manifestHash, readTargetManifest } from '../src/target.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

/** A minimal registered-target repo on `main` carrying a manifest at its root. */
function makeTargetRepo(root: string, name = 'notes'): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'loopkit.target.json'), JSON.stringify({ name }), 'utf8');
  writeFileSync(join(root, 'notes.txt'), 'seed\n', 'utf8');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init target']);
}

/** A plane repo on `master` (the reactor's own home). */
function makePlaneRepo(root: string): void {
  mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
  git(root, ['init', '-b', 'master']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'plane.txt'), 'plane\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init plane']);
}

function testConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

/** Ledger seed: registered target + an approved item whose last build carries `branch`. */
function seedEvents(targetRoot: string, branch: string): LedgerEvent[] {
  const manifest = readTargetManifest(targetRoot);
  return [
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: targetRoot, manifestHash: manifestHash(manifest), defaultBranch: 'main',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-101', 'item.captured', { source: 'cli', text: 'polish notes', target: 'notes' }, '2026-01-01T00:01:00Z'),
    makeEvent('cli', 'WI-101', 'item.queued', { spec: 'polish notes' }, '2026-01-01T00:02:00Z'),
    makeEvent('test', 'WI-101', 'build.dispatched', { attempt: 1, branch, pid: 1 }, '2026-01-01T00:03:00Z'),
    makeEvent('operator', 'WI-101', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
  ];
}

test('reactor: an approved target item merges into the TARGET repo defaultBranch', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-appr-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeTargetRepo(targetRoot);

    // The finished build's branch lives in the TARGET repo (the plane has no such branch).
    const branch = 'loop-wi-101-a1';
    git(targetRoot, ['checkout', '-b', branch]);
    writeFileSync(join(targetRoot, 'feature.txt'), 'built\n', 'utf8');
    git(targetRoot, ['add', 'feature.txt']);
    git(targetRoot, ['commit', '-m', 'feat: polish notes']);
    git(targetRoot, ['checkout', 'main']);

    await appendEvents(ledgerDir, seedEvents(targetRoot, branch));

    // Gate injected green — the point under test is WHERE the merge lands.
    let gateRuns = 0;
    const result = await runReactor({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: testConfig(),
      gateRunner: () => { gateRuns++; return { passed: true, timedOut: false, reason: 'green' }; },
    });

    const events = await loadAllEvents(ledgerDir);
    const item = fold(events).items.get('WI-101');
    assert.equal(item?.state, 'merged',
      `approved target item must merge (got ${item?.state}; steps: ${JSON.stringify(result.steps)})`);
    assert.equal(gateRuns, 1, 'the manifest gate must run once in the merge worktree');

    // DECISIVE: the merge commit is on the TARGET repo's main — not on the plane's master.
    const targetLog = git(targetRoot, ['log', '--oneline', 'main']).stdout.toString();
    assert.match(targetLog, /approved merge \(target notes\)/,
      'the approved merge commit must land on the target repo main');
    assert.match(targetLog, /polish notes/, 'the build commit must be reachable from target main');
    const planeLog = git(planeRoot, ['log', '--oneline', 'master']).stdout.toString();
    assert.ok(!planeLog.includes('approved merge'), 'the plane master must be untouched');

    // The recorded merge commit exists in the target repo, and the branch is cleaned up.
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-101');
    assert.equal(merged.length, 1);
    const commit = (merged[0].data as { commit: string }).commit;
    assert.equal(git(targetRoot, ['cat-file', '-t', commit]).stdout.toString().trim(), 'commit',
      'recorded merge commit must exist in the target repo');
    assert.notEqual(git(targetRoot, ['branch', '--list', branch]).stdout.toString().trim().length > 0, true,
      'the merged branch must be deleted from the target repo');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('reactor: an approved target merge records the REAL changed-file evidence on item.merged', async () => {
  // TRUST-HARDENING (FIX 1, best-effort): a reactor-approved merge must attach the actual git diff
  // (changedFiles/base/head/gateCommand) so acceptance tiers from the real diff, not declared
  // touches. Previously the reactor appended only { commit, deployed } → acceptance fell back to
  // touches (or, with no touches, defaulted below review).
  const base = mkdtempSync(join(tmpdir(), 'tgt-appr-ev-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeTargetRepo(targetRoot);

    const branch = 'loop-wi-101-a1';
    git(targetRoot, ['checkout', '-b', branch]);
    writeFileSync(join(targetRoot, 'feature.txt'), 'built\n', 'utf8');
    writeFileSync(join(targetRoot, 'second.txt'), 'more\n', 'utf8');
    git(targetRoot, ['add', 'feature.txt', 'second.txt']);
    git(targetRoot, ['commit', '-m', 'feat: polish notes']);
    git(targetRoot, ['checkout', 'main']);

    // Seed the item WITHOUT declared touches, so the ONLY evidence acceptance can use is the diff
    // the reactor captures at merge time.
    await appendEvents(ledgerDir, seedEvents(targetRoot, branch));

    await runReactor({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: testConfig({ acceptance: { tiers: { surfacePrefixes: ['feature.txt'] } } } as Partial<LoopkitConfig>),
      gateRunner: () => ({ passed: true, timedOut: false, reason: 'green' }),
    });

    const events = await loadAllEvents(ledgerDir);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-101');
    assert.equal(merged.length, 1, 'the approved target item must merge');
    const d = merged[0].data as { changedFiles?: string[]; baseSha?: string; headSha?: string; gateCommand?: string };
    assert.ok(Array.isArray(d.changedFiles), 'item.merged must carry a changedFiles evidence array');
    assert.deepEqual([...d.changedFiles!].sort(), ['feature.txt', 'second.txt'],
      'changedFiles must be the ACTUAL diff of the approved branch, not declared touches');
    assert.ok(d.baseSha && /^[0-9a-f]{7,40}$/.test(d.baseSha), 'baseSha must be a resolved commit sha');
    assert.ok(d.headSha && d.headSha.length > 0, 'headSha (merge commit) must be recorded');

    // The captured evidence lands on the fold record for the classifier to consume.
    const rec = fold(events).items.get('WI-101')!;
    assert.deepEqual([...(rec.mergeChangedFiles ?? [])].sort(), ['feature.txt', 'second.txt']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('reactor: a same-named branch in the plane cwd does NOT satisfy the target branch check', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-appr-neg-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeTargetRepo(targetRoot);

    // The branch exists ONLY in the PLANE repo — the exact false-positive shape the old
    // plane-cwd check would have accepted. The target repo has no such branch.
    const branch = 'loop-wi-101-a1';
    git(planeRoot, ['checkout', '-b', branch]);
    writeFileSync(join(planeRoot, 'decoy.txt'), 'decoy\n', 'utf8');
    git(planeRoot, ['add', 'decoy.txt']);
    git(planeRoot, ['commit', '-m', 'decoy plane branch']);
    git(planeRoot, ['checkout', 'master']);

    await appendEvents(ledgerDir, seedEvents(targetRoot, branch));

    const targetMainBefore = git(targetRoot, ['rev-parse', 'main']).stdout.toString().trim();

    await runReactor({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: testConfig(),
      gateRunner: () => ({ passed: true, timedOut: false, reason: 'green' }),
    });

    const events = await loadAllEvents(ledgerDir);
    const item = fold(events).items.get('WI-101');
    assert.equal(item?.state, 'parked',
      `a branch present only in the plane cwd must NOT merge — item parks (got ${item?.state})`);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-101');
    assert.equal(parked.length, 1);
    const reason = (parked[0].data as { reason: string }).reason;
    assert.ok(reason.includes(`missing in target 'notes'`),
      `park reason must name the target whose branch is missing (got: ${reason})`);

    // Nothing merged anywhere: target main unmoved, no item.merged event.
    assert.equal(git(targetRoot, ['rev-parse', 'main']).stdout.toString().trim(), targetMainBefore,
      'the target main must be unmoved');
    assert.equal(events.filter(e => e.type === 'item.merged' && e.item === 'WI-101').length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
