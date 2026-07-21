// Plane-observability projection adapter — WI-235.
// Maps autonomy-plane instrumentation data (costs, verdicts, context packs,
// repairs, trajectory, plus the legacy token-usage rows from observability)
// into a typed ProjectionEnvelope<PlaneObservabilityData>. All source data is
// fail-soft — null/absent readers produce unavailable-state sections, never a
// failed envelope unless the envelope itself could not be constructed.
//
// NOTE: ops-ui must not import from the host app. Wire types are defined here;
// the host app maps its reader outputs to PlaneObservabilityInput.

import type { GlanceMetric } from './command-projection.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { formatTokens } from './observability-adapter.ts';

export { formatTokens };

const SCHEMA_VERSION = '1';

// ─── Wire types (mirror the host app's reader outputs; no import from the host app) ──

export type CostRow = {
  key: string;     // loop name or day string
  tokens: number;
  usd: number;
  calls: number;
};

export type PlaneCostsData = {
  byLoop: CostRow[];
  /** WI-357: same grouping as byLoop, filtered to today's ISO day (loopkit costs.ts foldCosts)
   *  — lets the glance-tile footnote share a time window with the today-scoped headline instead
   *  of silently mixing in all-time spend. Optional: absent on older loopctl builds. */
  byLoopToday?: CostRow[];
  byDay: CostRow[];
  byProvider: CostRow[];
  totalTokens: number;
  totalUsd: number;
  totalCalls: number;
  /** WI-311: latest Codex subscription-quota reading (0-100), never summed. Absent = no Codex
   *  cost.usage event has carried it yet. */
  codexQuotaPercent?: number;
  /** WI-314: one row per provider:window with the latest quota.snapshot reading plus a
   *  regressed capacity/runway estimate (see loopkit costs.ts computeQuotaCapacity). Absent
   *  or empty = no quota.snapshot event has arrived yet. */
  quotaCapacity?: QuotaWindowRow[];
  /** WI-315: per-loop cache-read efficiency, bucketed 5m/1h (see loopkit costs.ts
   *  computePipelineLatency's sibling, the cacheByLoop fold). Absent or empty = no
   *  cost.usage event has arrived yet. */
  cacheEfficiency?: CacheEfficiencyRow[];
  /** WI-315: stage-transition latency (captured→queued→building→gated→merged), regressed
   *  from raw item/build/gate events over a trailing window (loopkit costs.ts
   *  computePipelineLatency). Absent = the collector hasn't produced a reading yet. */
  pipelineLatency?: PipelineLatencySummary;
};

// ─── WI-315: Cache efficiency & pipeline latency (mirrors loopkit costs.ts shapes) ────────────

export type CacheEfficiencyBucket = {
  bucketStart: string;
  uncachedTokens: number;
  cacheReadTokens: number;
};

export type CacheEfficiencyRow = {
  loop: string;
  totalTokens: number;
  cacheReadTokens: number;
  /** True when at least one cost.usage event for this loop carried cachedInputTokens. Today
   *  only the Codex collector (WI-311) populates that field — Claude CLI lanes discard the
   *  cache read/write split before it reaches cost.usage (see costs.ts CacheEfficiencyRow). */
  cacheInstrumented: boolean;
  cacheHitPercent: number | null;
  buckets5m: CacheEfficiencyBucket[];
  buckets1h: CacheEfficiencyBucket[];
};

export type PlanesCacheEfficiencyData = { rows: CacheEfficiencyRow[] } | null;

export type PipelineLatencyStage = {
  name: string;
  samples: number;
  medianMs: number;
  p90Ms: number;
};

export type PipelineLatencySummary = {
  stages: PipelineLatencyStage[];
  window: { days: number; from: string; to: string };
};

export type PlanesPipelineLatencyData = PipelineLatencySummary | null;

/** Build the cache-efficiency panel from `costs.cacheEfficiency` — null when empty/absent
 *  (feature-detects the collectors' presence, same approach as quotaPanelFromCosts). */
export function cacheEfficiencyFromCosts(costs: PlaneCostsData | null): PlanesCacheEfficiencyData {
  if (!costs || !costs.cacheEfficiency || costs.cacheEfficiency.length === 0) return null;
  return { rows: costs.cacheEfficiency };
}

/** Build the pipeline-latency panel from `costs.pipelineLatency` — null when no stage has
 *  any samples yet (feature-detects the collectors' presence, same approach as quotaPanelFromCosts). */
export function pipelineLatencyFromCosts(costs: PlaneCostsData | null): PlanesPipelineLatencyData {
  if (!costs || !costs.pipelineLatency || costs.pipelineLatency.stages.length === 0) return null;
  return costs.pipelineLatency;
}

export type PlaneVerdictRow = {
  item: string;
  verdict: string;
  confidence?: number | string;
  scopeCreep?: boolean;
  testTheatre?: boolean;
  reasons?: string[];
  outcome?: string;
};

export type PlaneVerdictsData = {
  total: number;
  judgedFail: number;
  withOutcome: number;
  agreePass: number;
  falseAlarm: number;
  /** Items auto-accepted as provisional (excluded from agreePass/falseAlarm/withOutcome). */
  provisionalAccepted?: number;
  rows: PlaneVerdictRow[];
};

export type PlaneTrajectoryData = {
  firstPassMergeRate?: number;
  repairMergeRate?: number;
  avgCostPerMergedUsd?: number;
  avgTurns?: number;
  scoutCoverage?: number;
  [key: string]: unknown;
};

export type PlaneBudgetConfig = {
  dispatchDailyUsd?: number;
};

export type PlaneRepairArtifact = {
  wiId: string;
  attempts: number;
  state: string;
  hasDiff: boolean;
  hasGateLog: boolean;
};

/** A fold active item (minimal shape needed for context-pack stats). */
export type PlaneFoldItem = {
  state: string;
  attempts: number;
  [key: string]: unknown;
};

/** Token-usage rows from the legacy observability readers (absorbed here). */
export type PlaneTokenCostRow = {
  loop: string;
  provider: string;
  tokens: number;
  usd: number;
};

export type PlaneTrendPoint = {
  date: string;
  tokens: number;
  usd: number;
};

export type PlaneTranscriptSize = {
  label: string;
  bytes: number;
};

// ─── WI-237: New wire types ───────────────────────────────────────────────────

/** Human vs provisional accept split — from loopctl summary + verdicts. */
export type PlaneAcceptSplit = {
  /** Items accepted by a human (founder). */
  humanAccepted: number;
  /** Items self-accepted provisionally (excluded from judge calibration). */
  provisionalAccepted: number;
};

/** Provider chain status row — from loopctl slo --json `provider` row. */
export type PlaneProviderStatus = {
  /** 'met' = primary healthy · 'at-risk' = running on fallback · 'breached' = no healthy provider */
  status: 'met' | 'at-risk' | 'breached' | 'unknown';
  /** Display value emitted by loopctl (e.g. "primary healthy", "running on fallback"). */
  value: string;
};

/** One salvage file record (fs-derived). */
export type PlaneSalvageFile = {
  wi: string;
  attempt: number;
  /** 'patch' | 'note' */
  kind: 'patch' | 'note';
  bytes: number;
  mtimeMs: number;
};

/** Manifest coverage summary (fs-derived). */
export type PlaneManifestCoverage = {
  /** Attempts that have a manifest file. */
  withManifest: number;
  /** Total attempt log files seen (denominator). */
  totalAttempts: number;
  /** Average self-reported confidence across all manifest files. */
  avgConfidence: number | null;
};

/** Ledger hygiene line (from loopctl doctor --json + fs). */
export type PlaneLedgerHygiene = {
  /** Quarantined known-invalid events (from loopctl doctor --json). null = CLI unavailable. */
  quarantinedKnown: number | null;
  /** Segment files sizes (bytes) per .jsonl file. */
  segments: { name: string; bytes: number }[];
  /** mtime of archive directory last entry (ms since epoch), or null if no archive. */
  archiveLastMtimeMs: number | null;
};

/** Routing panel — feature-detected. null = CLI command absent / model routing not yet enabled. */
export type PlaneRoutingData = {
  /** Advisory or active mode. */
  mode: string;
  /** Routing bucket × model rows. */
  rows: Array<{
    bucket: string;
    model: string;
    samples: number;
    /** Already a percent number (0-100, e.g. 41.4), not a 0-1 ratio — mapped from
     *  the CLI's 0-1 firstPassRate by the host app. Render sites format with
     *  .toFixed(1) and a literal '%'; never re-scale. */
    firstPassPct: number | null;
    avgCostUsd: number | null;
  }>;
} | null;

/**
 * Execution-config-by-model row — which execution CONFIGURATION produces ACCEPTED
 * outcomes, not "agent performance". Every ratio is optional (undefined when its
 * denominator is 0 — never fabricated from a 0/0 division); `n` is ALWAYS present so
 * the region can render an explicit insufficient-data state for low-sample models.
 */
export type PlaneExecutionConfigRow = {
  model: string;
  /** Sample size — the number of items attributed to this model. */
  n: number;
  /** accepted items / merged items. Undefined when merged=0. */
  acceptRate?: number;
  /** items whose gate passed on attempt 1 / items that reached a gate. Undefined when gated=0. */
  firstPassGateRate?: number;
  /** sum(cost.usage.usd across the item's builds) / accepted count. Undefined when accepted=0. */
  costPerAcceptedUsd?: number;
  /** sum(max(attempts-1,0)) / accepted count. Undefined when accepted=0. */
  retriesPerAccept?: number;
  // Raw counts backing the ratios — always present.
  merged: number;
  accepted: number;
  gated: number;
  gatedFirstPass: number;
};

/** Execution-config panel — feature-detected (loopctl execution-config). null = CLI command absent. */
export type PlaneExecutionConfigData = {
  /** Sample-size floor below which a row is rendered as insufficient-data. */
  minSamples: number;
  window: { days: number; from: string; to: string };
  rows: PlaneExecutionConfigRow[];
} | null;

// ─── Input type ───────────────────────────────────────────────────────────────

/** Wire input — the host app maps its reader outputs into this shape. */
export type PlaneObservabilityInput = {
  generatedAt: string;
  costs: PlaneCostsData | null;
  budget: PlaneBudgetConfig;
  verdicts: PlaneVerdictsData | null;
  repairs: PlaneRepairArtifact[];
  trajectory: PlaneTrajectoryData | null | 'absent';
  activeItems: PlaneFoldItem[];
  /** Token-usage rows (legacy observability data absorbed into this page). */
  tokenRows: PlaneTokenCostRow[];
  trendPoints: PlaneTrendPoint[];
  transcriptSizes: PlaneTranscriptSize[];
  // ── WI-237 additions ──────────────────────────────────────────────────────
  /** Human vs provisional accept split (from summary + verdicts). */
  acceptSplit: PlaneAcceptSplit | null;
  /** Provider chain status (from loopctl slo --json `provider` row). */
  providerStatus: PlaneProviderStatus | null;
  /** Salvage files found under .ai/runs/loopkit/ (fs-derived). */
  salvageFiles: PlaneSalvageFile[];
  /** Manifest coverage stats (fs-derived). */
  manifestCoverage: PlaneManifestCoverage | null;
  /** Ledger hygiene data (from loopctl doctor --json + fs). */
  ledgerHygiene: PlaneLedgerHygiene | null;
  /** Routing panel data (feature-detected, null when model routing not yet live). */
  routing: PlaneRoutingData;
  /** Execution-config-by-model panel (feature-detected). null = CLI command absent. */
  executionConfig?: PlaneExecutionConfigData;
};

// ─── Output types ─────────────────────────────────────────────────────────────

/** The typed payload the plane-observability projection renders. */
export type PlaneObservabilityData = {
  glance: GlanceMetric[];
  costs: PlaneCostsData | null;
  budget: PlaneBudgetConfig;
  verdicts: PlaneVerdictsData | null;
  repairs: PlaneRepairArtifact[];
  trajectory: PlaneTrajectoryData | null | 'absent';
  activeItems: PlaneFoldItem[];
  tokenRows: PlaneTokenCostRow[];
  trendPoints: PlaneTrendPoint[];
  transcriptSizes: PlaneTranscriptSize[];
  // ── WI-237 additions ──────────────────────────────────────────────────────
  acceptSplit: PlaneAcceptSplit | null;
  providerStatus: PlaneProviderStatus | null;
  salvageFiles: PlaneSalvageFile[];
  manifestCoverage: PlaneManifestCoverage | null;
  ledgerHygiene: PlaneLedgerHygiene | null;
  routing: PlaneRoutingData;
  /** Execution-config-by-model panel — null = CLI command absent (feature-detected). */
  executionConfig: PlaneExecutionConfigData;
  /** Codex consult/founder-manual tile (WI-311) — null when no Codex usage recorded yet. */
  codex: PlaneCodexData;
  /** Unified Claude + Codex quota panel (WI-314) — null when no quota.snapshot recorded yet. */
  quota: PlaneQuotaData;
  /** Cache-read efficiency per loop (WI-315) — null when no cost.usage event recorded yet. */
  cacheEfficiency: PlanesCacheEfficiencyData;
  /** Stage-transition pipeline latency (WI-315) — null when no item has merged in the window. */
  pipelineLatency: PlanesPipelineLatencyData;
};

// ─── Validator ────────────────────────────────────────────────────────────────

export function isPlaneObservabilityInput(v: unknown): v is PlaneObservabilityInput {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['generatedAt'] === 'string' &&
    (r['costs'] === null || typeof r['costs'] === 'object') &&
    typeof r['budget'] === 'object' && r['budget'] !== null &&
    (r['verdicts'] === null || typeof r['verdicts'] === 'object') &&
    Array.isArray(r['repairs']) &&
    Array.isArray(r['activeItems']) &&
    Array.isArray(r['tokenRows']) &&
    Array.isArray(r['trendPoints']) &&
    Array.isArray(r['transcriptSizes']) &&
    Array.isArray(r['salvageFiles'])
  );
}

// ─── Lanes (WI-309) ───────────────────────────────────────────────────────────
//
// `costs.byLoop` is per-loop (dispatch/reactor/scout/judge/interactive/...); the console
// groups those into two lanes the founder actually cares about — the autonomy plane
// (loopkit's own headless calls) vs interactive (the founder's own CLI sessions). Usage is
// metered against a Claude subscription, not billed per-call, so every lane figure here is
// an "API-equivalent" estimate, not a real invoice line.

const AUTONOMY_PLANE_LOOPS = new Set(['dispatch', 'reactor', 'scout', 'judge']);

export type LaneRow = { lane: 'autonomy-plane' | 'interactive' | 'other'; label: string; usd: number; tokens: number; calls: number };

// ─── Codex tile (WI-311) ───────────────────────────────────────────────────────
//
// Codex-dispatched consults and the founder's own personal Codex CLI use both draw on
// the same subscription quota, so both need to be visible. `costs.byLoop` already
// carries them as 'consult' / 'founder-manual' rows (tagged by the codex-usage collector); this
// tile just groups those two rows and surfaces the latest quota reading — computed here from
// the same `costs` data the Spend card already renders, no separate wire field needed.

export type PlaneCodexRow = { loop: 'consult' | 'founder-manual'; label: string; tokens: number; calls: number };

export type PlaneCodexData = {
  rows: PlaneCodexRow[];
  totalTokens: number;
  totalCalls: number;
  /** Latest rate_limits.primary.used_percent reading (0-100), or null when none has arrived yet. */
  quotaPercent: number | null;
} | null;

const CODEX_LOOP_LABELS: Record<string, string> = { consult: 'Consult', 'founder-manual': 'Founder manual' };

/** Build the Codex tile from `costs.byLoop` — null when no Codex usage has been recorded yet
 *  (feature-detects the WI-311 collector's presence without a separate absent/null wire field). */
export function codexTileFromCosts(costs: PlaneCostsData | null): PlaneCodexData {
  if (!costs) return null;
  const rows: PlaneCodexRow[] = costs.byLoop
    .filter((r) => r.key === 'consult' || r.key === 'founder-manual')
    .map((r) => ({ loop: r.key as PlaneCodexRow['loop'], label: CODEX_LOOP_LABELS[r.key] ?? r.key, tokens: r.tokens, calls: r.calls }));
  if (rows.length === 0) return null;
  return {
    rows,
    totalTokens: rows.reduce((s, r) => s + r.tokens, 0),
    totalCalls: rows.reduce((s, r) => s + r.calls, 0),
    quotaPercent: costs.codexQuotaPercent ?? null,
  };
}

// ─── Quota panel (WI-314) ───────────────────────────────────────────────────
//
// Unified subscription-quota utilization across Claude (five_hour/seven_day, via
// statusline.py's drop file) and Codex (primary, via the WI-311 collector). `costs
// .quotaCapacity` already carries the latest reading plus a regressed capacity/runway
// estimate per provider:window (loopkit costs.ts computeQuotaCapacity) — this just maps
// that field into the wire row shape, same feature-detection approach as codexTileFromCosts
// (null when the collectors haven't produced a reading yet).

export type QuotaWindowRow = {
  provider: string;   // 'claude' | 'codex'
  window: string;     // 'five_hour' | 'seven_day' | 'primary'
  usedPct: number;
  resetsAt?: string;
  planType?: string;
  /** WI-356: window length in minutes (e.g. Codex's 10080min 7-day window) — lets the
   *  region derive a label instead of a per-window hardcode. Absent = older reading or a
   *  window whose key is already semantic (Claude's five_hour/seven_day). */
  windowMinutes?: number;
  /** Regressed from delta(tokens)/delta(usedPct) over the two most recent same-cycle readings. */
  capacityTokensPerWeek?: number;
  /** API-equivalent estimate, not a billed charge. */
  capacityUsdPerWeek?: number;
  runwayDays?: number;
  /** WI-356: ts of the latest reading. Optional — feature-detects loopctl versions before
   *  this field existed. */
  ts?: string;
  /** WI-356: hours since the latest reading's ts. Optional for the same reason as `ts`; the
   *  region renders "age unknown" when absent rather than fabricating a value. */
  readingAgeHours?: number;
};

export type PlaneQuotaData = { rows: QuotaWindowRow[] } | null;

/** Build the quota panel from `costs.quotaCapacity` — null when no quota.snapshot has been
 *  recorded yet (feature-detects the WI-314 collectors' presence, no separate wire field). */
export function quotaPanelFromCosts(costs: PlaneCostsData | null): PlaneQuotaData {
  if (!costs || !costs.quotaCapacity || costs.quotaCapacity.length === 0) return null;
  return { rows: costs.quotaCapacity };
}

/** Group cost rows into founder-facing spend lanes. Pure — reused by both the glance tile
 *  footnote (today-scoped, via `rows: costs.byLoopToday`) and the Spend card's lane table
 *  (all-time, defaults to `costs.byLoop` when `rows` is omitted). */
export function laneRowsFromCosts(costs: PlaneCostsData | null, rows?: CostRow[]): LaneRow[] {
  if (!costs) return [];
  const source = rows ?? costs.byLoop;
  const lanes = new Map<LaneRow['lane'], LaneRow>();
  const bump = (lane: LaneRow['lane'], label: string, r: CostRow) => {
    const row = lanes.get(lane) ?? { lane, label, usd: 0, tokens: 0, calls: 0 };
    row.usd += r.usd;
    row.tokens += r.tokens;
    row.calls += r.calls;
    lanes.set(lane, row);
  };
  for (const r of source) {
    if (r.key === 'interactive') bump('interactive', 'Interactive (you)', r);
    else if (AUTONOMY_PLANE_LOOPS.has(r.key)) bump('autonomy-plane', 'Autonomy plane', r);
    else bump('other', 'Other', r);
  }
  return [...lanes.values()].sort((a, b) => b.usd - a.usd);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildGlance(
  costs: PlaneCostsData | null,
  verdicts: PlaneVerdictsData | null,
  repairs: PlaneRepairArtifact[],
  providerStatus: PlaneProviderStatus | null,
): GlanceMetric[] {
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayUsd = costs?.byDay.find((r) => r.key === todayKey)?.usd ?? 0;

  const spendState = costs === null
    ? 'neutral'
    : todayUsd > (costs.totalUsd / Math.max(costs.byDay.length, 1)) * 2
      ? 'warning'
      : 'neutral';

  const judgeState = verdicts === null
    ? 'neutral'
    : verdicts.falseAlarm > 0
      ? 'warning'
      : 'success';

  const providerState: GlanceMetric['state'] =
    providerStatus === null ? 'neutral'
    : providerStatus.status === 'met'      ? 'success'
    : providerStatus.status === 'at-risk'  ? 'warning'
    : providerStatus.status === 'breached' ? 'critical'
    : 'neutral';

  const lanes = laneRowsFromCosts(costs, costs?.byLoopToday);
  const laneFootnote = lanes.length > 0
    ? lanes.map((l) => `$${l.usd.toFixed(2)} ${l.label.toLowerCase()}`).join(' · ') + ' (API-equivalent)'
    : `$${(costs?.totalUsd ?? 0).toFixed(2)} total`;

  return [
    {
      label:    'Today spend',
      value:    costs ? `$${todayUsd.toFixed(2)}` : '—',
      footnote: costs ? laneFootnote : 'loopctl unavailable',
      state:    spendState,
      open:     { kind: 'evidence', id: 'spend' },
    },
    {
      label:    'Judge verdicts',
      value:    verdicts ? String(verdicts.total) : '—',
      footnote: verdicts
        ? verdicts.withOutcome > 0
          ? `${verdicts.falseAlarm} false alarm${verdicts.falseAlarm !== 1 ? 's' : ''}`
          : 'no outcomes yet'
        : 'loopctl unavailable',
      state:    judgeState,
      open:     { kind: 'evidence', id: 'judge' },
    },
    {
      label:    'Repair items',
      value:    repairs.length > 0 ? String(repairs.length) : '0',
      footnote: repairs.length > 0 ? `attempt${repairs.length !== 1 ? 's' : ''} > 1` : 'all first-pass',
      state:    repairs.length > 0 ? 'warning' : 'success',
      open:     { kind: 'evidence', id: 'repairs' },
    },
    {
      label:    'Provider chain',
      value:    providerStatus ? providerStatus.value : '—',
      footnote: providerStatus ? `status: ${providerStatus.status}` : 'loopctl unavailable',
      state:    providerState,
      open:     { kind: 'evidence', id: 'provider' },
    },
  ];
}

// ─── Analytics strip (nav collapse 9→5, WI-350) ─────────────────────────────────
//
// System's top strip surfaces 4 tiles computed by the SAME logic this adapter already
// uses for its own glance/Spend/Quota panels — quota is first-class per the observability
// doctrine (WI-314/309/311), "$" only ever a labeled API-equivalent, never a billed figure.
// Each tile links to /observability (Analytics keeps its own route, deep tables).

/** Highest current subscription-quota utilization across every provider:window reading
 *  (`costs.quotaCapacity`) — the single number the founder needs at a glance; the full
 *  per-provider breakdown lives on Analytics. Undefined when no quota.snapshot has landed. */
function highestQuotaUsedPct(quota: PlaneQuotaData): { usedPct: number; window: string; provider: string } | undefined {
  if (!quota || quota.rows.length === 0) return undefined;
  return quota.rows.reduce((max, r) => (r.usedPct > max.usedPct ? r : max), quota.rows[0]!);
}

/** Build the System page's 4-tile Analytics strip from the same fields
 *  `planeObservabilityProjectionFromInput` already folds — quota utilization, today
 *  spend, first-pass merge rate, and the human/provisional acceptance split. Pure (no
 *  fetch), so callers just pass the already-built `PlaneObservabilityData`. */
export function analyticsStripFromData(data: Pick<PlaneObservabilityData, 'quota' | 'costs' | 'trajectory' | 'acceptSplit'>): GlanceMetric[] {
  const href = '/observability';
  const quotaTop = highestQuotaUsedPct(data.quota);
  const quotaState: GlanceMetric['state'] = quotaTop === undefined
    ? 'neutral'
    : quotaTop.usedPct >= 90 ? 'critical' : quotaTop.usedPct >= 70 ? 'warning' : 'success';

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayUsd = data.costs?.byDay.find((r) => r.key === todayKey)?.usd ?? 0;

  const trajectory = data.trajectory && data.trajectory !== 'absent' ? data.trajectory : null;
  const firstPass = trajectory?.firstPassMergeRate;
  const firstPassState: GlanceMetric['state'] = firstPass === undefined
    ? 'neutral'
    : firstPass >= 0.7 ? 'success' : firstPass >= 0.4 ? 'warning' : 'critical';

  const split = data.acceptSplit;
  const splitTotal = split ? split.humanAccepted + split.provisionalAccepted : 0;

  return [
    {
      label: 'Quota utilization',
      value: quotaTop === undefined ? '—' : `${Math.round(quotaTop.usedPct)}%`,
      footnote: quotaTop === undefined ? 'no quota reading yet' : `${quotaTop.provider} · ${quotaTop.window}`,
      state: quotaState,
      href,
      open: { kind: 'evidence', id: 'quota' },
    },
    {
      label: 'Today spend',
      value: data.costs ? `$${todayUsd.toFixed(2)}` : '—',
      footnote: data.costs ? 'API-equivalent, not billed' : 'loopctl unavailable',
      state: 'neutral',
      href,
      open: { kind: 'evidence', id: 'spend' },
    },
    {
      label: 'First-pass rate',
      value: firstPass === undefined ? '—' : `${Math.round(firstPass * 100)}%`,
      footnote: firstPass === undefined ? 'no trajectory data yet' : 'merged without a repair',
      state: firstPassState,
      href,
      open: { kind: 'evidence', id: 'trajectory' },
    },
    {
      label: 'Acceptance split',
      value: splitTotal > 0 ? `${split!.humanAccepted}/${splitTotal}` : '—',
      footnote: splitTotal > 0 ? `${split!.humanAccepted} human · ${split!.provisionalAccepted} provisional` : 'no accepted items yet',
      state: 'neutral',
      href,
      open: { kind: 'evidence', id: 'judge' },
    },
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Build the plane-observability projection envelope from the instrumentation input.
 *  Unknown or malformed input yields a `failed` envelope. */
export function planeObservabilityProjectionFromInput(
  raw: unknown,
  opts: { ledgerSequence: number; foldVersion?: string; staleAfterSeconds?: number } = { ledgerSequence: 0 },
): ProjectionEnvelope<PlaneObservabilityData> {
  const foldVersion = opts.foldVersion ?? 'plane-observability@1';
  const staleAfter  = opts.staleAfterSeconds ?? 300;

  if (!isPlaneObservabilityInput(raw)) {
    return {
      projectionId:   'plane-observability',
      schemaVersion:  SCHEMA_VERSION,
      foldVersion,
      ledgerSequence: opts.ledgerSequence,
      generatedAt:    new Date().toISOString(),
      freshUntil:     new Date().toISOString(),
      state:          'failed',
      data: {
        glance: [], costs: null, budget: {}, verdicts: null,
        repairs: [], trajectory: null, activeItems: [],
        tokenRows: [], trendPoints: [], transcriptSizes: [],
        acceptSplit: null, providerStatus: null, salvageFiles: [],
        manifestCoverage: null, ledgerHygiene: null, routing: null,
        executionConfig: null, codex: null, quota: null,
        cacheEfficiency: null, pipelineLatency: null,
      },
      evidence: [
        { id: 'spend',   kind: 'metric-query', label: 'loopctl costs'     },
        { id: 'judge',   kind: 'metric-query', label: 'loopctl verdicts'  },
        { id: 'repairs', kind: 'artifact',     label: 'run artifacts'     },
      ],
    };
  }

  const generatedAt = raw.generatedAt;
  const freshUntil  = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();

  return {
    projectionId:   'plane-observability',
    schemaVersion:  SCHEMA_VERSION,
    foldVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance:           buildGlance(raw.costs, raw.verdicts, raw.repairs, raw.providerStatus ?? null),
      costs:            raw.costs,
      budget:           raw.budget,
      verdicts:         raw.verdicts,
      repairs:          raw.repairs,
      trajectory:       raw.trajectory,
      activeItems:      raw.activeItems,
      tokenRows:        raw.tokenRows,
      trendPoints:      raw.trendPoints,
      transcriptSizes:  raw.transcriptSizes,
      acceptSplit:      raw.acceptSplit ?? null,
      providerStatus:   raw.providerStatus ?? null,
      salvageFiles:     raw.salvageFiles ?? [],
      manifestCoverage: raw.manifestCoverage ?? null,
      ledgerHygiene:    raw.ledgerHygiene ?? null,
      routing:          raw.routing ?? null,
      executionConfig:  raw.executionConfig ?? null,
      codex:            codexTileFromCosts(raw.costs),
      quota:            quotaPanelFromCosts(raw.costs),
      cacheEfficiency:  cacheEfficiencyFromCosts(raw.costs),
      pipelineLatency:  pipelineLatencyFromCosts(raw.costs),
    },
    evidence: [
      { id: 'spend',       kind: 'metric-query', label: 'loopctl costs'           },
      { id: 'judge',       kind: 'metric-query', label: 'loopctl verdicts'        },
      { id: 'context',     kind: 'metric-query', label: 'context-pack coverage'   },
      { id: 'repairs',     kind: 'artifact',     label: 'run artifacts (.diff/.gate.log)' },
      { id: 'trajectory',  kind: 'metric-query', label: 'loopctl trajectory'      },
      { id: 'token-rows',  kind: 'metric-query', label: 'Claude transcript usage' },
      { id: 'provider',    kind: 'metric-query', label: 'loopctl slo (provider)'  },
      { id: 'salvage',     kind: 'artifact',     label: 'salvage patches'         },
      { id: 'routing',     kind: 'metric-query', label: 'loopctl routing'         },
      { id: 'execution-config', kind: 'metric-query', label: 'loopctl execution-config' },
      { id: 'codex',       kind: 'metric-query', label: 'loopctl costs (codex)'   },
      { id: 'quota',       kind: 'metric-query', label: 'loopctl quota'           },
    ],
  };
}
