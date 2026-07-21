/**
 * brief.ts — deterministic daily ops brief.
 *
 * Zero-LLM composition of already-computed projections into one operator digest:
 * pulse (24h shipped/captured/queue-depth/in-flight/cycle-time), attention (parked
 * decisions + to-accept items vs SLA), SLO board (red/at-risk only, green collapsed),
 * 7-day quality (first-pass gate rate, repair attempts, judge disagreements, breaker
 * trips), spend (tokens first-class, USD as a labeled equivalent), and a Monday-only
 * routing-calibration section.
 *
 * Pure function over inputs the CLI composes from existing projections (fold(),
 * evaluateSloBoard(), foldCosts(), projectVerdicts(), buildRoutingTableWithSpecs()) —
 * same call-composition pattern as `loopctl routing`'s specsByWi wiring in cli.ts.
 * No I/O, no config-value hardcoding: thresholds arrive via BriefConfig/BriefSlaConfig.
 */

import { FoldResult } from './fold.js';
import { LedgerEvent } from './schema.js';
import { SloRow } from './slo.js';
import { CostRow, CostSummary } from './costs.js';
import { VerdictSummary } from './verdicts.js';
import { RoutingTable } from './routing.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BriefConfig {
  /** Target trailing-median captured→merged cycle time, in hours. */
  cycleTimeMedianHours: number;
  /** Floor for the trailing 7-day first-pass (attempt=1 merge) rate, 0–1. */
  firstPassRate7dFloor: number;
  /** Optional daily token-spend ceiling; the brief flags at 80% consumed. Absent = no alert. */
  dailyTokenBudget?: number;
}

/** SLA ceilings the "needs you" section measures parked/to-accept age against (mirrors SloConfig). */
export interface BriefSlaConfig {
  decisionMaxHours: number;
  acceptanceMaxHours: number;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type BriefStatus = 'met' | 'breached' | 'unknown';

export interface AttentionRow {
  id: string;
  kind: 'parked' | 'to-accept';
  title: string;
  ageHours: number;
  slaHours: number;
  breached: boolean;
  parkReason?: string;
}

export interface PulseSummary {
  windowHours: number;
  shipped: number;
  captured: number;
  queueDepth: number;
  inFlight: number;
  cycleTimeWindowDays: number;
  cycleTimeSamples: number;
  cycleTimeMedianHours: number | null;
  cycleTimeTarget: number;
  cycleTimeStatus: BriefStatus;
}

export interface QualitySummary {
  windowDays: number;
  mergedCount: number;
  firstPassRate: number | null;
  firstPassFloor: number;
  firstPassStatus: BriefStatus;
  repairAttempts: number;
  judgeDisagreements: number;
  breakerTrips: number;
}

export interface SpendSummary {
  byProvider: CostRow[];
  byLoop: CostRow[];
  totalTokens: number;
  totalUsd: number;
  dailyTokenBudget?: number;
  todayTokens: number;
  budgetAlert: boolean;
}

export interface RoutingSection {
  windowDays: number;
  table: RoutingTable;
}

export interface BriefResult {
  generatedAt: string;
  isMonday: boolean;
  pulse: PulseSummary;
  attention: AttentionRow[];
  slo: {
    breaches: SloRow[];
    greenCount: number;
    totalCount: number;
  };
  quality: QualitySummary;
  spend: SpendSummary;
  routing?: RoutingSection;
}

export interface BriefInputs {
  fold: FoldResult;
  /** Full ledger event stream (same input `foldCosts`/`projectVerdicts` take — not ops-only). */
  events: LedgerEvent[];
  sloRows: SloRow[];
  costSummary: CostSummary;
  verdicts: VerdictSummary;
  cfg: BriefConfig;
  sla: BriefSlaConfig;
  now?: Date;
  /**
   * Composed by the CLI only when `now` falls on a Monday (mirrors `loopctl routing`'s
   * buildRoutingTableWithSpecs call) — absent on every other day, so the render is a no-op
   * without this module re-deriving "is it Monday" logic twice.
   */
  routing?: RoutingSection;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function ageHours(ts: string | undefined, nowMs: number): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / MS_PER_HOUR);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const QUALITY_WINDOW_DAYS = 7;
const PULSE_WINDOW_HOURS = 24;

export function computeBrief(inputs: BriefInputs): BriefResult {
  const now = inputs.now ?? new Date();
  const nowMs = now.getTime();
  const pulseFromMs = nowMs - PULSE_WINDOW_HOURS * MS_PER_HOUR;
  const qualityFromMs = nowMs - QUALITY_WINDOW_DAYS * MS_PER_DAY;

  // ---- Pulse (24h): shipped + captured from raw events; queue/in-flight from the fold ----
  let shipped = 0;
  let captured = 0;
  for (const ev of inputs.events) {
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || t < pulseFromMs || t > nowMs) continue;
    if (ev.type === 'item.merged') shipped++;
    else if (ev.type === 'item.captured') captured++;
  }

  let queueDepth = 0;
  let inFlight = 0;
  const cycleTimes: number[] = [];
  let mergedCount = 0;
  let firstPassMerged = 0;
  let repairAttempts = 0;
  for (const rec of inputs.fold.items.values()) {
    if (rec.state === 'queued') queueDepth++;
    if (rec.state === 'building') inFlight++;

    if (!rec.mergedAt) continue;
    const mergedMs = Date.parse(rec.mergedAt);
    if (!Number.isFinite(mergedMs) || mergedMs < qualityFromMs || mergedMs > nowMs) continue;

    // Quality window (7d): first-pass rate + repair attempts, both keyed on merge time.
    mergedCount++;
    if (rec.attempts <= 1) firstPassMerged++;
    else repairAttempts += rec.attempts - 1;

    // Cycle time: captured→merged, same 7d window (statistically thin at 24h).
    if (rec.capturedAt) {
      const capturedMs = Date.parse(rec.capturedAt);
      if (Number.isFinite(capturedMs) && mergedMs >= capturedMs) {
        cycleTimes.push((mergedMs - capturedMs) / MS_PER_HOUR);
      }
    }
  }

  const cycleTimeMedianHours = median(cycleTimes);
  const cycleTimeStatus: BriefStatus = cycleTimeMedianHours === null
    ? 'unknown'
    : cycleTimeMedianHours > inputs.cfg.cycleTimeMedianHours ? 'breached' : 'met';

  // ---- Attention: parked decisions (parkKind:'decision' only) + to-accept ----
  const attention: AttentionRow[] = [];
  for (const rec of inputs.fold.items.values()) {
    const title = rec.title ?? rec.spec?.slice(0, 60) ?? rec.sourceText?.slice(0, 60) ?? '';
    if (rec.state === 'parked' && rec.parkKind === 'decision') {
      const age = ageHours(rec.parkedAt, nowMs);
      attention.push({
        id: rec.id,
        kind: 'parked',
        title,
        ageHours: age,
        slaHours: inputs.sla.decisionMaxHours,
        breached: age > inputs.sla.decisionMaxHours,
        ...(rec.parkReason ? { parkReason: rec.parkReason } : {}),
      });
    } else if (rec.state === 'merged') {
      const age = ageHours(rec.mergedAt, nowMs);
      attention.push({
        id: rec.id,
        kind: 'to-accept',
        title,
        ageHours: age,
        slaHours: inputs.sla.acceptanceMaxHours,
        breached: age > inputs.sla.acceptanceMaxHours,
      });
    }
  }
  attention.sort((a, b) => b.ageHours - a.ageHours);

  // ---- SLO: collapse green, surface only at-risk/breached ----
  const breaches = inputs.sloRows.filter(r => r.status === 'breached' || r.status === 'at-risk');
  const greenCount = inputs.sloRows.filter(r => r.status === 'met').length;

  // ---- Quality: judge disagreements + breaker trips, both windowed to 7d ----
  const judgeDisagreements = inputs.verdicts.rows.filter(r => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= qualityFromMs && t <= nowMs
      && r.verdict === 'fail' && r.outcome === 'accepted';
  }).length;

  let breakerTrips = 0;
  for (const ev of inputs.events) {
    if (ev.type !== 'item.parked') continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || t < qualityFromMs || t > nowMs) continue;
    const d = ev.data as { reason?: string };
    if (typeof d.reason === 'string' && d.reason.startsWith('breaker')) breakerTrips++;
  }

  const firstPassRate = mergedCount > 0 ? firstPassMerged / mergedCount : null;
  const firstPassStatus: BriefStatus = firstPassRate === null
    ? 'unknown'
    : firstPassRate < inputs.cfg.firstPassRate7dFloor ? 'breached' : 'met';

  // ---- Spend: tokens first-class; USD stays a labeled API-equivalent ----
  const todayIso = now.toISOString().slice(0, 10);
  const todayTokens = inputs.costSummary.byDay.find(r => r.key === todayIso)?.tokens ?? 0;
  const budgetAlert = inputs.cfg.dailyTokenBudget !== undefined && inputs.cfg.dailyTokenBudget > 0
    && todayTokens >= inputs.cfg.dailyTokenBudget * 0.8;

  return {
    generatedAt: now.toISOString(),
    isMonday: now.getUTCDay() === 1,
    pulse: {
      windowHours: PULSE_WINDOW_HOURS,
      shipped,
      captured,
      queueDepth,
      inFlight,
      cycleTimeWindowDays: QUALITY_WINDOW_DAYS,
      cycleTimeSamples: cycleTimes.length,
      cycleTimeMedianHours,
      cycleTimeTarget: inputs.cfg.cycleTimeMedianHours,
      cycleTimeStatus,
    },
    attention,
    slo: { breaches, greenCount, totalCount: inputs.sloRows.length },
    quality: {
      windowDays: QUALITY_WINDOW_DAYS,
      mergedCount,
      firstPassRate,
      firstPassFloor: inputs.cfg.firstPassRate7dFloor,
      firstPassStatus,
      repairAttempts,
      judgeDisagreements,
      breakerTrips,
    },
    spend: {
      byProvider: inputs.costSummary.byProvider,
      byLoop: inputs.costSummary.byLoop,
      totalTokens: inputs.costSummary.totalTokens,
      totalUsd: inputs.costSummary.totalUsd,
      ...(inputs.cfg.dailyTokenBudget !== undefined ? { dailyTokenBudget: inputs.cfg.dailyTokenBudget } : {}),
      todayTokens,
      budgetAlert,
    },
    ...(inputs.routing ? { routing: inputs.routing } : {}),
  };
}

// ---------------------------------------------------------------------------
// Markdown render
// ---------------------------------------------------------------------------

const DOT: Record<BriefStatus, string> = { met: 'OK', breached: 'XX', unknown: '--' };

export function renderBriefMarkdown(b: BriefResult): string {
  const lines: string[] = [];
  lines.push(`# Daily Ops Brief — ${b.generatedAt}`);
  lines.push('');

  lines.push('## Pulse (24h)');
  lines.push(`- Shipped ${b.pulse.shipped} · Captured ${b.pulse.captured} · Queue depth ${b.pulse.queueDepth} · In-flight ${b.pulse.inFlight}`);
  const ctValue = b.pulse.cycleTimeMedianHours !== null ? `${b.pulse.cycleTimeMedianHours.toFixed(1)}h` : 'no data';
  lines.push(`- Cycle time (${b.pulse.cycleTimeWindowDays}d median, n=${b.pulse.cycleTimeSamples}): [${DOT[b.pulse.cycleTimeStatus]}] ${ctValue} · target ≤ ${b.pulse.cycleTimeTarget}h`);
  lines.push('');

  lines.push('## Needs you');
  if (b.attention.length === 0) {
    lines.push('_Nothing waiting._');
  } else {
    for (const a of b.attention) {
      const flag = a.breached ? ' ⚠ OVER SLA' : '';
      const reason = a.parkReason ? ` · ${a.parkReason}` : '';
      lines.push(`- **${a.id}** (${a.kind}) ${a.title} — ${a.ageHours.toFixed(1)}h old, SLA ${a.slaHours}h${flag}${reason}`);
    }
  }
  lines.push('');

  lines.push('## SLO');
  if (b.slo.breaches.length === 0) {
    lines.push(`_All ${b.slo.greenCount}/${b.slo.totalCount} green._`);
  } else {
    for (const row of b.slo.breaches) {
      lines.push(`- [${row.status === 'breached' ? 'XX' : '??'}] ${row.key}: ${row.value} (target: ${row.target})`);
    }
    lines.push(`_${b.slo.greenCount}/${b.slo.totalCount} other rows green._`);
  }
  lines.push('');

  lines.push(`## Quality (${b.quality.windowDays}d)`);
  const fpValue = b.quality.firstPassRate !== null ? `${(b.quality.firstPassRate * 100).toFixed(0)}%` : 'no data';
  lines.push(`- First-pass gate rate: [${DOT[b.quality.firstPassStatus]}] ${fpValue} · floor ${(b.quality.firstPassFloor * 100).toFixed(0)}% · n=${b.quality.mergedCount}`);
  lines.push(`- Repair attempts ${b.quality.repairAttempts} · Judge disagreements ${b.quality.judgeDisagreements} · Breaker trips ${b.quality.breakerTrips}`);
  lines.push('');

  lines.push('## Spend');
  lines.push(`- Total ${b.spend.totalTokens} tokens · $${b.spend.totalUsd.toFixed(4)} (API-equivalent)`);
  if (b.spend.byProvider.length > 0) {
    lines.push(`- By provider: ${b.spend.byProvider.map(r => `${r.key}=${r.tokens}tok`).join(' · ')}`);
  }
  if (b.spend.dailyTokenBudget !== undefined) {
    lines.push(`- Today ${b.spend.todayTokens} / ${b.spend.dailyTokenBudget} tokens${b.spend.budgetAlert ? ' ⚠ ≥80% of daily budget' : ''}`);
  }
  lines.push('');

  if (b.routing) {
    lines.push('## Monday routing calibration');
    for (const bucket of Object.keys(b.routing.table) as Array<keyof RoutingTable>) {
      const cells = b.routing.table[bucket];
      const models = Object.keys(cells);
      if (models.length === 0) {
        lines.push(`- ${bucket}: no data in ${b.routing.windowDays}d window`);
        continue;
      }
      for (const m of models) {
        const c = cells[m]!;
        lines.push(`- ${bucket}/${m}: samples=${c.samples} first-pass=${(c.firstPassRate * 100).toFixed(0)}% avg=$${c.avgUsd.toFixed(4)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
