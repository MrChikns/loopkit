/**
 * detached-dispatch.test.ts — ADR-008 phase A: detached dispatch staged behind a default-off
 * flag (`execution.detachedDispatch`), plus the unconditional cross-beat collection pass.
 *
 * Covers:
 *   a. flag-off equivalence (pinned) — byte-identical to today's sync-in-beat behaviour
 *   b. flag-on returns before completion — a detach-eligible build spawns detached, the beat
 *      returns without awaiting it, build.dispatched carries pgid (not pid)
 *   c. collection folds a GREEN exit file through the real terminal path (merge)
 *   d. collection folds a RED exit file through the existing crash/no-commit terminal path
 *   e. orphan (dead pgid, no exit file past grace) — already covered by doctor.test.ts
 *      ('doctor: a detached build with a dead pgid and NO exit file past the grace window
 *      orphans (requeue/park-breaker)' class); not duplicated here per the task's own note.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { loadAllEvents, appendEvents } from '../src/ledger.js';
import { runDispatch, collectDetachedBuilds } from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { writeExitFile, usageJsonPath } from '../src/exitfile.js';
import { manifestHash, readTargetManifest } from '../src/target.js';

// ---------------------------------------------------------------------------
// Test helpers (mirrors packages/core/test/scout-context.test.ts)
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi065-${process.pid}-${++testCount}-${Date.now()}`);
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
    ...overrides,
  };
}

/** Seeded dispatch setup with a real git repo in a temp dir. */
async function makeDispatchEnv(ledgerEvents: LedgerEvent[]): Promise<{
  repoRoot: string;
  ledgerDir: string;
  runsDir: string;
  cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const runsDir = join(base, 'runs');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

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
    runsDir,
    cleanup: () => cleanDir(base),
  };
}

// ---------------------------------------------------------------------------
// (a) Flag-off equivalence — pinned
// ---------------------------------------------------------------------------

test('detached-dispatch: flag OFF — build.dispatched carries pid (no pgid), item reaches terminal state within the beat', async () => {
  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-501', 'item.captured', { source: 'cli', text: 'add acme-web feature' }),
    makeEvent('conductor', 'WI-501', 'item.queued', { spec: 'add acme-web feature', touches: 'src/' }),
  ]);

  try {
    // Named 'claude-cli' deliberately — proves the flag (not the provider name) gates detach.
    const provider: LlmProvider = {
      name: 'claude-cli',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        assert.equal(req.detached, false, 'flag off must always request an ATTACHED spawn');
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'app.ts'), '// built', 'utf8');
        spawnSync('git', ['add', 'src/app.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-501): acme-web feature'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      provider,
      // execution.detachedDispatch left UNSET — loadConfig-equivalent default (false).
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/app.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    const events = await loadAllEvents(ledgerDir);
    const dispatched = events.find(e => e.type === 'build.dispatched' && e.item === 'WI-501');
    assert.ok(dispatched, 'build.dispatched must be emitted');
    const data = dispatched!.data as { pid?: number; pgid?: number };
    assert.equal(typeof data.pid, 'number', 'build.dispatched must carry pid');
    assert.equal(data.pgid, undefined, 'build.dispatched must NOT carry pgid when the flag is off');

    const merged = events.find(e => e.type === 'item.merged' && e.item === 'WI-501');
    assert.ok(merged, 'the item must reach a terminal state (merged) within this single beat');

    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-501')?.state, 'merged', 'fold must read the item as merged');
  } finally {
    cleanup();
  }
});

test('detached-dispatch: config default is detachedDispatch:false (loadConfig with no file)', () => {
  const cfg = loadConfig('/nonexistent-repo-root-for-config-default-check');
  assert.equal(cfg.execution?.detachedDispatch, false, 'default must be false — byte-for-byte today\'s behaviour');
});

// ---------------------------------------------------------------------------
// (b) Flag ON — detach-eligible build returns before completion
// ---------------------------------------------------------------------------

test('detached-dispatch: flag ON + eligible (single-item, claude-cli) — beat returns before completion; build.dispatched carries pgid, item stays building', async () => {
  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-502', 'item.captured', { source: 'cli', text: 'add acme-web widget' }),
    makeEvent('conductor', 'WI-502', 'item.queued', { spec: 'add acme-web widget', touches: 'src/' }),
  ]);

  try {
    const FAKE_PGID = 424242;
    let runInvoked = false;

    const provider: LlmProvider = {
      name: 'claude-cli',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        runInvoked = true;
        assert.equal(req.detached, true, 'an eligible build must request a DETACHED spawn');
        // onSpawn must fire synchronously (mirrors claudeCli.ts: before run() returns its
        // Promise to the caller) so the caller can record pgid immediately.
        req.onSpawn?.(FAKE_PGID);
        // Never resolves within the test's lifetime — proves the beat does not await it.
        return new Promise<ProviderResult>(() => { /* deliberately never resolves */ });
      },
    };

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ execution: { detachedDispatch: true } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(runInvoked, 'provider.run must have been called');
    assert.ok(
      result.dispatched.some(d => d.item === 'WI-502' && d.detail?.includes('not awaited')),
      'the step result must record the detached dispatch without an awaited outcome',
    );

    const events = await loadAllEvents(ledgerDir);
    const dispatched = events.find(e => e.type === 'build.dispatched' && e.item === 'WI-502');
    assert.ok(dispatched, 'build.dispatched must be emitted');
    const data = dispatched!.data as { pid?: number; pgid?: number };
    assert.equal(data.pgid, FAKE_PGID, 'build.dispatched must carry the spawned pgid');
    assert.equal(data.pid, undefined, 'build.dispatched must NOT carry pid on the detached path');

    // No terminal event yet — the build is still "in flight" from the ledger's point of view.
    const terminal = events.find(e => ['item.merged', 'gate.failed', 'build.crashed', 'item.parked'].includes(e.type) && e.item === 'WI-502');
    assert.equal(terminal, undefined, 'no terminal event must exist yet — the beat returned before completion');

    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-502')?.state, 'building', 'the item must still read as building after the beat returns');
    assert.equal(foldResult.items.get('WI-502')?.currentBuild?.pgid, FAKE_PGID, 'the fold must carry the pgid on currentBuild');
  } finally {
    cleanup();
  }
});

test('detached-dispatch (phase B): flag ON + a co-located batch (group.length > 1) DETACHES as one group — every member carries the SAME group pgid, the beat returns before completion', async () => {
  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-503', 'item.captured', { source: 'cli', text: 'acme-web part 1' }),
    makeEvent('conductor', 'WI-503', 'item.queued', { spec: 'acme-web part 1', touches: 'src/shared/' }),
    makeEvent('cli', 'WI-504', 'item.captured', { source: 'cli', text: 'acme-web part 2' }),
    makeEvent('conductor', 'WI-504', 'item.queued', { spec: 'acme-web part 2', touches: 'src/shared/' }),
  ]);

  try {
    const GROUP_PGID = 434343;
    let runCalls = 0;

    const provider: LlmProvider = {
      name: 'claude-cli',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        runCalls += 1;
        // Phase B: a co-located batch is ONE detached worker (group-level serialization stays;
        // only disjoint GROUPS run concurrently). The whole group shares one pgid via onSpawn.
        assert.equal(req.detached, true, 'phase B: a co-located batch on claude-cli must detach as a group');
        req.onSpawn?.(GROUP_PGID);
        // Never resolves — proves the beat does NOT await the group's completion.
        return new Promise<ProviderResult>(() => { /* deliberately never resolves */ });
      },
    };

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ execution: { detachedDispatch: true }, batchMaxItems: 2 }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/shared/both.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.equal(runCalls, 1, 'the co-located group must spawn exactly ONE worker (intra-group serialization)');
    assert.ok(
      result.dispatched.some(d => d.item === 'WI-503' && d.detail?.includes('not awaited')),
      'the carrier step result must record the detached dispatch without an awaited outcome',
    );

    const events = await loadAllEvents(ledgerDir);
    const dispatched = events.filter(e => e.type === 'build.dispatched');
    assert.equal(dispatched.length, 2, 'both co-located items must get a build.dispatched');
    for (const d of dispatched) {
      const data = d.data as { pid?: number; pgid?: number; branch?: string; worktree?: string };
      assert.equal(data.pgid, GROUP_PGID, 'every member of a detached batch carries the SAME group pgid');
      assert.equal(data.pid, undefined, 'a detached batch member must never carry pid');
    }
    // Both members share ONE worktree/branch — the group is a single worker.
    const [d1, d2] = dispatched.map(d => d.data as { branch?: string; worktree?: string });
    assert.equal(d1.branch, d2.branch, 'a co-located group shares one branch');
    assert.equal(d1.worktree, d2.worktree, 'a co-located group shares one worktree');

    // No terminal event — the beat returned before completion, so BOTH stay building.
    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-503')?.state, 'building', 'carrier still building after the beat returns');
    assert.equal(foldResult.items.get('WI-504')?.state, 'building', 'companion still building after the beat returns');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) Collection: a GREEN exit file drives the real terminal path (merge)
// ---------------------------------------------------------------------------

test('detached-dispatch: collection drains a GREEN exit file through the real gate → merge path', async () => {
  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-505', 'item.captured', { source: 'cli', text: 'acme-web collected feature' }),
    makeEvent('conductor', 'WI-505', 'item.queued', { spec: 'acme-web collected feature', touches: 'src/' }),
  ]);

  try {
    // Build the worktree + branch a "prior beat" would have created, with a real commit on it —
    // the collector's terminal path needs a real worktree/branch to gate/rebase/merge from.
    const { spawnSync } = await import('node:child_process');
    const branch = 'wi-505-a1';
    const wtPath = join(repoRoot, '..', `loopkit-wt-${branch}`);
    spawnSync('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], { cwd: repoRoot, stdio: 'pipe' });
    mkdirSync(join(wtPath, 'src'), { recursive: true });
    writeFileSync(join(wtPath, 'src', 'collected.ts'), '// built by a detached worker', 'utf8');
    spawnSync('git', ['add', 'src/collected.ts'], { cwd: wtPath, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'feat(WI-505): collected feature'], { cwd: wtPath, stdio: 'pipe' });

    const PGID = 555001;
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-505', 'build.dispatched', {
        attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli',
      }),
    ]);

    // Write a GREEN exit file + its usage json (mirrors claudeCli.ts's own write shape).
    const usagePath = usageJsonPath(runsDir, 'WI-505', 1);
    writeFileSync(usagePath, JSON.stringify({ result: 'done', usage: { input_tokens: 10, output_tokens: 5 } }), 'utf8');
    writeExitFile(runsDir, 'WI-505', 1, { exitCode: 0, usageJsonPath: usagePath });

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      // No provider run() should ever be invoked for the collected item — fail the test if it is.
      provider: { name: 'claude-cli', async run(): Promise<ProviderResult> {
        throw new Error('provider.run must not be called for a collected (already-finished) build');
      } },
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/collected.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(
      result.dispatched.some(d => d.item === 'WI-505' && d.gateOutcome === 'passed'),
      `expected WI-505 to gate-pass via collection (got: ${JSON.stringify(result.dispatched)})`,
    );

    const events = await loadAllEvents(ledgerDir);
    const merged = events.find(e => e.type === 'item.merged' && e.item === 'WI-505');
    assert.ok(merged, 'collection must drive the item through the real terminal path to merged');

    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-505')?.state, 'merged');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) Collection: a RED exit file drives the existing crash/no-commit terminal path
// ---------------------------------------------------------------------------

test('detached-dispatch: collection drains a RED exit file through the existing no-commit/crash path (never a merge)', async () => {
  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-506', 'item.captured', { source: 'cli', text: 'acme-web red feature' }),
    makeEvent('conductor', 'WI-506', 'item.queued', { spec: 'acme-web red feature', touches: 'src/' }),
  ]);

  try {
    // Worktree with NO commit past the branch point — the worker "failed" and produced nothing.
    const { spawnSync } = await import('node:child_process');
    const branch = 'wi-506-a1';
    const wtPath = join(repoRoot, '..', `loopkit-wt-${branch}`);
    spawnSync('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], { cwd: repoRoot, stdio: 'pipe' });

    const PGID = 555002;
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-506', 'build.dispatched', {
        attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli',
      }),
    ]);

    // RED exit file: non-zero exit code, no usage json.
    writeExitFile(runsDir, 'WI-506', 1, { exitCode: 1 });

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      provider: { name: 'claude-cli', async run(): Promise<ProviderResult> {
        throw new Error('provider.run must not be called for a collected (already-finished) build');
      } },
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(
      result.dispatched.some(d => d.item === 'WI-506' && d.gateOutcome === 'failed'),
      `expected WI-506 to fail via the no-commit terminal path (got: ${JSON.stringify(result.dispatched)})`,
    );

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.find(e => e.type === 'item.merged' && e.item === 'WI-506'), undefined, 'a red exit file must never merge');
    const noCommitOrCrash = events.find(e =>
      e.item === 'WI-506' && (e.type === 'gate.failed' || e.type === 'build.crashed'),
    );
    assert.ok(noCommitOrCrash, 'a red exit file must be driven through the existing crash/no-commit terminal path');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d2) Collection: an AUTH exit file routes through the SAME auth-handling path the
// in-process sync build already has (mark-unhealthy flag, requeue via build.crashed with the
// 'infra: builder not logged in' reason) — not the generic crash path (d) uses.
// ---------------------------------------------------------------------------

test('detached-dispatch: collection drains an AUTH exit file through the same auth-handling path as a sync build (never a generic crash)', async () => {
  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-513', 'item.captured', { source: 'cli', text: 'acme-web auth-failed feature' }),
    makeEvent('conductor', 'WI-513', 'item.queued', { spec: 'acme-web auth-failed feature', touches: 'src/' }),
  ]);

  try {
    // Worktree with no commit — the detached worker logged out before it could commit anything.
    const { spawnSync } = await import('node:child_process');
    const branch = 'wi-513-a1';
    const wtPath = join(repoRoot, '..', `loopkit-wt-${branch}`);
    spawnSync('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], { cwd: repoRoot, stdio: 'pipe' });

    const PGID = 555003;
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-513', 'build.dispatched', {
        attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli',
      }),
    ]);

    // AUTH exit file: claude-cli exits with is_error/auth text (claudeCli.ts's finishWithExit
    // sets authFailure:true whenever ProviderResult.code === 'auth' — this mirrors that write).
    writeExitFile(runsDir, 'WI-513', 1, { exitCode: 0, authFailure: true });

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      provider: { name: 'claude-cli', async run(): Promise<ProviderResult> {
        throw new Error('provider.run must not be called for a collected (already-finished) build');
      } },
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(
      result.dispatched.some(d => d.item === 'WI-513' && d.gateOutcome === 'failed' && d.detail?.includes('not logged in')),
      `expected WI-513 to fail via the auth-handling path (got: ${JSON.stringify(result.dispatched)})`,
    );

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.find(e => e.type === 'item.merged' && e.item === 'WI-513'), undefined, 'an auth-failed exit file must never merge');
    const crashed = events.find(e => e.item === 'WI-513' && e.type === 'build.crashed');
    assert.ok(crashed, 'an auth failure must route through build.crashed (requeue), same as the sync build path');
    const reason = (crashed!.data as { reason?: string }).reason;
    assert.ok(reason?.includes('infra: builder not logged in'), `reason must read as an auth failure, got: ${reason}`);

    // Same alert flag the sync build's mid-build auth branch and the pre-flight probe both set
    // (written under the plane's runDir, not the artifact dir the exit file itself lives in).
    assert.ok(
      existsSync(join(repoRoot, '.ai', 'runs', 'loopkit', 'dispatch-auth-failed')),
      'the auth-failed flag file must be written on the collected path too',
    );

    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-513')?.state, 'queued', 'build.crashed folds back to queued, never a no-commit park');
  } finally {
    cleanup();
  }
});

test('collectDetachedBuilds: authFailure:true decodes to a resolved ProviderResult with code "auth" (not a generic error)', async () => {
  const branch = 'wi-514-a1';
  const wtPath = '/tmp/loopkit-wt-514';
  const PGID = 777003;
  const { ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-514', 'item.captured', { source: 'cli', text: 'auth-failed solo' }),
    makeEvent('conductor', 'WI-514', 'item.queued', { spec: 'auth-failed solo', touches: 'src/' }),
    makeEvent('dispatch', 'WI-514', 'build.dispatched', { attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli' }),
  ]);

  try {
    writeExitFile(runsDir, 'WI-514', 1, { exitCode: 0, authFailure: true });

    const foldResult = fold(await loadAllEvents(ledgerDir));
    const collected = collectDetachedBuilds(foldResult, runsDir);
    assert.equal(collected.length, 1);
    const pr = await collected[0]!.providerPromise!;
    assert.equal(pr.ok, false, 'an auth-failed exit file must never decode as ok, even with exitCode 0');
    assert.equal(pr.code, 'auth', 'the reconstructed ProviderResult must carry code "auth" for the terminal loop to route on');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unit coverage of collectDetachedBuilds itself (pure function, no dispatch beat)
// ---------------------------------------------------------------------------

test('collectDetachedBuilds: ignores a legacy pid-only build (no pgid) — never collected here', async () => {
  const { ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-507', 'item.captured', { source: 'cli', text: 'legacy sync build' }),
    makeEvent('conductor', 'WI-507', 'item.queued', { spec: 'legacy sync build', touches: 'src/' }),
    makeEvent('dispatch', 'WI-507', 'build.dispatched', { attempt: 1, worktree: '/tmp/wt', branch: 'wi-507-a1', pid: 12345 }),
  ]);

  try {
    // Even if an exit file happened to exist (it shouldn't for a legacy sync build), pgid==null
    // must short-circuit before ever reading it.
    writeExitFile(runsDir, 'WI-507', 1, { exitCode: 0 });
    const events = await loadAllEvents(ledgerDir);
    const foldResult = fold(events);
    const collected = collectDetachedBuilds(foldResult, runsDir);
    assert.equal(collected.length, 0, 'a legacy pid-only build must never be collected');
  } finally {
    cleanup();
  }
});

test('collectDetachedBuilds: a pgid-bearing build with NO exit file yet is deferred (not collected)', async () => {
  const { ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-508', 'item.captured', { source: 'cli', text: 'still running' }),
    makeEvent('conductor', 'WI-508', 'item.queued', { spec: 'still running', touches: 'src/' }),
    makeEvent('dispatch', 'WI-508', 'build.dispatched', { attempt: 1, worktree: '/tmp/wt', branch: 'wi-508-a1', pgid: 999 }),
  ]);

  try {
    const events = await loadAllEvents(ledgerDir);
    const foldResult = fold(events);
    const collected = collectDetachedBuilds(foldResult, runsDir);
    assert.equal(collected.length, 0, 'no exit file yet must defer collection, not fabricate a result');
  } finally {
    cleanup();
  }
});

test('collectDetachedBuilds (phase B): a multi-item detached group collapses to ONE worker — carrier first, companion after, from the carrier exit file alone', async () => {
  const branch = 'wi-509-a1';
  const wtPath = '/tmp/loopkit-wt-509';
  const PGID = 777001;
  const { ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-509', 'item.captured', { source: 'cli', text: 'carrier' }),
    makeEvent('conductor', 'WI-509', 'item.queued', { spec: 'carrier', touches: 'src/shared/' }),
    makeEvent('cli', 'WI-510', 'item.captured', { source: 'cli', text: 'companion' }),
    makeEvent('conductor', 'WI-510', 'item.queued', { spec: 'companion', touches: 'src/shared/' }),
    // Both dispatched detached into the SAME worktree/branch/pgid (a co-located batch, phase B).
    makeEvent('dispatch', 'WI-509', 'build.dispatched', { attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli' }),
    makeEvent('dispatch', 'WI-510', 'build.dispatched', { attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli' }),
  ]);

  try {
    // Only the CARRIER (WI-509 — the id the exit file is written under) has an exit file; the
    // companion never gets one. Collection must still reconstruct the WHOLE group from it.
    const usagePath = usageJsonPath(runsDir, 'WI-509', 1);
    writeFileSync(usagePath, JSON.stringify({ result: 'done', usage: { input_tokens: 4, output_tokens: 2 } }), 'utf8');
    writeExitFile(runsDir, 'WI-509', 1, { exitCode: 0, usageJsonPath: usagePath });

    const foldResult = fold(await loadAllEvents(ledgerDir));
    const collected = collectDetachedBuilds(foldResult, runsDir);
    assert.equal(collected.length, 1, 'the two co-located members must collapse to ONE reconstructed worker');
    const w = collected[0]!;
    assert.deepEqual(w.recs.map(r => r.id), ['WI-509', 'WI-510'], 'carrier first (names branch/merge), companion after');
    assert.equal(w.branch, branch);
    assert.equal(w.wtPath, wtPath);
    assert.equal(w.attempt, 1);
    const pr = await w.providerPromise!;
    assert.equal(pr.ok, true, 'a green carrier exit file decodes to a resolved OK provider result for the group');
  } finally {
    cleanup();
  }
});

test('collectDetachedBuilds (phase B): a multi-item group with NO carrier exit file yet defers the WHOLE group (a companion is never collected alone)', async () => {
  const branch = 'wi-511-a1';
  const wtPath = '/tmp/loopkit-wt-511';
  const PGID = 777002;
  const { ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-511', 'item.captured', { source: 'cli', text: 'carrier' }),
    makeEvent('conductor', 'WI-511', 'item.queued', { spec: 'carrier', touches: 'src/shared/' }),
    makeEvent('cli', 'WI-512', 'item.captured', { source: 'cli', text: 'companion' }),
    makeEvent('conductor', 'WI-512', 'item.queued', { spec: 'companion', touches: 'src/shared/' }),
    makeEvent('dispatch', 'WI-511', 'build.dispatched', { attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli' }),
    makeEvent('dispatch', 'WI-512', 'build.dispatched', { attempt: 1, worktree: wtPath, branch, pgid: PGID, provider: 'claude-cli' }),
  ]);

  try {
    // No exit file for the carrier (still running). The companion must NOT be collected on its
    // own — the whole group defers until the carrier's exit file appears.
    const foldResult = fold(await loadAllEvents(ledgerDir));
    const collected = collectDetachedBuilds(foldResult, runsDir);
    assert.equal(collected.length, 0, 'no carrier exit file → defer the whole group, never strand-collect a companion');
  } finally {
    cleanup();
  }
});

// Note (task item 4e): the ORPHAN case — a detached build whose pgid is dead with NO exit file
// past the collection-cycle grace — is already covered end-to-end by doctor.test.ts (the
// buildDetachedEvents helper + the grace-window assertions around DEFAULT_COLLECTION_CYCLE_MS,
// e.g. the dead-pgid-past-grace → orphan/requeue coverage near WI-408 in that file). Not
// duplicated here — doctor.ts owns the orphan predicate and its own test file already exercises
// it; this file's job is spawn + collection, not orphan detection.

// ---------------------------------------------------------------------------
// (f) Target lane (WI-079): a REGISTERED-TARGET item detaches too — the target lane got the same
// detach-eligibility + deferred pgid-bearing dispatch wiring the legacy lane has. Before this, the
// target lane always ran sync and only recorded a pid, so a targeted build never reached detach
// eligibility.
// ---------------------------------------------------------------------------

/** Build a minimal registered target repo on `main` with a trivial (always-green) manifest gate. */
async function makeTargetRepo(root: string): Promise<{ hash: string }> {
  const { spawnSync } = await import('node:child_process');
  const g = (args: string[]) => spawnSync('git', args, { cwd: root, stdio: 'pipe' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'loopkit.target.json'), JSON.stringify({
    name: 'acme', defaultBranch: 'main', gateCommand: 'exit 0', gateWorkdir: '.',
    deployCommand: '', worktreePrefix: 'loop-', touches: { conflictMode: 'prefix' },
    boundaries: { planePrefixes: [], surfacePrefixes: ['src/'], escalationPatterns: [] },
    buildTimeoutMinutes: 15,
  }), 'utf8');
  writeFileSync(join(root, 'src', 'seed.js'), '// seed\n', 'utf8');
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '-m', 'init acme target']);
  const manifest = readTargetManifest(root);
  return { hash: manifestHash(manifest) };
}

test('detached-dispatch (target lane, WI-079): flag ON + a registered-target single item on claude-cli — records a pgid and the beat returns before completion', async () => {
  // A sibling dir of the plane repo's base holds the target repo (runTargetLane creates the build
  // worktree as a sibling of the target repo, so its parent must be writable).
  const targetRoot = join(makeTempDir(), 'acme');
  const { hash } = await makeTargetRepo(targetRoot);

  const { repoRoot, ledgerDir, runsDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'acme', 'target.registered', {
      name: 'acme', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
    }),
    makeEvent('cli', 'WI-601', 'item.captured', { source: 'cli', text: 'add acme widget', target: 'acme' }),
    makeEvent('conductor', 'WI-601', 'item.queued', { spec: 'add acme widget', touches: 'src/' }),
  ]);

  try {
    const FAKE_PGID = 606060;
    let runInvoked = false;

    const provider: LlmProvider = {
      name: 'claude-cli',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        runInvoked = true;
        // The target-lane build must now request a DETACHED spawn under the flag, carry the exit-file
        // protocol, and the builder tools contract — same as the legacy lane.
        assert.equal(req.detached, true, 'an eligible target build must request a DETACHED spawn');
        assert.ok(req.exitFile?.itemId === 'WI-601', 'the detached target build must carry the exit-file protocol');
        assert.ok(req.tools?.includes('Edit') && req.tools?.includes('Write'), 'target-lane build must carry builder tools');
        // onSpawn fires synchronously (mirrors claudeCli.ts) so the caller records pgid immediately.
        req.onSpawn?.(FAKE_PGID);
        // Never resolves within the test's lifetime — proves the beat does not await it.
        return new Promise<ProviderResult>(() => { /* deliberately never resolves */ });
      },
    };

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      artifactRunsDir: runsDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ execution: { detachedDispatch: true } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(runInvoked, 'provider.run must have been called for the targeted build');
    assert.ok(
      result.dispatched.some(d => d.item === 'WI-601' && d.detail?.includes('not awaited')),
      `the target-lane step result must record the detached dispatch without an awaited outcome (got: ${JSON.stringify(result.dispatched)})`,
    );

    const events = await loadAllEvents(ledgerDir);
    const dispatched = events.find(e => e.type === 'build.dispatched' && e.item === 'WI-601');
    assert.ok(dispatched, 'build.dispatched must be emitted for the targeted item');
    const data = dispatched!.data as { pid?: number; pgid?: number };
    assert.equal(data.pgid, FAKE_PGID, 'the target-lane build.dispatched must carry the spawned pgid');
    assert.equal(data.pid, undefined, 'the target-lane build.dispatched must NOT carry pid on the detached path');

    // No terminal event yet — the beat returned before the build finished.
    const terminal = events.find(e => ['item.merged', 'gate.failed', 'build.crashed', 'item.parked'].includes(e.type) && e.item === 'WI-601');
    assert.equal(terminal, undefined, 'no terminal event must exist yet — the target-lane beat returned before completion');

    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-601')?.state, 'building', 'the targeted item must still read as building after the beat returns');
    assert.equal(foldResult.items.get('WI-601')?.currentBuild?.pgid, FAKE_PGID, 'the fold must carry the pgid on the targeted item currentBuild');
  } finally {
    cleanup();
    cleanDir(targetRoot);
  }
});
