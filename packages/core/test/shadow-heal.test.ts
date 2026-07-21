/**
 * shadow-heal.test.ts — Shadow mode for the self-heal ladder.
 *
 * Covers:
 *   resolveHealMode — pure resolver: absent/undefined mode → 'armed', explicit 'shadow' → 'shadow'
 *   config validation — healRules bad shapes throw (mergeHealRules via loadConfig)
 *   shadow mode emits heal.shadowed and takes NO action, even under opsAutonomy: 'heal'
 *     (no spawn call, no heal.proposed/heal.executed/heal.escalated, no notify)
 *   armed (default) mode is unaffected — existing propose/execute ladder still runs
 *   graduation counter tracks shadowDays separately from cleanDays
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { loadAllEvents } from '../src/ledger.js';
import { evaluateSloBoard, SloProbes } from '../src/slo.js';
import { runReactor } from '../src/beats/reactor.js';
import { LoopkitConfig, CONFIG_DEFAULTS, loadConfig } from '../src/config.js';
import { resolveHealMode } from '../src/runbooks.js';

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

function makeFreshProbes(nowMs: number = Date.now()): SloProbes {
  return {
    now: () => nowMs,
    reactorLastrun: () => Math.floor(nowMs / 1000) - 10,
    dispatchLastrun: () => Math.floor(nowMs / 1000) - 30,
    launchd: () => undefined,
    backup: () => 2,
    watchNightly: () => nowMs - 1 * 3600 * 1000,
    watchHourly: () => nowMs - 0.5 * 3600 * 1000,
    deploy: () => ({ behindCount: 0 }),
    fold: () => ({ unrouted: { count: 0 }, acceptanceCount: 0, decisionCount: 0 }),
  };
}

// ---------------------------------------------------------------------------
// resolveHealMode — pure resolver
// ---------------------------------------------------------------------------

test('resolveHealMode: absent key defaults to armed', () => {
  assert.equal(resolveHealMode('backup', undefined), 'armed');
  assert.equal(resolveHealMode('backup', {}), 'armed');
});

test('resolveHealMode: mode omitted on a present key defaults to armed', () => {
  assert.equal(resolveHealMode('backup', { backup: {} }), 'armed');
});

test('resolveHealMode: explicit shadow/armed round-trip', () => {
  assert.equal(resolveHealMode('backup', { backup: { mode: 'shadow' } }), 'shadow');
  assert.equal(resolveHealMode('backup', { backup: { mode: 'armed' } }), 'armed');
  // Unrelated key in the map is unaffected
  assert.equal(resolveHealMode('launchd', { backup: { mode: 'shadow' } }), 'armed');
});

// ---------------------------------------------------------------------------
// config validation
// ---------------------------------------------------------------------------

test('config: healRules bad shapes throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'healrules-cfg-'));
  try {
    writeFileSync(join(dir, 'loopkit.config.json'), JSON.stringify({ healRules: 'nope' }));
    assert.throws(() => loadConfig(dir), /healRules must be an object/);
  } finally {
    cleanDir(dir);
  }
});

test('config: healRules.<key>.mode bad value throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'healrules-cfg2-'));
  try {
    writeFileSync(join(dir, 'loopkit.config.json'), JSON.stringify({ healRules: { backup: { mode: 'nope' } } }));
    assert.throws(() => loadConfig(dir), /healRules\.backup\.mode must be 'shadow' or 'armed'/);
  } finally {
    cleanDir(dir);
  }
});

test('config: healRules valid shape loads and resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'healrules-cfg3-'));
  try {
    writeFileSync(join(dir, 'loopkit.config.json'), JSON.stringify({ healRules: { backup: { mode: 'shadow' } } }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.healRules?.['backup']?.mode, 'shadow');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// shadow mode: no action taken, heal.shadowed recorded, even under opsAutonomy: 'heal'
// ---------------------------------------------------------------------------

test('slo: shadow-mode rule emits heal.shadowed and takes no action, even in heal mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-shadow-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    // Breach the framework-generic loop-dispatch key (auto-heal runbook): dispatch lastrun
    // 700s ago > 600s threshold.
    const probes = makeFreshProbes(nowMs);
    probes.dispatchLastrun = () => Math.floor(nowMs / 1000) - 700;

    let spawnCalled = false;
    let notifyCalled = false;

    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'heal', // would normally execute loop-dispatch's auto-heal runbook
      provider: null,
      config: makeTestConfig({
        loops: { dispatchLabel: 'com.example.dispatch' },
        healRules: { 'loop-dispatch': { mode: 'shadow' } },
      }),
      sloProbes: probes,
      runbookSpawn: (_cmd, _args) => {
        spawnCalled = true;
        return { ok: true, output: '' };
      },
      notify: () => {
        notifyCalled = true;
      },
    });

    const events = await loadAllEvents(ledgerDir);
    const shadowed = events.filter(e =>
      e.type === 'heal.shadowed' && (e.data as { key?: string }).key === 'loop-dispatch',
    );
    assert.equal(shadowed.length, 1, 'exactly one heal.shadowed for the breached shadow-mode key');
    const data = shadowed[0]!.data as { key: string; action: string; wouldHave: string };
    assert.equal(data.wouldHave, 'auto-heal', 'wouldHave carries the runbook tier');
    assert.ok(data.action.length > 0);

    const proposed = events.filter(e => e.type === 'heal.proposed' && (e.data as { key?: string }).key === 'loop-dispatch');
    const executed = events.filter(e => e.type === 'heal.executed' && (e.data as { key?: string }).key === 'loop-dispatch');
    const escalated = events.filter(e => e.type === 'heal.escalated' && (e.data as { key?: string }).key === 'loop-dispatch');
    assert.equal(proposed.length, 0, 'shadow mode must not also propose');
    assert.equal(executed.length, 0, 'shadow mode must not execute');
    assert.equal(escalated.length, 0, 'shadow mode must not escalate');
    assert.equal(spawnCalled, false, 'shadow mode must never invoke the runbook spawn');
    assert.equal(notifyCalled, false, 'shadow mode must never notify');
  } finally {
    cleanDir(dir);
  }
});

test('slo: armed (default, no healRules entry) is unaffected — heal mode still executes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slo-armed-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    const probes = makeFreshProbes(nowMs);
    probes.dispatchLastrun = () => Math.floor(nowMs / 1000) - 700;

    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      opsAutonomy: 'heal',
      provider: null,
      config: makeTestConfig({ loops: { dispatchLabel: 'com.example.dispatch' } }), // no healRules block at all
      sloProbes: probes,
      runbookSpawn: (_cmd, _args) => ({ ok: true, output: 'ok' }),
    });

    const events = await loadAllEvents(ledgerDir);
    const executed = events.filter(e => e.type === 'heal.executed' && (e.data as { key?: string }).key === 'loop-dispatch');
    const shadowed = events.filter(e => e.type === 'heal.shadowed' && (e.data as { key?: string }).key === 'loop-dispatch');
    assert.ok(executed.length >= 1, 'armed default must still execute in heal mode');
    assert.equal(shadowed.length, 0, 'armed key must never emit heal.shadowed');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// graduation counter: shadowDays tracked separately from cleanDays
// ---------------------------------------------------------------------------

test('slo: graduation counter tracks shadowDays separately from cleanDays', () => {
  const dayIso = (n: number): string => `2026-07-${String(n).padStart(2, '0')}T10:00:00.000Z`;
  const opsEvents: LedgerEvent[] = [
    makeEvent('reactor', 'system', 'heal.shadowed', { key: 'backup', action: 'kickstart', wouldHave: 'auto-heal' }, dayIso(1)),
    makeEvent('reactor', 'system', 'heal.shadowed', { key: 'backup', action: 'kickstart', wouldHave: 'auto-heal' }, dayIso(2)),
  ];

  const board = evaluateSloBoard(
    { reactorFreshSec: 300, dispatchFreshSec: 600, atRiskFraction: 0.8, backupMaxHours: 26 },
    { now: () => new Date(dayIso(3)).getTime(), backup: () => 2 },
    opsEvents,
  );
  const backupRow = board.find(r => r.key === 'backup');
  assert.ok(backupRow?.graduation, 'backup row must carry graduation info');
  assert.equal(backupRow!.graduation!.shadowDays, 2, 'two distinct shadow days counted');
  assert.equal(backupRow!.graduation!.cleanDays, 0, 'shadow days must not count as cleanDays (no heal.proposed)');
});
