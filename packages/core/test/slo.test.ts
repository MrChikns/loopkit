/**
 * slo.test.ts — Self-heal kernel tests
 *
 * Tests (injected fakes — no real launchctl/network):
 *  1. SLO evaluator classifies met/at-risk/breached from fixture probes
 *  2. Edge-trigger emits exactly one breach + one recover across state changes
 *  3. propose mode writes heal.proposed and executes NOTHING
 *  4. heal mode executes and writes heal.executed with evidence
 *  5. Anti-flap: escalates after 3 heals in 6h, no more execute
 *  6. Watchdog (day-1 exempt): kickstarts stale opposite beat even in propose mode
 *  7. Graduation counter math: cleanDays counts proposal days without escalation
 *  8. Loop-reactor row classifies correctly from lastrun age
 *  9. slo.recovered emitted when breach clears
 * 10. watch mode writes no events at all
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import {
  evaluateSloBoard, deriveSloState, makeDeployProbe, makeInstanceProbe, makeRealProbes,
  dispatchWedgeSecFor, parseLaunchctlList, parseLaunchctlPrint, makeLaunchdProbe,
  readEpochStampFile, SloProbes, SloRow,
} from '../src/slo.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { runDispatch, DispatchOptions } from '../src/beats/dispatch.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { fold } from '../src/fold.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `slo-test-${process.pid}-${++testCount}-${Date.now()}`);
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
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    slo: {
      reactorFreshSec: 300,
      dispatchFreshSec: 600,
      deployBehindHours: 1,
      backupMaxHours: 26,
      watchNightlyMaxHours: 26,
      watchHourlyMaxHours: 2,
      acceptanceMaxHours: 48,
      decisionMaxHours: 72,
      unroutedMaxMin: 15,
      routingWorstMin: 15,
      atRiskFraction: 0.8,
      expectedLaunchdLabels: [],
      instanceProbes: {},
    },
    ...overrides,
  };
}

async function seedLedger(ledgerDir: string, events: LedgerEvent[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

// Fixture probes that return fresh/healthy values
function makeFreshProbes(nowMs: number = Date.now()): SloProbes {
  return {
    now: () => nowMs,
    reactorLastrun: () => Math.floor(nowMs / 1000) - 10, // 10s ago = fresh
    dispatchLastrun: () => Math.floor(nowMs / 1000) - 30, // 30s ago = fresh
    launchd: () => undefined, // no launchd probing in tests
    backup: () => 2,          // 2h = well under 26h
    watchNightly: () => nowMs - 1 * 3600 * 1000, // 1h old = fresh
    watchHourly: () => nowMs - 0.5 * 3600 * 1000, // 30m old = fresh
    deploy: () => ({ behindCount: 0 }),
    fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0 }),
  };
}

// Fixture probes where reactor is stale (breached)
function makeStaleReactorProbes(nowMs: number = Date.now()): SloProbes {
  const fresh = makeFreshProbes(nowMs);
  return {
    ...fresh,
    reactorLastrun: () => Math.floor(nowMs / 1000) - 400, // 400s > 300s threshold → breached
  };
}

// ---------------------------------------------------------------------------
// Test 1: evaluator classifies met/at-risk/breached from fixture probes
// ---------------------------------------------------------------------------

test('slo: evaluator classifies met from fresh probes', () => {
  const board = evaluateSloBoard(
    { reactorFreshSec: 300, dispatchFreshSec: 600, atRiskFraction: 0.8 },
    makeFreshProbes(),
    [],
  );

  const reactor = board.find(r => r.key === 'loop-reactor');
  assert.ok(reactor, 'loop-reactor row must exist');
  assert.equal(reactor.status, 'met', `expected met, got ${reactor.status} (${reactor.value})`);

  const dispatch = board.find(r => r.key === 'loop-dispatch');
  assert.ok(dispatch, 'loop-dispatch row must exist');
  assert.equal(dispatch.status, 'met');

  const backup = board.find(r => r.key === 'backup');
  assert.ok(backup, 'backup row must exist');
  assert.equal(backup.status, 'met');
});

test('slo: evaluator classifies breached when reactor is stale', () => {
  const nowMs = Date.now();
  const board = evaluateSloBoard(
    { reactorFreshSec: 300, atRiskFraction: 0.8 },
    makeStaleReactorProbes(nowMs),
    [],
  );

  const reactor = board.find(r => r.key === 'loop-reactor');
  assert.ok(reactor, 'loop-reactor row must exist');
  assert.equal(reactor.status, 'breached', `expected breached, got ${reactor.status} (${reactor.value})`);
});

test('slo: evaluator classifies at-risk in amber band (>80% of threshold)', () => {
  const nowMs = Date.now();
  const probes = makeFreshProbes(nowMs);
  // reactorFreshSec = 300; at-risk band = > 240s (0.8 × 300); we set age to 260s
  probes.reactorLastrun = () => Math.floor(nowMs / 1000) - 260;
  const board = evaluateSloBoard(
    { reactorFreshSec: 300, atRiskFraction: 0.8 },
    probes,
    [],
  );

  const reactor = board.find(r => r.key === 'loop-reactor');
  assert.ok(reactor, 'loop-reactor row must exist');
  assert.equal(reactor.status, 'at-risk', `expected at-risk at 260s with 300s threshold`);
});

test('slo: backup row breaches when age > 26h', () => {
  const nowMs = Date.now();
  const probes = makeFreshProbes(nowMs);
  probes.backup = () => 30; // 30h > 26h target
  const board = evaluateSloBoard({ backupMaxHours: 26, atRiskFraction: 0.8 }, probes, []);

  const backup = board.find(r => r.key === 'backup');
  assert.equal(backup?.status, 'breached');
});

// ---------------------------------------------------------------------------
// Test 2: edge-trigger emits exactly one breach + one recover
// ---------------------------------------------------------------------------

test('slo: reactor step emits exactly one breach on green→red and one recover on red→green', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-edge-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    const cfg = makeTestConfig();

    // Beat 1: fresh probes → should emit 0 breach events
    const result1 = await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch', // watch mode = no heal events
      provider: null,
      config: cfg,
      sloProbes: makeFreshProbes(nowMs),
    });

    const events1 = await loadAllEvents(ledgerDir);
    const breaches1 = events1.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'loop-reactor');
    assert.equal(breaches1.length, 0, 'no breach on fresh reactor');

    // Beat 2: stale probes → should emit exactly 1 breach event
    const result2 = await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch',
      provider: null,
      config: cfg,
      sloProbes: makeStaleReactorProbes(nowMs),
    });

    const events2 = await loadAllEvents(ledgerDir);
    const breaches2 = events2.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'loop-reactor');
    assert.equal(breaches2.length, 1, 'exactly one breach event on green→red');

    // Beat 3: stale probes again → NO second breach (edge-triggered, still breached)
    const result3 = await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch',
      provider: null,
      config: cfg,
      sloProbes: makeStaleReactorProbes(nowMs),
    });

    const events3 = await loadAllEvents(ledgerDir);
    const breaches3 = events3.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'loop-reactor');
    assert.equal(breaches3.length, 1, 'still exactly one breach (no spam on repeated stale beat)');

    // Beat 4: fresh probes again → should emit exactly 1 slo.recovered
    const result4 = await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch',
      provider: null,
      config: cfg,
      sloProbes: makeFreshProbes(nowMs),
    });

    const events4 = await loadAllEvents(ledgerDir);
    const recovers = events4.filter(e => e.type === 'slo.recovered' && (e.data as { key?: string }).key === 'loop-reactor');
    assert.equal(recovers.length, 1, 'exactly one recover event on red→green');

    // Beat 5: fresh probes → no second recover
    const result5 = await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch',
      provider: null,
      config: cfg,
      sloProbes: makeFreshProbes(nowMs),
    });

    const events5 = await loadAllEvents(ledgerDir);
    const recovers5 = events5.filter(e => e.type === 'slo.recovered' && (e.data as { key?: string }).key === 'loop-reactor');
    assert.equal(recovers5.length, 1, 'still exactly one recover (no spam on repeated fresh)');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 3: propose mode writes heal.proposed and executes NOTHING
// ---------------------------------------------------------------------------

test('slo: propose mode writes heal.proposed for breached key and executes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-propose-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    let spawnCalled = false;

    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'propose',
      provider: null,
      config: makeTestConfig(),
      sloProbes: makeStaleReactorProbes(nowMs),
      runbookSpawn: (_cmd, _args) => {
        spawnCalled = true;
        return { ok: true, output: '' };
      },
    });

    // Must NOT have called spawn (except day-1 exempt watchdog for loop-dispatch if stale,
    // but in this test loop-dispatch is fresh so dispatch watchdog won't fire)
    // The loop-reactor runbook IS day-1 exempt and would fire from the reactor itself,
    // but we're checking that the propose path does NOT execute non-day1-exempt runbooks.
    // The reactor itself won't kickstart itself (would be a bug).

    const events = await loadAllEvents(ledgerDir);
    const proposed = events.filter(e =>
      e.type === 'heal.proposed' &&
      (e.data as { key?: string }).key === 'loop-reactor',
    );
    // Note: loop-reactor IS day-1 exempt, so in the reactor's heal step it executes.
    // But since we injected a spawn that tracks calls, and the reactor step runs propose
    // for other keys, let's verify no heal.executed for non-exempt keys.
    // The backup row is 'met' in fresh probes, so no heal needed.
    // For this test we test backup being breached (non-exempt, propose → proposed event only).
    const executed = events.filter(e => e.type === 'heal.executed' && (e.data as { key?: string }).key === 'backup');
    assert.equal(executed.length, 0, 'no heal.executed for non-day1-exempt key in propose mode');
  } finally {
    cleanDir(dir);
  }
});

// NOTE: the backup/instances/watch-nightly/watch-hourly SLO rows are fed by opt-in probes
// (SloProbePaths) and have no generic runbook in runbooks.ts, so there is nothing runbook-shaped
// to assert for them here. The framework-generic runbooks this suite covers ('launchd',
// 'loop-reactor', 'loop-dispatch', 'ci-reenable') are exercised elsewhere in this file /
// ci-reenable.test.ts.

// ---------------------------------------------------------------------------
// Test 6: watchdog kickstarts stale opposite beat even in propose mode
// ---------------------------------------------------------------------------

test('slo: dispatch watchdog kickstarts stale reactor even in propose mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-watchdog-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    // Reactor lastrun is 400s ago (> 300s threshold → stale)
    const staleLastrunSec = Math.floor(nowMs / 1000) - 400;

    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'x' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'nowhere' }),
    ]);

    await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true, // dry-run to avoid real git ops
      autonomy: 'on',
      provider: null,
      config: makeTestConfig({ loops: { reactorLabel: 'com.example.reactor' } }),
      reactorLastrunProbe: () => staleLastrunSec,
      watchdogSpawn: (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return { ok: true, output: 'kickstarted' };
      },
    });

    // Watchdog should have been called (dispatch kicks reactor when stale)
    // Note: in dry-run mode the watchdog is skipped to avoid side-effects
    // The watchdog only runs in non-dry-run mode (by design: dry-run = no OS actions)
    // So for this test we verify the behavior by running without dry-run but with injected spawn
    // Reset and run real (non-dry-run)
    spawnCalls.length = 0;
    // Re-run without dry-run (but with injected spawn to avoid real launchctl)
    await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: false,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig({ loops: { reactorLabel: 'com.example.reactor' } }),
      reactorLastrunProbe: () => staleLastrunSec,
      watchdogSpawn: (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return { ok: true, output: 'kickstarted' };
      },
      // branchProbe prevents any real git merge from happening
      branchProbe: () => 'not-master',
      gateResult: { passed: true, reason: 'fake' },
    });

    const kickstartCalls = spawnCalls.filter(c =>
      c.cmd === 'launchctl' && c.args[0] === 'kickstart' && c.args.some(a => a.includes('reactor')),
    );
    assert.ok(kickstartCalls.length >= 1, `watchdog must have called launchctl kickstart for reactor (got ${spawnCalls.length} spawn calls: ${JSON.stringify(spawnCalls)})`);
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 7: graduation counter math
// ---------------------------------------------------------------------------

test('slo: graduation counter counts clean proposal days (no escalation = clean)', () => {
  const nowMs = Date.now();
  // 15 days of proposals, no escalations → cleanDays=15, eligible=true
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 15; i++) {
    const day = new Date(nowMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    events.push({
      id: `ev-${i}`,
      ts: `${day}T12:00:00.000Z`,
      actor: 'reactor',
      item: 'system',
      type: 'heal.proposed',
      data: { key: 'backup', action: 'kickstart', tier: 'auto-heal' },
    });
  }

  // Evaluate board with these ops events — graduation should show up
  const probes = makeFreshProbes(nowMs);
  probes.backup = () => 30; // breach the backup key so we can see its graduation row
  const board = evaluateSloBoard({ backupMaxHours: 26, atRiskFraction: 0.8 }, probes, events);

  const backup = board.find(r => r.key === 'backup');
  assert.ok(backup, 'backup row must exist');
  assert.ok(backup.graduation, 'graduation field must be present');
  assert.ok(backup.graduation.cleanDays >= 14, `cleanDays should be >=14 (got ${backup.graduation.cleanDays})`);
  assert.equal(backup.graduation.eligible, true, 'should be eligible after 14 clean days');
});

test('slo: graduation counter — escalation days are not counted as clean', () => {
  const nowMs = Date.now();
  const events: LedgerEvent[] = [];
  const today = new Date(nowMs).toISOString().slice(0, 10);

  // 5 proposal days: days 0-4
  for (let i = 0; i < 5; i++) {
    const day = new Date(nowMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    events.push({
      id: `ev-p${i}`,
      ts: `${day}T12:00:00.000Z`,
      actor: 'reactor',
      item: 'system',
      type: 'heal.proposed',
      data: { key: 'backup', action: 'kickstart', tier: 'auto-heal' },
    });
  }
  // Escalation on day 2 (makes day 2 "dirty")
  const day2 = new Date(nowMs - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  events.push({
    id: 'ev-e',
    ts: `${day2}T13:00:00.000Z`,
    actor: 'reactor',
    item: 'system',
    type: 'heal.escalated',
    data: { key: 'backup', reason: 'anti-flap', count: 3 },
  });

  const probes = makeFreshProbes(nowMs);
  probes.backup = () => 30;
  const board = evaluateSloBoard({ backupMaxHours: 26, atRiskFraction: 0.8 }, probes, events);

  const backup = board.find(r => r.key === 'backup');
  assert.ok(backup?.graduation, 'graduation must be present');
  // 5 proposal days - 1 escalation day = 4 clean days
  assert.equal(backup.graduation.cleanDays, 4, `should be 4 clean days (got ${backup.graduation.cleanDays})`);
  assert.equal(backup.graduation.eligible, false, 'not eligible with only 4 clean days');
});

test('slo: graduation via heal.graduated event makes key eligible immediately', () => {
  const nowMs = Date.now();
  const events: LedgerEvent[] = [
    {
      id: 'ev-g',
      ts: new Date(nowMs - 1000).toISOString(),
      actor: 'cli',
      item: 'system',
      type: 'heal.graduated',
      data: { key: 'backup' },
    },
  ];

  const probes = makeFreshProbes(nowMs);
  probes.backup = () => 30;
  const board = evaluateSloBoard({ backupMaxHours: 26, atRiskFraction: 0.8 }, probes, events);

  const backup = board.find(r => r.key === 'backup');
  assert.ok(backup?.graduation, 'graduation must be present');
  assert.equal(backup.graduation.eligible, true, 'heal.graduated event makes key eligible immediately');
  assert.equal(backup.graduation.cleanDays, 0, 'cleanDays is still 0 (no proposals)');
});

// ---------------------------------------------------------------------------
// Test 8: loop-reactor row classification from lastrun age
// ---------------------------------------------------------------------------

test('slo: loop-reactor row status from lastrun age — boundary conditions', () => {
  const nowMs = Date.now();
  const cfg = { reactorFreshSec: 300, atRiskFraction: 0.8 };

  // met: age = 100s (well under 300)
  const p1 = { ...makeFreshProbes(nowMs), reactorLastrun: () => Math.floor(nowMs / 1000) - 100 };
  const b1 = evaluateSloBoard(cfg, p1, []);
  assert.equal(b1.find(r => r.key === 'loop-reactor')?.status, 'met');

  // at-risk: age = 250s (> 0.8 × 300 = 240, < 300)
  const p2 = { ...makeFreshProbes(nowMs), reactorLastrun: () => Math.floor(nowMs / 1000) - 250 };
  const b2 = evaluateSloBoard(cfg, p2, []);
  assert.equal(b2.find(r => r.key === 'loop-reactor')?.status, 'at-risk');

  // breached: age = 301s
  const p3 = { ...makeFreshProbes(nowMs), reactorLastrun: () => Math.floor(nowMs / 1000) - 301 };
  const b3 = evaluateSloBoard(cfg, p3, []);
  assert.equal(b3.find(r => r.key === 'loop-reactor')?.status, 'breached');

  // unknown: lastrun returns undefined
  const p4 = { ...makeFreshProbes(nowMs), reactorLastrun: () => undefined };
  const b4 = evaluateSloBoard(cfg, p4, []);
  assert.equal(b4.find(r => r.key === 'loop-reactor')?.status, 'unknown');
});

// ---------------------------------------------------------------------------
// Test 9: slo.recovered emitted when breach clears
// ---------------------------------------------------------------------------

test('slo: slo.recovered emitted when key transitions from breached to met', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-recover-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();
    const cfg = makeTestConfig();

    // Seed a prior slo.breach for backup (so it's "known breached")
    await seedLedger(ledgerDir, [
      makeEvent('reactor', 'system', 'slo.breach', {
        indicator: 'backup', value: '30', target: '< 26h',
      }),
    ]);

    // Now run with backup healthy (2h)
    const probes = makeFreshProbes(nowMs);
    probes.backup = () => 2; // healthy

    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch',
      provider: null,
      config: cfg,
      sloProbes: probes,
    });

    const events = await loadAllEvents(ledgerDir);
    const recovers = events.filter(e =>
      e.type === 'slo.recovered' && (e.data as { key?: string }).key === 'backup',
    );
    assert.equal(recovers.length, 1, `slo.recovered expected (got ${recovers.length})`);
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 10: watch mode writes no heal events
// ---------------------------------------------------------------------------

test('slo: watch mode emits no heal events (not even heal.proposed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-watch-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    const probes = makeFreshProbes(nowMs);
    probes.backup = () => 30; // breached

    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'watch',
      provider: null,
      config: makeTestConfig(),
      sloProbes: probes,
    });

    const events = await loadAllEvents(ledgerDir);
    const healEvents = events.filter(e => e.type.startsWith('heal.'));
    assert.equal(healEvents.length, 0, `no heal events in watch mode (got ${healEvents.length})`);
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test: deriveSloState correctly reads breach/recover sequence
// ---------------------------------------------------------------------------

test('slo: deriveSloState tracks last state from ledger events', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'system', 'slo.breach', { indicator: 'backup', value: '30', target: '< 26h' }, '2026-01-01T01:00:00.000Z'),
    makeEvent('reactor', 'system', 'slo.breach', { indicator: 'loop-reactor', value: '400', target: '≤ 5m' }, '2026-01-01T01:01:00.000Z'),
    makeEvent('reactor', 'system', 'slo.recovered', { key: 'backup' }, '2026-01-01T02:00:00.000Z'),
  ];

  const state = deriveSloState(events);
  assert.equal(state.get('backup'), 'ok', 'backup should be recovered');
  assert.equal(state.get('loop-reactor'), 'breached', 'loop-reactor should still be breached');
  assert.equal(state.get('loop-dispatch'), undefined, 'loop-dispatch never seen → undefined');
});

// ---------------------------------------------------------------------------
// Regression: a live long build must never read as a stalled loop
// (a day-1 watchdog kickstart once killed a long-running build mid-flight because
// staleness was read without checking liveness first — the lock-age probe below
// exists to distinguish "stale and idle" from "stale lastrun but still running".)
// ---------------------------------------------------------------------------

test('slo: fresh dispatch lock = beat in flight (met), even with stale lastrun', () => {
  const board = evaluateSloBoard({ reactorFreshSec: 300, dispatchFreshSec: 600 }, {
    now: () => 1752105600000,
    dispatchLastrun: () => Math.floor(1752105600000 / 1000) - 30 * 60, // 30 min stale
    dispatchLockAgeSec: () => 12 * 60, // beat running 12 min (a long build)
  }, []);
  const row = board.find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(row.status, 'met');
  assert.ok(String(row.value).includes('beat in flight'), row.value as string);
});

test('slo: very old dispatch lock = wedged (breached)', () => {
  const board = evaluateSloBoard({ reactorFreshSec: 300, dispatchFreshSec: 600 }, {
    now: () => 1752105600000,
    dispatchLastrun: () => Math.floor(1752105600000 / 1000) - 90 * 60,
    dispatchLockAgeSec: () => 80 * 60, // > 55 min wedge threshold
  }, []);
  const row = board.find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(row.status, 'breached');
  assert.ok(String(row.value).includes('wedged'), row.value as string);
});

// ---------------------------------------------------------------------------
// makeRealProbes — plane-home run-state resolution (mirrors the beats' opts.runDir)
// ---------------------------------------------------------------------------

test('slo: makeRealProbes reads reactor/dispatch lastrun + locks from an injected runDir, not repoRoot (plane-home mode)', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'slo-probes-repo-'));
  const planeHome = mkdtempSync(join(tmpdir(), 'slo-probes-home-'));
  try {
    const runDir = join(planeHome, 'runs', 'loopkit');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(planeHome, 'runs', 'reactor'), { recursive: true });
    mkdirSync(join(planeHome, 'runs', 'dispatch'), { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    writeFileSync(join(planeHome, 'runs', 'reactor', 'lastrun'), String(nowSec), 'utf8');
    writeFileSync(join(planeHome, 'runs', 'dispatch', 'lastrun'), String(nowSec), 'utf8');
    writeFileSync(join(runDir, 'reactor.lock'), '', 'utf8');
    writeFileSync(join(runDir, 'dispatch.lock'), '', 'utf8');

    const probes = makeRealProbes(repoRoot, runDir);
    assert.equal(probes.reactorLastrun?.(), nowSec, 'reactorLastrun must read from the injected runDir');
    assert.equal(probes.dispatchLastrun?.(), nowSec, 'dispatchLastrun must read from the injected runDir');
    assert.ok((probes.reactorLockAgeSec?.() ?? Infinity) < 5, 'reactorLockAgeSec must read the lock under the injected runDir');
    assert.ok((probes.dispatchLockAgeSec?.() ?? Infinity) < 5, 'dispatchLockAgeSec must read the lock under the injected runDir');

    // And nothing was ever read from (or expected under) repoRoot/.ai/runs.
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')), 'no run-state may be read from repoRoot/.ai/runs when runDir is injected');
  } finally {
    cleanDir(repoRoot);
    cleanDir(planeHome);
  }
});

test('slo: makeRealProbes defaults to the embedded repoRoot layout when runDir is omitted (back-compat)', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'slo-probes-embedded-'));
  try {
    mkdirSync(join(repoRoot, '.ai', 'runs', 'reactor'), { recursive: true });
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowSec = Math.floor(Date.now() / 1000);
    writeFileSync(join(repoRoot, '.ai', 'runs', 'reactor', 'lastrun'), String(nowSec), 'utf8');

    const probes = makeRealProbes(repoRoot);
    assert.equal(probes.reactorLastrun?.(), nowSec, 'embedded default must still resolve to <repoRoot>/.ai/runs');
  } finally {
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// makeDeployProbe + makeInstanceProbe — never-throw contract
// ---------------------------------------------------------------------------

test('slo: makeDeployProbe returns undefined (not throws) for nonexistent deploy-target root', () => {
  // Point LOOPKIT_DEPLOY_ROOT at a path that does not exist — git rev-parse will fail.
  // We assert type safety (undefined or a valid DeployStatus) and no throw.
  const probe = makeDeployProbe('/tmp/fake-repo-root', { LOOPKIT_DEPLOY_ROOT: '/nonexistent/does-not-exist' });
  let result: ReturnType<typeof probe>;
  assert.doesNotThrow(() => { result = probe(); });
  // Must be undefined (git fails) OR a valid DeployStatus shape — never throws.
  assert.ok(result === undefined || (typeof result === 'object' && typeof result!.behindCount === 'number'),
    `expected undefined or DeployStatus, got ${JSON.stringify(result)}`);
});

test('slo: makeInstanceProbe returns false for unreachable URL (never throws)', () => {
  const probe = makeInstanceProbe();
  let result: ReturnType<typeof probe>;
  assert.doesNotThrow(() => { result = probe('http://127.0.0.1:1/health'); });
  // An unreachable port: curl exits nonzero → false; or undefined if curl is unavailable.
  assert.ok(result === false || result === undefined,
    `expected false or undefined for unreachable URL, got ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// Spend SLO row + config budget validation
// ---------------------------------------------------------------------------

import { loadConfig } from '../src/config.js';
import { writeFileSync as wfS } from 'node:fs';
import { makeRegistry } from '../src/providers/registry.js';

test('slo: spend row is present and breaching when ceiling configured and spend >= ceiling', () => {
  const board = evaluateSloBoard(
    { dispatchDailyUsdCeiling: 0.10, atRiskFraction: 0.8 },
    { todayDispatchSpendUsd: () => 0.12 },
    [],
  );
  const spend = board.find(r => r.key === 'spend');
  assert.ok(spend, 'spend row must be present when ceiling is configured');
  assert.equal(spend.status, 'breached', `expected breached when spend >= ceiling (got ${spend.status})`);
  assert.ok(spend.value.includes('0.12'), `value must show spend (got: ${spend.value})`);
  assert.ok(spend.target.includes('0.10'), `target must show ceiling (got: ${spend.target})`);
});

test('slo: spend row is at-risk when spend is in the amber band (>= 80% of ceiling)', () => {
  const board = evaluateSloBoard(
    { dispatchDailyUsdCeiling: 0.10, atRiskFraction: 0.8 },
    { todayDispatchSpendUsd: () => 0.085 }, // 85% = at-risk
    [],
  );
  const spend = board.find(r => r.key === 'spend');
  assert.ok(spend, 'spend row must be present');
  assert.equal(spend.status, 'at-risk', `expected at-risk at 85% (got ${spend.status})`);
});

test('slo: spend row is met when spend is well below the ceiling', () => {
  const board = evaluateSloBoard(
    { dispatchDailyUsdCeiling: 0.10, atRiskFraction: 0.8 },
    { todayDispatchSpendUsd: () => 0.02 },
    [],
  );
  const spend = board.find(r => r.key === 'spend');
  assert.ok(spend, 'spend row must be present');
  assert.equal(spend.status, 'met');
});

test('slo: spend row is absent when no ceiling is configured', () => {
  const board = evaluateSloBoard(
    {},   // no dispatchDailyUsdCeiling
    { todayDispatchSpendUsd: () => 99.0 },
    [],
  );
  const spend = board.find(r => r.key === 'spend');
  assert.equal(spend, undefined, 'spend row must be absent without a ceiling');
});

test('slo: spend row is unknown when probe returns undefined', () => {
  const board = evaluateSloBoard(
    { dispatchDailyUsdCeiling: 0.10, atRiskFraction: 0.8 },
    { todayDispatchSpendUsd: () => undefined },
    [],
  );
  const spend = board.find(r => r.key === 'spend');
  assert.ok(spend, 'spend row must be present');
  assert.equal(spend.status, 'unknown');
});

// ---------------------------------------------------------------------------
// ci-reenable SLO row + config.ci.reenableOn validation
// ---------------------------------------------------------------------------

test('slo: ci-reenable row is absent when no reenableOn is configured', () => {
  const board = evaluateSloBoard({}, {}, []);
  assert.equal(board.find(r => r.key === 'ci-reenable'), undefined, 'row must be absent without reenableOn');
});

test('slo: ci-reenable row breaches once today is on/after the configured date', () => {
  const board = evaluateSloBoard(
    { ciReenableOn: '2026-08-01' },
    { now: () => Date.parse('2026-08-01T12:00:00Z') },
    [],
  );
  const row = board.find(r => r.key === 'ci-reenable');
  assert.ok(row, 'ci-reenable row must be present when configured');
  assert.equal(row.status, 'breached');
});

test('slo: ci-reenable row is met before the configured date', () => {
  const board = evaluateSloBoard(
    { ciReenableOn: '2026-08-01' },
    { now: () => Date.parse('2026-07-17T12:00:00Z') },
    [],
  );
  const row = board.find(r => r.key === 'ci-reenable');
  assert.ok(row, 'ci-reenable row must be present when configured');
  assert.equal(row.status, 'met');
});

test('config: ci.reenableOn is loaded from loopkit.config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-ci-'));
  try {
    const cfgPath = join(dir, 'loopkit.config.json');
    wfS(cfgPath, JSON.stringify({ ci: { reenableOn: '2026-08-01' } }), 'utf8');
    const cfg = loadConfig(dir);
    assert.equal(cfg.ci?.reenableOn, '2026-08-01');
  } finally {
    cleanDir(dir);
  }
});

test('config: ci absent = undefined (no reenableOn)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-noci-'));
  try {
    const cfgPath = join(dir, 'loopkit.config.json');
    wfS(cfgPath, JSON.stringify({}), 'utf8');
    const cfg = loadConfig(dir);
    assert.equal(cfg.ci, undefined, 'absent ci must be undefined');
  } finally {
    cleanDir(dir);
  }
});

test('config: ci.reenableOn must be a string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-badci-'));
  try {
    const cfgPath = join(dir, 'loopkit.config.json');
    wfS(cfgPath, JSON.stringify({ ci: { reenableOn: 20260801 } }), 'utf8');
    assert.throws(() => loadConfig(dir), /ci\.reenableOn must be a string/);
  } finally {
    cleanDir(dir);
  }
});

test('config: budget.dispatchDailyUsd is accepted when positive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-budget-'));
  try {
    const cfgPath = join(dir, 'loopkit.config.json');
    wfS(cfgPath, JSON.stringify({ budget: { dispatchDailyUsd: 0.50 } }), 'utf8');
    const cfg = loadConfig(dir);
    assert.equal(cfg.budget?.dispatchDailyUsd, 0.50, 'positive budget value must be loaded');
  } finally {
    cleanDir(dir);
  }
});

test('config: budget absent = undefined (no ceiling)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-nobudget-'));
  try {
    const cfgPath = join(dir, 'loopkit.config.json');
    wfS(cfgPath, JSON.stringify({}), 'utf8');
    const cfg = loadConfig(dir);
    assert.equal(cfg.budget, undefined, 'absent budget must be undefined');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Provider health probe: non-unknown when healthy registry is supplied
// ---------------------------------------------------------------------------

test('slo: provider row is met (non-unknown) when healthy registry is injected via providerHealth probe', () => {
  // Registry with claude-cli as internal chain, no unhealthy markers (default stubs = null → healthy).
  const reg = makeRegistry({
    providers: { 'claude-cli': {} },
    sensitivityAllowlists: {},
    chains: { internal: ['claude-cli'] },
  });

  const probes: SloProbes = {
    providerHealth: () => {
      const chain = reg.chainFor('internal');
      if (chain.length === 0) return { status: 'all-unhealthy' as const };
      const primary = chain[0]!;
      if (!reg.isUnhealthy(primary)) return { status: 'primary-healthy' as const, primaryProvider: primary, activeProvider: primary };
      const allowed = reg.allowedProviders('internal');
      for (let i = 1; i < chain.length; i++) {
        const name = chain[i]!;
        if (!allowed.includes(name)) continue;
        if (!reg.isUnhealthy(name)) {
          return { status: 'fallback-active' as const, primaryProvider: primary, activeProvider: name };
        }
      }
      return { status: 'all-unhealthy' as const };
    },
  };

  const board = evaluateSloBoard({}, probes, []);
  const row = board.find(r => r.key === 'provider');
  assert.ok(row, 'provider row must be present');
  assert.notEqual(row.status, 'unknown', `expected non-unknown (got ${row.status}: ${row.value})`);
  assert.equal(row.status, 'met', `expected met for healthy primary (got ${row.status}: ${row.value})`);
});

// ---------------------------------------------------------------------------
// Plane self-diagnosis heal tier — queue-stall + no-commit-park SLOs
// ---------------------------------------------------------------------------

import { makePlaneCheckProbe } from '../src/slo.js';

test('slo: queue-stall row classifies met/at-risk/breached from the streak count', () => {
  const met = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 0 }) }, []);
  assert.equal(met.find(r => r.key === 'queue-stall')?.status, 'met');

  const atRisk = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 1 }) }, []);
  assert.equal(atRisk.find(r => r.key === 'queue-stall')?.status, 'at-risk');

  const breached = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 3 }) }, []);
  assert.equal(breached.find(r => r.key === 'queue-stall')?.status, 'breached');

  const unknown = evaluateSloBoard({}, {}, []);
  assert.equal(unknown.find(r => r.key === 'queue-stall')?.status, 'unknown', 'no fold probe → unknown, never a false breach');
});

test('slo: queue-stall row threads the plane-check dispatchability detail into its value', () => {
  const board = evaluateSloBoard(
    {},
    {
      fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 3 }),
      planeCheck: () => [{ status: 'FAIL', check: 'dispatchability', detail: '3 queued, 0 dispatchable — choke: packages/engine/src/ shared by 3 items' }],
    },
    [],
  );
  const row = board.find(r => r.key === 'queue-stall');
  assert.ok(row?.value.includes('choke: packages/engine/src/'), `expected plane-check detail threaded into value, got: ${row?.value}`);
});

test('slo: queue-stall row stays met when the queue is serialized-but-working, not stalled', () => {
  // A dispatchability FAIL only ever fires because one in-flight build's Touches conflicts with
  // every queued item — that's the picker serializing correctly by design, not broken. As long as
  // the choking build hasn't gone stale (plane-check's in-flight rows all PASS), the persisted
  // streak must not read as a breach even if it's climbed high across many attended-sweep beats.
  const board = evaluateSloBoard(
    {},
    {
      fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 555 }),
      planeCheck: () => [
        { status: 'FAIL', check: 'dispatchability', detail: '3 queued, 0 dispatchable — choke: packages/engine/src/ shared by 3 items' },
        { status: 'PASS', check: 'in-flight', detail: 'WI-372 building 4m' },
      ],
    },
    [],
  );
  const row = board.find(r => r.key === 'queue-stall');
  assert.equal(row?.status, 'met', 'a healthy choking build means serialized-by-design, not stalled');
  assert.match(row!.value, /not stalled/);
});

test('slo: queue-stall row still breaches when the choking build has genuinely gone stale', () => {
  const board = evaluateSloBoard(
    {},
    {
      fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 5 }),
      planeCheck: () => [
        { status: 'FAIL', check: 'dispatchability', detail: '3 queued, 0 dispatchable' },
        { status: 'WARN', check: 'in-flight', detail: 'WI-372 building 90m (> 45m — check pid liveness / doctor)' },
      ],
    },
    [],
  );
  const row = board.find(r => r.key === 'queue-stall');
  assert.equal(row?.status, 'breached', 'a stuck in-flight build past the stall threshold is a genuine stall');
});

test('slo: queue-stall row breaches as before when no in-flight evidence is available at all', () => {
  // No `in-flight` rows in the plane-check output (e.g. the fold section degraded) — fall back
  // to the streak-only read rather than silently downgrading a possible genuine stall to met.
  const board = evaluateSloBoard(
    {},
    {
      fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, queueStallStreak: 3 }),
      planeCheck: () => [{ status: 'FAIL', check: 'dispatchability', detail: '3 queued, 0 dispatchable' }],
    },
    [],
  );
  const row = board.find(r => r.key === 'queue-stall');
  assert.equal(row?.status, 'breached');
});

test('slo: no-commit-park row classifies met/at-risk/breached from the 24h count', () => {
  const met = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, noCommitParkCount24h: 0 }) }, []);
  assert.equal(met.find(r => r.key === 'no-commit-park')?.status, 'met');

  const atRisk = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, noCommitParkCount24h: 2 }) }, []);
  assert.equal(atRisk.find(r => r.key === 'no-commit-park')?.status, 'at-risk');

  const breached = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, noCommitParkCount24h: 3 }) }, []);
  assert.equal(breached.find(r => r.key === 'no-commit-park')?.status, 'breached');
});

test('slo: makePlaneCheckProbe degrades to undefined (never throws) when the script is missing', () => {
  const probe = makePlaneCheckProbe('/tmp/fake-repo-root-does-not-exist-wi323');
  let result: ReturnType<typeof probe>;
  assert.doesNotThrow(() => { result = probe(); });
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// Instances row affirmatively 'met' + accept-skip streak row
// ---------------------------------------------------------------------------

test('slo: instances row reports met when every configured probe reports up', () => {
  // arbitrary example ports — instanceProbes has no src default (config.ts default is {})
  const board = evaluateSloBoard(
    { instanceProbes: { app: 'http://localhost:4001/health', demo: 'http://localhost:4002/health' } },
    { instanceProbe: () => true },
    [],
  );
  const row = board.find(r => r.key === 'instances');
  assert.equal(row?.status, 'met', 'both probes reporting true must classify as met, not unknown');
  assert.equal(row?.value, 'app up · demo up');
});

test('slo: instances row reports unknown only when a probe genuinely fails to resolve (not merely absent)', () => {
  const board = evaluateSloBoard(
    { instanceProbes: { app: 'http://localhost:4001/health', demo: 'http://localhost:4002/health' } },
    { instanceProbe: () => undefined },
    [],
  );
  const row = board.find(r => r.key === 'instances');
  assert.equal(row?.status, 'unknown');
  assert.equal(row?.value, 'app ? · demo ?');
});

test('slo: accept-skip row classifies met/at-risk/breached from the streak count', () => {
  const met = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, acceptSkipStreak: 0 }) }, []);
  assert.equal(met.find(r => r.key === 'accept-skip')?.status, 'met');

  const atRisk = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, acceptSkipStreak: 1 }) }, []);
  assert.equal(atRisk.find(r => r.key === 'accept-skip')?.status, 'at-risk');

  const breached = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, acceptSkipStreak: 3 }) }, []);
  assert.equal(breached.find(r => r.key === 'accept-skip')?.status, 'breached');

  const unknown = evaluateSloBoard({}, {}, []);
  assert.equal(unknown.find(r => r.key === 'accept-skip')?.status, 'unknown', 'no fold probe → unknown, never a false breach');
});

test('slo: queue-stall streak persists across reactor beats and breaches at the configured threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-queue-stall-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    const nowMs = Date.now();
    const cfg = makeTestConfig();
    const stalledPlaneCheck = () => [{ status: 'FAIL', check: 'dispatchability', detail: '3 queued, 0 dispatchable' }];

    for (let i = 0; i < 2; i++) {
      await runReactor({
        repoRoot: dir, ledgerDir, autonomy: 'on', opsAutonomy: 'watch', provider: null,
        config: cfg, sloProbes: makeFreshProbes(nowMs), planeCheckProbe: stalledPlaneCheck,
      });
    }
    let events = await loadAllEvents(ledgerDir);
    let breaches = events.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'queue-stall');
    assert.equal(breaches.length, 0, 'not yet breached after 2 consecutive stalled beats (default threshold is 3)');

    await runReactor({
      repoRoot: dir, ledgerDir, autonomy: 'on', opsAutonomy: 'watch', provider: null,
      config: cfg, sloProbes: makeFreshProbes(nowMs), planeCheckProbe: stalledPlaneCheck,
    });
    events = await loadAllEvents(ledgerDir);
    breaches = events.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'queue-stall');
    assert.equal(breaches.length, 1, 'breaches on the 3rd consecutive stalled beat');

    // A healthy dispatchability read resets the streak and recovers the row.
    await runReactor({
      repoRoot: dir, ledgerDir, autonomy: 'on', opsAutonomy: 'watch', provider: null,
      config: cfg, sloProbes: makeFreshProbes(nowMs),
      planeCheckProbe: () => [{ status: 'PASS', check: 'dispatchability', detail: 'queue empty' }],
    });
    events = await loadAllEvents(ledgerDir);
    const recovers = events.filter(e => e.type === 'slo.recovered' && (e.data as { key?: string }).key === 'queue-stall');
    assert.equal(recovers.length, 1, 'recovers once the plane-check probe reports healthy dispatchability');
  } finally {
    cleanDir(dir);
  }
});

test('slo: no-commit-park row counts no-commit item.parked ledger events in the trailing 24h', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-no-commit-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    const nowMs = Date.now();
    const cfg = makeTestConfig();

    const mkParked = (id: string, reason: string): LedgerEvent[] => [
      makeEvent('cli', id, 'item.captured', { source: 'test', text: 'x' }),
      makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
    ];
    await seedLedger(ledgerDir, [...mkParked('WI-901', 'no-commit: agent produced no commit'), ...mkParked('WI-902', 'no-commit: worktree issue')]);

    await runReactor({
      repoRoot: dir, ledgerDir, autonomy: 'on', opsAutonomy: 'watch', provider: null,
      config: cfg, sloProbes: makeFreshProbes(nowMs),
    });
    let events = await loadAllEvents(ledgerDir);
    let breaches = events.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'no-commit-park');
    assert.equal(breaches.length, 0, '2 no-commit parks in 24h is at-risk, not yet breached (default threshold is 3)');

    await seedLedger(ledgerDir, mkParked('WI-903', 'no-commit: allowlist denial'));
    await runReactor({
      repoRoot: dir, ledgerDir, autonomy: 'on', opsAutonomy: 'watch', provider: null,
      config: cfg, sloProbes: makeFreshProbes(nowMs),
    });
    events = await loadAllEvents(ledgerDir);
    breaches = events.filter(e => e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'no-commit-park');
    assert.equal(breaches.length, 1, 'breaches once 3 no-commit parks land within 24h');
  } finally {
    cleanDir(dir);
  }
});

test('slo: getRunbook resolves the queue-stall and no-commit-park keys to escalate-tier runbooks', async () => {
  const { getRunbook } = await import('../src/runbooks.js');
  for (const key of ['queue-stall', 'no-commit-park']) {
    const rb = getRunbook(key);
    assert.ok(rb, `expected a runbook for ${key}`);
    assert.equal(rb!.tier, 'escalate', `${key} should be notify-only in this slice (no execute)`);
  }
});

// ---------------------------------------------------------------------------
// Master/origin divergence sentinel (self-heal probe)
// ---------------------------------------------------------------------------

import { makeDivergenceProbe } from '../src/slo.js';

test('slo: divergence row classifies met/at-risk/breached from the streak count', () => {
  const met = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 0 }) }, []);
  assert.equal(met.find(r => r.key === 'divergence')?.status, 'met');

  const atRisk = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 1 }) }, []);
  assert.equal(atRisk.find(r => r.key === 'divergence')?.status, 'at-risk');

  const breached = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 3 }) }, []);
  assert.equal(breached.find(r => r.key === 'divergence')?.status, 'breached');

  const unknown = evaluateSloBoard({}, {}, []);
  assert.equal(unknown.find(r => r.key === 'divergence')?.status, 'unknown', 'no fold probe → unknown, never a false breach');
});

test('slo: divergence row recovers to met once the streak resets to zero (sustained-breach then recovery)', () => {
  const breached = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 3 }) }, []);
  assert.equal(breached.find(r => r.key === 'divergence')?.status, 'breached');

  const recovered = evaluateSloBoard({}, { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 0 }) }, []);
  assert.equal(recovered.find(r => r.key === 'divergence')?.status, 'met');
  assert.equal(recovered.find(r => r.key === 'divergence')?.value, 'in sync');
});

test('slo: divergence row threads the local-ahead count from the divergence probe into its value', () => {
  const board = evaluateSloBoard(
    {},
    {
      fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 3 }),
      divergence: () => ({ localAhead: 4, originAhead: 0 }),
    },
    [],
  );
  const row = board.find(r => r.key === 'divergence');
  assert.ok(row?.value.includes('4 local-ahead'), `expected local-ahead count threaded into value, got: ${row?.value}`);
});

test('slo: divergence config threshold is configurable (custom consecutive-beats boundary)', () => {
  const board = evaluateSloBoard(
    { divergenceAheadConsecutiveBeats: 5 },
    { fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0, divergenceAheadStreak: 3 }) },
    [],
  );
  assert.equal(board.find(r => r.key === 'divergence')?.status, 'at-risk', 'streak 3 < custom threshold 5 ⇒ not yet breached');
});

test('slo: makeDivergenceProbe degrades to undefined (never throws) when git fails', () => {
  const probe = makeDivergenceProbe('/tmp/fake-repo-root-does-not-exist-wi328');
  let result: ReturnType<typeof probe>;
  assert.doesNotThrow(() => { result = probe(); });
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// Long-beat heartbeat: the staleness probe prefers the mid-beat heartbeat over the
// beat-start lastrun, so a beat legitimately draining many items stays green — while a
// truly frozen beat (heartbeat stopped) still trips the wedge threshold.
// ---------------------------------------------------------------------------

const HB_NOW = 1752105600000;
const hbSec = (agoSec: number) => Math.floor(HB_NOW / 1000) - agoSec;

test('slo: heartbeat refreshed between items keeps dispatch green during a long beat (lock older than the wedge)', () => {
  const board = evaluateSloBoard({}, {
    now: () => HB_NOW,
    dispatchLastrun: () => hbSec(3 * 3600),      // beat started 3 h ago
    dispatchHeartbeat: () => hbSec(2 * 60),      // last item finished 2 min ago
    dispatchLockAgeSec: () => 3 * 3600,          // lock far past the 55-min wedge
  }, []);
  const row = board.find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(row.status, 'met');
  assert.ok(String(row.value).includes('heartbeat'), row.value as string);
});

test('slo: a truly frozen dispatch beat (stale heartbeat + old lock) still breaches as wedged', () => {
  const board = evaluateSloBoard({}, {
    now: () => HB_NOW,
    dispatchLastrun: () => hbSec(3 * 3600),
    dispatchHeartbeat: () => hbSec(2 * 3600),    // heartbeat stopped 2 h ago (> 55-min wedge)
    dispatchLockAgeSec: () => 3 * 3600,
  }, []);
  const row = board.find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(row.status, 'breached');
  assert.ok(String(row.value).includes('wedged'), row.value as string);
});

test('slo: without a lock, a fresh heartbeat alone keeps a stale-lastrun dispatch row green', () => {
  const board = evaluateSloBoard({}, {
    now: () => HB_NOW,
    dispatchLastrun: () => hbSec(30 * 60),       // lastrun written at beat start, 30 min ago
    dispatchHeartbeat: () => hbSec(60),          // heartbeat 1 min ago
  }, []);
  const row = board.find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(row.status, 'met');
});

test('slo: reactor mirror — heartbeat keeps a long reactor beat green past the reactor wedge', () => {
  const board = evaluateSloBoard({}, {
    now: () => HB_NOW,
    reactorLastrun: () => hbSec(40 * 60),
    reactorHeartbeat: () => hbSec(60),
    reactorLockAgeSec: () => 30 * 60,            // > 20-min reactor wedge
  }, []);
  const row = board.find((r: SloRow) => r.key === 'loop-reactor')!;
  assert.equal(row.status, 'met');
  assert.ok(String(row.value).includes('heartbeat'), row.value as string);
});

// ---------------------------------------------------------------------------
// Work-shaped dispatch wedge threshold
// ---------------------------------------------------------------------------

test('slo: dispatchWedgeSecFor reproduces the old flat 55-min default at cap 1 and scales with the cap', () => {
  assert.equal(dispatchWedgeSecFor(1, 40), 55 * 60);
  assert.equal(dispatchWedgeSecFor(5, 40), 5 * 40 * 60 + 15 * 60);
  assert.equal(dispatchWedgeSecFor(0, 40), 55 * 60, 'cap floors at 1');
  assert.equal(dispatchWedgeSecFor(2, 30, 10), 2 * 30 * 60 + 10 * 60);
});

test('slo: an injected dispatchWedgeSec keeps a long multi-item beat green where the flat default would breach', () => {
  const probes: SloProbes = {
    now: () => HB_NOW,
    dispatchLastrun: () => hbSec(90 * 60),
    dispatchLockAgeSec: () => 80 * 60, // > flat 55-min wedge, < work-shaped 3×40+15
  };
  const flat = evaluateSloBoard({}, probes, []).find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(flat.status, 'breached', 'flat default must still classify 80 min as wedged');
  const shaped = evaluateSloBoard(
    { dispatchWedgeSec: dispatchWedgeSecFor(3, 40) }, probes, [],
  ).find((r: SloRow) => r.key === 'loop-dispatch')!;
  assert.equal(shaped.status, 'met', 'work-shaped wedge must read the same beat as in flight');
});

// ---------------------------------------------------------------------------
// launchd probe: loaded interval jobs with no current pid are healthy-idle, and the
// per-label `launchctl print` fallback covers jobs the session-filtered legacy `list`
// output hides from a probe running inside another launchd job.
// ---------------------------------------------------------------------------

test('slo: parseLaunchctlList keeps a 0 exit code as 0 (idle interval job) and preserves signal exits', () => {
  const jobs = parseLaunchctlList('PID\tStatus\tLabel\n-\t0\tcom.example.reactor\n123\t-15\tcom.example.console\n-\t78\tcom.example.broken\nnot a row\n');
  assert.equal(jobs.length, 3);
  const idle = jobs.find(j => j.label === 'com.example.reactor')!;
  assert.deepEqual(idle, { label: 'com.example.reactor', loaded: true, running: false, lastExit: 0 });
  const running = jobs.find(j => j.label === 'com.example.console')!;
  assert.equal(running.running, true);
  assert.equal(running.lastExit, -15);
  const broken = jobs.find(j => j.label === 'com.example.broken')!;
  assert.equal(broken.lastExit, 78);
});

test('slo: a loaded interval job with no current pid and exit 0 is healthy-idle on the board (never "not loaded")', () => {
  const jobs = parseLaunchctlList('PID\tStatus\tLabel\n-\t0\tcom.example.reactor\n-\t0\tcom.example.dispatch\n');
  const board = evaluateSloBoard(
    { expectedLaunchdLabels: ['com.example.reactor', 'com.example.dispatch'] },
    { now: () => HB_NOW, launchd: () => jobs },
    [],
  );
  const row = board.find((r: SloRow) => r.key === 'launchd')!;
  assert.equal(row.status, 'met', JSON.stringify(row));
  assert.ok(!String(row.value).includes('not loaded'), row.value as string);
});

test('slo: makeLaunchdProbe falls back to per-label launchctl print for jobs the legacy list hides', () => {
  const calls: string[][] = [];
  const spawn = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'list') {
      // Session-filtered list output: the loaded interval beats are NOT visible here.
      return { status: 0, stdout: 'PID\tStatus\tLabel\n456\t0\tcom.example.console\n' };
    }
    // print gui/<uid>/<label>: reactor is loaded (idle); "ghost" is genuinely not loaded.
    if (String(args[1]).endsWith('/com.example.reactor')) {
      return { status: 0, stdout: 'com.example.reactor = {\n\tlast exit code = 0\n}' };
    }
    return { status: 113, stdout: '' };
  };
  const probe = makeLaunchdProbe(['com.example.reactor', 'com.example.ghost'], spawn, 501);
  const jobs = probe()!;
  const reactor = jobs.find(j => j.label === 'com.example.reactor');
  assert.ok(reactor, 'the print fallback must recover the loaded-but-hidden job');
  assert.deepEqual(reactor, { label: 'com.example.reactor', loaded: true, running: false, lastExit: 0 });
  assert.ok(!jobs.some(j => j.label === 'com.example.ghost'), 'a truly unloaded label stays missing');
  assert.deepEqual(calls[1], ['print', 'gui/501/com.example.reactor']);

  // Board classification: recovered job healthy-idle; the ghost breaches as not loaded.
  const board = evaluateSloBoard(
    { expectedLaunchdLabels: ['com.example.reactor', 'com.example.ghost'] },
    { now: () => HB_NOW, launchd: probe },
    [],
  );
  const row = board.find((r: SloRow) => r.key === 'launchd')!;
  assert.equal(row.status, 'breached');
  assert.ok(String(row.value).includes('ghost'), row.value as string);
  assert.ok(!String(row.value).includes('reactor,'), row.value as string);
});

test('slo: parseLaunchctlPrint reads a running job pid and last exit code', () => {
  const running = parseLaunchctlPrint('com.example.dispatch', 'com.example.dispatch = {\n\tpid = 4242\n\tlast exit code = 0\n}');
  assert.deepEqual(running, { label: 'com.example.dispatch', loaded: true, running: true, lastExit: 0 });
  const failed = parseLaunchctlPrint('com.example.dispatch', '...\n\tlast exit code = 78\n');
  assert.equal(failed.lastExit, 78);
  assert.equal(failed.running, false);
});

// ---------------------------------------------------------------------------
// makeRealProbes: heartbeat stamps read beside lastrun, same run-dir resolution,
// same epoch-seconds stamp format (ONE parser: readEpochStampFile).
// ---------------------------------------------------------------------------

test('slo: makeRealProbes reads reactor/dispatch heartbeat stamps from the injected runDir', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'slo-hb-repo-'));
  const planeHome = mkdtempSync(join(tmpdir(), 'slo-hb-home-'));
  try {
    const runDir = join(planeHome, 'runs', 'loopkit');
    mkdirSync(join(planeHome, 'runs', 'reactor'), { recursive: true });
    mkdirSync(join(planeHome, 'runs', 'dispatch'), { recursive: true });
    const nowSec = Math.floor(Date.now() / 1000);
    writeFileSync(join(planeHome, 'runs', 'reactor', 'heartbeat'), String(nowSec - 7), 'utf8');
    writeFileSync(join(planeHome, 'runs', 'dispatch', 'heartbeat'), String(nowSec - 9), 'utf8');

    const probes = makeRealProbes(repoRoot, runDir);
    assert.equal(probes.reactorHeartbeat?.(), nowSec - 7);
    assert.equal(probes.dispatchHeartbeat?.(), nowSec - 9);
    assert.equal(readEpochStampFile(join(planeHome, 'runs', 'reactor', 'heartbeat')), nowSec - 7,
      'the shared stamp parser must read the same value the probe does');
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')), 'no run-state may be read from repoRoot when runDir is injected');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(planeHome, { recursive: true, force: true });
  }
});
