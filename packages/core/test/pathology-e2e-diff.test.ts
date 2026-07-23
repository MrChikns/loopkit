/**
 * pathology-e2e-diff.test.ts — WI-100: stepPathology's branch-diff path, end-to-end against a
 * REAL git worktree.
 *
 * Existing coverage gap: pathology.test.ts exercises stepPathology entirely with in-memory
 * ledgers and no real `currentBuild.worktree`, so every diagnosis prompt it builds carries the
 * pathology.ts placeholder text for an empty diff ("(empty diff — no changes detected, or the
 * worktree is gone)") — see captureWorktreeDiff's fail-soft return in judge.ts, which
 * stepPathology calls with `wt ? captureWorktreeDiff(wt, 'main', maxDiffChars) : ''`
 * (reactor.ts). judge-diff-buffer.test.ts DOES exercise captureWorktreeDiff against a real repo,
 * but only the bare helper — never through stepPathology's own prompt-building path, so a
 * regression that stopped stepPathology from ever passing a real worktree through would go
 * undetected by both suites.
 *
 * This test creates a real git repo with a `main` branch, branches off it, commits a real file
 * change, and points a seeded item's `build.dispatched.worktree` at that checkout. It then runs
 * stepPathology (via runReactor) with a provider that CAPTURES the prompt it was actually given,
 * and asserts the real diff content (the changed file's name + a real diff hunk) reached the
 * prompt — i.e., the diff did NOT degrade to the empty placeholder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

let testCount = 0;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), `loopkit-wi100-${process.pid}-${++testCount}-`));
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
}

/**
 * Build a REAL git repo with a `main` branch, then a divergent branch carrying one real,
 * distinctive file change — the shape stepPathology's diff path expects (`captureWorktreeDiff`
 * diffs `main..HEAD` inside the worktree path recorded on build.dispatched).
 */
function makeRealWorktreeWithDivergence(): { repoDir: string } {
  const repoDir = makeTempDir();
  git(repoDir, 'init', '-q', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repoDir, 'seed.txt'), 'seed\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'seed on main');

  git(repoDir, 'checkout', '-q', '-b', 'wi-100-branch');
  writeFileSync(join(repoDir, 'PATHOLOGY_DIFF_MARKER.txt'), 'a genuinely distinctive diff line\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'add distinctive file on the diverged branch');

  // Diff is captured IN the worktree path against 'main..HEAD' — a single checkout with the
  // feature branch active satisfies that (no linked `git worktree add` needed: stepPathology
  // only shells `git diff main..HEAD` inside whatever directory build.dispatched.worktree names).
  return { repoDir };
}

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

async function seedLedger(ledgerDir: string, events: LedgerEvent[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

/** Seed a parked(ops) item whose build.dispatched carries a REAL worktree path. */
function seedParkedOpsItemWithWorktree(id: string, worktree: string): LedgerEvent[] {
  return [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: 'do the thing' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', id, 'item.queued', { spec: 'do the thing' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', id, 'build.dispatched', { attempt: 1, branch: 'wi-100-branch', worktree, pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', id, 'item.parked', { reason: 'gate red: tests failed', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
  ];
}

const TRANSIENT_TEXT = `CLASSIFICATION: transient-infra
EVIDENCE:
- ENOBUFS on the diff spawn
PROPOSED_ACTION: retry as-is`;

/** A provider that records every prompt it was called with, and returns a fixed verdict. */
function makeCapturingProvider(text: string): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake-pathology-capturing',
    prompts,
    async run(req: ProviderRequest): Promise<ProviderResult> {
      prompts.push(req.prompt);
      return { ok: true, text, usage: { in: 10, out: 20, usd: 0.001 } };
    },
  };
}

test('WI-100: stepPathology diagnoses against a REAL git worktree — the diff carries the real change, not the empty placeholder', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const { repoDir } = makeRealWorktreeWithDivergence();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItemWithWorktree('WI-070', repoDir));

    const provider = makeCapturingProvider(TRANSIENT_TEXT);

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider,
      config: makeTestConfig({ breakerN: 3 }),
    });

    assert.equal(provider.prompts.length, 1, 'the pathologist must have been invoked exactly once');
    const prompt = provider.prompts[0];

    // The failure mode this test guards against: a broken diff path silently degrades to the
    // pathology.ts placeholder for "no changes detected" — assert it is ABSENT.
    assert.ok(
      !prompt.includes('(empty diff — no changes detected, or the worktree is gone)'),
      'the diff must NOT have degraded to the empty-diff placeholder',
    );

    // And the REAL diff content (the distinctive file + a real patch line) must be present —
    // proof the diff was captured from the actual worktree, not faked or truncated to nothing.
    assert.match(prompt, /PATHOLOGY_DIFF_MARKER\.txt/, 'the diff must name the real changed file');
    assert.match(prompt, /a genuinely distinctive diff line/, 'the diff must carry the real added line');
    assert.match(prompt, /THE DIFF \(git diff --stat \+ patch, possibly truncated\):/, 'sanity: this is the diff section of the pathology prompt');

    // Confirm the reactor actually completed the pathology flow end-to-end on this real diff
    // (transient-infra requeues on a first attempt) — the diff wasn't just captured, it flowed
    // all the way through to a real classification + action.
    const events = await loadAllEvents(ledgerDir);
    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-070');
    assert.equal(diag.length, 1);
    assert.equal((diag[0].data as { classification?: string }).classification, 'transient-infra');
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-070' && e.actor === 'reactor');
    assert.equal(requeued.length, 1, 'transient-infra under the breaker cap must requeue');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot); cleanDir(repoDir);
  }
});

test('WI-100: stepPathology on a worktree with NO divergence from main captures an empty (but real, non-error) diff', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const repoDir = makeTempDir();
  try {
    // A real repo where 'main' IS HEAD — no divergence at all, so `git diff main..HEAD` is
    // legitimately empty. This is the control: an empty diff here is CORRECT (not a bug),
    // distinguishing "genuinely no changes" from "the diff path is broken".
    git(repoDir, 'init', '-q', '-b', 'main');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    git(repoDir, 'config', 'user.name', 'Test');
    git(repoDir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repoDir, 'seed.txt'), 'seed\n');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-q', '-m', 'seed on main');

    await seedLedger(ledgerDir, seedParkedOpsItemWithWorktree('WI-071', repoDir));
    const provider = makeCapturingProvider(TRANSIENT_TEXT);

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider,
      config: makeTestConfig({ breakerN: 3 }),
    });

    assert.equal(provider.prompts.length, 1);
    const prompt = provider.prompts[0];
    assert.ok(
      prompt.includes('(empty diff — no changes detected, or the worktree is gone)'),
      'no real divergence exists — the empty-diff placeholder is the CORRECT output here',
    );
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot); cleanDir(repoDir);
  }
});
