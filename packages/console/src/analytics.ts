/**
 * analytics.ts — the console's Analytics view (/analytics): the plane-generic observability
 * board. Pure render functions from the ledger (fold + foldCosts + verdict/trajectory
 * projections, all from @loopkit/core) to an HTML string — no CLI shell-outs. Filesystem
 * probes are limited to what the server hands in (segment listing + quarantine count) PLUS
 * the three point-in-time probe panes that are definitionally not ledger projections
 * (provider-chain health markers, worker run-artifact manifests, the routing config) — each
 * is read behind a safe try/catch default AND injectable via `AnalyticsExtras`, so tests stay
 * hermetic and a machine with no plane home renders honest unknown/empty states.
 *
 * Time-window discipline (the page's core contract):
 *   - FOLLOW-THE-PICKER widgets (spend, token usage, daily trend) re-scope to `?window=`
 *     (chips 24h/7d/30d/all; any Nm/Nh/Nd duration works typed into the URL).
 *   - FAST-LANE widgets (cache efficiency) get their own shorter `?cache=` picker (5m/1h/24h)
 *     matching the collector's bucket granularity.
 *   - LABEL-ONLY widgets are never filtered but always SAY their interval: statistical
 *     aggregates caption their fixed trailing window, cumulative counters say "all-time",
 *     point-in-time probes say "live", recency lists say "last N".
 * Every window string comes from the ONE shared parser (`parseTimeWindow`, @loopkit/ui) —
 * no view-local re-parse of the grammar.
 *
 * Quota-not-dollars: operators pay in subscription quota, so quota surfaces lead with
 * percent + resets, tokens second, and show $ only as a labeled API-equivalent estimate.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  FoldResult,
  ItemRecord,
  LedgerEvent,
  foldCosts,
  projectVerdicts,
  projectTrajectory,
  formatQuotaWindowLabel,
  buildRoutingTableWithSpecs,
  mergeRoutingConfig,
  ROUTING_CONFIG_DEFAULTS,
  loadConfig,
  resolvePlaneHome,
  makeRegistry,
  makeFileHealthFns,
} from '@loopkit/core';
import type {
  CostSummary,
  CostRow,
  QuotaWindowRow,
  CacheEfficiencyBucket,
  RoutingConfig,
  SpecBucket,
  ProviderProbeResult,
  ProviderHealthStatus,
} from '@loopkit/core';
import { Card, StatusBadge, WindowPicker, parseTimeWindow, windowCutoffMs, FOLLOW_WINDOW_OPTIONS, FAST_WINDOW_OPTIONS } from '@loopkit/ui';
import type { OperationalState, TimeWindowSpec } from '@loopkit/ui';
import { esc, page, emptyState } from './html.js';
import type { SegmentInfo } from './views.js';
import { renderStatusStrip } from './views.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDurationMs(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtMinutes(min: number): string {
  if (min >= 1440) return `${(min / 1440).toFixed(1)}d`;
  if (min >= 60) return `${(min / 60).toFixed(1)}h`;
  return `${Math.round(min)}m`;
}

/** A one-line interval caption — every pane states the window its numbers cover (or that
 *  they are live/cumulative), so no table silently mixes time bases. */
function intervalCaption(text: string): string {
  return `<p class="analytics-caption">${esc(text)}</p>`;
}

const NUM = 'class="analytics-num"';

// ---------------------------------------------------------------------------
// Window plumbing (ONE parser — parseTimeWindow — feeds both pickers)
// ---------------------------------------------------------------------------

const PAGE_WINDOW_DEFAULT = '7d';
const CACHE_WINDOW_DEFAULT = '1h';

/** Query params to preserve on a picker's chips: everything except the picker's own param. */
function pickerExtraQuery(url: URL, ownParam: string): string {
  const params = new URLSearchParams(url.search);
  params.delete(ownParam);
  return params.toString();
}

function followPicker(url: URL, active: string): string {
  return WindowPicker({ active, options: FOLLOW_WINDOW_OPTIONS, extraQuery: pickerExtraQuery(url, 'window') });
}

function cachePicker(url: URL, active: string): string {
  return WindowPicker({ active, options: FAST_WINDOW_OPTIONS, param: 'cache', extraQuery: pickerExtraQuery(url, 'cache') });
}

/** cost.usage events inside the window (null cutoff = all of them). */
function costEventsInWindow(events: LedgerEvent[], cutoffMs: number | null): LedgerEvent[] {
  return events.filter((e) => {
    if (e.type !== 'cost.usage') return false;
    if (cutoffMs === null) return true;
    const ts = Date.parse(e.ts);
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
}

// ---------------------------------------------------------------------------
// Spend (follow-the-picker)
// ---------------------------------------------------------------------------

/** Loops that ARE the autonomy plane (beats + the workers they spawn). Everything else that
 *  reports usage groups as interactive (an operator's own sessions) or other. */
const PLANE_LOOPS = new Set(['reactor', 'dispatch', 'scout', 'builder', 'judge']);

interface LaneRow {
  label: string;
  tokens: number;
  usd: number;
  calls: number;
}

/** Group per-loop cost rows into operator-meaningful lanes. Exposed for tests. */
export function laneRowsFromLoops(byLoop: CostRow[]): LaneRow[] {
  const lanes = new Map<string, LaneRow>();
  const bump = (label: string, r: CostRow) => {
    const row = lanes.get(label) ?? { label, tokens: 0, usd: 0, calls: 0 };
    row.tokens += r.tokens;
    row.usd += r.usd;
    row.calls += r.calls;
    lanes.set(label, row);
  };
  for (const r of byLoop) {
    if (r.key === 'interactive') bump('Interactive (operator sessions)', r);
    else if (PLANE_LOOPS.has(r.key)) bump('Autonomy plane', r);
    else bump('Other', r);
  }
  return [...lanes.values()].sort((a, b) => b.usd - a.usd);
}

function costTable(headers: [string, string, string, string], rows: string[]): string {
  return (
    `<table class="analytics-table">` +
    `<thead><tr><th>${esc(headers[0])}</th><th ${NUM}>${esc(headers[1])}</th><th ${NUM}>${esc(headers[2])}</th><th ${NUM}>${esc(headers[3])}</th></tr></thead>` +
    `<tbody>${rows.length ? rows.join('') : `<tr><td colspan="4" class="empty">no usage events in this window</td></tr>`}</tbody></table>`
  );
}

function costRowHtml(label: string, r: { tokens: number; usd: number; calls: number }): string {
  return (
    `<tr><td>${esc(label)}</td>` +
    `<td ${NUM}>${esc(fmtNum(r.tokens))}</td>` +
    `<td ${NUM}>${esc(fmtUsd(r.usd))}</td>` +
    `<td ${NUM}>${esc(String(r.calls))}</td></tr>`
  );
}

function spendCard(windowed: CostSummary, spec: TimeWindowSpec, url: URL): string {
  const lanes = laneRowsFromLoops(windowed.byLoop);
  const totalLine =
    `<p class="analytics-total">${esc(spec.label)}: ${esc(fmtNum(windowed.totalTokens))} tokens · ` +
    `${esc(fmtUsd(windowed.totalUsd))} · ${esc(String(windowed.totalCalls))} call(s)</p>`;

  const body =
    intervalCaption(`Interval: ${spec.label}. $ figures are an API-equivalent estimate — usage is metered against a subscription, not billed per call.`) +
    totalLine +
    `<p class="analytics-subhead">By lane (${esc(spec.label)})</p>` +
    costTable(['Lane', 'Tokens', 'USD', 'Calls'], lanes.map((l) => costRowHtml(l.label, l))) +
    `<p class="analytics-subhead">By loop (${esc(spec.label)})</p>` +
    costTable(['Loop', 'Tokens', 'USD', 'Calls'], windowed.byLoop.map((r) => costRowHtml(r.key, r)));

  return Card({
    title: 'Spend',
    subtitle: 'Who is spending what — by lane and by loop',
    headerAside: followPicker(url, spec.key),
    body,
  });
}

// ---------------------------------------------------------------------------
// Daily spend + cost trend (follow-the-picker)
// ---------------------------------------------------------------------------

function sparkline(points: { key: string; usd: number }[]): string {
  if (points.length < 2) {
    return `<p class="empty">Not enough daily data for a trend line (need at least 2 days).</p>`;
  }
  const W = 200, H = 48, PAD = 3;
  const maxUsd = Math.max(...points.map((p) => p.usd), 0.001);
  const n = points.length;
  const xs = points.map((_, i) => PAD + (i / (n - 1)) * (W - PAD * 2));
  const ys = points.map((p) => PAD + (1 - p.usd / maxUsd) * (H - PAD * 2));
  const linePoints = xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ');
  const areaPoints = [
    `${xs[0]!.toFixed(1)},${(H - PAD).toFixed(1)}`,
    ...xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`),
    `${xs[n - 1]!.toFixed(1)},${(H - PAD).toFixed(1)}`,
  ].join(' ');
  const svg =
    `<svg class="analytics-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polygon class="analytics-svg-area" points="${areaPoints}"/>` +
    `<polyline class="analytics-svg-line" points="${linePoints}"/>` +
    `</svg>`;
  return (
    `<div class="analytics-chart">${svg}` +
    `<div class="analytics-chart-dates"><span>${esc(points[0]!.key.slice(5))}</span><span>${esc(points[n - 1]!.key.slice(5))}</span></div>` +
    `</div>`
  );
}

function dailySpendCard(windowed: CostSummary, spec: TimeWindowSpec, url: URL): string {
  const days = windowed.byDay;
  const dayRows = [...days].reverse().map((r) => costRowHtml(r.key, r));
  const body =
    intervalCaption(`Interval: ${spec.label}, bucketed by day (newest first).`) +
    sparkline(days) +
    costTable(['Day', 'Tokens', 'USD', 'Calls'], dayRows);
  return Card({
    title: 'Daily spend',
    subtitle: 'Per-day totals + cost trend',
    headerAside: followPicker(url, spec.key),
    body,
  });
}

// ---------------------------------------------------------------------------
// Token usage — loop × provider (follow-the-picker)
// ---------------------------------------------------------------------------

interface LoopProviderRow {
  loop: string;
  provider: string;
  tokens: number;
  usd: number;
  calls: number;
}

/** Cross-group cost.usage by loop × provider. foldCosts groups by loop OR provider, not the
 *  cross product — this stays the only view-side aggregation of cost.usage (candidate for a
 *  core `byLoopProvider` if a second consumer appears). Exposed for tests. */
export function tokenUsageRows(costEvents: LedgerEvent[]): LoopProviderRow[] {
  const rows = new Map<string, LoopProviderRow>();
  for (const ev of costEvents) {
    if (ev.type !== 'cost.usage') continue;
    const d = ev.data as { provider?: unknown; loop?: unknown; tokens?: unknown; usd?: unknown };
    const provider = typeof d.provider === 'string' ? d.provider : 'unknown';
    const loop = typeof d.loop === 'string' ? d.loop : 'unknown';
    const tokens = typeof d.tokens === 'number' && Number.isFinite(d.tokens) ? d.tokens : 0;
    const usd = typeof d.usd === 'number' && Number.isFinite(d.usd) ? d.usd : 0;
    const key = `${loop}\u0000${provider}`;
    const row = rows.get(key) ?? { loop, provider, tokens: 0, usd: 0, calls: 0 };
    row.tokens += tokens;
    row.usd += usd;
    row.calls += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.loop.localeCompare(b.loop));
}

function tokenUsageCard(costEvents: LedgerEvent[], spec: TimeWindowSpec, url: URL): string {
  const rows = tokenUsageRows(costEvents);
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
  const rowsHtml = rows.map((r) =>
    `<tr><td>${esc(r.loop)}</td><td>${esc(r.provider)}</td>` +
    `<td ${NUM}>${esc(fmtNum(r.tokens))}</td>` +
    `<td ${NUM}>${esc(fmtUsd(r.usd))}</td></tr>`,
  );
  const foot = rows.length > 1
    ? `<tfoot><tr><td colspan="2" class="analytics-total">Total</td>` +
      `<td ${NUM}>${esc(fmtNum(totalTokens))}</td><td ${NUM}>${esc(fmtUsd(totalUsd))}</td></tr></tfoot>`
    : '';
  const table =
    `<table class="analytics-table">` +
    `<thead><tr><th>Loop</th><th>Provider</th><th ${NUM}>Tokens</th><th ${NUM}>Cost</th></tr></thead>` +
    `<tbody>${rowsHtml.length ? rowsHtml.join('') : `<tr><td colspan="4" class="empty">no usage events in this window</td></tr>`}</tbody>${foot}</table>`;
  const body =
    intervalCaption(`Interval: ${spec.label}. Cost is an API-equivalent estimate, not a billed charge.`) +
    table;
  return Card({
    title: 'Token usage',
    subtitle: 'Loop × provider breakdown',
    headerAside: followPicker(url, spec.key),
    body,
  });
}

// ---------------------------------------------------------------------------
// Quota utilization (point-in-time probe — label-only, "live")
// ---------------------------------------------------------------------------

/** Quota alert thresholds — shared meaning with the Command view's chip/banner: below
 *  `warn` quota stays out of the way, `warn`..`crit` warns, at/above `crit` is critical. */
export const QUOTA_WARN_PCT = 60;
export const QUOTA_CRIT_PCT = 85;

export function quotaBarState(usedPct: number): 'neutral' | 'warning' | 'critical' {
  if (usedPct >= QUOTA_CRIT_PCT) return 'critical';
  if (usedPct >= QUOTA_WARN_PCT) return 'warning';
  return 'neutral';
}

function quotaRowHtml(r: QuotaWindowRow): string {
  const pct = Math.max(0, Math.min(100, r.usedPct));
  const barState = quotaBarState(r.usedPct);
  const label = `${r.provider} · ${formatQuotaWindowLabel(r.window, r.windowMinutes)}`;
  const stale = r.readingAgeHours >= 24;
  const ageBadge = StatusBadge({
    state: stale ? 'warning' : 'neutral',
    label: `reading ${Math.round(r.readingAgeHours)}h old`,
    size: 'sm',
  });
  const detailParts: string[] = [];
  if (r.resetsAt) detailParts.push(`resets ${esc(r.resetsAt)}`);
  if (r.runwayDays !== undefined) detailParts.push(`runway ~${esc(r.runwayDays.toFixed(1))}d`);
  if (r.capacityTokensPerWeek !== undefined) detailParts.push(`~${esc(fmtNum(r.capacityTokensPerWeek))} tok/wk`);
  if (r.capacityUsdPerWeek !== undefined) detailParts.push(`~${esc(fmtUsd(r.capacityUsdPerWeek))}/wk (API-equivalent)`);
  const detail = detailParts.length > 0
    ? `<p class="analytics-muted">${detailParts.join(' · ')}</p>`
    : `<p class="analytics-muted">Capacity estimate pending — needs a second same-cycle reading.</p>`;
  return (
    `<div class="analytics-quota-row">` +
    `<div class="analytics-quota-head">` +
    `<span class="analytics-quota-label">${esc(label)}</span>` +
    `<span class="analytics-quota-pct">${esc(pct.toFixed(1))}%</span>` +
    `${ageBadge}` +
    `</div>` +
    `<div class="analytics-quota-bar"><div class="analytics-quota-fill analytics-quota-fill--${barState}" style="width:${pct}%"></div></div>` +
    detail +
    `</div>`
  );
}

function quotaCard(rows: QuotaWindowRow[]): string {
  const body = rows.length === 0
    ? emptyState('No quota snapshots yet', 'Quota collectors report per provider:window readings here as soon as the first quota.snapshot event lands.')
    : intervalCaption('Interval: live — latest reading per provider:window. Percent + resets first; $ figures are API-equivalent estimates, never billed charges.') +
      rows.map(quotaRowHtml).join('');
  const worst = rows.reduce((w, r) => Math.max(w, r.usedPct), 0);
  const aside = rows.length
    ? StatusBadge({ state: quotaBarState(worst) === 'neutral' ? 'success' : quotaBarState(worst), label: `worst ${worst.toFixed(0)}%` })
    : StatusBadge({ state: 'neutral', label: 'no data' });
  return `<div id="quota">${Card({
    title: 'Quota utilization',
    subtitle: 'Subscription capacity and runway per provider:window',
    headerAside: aside,
    body,
  })}</div>`;
}

// ---------------------------------------------------------------------------
// Conditional quota surfacing (Command view chip/banner)
// ---------------------------------------------------------------------------

/** "5h window" → "5h" for the compact chip. */
function shortWindowLabel(r: QuotaWindowRow): string {
  return formatQuotaWindowLabel(r.window, r.windowMinutes).replace(/ window$/, '');
}

/** "resets 14:30" when resetsAt parses as ISO; the raw string otherwise. */
function fmtResets(resetsAt: string): string {
  const ms = Date.parse(resetsAt);
  if (Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T/.test(resetsAt)) return resetsAt.slice(11, 16);
  return resetsAt;
}

export interface QuotaNotice {
  /** Compact warning chip for the glance row (worst window 60–85%). */
  chip?: string;
  /** Critical above-the-fold banner (worst window ≥ 85%). */
  banner?: string;
}

/**
 * Conditional quota surfacing for the Command view: below the warning threshold quota stays
 * OFF the page entirely (glanceable = only what needs attention — the full panel lives on
 * Analytics); 60–85% renders a compact chip; at/above 85% a critical banner with resets +
 * runway. Triggered by the WORST usedPct across provider:windows. Percent + resets lead,
 * tokens second, $ only as a labeled API-equivalent.
 */
export function quotaNotice(rows: QuotaWindowRow[], pauseThresholdPct?: number): QuotaNotice {
  let worst: QuotaWindowRow | undefined;
  for (const r of rows) {
    if (!worst || r.usedPct > worst.usedPct) worst = r;
  }
  if (!worst || worst.usedPct < QUOTA_WARN_PCT) return {};

  const label = `${worst.provider} ${shortWindowLabel(worst)}`;
  const pctText = `${worst.usedPct.toFixed(0)}%`;

  if (worst.usedPct < QUOTA_CRIT_PCT) {
    const parts = [`${label}: ${pctText}`];
    if (worst.resetsAt) parts.push(`resets ${fmtResets(worst.resetsAt)}`);
    return {
      chip: `<a class="quota-chip quota-chip--warning" href="/analytics#quota">${esc(parts.join(' · '))}</a>`,
    };
  }

  const detailParts: string[] = [];
  if (worst.resetsAt) detailParts.push(`resets ${fmtResets(worst.resetsAt)}`);
  if (worst.runwayDays !== undefined) detailParts.push(`runway ~${worst.runwayDays.toFixed(1)}d`);
  if (worst.capacityTokensPerWeek !== undefined) detailParts.push(`~${fmtNum(worst.capacityTokensPerWeek)} tok/wk capacity`);
  if (worst.capacityUsdPerWeek !== undefined) detailParts.push(`~${fmtUsd(worst.capacityUsdPerWeek)}/wk (API-equivalent)`);
  const pauseLine = pauseThresholdPct !== undefined && worst.usedPct >= pauseThresholdPct
    ? `<span class="quota-banner__pause">Dispatch pauses new builds at ${esc(String(pauseThresholdPct))}% — quota-pressure gate active.</span>`
    : '';
  return {
    banner:
      `<div class="quota-banner" role="alert">` +
      `<span class="quota-banner__headline">LLM quota critical — ${esc(label)} at ${esc(pctText)}</span>` +
      (detailParts.length ? `<span class="quota-banner__detail">${esc(detailParts.join(' · '))}</span>` : '') +
      pauseLine +
      `<a class="quota-banner__link" href="/analytics#quota">Quota panel →</a>` +
      `</div>`,
  };
}

// ---------------------------------------------------------------------------
// Judge verdicts (recency list — "last 10")
// ---------------------------------------------------------------------------

function judgeCard(events: LedgerEvent[]): string {
  const summary = projectVerdicts(events);
  let body: string;
  if (summary.total === 0) {
    body = emptyState('No verdicts yet', 'The judge reviews finished diffs and its verdicts land here.');
  } else {
    const statLine =
      `<div class="analytics-stats">` +
      `<span>Total: <strong>${esc(String(summary.total))}</strong></span>` +
      `<span>Judged fail: <strong>${esc(String(summary.judgedFail))}</strong></span>` +
      (summary.withOutcome > 0
        ? `<span>False alarms: <strong>${esc(String(summary.falseAlarm))}</strong></span>` +
          `<span>Agree (pass+accepted): <strong>${esc(String(summary.agreePass))}</strong></span>`
        : `<span class="analytics-muted">No accepted outcomes yet — false-alarm rate unmeasurable.</span>`) +
      `</div>`;
    const last10 = [...summary.rows].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
    const rowsHtml = last10.map((r) =>
      `<tr><td>${esc(r.wi)}</td>` +
      `<td><span class="analytics-verdict analytics-verdict--${esc(r.verdict)}">${esc(r.verdict)}</span></td>` +
      `<td ${NUM}>${esc(String(r.confidence))}</td>` +
      `<td>${r.outcome === 'none-yet' ? `<span class="analytics-muted">none yet</span>` : esc(r.outcome)}</td></tr>`,
    ).join('');
    body =
      intervalCaption(`Interval: last ${last10.length} verdict(s), newest first; the stats above are all-time.`) +
      statLine +
      `<table class="analytics-table">` +
      `<thead><tr><th>Item</th><th>Verdict</th><th ${NUM}>Confidence</th><th>Outcome</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`;
  }
  const aside = `<span class="analytics-tag analytics-tag--advisory">ADVISORY</span>`;
  return Card({
    title: 'Judge verdicts',
    subtitle: 'Merge-review calibration — no blocking power until the false-alarm rate proves near zero',
    headerAside: aside,
    body,
  });
}

// ---------------------------------------------------------------------------
// Repairs (point-in-time — "live")
// ---------------------------------------------------------------------------

function repairsCard(result: FoldResult): string {
  const repairs = [...result.items.values()]
    .filter((r) => r.attempts > 1)
    .sort((a, b) => b.attempts - a.attempts || a.id.localeCompare(b.id));
  let body: string;
  if (repairs.length === 0) {
    body = emptyState('No repairs', 'Items that needed more than one build attempt land here.');
  } else {
    const rowsHtml = repairs.map((r: ItemRecord) =>
      `<tr><td>${esc(r.id)}</td>` +
      `<td ${NUM}>${esc(String(r.attempts))}</td>` +
      `<td>${esc(r.state)}</td></tr>`,
    ).join('');
    body =
      intervalCaption('Interval: live — current attempt counts across the whole ledger.') +
      `<table class="analytics-table">` +
      `<thead><tr><th>Item</th><th ${NUM}>Attempts</th><th>State</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`;
  }
  const aside = StatusBadge({
    state: repairs.length > 0 ? 'warning' : 'success',
    label: `${repairs.length} repair${repairs.length !== 1 ? 's' : ''}`,
  });
  return Card({
    title: 'Repairs',
    subtitle: 'Items with attempt > 1 — retries carry the prior diff + gate log as evidence',
    headerAside: aside,
    body,
  });
}

// ---------------------------------------------------------------------------
// Cache efficiency (fast-lane picker — 5m/1h/24h)
// ---------------------------------------------------------------------------

function sumBuckets(buckets: CacheEfficiencyBucket[], cutoffMs: number | null): { uncached: number; cacheRead: number } {
  let uncached = 0;
  let cacheRead = 0;
  for (const b of buckets) {
    if (cutoffMs !== null) {
      const ts = Date.parse(b.bucketStart);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    }
    uncached += b.uncachedTokens;
    cacheRead += b.cacheReadTokens;
  }
  return { uncached, cacheRead };
}

function cacheEfficiencyCard(costs: CostSummary, spec: TimeWindowSpec, now: Date, url: URL): string {
  const cutoff = windowCutoffMs(spec, now.getTime());
  let body: string;
  if (costs.cacheEfficiency.length === 0) {
    body = emptyState('No usage events yet', 'Cache-read hit rates per loop appear once cost.usage events land.');
  } else {
    // ≤1h windows read the 5-minute buckets; wider windows the hourly ones.
    const useFine = spec.ms !== null && spec.ms <= 3_600_000;
    const rowsHtml = costs.cacheEfficiency.map((row) => {
      if (!row.cacheInstrumented) {
        return `<tr><td>${esc(row.loop)}</td><td colspan="3"><span class="analytics-muted">not instrumented — this loop's collector does not split cache reads out</span></td></tr>`;
      }
      const { uncached, cacheRead } = sumBuckets(useFine ? row.buckets5m : row.buckets1h, cutoff);
      const total = uncached + cacheRead;
      const hit = total > 0
        ? esc(fmtPct(cacheRead / total))
        : `<span class="analytics-muted">no traffic in window</span>`;
      return (
        `<tr><td>${esc(row.loop)}</td>` +
        `<td ${NUM}>${hit}</td>` +
        `<td ${NUM}>${esc(fmtNum(cacheRead))}</td>` +
        `<td ${NUM}>${esc(fmtNum(total))}</td></tr>`
      );
    }).join('');
    body =
      intervalCaption(`Interval: ${spec.label}, from the collector's ${useFine ? '5-minute' : 'hourly'} buckets. Loops whose collectors merge cache reads into one input figure show "not instrumented" — never a fabricated zero.`) +
      `<table class="analytics-table">` +
      `<thead><tr><th>Loop</th><th ${NUM}>Cache hit %</th><th ${NUM}>Cache-read tokens</th><th ${NUM}>Total tokens</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`;
  }
  return Card({
    title: 'Cache efficiency',
    subtitle: 'Prompt-cache read hit rate per loop',
    headerAside: cachePicker(url, spec.key),
    body,
  });
}

// ---------------------------------------------------------------------------
// Pipeline latency (fixed trailing window, labeled) + routing-latency SLO row
// ---------------------------------------------------------------------------

/** Intent-routing SLO: an intent should get its first reply within this many minutes. */
export const ROUTING_TARGET_MIN = 15;
const ROUTING_WIDE_DAYS = 7;
const ROUTING_RECENT_HOURS = 24;

export interface RoutingLatencySummary {
  medianMin?: number;
  /** Worst first-reply latency across the wide (7d) window. */
  worstMin?: number;
  /** Worst first-reply latency across the recent (24h) window — drives red. */
  worst24hMin?: number;
  sampled: number;
  pending: number;
  status: 'met' | 'at-risk' | 'breached' | 'unknown';
}

/**
 * First-reply latency per item: first inbound (item.captured or msg.in) → first msg.out at
 * or after it. Recency-weighted status: only a breach inside the last 24h reads red; a breach
 * that exists only in the wider 7d window has already gone stale and decays to amber — one
 * old slow reply must not keep the row red for a week.
 */
export function computeRoutingLatency(events: LedgerEvent[], nowMs: number): RoutingLatencySummary {
  const firstIn = new Map<string, number>();
  const firstOut = new Map<string, number>();
  for (const ev of events) {
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts)) continue;
    if (ev.type === 'item.captured' || ev.type === 'msg.in') {
      const prior = firstIn.get(ev.item);
      if (prior === undefined || ts < prior) firstIn.set(ev.item, ts);
    } else if (ev.type === 'msg.out') {
      const prior = firstOut.get(ev.item);
      if (prior === undefined || ts < prior) firstOut.set(ev.item, ts);
    }
  }

  const wideMs = ROUTING_WIDE_DAYS * 86_400_000;
  const recentMs = ROUTING_RECENT_HOURS * 3_600_000;
  const latencies: number[] = [];
  const recentLatencies: number[] = [];
  let pending = 0;
  for (const [item, inMs] of firstIn) {
    const age = nowMs - inMs;
    if (age > wideMs) continue;
    const outMs = firstOut.get(item);
    if (outMs === undefined || outMs < inMs) {
      pending++;
      continue;
    }
    const mins = (outMs - inMs) / 60_000;
    latencies.push(mins);
    if (age <= recentMs) recentLatencies.push(mins);
  }

  if (latencies.length === 0) {
    return { sampled: 0, pending, status: pending > 0 ? 'at-risk' : 'unknown' };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const medianMin = sorted[Math.floor((sorted.length - 1) / 2)]!;
  const worstMin = Math.max(...sorted);
  const worst24hMin = recentLatencies.length > 0 ? Math.max(...recentLatencies) : undefined;
  const status: RoutingLatencySummary['status'] =
    worst24hMin !== undefined && worst24hMin > ROUTING_TARGET_MIN ? 'breached'
    : worstMin > ROUTING_TARGET_MIN ? 'at-risk'
    : 'met';
  return { medianMin, worstMin, ...(worst24hMin !== undefined ? { worst24hMin } : {}), sampled: latencies.length, pending, status };
}

function sloStatusToOperational(status: RoutingLatencySummary['status']): OperationalState {
  switch (status) {
    case 'met': return 'success';
    case 'at-risk': return 'warning';
    case 'breached': return 'critical';
    default: return 'neutral';
  }
}

function pipelineLatencyCard(costs: CostSummary, events: LedgerEvent[], now: Date): string {
  const data = costs.pipelineLatency;
  const routing = computeRoutingLatency(events, now.getTime());

  const routingValue = routing.sampled === 0
    ? (routing.pending > 0 ? `${routing.pending} awaiting first reply` : 'no traffic')
    : `median ${fmtMinutes(routing.medianMin!)} · worst ${fmtMinutes(routing.worstMin!)} (${ROUTING_WIDE_DAYS}d)`;
  const routingRow =
    `<div class="analytics-slo-row">` +
    `<span class="analytics-slo-label">Intent routing latency (${ROUTING_WIDE_DAYS}d)</span>` +
    `<span class="analytics-slo-value">${esc(routingValue)}</span>` +
    `<span class="analytics-slo-target">target: worst ≤ ${ROUTING_TARGET_MIN}m (${ROUTING_RECENT_HOURS}h)</span>` +
    StatusBadge({ state: sloStatusToOperational(routing.status), label: routing.status, size: 'sm' }) +
    `</div>`;

  const stagesHtml = data.stages.length === 0
    ? emptyState('No merged items with complete stage timestamps in the window yet')
    : `<table class="analytics-table">` +
      `<thead><tr><th>Stage</th><th ${NUM}>Samples</th><th ${NUM}>Median</th><th ${NUM}>p90</th></tr></thead>` +
      `<tbody>${data.stages.map((s) =>
        `<tr><td>${esc(s.name)}</td>` +
        `<td ${NUM}>${esc(String(s.samples))}</td>` +
        `<td ${NUM}>${esc(fmtDurationMs(s.medianMs))}</td>` +
        `<td ${NUM}>${esc(fmtDurationMs(s.p90Ms))}</td></tr>`).join('')}</tbody></table>`;

  const body =
    intervalCaption(`Interval: trailing ${data.window.days}d (${data.window.from.slice(0, 10)} – ${data.window.to.slice(0, 10)}); routing status reads red only on a breach inside the last ${ROUTING_RECENT_HOURS}h — older breaches within ${ROUTING_WIDE_DAYS}d decay to amber.`) +
    routingRow +
    stagesHtml;

  return Card({
    title: 'Pipeline latency',
    subtitle: 'First reply + stage-transition timing (median · p90)',
    body,
  });
}

// ---------------------------------------------------------------------------
// Trajectory (statistical aggregate — fixed trailing window, labeled)
// ---------------------------------------------------------------------------

function trajectoryCard(events: LedgerEvent[], now: Date): string {
  const t = projectTrajectory(events, { now: now.toISOString() });
  let body: string;
  if (t.aggregates.attempts === 0) {
    body = emptyState('No build attempts in the window yet', 'Velocity and quality aggregates appear once builds dispatch.');
  } else {
    const a = t.aggregates;
    const cells: [string, string][] = [
      ['First-pass merge rate', fmtPct(a.firstPassMergeRate)],
      ['Repair merge rate', fmtPct(a.repairMergeRate)],
      ['Avg cost / merged item (API-equivalent)', fmtUsd(a.avgUsdPerMergedItem)],
      ['Avg turns / attempt', a.avgTurnsPerAttempt.toFixed(1)],
      ['Avg attempt duration', `${a.avgDurationMinutes.toFixed(1)}m`],
      ['Scout brief coverage', fmtPct(a.scoutCoverage)],
      ['Judge fail share', fmtPct(a.judgeFailShare)],
    ];
    body =
      intervalCaption(`Interval: trailing ${t.window.days}d (${t.window.from.slice(0, 10)} – ${t.window.to.slice(0, 10)}) — fixed window for sample-size stability, not filtered by the page picker.`) +
      `<table class="analytics-table">` +
      `<thead><tr><th>Metric</th><th ${NUM}>Value</th></tr></thead>` +
      `<tbody>${cells.map(([label, value]) => `<tr><td>${esc(label)}</td><td ${NUM}>${esc(value)}</td></tr>`).join('')}</tbody></table>`;
  }
  return Card({
    title: 'Trajectory',
    subtitle: 'Aggregate velocity and quality across attempts',
    body,
  });
}

// ---------------------------------------------------------------------------
// Ledger hygiene (point-in-time — "live")
// ---------------------------------------------------------------------------

function ledgerHygieneCard(segments: SegmentInfo[], quarantinedCount: number | null | undefined): string {
  const totalBytes = segments.reduce((s, seg) => s + seg.bytes, 0);
  const body =
    intervalCaption('Interval: live — current segment files and quarantine list.') +
    `<div class="analytics-stats">` +
    `<span>Quarantined events: <strong>${quarantinedCount === null || quarantinedCount === undefined ? '—' : esc(String(quarantinedCount))}</strong></span>` +
    `<span>Segments: <strong>${esc(String(segments.length))}</strong></span>` +
    `<span>Total size: <strong>${esc((totalBytes / 1024).toFixed(1))} KB</strong></span>` +
    `</div>` +
    `<p class="analytics-muted">Telemetry segments archive when old; work-item segments never compact — the raw event log stays the truth. A quarantined count above zero means malformed events were silenced, never that the fold is wrong.</p>`;
  return Card({
    title: 'Ledger hygiene',
    subtitle: 'Quarantine · segment sizes · archive discipline',
    body,
  });
}

// ---------------------------------------------------------------------------
// Salvage activity (recency list — "last 10")
// ---------------------------------------------------------------------------

interface SalvageEntry {
  item: string;
  attempt: number;
  reason: string;
  detail: string;
  kind: 'patch' | 'too-large' | 'none' | 'error';
  ts: string;
}

/** Salvage trail messages are appended as msg.out events by the dispatcher when a worker is
 *  interrupted (`attempt N interrupted (<reason>) — <detail>`). Parsed from the ledger — the
 *  console never reads the runs directory the patch files live in. Exposed for tests. */
export function salvageEntries(events: LedgerEvent[]): SalvageEntry[] {
  const entries: SalvageEntry[] = [];
  const re = /^attempt (\d+) interrupted \(([^)]*)\) — (.*)$/;
  for (const ev of events) {
    if (ev.type !== 'msg.out') continue;
    const text = (ev.data as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    const m = re.exec(text);
    if (!m) continue;
    const detail = m[3]!;
    const kind: SalvageEntry['kind'] = detail.includes('too large') ? 'too-large'
      : detail.includes('no uncommitted changes') ? 'none'
      : detail.startsWith('salvaged') ? 'patch'
      : 'error';
    entries.push({ item: ev.item, attempt: Number(m[1]), reason: m[2]!, detail, kind, ts: ev.ts });
  }
  return entries.sort((a, b) => b.ts.localeCompare(a.ts));
}

function salvageCard(events: LedgerEvent[]): string {
  const entries = salvageEntries(events).slice(0, 10);
  let body: string;
  if (entries.length === 0) {
    body = emptyState('No interrupted attempts', 'When a worker is interrupted before committing, its uncommitted diff is captured and the retry pre-applies it as a suspect draft.');
  } else {
    const kindClass: Record<SalvageEntry['kind'], string> = {
      patch: 'analytics-tag--ok',
      'too-large': 'analytics-tag--warn',
      none: 'analytics-tag--muted',
      error: 'analytics-tag--warn',
    };
    const rowsHtml = entries.map((e) =>
      `<tr><td>${esc(e.item)}</td>` +
      `<td ${NUM}>${esc(String(e.attempt))}</td>` +
      `<td>${esc(e.reason)}</td>` +
      `<td><span class="analytics-tag ${kindClass[e.kind]}">${esc(e.kind)}</span></td>` +
      `<td class="analytics-muted">${esc(e.ts.slice(0, 16).replace('T', ' '))}</td></tr>`,
    ).join('');
    body =
      intervalCaption(`Interval: last ${entries.length} interruption(s), newest first.`) +
      `<table class="analytics-table">` +
      `<thead><tr><th>Item</th><th ${NUM}>Attempt</th><th>Reason</th><th>Outcome</th><th>When</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`;
  }
  return Card({
    title: 'Salvage activity',
    subtitle: 'Uncommitted partial work captured from interrupted attempts',
    body,
  });
}

// ---------------------------------------------------------------------------
// Execution config (statistical aggregate — fixed trailing window, labeled)
// ---------------------------------------------------------------------------

/**
 * Structural mirror of @loopkit/core's execution-config projection output. The projection
 * module (executionConfig.ts) exists in the core package but is not yet re-exported from its
 * package root, so the shapes are declared structurally here and the function is loaded from
 * the installed package's dist by file URL below. When core exports projectExecutionConfig
 * from its index, this block collapses to a plain named import.
 */
interface ExecutionConfigCellShape {
  model: string;
  n: number;
  acceptRate?: number;
  firstPassGateRate?: number;
  costPerAcceptedUsd?: number;
  retriesPerAccept?: number;
  merged: number;
  accepted: number;
  gated: number;
  gatedFirstPass: number;
  totalUsd: number;
  totalRetries: number;
}

interface ExecutionConfigProjectionShape {
  minSamples: number;
  window: { days: number; from: string; to: string };
  cells: ExecutionConfigCellShape[];
}

type ProjectExecutionConfigFn = (
  events: LedgerEvent[],
  opts?: { days?: number; now?: string; minSamples?: number },
) => ExecutionConfigProjectionShape;

/** Loaded once at module init; null when the core build does not carry the module. A file-URL
 *  import sidesteps the package exports map without touching any core source. */
const projectExecutionConfigFn: ProjectExecutionConfigFn | null = await (async () => {
  try {
    const req = createRequire(import.meta.url);
    const corePkgJson = req.resolve('@loopkit/core/package.json');
    const modUrl = pathToFileURL(join(dirname(corePkgJson), 'dist', 'executionConfig.js')).href;
    const mod = (await import(modUrl)) as { projectExecutionConfig?: ProjectExecutionConfigFn };
    return typeof mod.projectExecutionConfig === 'function' ? mod.projectExecutionConfig : null;
  } catch {
    return null;
  }
})();

function execCell(value: string, muted = false): string {
  return muted ? `<span class="analytics-muted">${value}</span>` : value;
}

function executionConfigCard(events: LedgerEvent[], nowIso: string): string {
  let body: string;
  if (!projectExecutionConfigFn) {
    body = emptyState(
      'Execution-config projection unavailable',
      'The installed @loopkit/core build does not carry the execution-config projection module — rebuild the core package.',
    );
  } else {
    const p = projectExecutionConfigFn(events, { now: nowIso });
    if (p.cells.length === 0) {
      body =
        intervalCaption(`Interval: trailing ${p.window.days}d (${p.window.from.slice(0, 10)} – ${p.window.to.slice(0, 10)}) — fixed window, not filtered by the page picker.`) +
        emptyState('No attributable builds in the window yet', 'Rows appear once builds dispatch with a model recorded on the first attempt.');
    } else {
      const rowsHtml = p.cells.map((c) => {
        const small = c.n < p.minSamples;
        const modelCell = small
          ? `${esc(c.model)} <span class="analytics-muted">(n&lt;${esc(String(p.minSamples))} — counts only)</span>`
          : esc(c.model);
        // Sub-sample rows show raw counts only — never a ratio computed over a handful of items.
        const acceptCell = small
          ? execCell(`${esc(String(c.accepted))}/${esc(String(c.merged))} accepted`, true)
          : execCell(c.acceptRate === undefined ? '—' : esc(fmtPct(c.acceptRate)), c.acceptRate === undefined);
        const gateCell = small
          ? execCell(`${esc(String(c.gatedFirstPass))}/${esc(String(c.gated))} first-pass`, true)
          : execCell(c.firstPassGateRate === undefined ? '—' : esc(fmtPct(c.firstPassGateRate)), c.firstPassGateRate === undefined);
        const costCell = small
          ? execCell(`${esc(fmtUsd(c.totalUsd))} total`, true)
          : execCell(c.costPerAcceptedUsd === undefined ? '—' : esc(fmtUsd(c.costPerAcceptedUsd)), c.costPerAcceptedUsd === undefined);
        const retriesCell = small
          ? execCell(`${esc(String(c.totalRetries))} total`, true)
          : execCell(c.retriesPerAccept === undefined ? '—' : esc(c.retriesPerAccept.toFixed(1)), c.retriesPerAccept === undefined);
        return (
          `<tr><td>${modelCell}</td>` +
          `<td ${NUM}>${esc(String(c.n))}</td>` +
          `<td ${NUM}>${acceptCell}</td>` +
          `<td ${NUM}>${gateCell}</td>` +
          `<td ${NUM}>${costCell}</td>` +
          `<td ${NUM}>${retriesCell}</td></tr>`
        );
      }).join('');
      body =
        intervalCaption(`Interval: trailing ${p.window.days}d (${p.window.from.slice(0, 10)} – ${p.window.to.slice(0, 10)}) — fixed window, not filtered by the page picker. Rows under n=${p.minSamples} show raw counts only; a ratio over a handful of items would be noise dressed as signal.`) +
        `<table class="analytics-table">` +
        `<thead><tr><th>Model</th><th ${NUM}>n</th><th ${NUM}>Accept rate</th><th ${NUM}>First-pass gate</th><th ${NUM}>Cost / accept</th><th ${NUM}>Retries / accept</th></tr></thead>` +
        `<tbody>${rowsHtml}</tbody></table>`;
    }
  }
  return Card({
    title: 'Execution config',
    subtitle: 'Which execution configuration actually produces accepted outcomes — per model, whole items attributed to their first attempt',
    body,
  });
}

// ---------------------------------------------------------------------------
// Routing calibration (statistical aggregate — fixed trailing window, labeled)
// ---------------------------------------------------------------------------

/** Safe config default for callers that don't inject one: merged routing config from the
 *  plane's loadConfig, falling back to shipped defaults when no config is reachable. */
function safeRoutingConfig(): Required<RoutingConfig> {
  try {
    return mergeRoutingConfig(loadConfig(process.cwd()).routing, ROUTING_CONFIG_DEFAULTS);
  } catch {
    return { ...ROUTING_CONFIG_DEFAULTS };
  }
}

const BUCKET_LABELS: Record<SpecBucket, string> = {
  small: 'small (<1500 chars)',
  medium: 'medium (<6000 chars)',
  large: 'large (≥6000 chars)',
};

function routingModeTag(mode: Required<RoutingConfig>['mode']): string {
  const cls = mode === 'active' ? 'analytics-tag--ok' : mode === 'advisory' ? 'analytics-tag--advisory' : 'analytics-tag--muted';
  return `<span class="analytics-tag ${cls}">${esc(mode.toUpperCase())}</span>`;
}

function routingCard(result: FoldResult, events: LedgerEvent[], cfg: Required<RoutingConfig>, nowIso: string): string {
  const trajectory = projectTrajectory(events, { days: cfg.windowDays, now: nowIso });
  const specsByWi = new Map<string, string | undefined>(
    [...result.items.entries()].map(([id, r]) => [id, r.spec ?? r.sourceText]),
  );
  const table = buildRoutingTableWithSpecs(trajectory.attempts, specsByWi, { windowDays: cfg.windowDays, now: nowIso });

  const rows: string[] = [];
  for (const bucket of ['small', 'medium', 'large'] as SpecBucket[]) {
    const cells = Object.entries(table[bucket]).sort((a, b) => b[1].samples - a[1].samples || a[0].localeCompare(b[0]));
    for (const [model, cell] of cells) {
      const under = cell.samples < cfg.minSamples;
      rows.push(
        `<tr><td>${esc(BUCKET_LABELS[bucket])}</td>` +
        `<td>${esc(model)}</td>` +
        `<td ${NUM}>${esc(String(cell.samples))}${under ? ` <span class="analytics-muted">(&lt;${esc(String(cfg.minSamples))})</span>` : ''}</td>` +
        `<td ${NUM}>${esc(fmtPct(cell.firstPassRate))}</td>` +
        `<td ${NUM}>${esc(fmtUsd(cell.avgUsd))}</td></tr>`,
      );
    }
  }

  const body = rows.length === 0
    ? intervalCaption(`Interval: trailing ${cfg.windowDays}d of build attempts — fixed window, not filtered by the page picker.`) +
      emptyState('No routed attempts in the window yet', 'The calibration table fills as builds dispatch with a model recorded per attempt.')
    : intervalCaption(`Interval: trailing ${cfg.windowDays}d of build attempts — fixed window, not filtered by the page picker. Mode '${cfg.mode}': advisory records what active would pick without acting on it; a cell needs ≥ ${cfg.minSamples} samples before active mode may choose it.`) +
      `<table class="analytics-table">` +
      `<thead><tr><th>Spec bucket</th><th>Model</th><th ${NUM}>Samples</th><th ${NUM}>First-pass rate</th><th ${NUM}>Avg cost</th></tr></thead>` +
      `<tbody>${rows.join('')}</tbody></table>`;

  return Card({
    title: 'Routing',
    subtitle: 'Model-routing calibration — spec-size bucket × model, from build attempts',
    headerAside: routingModeTag(cfg.mode),
    body,
  });
}

// ---------------------------------------------------------------------------
// Provider-chain health (point-in-time probe — "live")
// ---------------------------------------------------------------------------

/** Map provider-chain status onto the page's ONE colour-meaning source: the SLO status
 *  vocabulary, which sloStatusToOperational then turns into a badge state. Exposed for tests. */
export function providerStatusToSlo(status: ProviderHealthStatus | undefined): RoutingLatencySummary['status'] {
  switch (status) {
    case 'primary-healthy': return 'met';
    case 'fallback-active': return 'at-risk';
    case 'all-unhealthy': return 'breached';
    default: return 'unknown';
  }
}

const PROVIDER_STATUS_LABEL: Record<ProviderHealthStatus, string> = {
  'primary-healthy': 'primary healthy',
  'fallback-active': 'running on fallback',
  'all-unhealthy': 'no healthy provider',
};

/**
 * Live provider-chain readout for callers that don't inject one: resolve the plane's provider
 * registry from config + on-disk health markers and walk the reference ('internal') chain —
 * the same circuit-breaker walk the beats use for their SLO probe. Reads health markers only;
 * sends nothing anywhere. Returns null (→ honest unknown) when no plane config is reachable.
 */
function safeProviderChainHealth(): ProviderProbeResult | null {
  try {
    const cfg = loadConfig(process.cwd());
    const planeHome = resolvePlaneHome({ warn: () => { /* quiet in a render path */ } });
    const runDir = join(planeHome.runsDir, 'loopkit');
    const reg = makeRegistry({
      providers: Object.fromEntries(
        Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }]),
      ),
      sensitivityAllowlists: cfg.sensitivityAllowlists,
      chains: cfg.chains,
      cooldownMs: cfg.providerCooldownMs,
    }, makeFileHealthFns(runDir));

    const chain = reg.chainFor('internal');
    if (chain.length === 0) return { status: 'all-unhealthy' };
    const primary = chain[0]!;
    if (!reg.isUnhealthy(primary)) return { status: 'primary-healthy', primaryProvider: primary, activeProvider: primary };
    const allowed = reg.allowedProviders('internal');
    for (let i = 1; i < chain.length; i++) {
      const name = chain[i]!;
      if (!allowed.includes(name)) continue;
      if (!reg.isUnhealthy(name)) {
        return { status: 'fallback-active', primaryProvider: primary, activeProvider: name };
      }
    }
    return { status: 'all-unhealthy', primaryProvider: primary };
  } catch {
    return null;
  }
}

function providerChainCard(probe: ProviderProbeResult | null): string {
  let body: string;
  let aside: string;
  if (!probe) {
    body =
      intervalCaption('Interval: live — resolved from on-disk provider health markers at render time.') +
      emptyState('Provider health unknown', 'No provider chain could be resolved — plane config is not reachable from this process.');
    aside = StatusBadge({ state: 'neutral', label: 'unknown' });
  } else {
    const opState = sloStatusToOperational(providerStatusToSlo(probe.status));
    const label = PROVIDER_STATUS_LABEL[probe.status];
    aside = StatusBadge({ state: opState, label });
    const detailParts: string[] = [];
    if (probe.primaryProvider) detailParts.push(`primary: <strong>${esc(probe.primaryProvider)}</strong>`);
    if (probe.activeProvider) detailParts.push(`active: <strong>${esc(probe.activeProvider)}</strong>`);
    const row =
      `<div class="analytics-slo-row">` +
      `<span class="analytics-slo-label">LLM provider chain</span>` +
      `<span class="analytics-slo-value">${detailParts.length ? detailParts.join(' · ') : '<span class="analytics-muted">no provider resolved</span>'}</span>` +
      `<span class="analytics-slo-target">circuit-breaker: primary → fallback chain</span>` +
      StatusBadge({ state: opState, label, size: 'sm' }) +
      `</div>`;
    body =
      intervalCaption('Interval: live — resolved from on-disk provider health markers at render time.') +
      row +
      `<p class="analytics-muted">A degraded chain is visible here before builds start failing: fallback-active means the primary tripped its breaker and work is running on a fallback provider; no-healthy-provider means the chain is exhausted.</p>`;
  }
  return Card({
    title: 'Provider chain',
    subtitle: 'LLM provider health for the reference routing lane',
    headerAside: aside,
    body,
  });
}

// ---------------------------------------------------------------------------
// Acceptance split (cumulative counter — "all-time")
// ---------------------------------------------------------------------------

function acceptanceSplitCard(result: FoldResult, events: LedgerEvent[]): string {
  const accepted = [...result.items.values()].filter((r) => r.state === 'accepted');
  const provisional = accepted.filter((r) => r.provisionalAccept === true);
  const human = accepted.length - provisional.length;

  let body: string;
  if (accepted.length === 0) {
    body = emptyState('No accepted items yet', 'Accepts split into human verdicts vs provisional plane self-accepts as soon as merged work is accepted.');
  } else {
    // Who recorded each accept: the last item.accepted event per item that actually folded
    // to 'accepted' (stray accepts on non-merged items are fold no-ops and must not count).
    const byPerItem = new Map<string, string>();
    for (const ev of events) {
      if (ev.type !== 'item.accepted') continue;
      const by = (ev.data as { by?: unknown }).by;
      byPerItem.set(ev.item, typeof by === 'string' && by.length > 0 ? by : 'unknown');
    }
    const byCounts = new Map<string, number>();
    for (const rec of accepted) {
      const by = byPerItem.get(rec.id) ?? 'unknown';
      byCounts.set(by, (byCounts.get(by) ?? 0) + 1);
    }
    const byRows = [...byCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([by, count]) => `<tr><td>${esc(by)}</td><td ${NUM}>${esc(String(count))}</td></tr>`)
      .join('');

    body =
      intervalCaption('Interval: all-time — cumulative accepts across the whole ledger.') +
      `<div class="analytics-stats">` +
      `<span>Human accepts: <strong>${esc(String(human))}</strong></span>` +
      `<span>Provisional (plane self-accepts): <strong>${esc(String(provisional.length))}</strong></span>` +
      `<span>Human share: <strong>${esc(fmtPct(human / accepted.length))}</strong></span>` +
      `</div>` +
      `<table class="analytics-table">` +
      `<thead><tr><th>Accepted by</th><th ${NUM}>Items</th></tr></thead>` +
      `<tbody>${byRows}</tbody></table>` +
      `<p class="analytics-muted">Provisional accepts are the plane accepting its own internal work; they are excluded from judge calibration so self-accepts never inflate the judge's agreement stats. The human share is the trust metric — it is the fraction of accepted work a person actually verified.</p>`;
  }
  return Card({
    title: 'Acceptance split',
    subtitle: 'Human verdicts vs provisional plane self-accepts',
    body,
  });
}

// ---------------------------------------------------------------------------
// Manifest coverage (point-in-time — "live", from run artifacts)
// ---------------------------------------------------------------------------

export interface ManifestScanEntry {
  item: string;
  attempt: number;
  /** Worker's self-reported confidence [0,1]; null when absent/unparseable. Data only. */
  confidence: number | null;
}

const MANIFEST_NAME_RE = /^(WI-\d+)-attempt-(\d+)\.manifest\.json$/;

/**
 * Scan a runs directory for worker completion manifests (`WI-NNN-attempt-N.manifest.json`),
 * including the per-loop and per-target namespace subdirectories (bounded depth — never a
 * full tree walk). Returns null when the directory does not exist yet (a fresh plane), so
 * the card can say so instead of faking an empty result. Exposed for tests.
 */
export function scanManifestFiles(runsDir: string): ManifestScanEntry[] | null {
  let rootEntries;
  try {
    rootEntries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const entries: ManifestScanEntry[] = [];
  // Depth-bounded walk: runsDir itself, its subdirectories, and THEIR subdirectories —
  // matching where the dispatcher writes evidence (runs root, per-loop dir, per-target dir).
  const dirs: string[] = [runsDir];
  for (const e of rootEntries) {
    if (!e.isDirectory()) continue;
    const level1 = join(runsDir, e.name);
    dirs.push(level1);
    try {
      for (const sub of readdirSync(level1, { withFileTypes: true })) {
        if (sub.isDirectory()) dirs.push(join(level1, sub.name));
      }
    } catch { /* unreadable subdirectory — skip */ }
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = MANIFEST_NAME_RE.exec(name);
      if (!m) continue;
      let confidence: number | null = null;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { confidence?: unknown };
        if (typeof raw === 'object' && raw !== null && typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
          confidence = Math.max(0, Math.min(1, raw.confidence));
        }
      } catch { /* malformed manifest — counts for coverage, contributes no confidence */ }
      entries.push({ item: m[1]!, attempt: Number(m[2]), confidence });
    }
  }
  return entries;
}

function safeScanManifests(): ManifestScanEntry[] | null {
  try {
    return scanManifestFiles(resolvePlaneHome({ warn: () => { /* quiet */ } }).runsDir);
  } catch {
    return null;
  }
}

function manifestCoverageCard(result: FoldResult, manifests: ManifestScanEntry[] | null): string {
  let body: string;
  if (manifests === null) {
    body =
      intervalCaption('Interval: live — from run artifacts (worker self-reports on disk), not ledger events.') +
      emptyState('No runs directory yet', 'Worker completion manifests land there as builds dispatch; coverage appears with the first one.');
  } else {
    const totalAttempts = [...result.items.values()].reduce((s, r) => s + r.builds.length, 0);
    if (totalAttempts === 0 && manifests.length === 0) {
      body =
        intervalCaption('Interval: live — from run artifacts (worker self-reports on disk), not ledger events.') +
        emptyState('No build attempts yet', 'Coverage appears once builds dispatch and workers write completion manifests.');
    } else {
      // Join to the fold: only manifests for items the ledger knows about count, deduped per
      // (item, attempt) so a re-copied artifact can never push coverage past 100%.
      const seen = new Set<string>();
      let matched = 0;
      for (const m of manifests) {
        const key = `${m.item}#${m.attempt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (result.items.has(m.item)) matched++;
      }
      const coverage = totalAttempts > 0 ? matched / totalAttempts : undefined;
      const confidences = manifests.filter((m) => m.confidence !== null).map((m) => m.confidence!);
      const avgConfidence = confidences.length > 0
        ? confidences.reduce((s, c) => s + c, 0) / confidences.length
        : undefined;
      body =
        intervalCaption('Interval: live — from run artifacts (worker self-reports on disk), joined to the fold’s build attempts.') +
        `<div class="analytics-stats">` +
        `<span>Build attempts: <strong>${esc(String(totalAttempts))}</strong></span>` +
        `<span>With manifest: <strong>${esc(String(matched))}</strong></span>` +
        `<span>Coverage: <strong>${coverage === undefined ? '—' : esc(fmtPct(coverage))}</strong></span>` +
        `<span>Avg self-reported confidence: <strong>${avgConfidence === undefined ? '—' : esc(avgConfidence.toFixed(2))}</strong></span>` +
        `</div>` +
        `<p class="analytics-muted">Worker manifests are honest self-reports (files touched, tests added, confidence the spec is satisfied). Data only — the raw material for a future confidence gate, never a blocking signal today.</p>`;
    }
  }
  return Card({
    title: 'Manifest coverage',
    subtitle: 'Worker self-reports — completion manifests per build attempt',
    body,
  });
}

// ---------------------------------------------------------------------------
// Scout warm-start coverage (statistical aggregate — fixed trailing window, labeled)
// ---------------------------------------------------------------------------

/** Trailing window for warm-start coverage — matches projectTrajectory's default so the two
 *  scout-brief readings (this pane's ItemRecord.brief join and Trajectory's per-attempt
 *  event-timestamp join) cover the same span even though they measure it differently. */
export const SCOUT_COVERAGE_WINDOW_DAYS = 14;

export interface ScoutCoverageResult {
  totalAttempts: number;
  warmStarts: number;
  /** undefined when there were no dispatched attempts in the window. */
  coverage?: number;
}

/**
 * Fraction of dispatched build attempts in the trailing window that started from a scout
 * brief. Keyed on ItemRecord.brief presence — a per-item flag, not a per-attempt one — so every
 * attempt belonging to a briefed item counts as warm-started, including the in-flight
 * currentBuild. A simpler, state-based counterpart to Trajectory's scoutCoverage (which joins
 * item.briefed timestamps to each build.dispatched event); this one answers "did this item ever
 * get a scout brief", not "was it briefed before this specific attempt". Exposed for tests.
 */
export function computeScoutCoverage(
  result: FoldResult,
  now: Date,
  days: number = SCOUT_COVERAGE_WINDOW_DAYS,
): ScoutCoverageResult {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  let totalAttempts = 0;
  let warmStarts = 0;
  for (const rec of result.items.values()) {
    const attempts: ItemRecord['builds'] = rec.currentBuild ? [...rec.builds, rec.currentBuild] : rec.builds;
    for (const build of attempts) {
      if (!build.dispatchedAt) continue;
      const ts = Date.parse(build.dispatchedAt);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      totalAttempts++;
      if (rec.brief) warmStarts++;
    }
  }
  return { totalAttempts, warmStarts, coverage: totalAttempts > 0 ? warmStarts / totalAttempts : undefined };
}

function scoutCoverageCard(result: FoldResult, now: Date): string {
  const { totalAttempts, warmStarts, coverage } = computeScoutCoverage(result, now);
  let body: string;
  if (totalAttempts === 0) {
    body =
      intervalCaption(`Interval: trailing ${SCOUT_COVERAGE_WINDOW_DAYS}d of build attempts — fixed window, not filtered by the page picker.`) +
      emptyState('No build attempts in the window yet', 'Coverage appears once builds dispatch — an item with a scout brief counts every one of its attempts as warm-started.');
  } else {
    body =
      intervalCaption(`Interval: trailing ${SCOUT_COVERAGE_WINDOW_DAYS}d of build attempts — fixed window, not filtered by the page picker.`) +
      `<div class="analytics-stats">` +
      `<span>Build attempts: <strong>${esc(String(totalAttempts))}</strong></span>` +
      `<span>Warm-started (scout brief present): <strong>${esc(String(warmStarts))}</strong></span>` +
      `<span>Coverage: <strong>${esc(fmtPct(coverage!))}</strong></span>` +
      `</div>` +
      `<p class="analytics-muted">coverage rising and first-pass merges improving is the healthy direction.</p>`;
  }
  return Card({
    title: 'Scout warm-start coverage',
    subtitle: 'Dispatched builds started from a scout brief — ItemRecord.brief vs. total attempts',
    body,
  });
}

// ---------------------------------------------------------------------------
// Page legend (native <details> — zero JS, embedded docs)
// ---------------------------------------------------------------------------

function legendBlock(): string {
  const panes: [string, string][] = [
    ['Spend / Daily spend / Token usage', 'cost.usage events grouped by lane, loop, provider and day — follow the page picker.'],
    ['Quota utilization', 'latest subscription-quota reading per provider:window — live, percent and resets first.'],
    ['Judge verdicts', 'advisory merge-review verdicts and their calibration against accepted outcomes.'],
    ['Repairs', 'items that needed more than one build attempt — live attempt counts.'],
    ['Cache efficiency', 'prompt-cache read hit rate per loop, from the collector buckets — fast-lane picker.'],
    ['Pipeline latency', 'first-reply and stage-transition timing over a fixed trailing window.'],
    ['Trajectory', 'aggregate velocity/quality across build attempts — fixed trailing window.'],
    ['Execution config', 'which model configuration produces accepted outcomes; small samples show counts only.'],
    ['Routing', 'model-routing calibration by spec-size bucket; the tag says whether routing is advisory or active.'],
    ['Provider chain', 'live circuit-breaker readout: primary healthy, running on fallback, or no healthy provider.'],
    ['Acceptance split', 'human accepts vs provisional plane self-accepts — the trust metric, all-time.'],
    ['Manifest coverage', 'worker completion self-reports joined to build attempts — live, from run artifacts.'],
    ['Scout warm-start coverage', 'fraction of dispatched builds started from a scout brief — fixed trailing window.'],
    ['Ledger hygiene', 'segment sizes and the quarantine count — live.'],
    ['Salvage activity', 'uncommitted partial work captured from interrupted attempts — last 10.'],
  ];
  const loops: [string, string][] = [
    ['reactor', 'the routing/merging beat — classifies intents, applies operator verbs, merges approved branches.'],
    ['dispatch', 'the build beat — picks queued items, spawns workers in worktrees, runs the gate.'],
    ['scout / builder / judge', 'worker roles the beats spawn: context packs, bounded implementation, merge review.'],
    ['interactive', 'an operator’s own sessions — reported usage outside the autonomy plane.'],
  ];
  const controls: [string, string][] = [
    ['LOOPKIT_AUTONOMY', 'the autonomy kill-switch — the plane refuses to run agents unless this env var is \'on\'; set in .ai/loops/config.env.'],
  ];
  const dl = (rows: [string, string][]): string =>
    `<dl class="analytics-legend__list">${rows.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>`;
  return (
    `<details class="analytics-legend">` +
    `<summary>How to read this page</summary>` +
    `<div class="analytics-legend__body">` +
    `<p class="analytics-muted">Windowed panes follow the picker; every other pane states its own interval (trailing window, all-time, live, or last-N) — no table silently mixes time bases. Colour always means the same thing: green met/healthy, amber at-risk/fallback, red breached/exhausted.</p>` +
    `<h4 class="analytics-legend__heading">Panes</h4>` + dl(panes) +
    `<h4 class="analytics-legend__heading">Loop labels</h4>` + dl(loops) +
    `<h4 class="analytics-legend__heading">Operational controls</h4>` + dl(controls) +
    `</div></details>`
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface AnalyticsExtras {
  /** Ledger segment listing (name + bytes), from the server's directory scan. */
  segments?: SegmentInfo[];
  /** Entry count of the ledger's quarantine list; null/undefined renders as unknown. */
  quarantinedCount?: number | null;
  /** Merged routing config; omitted → read live from the plane config (safe default). */
  routingConfig?: Required<RoutingConfig>;
  /** Provider-chain probe; omitted → derived live from health markers; null → unknown. */
  providerHealth?: ProviderProbeResult | null;
  /** Worker-manifest scan; omitted → scanned live from the plane's runs dir; null → dir absent. */
  manifests?: ManifestScanEntry[] | null;
}

export function renderAnalytics(
  result: FoldResult,
  now: Date = new Date(),
  events: LedgerEvent[] = [],
  url: URL = new URL('http://localhost/analytics'),
  extras: AnalyticsExtras = {},
  theme?: string,
): string {
  const pageSpec = parseTimeWindow(url.searchParams.get('window'), PAGE_WINDOW_DEFAULT);
  const cacheSpec = parseTimeWindow(url.searchParams.get('cache'), CACHE_WINDOW_DEFAULT);
  const nowIso = now.toISOString();

  // One full-history fold feeds the unwindowed widgets (quota, cache buckets, pipeline);
  // a second fold over only the in-window cost.usage events feeds the follow-the-picker
  // spend/token widgets. Both come from the same core foldCosts — no view-local re-parse.
  const fullCosts = foldCosts(events, { now: nowIso });
  const cutoff = windowCutoffMs(pageSpec, now.getTime());
  const windowedCosts = foldCosts(costEventsInWindow(events, cutoff), { now: nowIso });

  // Point-in-time probe inputs: injected via extras (tests, callers with better context) or
  // derived live behind safe defaults (`undefined` = derive; `null` = explicitly unknown).
  const routingCfg = extras.routingConfig ?? safeRoutingConfig();
  const providerHealth = extras.providerHealth !== undefined ? extras.providerHealth : safeProviderChainHealth();
  const manifests = extras.manifests !== undefined ? extras.manifests : safeScanManifests();

  const body = `<h1 class="opsui-page-title">Analytics</h1>
<p class="opsui-page-updated">Spend · quota · judge · latency · trajectory — windowed widgets follow the picker (${esc(pageSpec.label)}); every other pane states its own interval</p>
<div class="opsui-analytics">
${spendCard(windowedCosts, pageSpec, url)}
${dailySpendCard(windowedCosts, pageSpec, url)}
${tokenUsageCard(costEventsInWindow(events, cutoff), pageSpec, url)}
${quotaCard(fullCosts.quotaCapacity)}
${judgeCard(events)}
${repairsCard(result)}
${cacheEfficiencyCard(fullCosts, cacheSpec, now, url)}
${pipelineLatencyCard(fullCosts, events, now)}
${trajectoryCard(events, now)}
${executionConfigCard(events, nowIso)}
${routingCard(result, events, routingCfg, nowIso)}
${providerChainCard(providerHealth)}
${acceptanceSplitCard(result, events)}
${manifestCoverageCard(result, manifests)}
${scoutCoverageCard(result, now)}
${ledgerHygieneCard(extras.segments ?? [], extras.quarantinedCount)}
${salvageCard(events)}
${legendBlock()}
</div>`;

  return page(
    {
      title: 'Analytics — loopkit console',
      activeNav: 'analytics',
      statusStrip: renderStatusStrip(result, events, now),
      theme,
      provenance: {
        generatedAt: nowIso,
        eventCount: events.length,
        itemCount: result.items.size,
        cliEquivalents: [
          { label: 'Spend / Daily spend / Token usage', command: 'loopctl costs --by loop|provider|day' },
          { label: 'Quota utilization', command: 'loopctl quota' },
          { label: 'Judge verdicts', command: 'loopctl verdicts' },
          { label: 'Repairs · Acceptance split', command: 'loopctl summary' },
          { label: 'Pipeline latency · Provider chain', command: 'loopctl slo' },
          { label: 'Trajectory', command: 'loopctl trajectory' },
          { label: 'Execution config', command: 'loopctl execution-config' },
          { label: 'Routing', command: 'loopctl routing' },
          { label: 'Scout warm-start coverage', command: 'loopctl summary' },
          { label: 'Ledger hygiene', command: 'loopctl compact --dry-run' },
          { label: 'Salvage activity · raw events', command: 'loopctl events --recent 50' },
        ],
      },
    },
    body,
  );
}
