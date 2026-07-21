/**
 * acceptance-tiers.test.ts — Tests for tiered provisional acceptance
 * (acceptance.ts + reactor.ts stepProvisionalAccept).
 *
 * The reactor step no longer shells out to `git diff-tree` — it classifies straight from
 * the fold record's `rec.touches` (the item's declared/changed file set, set on item.queued).
 * These tests drive `touches` on the queued event rather than injecting a diffTreeProbe.
 *
 * Covers:
 *   eligibility — long-standing guards (operator silence, SLO health) plus the
 *     tier-driven window/skip logic (auto/optional/review windows, 'must' never accepts)
 *   cap — N eligible items → only perBeatCap accepted per beat
 *   fold — provisional item.accepted transitions merged→accepted + sets provisionalAccept flag
 *   verdicts — provisional accept → 'provisional' bucket, NOT in agreement cells
 *   approval — classifyPathsPlaneOnly helper unit tested (still used by the delegated-approval auto-approve path)
 *   config — acceptance.provisional + acceptance.tiers validation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { classifyPathsPlaneOnly } from '../src/approval.js';
import { projectVerdicts } from '../src/verdicts.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { SloRow } from '../src/slo.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-acceptance-tiers-${process.pid}-${++testCount}-${Date.now()}`);
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
    // Framework defaults ship no product plane/surface prefixes of their own — this suite's
    // fixtures use 'packages/engine/' (plane) and 'apps/example/src/features/' (review surface) as
    // example paths, so declare them explicitly.
    autoApprove: {
      ...CONFIG_DEFAULTS.autoApprove,
      planePrefixes: ['packages/engine/', '.ai/'],
    },
    acceptance: {
      ...CONFIG_DEFAULTS.acceptance!,
      tiers: {
        ...CONFIG_DEFAULTS.acceptance!.tiers!,
        surfacePrefixes: ['apps/example/src/public/', 'apps/example/src/features/'],
      },
    },
    ...overrides,
  };
}

/** SLO board with only the three health indicators, all met. */
function makeHealthyBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10s ago', target: '≤ 5m', status: 'met' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}

/** SLO board with the reactor row breached. */
function makeBreachedBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10m ago', target: '≤ 5m', status: 'breached' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}

const NOW_MS = Date.now();
// Windows under test (defaults): auto=2h, optional=48h, review=168h (7 days).
const AUTO_OLD_MS = NOW_MS - 3 * 3_600_000;       // 3h ago — past the 2h auto window
const AUTO_TOO_RECENT_MS = NOW_MS - 1 * 3_600_000; // 1h ago — below the 2h auto window
const OPTIONAL_OLD_MS = NOW_MS - 50 * 3_600_000;   // 50h ago — past the 48h optional window
const REVIEW_OLD_MS = NOW_MS - 200 * 3_600_000;    // 200h ago — past the 168h review window
const REVIEW_TOO_RECENT_MS = NOW_MS - 24 * 3_600_000; // 1 day ago — below the 168h review window

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/** Build a minimal repo + ledger with a merged item and run stepProvisionalAccept via runReactor. */
async function makeReactorEnv(ledgerEvents: LedgerEvent[]): Promise<{
  repoRoot: string;
  ledgerDir: string;
  cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'runs', 'reactor'), { recursive: true });
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

/** Run only the provisional-accept step by using runReactor with all other steps no-op. */
async function runProvisionalAcceptOnly(
  repoRoot: string,
  ledgerDir: string,
  opts: Partial<ReactorOptions> = {},
): Promise<LedgerEvent[]> {
  await runReactor({
    repoRoot,
    ledgerDir,
    autonomy: 'on',
    provider: null,                     // no routing step
    pidProbe: () => true,               // no doctor orphans
    config: makeTestConfig(),
    provisionalSloBoard: makeHealthyBoard(),
    ...opts,
  });
  return loadAllEvents(ledgerDir);
}

/** A queued event declaring `touches` — the fold copies this verbatim to rec.touches. */
function queuedEvent(wi: string, spec: string, touches: string, ts: string): LedgerEvent {
  return makeEvent('conductor', wi, 'item.queued', { spec, touches }, ts);
}

// ---------------------------------------------------------------------------
// classifyPathsPlaneOnly — unit tests (still used by the delegated-approval auto-approve path, approval.ts)
// ---------------------------------------------------------------------------

test('classifyPathsPlaneOnly: all plane files → planeOnly=true, escalated=[]', () => {
  const planePrefixes = ['packages/engine/', '.ai/'];
  const escalationPatterns = ['eventContracts', 'billing'];
  const result = classifyPathsPlaneOnly(
    ['packages/engine/src/foo.ts', '.ai/loops/prompts/conductor.md'],
    planePrefixes,
    escalationPatterns,
  );
  assert.equal(result.planeOnly, true);
  assert.deepEqual(result.escalated, []);
});

test('classifyPathsPlaneOnly: one non-plane file → planeOnly=false', () => {
  const planePrefixes = ['packages/engine/', '.ai/'];
  const escalationPatterns = ['billing'];
  const result = classifyPathsPlaneOnly(
    ['packages/engine/src/foo.ts', 'apps/example/src/some.ts'],
    planePrefixes,
    escalationPatterns,
  );
  assert.equal(result.planeOnly, false, 'apps/example/ is not in plane prefixes');
  assert.deepEqual(result.escalated, []);
});

test('classifyPathsPlaneOnly: escalated file → escalated array non-empty', () => {
  const planePrefixes = ['packages/engine/', '.ai/'];
  const escalationPatterns = ['eventContracts', 'billing'];
  const result = classifyPathsPlaneOnly(
    ['packages/engine/src/foo.ts', 'packages/engine/eventContracts/schema.ts'],
    planePrefixes,
    escalationPatterns,
  );
  // Escalated files are in the plane prefix but still escalated
  assert.ok(result.escalated.length > 0, 'escalated list must be non-empty');
  assert.ok(result.escalated[0]!.includes('eventContracts'));
});

test('classifyPathsPlaneOnly: empty files → planeOnly=false (no files to classify)', () => {
  const result = classifyPathsPlaneOnly([], ['packages/engine/'], ['billing']);
  assert.equal(result.planeOnly, false, 'empty file list must not be considered plane-only');
});

test('classifyPathsPlaneOnly: .loopkit/ is the plane prefix by default config', () => {
  const { planePrefixes, escalationPatterns } = CONFIG_DEFAULTS.autoApprove;
  assert.deepEqual(planePrefixes, ['.loopkit/'], 'framework default: only its own plane dir');
  const result = classifyPathsPlaneOnly(
    ['.loopkit/some-state-file.json'],
    planePrefixes,
    escalationPatterns,
  );
  assert.equal(result.planeOnly, true);
});

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

test('config: acceptance.provisional defaults applied when no acceptance block', () => {
  const repoRoot = makeTempDir();
  try {
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.provisional?.enabled, true);
    assert.equal(cfg.acceptance?.provisional?.afterHours, 48);
    assert.equal(cfg.acceptance?.provisional?.requireJudgePass, true);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.provisional.enabled:false disables', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { provisional: { enabled: false } } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.provisional?.enabled, false);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.provisional.enabled bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { provisional: { enabled: 'yes' } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /acceptance\.provisional\.enabled must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.provisional.afterHours bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { provisional: { afterHours: 'soon' } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /afterHours must be a non-negative finite number/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.provisional.requireJudgePass bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { provisional: { requireJudgePass: 1 } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /requireJudgePass must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: partial acceptance.provisional merges with defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { provisional: { afterHours: 24 } } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.provisional?.enabled, true,      'default enabled');
    assert.equal(cfg.acceptance?.provisional?.afterHours, 24,     'overridden afterHours');
    assert.equal(cfg.acceptance?.provisional?.requireJudgePass, true, 'default requireJudgePass');
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.tiers defaults applied when no acceptance block', () => {
  const repoRoot = makeTempDir();
  try {
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.tiers?.enabled, true);
    assert.deepEqual(cfg.acceptance?.tiers?.surfacePrefixes, [], 'framework default: no product surfaces of its own');
    assert.equal(cfg.acceptance?.tiers?.autoAfterHours, 2);
    assert.equal(cfg.acceptance?.tiers?.optionalAfterHours, 48);
    assert.equal(cfg.acceptance?.tiers?.reviewAfterHours, 168);
    assert.equal(cfg.acceptance?.tiers?.perBeatCap, 25);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.tiers.enabled:false disables', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { enabled: false } } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.tiers?.enabled, false);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.tiers.enabled bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { enabled: 'yes' } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /acceptance\.tiers\.enabled must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.tiers.surfacePrefixes bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { surfacePrefixes: 'not-an-array' } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /surfacePrefixes must be an array of strings/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.tiers.perBeatCap bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { perBeatCap: 0 } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /perBeatCap must be a positive integer/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: partial acceptance.tiers merges with defaults, provisional untouched', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { perBeatCap: 10 } } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.tiers?.perBeatCap, 10, 'overridden perBeatCap');
    assert.equal(cfg.acceptance?.tiers?.autoAfterHours, 2, 'default autoAfterHours');
    assert.equal(cfg.acceptance?.provisional?.afterHours, 48, 'provisional block still defaults (back-compat)');
  } finally {
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Eligibility: guards + tier windows
// ---------------------------------------------------------------------------

test('provisional-accept: tiers disabled → no-op', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-000', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    queuedEvent('WI-000', 'x', 'packages/engine/', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-000', 'item.merged', { commit: 'abc000', deployed: false }, isoAt(REVIEW_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
      config: makeTestConfig({ acceptance: { tiers: { enabled: false } } }),
    });
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-000');
    assert.equal(accepted.length, 0, 'tiers disabled — must not accept anything');
  } finally {
    cleanup();
  }
});

test('provisional-accept: plane-only item auto-accepts once past the 2h auto window', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, isoAt(AUTO_OLD_MS - 1000)),
    queuedEvent('WI-001', 'x', 'packages/engine/src/foo.ts', isoAt(AUTO_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-001', 'item.merged', { commit: 'abc123', deployed: false }, isoAt(AUTO_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-001');
    assert.equal(accepted.length, 1, 'plane-only item past the auto window must accept');
    const data = accepted[0]!.data as { tier: string };
    assert.equal(data.tier, 'auto');
  } finally {
    cleanup();
  }
});

test('provisional-accept: plane-only item skipped when merged too recently (< 2h auto window)', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-002', 'item.captured', { source: 'cli', text: 'x' }, isoAt(AUTO_TOO_RECENT_MS - 1000)),
    queuedEvent('WI-002', 'x', 'packages/engine/src/foo.ts', isoAt(AUTO_TOO_RECENT_MS - 900)),
    makeEvent('dispatch', 'WI-002', 'item.merged', { commit: 'abc124', deployed: false }, isoAt(AUTO_TOO_RECENT_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-002');
    assert.equal(accepted.length, 0, 'must not accept: too recent for the auto window');
  } finally {
    cleanup();
  }
});

test('provisional-accept: no-code item (question/feedback) auto-accepts', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-003', 'item.captured', { source: 'cli', text: 'what is X?' }, isoAt(AUTO_OLD_MS - 1000)),
    queuedEvent('WI-003', 'what is X?', '', isoAt(AUTO_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-003', 'item.merged', { commit: 'noop001', deployed: false }, isoAt(AUTO_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-003');
    assert.equal(accepted.length, 1, 'no-code item must auto-accept');
    const data = accepted[0]!.data as { tier: string };
    assert.equal(data.tier, 'auto');
  } finally {
    cleanup();
  }
});

test('provisional-accept: unanswered operator reply after merge HOLDS review/optional tiers (causation hold)', async () => {
  // A user-facing (review-tier) item with an UNANSWERED post-baseline reply is held — a change
  // the operator is actively questioning must not be silently accepted.
  const events: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, isoAt(REVIEW_OLD_MS - 2000)),
    makeEvent('operator', 'WI-010', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    queuedEvent('WI-010', 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-010', 'item.merged', { commit: 'def456', deployed: false }, isoAt(REVIEW_OLD_MS)),
    // operator engaged AFTER merge (post-baseline, unanswered) → held by causation. The reply
    // must be RECENT (within the 72h holdMaxHours) or the hold expires and the item resumes.
    makeEvent('operator', 'WI-010', 'msg.in', { text: 'looks odd' }, isoAt(NOW_MS - 3_600_000)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-010');
    assert.equal(accepted.length, 0, 'review-tier item engaged by the operator must be held');
  } finally {
    cleanup();
  }
});

test('provisional-accept: unanswered operator reply does NOT hold the auto tier', async () => {
  // A plane-only (auto-tier) item has nothing to test — even a fresh post-baseline reply must
  // not pin it in the queue. It auto-accepts despite operator engagement (auto tier is exempt).
  const events: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, isoAt(REVIEW_OLD_MS - 2000)),
    makeEvent('operator', 'WI-012', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    queuedEvent('WI-012', 'x', 'packages/engine/src/foo.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-012', 'item.merged', { commit: 'def457', deployed: false }, isoAt(REVIEW_OLD_MS)),
    makeEvent('operator', 'WI-012', 'msg.in', { text: 'this thing is odd' }, isoAt(REVIEW_OLD_MS + 3_600_000)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-012');
    assert.equal(accepted.length, 1, 'auto-tier item accepts despite operator engagement');
    assert.equal(accepted[0]!.data.tier, 'auto');
  } finally {
    cleanup();
  }
});

test('provisional-accept: risk file (must tier) never accepts, regardless of age', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-020', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    queuedEvent('WI-020', 'x', 'apps/example/src/features/billing/plan.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-020', 'item.merged', { commit: 'ghi789', deployed: false }, isoAt(REVIEW_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-020');
    assert.equal(accepted.length, 0, 'must not accept: risk-flagged path is must-tier');
  } finally {
    cleanup();
  }
});

test('provisional-accept: judge verdict fail (must tier) never accepts, regardless of age', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-021', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    queuedEvent('WI-021', 'x', 'packages/engine/src/foo.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-021', 'item.merged', { commit: 'jkl012', deployed: false }, isoAt(REVIEW_OLD_MS)),
    makeEvent('dispatch', 'WI-021', 'review.verdict', {
      verdict: 'fail', confidence: 0.4, specSatisfied: 'partial', scopeCreep: 'minor',
      testTheatre: 'none', reasons: ['issue'], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData, isoAt(REVIEW_OLD_MS + 100)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-021');
    assert.equal(accepted.length, 0, 'must not accept: judge verdict fail forces must-tier even for plane files');
  } finally {
    cleanup();
  }
});

test('provisional-accept: user-facing surface item skipped when younger than the 7-day review window', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-030', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_TOO_RECENT_MS - 1000)),
    queuedEvent('WI-030', 'x', 'apps/example/src/features/share/screen.ts', isoAt(REVIEW_TOO_RECENT_MS - 900)),
    makeEvent('dispatch', 'WI-030', 'item.merged', { commit: 'mno345', deployed: false }, isoAt(REVIEW_TOO_RECENT_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-030');
    assert.equal(accepted.length, 0, 'must not accept: surface item younger than the 7-day review window');
  } finally {
    cleanup();
  }
});

test('provisional-accept: user-facing surface item accepts once past the 7-day review window', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-031', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    queuedEvent('WI-031', 'x', 'apps/example/src/features/share/screen.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-031', 'item.merged', { commit: 'pqr678', deployed: false }, isoAt(REVIEW_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-031');
    assert.equal(accepted.length, 1, 'surface item past the 7-day review window must accept');
    const data = accepted[0]!.data as { tier: string };
    assert.equal(data.tier, 'review');
  } finally {
    cleanup();
  }
});

test('provisional-accept: optional-tier item skipped before 48h, accepted after', async () => {
  const eventsTooSoon: LedgerEvent[] = [
    makeEvent('operator', 'WI-040', 'item.captured', { source: 'cli', text: 'x' }, isoAt(AUTO_TOO_RECENT_MS - 1000)),
    queuedEvent('WI-040', 'x', 'apps/example/src/app.ts', isoAt(AUTO_TOO_RECENT_MS - 900)),
    makeEvent('dispatch', 'WI-040', 'item.merged', { commit: 'stu901', deployed: false }, isoAt(AUTO_TOO_RECENT_MS)),
  ];
  const { repoRoot: repoRoot1, ledgerDir: ledgerDir1, cleanup: cleanup1 } = await makeReactorEnv(eventsTooSoon);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot1, ledgerDir1);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-040');
    assert.equal(accepted.length, 0, 'optional-tier item under 48h must not accept yet');
  } finally {
    cleanup1();
  }

  const eventsOldEnough: LedgerEvent[] = [
    makeEvent('operator', 'WI-041', 'item.captured', { source: 'cli', text: 'x' }, isoAt(OPTIONAL_OLD_MS - 1000)),
    queuedEvent('WI-041', 'x', 'apps/example/src/app.ts', isoAt(OPTIONAL_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-041', 'item.merged', { commit: 'stu902', deployed: false }, isoAt(OPTIONAL_OLD_MS)),
  ];
  const { repoRoot: repoRoot2, ledgerDir: ledgerDir2, cleanup: cleanup2 } = await makeReactorEnv(eventsOldEnough);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot2, ledgerDir2);
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-041');
    assert.equal(accepted.length, 1, 'optional-tier item past 48h must accept');
    const data = accepted[0]!.data as { tier: string };
    assert.equal(data.tier, 'optional');
  } finally {
    cleanup2();
  }
});

test('provisional-accept: skipped when SLO board has a breached health row', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-060', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    // A NON-auto (product-surface = review) tier item so the SLO gate applies — the 'auto'
    // tier is exempt from the plane-SLO smoke gate (nothing to test there).
    queuedEvent('WI-060', 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-060', 'item.merged', { commit: 'vwx234', deployed: false }, isoAt(REVIEW_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
      provisionalSloBoard: makeBreachedBoard(),   // reactor row breached
    });
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-060');
    assert.equal(accepted.length, 0, 'must not accept: SLO breached');
  } finally {
    cleanup();
  }
});

test('provisional-accept: skipped when a monitored SLO row is unknown (probe error ≠ healthy)', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-061', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
    // NON-auto tier so the SLO gate still applies (auto is exempt).
    queuedEvent('WI-061', 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-061', 'item.merged', { commit: 'vwx235', deployed: false }, isoAt(REVIEW_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const unknownBoard: SloRow[] = [
      { key: 'loop-reactor', label: 'reactor', value: '—', target: '≤ 5m', status: 'unknown' },
      { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
      { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
    ];
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
      provisionalSloBoard: unknownBoard,
    });
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-061');
    assert.equal(accepted.length, 0, 'must not accept: probe error means evidence absent, not green');
  } finally {
    cleanup();
  }
});

test('provisional-accept: skip streak persists across beats and breaches the accept-skip SLO row at threshold', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv([]);
  try {
    for (let i = 0; i < 2; i++) {
      await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
        provisionalSloBoard: makeBreachedBoard(),
      });
    }
    let events = await loadAllEvents(ledgerDir);
    let breaches = events.filter(e =>
      e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'accept-skip');
    assert.equal(breaches.length, 0, 'not yet breached after 2 consecutive skipped beats (default threshold is 3)');

    await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
      provisionalSloBoard: makeBreachedBoard(),
    });
    events = await loadAllEvents(ledgerDir);
    breaches = events.filter(e =>
      e.type === 'slo.breach' && (e.data as { indicator?: string }).indicator === 'accept-skip');
    assert.equal(breaches.length, 1, 'breaches on the 3rd consecutive skipped beat — this class of silent stall is now visible');

    // A beat with a healthy SLO smoke check resets the streak and recovers the row.
    await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
      provisionalSloBoard: makeHealthyBoard(),
    });
    events = await loadAllEvents(ledgerDir);
    const recovers = events.filter(e =>
      e.type === 'slo.recovered' && (e.data as { key?: string }).key === 'accept-skip');
    assert.equal(recovers.length, 1, 'recovers once a beat sees loop-reactor/loop-dispatch/instances all met');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Happy path: all rungs pass → item.accepted with provisional flag + tier + trail
// ---------------------------------------------------------------------------

test('provisional-accept: all rungs pass → item.accepted provisional + tier + msg.out trail', async () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-070', 'item.captured', { source: 'cli', text: 'build engine thing' }, isoAt(AUTO_OLD_MS - 1000)),
    queuedEvent('WI-070', 'build engine thing', 'packages/engine/src/slo.ts,packages/engine/test/slo.test.ts', isoAt(AUTO_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-070', 'item.merged', { commit: 'abc456def', deployed: false }, isoAt(AUTO_OLD_MS)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir);

    // item.accepted with provisional:true must be emitted
    const accepted = allEvents.filter(e => e.type === 'item.accepted' && e.item === 'WI-070');
    assert.equal(accepted.length, 1, 'must emit one item.accepted');
    const data = accepted[0]!.data as { by: string; provisional: boolean; tier: string; reason: string };
    assert.equal(data.by, 'reactor:tier-auto');
    assert.equal(data.provisional, true);
    assert.equal(data.tier, 'auto');
    assert.ok(data.reason.length > 0);
    assert.equal(accepted[0]!.actor, 'reactor');

    // msg.out trail must be emitted
    const trail = allEvents.filter(e => e.type === 'msg.out' && e.item === 'WI-070' && e.actor === 'reactor');
    assert.ok(trail.length > 0, 'must emit msg.out trail');
    const trailText = (trail[trail.length - 1]!.data as { text: string }).text;
    assert.ok(trailText.includes('tier acceptance'), 'trail must mention tier acceptance');
    assert.ok(trailText.includes('tier=auto'), 'trail must include the tier');
    assert.ok(trailText.includes('packages/engine/src/slo.ts'), 'trail must include a touched file');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Cap: N eligible items → only perBeatCap accepted per beat
// ---------------------------------------------------------------------------

test('provisional-accept: perBeatCap=3 — 5 eligible yields exactly 3 accepted', async () => {
  const events: LedgerEvent[] = [];
  for (let i = 1; i <= 5; i++) {
    const ts = isoAt(AUTO_OLD_MS - 1000 * i);
    const mergeTs = isoAt(AUTO_OLD_MS + 10 * i);
    const wi = `WI-${String(100 + i).padStart(3, '0')}`;
    events.push(makeEvent('operator', wi, 'item.captured', { source: 'cli', text: `task ${i}` }, ts));
    events.push(queuedEvent(wi, `task ${i}`, 'packages/engine/', ts));
    events.push(makeEvent('dispatch', wi, 'item.merged', { commit: `sha${i}00`, deployed: false }, mergeTs));
  }
  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runProvisionalAcceptOnly(repoRoot, ledgerDir, {
      config: makeTestConfig({ acceptance: { tiers: { perBeatCap: 3 } } }),
    });
    const accepted = allEvents.filter(e => e.type === 'item.accepted');
    assert.equal(accepted.length, 3, 'cap is 3 per beat — must accept exactly 3 of 5 eligible');
    // All accepted must be provisional
    for (const ev of accepted) {
      const d = ev.data as { provisional: boolean };
      assert.equal(d.provisional, true, 'all auto-accepts must be provisional');
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fold: provisional item.accepted transitions merged→accepted + sets provisionalAccept flag
// ---------------------------------------------------------------------------

test('fold: provisional item.accepted transitions merged→accepted', () => {
  const mergeTs = isoAt(REVIEW_OLD_MS);
  const acceptTs = isoAt(NOW_MS - 1000);
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-200', 'item.captured', { source: 'cli', text: 'engine fix' }),
    queuedEvent('WI-200', 'engine fix', 'packages/engine/', isoAt(REVIEW_OLD_MS - 900)),
    makeEvent('dispatch', 'WI-200', 'item.merged', { commit: 'abc', deployed: false }, mergeTs),
    makeEvent('reactor', 'WI-200', 'item.accepted', { by: 'reactor:tier-auto', provisional: true, tier: 'auto', reason: 'ops-plane internals only' }, acceptTs),
  ];
  const result = fold(events);
  const item = result.items.get('WI-200');
  assert.ok(item, 'item must exist');
  assert.equal(item.state, 'accepted', 'state must be accepted');
  assert.equal(item.acceptedAt, acceptTs, 'acceptedAt must be set');
  assert.equal(item.provisionalAccept, true, 'provisionalAccept flag must be set');
});

test('fold: human item.accepted does NOT set provisionalAccept flag', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-201', 'item.captured', { source: 'cli', text: 'build x' }),
    makeEvent('conductor', 'WI-201', 'item.queued', { spec: 'build x', touches: 'src/' }),
    makeEvent('dispatch', 'WI-201', 'item.merged', { commit: 'xyz', deployed: false }),
    makeEvent('operator', 'WI-201', 'item.accepted', { by: 'operator' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-201');
  assert.equal(item?.state, 'accepted');
  assert.equal(item?.provisionalAccept, undefined, 'provisionalAccept must be undefined for human accepts');
});

test('fold: existing acceptance semantics preserved (merged is terminal; accepted is one legit transition)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-202', 'item.captured', { source: 'cli', text: 'build y' }),
    makeEvent('conductor', 'WI-202', 'item.queued', { spec: 'build y', touches: 'src/' }),
    makeEvent('dispatch', 'WI-202', 'item.merged', { commit: 'zzz', deployed: false }),
    // Stray event that should be no-op on merged state
    makeEvent('conductor', 'WI-202', 'item.parked', { reason: 'stray' }),
    // item.accepted is still the one legit transition
    makeEvent('operator', 'WI-202', 'item.accepted', { by: 'operator' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-202');
  assert.equal(item?.state, 'accepted', 'item.accepted must win from merged state');
});

// ---------------------------------------------------------------------------
// Verdicts calibration decontamination
// ---------------------------------------------------------------------------

test('verdicts: provisional accept → outcome=provisional, excluded from agreePass/falseAlarm', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-300', 'review.verdict', {
      verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
    makeEvent('reactor', 'WI-300', 'item.accepted', { by: 'reactor:tier-auto', provisional: true, tier: 'auto' }),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.total, 1);
  assert.equal(summary.provisionalAccepted, 1, 'provisionalAccepted must count the tier accept');
  // NOT in agreement cells
  assert.equal(summary.withOutcome, 0, 'provisional must not count as withOutcome');
  assert.equal(summary.agreePass, 0,   'provisional must not count as agreePass');
  assert.equal(summary.falseAlarm, 0,  'provisional must not count as falseAlarm');
  assert.equal(summary.rows[0]!.outcome, 'provisional');
});

test('verdicts: human accept still counts as ground truth (agreePass / falseAlarm)', () => {
  const events: LedgerEvent[] = [
    // WI-301: pass + human accept → agreePass
    makeEvent('dispatch', 'WI-301', 'review.verdict', {
      verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
    makeEvent('operator', 'WI-301', 'item.accepted', { by: 'operator' }),
    // WI-302: fail + human accept → falseAlarm
    makeEvent('dispatch', 'WI-302', 'review.verdict', {
      verdict: 'fail', confidence: 0.4, specSatisfied: 'partial', scopeCreep: 'minor',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
    makeEvent('operator', 'WI-302', 'item.accepted', { by: 'operator' }),
    // WI-303: pass + provisional → not in agreement
    makeEvent('dispatch', 'WI-303', 'review.verdict', {
      verdict: 'pass', confidence: 0.85, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
    makeEvent('reactor', 'WI-303', 'item.accepted', { by: 'reactor:tier-auto', provisional: true, tier: 'auto' }),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.total, 3);
  assert.equal(summary.withOutcome, 2,       'two human accepts');
  assert.equal(summary.agreePass, 1,         'WI-301 pass+accepted');
  assert.equal(summary.falseAlarm, 1,        'WI-302 fail+accepted');
  assert.equal(summary.provisionalAccepted, 1, 'WI-303 provisional');
  // Check WI-303 row
  const row303 = summary.rows.find(r => r.wi === 'WI-303');
  assert.equal(row303?.outcome, 'provisional');
});

test('verdicts: provisional accept with fail verdict still lands in provisional bucket', () => {
  // Unusual but possible: requireJudgePass=false lets a fail-verdict item be accepted.
  // It still must land in provisional, NOT falseAlarm (no selection bias either direction).
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-310', 'review.verdict', {
      verdict: 'fail', confidence: 0.3, specSatisfied: 'no', scopeCreep: 'minor',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
    makeEvent('reactor', 'WI-310', 'item.accepted', { by: 'reactor:tier-auto', provisional: true, tier: 'auto' }),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.provisionalAccepted, 1);
  assert.equal(summary.falseAlarm, 0,         'provisional must NOT count as false alarm');
  assert.equal(summary.withOutcome, 0,         'provisional must not be ground truth');
  assert.equal(summary.rows[0]!.outcome, 'provisional');
});

test('verdicts: none-yet outcome unchanged when no item.accepted', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-320', 'review.verdict', {
      verdict: 'pass', confidence: 0.8, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    } as unknown as import('../src/schema.js').ReviewVerdictData),
  ];
  const summary = projectVerdicts(events);
  assert.equal(summary.rows[0]!.outcome, 'none-yet');
  assert.equal(summary.provisionalAccepted, 0);
});

// ---------------------------------------------------------------------------
// Existing approval tests compatibility: classifyPathsPlaneOnly doesn't break
// classifyParkForAutoApprove (smoke — the approval.test.ts suite is the full gate)
// ---------------------------------------------------------------------------

test('approval: classifyParkForAutoApprove spine-park still auto-approves plane-only spine', async () => {
  const { classifyParkForAutoApprove } = await import('../src/approval.js');
  const cfg = CONFIG_DEFAULTS.autoApprove;
  const result = classifyParkForAutoApprove(
    { parkClass: 'spine', parkReason: 'needs-decision: touches spine (.loopkit/state.json) — approve to merge' },
    cfg,
  );
  assert.equal(result.autoApprove, true, 'plane-only spine must still auto-approve');
  assert.ok(result.reason.includes('auto-approve'), 'reason must state the auto-approve trail');
});

test('approval: classifyParkForAutoApprove product-spine still parks for operator review', async () => {
  const { classifyParkForAutoApprove } = await import('../src/approval.js');
  const cfg = CONFIG_DEFAULTS.autoApprove;
  const result = classifyParkForAutoApprove(
    { parkClass: 'spine', parkReason: 'needs-decision: touches spine (apps/example/src/app.ts) — approve to merge' },
    cfg,
  );
  assert.equal(result.autoApprove, false, 'product spine must still park for operator review');
});
