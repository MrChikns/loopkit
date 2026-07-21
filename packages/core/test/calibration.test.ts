/**
 * calibration.test.ts — Tests for verdict-history tier calibration (calibration.ts pure
 * logic + beats/reactor.ts stepTierCalibration integration).
 *
 * Covers:
 *   decideTierWindow — disabled/promote/demote/threshold/floor-ceiling pure-logic cases
 *   effectiveTierWindows — defaults when untuned, latest tier.recalibrated wins
 *   tallyVerdictsSince — clean operator-accepts vs. problem reports, watermark exclusion,
 *     reactor auto-accepts (by != 'operator') NOT counted — 'operator' is the literal
 *     `item.accepted.by` value the fold checks for a human verdict, kept verbatim
 *   reactor integration — a review-tier clean-accept streak shrinks the window; a
 *     subsequent problem report grows it back
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { SloRow } from '../src/slo.js';
import {
  decideTierWindow,
  effectiveTierWindows,
  tallyVerdictsSince,
  TierCalibrationConfig,
  TierStats,
} from '../src/calibration.js';

// ---------------------------------------------------------------------------
// Test helpers (mirrors wi222-provisional.test.ts)
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-calib-${process.pid}-${++testCount}-${Date.now()}`);
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
    // Framework default surfacePrefixes is [] (no product surfaces of its own) — this
    // suite's fixtures use 'apps/example/src/features/' as their example review-tier
    // surface, so declare it explicitly rather than relying on a product default.
    acceptance: {
      ...CONFIG_DEFAULTS.acceptance!,
      tiers: {
        ...CONFIG_DEFAULTS.acceptance!.tiers!,
        surfacePrefixes: ['apps/example/src/features/'],
      },
    },
    ...overrides,
  };
}

function makeHealthyBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10s ago', target: '≤ 5m', status: 'met' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}

const NOW_MS = Date.now();
const REVIEW_OLD_MS = NOW_MS - 200 * 3_600_000; // 200h ago — past the 168h review window

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

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

async function runReactorOnce(
  repoRoot: string,
  ledgerDir: string,
  opts: Partial<ReactorOptions> = {},
): Promise<LedgerEvent[]> {
  await runReactor({
    repoRoot,
    ledgerDir,
    autonomy: 'on',
    provider: null,
    pidProbe: () => true,
    config: makeTestConfig(),
    provisionalSloBoard: makeHealthyBoard(),
    ...opts,
  });
  return loadAllEvents(ledgerDir);
}

function queuedEvent(wi: string, spec: string, touches: string, ts: string): LedgerEvent {
  return makeEvent('conductor', wi, 'item.queued', { spec, touches }, ts);
}

const DEFAULT_CALIB: TierCalibrationConfig = {
  enabled: true,
  demoteAfterCleanAccepts: 5,
  demoteFactor: 0.5,
  promoteFactor: 2.0,
  windowFloorHours: 1,
  windowCeilingHours: 336,
};

// ---------------------------------------------------------------------------
// decideTierWindow — pure logic
// ---------------------------------------------------------------------------

test('decideTierWindow: disabled → null', () => {
  const cfg: TierCalibrationConfig = { ...DEFAULT_CALIB, enabled: false };
  const stats: TierStats = { cleanAccepts: 10, problems: 0 };
  assert.equal(decideTierWindow(168, stats, cfg), null);
});

test('decideTierWindow: problems > 0 → grows by promoteFactor, capped at ceiling', () => {
  const cfg = DEFAULT_CALIB;
  const decision = decideTierWindow(168, { cleanAccepts: 0, problems: 1 }, cfg);
  assert.ok(decision);
  assert.equal(decision!.newWindowHours, 336, 'round(168*2)=336, within ceiling');
  assert.match(decision!.reason, /1 problem\(s\) reported/);
});

test('decideTierWindow: promote capped at ceiling — no change when already at/above ceiling', () => {
  const cfg = DEFAULT_CALIB;
  const decision = decideTierWindow(336, { cleanAccepts: 0, problems: 1 }, cfg);
  assert.equal(decision, null, 'already at ceiling — min(ceiling, 336*2)=336=current → null');
});

test('decideTierWindow: problems=0 & cleanAccepts >= threshold → shrinks by demoteFactor, floored', () => {
  const cfg = DEFAULT_CALIB;
  const decision = decideTierWindow(168, { cleanAccepts: 5, problems: 0 }, cfg);
  assert.ok(decision);
  assert.equal(decision!.newWindowHours, 84, 'round(168*0.5)=84');
  assert.match(decision!.reason, /5 clean accepts, 0 problems/);
});

test('decideTierWindow: below clean-accept threshold → null', () => {
  const cfg = DEFAULT_CALIB;
  const decision = decideTierWindow(168, { cleanAccepts: 4, problems: 0 }, cfg);
  assert.equal(decision, null);
});

test('decideTierWindow: demote floored — no change when already at/below floor', () => {
  const cfg = DEFAULT_CALIB;
  const decision = decideTierWindow(1, { cleanAccepts: 5, problems: 0 }, cfg);
  assert.equal(decision, null, 'already at floor — max(floor, round(1*0.5))=1=current → null');
});

test('decideTierWindow: promote takes precedence over demote when both conditions hold', () => {
  const cfg = DEFAULT_CALIB;
  // 5 clean accepts (would trigger demote) but also 1 problem (promote wins).
  const decision = decideTierWindow(168, { cleanAccepts: 5, problems: 1 }, cfg);
  assert.ok(decision);
  assert.equal(decision!.newWindowHours, 336, 'promote wins over demote');
});

// ---------------------------------------------------------------------------
// effectiveTierWindows
// ---------------------------------------------------------------------------

test('effectiveTierWindows: no recalibrated events → defaults + empty watermarks', () => {
  const { windows, watermark } = effectiveTierWindows([], { optional: 48, review: 168 });
  assert.deepEqual(windows, { optional: 48, review: 168 });
  assert.equal(watermark.optional, '');
  assert.equal(watermark.review, '');
});

test('effectiveTierWindows: a tier.recalibrated for review returns its windowHours + ts as watermark', () => {
  const ev = makeEvent('reactor', 'tier-review', 'tier.recalibrated', {
    tier: 'review', windowHours: 84, prevWindowHours: 168, reason: 'x', cleanAccepts: 5, problems: 0,
  }, isoAt(NOW_MS - 1000));
  const { windows, watermark } = effectiveTierWindows([ev], { optional: 48, review: 168 });
  assert.equal(windows.review, 84);
  assert.equal(windows.optional, 48, 'optional untouched');
  assert.equal(watermark.review, ev.ts);
  assert.equal(watermark.optional, '');
});

test('effectiveTierWindows: latest of multiple tier.recalibrated wins', () => {
  const ev1 = makeEvent('reactor', 'tier-review', 'tier.recalibrated', {
    tier: 'review', windowHours: 84, prevWindowHours: 168, reason: 'first', cleanAccepts: 5, problems: 0,
  }, isoAt(NOW_MS - 10_000));
  const ev2 = makeEvent('reactor', 'tier-review', 'tier.recalibrated', {
    tier: 'review', windowHours: 42, prevWindowHours: 84, reason: 'second', cleanAccepts: 5, problems: 0,
  }, isoAt(NOW_MS - 1_000));
  // Deliberately out of chronological order in the array to prove ts comparison, not array order.
  const { windows, watermark } = effectiveTierWindows([ev2, ev1], { optional: 48, review: 168 });
  assert.equal(windows.review, 42, 'latest by ts must win regardless of array order');
  assert.equal(watermark.review, ev2.ts);
});

// ---------------------------------------------------------------------------
// tallyVerdictsSince
// ---------------------------------------------------------------------------

test('tallyVerdictsSince: operator accept on a review-tier item after watermark → review.cleanAccepts=1', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-500', 'item.accepted', { by: 'operator' }, isoAt(NOW_MS - 1000)),
  ];
  const watermark = { optional: '', review: '' };
  const classifyTier = (id: string) => (id === 'WI-500' ? 'review' : undefined);
  const stats = tallyVerdictsSince(events, watermark, classifyTier);
  assert.equal(stats.review.cleanAccepts, 1);
  assert.equal(stats.review.problems, 0);
  assert.equal(stats.optional.cleanAccepts, 0);
});

test('tallyVerdictsSince: "Problem with WI-NNN" capture referencing an optional item → optional.problems=1', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-600', 'item.captured', {
      source: 'ops-console', text: 'Problem with WI-501 (something broke): the button did nothing',
    }, isoAt(NOW_MS - 1000)),
  ];
  const watermark = { optional: '', review: '' };
  const classifyTier = (id: string) => (id === 'WI-501' ? 'optional' : undefined);
  const stats = tallyVerdictsSince(events, watermark, classifyTier);
  assert.equal(stats.optional.problems, 1);
  assert.equal(stats.optional.cleanAccepts, 0);
  assert.equal(stats.review.problems, 0);
});

test('tallyVerdictsSince: events at/before the watermark are excluded', () => {
  const atWatermark = isoAt(NOW_MS - 5000);
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-502', 'item.accepted', { by: 'operator' }, atWatermark),
    makeEvent('operator', 'WI-503', 'item.accepted', { by: 'operator' }, isoAt(NOW_MS - 4000)),
  ];
  const watermark = { optional: '', review: atWatermark };
  const classifyTier = () => 'review';
  const stats = tallyVerdictsSince(events, watermark, classifyTier);
  assert.equal(stats.review.cleanAccepts, 1, 'only the event strictly after the watermark counts');
});

test('tallyVerdictsSince: reactor auto-accepts (by != "operator") are NOT counted', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-504', 'item.accepted', { by: 'reactor:tier-review', provisional: true, tier: 'review' }, isoAt(NOW_MS - 1000)),
  ];
  const watermark = { optional: '', review: '' };
  const classifyTier = () => 'review';
  const stats = tallyVerdictsSince(events, watermark, classifyTier);
  assert.equal(stats.review.cleanAccepts, 0, 'reactor auto-accept must not count as an operator verdict');
});

// ---------------------------------------------------------------------------
// Reactor integration — stepTierCalibration via runReactor
// ---------------------------------------------------------------------------

test('reactor: 5 operator accepts on review-tier items (no problems) → recalibrates review to 84h', async () => {
  const events: LedgerEvent[] = [];
  // One merged review-tier item (so the classifier + fold have a real record to key off).
  events.push(makeEvent('operator', 'WI-700', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)));
  events.push(queuedEvent('WI-700', 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)));
  events.push(makeEvent('dispatch', 'WI-700', 'item.merged', { commit: 'abc700', deployed: false }, isoAt(REVIEW_OLD_MS)));

  // 5 operator accepts attributed to review-tier items (WI-701..WI-705), all past epoch.
  for (let i = 701; i <= 705; i++) {
    const wi = `WI-${i}`;
    events.push(makeEvent('operator', wi, 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)));
    events.push(queuedEvent(wi, 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)));
    events.push(makeEvent('dispatch', wi, 'item.merged', { commit: `sha${i}`, deployed: false }, isoAt(REVIEW_OLD_MS)));
    events.push(makeEvent('operator', wi, 'item.accepted', { by: 'operator' }, isoAt(REVIEW_OLD_MS + 100)));
  }

  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    const allEvents = await runReactorOnce(repoRoot, ledgerDir);
    const recal = allEvents.filter(e => e.type === 'tier.recalibrated');
    const reviewRecal = recal.filter(e => (e.data as { tier: string }).tier === 'review');
    assert.equal(reviewRecal.length, 1, 'exactly one review recalibration must be written');
    const data = reviewRecal[0]!.data as { windowHours: number; prevWindowHours: number; cleanAccepts: number; problems: number };
    assert.equal(data.windowHours, 84, 'round(168*0.5)=84');
    assert.equal(data.prevWindowHours, 168);
    assert.equal(data.cleanAccepts, 5);
    assert.equal(data.problems, 0);

    // optional tier must be untouched (no verdicts attributed to it)
    const optionalRecal = recal.filter(e => (e.data as { tier: string }).tier === 'optional');
    assert.equal(optionalRecal.length, 0);
  } finally {
    cleanup();
  }
});

test('reactor: a "Problem with WI-x" capture on a review item grows the window on the next calibration', async () => {
  // Seed with the same 5 clean review accepts as above so the first calibration shrinks
  // 168 → 84, then add a problem report referencing one of those items (after the
  // recalibration watermark) and run again — it must grow back from the new baseline.
  const events: LedgerEvent[] = [];
  for (let i = 801; i <= 805; i++) {
    const wi = `WI-${i}`;
    events.push(makeEvent('operator', wi, 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)));
    events.push(queuedEvent(wi, 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)));
    events.push(makeEvent('dispatch', wi, 'item.merged', { commit: `sha${i}`, deployed: false }, isoAt(REVIEW_OLD_MS)));
    events.push(makeEvent('operator', wi, 'item.accepted', { by: 'operator' }, isoAt(REVIEW_OLD_MS + 100)));
  }

  const { repoRoot, ledgerDir, cleanup } = await makeReactorEnv(events);
  try {
    // First beat: shrinks review 168 → 84.
    let allEvents = await runReactorOnce(repoRoot, ledgerDir);
    let reviewRecal = allEvents.filter(e => e.type === 'tier.recalibrated' && (e.data as { tier: string }).tier === 'review');
    assert.equal(reviewRecal.length, 1);
    assert.equal((reviewRecal[0]!.data as { windowHours: number }).windowHours, 84);

    // Seed a review-tier item + a problem report referencing it, both after the watermark
    // (the first calibration event's ts is real wall-clock time, later than the NOW_MS
    // constant captured at module load — use Date.now() here to guarantee ordering).
    const problemTs = new Date(Date.now() + 1000).toISOString();
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-810', 'item.captured', { source: 'cli', text: 'x' }, isoAt(REVIEW_OLD_MS - 1000)),
      queuedEvent('WI-810', 'x', 'apps/example/src/features/board/screen.ts', isoAt(REVIEW_OLD_MS - 900)),
      makeEvent('dispatch', 'WI-810', 'item.merged', { commit: 'shaproblem', deployed: false }, isoAt(REVIEW_OLD_MS)),
      makeEvent('operator', 'WI-820', 'item.captured', { source: 'ops-console', text: 'Problem with WI-810 (regression): the board is blank' }, problemTs),
    ]);

    // Second beat: promote wins — grows 84 → 168.
    allEvents = await runReactorOnce(repoRoot, ledgerDir);
    reviewRecal = allEvents.filter(e => e.type === 'tier.recalibrated' && (e.data as { tier: string }).tier === 'review');
    assert.equal(reviewRecal.length, 2, 'a second recalibration event must be written');
    const second = reviewRecal[1]!.data as { windowHours: number; prevWindowHours: number; problems: number };
    assert.equal(second.prevWindowHours, 84);
    assert.equal(second.windowHours, 168, 'round(84*2)=168');
    assert.equal(second.problems, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Config validation — acceptance.tiers.calibration
// ---------------------------------------------------------------------------

test('config: acceptance.tiers.calibration defaults applied when no acceptance block', () => {
  const repoRoot = makeTempDir();
  try {
    const cfg = loadConfig(repoRoot);
    const c = cfg.acceptance?.tiers?.calibration;
    assert.equal(c?.enabled, true);
    assert.equal(c?.demoteAfterCleanAccepts, 5);
    assert.equal(c?.demoteFactor, 0.5);
    assert.equal(c?.promoteFactor, 2.0);
    assert.equal(c?.windowFloorHours, 1);
    assert.equal(c?.windowCeilingHours, 336);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: acceptance.tiers.calibration.enabled bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { calibration: { enabled: 'yes' } } } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /acceptance\.tiers\.calibration\.enabled must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: partial acceptance.tiers.calibration merges with defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ acceptance: { tiers: { calibration: { demoteFactor: 0.25 } } } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.acceptance?.tiers?.calibration?.demoteFactor, 0.25, 'overridden');
    assert.equal(cfg.acceptance?.tiers?.calibration?.promoteFactor, 2.0, 'default');
  } finally {
    cleanDir(repoRoot);
  }
});
