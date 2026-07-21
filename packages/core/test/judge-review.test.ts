/**
 * judge-review.test.ts — Tests for advisory LLM-as-judge merge review.
 *
 * Covers:
 *   dispatch  — gate-green path appends review.verdict + cost.usage{loop:'judge'}
 *   dispatch  — merge outcome IDENTICAL with judge enabled vs disabled (same events except verdict/cost)
 *   dispatch  — judge provider failure → merge proceeds, no verdict event, one stderr line
 *   dispatch  — unparseable judge output → verdict event with verdict:'unparseable', merge proceeds
 *   parser    — happy path, clamped confidence, missing fields, case tolerance
 *   config    — mode validation rejects 'gate'; defaults applied
 *   fold      — stores judgeVerdict without state change
 *   verdicts  — accepted+pass agree / accepted+fail false-alarm / none-yet counting
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { parseJudgeOutput } from '../src/judge.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { projectVerdicts } from '../src/verdicts.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi220-${process.pid}-${++testCount}-${Date.now()}`);
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

/** Provider that makes a commit to the worktree and returns ok. */
function makeCommitProvider(filename = 'src/feature.ts', content = '// built'): LlmProvider {
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

const HAPPY_JUDGE_OUTPUT = `VERDICT: pass
CONFIDENCE: 0.9
SPEC_SATISFIED: yes
SCOPE_CREEP: none
TEST_THEATRE: none
REASONS:
- Added src/feature.ts exactly as specified
- Tests cover the new behavior`;

const FAIL_JUDGE_OUTPUT = `VERDICT: fail
CONFIDENCE: 0.75
SPEC_SATISFIED: partial
SCOPE_CREEP: minor
TEST_THEATRE: suspected
REASONS:
- diff adds extra code not in spec
- test merely echoes the implementation`;

// ---------------------------------------------------------------------------
// parseJudgeOutput — unit tests
// ---------------------------------------------------------------------------

test('parseJudgeOutput: happy path parses all fields', () => {
  const result = parseJudgeOutput(HAPPY_JUDGE_OUTPUT);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.specSatisfied, 'yes');
  assert.equal(result.scopeCreep, 'none');
  assert.equal(result.testTheatre, 'none');
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons[0]!.includes('src/feature.ts'));
});

test('parseJudgeOutput: fail verdict parsed correctly', () => {
  const result = parseJudgeOutput(FAIL_JUDGE_OUTPUT);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.confidence, 0.75);
  assert.equal(result.specSatisfied, 'partial');
  assert.equal(result.scopeCreep, 'minor');
  assert.equal(result.testTheatre, 'suspected');
  assert.equal(result.reasons.length, 2);
});

test('parseJudgeOutput: confidence clamped to [0, 1] when > 1', () => {
  const text = `VERDICT: pass\nCONFIDENCE: 1.5\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:\n- ok`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.confidence, 1.0, 'confidence must be clamped to 1.0');
});

test('parseJudgeOutput: confidence clamped to 0 when negative', () => {
  const text = `VERDICT: fail\nCONFIDENCE: -0.3\nSPEC_SATISFIED: no\nSCOPE_CREEP: major\nTEST_THEATRE: suspected\nREASONS:\n- bad`;
  const result = parseJudgeOutput(text);
  assert.equal(result.confidence, 0, 'negative confidence must be clamped to 0');
});

test('parseJudgeOutput: missing VERDICT → unparseable', () => {
  const text = `CONFIDENCE: 0.8\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:\n- ok`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'unparseable');
  assert.equal(result.confidence, 0);
  assert.ok(result.raw, 'must include raw output');
});

test('parseJudgeOutput: invalid VERDICT value → unparseable', () => {
  const text = `VERDICT: maybe\nCONFIDENCE: 0.5\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:\n- ok`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'unparseable');
});

test('parseJudgeOutput: missing CONFIDENCE → unparseable', () => {
  const text = `VERDICT: pass\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:\n- ok`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'unparseable', 'missing CONFIDENCE must make it unparseable');
});

test('parseJudgeOutput: non-numeric CONFIDENCE → unparseable', () => {
  const text = `VERDICT: pass\nCONFIDENCE: high\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:\n- ok`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'unparseable');
});

test('parseJudgeOutput: case-insensitive field matching', () => {
  const text = `verdict: PASS\nconfidence: 0.7\nspec_satisfied: YES\nscope_creep: NONE\ntest_theatre: NONE\nreasons:\n- looks good`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.confidence, 0.7);
  assert.equal(result.specSatisfied, 'yes');
  assert.equal(result.scopeCreep, 'none');
  assert.equal(result.testTheatre, 'none');
});

test('parseJudgeOutput: unknown optional field values → unknown defaults', () => {
  const text = `VERDICT: pass\nCONFIDENCE: 0.6\nSPEC_SATISFIED: maybe\nSCOPE_CREEP: some\nTEST_THEATRE: unclear\nREASONS:\n- ok`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.specSatisfied, 'unknown');
  assert.equal(result.scopeCreep, 'unknown');
  assert.equal(result.testTheatre, 'unknown');
});

test('parseJudgeOutput: up to 5 reasons extracted', () => {
  const text = `VERDICT: pass\nCONFIDENCE: 0.5\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:\n- r1\n- r2\n- r3\n- r4\n- r5\n- r6`;
  const result = parseJudgeOutput(text);
  assert.equal(result.reasons.length, 5, 'must extract at most 5 reasons');
});

test('parseJudgeOutput: empty REASONS block → empty array, not unparseable', () => {
  const text = `VERDICT: pass\nCONFIDENCE: 0.8\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\nREASONS:`;
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reasons.length, 0);
});

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

test('config: judge defaults applied when no judge block', () => {
  const repoRoot = makeTempDir();
  try {
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.judge?.enabled, true, 'default judge.enabled must be true');
    assert.equal(cfg.judge?.mode, 'advisory', 'default judge.mode must be advisory');
    assert.equal(cfg.judge?.model, 'sonnet', 'default judge.model must be sonnet');
    assert.equal(cfg.judge?.timeoutMs, 240_000, 'default judge.timeoutMs must be 240000');
    assert.equal(cfg.judge?.maxDiffChars, 20_000, 'default judge.maxDiffChars must be 20000');
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: judge.mode rejects non-advisory value', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ judge: { mode: 'gate' } }),
      'utf8',
    );
    assert.throws(
      () => loadConfig(repoRoot),
      /only 'advisory' is accepted/,
      'mode:gate must throw with calibration message',
    );
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: judge.enabled:false disables the block', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ judge: { enabled: false } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.judge?.enabled, false);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: judge.enabled bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ judge: { enabled: 'yes' } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /judge\.enabled must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: partial judge block merges with defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ judge: { model: 'opus', timeoutMs: 120_000 } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.judge?.enabled, true, 'default enabled');
    assert.equal(cfg.judge?.model, 'opus', 'overridden model');
    assert.equal(cfg.judge?.timeoutMs, 120_000, 'overridden timeout');
    assert.equal(cfg.judge?.maxDiffChars, 20_000, 'default maxDiffChars');
  } finally {
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Fold tests
// ---------------------------------------------------------------------------

test('fold: review.verdict stored as judgeVerdict without state change (queued)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'build X', touches: 'src/' }),
    makeEvent('dispatch', 'WI-001', 'review.verdict', {
      verdict: 'pass',
      confidence: 0.9,
      specSatisfied: 'yes',
      scopeCreep: 'none',
      testTheatre: 'none',
      reasons: ['looks good'],
      model: 'sonnet',
      judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
  ];
  const result = fold(events);
  const item = result.items.get('WI-001');
  assert.ok(item, 'item must exist');
  assert.equal(item.state, 'queued', 'state must remain queued — verdict is advisory');
  assert.ok(item.judgeVerdict, 'judgeVerdict must be stored');
  assert.equal(item.judgeVerdict.verdict, 'pass');
  assert.equal(item.judgeVerdict.confidence, 0.9);
});

test('fold: review.verdict stores latest (second wins) without state change', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-002', 'item.captured', { source: 'cli', text: 'fix Y' }),
    makeEvent('conductor', 'WI-002', 'item.queued', { spec: 'fix Y', touches: 'src/' }),
    makeEvent('dispatch', 'WI-002', 'review.verdict', {
      verdict: 'fail', confidence: 0.3, specSatisfied: 'partial',
      scopeCreep: 'minor', testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    makeEvent('dispatch', 'WI-002', 'review.verdict', {
      verdict: 'pass', confidence: 0.95, specSatisfied: 'yes',
      scopeCreep: 'none', testTheatre: 'none', reasons: ['fixed'], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
  ];
  const result = fold(events);
  const item = result.items.get('WI-002');
  assert.equal(item?.judgeVerdict?.verdict, 'pass', 'latest verdict must win');
  assert.equal(item?.judgeVerdict?.confidence, 0.95);
});

test('fold: review.verdict on merged item stored, state stays merged', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-003', 'item.captured', { source: 'cli', text: 'feat Z' }),
    makeEvent('conductor', 'WI-003', 'item.queued', { spec: 'feat Z', touches: 'src/' }),
    makeEvent('dispatch', 'WI-003', 'build.dispatched', { attempt: 1, pid: 1 }),
    makeEvent('dispatch', 'WI-003', 'item.merged', { commit: 'abc', deployed: false }),
    makeEvent('dispatch', 'WI-003', 'review.verdict', {
      verdict: 'fail', confidence: 0.6, specSatisfied: 'partial',
      scopeCreep: 'major', testTheatre: 'none', reasons: ['creep detected'], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
  ];
  const result = fold(events);
  const item = result.items.get('WI-003');
  assert.equal(item?.state, 'merged', 'state must stay merged');
  assert.ok(item?.judgeVerdict, 'judgeVerdict must be stored even on merged item');
  assert.equal(item?.judgeVerdict?.verdict, 'fail');
});

// ---------------------------------------------------------------------------
// Dispatch integration tests
// ---------------------------------------------------------------------------

test('dispatch: gate-green + judge enabled appends review.verdict + cost.usage{loop:judge}', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', {
      spec: 'add feature to src/feature.ts',
      touches: 'src/',
    }),
  ]);

  // Inject a successful judge result
  const judgeResults = new Map<string, { ok: boolean; text?: string; usage?: { in: number; out: number; usd?: number } }>();
  judgeResults.set('WI-001', {
    ok: true,
    text: HAPPY_JUDGE_OUTPUT,
    usage: { in: 50, out: 30, usd: 0.0005 },
  });

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/feature.ts'),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/feature.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: true,
      judgeResults: judgeResults as Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } } | null>,
    });

    const events = await loadAllEvents(ledgerDir);

    // review.verdict must be in the ledger
    const verdictEvents = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-001');
    assert.equal(verdictEvents.length, 1, 'must emit exactly one review.verdict');
    const vData = verdictEvents[0]!.data as { verdict: string; confidence: number; model: string; judge: string };
    assert.equal(vData.verdict, 'pass');
    assert.equal(vData.confidence, 0.9);
    assert.equal(vData.model, 'sonnet');
    assert.equal(vData.judge, 'merge-review');

    // cost.usage with loop:'judge' must be in the ledger
    const judgeCost = events.filter(e =>
      e.type === 'cost.usage' &&
      e.item === 'WI-001' &&
      (e.data as { loop: string }).loop === 'judge',
    );
    assert.equal(judgeCost.length, 1, 'must emit one cost.usage{loop:judge}');
    const costData = judgeCost[0]!.data as { loop: string; tokens: number; wi: string };
    assert.equal(costData.loop, 'judge');
    assert.equal(costData.wi, 'WI-001');
    assert.ok(costData.tokens > 0, 'tokens must be positive');

    // Item must still merge (judge is advisory)
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-001');
    assert.equal(merged.length, 1, 'item must merge despite judge verdict');
  } finally {
    cleanup();
  }
});

test('dispatch: merge outcome IDENTICAL with judge enabled vs disabled (same non-judge events)', async () => {
  // Run dispatch ENABLED
  const { repoRoot: r1, ledgerDir: l1, cleanup: c1 } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'add feature', touches: 'src/' }),
  ]);
  const judgeResults = new Map<string, { ok: boolean; text: string }>();
  judgeResults.set('WI-001', { ok: true, text: HAPPY_JUDGE_OUTPUT });
  await runDispatch({
    repoRoot: r1, ledgerDir: l1, autonomy: 'on',
    provider: makeCommitProvider('src/feature.ts'),
    config: makeTestConfig(), branchProbe: () => 'master',
    authProbeResult: { ok: true }, touchesDiffFiles: ['src/feature.ts'],
    pushProbe: () => ({ status: 0 }), scoutEnabled: false,
    judgeEnabled: true,
    judgeResults: judgeResults as Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } } | null>,
    dispatchSessionId: 'ses-aaaaaaaa',
  });
  const eventsEnabled = await loadAllEvents(l1);

  // Run dispatch DISABLED
  const { repoRoot: r2, ledgerDir: l2, cleanup: c2 } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'add feature', touches: 'src/' }),
  ]);
  await runDispatch({
    repoRoot: r2, ledgerDir: l2, autonomy: 'on',
    provider: makeCommitProvider('src/feature.ts'),
    config: makeTestConfig(), branchProbe: () => 'master',
    authProbeResult: { ok: true }, touchesDiffFiles: ['src/feature.ts'],
    pushProbe: () => ({ status: 0 }), scoutEnabled: false,
    judgeEnabled: false,
    dispatchSessionId: 'ses-aaaaaaaa',
  });
  const eventsDisabled = await loadAllEvents(l2);

  try {
    // Filter out judge-specific events
    const strip = (evs: LedgerEvent[]) =>
      evs.filter(e => e.type !== 'review.verdict' && e.type !== 'cost.usage');

    const enabledTypes = strip(eventsEnabled).map(e => `${e.type}:${e.item}`);
    const disabledTypes = strip(eventsDisabled).map(e => `${e.type}:${e.item}`);

    assert.deepEqual(
      enabledTypes,
      disabledTypes,
      'non-judge event sequence must be identical with judge enabled vs disabled',
    );

    // Enabled run must have extra judge events
    const judgeEvts = eventsEnabled.filter(e => e.type === 'review.verdict' || (e.type === 'cost.usage' && (e.data as { loop: string }).loop === 'judge'));
    assert.ok(judgeEvts.length > 0, 'enabled run must have judge-specific events');
  } finally {
    c1();
    c2();
  }
});

test('dispatch: judge provider failure → merge proceeds, records review.verdict:unavailable (no silent loss)', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'build' }),
    makeEvent('conductor', 'WI-010', 'item.queued', { spec: 'build thing', touches: 'src/' }),
  ]);

  // Inject a failing judge result
  const judgeResults = new Map<string, { ok: boolean; error: string }>();
  judgeResults.set('WI-010', { ok: false, error: 'judge provider timeout' });

  const stderrLines: string[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  // Capture stderr to verify the one-liner is written
  const stderrCapture = (chunk: string | Uint8Array) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    stderrLines.push(s);
    return origStderr(chunk as string);
  };
  process.stderr.write = stderrCapture as typeof process.stderr.write;

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/thing.ts'),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/thing.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: true,
      judgeResults: judgeResults as Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } } | null>,
    });

    const events = await loadAllEvents(ledgerDir);

    // TRUST-HARDENING (defect b): the evidence gap is NO LONGER silent — a review.verdict is
    // recorded with verdict:'unavailable' and the provider error carried in reason.
    const verdictEvents = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-010');
    assert.equal(verdictEvents.length, 1, 'a review.verdict:unavailable must be emitted on judge provider failure');
    const vData = verdictEvents[0]!.data as { verdict: string; confidence: number; reason?: string; judge: string };
    assert.equal(vData.verdict, 'unavailable', 'verdict must be unavailable on judge provider failure');
    assert.equal(vData.confidence, 0);
    assert.equal(vData.judge, 'merge-review');
    assert.ok((vData.reason ?? '').includes('judge provider timeout'), 'reason must carry the provider error');

    // Item must still merge (judge stays advisory — the merge is never blocked)
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-010');
    assert.equal(merged.length, 1, 'item must merge even when judge provider fails (judge is advisory)');

    // One stderr line about judge error
    const judgeLines = stderrLines.filter(l => l.includes('[dispatch] judge:') && l.includes('WI-010'));
    assert.ok(judgeLines.length >= 1, 'must emit one stderr line on judge provider failure');
  } finally {
    process.stderr.write = origStderr as typeof process.stderr.write;
    cleanup();
  }
});

test('dispatch: unparseable judge output → verdict event with verdict:unparseable, merge proceeds', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-020', 'item.captured', { source: 'cli', text: 'add widget' }),
    makeEvent('conductor', 'WI-020', 'item.queued', { spec: 'add widget', touches: 'src/' }),
  ]);

  const judgeResults = new Map<string, { ok: boolean; text: string }>();
  judgeResults.set('WI-020', { ok: true, text: 'Sorry I cannot judge this code.' });

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/widget.ts'),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/widget.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: true,
      judgeResults: judgeResults as Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } } | null>,
    });

    const events = await loadAllEvents(ledgerDir);

    // review.verdict must be emitted with verdict:'unparseable'
    const verdictEvents = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-020');
    assert.equal(verdictEvents.length, 1, 'must emit review.verdict even for unparseable output');
    const vData = verdictEvents[0]!.data as { verdict: string };
    assert.equal(vData.verdict, 'unparseable', 'verdict must be unparseable');

    // Item must still merge (fail-open)
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-020');
    assert.equal(merged.length, 1, 'item must merge even with unparseable judge output');
  } finally {
    cleanup();
  }
});

test('dispatch: judge disabled via judgeEnabled:false → no verdict event, merge proceeds', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-030', 'item.captured', { source: 'cli', text: 'task' }),
    makeEvent('conductor', 'WI-030', 'item.queued', { spec: 'task', touches: 'src/' }),
  ]);

  try {
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeCommitProvider('src/task.ts'),
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/task.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    const events = await loadAllEvents(ledgerDir);
    const verdictEvents = events.filter(e => e.type === 'review.verdict');
    assert.equal(verdictEvents.length, 0, 'no review.verdict when judge disabled');

    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-030');
    assert.equal(merged.length, 1, 'item must merge normally when judge is disabled');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// verdicts projection tests
// ---------------------------------------------------------------------------

test('verdicts: accepted+pass rows counted as agreePass', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-001', 'review.verdict', {
      verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    makeEvent('operator', 'WI-001', 'item.accepted', { by: 'operator' }),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.total, 1);
  assert.equal(summary.judgedFail, 0);
  assert.equal(summary.withOutcome, 1);
  assert.equal(summary.agreePass, 1, 'pass+accepted = agreement');
  assert.equal(summary.falseAlarm, 0);
  assert.equal(summary.rows[0]!.outcome, 'accepted');
  assert.equal(summary.rows[0]!.verdict, 'pass');
});

test('verdicts: accepted+fail counted as falseAlarm', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-002', 'review.verdict', {
      verdict: 'fail', confidence: 0.7, specSatisfied: 'partial', scopeCreep: 'minor',
      testTheatre: 'none', reasons: ['creep'], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    makeEvent('operator', 'WI-002', 'item.accepted', { by: 'operator' }),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.falseAlarm, 1, 'fail+accepted = false alarm');
  assert.equal(summary.agreePass, 0);
});

test('verdicts: no item.accepted → none-yet outcome', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-003', 'review.verdict', {
      verdict: 'pass', confidence: 0.8, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.total, 1);
  assert.equal(summary.withOutcome, 0, 'no accepted → no outcome');
  assert.equal(summary.rows[0]!.outcome, 'none-yet');
});

test('verdicts: empty ledger → zero totals', () => {
  const summary = projectVerdicts([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.judgedFail, 0);
  assert.equal(summary.withOutcome, 0);
  assert.equal(summary.rows.length, 0);
});

test('verdicts: latest review.verdict per item supersedes earlier ones', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-005', 'review.verdict', {
      verdict: 'fail', confidence: 0.4, specSatisfied: 'no', scopeCreep: 'major',
      testTheatre: 'suspected', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    // Later verdict overrides
    makeEvent('dispatch', 'WI-005', 'review.verdict', {
      verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: ['all good'], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    makeEvent('operator', 'WI-005', 'item.accepted', { by: 'operator' }),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.total, 1, 'one row per item (latest verdict)');
  assert.equal(summary.rows[0]!.verdict, 'pass', 'latest verdict must win');
  assert.equal(summary.agreePass, 1);
  assert.equal(summary.judgedFail, 0, 'fail count uses latest verdict only');
});

test('verdicts: multiple items with mixed outcomes', () => {
  const events: LedgerEvent[] = [
    // WI-001: pass + accepted → agree
    makeEvent('dispatch', 'WI-001', 'review.verdict', {
      verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    makeEvent('operator', 'WI-001', 'item.accepted', { by: 'operator' }),
    // WI-002: fail + accepted → false alarm
    makeEvent('dispatch', 'WI-002', 'review.verdict', {
      verdict: 'fail', confidence: 0.6, specSatisfied: 'partial', scopeCreep: 'minor',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
    makeEvent('operator', 'WI-002', 'item.accepted', { by: 'operator' }),
    // WI-003: pass + none-yet
    makeEvent('dispatch', 'WI-003', 'review.verdict', {
      verdict: 'pass', confidence: 0.7, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import("../src/schema.js").ReviewVerdictData),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.total, 3);
  assert.equal(summary.judgedFail, 1);
  assert.equal(summary.withOutcome, 2);
  assert.equal(summary.agreePass, 1);
  assert.equal(summary.falseAlarm, 1);
  // Rows sorted by WI id
  assert.equal(summary.rows[0]!.wi, 'WI-001');
  assert.equal(summary.rows[1]!.wi, 'WI-002');
  assert.equal(summary.rows[2]!.wi, 'WI-003');
  assert.equal(summary.rows[2]!.outcome, 'none-yet');
});
