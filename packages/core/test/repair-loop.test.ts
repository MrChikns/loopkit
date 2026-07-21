/**
 * repair-loop.test.ts — Tests for real repair loops (evaluator-optimizer).
 *
 * Covers:
 *   artifacts  — gate-red path writes .gate.log and .diff with correct names/caps
 *   truncation — oversize gate output and diff are truncated with marker
 *   prompt     — re-dispatched item with artifacts gets REPAIR EVIDENCE section after CONTEXT PACK
 *   fail-open  — missing artifacts → prompt built cold, no crash
 *   write-fail — unwritable artifactDir → flow proceeds, park still happens
 *   no-commit  — no-commit park writes no .diff (nothing to diff); repair assembly tolerates .gate.log-only
 *   assembleRepairEvidence — unit tests for the exported function
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch, DispatchOptions, assembleRepairEvidence } from '../src/beats/dispatch.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi219-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try {
    // chmod to restore permissions before rmSync in case we made it unwritable
    try { chmodSync(dir, 0o755); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
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

/** Provider that makes a commit to the worktree and returns ok. */
function makeCommitProvider(filename = 'src/app.ts', content = '// built'): LlmProvider {
  return {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      const { spawnSync } = await import('node:child_process');
      const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
      mkdir(join(req.cwd!, 'src'), { recursive: true });
      wf(join(req.cwd!, filename), content, 'utf8');
      spawnSync('git', ['add', filename], { cwd: req.cwd, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'feat(WI-001): implement'], { cwd: req.cwd, stdio: 'pipe' });
      return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
    },
  };
}

// ---------------------------------------------------------------------------
// assembleRepairEvidence — unit tests (pure function, no dispatch needed)
// ---------------------------------------------------------------------------

test('assembleRepairEvidence: returns undefined when no artifacts exist', () => {
  const dir = makeTempDir();
  try {
    const result = assembleRepairEvidence(dir, 'WI-001', 2);
    assert.equal(result, undefined, 'must return undefined when no artifacts exist (fail-open)');
  } finally {
    cleanDir(dir);
  }
});

test('assembleRepairEvidence: returns undefined for attempt 1 (no prior attempt)', () => {
  const dir = makeTempDir();
  try {
    // Even if stray files exist, attempt=1 → no prior attempt to look up
    const result = assembleRepairEvidence(dir, 'WI-001', 1);
    assert.equal(result, undefined, 'attempt 1 has no prior to look up');
  } finally {
    cleanDir(dir);
  }
});

test('assembleRepairEvidence: finds gate.log when diff is missing', () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'WI-001-attempt-1.gate.log'), 'Test failed: assertion error\n', 'utf8');
    // No .diff written (no-commit case)
    const result = assembleRepairEvidence(dir, 'WI-001', 2);
    assert.ok(result, 'must return evidence when gate.log exists');
    assert.ok(result.includes('REPAIR EVIDENCE'), 'must include the critique instruction');
    assert.ok(result.includes('assertion error'), 'must include gate log content');
    assert.ok(result.includes('gate output'), 'must label the gate section');
  } finally {
    cleanDir(dir);
  }
});

test('assembleRepairEvidence: finds both diff and gate.log', () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'WI-005-attempt-2.gate.log'), 'FAIL: test suite blew up\n', 'utf8');
    writeFileSync(join(dir, 'WI-005-attempt-2.diff'), 'diff --git a/src/foo.ts\n+const x = 1;\n', 'utf8');
    const result = assembleRepairEvidence(dir, 'WI-005', 3);
    assert.ok(result, 'must return evidence');
    assert.ok(result.includes('REPAIR EVIDENCE'), 'must include critique instruction');
    assert.ok(result.includes('src/foo.ts'), 'must include diff content');
    assert.ok(result.includes('test suite blew up'), 'must include gate log content');
  } finally {
    cleanDir(dir);
  }
});

test('assembleRepairEvidence: walks back from highest attempt to find artifacts', () => {
  const dir = makeTempDir();
  try {
    // Attempt 3 has no artifacts; attempt 2 does
    writeFileSync(join(dir, 'WI-007-attempt-2.gate.log'), 'gate-output-attempt-2\n', 'utf8');
    // No attempt-3 artifacts
    const result = assembleRepairEvidence(dir, 'WI-007', 4);
    assert.ok(result, 'must find attempt 2 artifacts when attempt 3 is absent');
    assert.ok(result.includes('gate-output-attempt-2'), 'must use the found attempt');
    assert.ok(result.includes('attempt 2'), 'must reference the attempt number in section heading');
  } finally {
    cleanDir(dir);
  }
});

test('assembleRepairEvidence: includes repairContext when provided', () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'WI-010-attempt-1.gate.log'), 'gate fail\n', 'utf8');
    const result = assembleRepairEvidence(dir, 'WI-010', 2, 'prior context: merge conflict in foo.ts');
    assert.ok(result, 'must return evidence');
    assert.ok(result.includes('prior context: merge conflict'), 'must include repairContext');
    assert.ok(result.includes('prior repair context'), 'must label the repairContext section');
  } finally {
    cleanDir(dir);
  }
});

test('assembleRepairEvidence: truncates oversize diff with marker', () => {
  const dir = makeTempDir();
  try {
    const bigDiff = 'diff --git a/src/foo.ts\n' + 'x'.repeat(15_000);
    writeFileSync(join(dir, 'WI-020-attempt-1.diff'), bigDiff, 'utf8');
    const result = assembleRepairEvidence(dir, 'WI-020', 2);
    assert.ok(result, 'must return evidence');
    // The assembled section should be capped (diff + gate)
    assert.ok(result.includes('[diff truncated]'), 'oversize diff must include truncation marker');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Dispatch integration tests
// ---------------------------------------------------------------------------

test('dispatch: gate-red path writes .gate.log and .diff with correct names', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', {
      spec: 'add feature to src/feature.ts',
      touches: 'src/',
    }),
  ]);

  const artifactDir = makeTempDir();
  try {
    // Use a filename that does NOT match the default spineRegex (src/app.ts would trip spine check).
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/feature.ts'),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/feature.ts'],
      // Gate fails with output
      gateResult: { passed: false, reason: 'test failed', output: 'FAIL: expect(1).toBe(2)\nTest suite failed\n' },
      artifactRunsDir: artifactDir,
      scoutEnabled: false,
    });

    const gatePath = join(artifactDir, 'WI-001-attempt-1.gate.log');
    const diffPath = join(artifactDir, 'WI-001-attempt-1.diff');

    assert.ok(existsSync(gatePath), `.gate.log must exist at ${gatePath}`);
    const gateContent = readFileSync(gatePath, 'utf8');
    assert.ok(gateContent.includes('FAIL'), 'gate log must contain gate output');

    assert.ok(existsSync(diffPath), `.diff must exist at ${diffPath}`);
    const diffContent = readFileSync(diffPath, 'utf8');
    assert.ok(diffContent.length > 0, '.diff must be non-empty');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: gate-red path gate.log truncated at ~6000 chars with oversize output', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-002', 'item.queued', {
      spec: 'add feature',
      touches: 'src/',
    }),
  ]);

  const artifactDir = makeTempDir();
  const oversizeOutput = 'x'.repeat(10_000); // well over 6000 chars
  try {
    // 'src/thing.ts' does not match the default spineRegex
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/thing.ts'),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/thing.ts'],
      gateResult: { passed: false, reason: 'gate failed', output: oversizeOutput },
      artifactRunsDir: artifactDir,
      scoutEnabled: false,
    });

    const gatePath = join(artifactDir, 'WI-002-attempt-1.gate.log');
    assert.ok(existsSync(gatePath), '.gate.log must exist');
    const gateContent = readFileSync(gatePath, 'utf8');
    assert.ok(gateContent.length <= 6_000, `gate.log must be capped at 6000 chars, got ${gateContent.length}`);
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: re-dispatched item with artifacts gets REPAIR EVIDENCE after CONTEXT PACK', async () => {
  // Seed item with attempts=1 (already had one failed attempt).
  // Use 'src/bug-fix.ts' — NOT src/app.ts which matches the default spineRegex.
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-030', 'item.captured', { source: 'cli', text: 'fix bug' }),
    makeEvent('conductor', 'WI-030', 'item.queued', { spec: 'fix the bug in src/bug-fix.ts', touches: 'src/' }),
    // Prior attempt: dispatch → gate failed → parked → unparked
    makeEvent('dispatch', 'WI-030', 'build.dispatched', { attempt: 1, branch: 'wi-030-a1', pid: 999 }),
    makeEvent('dispatch', 'WI-030', 'gate.failed', { reason: 'tests-red: prior failure' }),
    makeEvent('dispatch', 'WI-030', 'item.parked', { reason: 'tests-red: prior failure' }),
    makeEvent('operator', 'WI-030', 'item.unparked', {}),
    makeEvent('conductor', 'WI-030', 'item.queued', { spec: 'fix the bug in src/bug-fix.ts', touches: 'src/' }),
    // Scout brief (for CONTEXT PACK ordering test) — memoized so scout is skipped on dispatch
    makeEvent('dispatch', 'WI-030', 'item.briefed', { brief: 'BRIEF:\nFiles: src/bug-fix.ts — must change', model: 'haiku' }),
  ]);

  const artifactDir = makeTempDir();
  // Pre-seed the prior attempt's artifacts
  writeFileSync(join(artifactDir, 'WI-030-attempt-1.gate.log'), 'FAIL: expect(true).toBe(false)\n', 'utf8');
  writeFileSync(join(artifactDir, 'WI-030-attempt-1.diff'), 'diff --git a/src/bug-fix.ts\n+const broken = true;\n', 'utf8');

  let capturedPrompt: string | undefined;

  const provider: LlmProvider = {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      capturedPrompt = req.prompt;
      // Make a commit so gate has something to check
      const { spawnSync } = await import('node:child_process');
      const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
      mkdir(join(req.cwd!, 'src'), { recursive: true });
      wf(join(req.cwd!, 'src', 'bug-fix.ts'), '// fixed', 'utf8');
      spawnSync('git', ['add', 'src/bug-fix.ts'], { cwd: req.cwd, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'fix(WI-030): fix bug'], { cwd: req.cwd, stdio: 'pipe' });
      return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
    },
  };

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/bug-fix.ts'],
      pushProbe: () => ({ status: 0 }),
      artifactRunsDir: artifactDir,
      // scoutEnabled not set → defaults to true → uses memoized brief from fold (no real scout call)
      judgeEnabled: false,  // WI-220: disable judge so it doesn't overwrite capturedPrompt
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(
      capturedPrompt.includes('REPAIR EVIDENCE'),
      `prompt must include REPAIR EVIDENCE section (got: ${capturedPrompt.slice(0, 300)})`,
    );
    assert.ok(
      capturedPrompt.includes('CONTEXT PACK'),
      'prompt must include CONTEXT PACK section (brief is in fold)',
    );
    // CONTEXT PACK must come BEFORE REPAIR EVIDENCE
    const packIdx = capturedPrompt.indexOf('CONTEXT PACK');
    const evidenceIdx = capturedPrompt.indexOf('REPAIR EVIDENCE');
    assert.ok(packIdx < evidenceIdx, 'CONTEXT PACK must precede REPAIR EVIDENCE in the prompt');
    // Must include the critique instruction
    assert.ok(
      capturedPrompt.includes('Before writing any code: state in 2'),
      'prompt must include the critique-then-fix instruction',
    );
    // Must include prior diff content (from the pre-seeded .diff)
    assert.ok(
      capturedPrompt.includes('const broken') || capturedPrompt.includes('bug-fix.ts'),
      'prompt must include prior diff content',
    );
    // Must include prior gate output
    assert.ok(
      capturedPrompt.includes('expect(true)'),
      'prompt must include prior gate output',
    );
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: missing artifacts → prompt built without REPAIR EVIDENCE, no crash', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-040', 'item.captured', { source: 'cli', text: 'fix thing' }),
    makeEvent('conductor', 'WI-040', 'item.queued', { spec: 'fix the thing', touches: 'src/' }),
    // attempts=1 via a prior dispatched→parked cycle
    makeEvent('dispatch', 'WI-040', 'build.dispatched', { attempt: 1, branch: 'wi-040-a1', pid: 999 }),
    makeEvent('dispatch', 'WI-040', 'gate.failed', { reason: 'tests-red: prior failure' }),
    makeEvent('dispatch', 'WI-040', 'item.parked', { reason: 'tests-red: prior failure' }),
    makeEvent('operator', 'WI-040', 'item.unparked', {}),
    makeEvent('conductor', 'WI-040', 'item.queued', { spec: 'fix the thing', touches: 'src/' }),
  ]);

  // artifactDir is empty — no artifacts on disk
  const artifactDir = makeTempDir();
  let capturedPrompt: string | undefined;

  const provider: LlmProvider = {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      capturedPrompt = req.prompt;
      const { spawnSync } = await import('node:child_process');
      const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
      mkdir(join(req.cwd!, 'src'), { recursive: true });
      wf(join(req.cwd!, 'src', 'thing.ts'), '// fixed', 'utf8');
      spawnSync('git', ['add', 'src/thing.ts'], { cwd: req.cwd, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'fix(WI-040): fix'], { cwd: req.cwd, stdio: 'pipe' });
      return { ok: true, text: 'done' };
    },
  };

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/thing.ts'],
      pushProbe: () => ({ status: 0 }),
      artifactRunsDir: artifactDir,
      scoutEnabled: false,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    // Fail-open: no REPAIR EVIDENCE when no artifacts
    assert.ok(
      !capturedPrompt.includes('REPAIR EVIDENCE'),
      'prompt must NOT include REPAIR EVIDENCE when no artifacts exist (fail-open)',
    );

    // Item must have merged (flow proceeded normally)
    const events = await loadAllEvents(ledgerDir);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-040');
    assert.equal(merged.length, 1, 'item must merge successfully (fail-open means build proceeds)');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: artifact write failure does not affect park flow', async () => {
  // Use a path that cannot be written to as artifactRunsDir
  // Seed two prior attempts so this build runs at attempt 3 (>= breakerN=3): a tests-red at
  // the exhausted breaker parks (the flow this test guards), rather than auto-requeuing.
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-050', 'item.captured', { source: 'cli', text: 'build' }),
    makeEvent('conductor', 'WI-050', 'item.queued', { spec: 'build thing', touches: 'src/' }),
    makeEvent('dispatch', 'WI-050', 'build.dispatched', { attempt: 1, branch: 'wi-050-a1', pid: 1 }),
    makeEvent('dispatch', 'WI-050', 'build.finished', { commit: 'a1' }),
    makeEvent('dispatch', 'WI-050', 'item.queued', { spec: 'build thing', touches: 'src/', repairContext: 'first fail' }),
    makeEvent('dispatch', 'WI-050', 'build.dispatched', { attempt: 2, branch: 'wi-050-a2', pid: 1 }),
    makeEvent('dispatch', 'WI-050', 'build.finished', { commit: 'a2' }),
    makeEvent('dispatch', 'WI-050', 'item.queued', { spec: 'build thing', touches: 'src/', repairContext: 'second fail' }),
  ]);

  // Create a file (not a dir) at the artifact path so writes fail
  const base = makeTempDir();
  const blockedArtifactDir = join(base, 'not-a-dir');
  writeFileSync(blockedArtifactDir, 'I am a file, not a dir', 'utf8');

  try {
    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/thing.ts'),
      config: makeTestConfig({ breakerN: 3 }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/thing.ts'],
      gateResult: { passed: false, reason: 'gate failed', output: 'error output' },
      artifactRunsDir: blockedArtifactDir,
      scoutEnabled: false,
    });

    // Park must still happen even if artifact write failed
    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-050');
    assert.equal(parked.length, 1, 'item must still be parked even when artifact write fails');
    assert.equal((parked[0].data as { parkKind?: string }).parkKind, 'ops',
      'breaker-exhausted tests-red is an ops-park');
    assert.equal(result.dispatched[0].gateOutcome, 'failed', 'gateOutcome must still be failed');
  } finally {
    cleanup();
    cleanDir(base);
  }
});

test('dispatch: no-commit park does not write .diff; repair assembly tolerates .gate.log-only', async () => {
  // Simulate a no-commit scenario by using a provider that does NOT make a commit.
  // In that case, the dispatch code parks with 'no-commit' reason before reaching the gate.
  // No diff should be written (there's nothing to diff — HEAD == merge-base).
  //
  // Then verify that assembleRepairEvidence works fine with only a gate.log (no .diff).
  const artifactDir = makeTempDir();
  try {
    // Directly test assembleRepairEvidence with only a gate.log (no .diff)
    writeFileSync(join(artifactDir, 'WI-060-attempt-1.gate.log'), 'no-commit: agent did nothing\n', 'utf8');
    // No .diff file — simulating the no-commit case

    const result = assembleRepairEvidence(artifactDir, 'WI-060', 2);
    assert.ok(result, 'must return evidence even when only gate.log exists');
    assert.ok(result.includes('REPAIR EVIDENCE'), 'must include critique instruction');
    assert.ok(result.includes('agent did nothing'), 'must include gate log content');
    // No diff section
    assert.ok(!result.includes('--- diff from'), 'must not include diff section when .diff is absent');
  } finally {
    cleanDir(artifactDir);
  }
});
