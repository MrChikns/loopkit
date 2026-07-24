/**
 * worktree-reaper.test.ts — leaked-worktree reaper: parses `git worktree list --porcelain`,
 * classifies each worktree against the safety invariant (never reap a live-owned, foreign,
 * or too-young dir), and drives removal only on genuinely-leaked ones, per registered
 * target. All liveness signals are injected so the tests are hermetic (no real git, no real
 * clock, no real fs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, FoldResult } from '../src/fold.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import {
  parseWorktreePorcelain,
  classifyWorktree,
  isManagedWorktreeName,
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
    pidProbe: () => false,          // default: every pid dead
    mtimeMsOf: () => 0,             // default: ancient (way past grace)
    ...over,
  };
}

const wt = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo =>
  ({ path, locked: false, ...over });

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

test('parseWorktreePorcelain: main + branch + detached + locked-with-pid', () => {
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
  assert.deepEqual(got[0], { path: ROOT, branch: 'main', locked: false });
  assert.equal(got[1]!.branch, 'acme-web-tgt-1-wi-140-a1');
  assert.equal(got[2]!.branch, undefined);          // detached
  assert.equal(got[3]!.locked, true);
  assert.equal(got[3]!.lockPid, 42807);
});

test('parseWorktreePorcelain: bare "locked" with no reason has no pid', () => {
  const out = `worktree ${SIB('acme-web-tgt-1-wi-1-a1')}\nHEAD a\nbranch refs/heads/x\nlocked\n`;
  const got = parseWorktreePorcelain(out);
  assert.equal(got[0]!.locked, true);
  assert.equal(got[0]!.lockPid, undefined);
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

test('classify: a lock held by a LIVE pid is spared', () => {
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-7-a2'), { locked: true, lockPid: 42807 }),
    ctx({ pidProbe: (pid) => pid === 42807 }),
  );
  assert.equal(v.reap, false);
  assert.equal((v as { reason: string }).reason, 'live-locker');
});

test('classify: a lock held by a DEAD pid does not spare (falls through to reap)', () => {
  const v = classifyWorktree(
    wt(SIB('acme-web-tgt-1-wi-7-a2'), { locked: true, lockPid: 42807 }),
    ctx({ pidProbe: () => false }),   // dead; mtime ancient by default
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
      pidProbe: () => false,
      mtimeMsOf: () => 0,                       // everything ancient
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
