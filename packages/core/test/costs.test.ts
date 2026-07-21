/**
 * costs.test.ts — foldCosts: cost/usage/quota event aggregation into cost summary rows
 * (codexQuotaPercent takes the latest reading, never summed; per-provider/per-loop/per-day
 * rollups; quota capacity + runway regression; cache efficiency; pipeline latency).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { foldCosts, formatQuotaWindowLabel } from '../src/costs.js';
import { makeEvent } from '../src/schema.js';

test('foldCosts: codexQuotaPercent takes the latest reading, not a sum, and ignores non-codex providers', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'consult', tokens: 100, quotaPercent: 4,
    }, '2026-07-16T09:00:00.000Z'),
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'interactive-manual', tokens: 50, quotaPercent: 9,
    }, '2026-07-16T10:00:00.000Z'),
    // A later claude-cli event with no quotaPercent must not clear the codex reading.
    makeEvent('interactive-usage-collector', 'interactive', 'cost.usage', {
      provider: 'claude-cli', loop: 'interactive', tokens: 200, usd: 0.5,
    }, '2026-07-16T11:00:00.000Z'),
  ];

  const summary = foldCosts(events);
  assert.equal(summary.codexQuotaPercent, 9, 'latest codex reading wins, not 4+9');
  assert.equal(summary.byProvider.find((r) => r.key === 'codex')?.tokens, 150);
});

test('foldCosts: codexQuotaPercent is undefined when no codex event carries it', () => {
  const events = [
    makeEvent('reactor', 'WI-1', 'cost.usage', { provider: 'anthropic', loop: 'reactor', tokens: 10 }),
  ];
  const summary = foldCosts(events);
  assert.equal(summary.codexQuotaPercent, undefined);
});

// ─── quota.snapshot history + capacity/runway regression ─────────────────────

test('foldCosts: quotaSnapshots keeps full history per provider:window, sorted by ts, never summed', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'five_hour', usedPct: 10,
    }, '2026-07-16T09:00:00.000Z'),
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'five_hour', usedPct: 20,
    }, '2026-07-16T10:00:00.000Z'),
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'seven_day', usedPct: 40,
    }, '2026-07-16T09:30:00.000Z'),
  ];
  const summary = foldCosts(events);
  assert.equal(summary.quotaSnapshots.length, 3);
  assert.deepEqual(summary.quotaSnapshots.map((p) => p.ts), [
    '2026-07-16T09:00:00.000Z', '2026-07-16T09:30:00.000Z', '2026-07-16T10:00:00.000Z',
  ]);
});

test('foldCosts: quotaCapacity regresses tokens/wk + usd/wk + runwayDays from two same-cycle readings and matching cost.usage deltas', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'seven_day', usedPct: 10,
    }, '2026-07-16T00:00:00.000Z'),
    makeEvent('interactive-usage-collector', 'interactive', 'cost.usage', {
      provider: 'claude-cli', loop: 'interactive', tokens: 100_000, usd: 1,
    }, '2026-07-17T00:00:00.000Z'),
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'seven_day', usedPct: 20,
    }, '2026-07-17T00:00:00.000Z'),
  ];
  const summary = foldCosts(events);
  const row = summary.quotaCapacity.find((r) => r.provider === 'claude' && r.window === 'seven_day');
  assert.ok(row, 'expected a claude:seven_day capacity row');
  assert.equal(row?.usedPct, 20);
  // deltaTokens=100_000 over deltaPct=10 -> 1_000_000 tokens for a full (100%) seven_day cycle,
  // which IS the weekly figure for a 7-day window (scaleToWeek = 1).
  assert.equal(row?.capacityTokensPerWeek, 1_000_000);
  assert.equal(row?.capacityUsdPerWeek, 10);
  assert.ok(row!.runwayDays! > 0, 'runway should be a positive day count');
});

// ─── byLoopToday — today-scoped per-loop aggregation ─────────────────────────

test('foldCosts: byLoopToday is scoped to the current day and sums match byDay for that day', () => {
  const events = [
    // Yesterday — must be excluded from byLoopToday but still counted in byLoop/byDay.
    makeEvent('dispatch', 'WI-1', 'cost.usage', {
      provider: 'claude-cli', loop: 'dispatch', tokens: 1_000, usd: 1,
    }, '2026-07-16T09:00:00.000Z'),
    makeEvent('reactor', 'WI-1', 'cost.usage', {
      provider: 'claude-cli', loop: 'reactor', tokens: 500, usd: 0.5,
    }, '2026-07-16T10:00:00.000Z'),
    // Today.
    makeEvent('dispatch', 'WI-2', 'cost.usage', {
      provider: 'claude-cli', loop: 'dispatch', tokens: 300, usd: 0.3,
    }, '2026-07-17T09:00:00.000Z'),
    makeEvent('scout', 'WI-2', 'cost.usage', {
      provider: 'claude-cli', loop: 'scout', tokens: 200, usd: 0.2,
    }, '2026-07-17T11:00:00.000Z'),
  ];

  const summary = foldCosts(events, { now: '2026-07-17T12:00:00.000Z' });

  // byLoop stays all-time (dispatch sums across both days).
  assert.equal(summary.byLoop.find((r) => r.key === 'dispatch')?.usd, 1.3);

  // byLoopToday only carries today's rows.
  assert.equal(summary.byLoopToday.find((r) => r.key === 'dispatch')?.usd, 0.3);
  assert.equal(summary.byLoopToday.find((r) => r.key === 'scout')?.usd, 0.2);
  assert.equal(summary.byLoopToday.find((r) => r.key === 'reactor'), undefined, 'yesterday-only loop must not appear today');

  const todayRow = summary.byDay.find((r) => r.key === '2026-07-17');
  const footnoteSum = summary.byLoopToday.reduce((s, r) => s + r.usd, 0);
  assert.equal(footnoteSum, todayRow?.usd, 'headline (byDay today) must equal sum of footnote lanes (byLoopToday)');
});

test('quotaCapacity: a usedPct drop between readings (window reset) is not treated as negative usage', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', {
      provider: 'codex', window: 'primary', usedPct: 90,
    }, '2026-07-16T00:00:00.000Z'),
    makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', {
      provider: 'codex', window: 'primary', usedPct: 5,
    }, '2026-07-17T00:00:00.000Z'),
  ];
  const summary = foldCosts(events);
  const row = summary.quotaCapacity.find((r) => r.provider === 'codex' && r.window === 'primary');
  assert.ok(row);
  assert.equal(row?.usedPct, 5);
  assert.equal(row?.capacityTokensPerWeek, undefined);
  assert.equal(row?.runwayDays, undefined);
});

test('quotaCapacity: a single reading yields the latest usedPct with no capacity/runway yet', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'five_hour', usedPct: 15,
    }),
  ];
  const summary = foldCosts(events);
  assert.equal(summary.quotaCapacity.length, 1);
  assert.equal(summary.quotaCapacity[0].usedPct, 15);
  assert.equal(summary.quotaCapacity[0].capacityTokensPerWeek, undefined);
  assert.equal(summary.quotaCapacity[0].runwayDays, undefined);
});

test('foldCosts: quotaCapacity is empty when no quota.snapshot event exists', () => {
  const events = [
    makeEvent('reactor', 'WI-1', 'cost.usage', { provider: 'anthropic', loop: 'reactor', tokens: 10 }),
  ];
  const summary = foldCosts(events);
  assert.deepEqual(summary.quotaCapacity, []);
  assert.deepEqual(summary.quotaSnapshots, []);
});

// ─── windowMinutes + reading-age ──────────────────────────────────────────────

test('foldCosts: quotaCapacity carries windowMinutes through from the quota.snapshot event', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', {
      provider: 'codex', window: 'primary', usedPct: 20, windowMinutes: 10_080,
    }, '2026-07-16T00:00:00.000Z'),
  ];
  const summary = foldCosts(events, { now: '2026-07-17T00:00:00.000Z' });
  const row = summary.quotaCapacity.find((r) => r.provider === 'codex');
  assert.equal(row?.windowMinutes, 10_080);
});

test('foldCosts: quotaCapacity omits windowMinutes when the event never carried it (Claude readings today)', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude', window: 'five_hour', usedPct: 10,
    }, '2026-07-16T00:00:00.000Z'),
  ];
  const summary = foldCosts(events, { now: '2026-07-16T01:00:00.000Z' });
  const row = summary.quotaCapacity.find((r) => r.provider === 'claude');
  assert.equal(row?.windowMinutes, undefined);
});

test('foldCosts: quotaCapacity readingAgeHours regresses from the latest reading ts against foldCosts\' now', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', {
      provider: 'codex', window: 'primary', usedPct: 20,
    }, '2026-07-16T00:00:00.000Z'),
  ];
  const summary = foldCosts(events, { now: '2026-07-17T02:00:00.000Z' });
  const row = summary.quotaCapacity.find((r) => r.provider === 'codex');
  assert.equal(row?.ts, '2026-07-16T00:00:00.000Z');
  assert.equal(row?.readingAgeHours, 26);
});

test('foldCosts: quotaCapacity readingAgeHours defaults to wall-clock now when foldCosts is called without one', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', {
      provider: 'codex', window: 'primary', usedPct: 20,
    }, new Date(Date.now() - 3_600_000).toISOString()),
  ];
  const summary = foldCosts(events);
  const row = summary.quotaCapacity.find((r) => r.provider === 'codex');
  assert.ok(row!.readingAgeHours! >= 0.9 && row!.readingAgeHours! <= 1.1, 'roughly 1h old');
});

test('formatQuotaWindowLabel: derives from windowMinutes (days/hours/minutes), ignoring the window key', () => {
  assert.equal(formatQuotaWindowLabel('primary', 10_080), '7d window');
  assert.equal(formatQuotaWindowLabel('primary', 300), '5h window');
  assert.equal(formatQuotaWindowLabel('primary', 90), '90m window');
});

test('formatQuotaWindowLabel: falls back to a static label for known Claude keys, else the raw key — never a fabricated "subscription"', () => {
  assert.equal(formatQuotaWindowLabel('five_hour'), '5h window');
  assert.equal(formatQuotaWindowLabel('seven_day'), '7d window');
  assert.equal(formatQuotaWindowLabel('primary'), 'primary');
});

// ─── cache efficiency + pipeline latency ──────────────────────────────────────

test('foldCosts: cache efficiency is uninstrumented (null hit%) for a loop whose events never carry cachedInputTokens', () => {
  const events = [
    makeEvent('dispatch', 'WI-1', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 1000 }, '2026-07-16T09:00:00.000Z'),
    makeEvent('dispatch', 'WI-2', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 500 }, '2026-07-16T09:02:00.000Z'),
  ];
  const summary = foldCosts(events);
  const row = summary.cacheEfficiency.find((r) => r.loop === 'dispatch');
  assert.ok(row);
  assert.equal(row?.totalTokens, 1500);
  assert.equal(row?.cacheInstrumented, false, 'dispatch never carries cachedInputTokens today (extractUsage merges it away)');
  assert.equal(row?.cacheHitPercent, null);
  assert.equal(row?.cacheReadTokens, 0);
});

test('foldCosts: cache efficiency computes hit% for a loop whose events carry cachedInputTokens (codex today)', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'consult', tokens: 1000, cachedInputTokens: 400,
    }, '2026-07-16T09:00:00.000Z'),
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'consult', tokens: 1000, cachedInputTokens: 600,
    }, '2026-07-16T09:01:00.000Z'),
  ];
  const summary = foldCosts(events);
  const row = summary.cacheEfficiency.find((r) => r.loop === 'consult');
  assert.ok(row);
  assert.equal(row?.cacheInstrumented, true);
  assert.equal(row?.cacheReadTokens, 1000);
  assert.equal(row?.totalTokens, 2000);
  assert.equal(row?.cacheHitPercent, 50);
});

test('foldCosts: cache efficiency buckets by 5m and 1h, summing within each window', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'consult', tokens: 100, cachedInputTokens: 20,
    }, '2026-07-16T09:00:10.000Z'),
    // Same 5m bucket (09:00:00-09:05:00), same 1h bucket (09:00:00-10:00:00).
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'consult', tokens: 100, cachedInputTokens: 20,
    }, '2026-07-16T09:04:00.000Z'),
    // A different 5m bucket (09:10:00) but the SAME 1h bucket.
    makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
      provider: 'codex', loop: 'consult', tokens: 100, cachedInputTokens: 20,
    }, '2026-07-16T09:10:00.000Z'),
  ];
  const summary = foldCosts(events);
  const row = summary.cacheEfficiency.find((r) => r.loop === 'consult');
  assert.ok(row);
  assert.equal(row?.buckets5m.length, 2, 'two distinct 5m buckets');
  assert.equal(row?.buckets5m[0].bucketStart, '2026-07-16T09:00:00.000Z');
  assert.equal(row?.buckets5m[0].uncachedTokens, 160, '(100-20)*2 events in the first 5m bucket');
  assert.equal(row?.buckets5m[0].cacheReadTokens, 40);
  assert.equal(row?.buckets5m[1].bucketStart, '2026-07-16T09:10:00.000Z');
  assert.equal(row?.buckets1h.length, 1, 'all three events land in the same 1h bucket');
  assert.equal(row?.buckets1h[0].uncachedTokens, 240);
  assert.equal(row?.buckets1h[0].cacheReadTokens, 60);
});

test('foldCosts: pipeline latency computes p50/p90 per stage transition for a merged item', () => {
  const events = [
    makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'do the thing' }, '2026-07-16T09:00:00.000Z'),
    makeEvent('reactor', 'WI-1', 'item.queued', { spec: 'do the thing' }, '2026-07-16T09:01:00.000Z'),
    makeEvent('dispatch', 'WI-1', 'build.dispatched', { attempt: 1 }, '2026-07-16T09:03:00.000Z'),
    makeEvent('dispatch', 'WI-1', 'gate.passed', {}, '2026-07-16T09:08:00.000Z'),
    makeEvent('reactor', 'WI-1', 'item.merged', { commit: 'abc123' }, '2026-07-16T09:09:00.000Z'),
  ];
  const summary = foldCosts(events, { now: '2026-07-16T10:00:00.000Z' });
  const stage = (name: string) => summary.pipelineLatency.stages.find((s) => s.name === name);
  assert.equal(stage('captured→queued')?.medianMs, 60_000);
  assert.equal(stage('queued→building')?.medianMs, 120_000);
  assert.equal(stage('building→gated')?.medianMs, 300_000);
  assert.equal(stage('gated→merged')?.medianMs, 60_000);
  assert.equal(stage('captured→queued')?.samples, 1);
});

test('foldCosts: pipeline latency skips a stage transition when an endpoint event is missing (crashed build, never gated)', () => {
  const events = [
    makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'do the thing' }, '2026-07-16T09:00:00.000Z'),
    makeEvent('reactor', 'WI-1', 'item.queued', { spec: 'do the thing' }, '2026-07-16T09:01:00.000Z'),
    makeEvent('dispatch', 'WI-1', 'build.dispatched', { attempt: 1 }, '2026-07-16T09:03:00.000Z'),
    // No gate.passed — build crashed and requeued elsewhere; item.merged never follows here.
  ];
  const summary = foldCosts(events, { now: '2026-07-16T10:00:00.000Z' });
  assert.equal(summary.pipelineLatency.stages.length, 0, 'no item.merged at all means zero samples for every stage');
});

test('foldCosts: pipeline latency window excludes merges outside the trailing window', () => {
  const events = [
    makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'do the thing' }, '2026-01-01T09:00:00.000Z'),
    makeEvent('reactor', 'WI-1', 'item.queued', { spec: 'do the thing' }, '2026-01-01T09:01:00.000Z'),
    makeEvent('dispatch', 'WI-1', 'build.dispatched', { attempt: 1 }, '2026-01-01T09:03:00.000Z'),
    makeEvent('dispatch', 'WI-1', 'gate.passed', {}, '2026-01-01T09:08:00.000Z'),
    makeEvent('reactor', 'WI-1', 'item.merged', { commit: 'abc123' }, '2026-01-01T09:09:00.000Z'),
  ];
  const summary = foldCosts(events, { now: '2026-07-16T10:00:00.000Z', pipelineLatencyDays: 7 });
  assert.equal(summary.pipelineLatency.stages.length, 0, 'the merge is 6+ months outside the 7-day window');
  assert.equal(summary.pipelineLatency.window.days, 7);
});
