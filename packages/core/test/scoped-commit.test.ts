/**
 * scoped-commit.test.ts — Tests for scoped-commit fallback staging AND the post-commit
 * diff guards it shares a call site with (dispatch.ts).
 *
 * Covers:
 *   diff guards      — checkSpine / checkTouchesOverstep / isTouchesExempt /
 *                      isPreviouslyApproved / loadApprovedTouches, asserted at the PREDICATE
 *                      BOUNDARY (WI-195: a mutation run proved every one of these was only ever
 *                      exercised through a caller's happy path, so the boolean could be pinned
 *                      always-true, inverted, or deleted with the suite still green)
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
  checkSpine,
  checkTouchesOverstep,
  isTouchesExempt,
  isPreviouslyApproved,
  loadApprovedTouches,
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
// Diff-guard predicate boundaries (WI-195)
//
// Every assertion below was written against a SPECIFIC surviving mutant and proven to go red
// when that mutation is applied to dispatch.ts. Read each `// kills:` note as the contract the
// test exists to hold — the happy-path integration tests further down this file exercise the
// same code but pin none of these boundaries.
// ---------------------------------------------------------------------------

// ── checkSpine ─────────────────────────────────────────────────────────────
// The spine check parks a diff that touches the plane's own event contracts. It scored 28.6%
// on the mutation run — the worst in the kernel — because no test ever called it with a
// non-empty pattern that matches.

const SPINE_RE = '^packages/core/src/(schema|ledger)\\.ts$';

test('checkSpine: a diff touching a spine file reports touched=true and names EXACTLY the spine files', () => {
  const spine = checkSpine(SPINE_RE, [
    'packages/core/src/schema.ts',
    'docs/notes.md',
    'packages/core/src/ledger.ts',
  ]);
  // kills: the `if (!spineRegex)` early return forced true (would report touched=false, i.e.
  //        the spine check permanently disabled);
  // kills: `spineFiles.length > 0` → `<= 0` (would invert touched to false);
  // kills: `changedFiles.filter(...)` → `changedFiles` (files would include docs/notes.md).
  assert.equal(spine.touched, true, 'a diff hitting a declared spine surface must be flagged');
  assert.deepEqual(spine.files, ['packages/core/src/schema.ts', 'packages/core/src/ledger.ts'],
    'only the matching files are reported — the non-matching diff entry must be filtered out');
});

test('checkSpine: a diff that matches nothing reports touched=false with no files', () => {
  const spine = checkSpine(SPINE_RE, ['docs/notes.md', 'packages/ui/src/button.ts']);
  // kills: `spineFiles.length > 0` → `>= 0` (would pin touched always-true, parking every build).
  assert.equal(spine.touched, false, 'a non-spine diff must not park');
  assert.deepEqual(spine.files, []);
});

test('checkSpine: an empty pattern means "no spine declared", never "match everything"', () => {
  // kills: deleting the `if (!spineRegex)` guard — `new RegExp('')` matches at position 0 of
  // every string, so every framework-default install would park its first diff.
  const spine = checkSpine('', ['packages/core/src/schema.ts']);
  assert.equal(spine.touched, false);
  assert.deepEqual(spine.files, []);
});

// ── loadApprovedTouches ────────────────────────────────────────────────────

test('loadApprovedTouches: approvals do NOT leak across work items or across event types', () => {
  const approval = (item: string, files: string[]): LedgerEvent =>
    makeEvent('operator', item, 'item.approved', { by: 'operator', approvedTouches: files });
  const events: LedgerEvent[] = [
    approval('WI-A', ['packages/a/src/one.ts']),
    approval('WI-B', ['packages/b/src/two.ts']),
    // Same item, but a DIFFERENT event type that happens to carry the same field shape.
    makeEvent('operator', 'WI-A', 'item.parked', {
      reason: 'touches overstep',
      approvedTouches: ['packages/c/src/three.ts'],
    } as unknown as { reason: string }),
  ];
  // kills: `ev.item !== itemId || ev.type !== 'item.approved'` forced false (nothing skipped —
  //        every item's approvals leak into every other item's overstep gate);
  // kills: the same condition's `||` → `&&` (each half alone stops skipping).
  assert.deepEqual(loadApprovedTouches(events, 'WI-A'), ['packages/a/src/one.ts'],
    "WI-B's approval and WI-A's non-approval event must both be ignored");
  assert.deepEqual(loadApprovedTouches(events, 'WI-B'), ['packages/b/src/two.ts']);
  assert.deepEqual(loadApprovedTouches(events, 'WI-C'), [], 'an item with no approvals gets nothing');
});

// ── checkTouchesOverstep ───────────────────────────────────────────────────

test('checkTouchesOverstep: the two escape hatches (wildcard, no declared prefixes) return null', () => {
  // `null` means "no Touches to enforce" and is NOT the same as `[]` ("enforced, nothing
  // overstepped") — the caller branches on it.
  // kills: `touches === '*'` forced false (a wildcard item would park on its own first file);
  // kills: `prefixes.length === 0` forced false (same for an item with no declared Touches).
  assert.equal(checkTouchesOverstep(['anywhere/at/all.ts'], '*'), null, 'wildcard Touches is unenforced');
  assert.equal(checkTouchesOverstep(['anywhere/at/all.ts'], ''), null, 'no declared prefixes is unenforced');
  assert.equal(checkTouchesOverstep(['anywhere/at/all.ts'], ' , , '), null,
    'a Touches string that normalizes to zero prefixes is unenforced');
});

test('checkTouchesOverstep: with real prefixes it returns the offenders and an empty array when clean', () => {
  assert.deepEqual(
    checkTouchesOverstep(['packages/a/src/x.ts', 'packages/b/src/y.ts'], 'packages/a/'),
    ['packages/b/src/y.ts'],
    'a file outside the declared prefix is an overstep',
  );
  assert.deepEqual(checkTouchesOverstep(['packages/a/src/x.ts'], 'packages/a/'), [],
    'a fully in-scope diff is enforced-and-clean ([]), not unenforced (null)');
});

// ── isPreviouslyApproved ───────────────────────────────────────────────────

test('isPreviouslyApproved: an exact match OR a same-directory sibling of an approved path counts', () => {
  // kills: the `||` → `&&` (which collapses the rule into "must be BOTH the same file and a
  //        sibling", i.e. re-parking every already-approved sibling forever).
  assert.equal(isPreviouslyApproved('a/b/new.ts', ['a/b/old.ts']), true,
    'a sibling in the same directory as an approved path is covered');
  assert.equal(isPreviouslyApproved('a/b/old.ts', ['a/b/old.ts']), true, 'the exact approved path is covered');
  assert.equal(isPreviouslyApproved('a/c/new.ts', ['a/b/old.ts']), false,
    'a genuinely new directory is NOT covered — it must still park');
  assert.equal(isPreviouslyApproved('a/b/new.ts', []), false, 'nothing approved → nothing covered');
});

// ── isTouchesExempt ────────────────────────────────────────────────────────

test('isTouchesExempt: the test-file marker is anchored — `foo.test.js.bak` is NOT a test file', () => {
  const prefixes = ['packages/engine/src'];
  // kills: removing the `$` anchor from /\.(test|spec)\.[jt]sx?$/ — the same too-loose-marker
  // defect that bit the lane matrix. A backup/patch/generated artifact that merely CONTAINS
  // `.test.js` would otherwise be waved through the overstep gate as a co-located test.
  assert.equal(isTouchesExempt('packages/engine/src/foo.test.js.bak', prefixes), false,
    'a .bak artifact must not be exempt just because `.test.js` appears in its name');
  assert.equal(isTouchesExempt('packages/engine/src/foo.test.js', prefixes), true,
    'the genuinely test-suffixed sibling IS exempt (the anchor must not over-tighten either)');
});

test('isTouchesExempt: a plain source file and an out-of-package test are both non-exempt', () => {
  const prefixes = ['packages/engine/src'];
  // kills: `if (!isTestFile) return false` → `return true` (every unrelated source file exempt).
  assert.equal(isTouchesExempt('docs/readme.md', prefixes), false, 'a non-test file is never exempt');
  // kills: the trailing `return false` → `return true` (a test file under a DIFFERENT package
  //        would be exempt, defeating the point of scoping the exemption to the package root).
  assert.equal(isTouchesExempt('packages/other/test/x.test.ts', prefixes), false,
    "a test file outside the touched package's root is not exempt");
  assert.equal(isTouchesExempt('packages/engine/test/x.test.ts', prefixes), true,
    'a test under the SAME package root is exempt');
  assert.equal(isTouchesExempt('any/where/package-lock.json', prefixes), true,
    'package-lock.json is exempt anywhere');
});

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

test('planScopedCommit: a co-located test file is exempt for a FLAT (target-repo) layout too — ' +
  'not just the packages/<name>/ monorepo shape (regression guard: this exemption must apply ' +
  'identically in the target lane, which has no packages/ wrapper)', () => {
  const plan = planScopedCommit(
    ['src/extra.js', 'test/extra.test.js', 'unrelated/file.txt'],
    ['src'],
    [],
  );
  assert.ok(plan.inScope.includes('src/extra.js'), 'the touched-prefix file is in-scope');
  assert.ok(plan.inScope.includes('test/extra.test.js'), 'a sibling top-level test file is exempt (co-located, same repo root)');
  assert.ok(plan.residue.includes('unrelated/file.txt'), 'unrelated file is still residue');
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
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/runs/\n', 'utf8');
    g(['add', 'base.txt', '.gitignore']);
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
