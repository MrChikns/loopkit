/**
 * runbooks.test.ts — loop-reactor / loop-dispatch watchdog runbooks: wedged-lock
 * resolution must follow the resolved plane-home run root (ctx.runDir), not repoRoot,
 * mirroring the beats' opts.runDir contract (beats/reactor.ts, beats/dispatch.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRunbook, RunbookContext } from '../src/runbooks.js';
import { runReactor } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { SloProbes } from '../src/slo.js';

function cleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
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

test('runbooks: loop-reactor clears a wedged lock under ctx.runDir, not repoRoot (plane-home mode)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-repo-'));
  const planeHome = mkdtempSync(join(tmpdir(), 'runbooks-home-'));
  try {
    const runDir = join(planeHome, 'runs', 'loopkit');
    mkdirSync(runDir, { recursive: true });
    const lockPath = join(runDir, 'reactor.lock');
    writeFileSync(lockPath, '', 'utf8');
    // Older than the 20-minute wedge threshold.
    const old = new Date(Date.now() - 25 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const ctx: RunbookContext = {
      repoRoot,
      runDir,
      key: 'loop-reactor',
      reactorLabel: 'com.example.reactor',
      spawn: (cmd, args) => {
        assert.equal(cmd, 'launchctl');
        assert.deepEqual(args.slice(0, 2), ['kickstart', '-k']);
        return { ok: true, output: 'kickstarted' };
      },
    };

    const evidence = await getRunbook('loop-reactor')!.execute!(ctx);
    assert.ok(evidence.includes('wedged lock cleared'), evidence);
    assert.ok(!existsSync(lockPath), 'the wedged lock under runDir must be removed');
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')), 'no run-state may be read from/written to repoRoot/.ai/runs when runDir is injected');
  } finally {
    cleanDir(repoRoot);
    cleanDir(planeHome);
  }
});

test('runbooks: loop-dispatch clears a wedged lock under ctx.runDir, not repoRoot (plane-home mode)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-repo-'));
  const planeHome = mkdtempSync(join(tmpdir(), 'runbooks-home-'));
  try {
    const runDir = join(planeHome, 'runs', 'loopkit');
    mkdirSync(runDir, { recursive: true });
    const lockPath = join(runDir, 'dispatch.lock');
    writeFileSync(lockPath, '', 'utf8');
    // Older than the 55-minute wedge threshold.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const ctx: RunbookContext = {
      repoRoot,
      runDir,
      key: 'loop-dispatch',
      dispatchLabel: 'com.example.dispatch',
      spawn: () => ({ ok: true, output: 'kickstarted' }),
    };

    const evidence = await getRunbook('loop-dispatch')!.execute!(ctx);
    assert.ok(evidence.includes('wedged lock cleared'), evidence);
    assert.ok(!existsSync(lockPath), 'the wedged lock under runDir must be removed');
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')), 'no run-state may be read from/written to repoRoot/.ai/runs when runDir is injected');
  } finally {
    cleanDir(repoRoot);
    cleanDir(planeHome);
  }
});

test('runbooks: loop-reactor falls back to the embedded repoRoot lock path when ctx.runDir is omitted (back-compat)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-embedded-'));
  try {
    const embeddedRunDir = join(repoRoot, '.ai', 'runs', 'loopkit');
    mkdirSync(embeddedRunDir, { recursive: true });
    const lockPath = join(embeddedRunDir, 'reactor.lock');
    writeFileSync(lockPath, '', 'utf8');
    const old = new Date(Date.now() - 25 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const ctx: RunbookContext = {
      repoRoot,
      key: 'loop-reactor',
      reactorLabel: 'com.example.reactor',
      spawn: () => ({ ok: true, output: 'kickstarted' }),
    };

    const evidence = await getRunbook('loop-reactor')!.execute!(ctx);
    assert.ok(evidence.includes('wedged lock cleared'), evidence);
    assert.ok(!existsSync(lockPath), 'the embedded-mode lock must still be cleared when runDir is unset');
  } finally {
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: runReactor's stepHeal must thread opts.runDir into the RunbookContext it
// builds (reactor.ts), not just runbooks.ts's own default — this is the actual wiring
// site the plane-home fix touches.
// ---------------------------------------------------------------------------

test('runbooks: runReactor executes the loop-dispatch watchdog and clears its wedged lock under opts.runDir (plane-home mode)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-e2e-repo-'));
  const planeHome = mkdtempSync(join(tmpdir(), 'runbooks-e2e-home-'));
  try {
    const ledgerDir = join(planeHome, 'ledger');
    const runDir = join(planeHome, 'runs', 'loopkit');
    mkdirSync(runDir, { recursive: true });

    const lockPath = join(runDir, 'dispatch.lock');
    writeFileSync(lockPath, '', 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000); // > 55-min wedge threshold
    utimesSync(lockPath, old, old);

    const nowMs = Date.now();
    const probes = makeFreshProbes(nowMs);
    probes.dispatchLastrun = () => Math.floor(nowMs / 1000) - 700; // stale → breaches loop-dispatch

    await runReactor({
      repoRoot,
      ledgerDir,
      runDir,
      autonomy: 'on',
      opsAutonomy: 'heal',
      provider: null,
      config: makeTestConfig({ loops: { dispatchLabel: 'com.example.dispatch' } }),
      sloProbes: probes,
      runbookSpawn: () => ({ ok: true, output: 'kickstarted' }),
    });

    assert.ok(!existsSync(lockPath), 'the wedged dispatch.lock under opts.runDir must be cleared by the executed runbook');
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')), 'no run-state may land under repoRoot/.ai/runs when opts.runDir is set');
  } finally {
    cleanDir(repoRoot);
    cleanDir(planeHome);
  }
});

// ---------------------------------------------------------------------------
// Liveness gate: before ANY lock-clear/kickstart heal action, the lock's owner pid must
// be provably dead — a wedge-age threshold alone once kickstart-killed a live multi-item
// beat. Reuses beatLockOwnerAlive (the lock-reclaim acquire predicate): one parser.
// ---------------------------------------------------------------------------

import { spawnSync as runbooksSpawnSync } from 'node:child_process';

/** A pid that provably belonged to an already-exited process. */
function exitedPid(): number {
  const r = runbooksSpawnSync('true', { stdio: 'pipe' });
  assert.ok(r.pid && r.pid > 0);
  return r.pid;
}

function makeLockDir(runDir: string, name: string, pid: number | undefined, ageMs: number): string {
  const lockPath = join(runDir, name);
  mkdirSync(lockPath, { recursive: true });
  if (pid !== undefined) writeFileSync(join(lockPath, 'pid'), String(pid), 'utf8');
  const old = new Date(Date.now() - ageMs);
  utimesSync(lockPath, old, old);
  return lockPath;
}

test('runbooks: loop-dispatch never heals a lock owned by a LIVE pid — reports in-flight, no kickstart, lock intact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-live-'));
  try {
    const runDir = join(repoRoot, 'runs', 'loopkit');
    // Lock far past every wedge threshold, but owned by THIS live test process.
    const lockPath = makeLockDir(runDir, 'dispatch.lock', process.pid, 5 * 60 * 60 * 1000);

    const spawned: string[][] = [];
    const ctx: RunbookContext = {
      repoRoot, runDir, key: 'loop-dispatch', dispatchLabel: 'com.example.dispatch',
      spawn: (_cmd, args) => { spawned.push(args); return { ok: true, output: '' }; },
    };
    const evidence = await getRunbook('loop-dispatch')!.execute!(ctx);
    assert.ok(/in flight|in-flight/i.test(evidence), evidence);
    assert.equal(spawned.length, 0, 'a live beat must never be kickstarted');
    assert.ok(existsSync(join(lockPath, 'pid')), 'the live lock must be left untouched');
  } finally {
    cleanDir(repoRoot);
  }
});

test('runbooks: loop-reactor never heals a lock owned by a LIVE pid', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-live-r-'));
  try {
    const runDir = join(repoRoot, 'runs', 'loopkit');
    const lockPath = makeLockDir(runDir, 'reactor.lock', process.pid, 2 * 60 * 60 * 1000);
    const spawned: string[][] = [];
    const ctx: RunbookContext = {
      repoRoot, runDir, key: 'loop-reactor', reactorLabel: 'com.example.reactor',
      spawn: (_cmd, args) => { spawned.push(args); return { ok: true, output: '' }; },
    };
    const evidence = await getRunbook('loop-reactor')!.execute!(ctx);
    assert.ok(/in flight|in-flight/i.test(evidence), evidence);
    assert.equal(spawned.length, 0);
    assert.ok(existsSync(lockPath));
  } finally {
    cleanDir(repoRoot);
  }
});

test('runbooks: loop-dispatch clears a dead-owner lock past the wedge and kickstarts', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-dead-'));
  try {
    const runDir = join(repoRoot, 'runs', 'loopkit');
    const lockPath = makeLockDir(runDir, 'dispatch.lock', exitedPid(), 60 * 60 * 1000); // > 55-min default
    const spawned: string[][] = [];
    const ctx: RunbookContext = {
      repoRoot, runDir, key: 'loop-dispatch', dispatchLabel: 'com.example.dispatch',
      spawn: (_cmd, args) => { spawned.push(args); return { ok: true, output: 'kickstarted' }; },
    };
    const evidence = await getRunbook('loop-dispatch')!.execute!(ctx);
    assert.ok(evidence.includes('wedged lock cleared'), evidence);
    assert.ok(!existsSync(lockPath), 'the dead wedged lock must be removed');
    assert.equal(spawned.length, 1);
  } finally {
    cleanDir(repoRoot);
  }
});

test('runbooks: loop-dispatch honors the work-shaped wedge threshold from ctx.dispatchWedgeMs', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-shaped-'));
  try {
    const runDir = join(repoRoot, 'runs', 'loopkit');
    // 80-min-old dead-owner lock: past the flat 55-min default, but INSIDE a
    // work-shaped 3-item × 40-min + 15-min window — must NOT be cleared.
    const lockPath = makeLockDir(runDir, 'dispatch.lock', exitedPid(), 80 * 60 * 1000);
    const ctx: RunbookContext = {
      repoRoot, runDir, key: 'loop-dispatch', dispatchLabel: 'com.example.dispatch',
      dispatchWedgeMs: (3 * 40 + 15) * 60 * 1000,
      spawn: () => ({ ok: true, output: 'kickstarted' }),
    };
    const evidence = await getRunbook('loop-dispatch')!.execute!(ctx);
    assert.ok(!evidence.includes('wedged lock cleared'), evidence);
    assert.ok(existsSync(lockPath), 'a lock younger than the work-shaped wedge must survive');
  } finally {
    cleanDir(repoRoot);
  }
});

test('runbooks: launchd runbook never kickstarts a beat label whose lock owner is alive', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runbooks-launchd-live-'));
  try {
    const runDir = join(repoRoot, 'runs', 'loopkit');
    makeLockDir(runDir, 'dispatch.lock', process.pid, 60 * 1000);
    const spawned: string[][] = [];
    const ctx: RunbookContext = {
      repoRoot, runDir, key: 'launchd',
      detail: 'com.example.dispatch',
      dispatchLabel: 'com.example.dispatch',
      spawn: (_cmd, args) => { spawned.push(args); return { ok: true, output: '' }; },
    };
    const evidence = await getRunbook('launchd')!.execute!(ctx);
    assert.ok(/in flight|in-flight/i.test(evidence), evidence);
    assert.equal(spawned.length, 0, 'kickstart -k against a live beat is exactly the incident this gate prevents');
  } finally {
    cleanDir(repoRoot);
  }
});
