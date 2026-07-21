/**
 * analytics.test.ts — the Analytics observability board: window scoping (follow-the-picker vs
 * fast-lane vs label-only), conditional quota surfacing on Command, interval honesty on every
 * pane, and graceful empty-ledger rendering for every widget (a fresh plane starts with an
 * empty ledger — nothing here may crash on one).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fold, makeEvent, LedgerEvent, ROUTING_CONFIG_DEFAULTS } from '@loopkit/core';

import {
  renderAnalytics,
  quotaNotice,
  laneRowsFromLoops,
  tokenUsageRows,
  salvageEntries,
  computeRoutingLatency,
  providerStatusToSlo,
  scanManifestFiles,
  computeScoutCoverage,
  QUOTA_WARN_PCT,
  QUOTA_CRIT_PCT,
} from '../src/analytics.js';
import { renderCommand } from '../src/views.js';

const NOW = new Date('2026-07-02T00:00:00.000Z');
const URL_DEFAULT = new URL('http://localhost/analytics');
const COMMAND_URL = new URL('http://localhost/command');

function urlWith(query: string): URL {
  return new URL(`http://localhost/analytics${query}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One recent (2h old) and one stale (12d old) cost.usage event — windows split them. */
function costLedger(): LedgerEvent[] {
  return [
    makeEvent('dispatch', 'WI-020', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 1000, usd: 5 }, '2026-07-01T22:00:00.000Z'),
    makeEvent('reactor', 'WI-021', 'cost.usage', { provider: 'claude-cli', loop: 'reactor', tokens: 500, usd: 2 }, '2026-06-20T00:00:00.000Z'),
  ];
}

function quotaLedger(usedPct: number): LedgerEvent[] {
  return [
    makeEvent('quota-collector', 'claude', 'quota.snapshot', {
      provider: 'claude',
      window: 'five_hour',
      usedPct,
      resetsAt: '2026-07-02T14:30:00.000Z',
    }, '2026-07-01T23:00:00.000Z'),
  ];
}

// ---------------------------------------------------------------------------
// Empty ledger — every widget renders an intentional empty state, no crash
// ---------------------------------------------------------------------------

test('renderAnalytics: empty ledger renders every widget with an empty state, no crash', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, {});

  // Every card title is present.
  for (const title of [
    'Spend', 'Daily spend', 'Token usage', 'Quota utilization', 'Judge verdicts',
    'Repairs', 'Cache efficiency', 'Pipeline latency', 'Trajectory', 'Ledger hygiene',
    'Salvage activity', 'Scout warm-start coverage',
  ]) {
    assert.ok(html.includes(title), `missing widget: ${title}`);
  }

  // And each data-less widget states an intentional empty state.
  assert.match(html, /no usage events in this window/);
  assert.match(html, /No quota snapshots yet/);
  assert.match(html, /No verdicts yet/);
  assert.match(html, /No repairs/);
  assert.match(html, /No merged items with complete stage timestamps/);
  assert.match(html, /No build attempts in the window yet/);
  assert.match(html, /No interrupted attempts/);
});

test('renderAnalytics: empty ledger + no extras — hygiene shows unknown quarantine, zero segments', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, {});
  assert.match(html, /Quarantined events: <strong>—<\/strong>/);
  assert.match(html, /Segments: <strong>0<\/strong>/);
});

// ---------------------------------------------------------------------------
// Window scoping (follow-the-picker widgets)
// ---------------------------------------------------------------------------

test('renderAnalytics: ?window=24h scopes spend to recent events only', () => {
  const events = costLedger();
  const html = renderAnalytics(fold(events), NOW, events, urlWith('?window=24h'), {});
  assert.match(html, /last 24h: 1k tokens · \$5\.00 · 1 call\(s\)/);
});

test('renderAnalytics: ?window=all includes the whole history', () => {
  const events = costLedger();
  const html = renderAnalytics(fold(events), NOW, events, urlWith('?window=all'), {});
  assert.match(html, /all-time: .* · \$7\.00 · 2 call\(s\)/);
});

test('renderAnalytics: a custom ?window=45m parses (URL-only, no chip) and scopes tighter than any preset', () => {
  const events = costLedger();
  const html = renderAnalytics(fold(events), NOW, events, urlWith('?window=45m'), {});
  assert.match(html, /last 45m: 0 tokens · \$0\.00 · 0 call\(s\)/);
});

test('renderAnalytics: garbage ?window= falls back to the default window instead of crashing', () => {
  const events = costLedger();
  const html = renderAnalytics(fold(events), NOW, events, urlWith('?window=bogus'), {});
  assert.match(html, /last 7d: 1k tokens · \$5\.00 · 1 call\(s\)/);
});

test('renderAnalytics: follow-the-picker chips offer 24h/7d/30d/all and preserve other params', () => {
  const html = renderAnalytics(fold([]), NOW, [], urlWith('?cache=5m'), {});
  for (const key of ['24h', '7d', '30d', 'all']) {
    assert.ok(html.includes(`?window=${key}&cache=5m`), `missing follow chip ${key}`);
  }
});

test('renderAnalytics: the fast-lane cache picker uses its own ?cache= param (5m/1h/24h) and preserves ?window=', () => {
  const html = renderAnalytics(fold([]), NOW, [], urlWith('?window=24h'), {});
  for (const key of ['5m', '1h', '24h']) {
    assert.ok(html.includes(`?cache=${key}&window=24h`), `missing cache chip ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Cache efficiency (fast-lane windows over collector buckets)
// ---------------------------------------------------------------------------

function cacheLedger(): LedgerEvent[] {
  return [
    // Instrumented collector: carries cachedInputTokens (30 minutes old).
    makeEvent('consult', 'WI-030', 'cost.usage', { provider: 'codex', loop: 'consult', tokens: 1000, usd: 1, cachedInputTokens: 800 }, '2026-07-01T23:30:00.000Z'),
    // Uninstrumented loop: no cache split available.
    makeEvent('dispatch', 'WI-031', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 400, usd: 2 }, '2026-07-01T23:30:00.000Z'),
  ];
}

test('renderAnalytics: cache efficiency shows the windowed hit rate for instrumented loops', () => {
  const events = cacheLedger();
  const html = renderAnalytics(fold(events), NOW, events, urlWith('?cache=1h'), {});
  assert.match(html, /80\.0%/);
  assert.match(html, /not instrumented/);
});

test('renderAnalytics: a 5m cache window excludes traffic older than 5 minutes', () => {
  const events = cacheLedger();
  const html = renderAnalytics(fold(events), NOW, events, urlWith('?cache=5m'), {});
  assert.match(html, /no traffic in window/);
  assert.ok(!html.includes('80.0%'));
});

// ---------------------------------------------------------------------------
// Routing-latency SLO row (recency-weighted status)
// ---------------------------------------------------------------------------

test('computeRoutingLatency: a stale breach (>24h old, within 7d) decays to at-risk, never breached', () => {
  const events = [
    // Stale breach: first reply took 30m, 2.5 days ago.
    makeEvent('cli', 'WI-040', 'item.captured', { source: 'cli', text: 'old intent' }, '2026-06-29T10:00:00.000Z'),
    makeEvent('reactor', 'WI-040', 'msg.out', { text: 'routed late' }, '2026-06-29T10:30:00.000Z'),
    // Fresh healthy sample inside 24h.
    makeEvent('cli', 'WI-041', 'item.captured', { source: 'cli', text: 'new intent' }, '2026-07-01T23:00:00.000Z'),
    makeEvent('reactor', 'WI-041', 'msg.out', { text: 'routed fast' }, '2026-07-01T23:02:00.000Z'),
  ];
  const r = computeRoutingLatency(events, NOW.getTime());
  assert.equal(r.status, 'at-risk');
  assert.equal(r.worstMin, 30);
  assert.equal(r.worst24hMin, 2);
});

test('computeRoutingLatency: a breach inside the last 24h reads breached', () => {
  const events = [
    makeEvent('cli', 'WI-042', 'item.captured', { source: 'cli', text: 'slow intent' }, '2026-07-01T20:00:00.000Z'),
    makeEvent('reactor', 'WI-042', 'msg.out', { text: 'routed very late' }, '2026-07-01T20:20:00.000Z'),
  ];
  const r = computeRoutingLatency(events, NOW.getTime());
  assert.equal(r.status, 'breached');
});

test('computeRoutingLatency: no traffic reads unknown; unanswered intents read at-risk pending', () => {
  assert.equal(computeRoutingLatency([], NOW.getTime()).status, 'unknown');
  const pending = computeRoutingLatency(
    [makeEvent('cli', 'WI-043', 'item.captured', { source: 'cli', text: 'unanswered' }, '2026-07-01T23:00:00.000Z')],
    NOW.getTime(),
  );
  assert.equal(pending.pending, 1);
  assert.equal(pending.status, 'at-risk');
});

test('renderAnalytics: the routing row labels both its windows (7d value, 24h status)', () => {
  const events = [
    makeEvent('cli', 'WI-044', 'item.captured', { source: 'cli', text: 'intent' }, '2026-07-01T23:00:00.000Z'),
    makeEvent('reactor', 'WI-044', 'msg.out', { text: 'reply' }, '2026-07-01T23:01:00.000Z'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, {});
  assert.match(html, /Intent routing latency \(7d\)/);
  assert.match(html, /target: worst ≤ 15m \(24h\)/);
});

// ---------------------------------------------------------------------------
// Interval captions — every pane states the window its numbers cover
// ---------------------------------------------------------------------------

test('renderAnalytics: every pane carries an interval caption (windowed, live, trailing, or last-N)', () => {
  const events = [
    ...costLedger(),
    ...quotaLedger(42),
    // A repair (two attempts) that merged — feeds repairs, trajectory, pipeline.
    makeEvent('cli', 'WI-050', 'item.captured', { source: 'cli', text: 'work' }, '2026-07-01T10:00:00.000Z'),
    makeEvent('reactor', 'WI-050', 'item.queued', { spec: 'work' }, '2026-07-01T10:01:00.000Z'),
    makeEvent('dispatch', 'WI-050', 'build.dispatched', { attempt: 1 }, '2026-07-01T10:02:00.000Z'),
    makeEvent('dispatch', 'WI-050', 'gate.failed', { reason: 'tests red' }, '2026-07-01T10:10:00.000Z'),
    makeEvent('dispatch', 'WI-050', 'build.dispatched', { attempt: 2 }, '2026-07-01T10:20:00.000Z'),
    makeEvent('dispatch', 'WI-050', 'gate.passed', { tests: 'green' }, '2026-07-01T10:30:00.000Z'),
    makeEvent('reactor', 'WI-050', 'item.merged', { commit: 'abc1234' }, '2026-07-01T10:31:00.000Z'),
    // A judge verdict.
    makeEvent('judge', 'WI-050', 'review.verdict', {
      verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'test-model', judge: 'merge-review',
    }, '2026-07-01T10:29:00.000Z'),
    // A salvage trail.
    makeEvent('dispatch', 'WI-050', 'msg.out', { text: 'attempt 1 interrupted (crash) — salvaged 3 file(s) / 12.4 KB to WI-050-attempt-1.salvage.patch' }, '2026-07-01T10:15:00.000Z'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, { segments: [{ name: 'work-2026-07.jsonl', bytes: 2048 }], quarantinedCount: 0 });

  assert.match(html, /Interval: last 7d/); // spend + daily + token usage (page default)
  assert.match(html, /Interval: live — latest reading per provider:window/); // quota
  assert.match(html, /Interval: last 1 verdict\(s\)/); // judge recency list
  assert.match(html, /Interval: live — current attempt counts/); // repairs
  assert.match(html, /Interval: last 1h/); // cache (fast-lane default)
  assert.match(html, /Interval: trailing 7d/); // pipeline latency
  assert.match(html, /Interval: trailing 14d/); // trajectory
  assert.match(html, /Interval: live — current segment files/); // hygiene
  assert.match(html, /Interval: last 1 interruption\(s\)/); // salvage
});

// ---------------------------------------------------------------------------
// Lane + loop×provider aggregations
// ---------------------------------------------------------------------------

test('laneRowsFromLoops: groups plane loops together, keeps operator sessions and others apart', () => {
  const lanes = laneRowsFromLoops([
    { key: 'dispatch', tokens: 100, usd: 1, calls: 1 },
    { key: 'reactor', tokens: 50, usd: 0.5, calls: 2 },
    { key: 'interactive', tokens: 200, usd: 2, calls: 1 },
    { key: 'consult', tokens: 10, usd: 0.1, calls: 1 },
  ]);
  const byLabel = new Map(lanes.map((l) => [l.label, l]));
  assert.equal(byLabel.get('Autonomy plane')?.tokens, 150);
  assert.equal(byLabel.get('Autonomy plane')?.calls, 3);
  assert.equal(byLabel.get('Interactive (operator sessions)')?.tokens, 200);
  assert.equal(byLabel.get('Other')?.tokens, 10);
});

test('tokenUsageRows: cross-groups cost.usage by loop × provider', () => {
  const rows = tokenUsageRows([
    makeEvent('a', 'WI-060', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 100, usd: 1 }, '2026-07-01T10:00:00.000Z'),
    makeEvent('a', 'WI-061', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 50, usd: 0.5 }, '2026-07-01T11:00:00.000Z'),
    makeEvent('a', 'WI-062', 'cost.usage', { provider: 'ollama', loop: 'dispatch', tokens: 10, usd: 0 }, '2026-07-01T12:00:00.000Z'),
  ]);
  assert.equal(rows.length, 2);
  const claude = rows.find((r) => r.provider === 'claude-cli');
  assert.equal(claude?.tokens, 150);
  assert.equal(claude?.calls, 2);
});

// ---------------------------------------------------------------------------
// Salvage trail parsing
// ---------------------------------------------------------------------------

test('salvageEntries: parses interruption trail messages and classifies outcomes', () => {
  const events = [
    makeEvent('dispatch', 'WI-070', 'msg.out', { text: 'attempt 1 interrupted (crash) — salvaged 3 file(s) / 12.4 KB to WI-070-attempt-1.salvage.patch' }, '2026-07-01T10:00:00.000Z'),
    makeEvent('dispatch', 'WI-071', 'msg.out', { text: 'attempt 2 interrupted (timeout) — partial work too large (900 KB > 256 KB cap), not salvaged' }, '2026-07-01T11:00:00.000Z'),
    makeEvent('dispatch', 'WI-072', 'msg.out', { text: 'attempt 1 interrupted (crash) — no uncommitted changes to salvage' }, '2026-07-01T12:00:00.000Z'),
    makeEvent('reactor', 'WI-073', 'msg.out', { text: 'an ordinary reply, not a salvage trail' }, '2026-07-01T13:00:00.000Z'),
  ];
  const entries = salvageEntries(events);
  assert.equal(entries.length, 3);
  // Newest first.
  assert.equal(entries[0]!.item, 'WI-072');
  assert.equal(entries[0]!.kind, 'none');
  assert.equal(entries[1]!.kind, 'too-large');
  assert.equal(entries[2]!.kind, 'patch');
  assert.equal(entries[2]!.attempt, 1);
  assert.equal(entries[2]!.reason, 'crash');
});

// ---------------------------------------------------------------------------
// Quota thresholds — the boundary contract (nothing / chip / banner)
// ---------------------------------------------------------------------------

test('quota thresholds: 59% stays entirely off the Command view', () => {
  const events = quotaLedger(59);
  const html = renderCommand(fold(events), NOW, events, COMMAND_URL);
  assert.ok(!html.includes('quota-chip'));
  assert.ok(!html.includes('quota-banner'));
});

test('quota thresholds: exactly 60% renders the compact warning chip linking to the quota panel', () => {
  const events = quotaLedger(60);
  const html = renderCommand(fold(events), NOW, events, COMMAND_URL);
  assert.match(html, /class="quota-chip quota-chip--warning" href="\/analytics#quota"/);
  assert.match(html, /claude 5h: 60% · resets 14:30/);
  assert.ok(!html.includes('quota-banner'));
});

test('quota thresholds: exactly 85% renders the critical banner (resets first, panel link), no chip', () => {
  const events = quotaLedger(85);
  const html = renderCommand(fold(events), NOW, events, COMMAND_URL);
  assert.match(html, /class="quota-banner" role="alert"/);
  assert.match(html, /LLM quota critical — claude 5h at 85%/);
  assert.match(html, /resets 14:30/);
  assert.ok(!html.includes('quota-chip'));
});

test('quota banner: names the dispatch pause when the quota-pressure gate threshold is tripped', () => {
  const events = quotaLedger(90);
  const html = renderCommand(fold(events), NOW, events, COMMAND_URL, undefined, undefined, 80);
  assert.match(html, /Dispatch pauses new builds at 80% — quota-pressure gate active\./);
});

test('quotaNotice: worst window across providers drives the level', () => {
  const rows = [
    { provider: 'claude', window: 'five_hour', usedPct: 30, ts: '2026-07-01T23:00:00.000Z', readingAgeHours: 1 },
    { provider: 'codex', window: 'primary', usedPct: 70, ts: '2026-07-01T23:00:00.000Z', readingAgeHours: 1 },
  ];
  const notice = quotaNotice(rows);
  assert.ok(notice.chip, 'expected a warning chip from the worst (70%) window');
  assert.match(notice.chip!, /codex/);
  assert.equal(notice.banner, undefined);
});

test('quota thresholds: the analytics quota panel bar states track the same 60/85 boundaries', () => {
  const events = [
    makeEvent('quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'five_hour', usedPct: 59 }, '2026-07-01T23:00:00.000Z'),
    makeEvent('quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'seven_day', usedPct: 60 }, '2026-07-01T23:00:00.000Z'),
    makeEvent('quota-collector', 'codex', 'quota.snapshot', { provider: 'codex', window: 'primary', usedPct: 85 }, '2026-07-01T23:00:00.000Z'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, {});
  assert.match(html, /analytics-quota-fill--neutral/);
  assert.match(html, /analytics-quota-fill--warning/);
  assert.match(html, /analytics-quota-fill--critical/);
});

// ---------------------------------------------------------------------------
// Verdict + repair rendering details
// ---------------------------------------------------------------------------

test('renderAnalytics: judge card lists verdicts newest-first with outcomes', () => {
  const events = [
    makeEvent('judge', 'WI-080', 'review.verdict', {
      verdict: 'fail', confidence: 0.7, specSatisfied: 'partial', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'test-model', judge: 'merge-review',
    }, '2026-07-01T10:00:00.000Z'),
    makeEvent('operator', 'WI-080', 'item.accepted', { by: 'operator' }, '2026-07-01T11:00:00.000Z'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, {});
  assert.match(html, /WI-080/);
  assert.match(html, /analytics-verdict--fail/);
  assert.match(html, /False alarms: <strong>1<\/strong>/);
});

// ---------------------------------------------------------------------------
// Shared fixture: a full built item (capture → queue → dispatch → gate → merge [→ accept])
// ---------------------------------------------------------------------------

/** One item that dispatched once under `model`, passed the gate and merged, with a $2 build
 *  cost; optionally accepted by a human operator or provisionally by the plane itself. */
function builtItem(wi: string, model: string, hour: number, accept: 'human' | 'provisional' | 'none' = 'none'): LedgerEvent[] {
  const t = (m: number) => `2026-07-01T${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const events: LedgerEvent[] = [
    makeEvent('cli', wi, 'item.captured', { source: 'cli', text: `work ${wi}` }, t(0)),
    makeEvent('reactor', wi, 'item.queued', { spec: `spec ${wi}` }, t(1)),
    makeEvent('dispatch', wi, 'build.dispatched', { attempt: 1, model }, t(2)),
    makeEvent('dispatch', wi, 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', wi, tokens: 100, usd: 2 }, t(3)),
    makeEvent('dispatch', wi, 'gate.passed', { tests: 'green' }, t(4)),
    makeEvent('reactor', wi, 'item.merged', { commit: 'abc1234' }, t(5)),
  ];
  if (accept === 'human') {
    events.push(makeEvent('operator', wi, 'item.accepted', { by: 'operator' }, t(6)));
  } else if (accept === 'provisional') {
    events.push(makeEvent('reactor', wi, 'item.accepted', { by: 'reactor:provisional', provisional: true }, t(6)));
  }
  return events;
}

/** Hermetic extras for the probe panes — no live config/fs reads inside a test. */
const PROBE_EXTRAS = {
  routingConfig: { ...ROUTING_CONFIG_DEFAULTS },
  providerHealth: null,
  manifests: null,
} as const;

// ---------------------------------------------------------------------------
// Execution-config card
// ---------------------------------------------------------------------------

test('renderAnalytics: execution-config card shows per-model ratios at n >= minSamples and counts-only under it', () => {
  const events: LedgerEvent[] = [
    // Five accepted items on one model — enough samples for honest ratios.
    ...builtItem('WI-201', 'model-a', 1, 'human'),
    ...builtItem('WI-202', 'model-a', 2, 'human'),
    ...builtItem('WI-203', 'model-a', 3, 'human'),
    ...builtItem('WI-204', 'model-a', 4, 'human'),
    ...builtItem('WI-205', 'model-a', 5, 'human'),
    // One merged-not-accepted item on another model — below the sample floor.
    ...builtItem('WI-206', 'model-b', 6, 'none'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, PROBE_EXTRAS);

  assert.match(html, /Execution config/);
  assert.match(html, /model-a/);
  assert.match(html, /100\.0%/); // accept rate AND first-pass gate rate at n=5
  assert.match(html, /\$2\.00/); // $10 across 5 accepted items
  // The small-sample row states counts only — never a ratio over one item.
  assert.match(html, /model-b <span class="analytics-muted">\(n&lt;5 — counts only\)<\/span>/);
  assert.match(html, /0\/1 accepted/);
  // Fixed trailing window stated per the page's window discipline.
  assert.match(html, /Interval: trailing 30d/);
});

test('renderAnalytics: execution-config card renders an empty state on a fresh ledger', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, PROBE_EXTRAS);
  assert.match(html, /No attributable builds in the window yet/);
});

// ---------------------------------------------------------------------------
// Routing calibration panel
// ---------------------------------------------------------------------------

test('renderAnalytics: routing panel renders bucket × model cells and labels the advisory mode from config', () => {
  const events = [
    ...builtItem('WI-211', 'model-a', 1, 'none'),
    ...builtItem('WI-212', 'model-a', 2, 'none'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, PROBE_EXTRAS);

  assert.match(html, /Routing/);
  assert.match(html, /ADVISORY/);
  assert.match(html, /small \(&lt;1500 chars\)/); // short spec fixtures bucket small
  assert.match(html, /First-pass rate/);
  assert.match(html, /Interval: trailing 30d of build attempts/);
});

test('renderAnalytics: routing panel labels active mode when config says so', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, {
    ...PROBE_EXTRAS,
    routingConfig: { ...ROUTING_CONFIG_DEFAULTS, mode: 'active' },
  });
  assert.match(html, /ACTIVE/);
  assert.match(html, /No routed attempts in the window yet/);
});

// ---------------------------------------------------------------------------
// Provider-chain health card
// ---------------------------------------------------------------------------

test('providerStatusToSlo: maps chain states onto the shared SLO colour vocabulary', () => {
  assert.equal(providerStatusToSlo('primary-healthy'), 'met');
  assert.equal(providerStatusToSlo('fallback-active'), 'at-risk');
  assert.equal(providerStatusToSlo('all-unhealthy'), 'breached');
  assert.equal(providerStatusToSlo(undefined), 'unknown');
});

test('renderAnalytics: provider-chain card renders the circuit-breaker states with live caption', () => {
  const healthy = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, {
    ...PROBE_EXTRAS,
    providerHealth: { status: 'primary-healthy', primaryProvider: 'claude-cli', activeProvider: 'claude-cli' },
  });
  assert.match(healthy, /Provider chain/);
  assert.match(healthy, /primary healthy/);
  assert.match(healthy, /opsui-status--success/);
  assert.match(healthy, /Interval: live — resolved from on-disk provider health markers/);

  const fallback = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, {
    ...PROBE_EXTRAS,
    providerHealth: { status: 'fallback-active', primaryProvider: 'claude-cli', activeProvider: 'ollama' },
  });
  assert.match(fallback, /running on fallback/);
  assert.match(fallback, /opsui-status--warning/);
  assert.match(fallback, /ollama/);

  const dead = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, {
    ...PROBE_EXTRAS,
    providerHealth: { status: 'all-unhealthy', primaryProvider: 'claude-cli' },
  });
  assert.match(dead, /no healthy provider/);
  assert.match(dead, /opsui-status--critical/);
});

test('renderAnalytics: provider-chain card reads honest unknown when no chain is resolvable', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, PROBE_EXTRAS);
  assert.match(html, /Provider health unknown/);
});

// ---------------------------------------------------------------------------
// Acceptance-split card
// ---------------------------------------------------------------------------

test('renderAnalytics: acceptance split separates human accepts from provisional self-accepts, all-time', () => {
  const events = [
    ...builtItem('WI-221', 'model-a', 1, 'human'),
    ...builtItem('WI-222', 'model-a', 2, 'provisional'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, PROBE_EXTRAS);

  assert.match(html, /Acceptance split/);
  assert.match(html, /Human accepts: <strong>1<\/strong>/);
  assert.match(html, /Provisional \(plane self-accepts\): <strong>1<\/strong>/);
  assert.match(html, /Human share: <strong>50\.0%<\/strong>/);
  assert.match(html, /Interval: all-time — cumulative accepts across the whole ledger\./);
  // The by-actor breakdown and the judge-calibration exclusion note.
  assert.match(html, /reactor:provisional/);
  assert.match(html, /excluded from judge calibration/);
});

test('renderAnalytics: acceptance split renders an empty state on a fresh ledger', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, PROBE_EXTRAS);
  assert.match(html, /No accepted items yet/);
});

// ---------------------------------------------------------------------------
// Manifest-coverage card
// ---------------------------------------------------------------------------

test('renderAnalytics: manifest coverage joins scanned manifests to fold attempts', () => {
  const events = [
    ...builtItem('WI-231', 'model-a', 1, 'none'),
    ...builtItem('WI-232', 'model-a', 2, 'none'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, {
    ...PROBE_EXTRAS,
    manifests: [
      { item: 'WI-231', attempt: 1, confidence: 0.9 },
      { item: 'WI-232', attempt: 1, confidence: 0.7 },
      // A manifest for an item the ledger does not know — must not count.
      { item: 'WI-999', attempt: 1, confidence: 1 },
      // A duplicate artifact for a counted attempt — must not double-count.
      { item: 'WI-231', attempt: 1, confidence: 0.9 },
    ],
  });
  assert.match(html, /Manifest coverage/);
  assert.match(html, /Build attempts: <strong>2<\/strong>/);
  assert.match(html, /With manifest: <strong>2<\/strong>/);
  assert.match(html, /Coverage: <strong>100\.0%<\/strong>/);
  assert.match(html, /Interval: live — from run artifacts/);
});

test('renderAnalytics: manifest coverage distinguishes an absent runs dir from zero attempts', () => {
  const absent = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, PROBE_EXTRAS);
  assert.match(absent, /No runs directory yet/);

  const fresh = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, { ...PROBE_EXTRAS, manifests: [] });
  assert.match(fresh, /No build attempts yet/);
});

test('scanManifestFiles: finds manifests at bounded depth, tolerates malformed JSON, null on absent dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'runs-scan-'));
  try {
    // Depth 0, 1 and 2 — the runs root, a per-loop dir, and a per-target dir under it.
    writeFileSync(join(root, 'WI-301-attempt-1.manifest.json'), JSON.stringify({ confidence: 0.8 }));
    mkdirSync(join(root, 'loop'));
    writeFileSync(join(root, 'loop', 'WI-302-attempt-2.manifest.json'), JSON.stringify({ confidence: 1.7 })); // clamps to 1
    mkdirSync(join(root, 'loop', 'target'));
    writeFileSync(join(root, 'loop', 'target', 'WI-303-attempt-1.manifest.json'), 'not json at all');
    // Non-manifest names are ignored.
    writeFileSync(join(root, 'WI-304-attempt-1.log'), 'a log, not a manifest');

    const entries = scanManifestFiles(root);
    assert.ok(entries);
    const byItem = new Map(entries!.map((e) => [e.item, e]));
    assert.equal(entries!.length, 3);
    assert.equal(byItem.get('WI-301')?.confidence, 0.8);
    assert.equal(byItem.get('WI-302')?.confidence, 1); // clamped
    assert.equal(byItem.get('WI-302')?.attempt, 2);
    assert.equal(byItem.get('WI-303')?.confidence, null); // malformed → counts, no confidence
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(scanManifestFiles(join(tmpdir(), 'runs-scan-definitely-absent')), null);
});

// ---------------------------------------------------------------------------
// Scout warm-start coverage card
// ---------------------------------------------------------------------------

test('computeScoutCoverage: fraction of build attempts on items with a scout brief, ItemRecord.brief-keyed', () => {
  const events = [
    // WI-241: briefed, then two build attempts — both count as warm-started.
    makeEvent('scout', 'WI-241', 'item.briefed', { brief: 'context pack' }, '2026-07-01T00:00:00.000Z'),
    makeEvent('dispatch', 'WI-241', 'build.dispatched', { attempt: 1 }, '2026-07-01T00:01:00.000Z'),
    makeEvent('dispatch', 'WI-241', 'build.crashed', { reason: 'oom' }, '2026-07-01T00:02:00.000Z'),
    makeEvent('dispatch', 'WI-241', 'build.dispatched', { attempt: 2 }, '2026-07-01T00:03:00.000Z'),
    // WI-242: never briefed — its one attempt is cold.
    makeEvent('dispatch', 'WI-242', 'build.dispatched', { attempt: 1 }, '2026-07-01T00:04:00.000Z'),
  ];
  const result = computeScoutCoverage(fold(events), NOW);
  assert.equal(result.totalAttempts, 3);
  assert.equal(result.warmStarts, 2);
  assert.equal(result.coverage, 2 / 3);
});

test('computeScoutCoverage: attempts outside the trailing window are excluded, coverage undefined on none', () => {
  const events = [
    makeEvent('scout', 'WI-250', 'item.briefed', { brief: 'context pack' }, '2026-06-01T00:00:00.000Z'),
    makeEvent('dispatch', 'WI-250', 'build.dispatched', { attempt: 1 }, '2026-06-01T00:01:00.000Z'), // >14d before NOW
  ];
  const result = computeScoutCoverage(fold(events), NOW);
  assert.equal(result.totalAttempts, 0);
  assert.equal(result.coverage, undefined);
});

test('renderAnalytics: scout warm-start coverage renders the guidance line and an empty state on a fresh ledger', () => {
  const empty = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, PROBE_EXTRAS);
  assert.match(empty, /Scout warm-start coverage/);
  assert.match(empty, /No build attempts in the window yet/);

  const events = [
    makeEvent('scout', 'WI-260', 'item.briefed', { brief: 'context pack' }, '2026-07-01T00:00:00.000Z'),
    makeEvent('dispatch', 'WI-260', 'build.dispatched', { attempt: 1 }, '2026-07-01T00:01:00.000Z'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, PROBE_EXTRAS);
  assert.match(html, /Build attempts: <strong>1<\/strong>/);
  assert.match(html, /Warm-started \(scout brief present\): <strong>1<\/strong>/);
  assert.match(html, /Coverage: <strong>100\.0%<\/strong>/);
  assert.match(html, /coverage rising and first-pass merges improving is the healthy direction/);
});

// ---------------------------------------------------------------------------
// Page legend + provenance
// ---------------------------------------------------------------------------

test('renderAnalytics: carries a native-details how-to-read legend defining panes and loop labels', () => {
  const html = renderAnalytics(fold([]), NOW, [], URL_DEFAULT, PROBE_EXTRAS);
  assert.match(html, /<details class="analytics-legend">/);
  assert.match(html, /How to read this page/);
  assert.match(html, /Loop labels/);
  // The autonomy kill-switch legend row — env var + where it lives.
  assert.match(html, /Operational controls/);
  assert.match(html, /LOOPKIT_AUTONOMY/);
  assert.match(html, /\.ai\/loops\/config\.env/);
  // No client JS involved — the legend must be a native details element, no script hooks.
  assert.ok(!html.includes('data-legend'));
});

test('renderAnalytics: ends with the provenance footer carrying fold metadata and CLI equivalents', () => {
  const events = costLedger();
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, PROBE_EXTRAS);
  assert.match(html, /opsui-provenance/);
  assert.match(html, /2 ledger event\(s\)/);
  assert.match(html, /generated 2026-07-02T00:00:00\.000Z/);
  assert.match(html, /loopctl execution-config/);
  assert.match(html, /loopctl routing/);
  // The footer renders after every card.
  assert.ok(html.indexOf('opsui-provenance') > html.indexOf('Salvage activity'));
});

test('renderAnalytics: repairs card lists only items with more than one attempt', () => {
  const events = [
    makeEvent('cli', 'WI-090', 'item.captured', { source: 'cli', text: 'retried work' }, '2026-07-01T10:00:00.000Z'),
    makeEvent('dispatch', 'WI-090', 'build.dispatched', { attempt: 1 }, '2026-07-01T10:01:00.000Z'),
    makeEvent('dispatch', 'WI-090', 'build.dispatched', { attempt: 2 }, '2026-07-01T10:30:00.000Z'),
    makeEvent('cli', 'WI-091', 'item.captured', { source: 'cli', text: 'clean work' }, '2026-07-01T11:00:00.000Z'),
    makeEvent('dispatch', 'WI-091', 'build.dispatched', { attempt: 1 }, '2026-07-01T11:01:00.000Z'),
  ];
  const html = renderAnalytics(fold(events), NOW, events, URL_DEFAULT, {});
  const repairsIdx = html.indexOf('Repairs');
  const repairsSlice = html.slice(repairsIdx, html.indexOf('Cache efficiency'));
  assert.match(repairsSlice, /WI-090/);
  assert.ok(!repairsSlice.includes('WI-091'));
});
