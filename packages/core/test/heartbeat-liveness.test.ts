/**
 * heartbeat-liveness.test.ts — long-beat heartbeat + watchdog liveness gate.
 *
 * A beat writes lastrun only at beat START, so a beat legitimately draining many items
 * used to read as stale/dead — and the cross-beat watchdog / heal runbooks would
 * kickstart (kill) it mid-build. Covered here:
 *   1. writeBeatHeartbeat stamps `<runs>/<beat>/heartbeat` in the shared epoch format
 *   2. the dispatch planning lane refreshes the heartbeat between queue items
 *   3. runReactor refreshes the reactor heartbeat between steps
 *   4. crossBeatWatchdog never kickstarts when the reactor lock owner pid is ALIVE
 *   5. crossBeatWatchdog prefers a fresh heartbeat over a stale lastrun
 *   6. crossBeatWatchdog still kickstarts a genuinely dead reactor
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runDispatch, runPlanningLane, writeBeatHeartbeat, DispatchOptions } from '../src/beats/dispatch.js';
import { runReactor } from '../src/beats/reactor.js';
import { readEpochStampFile } from '../src/slo.js';
import { ItemRecord } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `heartbeat-test-${process.pid}-${++testCount}-${Date.now()}`);
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
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

function makeFakeProvider(text = 'QUEUED:\n\nREMAINING:\n'): LlmProvider {
  return {
    name: 'fake',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Stamp writer — shared format
// ---------------------------------------------------------------------------

test('heartbeat: writeBeatHeartbeat stamps epoch seconds beside the beat lastrun, readable by the ONE stamp parser', () => {
  const home = makeTempDir();
  try {
    const runDir = join(home, 'runs', 'loopkit');
    const before = Math.floor(Date.now() / 1000);
    writeBeatHeartbeat(runDir, 'dispatch');
    const stampPath = join(home, 'runs', 'dispatch', 'heartbeat');
    assert.ok(existsSync(stampPath));
    const stamp = readEpochStampFile(stampPath);
    assert.ok(stamp !== undefined && stamp >= before && stamp <= before + 5,
      `stamp must be current epoch seconds (got ${stamp})`);
  } finally {
    cleanDir(home);
  }
});

// ---------------------------------------------------------------------------
// 2. Dispatch build loop refreshes the heartbeat between queue items
// ---------------------------------------------------------------------------

test('heartbeat: the planning lane refreshes the dispatch heartbeat between queue items', async () => {
  const repoRoot = makeTempDir();
  const home = makeTempDir();
  try {
    const ledgerDir = join(home, 'ledger');
    const runDir = join(home, 'runs', 'loopkit');
    mkdirSync(ledgerDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const cfg = makeTestConfig();
    mkdirSync(join(repoRoot, cfg.promptsDir), { recursive: true });
    writeFileSync(join(repoRoot, cfg.promptsDir, 'planner.md'), 'Decompose.', 'utf8');

    const items = [
      { id: 'WI-101', state: 'queued', lane: 'planning', attempts: 0, builds: [], spec: 'split epic A' },
      { id: 'WI-102', state: 'queued', lane: 'planning', attempts: 0, builds: [], spec: 'split epic B' },
    ] as unknown as ItemRecord[];

    const opts: DispatchOptions = { repoRoot, ledgerDir, runDir, provider: makeFakeProvider() };
    const results = await runPlanningLane(opts, cfg, makeFakeProvider(), items, runDir);
    assert.equal(results.length, 2, 'both items must be processed serially');

    const stamp = readEpochStampFile(join(home, 'runs', 'dispatch', 'heartbeat'));
    assert.ok(stamp !== undefined, 'the build loop must refresh the heartbeat between items');
    assert.ok(Math.abs(Math.floor(Date.now() / 1000) - stamp) < 60, `heartbeat must be fresh (got ${stamp})`);
  } finally {
    cleanDir(repoRoot);
    cleanDir(home);
  }
});

// ---------------------------------------------------------------------------
// 3. Reactor step loop refreshes its heartbeat between steps
// ---------------------------------------------------------------------------

test('heartbeat: runReactor refreshes the reactor heartbeat between steps', async () => {
  const repoRoot = makeTempDir();
  const home = makeTempDir();
  try {
    const ledgerDir = join(home, 'ledger');
    const runDir = join(home, 'runs', 'loopkit');
    mkdirSync(ledgerDir, { recursive: true });

    await runReactor({
      repoRoot, ledgerDir, runDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
    });

    const stamp = readEpochStampFile(join(home, 'runs', 'reactor', 'heartbeat'));
    assert.ok(stamp !== undefined, 'the reactor step loop must stamp its heartbeat');
    assert.ok(Math.abs(Math.floor(Date.now() / 1000) - stamp) < 60);
  } finally {
    cleanDir(repoRoot);
    cleanDir(home);
  }
});

// ---------------------------------------------------------------------------
// 4-6. Cross-beat watchdog: liveness gate + heartbeat preference
// ---------------------------------------------------------------------------

interface WatchdogHarness {
  opts: DispatchOptions;
  spawned: string[][];
  home: string;
  repoRoot: string;
}

function makeWatchdogHarness(probeOverrides: Partial<DispatchOptions>): WatchdogHarness {
  const repoRoot = makeTempDir();
  const home = makeTempDir();
  const ledgerDir = join(home, 'ledger');
  const runDir = join(home, 'runs', 'loopkit');
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const spawned: string[][] = [];
  const opts: DispatchOptions = {
    repoRoot, ledgerDir, runDir,
    autonomy: 'on',
    provider: null,
    config: makeTestConfig({
      loops: { ...CONFIG_DEFAULTS.loops, reactorLabel: 'com.example.reactor' },
    }),
    watchdogSpawn: (_cmd, args) => { spawned.push(args); return { ok: true, output: 'kickstarted' }; },
    ...probeOverrides,
  };
  return { opts, spawned, home, repoRoot };
}

test('heartbeat: crossBeatWatchdog never kickstarts when the reactor lock owner pid is ALIVE', async () => {
  const staleSec = Math.floor(Date.now() / 1000) - 600; // lastrun 10 min stale (> 300 s threshold)
  const h = makeWatchdogHarness({
    reactorLastrunProbe: () => staleSec,
    reactorHeartbeatProbe: () => undefined,
    reactorLockAgeSec: () => 25 * 60, // past the 20-min reactor wedge — age alone says "heal"
  });
  try {
    const runDir = join(h.home, 'runs', 'loopkit');
    const lockPath = join(runDir, 'reactor.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(process.pid), 'utf8'); // LIVE owner

    const result = await runDispatch(h.opts);
    assert.equal(result.dispatched.length, 0);
    assert.equal(h.spawned.length, 0, 'a live-pid lock must never be kickstarted on age alone');
    assert.ok(existsSync(join(lockPath, 'pid')), 'the live lock must be left intact');
  } finally {
    cleanDir(h.repoRoot);
    cleanDir(h.home);
  }
});

test('heartbeat: crossBeatWatchdog prefers a fresh mid-beat heartbeat over the stale beat-start lastrun', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = makeWatchdogHarness({
    reactorLastrunProbe: () => nowSec - 45 * 60,  // beat started 45 min ago
    reactorHeartbeatProbe: () => nowSec - 30,     // still progressing 30 s ago
  });
  try {
    await runDispatch(h.opts);
    assert.equal(h.spawned.length, 0, 'a heartbeating beat is alive — no kickstart');
  } finally {
    cleanDir(h.repoRoot);
    cleanDir(h.home);
  }
});

test('heartbeat: crossBeatWatchdog still kickstarts a genuinely dead reactor (stale stamps, no lock)', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = makeWatchdogHarness({
    reactorLastrunProbe: () => nowSec - 45 * 60,
    reactorHeartbeatProbe: () => nowSec - 44 * 60,
    reactorLockAgeSec: () => undefined, // no lock — beat exited and never came back
  });
  try {
    await runDispatch(h.opts);
    assert.equal(h.spawned.length, 1, 'a dead beat must still be kickstarted');
    assert.deepEqual(h.spawned[0].slice(0, 2), ['kickstart', '-k']);
    assert.ok(h.spawned[0][2].endsWith('com.example.reactor'));
  } finally {
    cleanDir(h.repoRoot);
    cleanDir(h.home);
  }
});
