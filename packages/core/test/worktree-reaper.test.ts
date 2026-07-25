/**
 * worktree-reaper.test.ts — leaked-worktree reaper: parses `git worktree list --porcelain`,
 * classifies each worktree against the safety invariant (never reap a live-owned, claimed,
 * dirty, or too-young dir), and drives removal only on genuinely-leaked ones, per registered
 * target. All liveness signals are injected so the tests are hermetic (no real git, no real
 * clock, no real fs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold, FoldResult } from '../src/fold.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import {
  parseWorktreePorcelain,
  classifyWorktree,
  isManagedWorktreeName,
  extractWorktreeItemId,
  newestMtimeMs,
  reapLeakedWorktrees,
  WorktreeInfo,
  ReapContext,
} from '../src/worktree-reaper.js';

const ROOT = '/Users/x/Projects/acme-web';
const SIB = (name: string): string => `/Users/x/Projects/${name}`;
const HOUR = 60 * 60 * 1000;

function ctx(over: Partial<ReapContext> = {}): ReapContext {
  return {
    repoRoot: ROOT,
    activeBuildPaths: new Set<string>(),
    now: 10 * HOUR,
    graceMs: 40 * 60 * 1000,
    mtimeMsOf: () => 0,             // default: ancient (way past grace)
    isDirty: () => false,           // default: clean (would otherwise mask the age guards)
    claimedItemIds: new Set<string>(),
    ...over,
  };
}

const wt = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo =>
  ({ path, ...over });

// ── managed-name predicate ────────────────────────────────────────────────────

test('isManagedWorktreeName: matches build + appr trees, external + local prefixes', () => {
  assert.equal(isManagedWorktreeName('acme-web-tgt-xy12-wi-140-a1'), true);  // external target
  assert.equal(isManagedWorktreeName('loop-wi-7-a2'), true);                     // local build
  assert.equal(isManagedWorktreeName('acme-web-appr-99'), true);                 // approval tree
  assert.equal(isManagedWorktreeName('acme-web'), false);                        // the repo itself
  assert.equal(isManagedWorktreeName('my-experiment'), false);                   // human worktree
  assert.equal(isManagedWorktreeName('release-wip'), false);
});

// ── parser ──────────────────────────────────────────────────────────────────

test('parseWorktreePorcelain: main + branch + detached + a locked entry (locked field dropped)', () => {
  const out = [
    `worktree ${ROOT}`,
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    `worktree ${SIB('acme-web-tgt-1-wi-140-a1')}`,
    'HEAD def456',
    'branch refs/heads/acme-web-tgt-1-wi-140-a1',
    '',
    `worktree ${SIB('acme-web-appr-99')}`,
    'HEAD 999aaa',
    'detached',
    '',
    `worktree ${SIB('acme-web-tgt-1-wi-7-a2')}`,
    'HEAD 777bbb',
    'branch refs/heads/acme-web-tgt-1-wi-7-a2',
    'locked claude agent xyz (pid 42807 start ...)',
    '',
  ].join('\n');
  const got = parseWorktreePorcelain(out);
  assert.equal(got.length, 4);
  // The porcelain "locked" line is intentionally not parsed into WorktreeInfo — nothing in
  // loopkit ever runs `git worktree lock`, so trusting it would be a guard that never fires.
  assert.deepEqual(got[0], { path: ROOT, branch: 'main' });
  assert.equal(got[1]!.branch, 'acme-web-tgt-1-wi-140-a1');
  assert.equal(got[2]!.branch, undefined);          // detached
  assert.equal(got[3]!.branch, 'acme-web-tgt-1-wi-7-a2');
  assert.equal((got[3] as { locked?: boolean }).locked, undefined);
});

// ── classifier: scope guards ──────────────────────────────────────────────────

test('classify: the primary checkout is never reaped', () => {
  const v = classifyWorktree(wt(ROOT, { branch: 'main' }), ctx());
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'main-worktree');
});

test('classify: a dir under the root (harness .claude/worktrees) is not a sibling → spared', () => {
  const v = classifyWorktree(wt(`${ROOT}/.claude/worktrees/agent-abc`), ctx());
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'not-sibling');
});

test('classify: a sibling that is a human-added worktree (non-convention name) is spared', () => {
  const v = classifyWorktree(wt(SIB('acme-web-experiment')), ctx());
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'not-managed');
});

// ── classifier: liveness guards ───────────────────────────────────────────────

test('classify: a worktree the fold still attaches to a build is spared (doctor owns it)', () => {
  const p = SIB('acme-web-tgt-1-wi-9-a1');
  const v = classifyWorktree(wt(p), ctx({ activeBuildPaths: new Set([p]) }));
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'active-build');
});

test('classify: a worktree covered by an active session claim is spared (attended safety)', () => {
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-7-a2')),
    ctx({ claimedItemIds: new Set(['WI-7']) }),
  );
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'claimed');
});

test('classify: an unclaimed WI worktree is not spared by the claim guard (falls through)', () => {
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-7-a2')),
    ctx({ claimedItemIds: new Set(['WI-999']) }),   // some OTHER item is claimed
  );
  assert.equal(v.reap, true);
});

test('extractWorktreeItemId: pulls the WI number out of the managed-name convention', () => {
  assert.equal(extractWorktreeItemId('acme-web-tgt-1-wi-140-a1'), 'WI-140');
  assert.equal(extractWorktreeItemId('loopkit-wi-169-a1'), 'WI-169');
  // the approval tree carries no item id — it's a merge scratch tree, not a claimable item
  assert.equal(extractWorktreeItemId('acme-web-appr-99'), undefined);
  assert.equal(extractWorktreeItemId('acme-web-experiment'), undefined);
});

// ── classifier: dirty-tree guard (never destroy uncommitted work) ────────────────

test('classify: a dirty worktree (modified/staged changes) is spared, never force-removed', () => {
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-7-a2')),
    ctx({ isDirty: () => true }),
  );
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'dirty');
});

test('classify: an untracked-only worktree (new file, nothing tracked changed) is spared', () => {
  // isDirty is defined as "git status --porcelain is non-empty", which is true for a lone
  // untracked file — untracked matters most: a brand-new file is pure loss if force-removed.
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-8-a1')),
    ctx({ isDirty: (p) => p === SIB('acme-web-tgt-1-wi-8-a1') }),
  );
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'dirty');
});

test('classify: a clean, unclaimed, old worktree still reaps (dirty guard does not over-spare)', () => {
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-7-a2')),
    ctx({ isDirty: () => false }),
  );
  assert.equal(v.reap, true);
});

// ── classifier: age guards ────────────────────────────────────────────────────

test('classify: a too-young worktree is spared (race with a just-created build)', () => {
  const now = 10 * HOUR;
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-5-a1')),
    ctx({ now, mtimeMsOf: () => now - 60_000 }),   // 1 min old, grace is 40 min
  );
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'too-young');
});

test('classify: unreadable mtime defers (no signal is not evidence of death)', () => {
  const v = classifyWorktree(wt(SIB('acme-web-tgt-1-wi-5-a1')), ctx({ mtimeMsOf: () => null }));
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'age-unknown');
});

test('classify: an old, ownerless, unlocked managed sibling is reaped', () => {
  const v = classifyWorktree(wt(SIB('acme-web-tgt-1-wi-140-a1')), ctx());
  assert.equal(v.reap, true);
  assert.equal((v as { reason: string }).reason, 'leaked');
});

// ── newestMtimeMs: real filesystem, deep activity is not invisible ───────────────

test('newestMtimeMs: a worktree whose deep files are recent is NOT considered stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'reaper-mtime-'));
  try {
    const oldMs = Date.now() - 2 * HOUR;
    utimesSync(root, new Date(oldMs), new Date(oldMs));   // root dir itself looks ancient

    const deep = join(root, 'packages', 'core', 'src');
    mkdirSync(deep, { recursive: true });
    const deepFile = join(deep, 'reactor.ts');
    writeFileSync(deepFile, 'recent edit');   // fresh mtime — "just now"

    // exercise the module's exported scanner directly (no injection) against the real fs
    const newest = newestMtimeMs(root);
    assert.ok(newest != null);
    // the deep file's fresh mtime must win over the root dir's stale mtime — this is the fix:
    // the OLD behaviour (root-dir-mtime-only) would have returned `oldMs` here and called a
    // worktree with an edit from a second ago "40 minutes idle".
    assert.ok(newest! > oldMs + 60_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classify: real deep activity (via newestMtimeMs) reads too-young, not leaked', () => {
  const parent = mkdtempSync(join(tmpdir(), 'reaper-classify-'));
  const repoRoot = join(parent, 'acme-web');
  const wtPath = join(parent, 'acme-web-tgt-1-wi-5-a1');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(wtPath, { recursive: true });
  try {
    const oldMs = Date.now() - 2 * HOUR;
    utimesSync(wtPath, new Date(oldMs), new Date(oldMs));   // worktree root looks ancient

    const deep = join(wtPath, 'src');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'file.ts'), 'a fresh edit');    // fresh mtime — activity now

    const now = Date.now();
    const v = classifyWorktree(
      wt(wtPath),
      ctx({ repoRoot, now, graceMs: 40 * 60 * 1000, mtimeMsOf: newestMtimeMs }),
    );
    assert.equal(v.reap, false);
    assert.equal((v as { reason: string }).reason, 'too-young');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('newestMtimeMs: .git and node_modules are excluded from the scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'reaper-mtime-excl-'));
  try {
    const oldMs = Date.now() - 2 * HOUR;
    utimesSync(root, new Date(oldMs), new Date(oldMs));

    const gitDir = join(root, '.git', 'objects');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'pack'), 'fresh git internals');   // fresh mtime, must be ignored

    const nmDir = join(root, 'node_modules', 'somepkg');
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, 'index.js'), 'fresh dep');          // fresh mtime, must be ignored

    const srcFile = join(root, 'src.ts');
    writeFileSync(srcFile, 'x');
    utimesSync(srcFile, new Date(oldMs), new Date(oldMs));        // the only counted file: old

    // creating the .git/node_modules/src.ts direct entries just above bumped root's OWN
    // mtime (a directory's mtime changes when its direct entries change) — reset it old
    // again so the only fresh signals left are the ones we're asserting get excluded.
    utimesSync(root, new Date(oldMs), new Date(oldMs));

    const newest = newestMtimeMs(root);
    assert.ok(newest != null);
    // newest must reflect the old src file (or the old root), not the fresh excluded dirs
    assert.ok(newest! < Date.now() - 60_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── driver ────────────────────────────────────────────────────────────────────

function foldWithBuildingWorktree(worktreePath: string): FoldResult {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-9', 'item.captured', { source: 'test', text: 'build a thing' }),
    makeEvent('reactor', 'WI-9', 'item.queued', { spec: 'x', touches: 'a' }),
    makeEvent('dispatch', 'WI-9', 'build.dispatched', { attempt: 1, pid: 111, worktree: worktreePath }),
  ];
  return fold(events);
}

test('reapLeakedWorktrees: removes leaked siblings, spares the live build and the main tree', () => {
  const liveBuild = SIB('acme-web-tgt-1-wi-9-a1');
  const leakedA = SIB('acme-web-tgt-1-wi-140-a1');
  const leakedB = SIB('acme-web-appr-99');
  const humanTree = SIB('acme-web-experiment');
  const removed: string[] = [];

  const res = reapLeakedWorktrees(
    ROOT,
    foldWithBuildingWorktree(liveBuild),
    {
      now: 10 * HOUR,
      graceMs: 40 * 60 * 1000,
      mtimeMsOf: () => 0,                       // everything ancient
      isDirty: () => false,                     // everything clean
      listWorktrees: () => [
        wt(ROOT, { branch: 'main' }),
        wt(liveBuild, { branch: 'acme-web-tgt-1-wi-9-a1' }),
        wt(leakedA, { branch: 'acme-web-tgt-1-wi-140-a1' }),
        wt(leakedB),                            // detached appr worktree
        wt(humanTree, { branch: 'experiment' }),
      ],
      removeWorktree: (_root, p) => { removed.push(p); },
    },
  );

  assert.deepEqual(removed.sort(), [leakedA, leakedB].sort());
  assert.deepEqual(res.reaped.map(r => r.path).sort(), [leakedA, leakedB].sort());
  assert.ok(res.reaped.every(r => r.reason === 'leaked'));
  // the live build is a managed sibling that was spared → it shows up in `spared`
  assert.ok(res.spared.some(s => s.path === liveBuild && s.reason === 'active-build'));
  // the main tree, human worktree, and repo itself are noise → not surfaced in `spared`
  assert.ok(!res.spared.some(s => s.path === ROOT || s.path === humanTree));
});

test('reapLeakedWorktrees: sweeps EACH registered target with its own worktree list', () => {
  // Two targets in different repos; each has one leaked worktree registered to its own .git.
  const targetAdd: LedgerEvent[] = [
    makeEvent('operator', 'acme-web', 'target.registered', {
      targetId: 'tgt-a', name: 'acme-web', repoPath: '/Users/x/Projects/acme-web',
      defaultBranch: 'main', manifestHash: 'h1',
    }),
    makeEvent('operator', 'widgets', 'target.registered', {
      targetId: 'tgt-b', name: 'widgets', repoPath: '/Users/x/Projects/widgets',
      defaultBranch: 'main', manifestHash: 'h2',
    }),
  ];
  const foldResult = fold(targetAdd);

  const leakedInA = '/Users/x/Projects/acme-web-tgt-a-wi-1-a1';
  const leakedInB = '/Users/x/Projects/widgets-tgt-b-wi-2-a1';
  const removed: Array<[string, string]> = [];

  const res = reapLeakedWorktrees(
    '/Users/x/Projects/acme-web',      // primary == target A (deduped)
    foldResult,
    {
      now: 10 * HOUR,
      graceMs: 0,
      mtimeMsOf: () => 0,
      isDirty: () => false,
      listWorktrees: (repoRoot) => repoRoot === '/Users/x/Projects/acme-web'
        ? [wt('/Users/x/Projects/acme-web', { branch: 'main' }), wt(leakedInA)]
        : [wt('/Users/x/Projects/widgets', { branch: 'main' }), wt(leakedInB)],
      removeWorktree: (root, p) => { removed.push([root, p]); },
    },
  );

  assert.deepEqual(res.reaped.map(r => r.path).sort(), [leakedInA, leakedInB].sort());
  // each removal ran with the OWNING repo as cwd (worktrees belong to their target's .git)
  assert.ok(removed.some(([root, p]) => root === '/Users/x/Projects/acme-web' && p === leakedInA));
  assert.ok(removed.some(([root, p]) => root === '/Users/x/Projects/widgets' && p === leakedInB));
});

test('reapLeakedWorktrees: a removal that throws does not abort the sweep', () => {
  const leakedA = SIB('acme-web-tgt-1-wi-1-a1');
  const leakedB = SIB('acme-web-tgt-1-wi-2-a1');
  const removed: string[] = [];
  const res = reapLeakedWorktrees(
    ROOT,
    fold([]),
    {
      now: 10 * HOUR,
      graceMs: 0,
      mtimeMsOf: () => 0,
      isDirty: () => false,
      listWorktrees: () => [wt(leakedA), wt(leakedB)],
      removeWorktree: (_root, p) => {
        if (p === leakedA) throw new Error('git locked');
        removed.push(p);
      },
    },
  );
  assert.deepEqual(removed, [leakedB]);         // B still swept after A threw
  assert.deepEqual(res.reaped.map(r => r.path), [leakedB]);
});

test('reapLeakedWorktrees: a worktree covered by an active session claim is spared', () => {
  const claimedWt = SIB('acme-web-tgt-1-wi-7-a2');   // embeds WI-7 via the -wi-N-aM convention
  const leaked = SIB('acme-web-tgt-1-wi-140-a1');
  const removed: string[] = [];

  const events: LedgerEvent[] = [
    makeEvent('cli', 'ses-aaaaaaaa', 'session.started', { sessionId: 'ses-aaaaaaaa', source: 'cli' }),
    makeEvent('operator', 'WI-7', 'item.captured', { source: 'test', text: 'attended work' }),
    makeEvent('reactor', 'WI-7', 'item.queued', { spec: 'x', touches: 'a' }),
    makeEvent('cli', 'WI-7', 'item.claimed', { sessionId: 'ses-aaaaaaaa', ttlMinutes: 60 }),
  ];
  const foldResult = fold(events);

  const res = reapLeakedWorktrees(
    ROOT,
    foldResult,
    {
      now: Date.parse(events[events.length - 1]!.ts) + 60_000,   // just after the claim, session fresh
      graceMs: 0,
      mtimeMsOf: () => 0,
      isDirty: () => false,
      listWorktrees: () => [wt(claimedWt), wt(leaked)],
      removeWorktree: (_root, p) => { removed.push(p); },
    },
  );

  assert.deepEqual(removed, [leaked]);          // the claimed worktree was never touched
  assert.deepEqual(res.reaped.map(r => r.path), [leaked]);
  assert.ok(res.spared.some(s => s.path === claimedWt && s.reason === 'claimed'));
});

test('reapLeakedWorktrees: a dirty worktree is spared (never force-removed) even when old', () => {
  const dirtyWt = SIB('acme-web-tgt-1-wi-3-a1');
  const cleanLeaked = SIB('acme-web-tgt-1-wi-140-a1');
  const removed: string[] = [];

  const res = reapLeakedWorktrees(
    ROOT,
    fold([]),
    {
      now: 10 * HOUR,
      graceMs: 0,
      mtimeMsOf: () => 0,                        // both look ancient
      isDirty: (p) => p === dirtyWt,              // only the first has uncommitted changes
      listWorktrees: () => [wt(dirtyWt), wt(cleanLeaked)],
      removeWorktree: (_root, p) => { removed.push(p); },
    },
  );

  assert.deepEqual(removed, [cleanLeaked]);      // the dirty worktree was never removed
  assert.deepEqual(res.reaped.map(r => r.path), [cleanLeaked]);
  assert.ok(res.spared.some(s => s.path === dirtyWt && s.reason === 'dirty'));
});
