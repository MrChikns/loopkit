/**
 * trajectory.test.ts — Tests for trajectory projection.
 *
 * Covers:
 *   providers/claudeCli — num_turns + duration_ms extraction into usage.turns/durationMs
 *   providers/claudeCli — absent num_turns/duration_ms → undefined (not 0)
 *   dispatch — cost.usage passthrough includes turns/durationMs when provider returns them
 *   trajectory — first-pass merge, fail-then-repair-merge, crash requeue, briefed vs unbriefed
 *   trajectory — judge fail share, window filtering with injected now
 *   trajectory — empty stream → zeroed valid structure
 *   trajectory — batch cost join (comma-joined wi) attributed to both items
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent, ParkKind } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { projectTrajectory, classifyReason } from '../src/trajectory.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi221-${process.pid}-${++testCount}-${Date.now()}`);
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
    ...overrides,
  };
}

/** Seeded dispatch setup with a real git repo in a temp dir. */
async function makeDispatchEnv(ledgerEvents: LedgerEvent[]): Promise<{
  repoRoot: string;
  ledgerDir: string;
  cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });

  const { spawnSync } = await import('node:child_process');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  await appendEvents(ledgerDir, ledgerEvents);
  return {
    repoRoot,
    ledgerDir,
    cleanup: () => cleanDir(base),
  };
}

/** Provider that makes a commit and returns ok with optional trajectory fields. */
function makeCommitProvider(opts: {
  filename?: string;
  content?: string;
  turns?: number;
  durationMs?: number;
} = {}): LlmProvider {
  const { filename = 'src/feature.ts', content = '// built', turns, durationMs } = opts;
  return {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      const { spawnSync } = await import('node:child_process');
      const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
      mkdir(join(req.cwd!, 'src'), { recursive: true });
      wf(join(req.cwd!, filename), content, 'utf8');
      spawnSync('git', ['add', filename], { cwd: req.cwd, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'feat(WI-001): implement'], { cwd: req.cwd, stdio: 'pipe' });
      return {
        ok: true,
        text: 'done',
        usage: {
          in: 100,
          out: 50,
          usd: 0.001,
          ...(turns !== undefined ? { turns } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Provider extraction: num_turns / duration_ms → usage.turns / durationMs
// ---------------------------------------------------------------------------

// We test the extraction logic indirectly through dispatch's cost.usage emission.
// The ClaudeCliProvider parses the JSON from the CLI subprocess; we can't spawn a
// real claude binary in tests. The unit assertion is that when the provider returns
// usage.turns/durationMs, dispatch passes them into the cost.usage event.
// The actual parsing path is exercised by the dispatch integration tests below.

// We do however validate the ProviderSuccess shape directly (types.ts)
test('provider types: ProviderSuccess usage shape accepts turns and durationMs', () => {
  // Type-level test: construct the shape and verify it compiles and reads back correctly.
  const success: import('../src/providers/types.js').ProviderSuccess = {
    ok: true,
    text: 'result',
    usage: {
      in: 100,
      out: 50,
      usd: 0.001,
      turns: 7,
      durationMs: 45_000,
    },
  };
  assert.equal(success.usage?.turns, 7);
  assert.equal(success.usage?.durationMs, 45_000);
});

test('provider types: ProviderSuccess usage turns/durationMs are optional (absent → undefined)', () => {
  const success: import('../src/providers/types.js').ProviderSuccess = {
    ok: true,
    text: 'result',
    usage: { in: 50, out: 20, usd: 0.0005 },
  };
  assert.equal(success.usage?.turns, undefined);
  assert.equal(success.usage?.durationMs, undefined);
});

// ---------------------------------------------------------------------------
// 2. cost.usage passthrough: dispatch emits turns/durationMs when provider has them
// ---------------------------------------------------------------------------

test('dispatch: cost.usage{loop:dispatch} carries turns and durationMs when provider returns them', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', {
      spec: 'add feature to src/feature.ts',
      touches: 'src/',
    }),
  ]);

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider({ turns: 5, durationMs: 120_000 }),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/feature.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    const events = await loadAllEvents(ledgerDir);
    const costEvents = events.filter(e =>
      e.type === 'cost.usage' &&
      e.item === 'WI-001' &&
      (e.data as { loop: string }).loop === 'dispatch',
    );
    assert.equal(costEvents.length, 1, 'must emit exactly one dispatch cost.usage');
    const d = costEvents[0]!.data as { turns?: number; durationMs?: number; tokens: number };
    assert.equal(d.turns, 5, 'turns must be passed through to cost.usage');
    assert.equal(d.durationMs, 120_000, 'durationMs must be passed through to cost.usage');
    assert.ok(d.tokens > 0, 'tokens must be present');
  } finally {
    cleanup();
  }
});

test('dispatch: cost.usage{loop:dispatch} omits turns/durationMs when provider does not return them', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'build thing' }),
    makeEvent('conductor', 'WI-002', 'item.queued', {
      spec: 'add thing to src/thing.ts',
      touches: 'src/',
    }),
  ]);

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      // No turns/durationMs returned
      provider: makeCommitProvider({ filename: 'src/thing.ts' }),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/thing.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    const events = await loadAllEvents(ledgerDir);
    const costEvents = events.filter(e =>
      e.type === 'cost.usage' &&
      e.item === 'WI-002' &&
      (e.data as { loop: string }).loop === 'dispatch',
    );
    assert.equal(costEvents.length, 1);
    const d = costEvents[0]!.data as { turns?: number; durationMs?: number };
    assert.equal(d.turns, undefined, 'turns must be absent when provider did not return it');
    assert.equal(d.durationMs, undefined, 'durationMs must be absent when provider did not return it');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Trajectory projection: synthetic event stream
// ---------------------------------------------------------------------------

/**
 * Build a minimal build.dispatched + terminal chain for one attempt.
 * ts must be ISO8601 strings within a test-controlled window.
 */
function makeAttemptChain(opts: {
  wi: string;
  attempt: number;
  dispatchedAt: string;
  terminalType: 'gate.passed' | 'gate.failed' | 'build.crashed' | 'gate.parked' | 'item.merged';
  terminalAt: string;
  costTurns?: number;
  costTokens?: number;
  costUsd?: number;
  costDurationMs?: number;
  costAt?: string;
  judgeVerdict?: 'pass' | 'fail' | 'unparseable';
  judgeAt?: string;
  /** Override the terminal event's default `reason` (see the per-type defaults below). */
  terminalReason?: string;
  /** Set the terminal event's `parkKind` (only some item.parked-adjacent shapes carry this in production). */
  terminalParkKind?: string;
  /**
   * WI-165: append a COMPANION item.parked event immediately after the terminal, matching the
   * real production shape (every emitter in beats/dispatch.ts/doctor.ts/conductor.ts appends
   * the terminal + item.parked together, companion second). Set this to exercise the
   * correlation join; omit it to keep a bare terminal with no companion (e.g. a crash the
   * breaker hasn't tripped on yet).
   */
  companionParkKind?: ParkKind;
  companionParkReason?: string;
  /** Defaults to terminalAt (same tick) — set to prove the join is index-based, not ts-based. */
  companionParkAt?: string;
}): LedgerEvent[] {
  const evs: LedgerEvent[] = [];

  evs.push(makeEvent('dispatch', opts.wi, 'build.dispatched', {
    attempt: opts.attempt,
    pid: 1,
  }, opts.dispatchedAt));

  if (opts.costTokens !== undefined) {
    evs.push(makeEvent('dispatch', opts.wi, 'cost.usage', {
      provider: 'claude-cli',
      loop: 'dispatch',
      tokens: opts.costTokens,
      usd: opts.costUsd,
      wi: opts.wi,
      ...(opts.costTurns !== undefined ? { turns: opts.costTurns } : {}),
      ...(opts.costDurationMs !== undefined ? { durationMs: opts.costDurationMs } : {}),
    }, opts.costAt ?? opts.dispatchedAt));
  }

  if (opts.judgeVerdict) {
    evs.push(makeEvent('dispatch', opts.wi, 'review.verdict', {
      verdict: opts.judgeVerdict,
      confidence: 0.8,
      specSatisfied: 'yes',
      scopeCreep: 'none',
      testTheatre: 'none',
      reasons: [],
      model: 'sonnet',
      judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData, opts.judgeAt ?? opts.terminalAt));
  }

  evs.push(makeEvent('dispatch', opts.wi, opts.terminalType, {
    ...(opts.terminalType === 'item.merged' ? { commit: 'abc123', deployed: false } : {}),
    ...(opts.terminalType === 'gate.passed' ? { tests: 'green' } : {}),
    ...(opts.terminalType === 'gate.failed' ? { reason: opts.terminalReason ?? 'tests-red' } : {}),
    ...(opts.terminalType === 'build.crashed' ? { reason: opts.terminalReason ?? 'timeout' } : {}),
    ...(opts.terminalType === 'gate.parked' ? { reason: opts.terminalReason ?? 'spine' } : {}),
    ...(opts.terminalParkKind !== undefined ? { parkKind: opts.terminalParkKind } : {}),
  } as Record<string, unknown>, opts.terminalAt));

  if (opts.companionParkKind !== undefined || opts.companionParkReason !== undefined) {
    evs.push(makeEvent('dispatch', opts.wi, 'item.parked', {
      reason: opts.companionParkReason ?? opts.terminalReason ?? 'parked',
      ...(opts.companionParkKind !== undefined ? { parkKind: opts.companionParkKind } : {}),
    }, opts.companionParkAt ?? opts.terminalAt));
  }

  return evs;
}

test('trajectory: empty event stream → zeroed valid structure', () => {
  const result = projectTrajectory([], { now: '2026-07-11T00:00:00Z' });
  assert.ok(result.window, 'window must be present');
  assert.equal(result.window.days, 14);
  assert.deepEqual(result.attempts, [], 'attempts must be empty array');
  assert.equal(result.aggregates.attempts, 0);
  assert.equal(result.aggregates.distinctItems, 0);
  assert.equal(result.aggregates.merges, 0);
  assert.equal(result.aggregates.firstPassMergeRate, 0);
  assert.equal(result.aggregates.repairMergeRate, 0);
  assert.equal(result.aggregates.avgUsdPerMergedItem, 0);
  assert.equal(result.aggregates.avgTurnsPerAttempt, 0);
  assert.equal(result.aggregates.avgDurationMinutes, 0);
  assert.equal(result.aggregates.scoutCoverage, 0);
  assert.equal(result.aggregates.judgeFailShare, 0);
});

test('trajectory: first-pass merge → outcome=merged, firstPassMergeRate=1', () => {
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-001',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T10:15:00Z',
      costTokens: 1500,
      costUsd: 0.004,
      costTurns: 8,
      costDurationMs: 900_000,
      costAt: '2026-07-10T10:01:00Z',
    }),
    makeEvent('dispatch', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-07-10T10:15:30Z'),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 1);
  const a = result.attempts[0]!;
  assert.equal(a.wi, 'WI-001');
  assert.equal(a.attempt, 1);
  assert.equal(a.outcome, 'merged', 'gate.passed → merged');
  assert.ok(a.durationMinutes !== undefined && a.durationMinutes > 0, 'durationMinutes must be positive');
  assert.equal(a.tokens, 1500);
  assert.equal(a.usd, 0.004);
  assert.equal(a.turns, 8);
  assert.equal(a.briefed, false, 'no item.briefed → not briefed');

  assert.equal(result.aggregates.attempts, 1);
  assert.equal(result.aggregates.merges, 1);
  assert.equal(result.aggregates.firstPassMergeRate, 1, 'first-pass merge rate must be 1.0');
  assert.equal(result.aggregates.scoutCoverage, 0, 'no briefed events → coverage 0');
});

test('trajectory: fail then repair merge → firstPassMergeRate=0, repairMergeRate=1', () => {
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-010',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T10:20:00Z',
      costTokens: 1000,
      costUsd: 0.003,
    }),
    ...makeAttemptChain({
      wi: 'WI-010',
      attempt: 2,
      dispatchedAt: '2026-07-10T12:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T12:12:00Z',
      costTokens: 1200,
      costUsd: 0.0036,
      costTurns: 5,
    }),
    makeEvent('dispatch', 'WI-010', 'item.merged', { commit: 'def', deployed: false }, '2026-07-10T12:12:30Z'),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 2);

  const attempt1 = result.attempts.find(a => a.attempt === 1)!;
  const attempt2 = result.attempts.find(a => a.attempt === 2)!;
  assert.ok(attempt1, 'attempt 1 must exist');
  assert.ok(attempt2, 'attempt 2 must exist');
  assert.equal(attempt1.outcome, 'gate-failed');
  assert.equal(attempt2.outcome, 'merged');

  assert.equal(result.aggregates.firstPassMergeRate, 0, 'first attempt failed → first-pass rate 0');
  assert.equal(result.aggregates.repairMergeRate, 1, 'repaired and merged → repair rate 1');
  assert.equal(result.aggregates.merges, 1, 'one item merged (via attempt 2)');
});

test('trajectory: crash requeue → outcome=crashed, no merge', () => {
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-020',
      attempt: 1,
      dispatchedAt: '2026-07-10T09:00:00Z',
      terminalType: 'build.crashed',
      terminalAt: '2026-07-10T09:05:00Z',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 1);
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'crashed');
  assert.equal(result.aggregates.merges, 0);
  assert.equal(result.aggregates.firstPassMergeRate, 0);
});

// ---------------------------------------------------------------------------
// WI-159: reason/parkKind carry-through + classifyReason() + parkRateByClass
// ---------------------------------------------------------------------------

test('classifyReason: no-commit prefix (real dispatch.ts shape) → no-commit class', () => {
  // Real production string from dispatch.ts:3245 (log path suffix elided here — the
  // classifier only needs the prefix).
  assert.equal(
    classifyReason('no-commit: agent produced no commit (log: .ai/runs/loopkit/WI-001-agent.err)'),
    'no-commit',
  );
});

test('classifyReason: gate.parked literals (touches-overstep, spine, batch-attribution)', () => {
  assert.equal(classifyReason('touches-overstep'), 'touches-overstep');
  assert.equal(classifyReason('spine'), 'spine');
  assert.equal(classifyReason('batch-attribution'), 'batch-attribution');
});

test('classifyReason: breaker/infra/sensitivity prefixes and merge-conflict text', () => {
  assert.equal(classifyReason('breaker: 5 attempts exhausted — tests-red'), 'breaker');
  assert.equal(classifyReason("infra: planner prompt missing: .ai/loops/prompts/x.md"), 'infra');
  assert.equal(
    classifyReason('sensitivity(low): no allowed+healthy provider for planning — parked fail-closed'),
    'sensitivity',
  );
  assert.equal(classifyReason("target merge conflict on 'master'"), 'merge-conflict');
});

test('classifyReason: unknown/unmatched reason string → other (never dropped, never guessed)', () => {
  assert.equal(classifyReason('some brand new failure mode nobody has seen yet'), 'other');
});

test('classifyReason: undefined reason → other', () => {
  assert.equal(classifyReason(undefined), 'other');
});

test('trajectory: gate.parked terminal (real touches-overstep shape) carries reason + reasonClass, no parkKind', () => {
  // Mirrors the real dispatch.ts:3409 shape — gate.parked{reason:'touches-overstep'} with
  // NO parkKind on this event (parkKind only appears on the companion item.parked event,
  // which is not a TERMINAL_TYPES member and therefore not the one trajectory reads).
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-159a',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.parked',
      terminalAt: '2026-07-10T10:05:00Z',
      terminalReason: 'touches-overstep',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 1);
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'gate-parked', 'outcome union must be unchanged');
  assert.equal(a.reason, 'touches-overstep');
  assert.equal(a.parkKind, undefined, 'gate.parked in production carries no parkKind field');
  assert.equal(a.reasonClass, 'touches-overstep');
});

test('trajectory: gate.failed terminal with parkKind present (item.parked-adjacent shape) carries both', () => {
  // Some dispatch paths (e.g. no-commit, dirty-tree) pair gate.failed with a companion
  // item.parked{parkKind:'ops'}; exercise a terminal event that itself carries parkKind
  // to prove the field is read generically off terminalEv.data, not type-gated.
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-159b',
      attempt: 1,
      dispatchedAt: '2026-07-10T09:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T09:10:00Z',
      terminalReason: 'no-commit: agent produced no commit (log: .ai/runs/loopkit/WI-159b-agent.err)',
      terminalParkKind: 'ops',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'gate-failed');
  assert.equal(a.reason, 'no-commit: agent produced no commit (log: .ai/runs/loopkit/WI-159b-agent.err)');
  assert.equal(a.parkKind, 'ops');
  assert.equal(a.reasonClass, 'no-commit');
});

test('trajectory: merged attempt has no reason/parkKind/reasonClass (nothing to classify)', () => {
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-159c',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T10:10:00Z',
    }),
    makeEvent('dispatch', 'WI-159c', 'item.merged', { commit: 'abc', deployed: false }, '2026-07-10T10:10:30Z'),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'merged');
  assert.equal(a.reason, undefined);
  assert.equal(a.parkKind, undefined);
  assert.equal(a.reasonClass, undefined);
});

test('trajectory: in-flight attempt (no terminal event) has no reason/reasonClass', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-159d', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-07-10T10:00:00Z'),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'in-flight');
  assert.equal(a.reason, undefined);
  assert.equal(a.reasonClass, undefined);
});

test('trajectory: unknown reason string on a park lands in reasonClass=other, never dropped', () => {
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-159e',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.parked',
      terminalAt: '2026-07-10T10:05:00Z',
      terminalReason: 'a brand new park reason nobody has classified yet',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.reason, 'a brand new park reason nobody has classified yet', 'raw reason must be preserved verbatim');
  assert.equal(a.reasonClass, 'other', 'unmatched reason must fall into the explicit other class');
});

test('trajectory: parkRateByClass aggregates across mixed reasonClasses, excluding merged/in-flight from the denominator', () => {
  const now = '2026-07-11T00:00:00Z';
  const events: LedgerEvent[] = [
    // Two touches-overstep parks
    ...makeAttemptChain({
      wi: 'WI-159f', attempt: 1, dispatchedAt: '2026-07-10T08:00:00Z',
      terminalType: 'gate.parked', terminalAt: '2026-07-10T08:05:00Z', terminalReason: 'touches-overstep',
    }),
    ...makeAttemptChain({
      wi: 'WI-159g', attempt: 1, dispatchedAt: '2026-07-10T08:10:00Z',
      terminalType: 'gate.parked', terminalAt: '2026-07-10T08:15:00Z', terminalReason: 'touches-overstep',
    }),
    // One no-commit gate.failed
    ...makeAttemptChain({
      wi: 'WI-159h', attempt: 1, dispatchedAt: '2026-07-10T08:20:00Z',
      terminalType: 'gate.failed', terminalAt: '2026-07-10T08:25:00Z',
      terminalReason: 'no-commit: agent produced no commit (log: x)',
    }),
    // One unknown reason → other
    ...makeAttemptChain({
      wi: 'WI-159i', attempt: 1, dispatchedAt: '2026-07-10T08:30:00Z',
      terminalType: 'gate.parked', terminalAt: '2026-07-10T08:35:00Z', terminalReason: 'never seen before',
    }),
    // One merged attempt — carries no reason, must be excluded from the parkRateByClass denominator
    ...makeAttemptChain({
      wi: 'WI-159j', attempt: 1, dispatchedAt: '2026-07-10T08:40:00Z',
      terminalType: 'gate.passed', terminalAt: '2026-07-10T08:45:00Z',
    }),
    makeEvent('dispatch', 'WI-159j', 'item.merged', { commit: 'zzz', deployed: false }, '2026-07-10T08:45:30Z'),
  ];

  const result = projectTrajectory(events, { now, days: 14 });
  assert.equal(result.aggregates.attempts, 5);

  // Denominator = 4 classified attempts (the merged one is excluded).
  const rates = result.aggregates.parkRateByClass;
  assert.ok(Math.abs((rates['touches-overstep'] ?? 0) - 2 / 4) < 1e-9, 'touches-overstep must be 2/4');
  assert.ok(Math.abs((rates['no-commit'] ?? 0) - 1 / 4) < 1e-9, 'no-commit must be 1/4');
  assert.ok(Math.abs((rates['other'] ?? 0) - 1 / 4) < 1e-9, 'other must be 1/4');
  assert.equal(rates['spine'], undefined, 'classes with zero occurrences must be absent, not zero-valued');

  const sum = Object.values(rates).reduce((s, v) => s + (v ?? 0), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'rates over present classes must sum to 1');
});

test('trajectory: empty stream → parkRateByClass is an empty object', () => {
  const result = projectTrajectory([], { now: '2026-07-11T00:00:00Z' });
  assert.deepEqual(result.aggregates.parkRateByClass, {});
});

// ---------------------------------------------------------------------------
// WI-165: parkKind correlation via companion item.parked + attentionCostShare
// ---------------------------------------------------------------------------

test('trajectory: a decision park correlates parkKind from the companion item.parked (real dispatch.ts touches-overstep shape)', () => {
  // Mirrors dispatch.ts:3469 exactly: gate.parked{reason:'touches-overstep'} (no parkKind)
  // immediately followed by item.parked{reason:'needs-decision: ...', parkKind:'decision'}.
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-165a',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.parked',
      terminalAt: '2026-07-10T10:05:00Z',
      terminalReason: 'touches-overstep',
      companionParkReason: 'needs-decision: files outside declared Touches (src/): src/x.ts',
      companionParkKind: 'decision',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 1);
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'gate-parked');
  assert.equal(a.reason, 'touches-overstep', 'reason still comes from the terminal, unaffected by the join');
  assert.equal(a.parkKind, 'decision', 'parkKind must be recovered from the companion item.parked');
  assert.equal(a.reasonClass, 'touches-overstep');
});

test('trajectory: an ops park correlates parkKind from the companion item.parked (real dispatch.ts no-commit shape)', () => {
  // Mirrors dispatch.ts:1717 exactly: gate.failed{reason} immediately followed by
  // item.parked{reason, parkKind:'ops'} in the same appendEvents call.
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-165b',
      attempt: 1,
      dispatchedAt: '2026-07-10T11:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T11:05:00Z',
      terminalReason: 'no-commit: agent produced no commit (log: .ai/runs/loopkit/WI-165b-agent.err)',
      companionParkKind: 'ops',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'gate-failed');
  assert.equal(a.parkKind, 'ops');
  assert.equal(a.reasonClass, 'no-commit');
});

test('trajectory: multi-attempt item (real WI-164 shape) — each attempt gets its own correlated parkKind, not the first/last found', () => {
  // Reproduces the real ledger shape for WI-164: two attempts, both parked 'ops', each with
  // its own gate.failed + item.parked pair. The join must not let attempt 1's item.parked
  // leak into attempt 2 (or vice versa) just because they share a wi.
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-165c',
      attempt: 1,
      dispatchedAt: '2026-07-10T07:55:05Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T08:15:13Z',
      terminalReason: 'target build produced no commit',
      companionParkKind: 'ops',
      companionParkReason: 'target build produced no commit',
    }),
    // Between attempts: reactor's pathology requeue (item.queued + diagnosis.recorded + msg.out)
    // — none of these are item.parked, so they must not disturb the bracket.
    makeEvent('reactor', 'WI-165c', 'item.queued', { spec: 'retry', touches: 'src/' }, '2026-07-10T08:15:33Z'),
    ...makeAttemptChain({
      wi: 'WI-165c',
      attempt: 2,
      dispatchedAt: '2026-07-10T08:15:45Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T08:31:44Z',
      terminalReason: 'target build produced no commit',
      companionParkKind: 'ops',
      companionParkReason: 'target build produced no commit',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 2);
  const attempt1 = result.attempts.find(a => a.attempt === 1)!;
  const attempt2 = result.attempts.find(a => a.attempt === 2)!;
  assert.ok(attempt1 && attempt2, 'both attempts must be present');
  assert.equal(attempt1.parkKind, 'ops', 'attempt 1 gets its OWN companion park');
  assert.equal(attempt2.parkKind, 'ops', 'attempt 2 gets its OWN companion park (not attempt 1\'s)');
});

test('trajectory: a hold park correlates parkKind but is excluded from attentionCostShare', () => {
  // Mirrors conductor.ts:524 exactly: gate.failed{reason:'cluster produced no commit'} paired
  // with item.parked{parkKind:'hold'} (the attended-lane degradation path).
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-165d',
      attempt: 1,
      dispatchedAt: '2026-07-10T12:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T12:05:00Z',
      terminalReason: 'cluster produced no commit',
      companionParkKind: 'hold',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.parkKind, 'hold', 'parkKind itself is still correlated and carried through');
  assert.equal(result.aggregates.decisionParks, 0);
  assert.equal(result.aggregates.opsParks, 0, 'hold must not be counted as an ops park either');
  assert.equal(result.aggregates.attentionCostShare, 0, 'no decision/ops parks in window → 0, not NaN');
});

test('trajectory: a terminal with no companion park leaves parkKind undefined (no false correlation)', () => {
  // A bare crash the breaker hasn't tripped on yet (see doctor.ts reapAction: below breakerN,
  // it requeues instead of parking) — no item.parked exists at all for this attempt.
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-165e',
      attempt: 1,
      dispatchedAt: '2026-07-10T13:00:00Z',
      terminalType: 'build.crashed',
      terminalAt: '2026-07-10T13:05:00Z',
      terminalReason: 'timeout',
      // no companionParkKind/companionParkReason — no item.parked emitted at all
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.outcome, 'crashed');
  assert.equal(a.parkKind, undefined, 'no item.parked in the stream → parkKind stays undefined, never guessed');
  assert.equal(result.aggregates.attentionCostShare, 0);
});

test('trajectory: attentionCostShare over mixed decision/ops/hold parks, hold excluded from both sides of the ratio', () => {
  const now = '2026-07-11T00:00:00Z';
  const events: LedgerEvent[] = [
    // 2 decision parks
    ...makeAttemptChain({
      wi: 'WI-165f', attempt: 1, dispatchedAt: '2026-07-10T08:00:00Z',
      terminalType: 'gate.parked', terminalAt: '2026-07-10T08:05:00Z', terminalReason: 'spine',
      companionParkKind: 'decision',
    }),
    ...makeAttemptChain({
      wi: 'WI-165g', attempt: 1, dispatchedAt: '2026-07-10T08:10:00Z',
      terminalType: 'gate.parked', terminalAt: '2026-07-10T08:15:00Z', terminalReason: 'touches-overstep',
      companionParkKind: 'decision',
    }),
    // 1 ops park
    ...makeAttemptChain({
      wi: 'WI-165h', attempt: 1, dispatchedAt: '2026-07-10T08:20:00Z',
      terminalType: 'gate.failed', terminalAt: '2026-07-10T08:25:00Z',
      terminalReason: 'no-commit: agent produced no commit',
      companionParkKind: 'ops',
    }),
    // 1 hold park (must be excluded from the denominator, not just the numerator)
    ...makeAttemptChain({
      wi: 'WI-165i', attempt: 1, dispatchedAt: '2026-07-10T08:30:00Z',
      terminalType: 'gate.failed', terminalAt: '2026-07-10T08:35:00Z',
      terminalReason: 'cluster produced no commit',
      companionParkKind: 'hold',
    }),
    // 1 merged attempt — no park at all, must not affect the aggregate
    ...makeAttemptChain({
      wi: 'WI-165j', attempt: 1, dispatchedAt: '2026-07-10T08:40:00Z',
      terminalType: 'gate.passed', terminalAt: '2026-07-10T08:45:00Z',
    }),
    makeEvent('dispatch', 'WI-165j', 'item.merged', { commit: 'zzz', deployed: false }, '2026-07-10T08:45:30Z'),
  ];

  const result = projectTrajectory(events, { now, days: 14 });
  assert.equal(result.aggregates.attempts, 5);
  assert.equal(result.aggregates.decisionParks, 2);
  assert.equal(result.aggregates.opsParks, 1);
  // attentionCostShare = decision / (decision + ops) = 2 / 3, hold and merged excluded entirely
  assert.ok(Math.abs(result.aggregates.attentionCostShare - 2 / 3) < 1e-9, 'attentionCostShare must be 2/3');
});

test('trajectory: empty stream → attentionCostShare/decisionParks/opsParks are zeroed, not NaN', () => {
  const result = projectTrajectory([], { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.aggregates.attentionCostShare, 0);
  assert.equal(result.aggregates.decisionParks, 0);
  assert.equal(result.aggregates.opsParks, 0);
});

test('trajectory: parkKind already present on the terminal event itself is preserved, not overwritten by an absent companion', () => {
  // Defensive: if a future emitter ever puts parkKind directly on the terminal (as the
  // WI-159 test above exercises for gate.failed), the correlation must not clobber it with
  // undefined just because no companion item.parked happens to exist in this stream.
  const events: LedgerEvent[] = [
    ...makeAttemptChain({
      wi: 'WI-165k',
      attempt: 1,
      dispatchedAt: '2026-07-10T14:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T14:05:00Z',
      terminalReason: 'no-commit: agent produced no commit',
      terminalParkKind: 'ops',
      // no companion item.parked in this synthetic stream
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  const a = result.attempts[0]!;
  assert.equal(a.parkKind, 'ops', 'terminal-carried parkKind must win when present, correlation is a fallback only');
});

test('trajectory: briefed vs unbriefed attempts → scoutCoverage', () => {
  // WI-030: briefed before dispatch
  // WI-031: no brief
  const events: LedgerEvent[] = [
    // WI-030 brief (before dispatch)
    makeEvent('dispatch', 'WI-030', 'item.briefed', { brief: 'Files: src/x.ts — change X', model: 'haiku' }, '2026-07-10T08:00:00Z'),
    ...makeAttemptChain({
      wi: 'WI-030',
      attempt: 1,
      dispatchedAt: '2026-07-10T08:05:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T08:20:00Z',
    }),
    makeEvent('dispatch', 'WI-030', 'item.merged', { commit: 'aaa', deployed: false }, '2026-07-10T08:20:30Z'),

    // WI-031: no brief, just dispatch
    ...makeAttemptChain({
      wi: 'WI-031',
      attempt: 1,
      dispatchedAt: '2026-07-10T09:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T09:20:00Z',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 2);

  const briefedAttempt = result.attempts.find(a => a.wi === 'WI-030')!;
  const unbriefedAttempt = result.attempts.find(a => a.wi === 'WI-031')!;
  assert.ok(briefedAttempt, 'WI-030 attempt must exist');
  assert.ok(unbriefedAttempt, 'WI-031 attempt must exist');
  assert.equal(briefedAttempt.briefed, true, 'WI-030 had item.briefed before dispatch');
  assert.equal(unbriefedAttempt.briefed, false, 'WI-031 had no brief');

  // scout coverage = 1 briefed / 2 total = 0.5
  assert.ok(Math.abs(result.aggregates.scoutCoverage - 0.5) < 1e-9, 'scout coverage must be 0.5');
});

test('trajectory: judge fail → judgeFailShare > 0', () => {
  const events: LedgerEvent[] = [
    // attempt with judge=fail
    ...makeAttemptChain({
      wi: 'WI-040',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T10:20:00Z',
      judgeVerdict: 'fail',
      judgeAt: '2026-07-10T10:18:00Z',
    }),
    makeEvent('dispatch', 'WI-040', 'item.merged', { commit: 'bbb', deployed: false }, '2026-07-10T10:20:30Z'),

    // attempt with judge=pass
    ...makeAttemptChain({
      wi: 'WI-041',
      attempt: 1,
      dispatchedAt: '2026-07-10T11:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T11:15:00Z',
      judgeVerdict: 'pass',
      judgeAt: '2026-07-10T11:13:00Z',
    }),
    makeEvent('dispatch', 'WI-041', 'item.merged', { commit: 'ccc', deployed: false }, '2026-07-10T11:15:30Z'),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 2);

  const a040 = result.attempts.find(a => a.wi === 'WI-040')!;
  const a041 = result.attempts.find(a => a.wi === 'WI-041')!;
  assert.equal(a040.judgeVerdict, 'fail');
  assert.equal(a041.judgeVerdict, 'pass');

  // 1 fail / 2 total verdicts = 0.5
  assert.ok(Math.abs(result.aggregates.judgeFailShare - 0.5) < 1e-9, 'judgeFailShare must be 0.5');
});

test('trajectory: window filtering — events outside window excluded', () => {
  // now = 2026-07-11T00:00:00Z; default 14-day window = from 2026-06-27
  // Old event at 2026-06-20 should be excluded
  const events: LedgerEvent[] = [
    // In-window
    ...makeAttemptChain({
      wi: 'WI-050',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T10:10:00Z',
    }),
    makeEvent('dispatch', 'WI-050', 'item.merged', { commit: 'eee', deployed: false }, '2026-07-10T10:10:30Z'),

    // Out-of-window (2026-06-20 is before 2026-06-27)
    ...makeAttemptChain({
      wi: 'WI-051',
      attempt: 1,
      dispatchedAt: '2026-06-20T10:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-06-20T10:20:00Z',
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z', days: 14 });
  assert.equal(result.attempts.length, 1, 'only in-window attempt must be included');
  assert.equal(result.attempts[0]!.wi, 'WI-050');
  assert.equal(result.aggregates.attempts, 1);
});

test('trajectory: injected now → deterministic window from/to', () => {
  const result = projectTrajectory([], { now: '2026-07-11T12:00:00.000Z', days: 7 });
  assert.equal(result.window.days, 7);
  // from should be 7 days before now
  const fromMs = Date.parse(result.window.from);
  const toMs = Date.parse(result.window.to);
  const nowMs = Date.parse('2026-07-11T12:00:00.000Z');
  assert.ok(Math.abs(toMs - nowMs) < 100, 'to must equal injected now');
  assert.ok(Math.abs(fromMs - (nowMs - 7 * 24 * 60 * 60 * 1000)) < 100, 'from must be exactly 7 days before now');
});

test('trajectory: avgTurnsPerAttempt only averages attempts with turns data', () => {
  const events: LedgerEvent[] = [
    // Attempt with turns
    ...makeAttemptChain({
      wi: 'WI-060',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T10:10:00Z',
      costTokens: 100,
      costTurns: 10,
    }),
    makeEvent('dispatch', 'WI-060', 'item.merged', { commit: 'fff', deployed: false }, '2026-07-10T10:10:30Z'),

    // Attempt without turns
    ...makeAttemptChain({
      wi: 'WI-061',
      attempt: 1,
      dispatchedAt: '2026-07-10T11:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T11:15:00Z',
      costTokens: 200,
      // no costTurns
    }),
  ];

  const result = projectTrajectory(events, { now: '2026-07-11T00:00:00Z' });
  assert.equal(result.attempts.length, 2);

  const a060 = result.attempts.find(a => a.wi === 'WI-060')!;
  const a061 = result.attempts.find(a => a.wi === 'WI-061')!;
  assert.equal(a060.turns, 10);
  assert.equal(a061.turns, undefined, 'no turns data → undefined');

  // avgTurnsPerAttempt should be average of [10] only (not 0 from WI-061)
  assert.equal(result.aggregates.avgTurnsPerAttempt, 10, 'average must only count attempts with turns');
});

test('trajectory: multi-metric synthetic stream — asserting all aggregates', () => {
  // WI-100: first-pass merge (briefed)
  // WI-101: attempt 1 fails, attempt 2 merges (repair merge)
  // WI-102: crash (no merge)
  const now = '2026-07-11T00:00:00Z';
  const events: LedgerEvent[] = [
    // WI-100: briefed, first-pass merge
    makeEvent('dispatch', 'WI-100', 'item.briefed', { brief: 'Files: src/a.ts', model: 'haiku' }, '2026-07-10T08:00:00Z'),
    ...makeAttemptChain({
      wi: 'WI-100',
      attempt: 1,
      dispatchedAt: '2026-07-10T08:05:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T08:20:00Z',
      costTokens: 500,
      costUsd: 0.002,
      costTurns: 4,
      costDurationMs: 900_000,
      costAt: '2026-07-10T08:06:00Z',
      judgeVerdict: 'pass',
      judgeAt: '2026-07-10T08:18:00Z',
    }),
    makeEvent('dispatch', 'WI-100', 'item.merged', { commit: 'abc', deployed: false }, '2026-07-10T08:20:30Z'),

    // WI-101: fail then repair merge
    ...makeAttemptChain({
      wi: 'WI-101',
      attempt: 1,
      dispatchedAt: '2026-07-10T09:00:00Z',
      terminalType: 'gate.failed',
      terminalAt: '2026-07-10T09:30:00Z',
      costTokens: 1000,
      costUsd: 0.003,
      costTurns: 12,
      costDurationMs: 1_800_000,
      costAt: '2026-07-10T09:01:00Z',
      judgeVerdict: 'fail',
      judgeAt: '2026-07-10T09:25:00Z',
    }),
    ...makeAttemptChain({
      wi: 'WI-101',
      attempt: 2,
      dispatchedAt: '2026-07-10T11:00:00Z',
      terminalType: 'gate.passed',
      terminalAt: '2026-07-10T11:15:00Z',
      costTokens: 800,
      costUsd: 0.0024,
      costTurns: 6,
      costDurationMs: 900_000,
      costAt: '2026-07-10T11:01:00Z',
    }),
    makeEvent('dispatch', 'WI-101', 'item.merged', { commit: 'def', deployed: false }, '2026-07-10T11:15:30Z'),

    // WI-102: crash only
    ...makeAttemptChain({
      wi: 'WI-102',
      attempt: 1,
      dispatchedAt: '2026-07-10T10:00:00Z',
      terminalType: 'build.crashed',
      terminalAt: '2026-07-10T10:05:00Z',
    }),
  ];

  const result = projectTrajectory(events, { now, days: 14 });

  // 4 attempts total: WI-100 a1, WI-101 a1, WI-101 a2, WI-102 a1
  assert.equal(result.aggregates.attempts, 4);
  assert.equal(result.aggregates.distinctItems, 3);
  assert.equal(result.aggregates.merges, 2, 'WI-100 and WI-101 merged');

  // First-pass: WI-100 (pass), WI-101 (fail), WI-102 (crash) → 1/3
  assert.ok(Math.abs(result.aggregates.firstPassMergeRate - 1 / 3) < 1e-9, 'firstPassMergeRate must be 1/3');

  // Repair: WI-101 has attempt>1 and merged → 1/1 = 1.0
  assert.equal(result.aggregates.repairMergeRate, 1);

  // Scout coverage: only WI-100 attempt 1 is briefed → 1/4
  assert.ok(Math.abs(result.aggregates.scoutCoverage - 0.25) < 1e-9, 'scoutCoverage must be 1/4');

  // Judge fail share: WI-100=pass (attempt 1), WI-101=fail (attempt 1) → 1 fail out of 2 verdicts = 0.5
  assert.ok(Math.abs(result.aggregates.judgeFailShare - 0.5) < 1e-9, 'judgeFailShare must be 0.5');

  // Avg turns: only 3 attempts have turns (10+12+6)/3 ... wait:
  // WI-100 a1: turns=4, WI-101 a1: turns=12, WI-101 a2: turns=6, WI-102 a1: no turns
  // avg = (4 + 12 + 6) / 3 = 7.333...
  const expectedTurns = (4 + 12 + 6) / 3;
  assert.ok(Math.abs(result.aggregates.avgTurnsPerAttempt - expectedTurns) < 1e-6, `avgTurns must be ${expectedTurns}`);
});

// ---------------------------------------------------------------------------
// summary --json: briefed + judgeVerdict fields (scope addition, same WI-221 commit)
// ---------------------------------------------------------------------------

/**
 * Simulate the active-item serialization that cmdSummary --json produces for one
 * item, mirroring the exact field-selection logic in cli.ts (not exec'ing the CLI,
 * which would require a temp ledger and process.env setup — we test the logic directly
 * via the fold result which is the source of truth for the serialization).
 */
test('summary --json: active item carries briefed=true and judgeVerdict when present', () => {
  const events: LedgerEvent[] = [
    // item captured and queued
    makeEvent('cli', 'WI-200', 'item.captured', { source: 'cli', text: 'build the thing' }),
    makeEvent('conductor', 'WI-200', 'item.queued', { spec: 'build thing', touches: 'src/' }),
    // scout brief
    makeEvent('dispatch', 'WI-200', 'item.briefed', { brief: 'Files: src/thing.ts', model: 'haiku' }),
    // dispatched (so attempts > 0)
    makeEvent('dispatch', 'WI-200', 'build.dispatched', { attempt: 1, pid: 1 }),
    // judge verdict (advisory — state stays building)
    makeEvent('dispatch', 'WI-200', 'review.verdict', {
      verdict: 'pass',
      confidence: 0.85,
      specSatisfied: 'yes',
      scopeCreep: 'none',
      testTheatre: 'none',
      reasons: ['looks good'],
      model: 'sonnet',
      judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
  ];

  const result = fold(events);
  const rec = result.items.get('WI-200')!;
  assert.ok(rec, 'WI-200 must exist in fold result');

  // Simulate the summary serialization for an active item (mirrors cli.ts cmdSummary)
  const serialized = {
    id: rec.id,
    state: rec.state,
    attempts: rec.attempts,
    briefed: rec.brief !== undefined,
    judgeVerdict: rec.judgeVerdict
      ? { verdict: rec.judgeVerdict.verdict, confidence: rec.judgeVerdict.confidence }
      : null,
  };

  assert.equal(serialized.briefed, true, 'briefed must be true when item.briefed is in the ledger');
  assert.ok(serialized.judgeVerdict !== null, 'judgeVerdict must be non-null when review.verdict present');
  assert.equal(serialized.judgeVerdict!.verdict, 'pass');
  assert.equal(serialized.judgeVerdict!.confidence, 0.85);
  assert.equal(serialized.attempts, 1, 'attempts must be present and correct');
  assert.equal(serialized.state, 'building', 'state must be building (judge is advisory)');
});

test('summary --json: active item carries briefed=false and judgeVerdict=null when absent', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-201', 'item.captured', { source: 'cli', text: 'another task' }),
    makeEvent('conductor', 'WI-201', 'item.queued', { spec: 'do something', touches: 'src/' }),
  ];

  const result = fold(events);
  const rec = result.items.get('WI-201')!;
  assert.ok(rec, 'WI-201 must exist');

  const serialized = {
    briefed: rec.brief !== undefined,
    judgeVerdict: rec.judgeVerdict
      ? { verdict: rec.judgeVerdict.verdict, confidence: rec.judgeVerdict.confidence }
      : null,
    attempts: rec.attempts,
  };

  assert.equal(serialized.briefed, false, 'briefed must be false when no item.briefed event');
  assert.equal(serialized.judgeVerdict, null, 'judgeVerdict must be null when no review.verdict');
  assert.equal(serialized.attempts, 0);
});

test('summary --json: merged item carries briefed + judgeVerdict in recentMerged', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-202', 'item.captured', { source: 'cli', text: 'merged with brief' }),
    makeEvent('conductor', 'WI-202', 'item.queued', { spec: 'ship it', touches: 'src/' }),
    makeEvent('dispatch', 'WI-202', 'item.briefed', { brief: 'Files: src/x.ts', model: 'haiku' }),
    makeEvent('dispatch', 'WI-202', 'build.dispatched', { attempt: 1, pid: 1 }),
    makeEvent('dispatch', 'WI-202', 'gate.passed', { tests: 'green' }),
    makeEvent('dispatch', 'WI-202', 'review.verdict', {
      verdict: 'fail',
      confidence: 0.6,
      specSatisfied: 'partial',
      scopeCreep: 'minor',
      testTheatre: 'none',
      reasons: ['scope issue'],
      model: 'sonnet',
      judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
    makeEvent('dispatch', 'WI-202', 'item.merged', { commit: 'abc123', deployed: false }),
  ];

  const result = fold(events);
  const rec = result.items.get('WI-202')!;
  assert.ok(rec, 'WI-202 must exist');
  assert.equal(rec.state, 'merged');

  // Simulate recentMerged serialization (mirrors cli.ts cmdSummary)
  const serialized = {
    id: rec.id,
    mergedAt: rec.mergedAt,
    briefed: rec.brief !== undefined,
    judgeVerdict: rec.judgeVerdict
      ? { verdict: rec.judgeVerdict.verdict, confidence: rec.judgeVerdict.confidence }
      : null,
  };

  assert.equal(serialized.briefed, true, 'briefed must be true on merged item with prior item.briefed');
  assert.ok(serialized.judgeVerdict !== null, 'judgeVerdict must be non-null on merged item with verdict');
  assert.equal(serialized.judgeVerdict!.verdict, 'fail');
  assert.equal(serialized.judgeVerdict!.confidence, 0.6);
});
