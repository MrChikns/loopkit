/**
 * no-commit-classification.test.ts — WI-198: the emitter↔classifier bijection for the plane's
 * single biggest build-failure class.
 *
 * The defect this file exists to prevent: `classifyReason()` (trajectory.ts) keys the
 * 'no-commit' class on the `no-commit:` prefix, but the TARGET lane parked commit-less builds
 * with a bare literal (`target build produced no commit`) that carried no prefix. Every one of
 * those parks fell into the 'other' bucket — a bucket dominated by DELIBERATE parks (operator
 * holds, fast-drain takeovers) — so the projection that should have shown the plane's largest
 * mechanical failure class reported ZERO of it. 22 real parks in the live ledger were invisible.
 *
 * Two halves, both load-bearing:
 *
 *   1. LIVE EMITTERS — each lane that can park a commit-less build is run END TO END here (real
 *      git repos, real worktrees, a fake worker that writes no commit) and the reason it actually
 *      appended to the ledger is fed through the real `classifyReason`. No hand-copied literal:
 *      if a lane's reason string drifts off the classifier again, THIS fails, in CI, instead of
 *      silently re-hiding the failure class in 'other'. A new lane that parks on no-commit must
 *      be added to this file.
 *   2. HISTORY — the pre-WI-198 literals are immutable ledger content. They are pinned as
 *      explicit legacy cases so a future tidy-up of the classifier cannot silently reclassify
 *      22 (and counting) archived parks back into 'other'.
 *
 * Never weaken an assertion here into "classifies as something". The class is the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { classifyReason } from '../src/trajectory.js';
import { manifestHash, readTargetManifest } from '../src/target.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { makeNonCommittingWorker } from './fakeWorker.js';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

function testConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

/** A plane repo: a git repo with the runs dir dispatch writes worker logs into. */
function makePlaneRepo(root: string): void {
  mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
  git(root, ['init', '-b', 'master']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'plane.txt'), 'plane', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init plane']);
}

/** The notes example target, built into a real git repo on `main` (same fixture target-e2e uses). */
function findExamplesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'examples', 'notes-target');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate examples/notes-target');
}

function makeNotesTargetRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  cpSync(findExamplesDir(), root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init notes target']);
}

/** The reason of the single item.parked event the beat appended for `item`. */
async function soleParkReason(ledgerDir: string, item: string): Promise<string> {
  const events: LedgerEvent[] = await loadAllEvents(ledgerDir);
  const parked = events.filter(e => e.type === 'item.parked' && e.item === item);
  assert.equal(parked.length, 1, `expected exactly one park for ${item} (got ${parked.length})`);
  return String((parked[0]!.data as { reason?: string }).reason ?? '');
}

// ---------------------------------------------------------------------------
// 1. Live emitters — the reason the lane really wrote, through the real classifier
// ---------------------------------------------------------------------------

test('emitter pin: the ENGINEERING lane\'s no-commit park classifies as no-commit', async () => {
  const base = mkdtempSync(join(tmpdir(), 'nocommit-eng-'));
  try {
    const repoRoot = join(base, 'plane');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(repoRoot);

    mkdirSync(ledgerDir, { recursive: true });
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-901', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-901', 'item.queued', { spec: 'x', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // A worker that writes nothing at all: finished, but there is nothing to commit.
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeNonCommittingWorker({ files: [] }),
      config: testConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const reason = await soleParkReason(ledgerDir, 'WI-901');
    assert.equal(
      classifyReason(reason), 'no-commit',
      `the engineering lane's own park reason must classify as no-commit (got reason: ${reason})`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('emitter pin: the TARGET lane\'s no-commit park classifies as no-commit (WI-198 regression)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'nocommit-tgt-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeNotesTargetRepo(targetRoot);

    const manifest = readTargetManifest(targetRoot);
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: manifestHash(manifest), defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-902', 'item.captured', { source: 'cli', text: 'add deleteNote', target: 'notes' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-902', 'item.queued', { spec: 'add a deleteNote helper', touches: 'src/' }, '2026-01-01T00:02:00Z'),
    ]);

    // Same shape as the real failure: the worker finishes, writes nothing, dispatch has nothing
    // to commit on its behalf.
    await runDispatch({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeNonCommittingWorker({ files: [] }),
      config: testConfig(),
      authProbeResult: { ok: true },
    });

    const reason = await soleParkReason(ledgerDir, 'WI-902');
    assert.ok(
      /no commit/i.test(reason),
      `sanity: the target lane must have parked for the no-commit reason (got: ${reason})`,
    );
    assert.equal(
      classifyReason(reason), 'no-commit',
      `the target lane's own park reason must classify as no-commit — a bare literal here is the ` +
      `WI-198 defect: 22 real parks counted as 'other' (got reason: ${reason})`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. History — immutable pre-WI-198 literals must keep classifying correctly
// ---------------------------------------------------------------------------

test('history: the pre-WI-198 unprefixed target-lane literal still classifies as no-commit', () => {
  // Verbatim from the live ledger (22 occurrences, 2026-07). Events are immutable: converging the
  // emitter forward cannot reach them, so the classifier must keep reading them.
  assert.equal(classifyReason('target build produced no commit'), 'no-commit');
  assert.equal(
    classifyReason('target build produced no commit — left 2 out-of-scope change(s), all outside declared Touches: a.ts, b.ts'),
    'no-commit',
    'the residue-note variant of the same historical literal counts too',
  );
  // The retired conductor lane's literal (ADR-013) — same class, same archaeology.
  assert.equal(classifyReason('cluster produced no commit'), 'no-commit');
});

test('history: the legacy clause stays narrow — it does not swallow unrelated reasons into no-commit', () => {
  // The 'other' bucket must keep meaning "genuinely unclassified", so the legacy tolerance is a
  // closed set of known past literals, not a loose "mentions commit" sniff.
  assert.equal(classifyReason('operator took this over in a fast-drain — no commit expected from the plane'), 'other');
  assert.equal(classifyReason('held: awaiting founder decision'), 'other');
});
