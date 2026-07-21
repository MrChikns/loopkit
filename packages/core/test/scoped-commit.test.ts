/**
 * scoped-commit.test.ts — Tests for scoped-commit fallback staging (dispatch.ts).
 *
 * Covers:
 *   planScopedCommit — pure unit tests (Touches partition, manifest widening, exemptions)
 *   fallback staging  — dispatch stages only in-scope files, surfaces residue (integration)
 *   no-commit residue — nothing in scope → no-commit park carries the residue in its reason
 *   detached:false    — the worker spawn passes detached:false
 *   non-FF re-gate    — fresh-base recompute smoke (injection makes a full pin infeasible)
 *   batch-attribution — an unattributed batched item parks 'batched:' (not 'no-commit'), ops,
 *                        parkClass 'batch-attribution'
 *   removeWorktree    — exported helper; a normal remove succeeds
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import {
  runDispatch,
  planScopedCommit,
  removeWorktree,
} from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-scoped-commit-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    salvage: { enabled: false, maxPatchKb: 256 },
    ...overrides,
  };
}

async function seedLedger(ledgerDir: string, events: LedgerEvent[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

// ---------------------------------------------------------------------------
// planScopedCommit — pure unit tests
// ---------------------------------------------------------------------------

test('planScopedCommit: files within a Touches prefix are in-scope, an outside file is residue', () => {
  // touchPrefixes are ALREADY-NORMALIZED (as normalizeTouches would produce — no trailing slash).
  const plan = planScopedCommit(
    ['src/a.ts', 'src/sub/b.ts', '.ai/scratch/junk.md'],
    ['src'],
    [],
  );
  assert.deepEqual(plan.inScope.sort(), ['src/a.ts', 'src/sub/b.ts'].sort());
  assert.deepEqual(plan.residue, ['.ai/scratch/junk.md']);
});

test('planScopedCommit: a manifest-reported exact path outside all Touches prefixes is in-scope', () => {
  const plan = planScopedCommit(
    ['src/a.ts', 'docs/generated.md'],
    ['src'],
    ['docs/generated.md'],
  );
  assert.deepEqual(plan.inScope.sort(), ['docs/generated.md', 'src/a.ts'].sort());
  assert.deepEqual(plan.residue, []);
});

test('planScopedCommit: empty touchPrefixes AND empty manifestFiles → everything is residue', () => {
  const plan = planScopedCommit(['a.ts', 'b.ts'], [], []);
  assert.deepEqual(plan.inScope, []);
  assert.deepEqual(plan.residue.sort(), ['a.ts', 'b.ts'].sort());
});

test('planScopedCommit: package-lock.json and a co-located test file are in-scope via isTouchesExempt', () => {
  const plan = planScopedCommit(
    ['package-lock.json', 'packages/engine/test/foo.test.ts', 'unrelated/file.txt'],
    ['packages/engine/src/'],
    [],
  );
  assert.ok(plan.inScope.includes('package-lock.json'), 'package-lock.json is exempt anywhere');
  assert.ok(plan.inScope.includes('packages/engine/test/foo.test.ts'), 'co-located test file is exempt');
  assert.ok(plan.residue.includes('unrelated/file.txt'), 'unrelated file is residue');
});

// ---------------------------------------------------------------------------
// Fallback stages only in-scope files + surfaces residue (integration)
// ---------------------------------------------------------------------------

test('scoped commit fallback: commits only the in-scope file; out-of-scope residue stays uncommitted', async () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        md(join(req.cwd!, 'src'), { recursive: true });
        // In-scope: under the declared Touches prefix.
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        // Out-of-scope: scratch/residue the worker should NOT get credit for committing.
        // Modeled as node_modules plumbing (isDependencyPlumbing) rather than an arbitrary
        // scratch file: a plain uncommitted scratch file would ALSO trip the separate
        // verifyWorktreeState dirty-tree check right after the commit fallback (a real,
        // pre-existing invariant this test does not touch) and the item would still park —
        // proving nothing about the scoped-commit fallback's scoping specifically. node_modules
        // plumbing is the one out-of-scope residue class dispatch already tolerates end-to-end,
        // so it isolates the assertion to "did the fallback COMMIT only in-scope files" without
        // conflating it with the separate dirty-tree invariant.
        md(join(req.cwd!, 'node_modules', 'somepkg'), { recursive: true });
        wf(join(req.cwd!, 'node_modules', 'somepkg', 'index.js'), '// pkg', 'utf8');
        // Deliberately make NO commit — simulates the denied-commit-command class.
        return { ok: true, text: 'done, but could not commit' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched[0].gateOutcome, 'passed', 'in-scope file lets the item merge');

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 reaches merged state');

    // The merged commit on master must NOT include the out-of-scope file.
    const showFiles = spawnSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' })
      .stdout.toString();
    assert.ok(showFiles.includes('src/x.ts'), 'in-scope file IS in the merged commit');
    assert.ok(!showFiles.includes('node_modules'), 'out-of-scope (dependency plumbing) file is NOT in the merged commit');
  } finally {
    cleanDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Nothing in scope → no-commit park with residue in reason
// ---------------------------------------------------------------------------

test('scoped commit fallback: worker touches ONLY out-of-scope files → no-commit park whose reason carries the residue', async () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { writeFileSync: wf } = await import('node:fs');
        // Only an out-of-scope file (flat, at repo root, so porcelain reports the exact
        // filename rather than collapsing a brand-new untracked directory into one line),
        // no commit, no manifest.
        wf(join(req.cwd!, 'scratch.md'), '# scratch', 'utf8');
        return { ok: true, text: 'done, only scratch touched' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched[0].gateOutcome, 'failed', 'no in-scope change → the build fails/parks');

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.equal(parked.length, 1, 'exactly one item.parked for WI-001');
    const reason = (parked[0].data as { reason: string; parkKind?: string }).reason;
    assert.ok(reason.includes('no-commit'), 'reason still carries the no-commit class token');
    assert.ok(reason.includes('scratch.md'), 'reason names the residue file');
    assert.equal((parked[0].data as { parkKind?: string }).parkKind, 'ops', 'parkKind stays ops');
  } finally {
    cleanDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// detached:false at the dispatch call site
// ---------------------------------------------------------------------------

test('worker spawn: passes detached:false', async () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    // Only the actual builder call sets req.exitFile (scout/judge calls never do) — key the
    // capture on that so we isolate the real build dispatch request.
    let capturedDetached: boolean | undefined;
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (!req.exitFile) return { ok: true, text: 'ok' };
        capturedDetached = req.detached;
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        spawnSync('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): x'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.equal(capturedDetached, false, 'the worker spawn request must carry detached:false');
  } finally {
    cleanDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Non-FF re-gate against a fresh base — smoke variant
// ---------------------------------------------------------------------------
// NOTE: injecting nonFfGateResult short-circuits runLaneGate entirely, so the base sha it
// would have been called with is not observable through the public API. A full pin would
// require a real second `origin` remote plus a genuine push race, which is heavier than this
// bounded task warrants. This is the documented SMOKE variant: it exercises the non-FF
// recovery path end-to-end with the fresh-base recompute in place (fresh fetch + rev-parse +
// reset + re-merge + recomputed changed files) and asserts the item still lands merged —
// proving the refactor didn't break the path — without pinning the exact base sha passed
// to the gate.

test('non-FF push recovery (smoke): still merges successfully with the fresh-base recompute in place', async () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    // A real second "origin" so `git fetch origin master` + `rev-parse origin/master` resolve
    // for real (the fresh-base recompute touches both).
    const originDir = join(tmpDir, 'origin.git');
    spawnSync('git', ['init', '--bare', '-b', 'master', originDir], { stdio: 'pipe' });
    g(['remote', 'add', 'origin', originDir]);
    g(['push', '-u', 'origin', 'master']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        spawnSync('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): x'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    // First push attempt "fails" (simulated non-FF); the retry (2nd doPush call) is real —
    // it will genuinely succeed since nothing else has pushed to origin in this test.
    let pushCall = 0;
    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => {
        pushCall++;
        if (pushCall === 1) {
          return { status: 1, stderr: Buffer.from('! [rejected] master -> master (non-fast-forward)') };
        }
        const r = spawnSync('git', ['push'], { cwd: repoRoot, stdio: 'pipe' });
        return { status: r.status };
      },
      nonFfGateResult: { passed: true, reason: 'ok' },
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched[0].gateOutcome, 'passed', 'non-FF recovery still lands the item');
    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 reaches merged state after non-FF recovery');
    assert.equal(pushCall, 2, 'push was retried exactly once after the simulated non-FF rejection');
  } finally {
    cleanDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Batch-attribution ops-park
// ---------------------------------------------------------------------------

test('batch attribution: an unattributed batched item parks batch-attribution, not no-commit', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-batch-attribution-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    // WI-002 declares 'src/bar' — a SUBDIRECTORY of WI-001's 'src/', so the two still
    // touchesConflict (overlap on a segment boundary) and co-locate into one batch, but the
    // actual changed file (src/shared.ts) does NOT fall within 'src/bar' — so the Touches-prefix
    // fallback correctly does NOT credit WI-002 (it would have, had both declared plain 'src/').
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'do B', touches: 'src/bar', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    // Worker commits ONE file, subject mentions only WI-001, no manifests at all — so WI-002
    // has no attributable file (no manifest, no subject match, no Touches-prefix hit).
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/shared.ts'), '// shared', 'utf8');
        spawnSync('git', ['add', 'src/shared.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): shared work'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 1, 'one worktree dispatched (batched)');

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 merged (attributed via commit subject)');
    assert.equal(folded.items.get('WI-002')?.state, 'parked', 'WI-002 parked (unattributed)');

    const parked = events.find(e => e.type === 'item.parked' && e.item === 'WI-002');
    assert.ok(parked, 'WI-002 has an item.parked event');
    const reason = (parked!.data as { reason: string }).reason;
    assert.ok(reason.includes('batched: no files attributable'), 'reason uses the batched: class, not no-commit');
    assert.ok(!/no-commit/i.test(reason), 'reason must NOT match the no-commit breaker predicate');
    assert.equal((parked!.data as { parkKind?: string }).parkKind, 'ops', 'parkKind is ops');

    const wi002Rec = folded.items.get('WI-002');
    assert.equal(wi002Rec?.parkClass, 'batch-attribution', 'fold records parkClass batch-attribution');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removeWorktree fallback
// ---------------------------------------------------------------------------

test('removeWorktree: removes a normal worktree cleanly', () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    const wtPath = join(tmpDir, 'wt-1');
    const add = g(['worktree', 'add', '-b', 'wt-branch-1', wtPath, 'HEAD']);
    assert.equal(add.status, 0, 'worktree add must succeed for the test setup');
    assert.ok(existsSync(wtPath), 'worktree exists before removal');

    removeWorktree(repoRoot, wtPath);

    assert.ok(!existsSync(wtPath), 'worktree directory no longer exists');
    const list = spawnSync('git', ['worktree', 'list'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString();
    assert.ok(!list.includes(wtPath), 'git worktree list no longer references the removed path');
  } finally {
    cleanDir(tmpDir);
  }
});

test('removeWorktree: falls back to rm+prune when the worktree dir was already deleted out-of-band', () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    const wtPath = join(tmpDir, 'wt-2');
    const add = g(['worktree', 'add', '-b', 'wt-branch-2', wtPath, 'HEAD']);
    assert.equal(add.status, 0, 'worktree add must succeed for the test setup');

    // Simulate the dir having vanished out-of-band (e.g. a prior crash mid-cleanup) — this
    // makes `git worktree remove` fail (administrative files reference a missing path in some
    // git versions) or, if git tolerates it, simply be a no-op; either way removeWorktree's
    // rm+prune fallback must leave the registration clean.
    rmSync(wtPath, { recursive: true, force: true });

    removeWorktree(repoRoot, wtPath);

    const list = spawnSync('git', ['worktree', 'list'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString();
    assert.ok(!list.includes(wtPath), 'git worktree list is clean after the fallback prune');
  } finally {
    cleanDir(tmpDir);
  }
});
