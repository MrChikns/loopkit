/**
 * dispatch-target-guard.test.ts — WI-246: dispatch's target lane must fail LOUDLY, up front,
 * when a registered target's repoPath no longer matches the actual git repo on disk.
 *
 * WI-208 (a item on another registered plane target) burned 4 build attempts because the dispatcher created/inspected
 * a worktree against the WRONG repo — the target registry's repoPath had drifted from the repo
 * root it was actually pointed at — and nothing crashed; the mismatch was only found on attempt
 * 4. `target add` (cli.ts) pins repoPath to `git rev-parse --show-toplevel` at registration
 * time, so resolveTargetForBuild re-derives that SAME toplevel immediately before any worktree
 * is created and aborts the build with both paths named in the reason when they disagree,
 * instead of silently building against the wrong tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { manifestHash, readTargetManifest } from '../src/target.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { makeNonCommittingWorker } from './fakeWorker.js';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

/** A minimal, valid loopkit target repo (mirrors target-e2e.test.ts's notes-template shape,
 *  but inlined here so this file has no dependency on the examples/ fixture). */
function makeTargetRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'src', 'notes.js'), 'export const marker = 1;\n', 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'notes', version: '1.0.0', type: 'module' }, null, 2) + '\n', 'utf8');
  writeFileSync(join(root, 'loopkit.target.json'), JSON.stringify({
    name: 'notes',
    defaultBranch: 'main',
    gateCommand: 'true',
    worktreePrefix: 'notes-',
  }, null, 2) + '\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init notes target']);
}

function makePlaneRepo(root: string): void {
  mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
  git(root, ['init', '-b', 'master']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'plane.txt'), 'plane', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init plane']);
}

function testConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return { ...CONFIG_DEFAULTS, promptsDir: '.ai/loops/prompts', notifyHook: '.ai/notify-phone.sh', ...overrides };
}

test('WI-246: target/repoRoot mismatch (registered repoPath got absorbed as a SUBDIRECTORY of a different repo) crashes the build loudly, naming both paths', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-guard-'));
  try {
    const planeRoot = join(base, 'plane');
    const outerRoot = join(base, 'outer');
    const registeredPath = join(outerRoot, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);

    // WI-208's actual shape: the target was registered against a real, standalone git repo
    // (readTargetManifest succeeds at registration — the registration itself is not wrong).
    // Register it FIRST, using its own real toplevel (exactly what `target add` does).
    makeTargetRepo(registeredPath);
    const manifest = readTargetManifest(registeredPath);
    const hash = manifestHash(manifest);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: registeredPath, manifestHash: hash, defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-246', 'item.captured', { source: 'cli', text: 'add marker', target: 'notes' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-246', 'item.queued', { spec: 'add a marker helper', touches: 'src/' }, '2026-01-01T00:02:00Z'),
    ]);

    // The drift, BY BUILD TIME: the repo's own `.git` is gone (moved/replaced/absorbed — the
    // "reused directory" class WI-208 hit) and the directory now lives as a plain subfolder
    // of an UNRELATED outer repo. `loopkit.target.json` still sits at the same relative path
    // (so readTargetManifest still succeeds — resolution never even reaches "manifest
    // unreadable"), but `git rev-parse --show-toplevel` from the registered path now walks up
    // to the OUTER repo's root, a genuinely different directory than what was registered.
    rmSync(join(registeredPath, '.git'), { recursive: true, force: true });
    git(outerRoot, ['init', '-b', 'main']);
    git(outerRoot, ['config', 'user.email', 't@t']);
    git(outerRoot, ['config', 'user.name', 't']);
    git(outerRoot, ['add', '-A']);
    git(outerRoot, ['commit', '-m', 'absorb notes as a subfolder']);

    const provider = makeNonCommittingWorker({
      name: 'fake',
      files: [{ path: 'src/extra.js', contents: 'export const marker = 42;\n' }],
      manifest: {
        wi: 'WI-246', filesTouched: ['src/extra.js'], testsAdded: [], confidence: 0.9,
        notes: 'added marker', subject: 'feat(WI-246): add marker',
      },
    });

    await runDispatch({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: testConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);

    // The build must crash with an explicit, named reason — never silently attempt a worktree
    // against the wrong repo.
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-246');
    assert.equal(crashed.length, 1, 'exactly one build.crashed for the mismatched target');
    const reason = (crashed[0].data as { reason: string }).reason;
    assert.match(reason, /mismatch/i, 'crash reason must name the mismatch');
    assert.ok(reason.includes(registeredPath), `crash reason must name the registered repoPath (${registeredPath}): ${reason}`);
    const actualToplevel = git(registeredPath, ['rev-parse', '--show-toplevel']).stdout.toString().trim();
    assert.ok(reason.includes(actualToplevel), `crash reason must name the actual (drifted-to) git toplevel (${actualToplevel}): ${reason}`);
    assert.notEqual(actualToplevel, registeredPath, 'precondition: the toplevel really must have drifted away from the registered path');

    // Parked immediately (first attempt) — no burned attempts, no worktree/build ever ran.
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-246');
    assert.equal(parked.length, 1, 'item must park on the very first attempt, not after retries');
    const folded = fold(events);
    assert.equal(folded.items.get('WI-246')?.attempts ?? 0, 0, 'no build attempt should be burned — the guard fires before any worktree is created');

    // Decisive: no worktree/branch of the item was ever created in the drifted-to (outer) repo.
    const outerBranches = git(outerRoot, ['branch', '--list']).stdout.toString();
    assert.doesNotMatch(outerBranches, /wi-246/i, 'no build branch must have been created against the drifted-to repo');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('WI-246: a matching target/repoRoot (registered repoPath IS the real toplevel) builds and merges normally — guard is a no-op on the happy path', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-guard-match-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeTargetRepo(targetRoot);

    const manifest = readTargetManifest(targetRoot);
    const hash = manifestHash(manifest);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-247', 'item.captured', { source: 'cli', text: 'add marker', target: 'notes' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-247', 'item.queued', { spec: 'add a marker helper', touches: 'src/' }, '2026-01-01T00:02:00Z'),
    ]);

    const provider = makeNonCommittingWorker({
      name: 'fake',
      files: [{ path: 'src/extra.js', contents: 'export const marker = 42;\n' }],
      manifest: {
        wi: 'WI-247', filesTouched: ['src/extra.js'], testsAdded: [], confidence: 0.9,
        notes: 'added marker', subject: 'feat(WI-247): add marker',
      },
    });

    await runDispatch({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: testConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-247')?.state, 'merged', `WI-247 must merge; events: ${JSON.stringify(events.map(e => e.type))}`);
    assert.equal(events.filter(e => e.type === 'build.crashed' && e.item === 'WI-247').length, 0, 'no crash on the matching-path happy path');

    const targetLog = git(targetRoot, ['log', '--oneline', 'main']).stdout.toString();
    assert.match(targetLog, /WI-247 \(target notes\)/, 'the merge commit must land on the target repo main');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
