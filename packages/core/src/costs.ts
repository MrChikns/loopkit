/**
 * costs.ts — Cost projection over `cost.usage` ops events.
 *
 * Every provider call appends `cost.usage {provider, loop, tokens, usd}`. This fold groups that
 * stream by loop, by provider, and by day — the read model behind `loopctl costs` and any
 * cost panel a console builds, answering "who is spending what."
 *
 * Pure function over events; no I/O.
 */

import { LedgerEvent } from './schema.js';

export interface CostRow {
  key: string;
  tokens: number;
  usd: number;
  calls: number;
}

export interface CostSummary {
  byLoop: CostRow[];
  /**
   * Same grouping as byLoop, filtered to today's ISO day (ev.ts.slice(0, 10) matching
   * the current day, same convention as byDay/spendForDay). Lets a glance-tile footnote share
   * a time window with a today-scoped headline instead of silently mixing in all-time byLoop.
   */
  byLoopToday: CostRow[];
  byProvider: CostRow[];
  byDay: CostRow[];
  totalTokens: number;
  totalUsd: number;
  totalCalls: number;
  /**
   * The latest `quotaPercent` reading from a `cost.usage{provider:'codex'}` event
   * (rate_limits.primary.used_percent) — a point-in-time subscription-quota reading, never
   * summed like tokens/usd. Undefined when no Codex event has carried this field yet.
   */
  codexQuotaPercent?: number;
  /**
   * Full `quota.snapshot` history, one point per event, sorted by ts asc. Kept as
   * raw history (never summed/latest-only) so the adapter can regress capacity/runway —
   * unlike codexQuotaPercent's latest-only strategy.
   */
  quotaSnapshots: QuotaPoint[];
  /**
   * One row per provider:window with the latest reading plus a capacity/runway
   * estimate regressed from the two most recent same-cycle snapshots and the matching
   * cost.usage token/usd delta over that interval. Capacity/runway fields are undefined
   * until there are two same-cycle readings AND a nonzero token delta between them.
   */
  quotaCapacity: QuotaWindowRow[];
  /**
   * Per-loop cache-read efficiency, bucketed 5m/1h. `cacheReadTokens` comes from
   * `cost.usage.cachedInputTokens` — this field is only populated by collectors that carry
   * cache-read detail, so `cacheInstrumented` is false (and `cacheHitPercent` null) for any
   * loop whose usage extractor merges cache-read + cache-creation into a single `in` figure
   * before it reaches cost.usage — the read/write split isn't recoverable here without an
   * event-schema addition on that collector.
   */
  cacheEfficiency: CacheEfficiencyRow[];
  /**
   * Stage-transition latency (captured→queued→building→gated→merged), regressed from
   * raw item.captured/item.queued/build.dispatched/gate.passed/item.merged events over a
   * trailing window. A stage transition is skipped per-item when either endpoint event is
   * missing (crashed/parked builds never reach gate.passed, etc.) — never fabricated as 0.
   */
  pipelineLatency: PipelineLatencySummary;
}

export interface CacheEfficiencyBucket {
  /** ISO8601 bucket start (floored to the bucket boundary). */
  bucketStart: string;
  uncachedTokens: number;
  cacheReadTokens: number;
}

export interface CacheEfficiencyRow {
  loop: string;
  totalTokens: number;
  cacheReadTokens: number;
  /** True when at least one cost.usage event for this loop carried cachedInputTokens. */
  cacheInstrumented: boolean;
  /** cacheReadTokens / totalTokens * 100. Null when cacheInstrumented is false or totalTokens is 0. */
  cacheHitPercent: number | null;
  buckets5m: CacheEfficiencyBucket[];
  buckets1h: CacheEfficiencyBucket[];
}

export interface PipelineLatencyStage {
  /** e.g. 'captured→queued', 'gated→merged'. */
  name: string;
  samples: number;
  medianMs: number;
  p90Ms: number;
}

export interface PipelineLatencySummary {
  stages: PipelineLatencyStage[];
  window: { days: number; from: string; to: string };
}

export interface QuotaPoint {
  provider: string;
  window: string;
  usedPct: number;
  ts: string;
  resetsAt?: string;
  planType?: string;
  /** Window length in minutes, when the source carried it (e.g. a provider's
   *  rate_limits.primary.window_minutes field). Absent for providers whose window keys
   *  are already semantic (e.g. five_hour/seven_day readings). */
  windowMinutes?: number;
}

export interface QuotaWindowRow {
  provider: string;
  window: string;
  usedPct: number;
  resetsAt?: string;
  planType?: string;
  windowMinutes?: number;
  /** API-equivalent token capacity per week, regressed from delta(tokens)/delta(usedPct). */
  capacityTokensPerWeek?: number;
  /** API-equivalent USD capacity per week (not a billed charge). */
  capacityUsdPerWeek?: number;
  /** Days until usedPct reaches 100 at the current rate of consumption. */
  runwayDays?: number;
  /** ts of the latest reading this row was built from. */
  ts: string;
  /** Hours since the latest reading's ts, regressed against foldCosts' `now` (falls
   *  back to wall-clock at fold time). A conserved/manual-consult provider only refreshes
   *  when a consult runs, so this can be genuinely large; a continuously-polled provider
   *  refreshes far more often during a session. */
  readingAgeHours: number;
}

/** Static labels for window keys that arrive without a windowMinutes hint — covers
 *  providers whose window keys are already semantic (e.g. a five_hour/seven_day pairing). */
const STATIC_QUOTA_WINDOW_LABELS: Record<string, string> = { five_hour: '5h window', seven_day: '7d window' };

/**
 * Human label for a provider:window row. Derives from `windowMinutes` when present
 * (e.g. a 10080min window → "7d window") so no window key needs a hardcoded
 * label; falls back to a static lookup for known keys, else the raw key as a last
 * resort (never a fabricated guess).
 */
export function formatQuotaWindowLabel(window: string, windowMinutes?: number): string {
  if (typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d window`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h window`;
    return `${windowMinutes}m window`;
  }
  return STATIC_QUOTA_WINDOW_LABELS[window] ?? window;
}

/** Maps a quota.snapshot provider tag to the cost.usage provider tag that carries its
 *  matching token/usd spend, so the regression can correlate the two streams. */
const QUOTA_TO_COST_PROVIDER: Record<string, string> = { claude: 'claude-cli', codex: 'codex' };

/** Approximate reset-cycle length in days per window, used to scale a regressed rate to a
 *  weekly figure. 'primary' (Codex) has no exposed window length — assumed weekly. */
const WINDOW_CYCLE_DAYS: Record<string, number> = { five_hour: 5 / 24, seven_day: 7, primary: 7 };

/**
 * Regress per-provider:window capacity/runway from quota.snapshot history plus the matching
 * cost.usage token/usd deltas. Uses only the two most recent readings for a provider:window
 * (a simple two-point regression, not least-squares) and skips the estimate entirely when
 * usedPct dropped between them (a drop means the window reset, not that usage reversed).
 * Pure — no I/O.
 */
function computeQuotaCapacity(
  history: Map<string, QuotaPoint[]>,
  usageEvents: Array<{ ts: string; provider: string; tokens: number; usd: number }>,
  opts: { now?: string } = {},
): QuotaWindowRow[] {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const rows: QuotaWindowRow[] = [];

  for (const points of history.values()) {
    const sorted = [...points].sort((a, b) => a.ts.localeCompare(b.ts));
    const latest = sorted[sorted.length - 1];
    const latestMs = Date.parse(latest.ts);
    const row: QuotaWindowRow = {
      provider: latest.provider,
      window: latest.window,
      usedPct: latest.usedPct,
      ts: latest.ts,
      readingAgeHours: Number.isFinite(latestMs) ? Math.max(0, (nowMs - latestMs) / 3_600_000) : 0,
      ...(latest.resetsAt !== undefined ? { resetsAt: latest.resetsAt } : {}),
      ...(latest.planType !== undefined ? { planType: latest.planType } : {}),
      ...(latest.windowMinutes !== undefined ? { windowMinutes: latest.windowMinutes } : {}),
    };

    const prior = sorted.length >= 2 ? sorted[sorted.length - 2] : undefined;
    if (prior && prior.usedPct <= latest.usedPct) {
      const deltaPct = latest.usedPct - prior.usedPct;
      const t1 = Date.parse(prior.ts);
      const t2 = Date.parse(latest.ts);
      if (deltaPct > 0 && Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1) {
        const costProvider = QUOTA_TO_COST_PROVIDER[latest.provider];
        let deltaTokens = 0;
        let deltaUsd = 0;
        if (costProvider) {
          for (const u of usageEvents) {
            if (u.provider !== costProvider) continue;
            const ts = Date.parse(u.ts);
            if (Number.isFinite(ts) && ts > t1 && ts <= t2) {
              deltaTokens += u.tokens;
              deltaUsd += u.usd;
            }
          }
        }
        if (deltaTokens > 0) {
          const cycleDays = WINDOW_CYCLE_DAYS[latest.window] ?? 7;
          const scaleToWeek = 7 / cycleDays;
          row.capacityTokensPerWeek = (deltaTokens / deltaPct) * 100 * scaleToWeek;
          row.capacityUsdPerWeek = (deltaUsd / deltaPct) * 100 * scaleToWeek;
        }
        const pctPerMs = deltaPct / (t2 - t1);
        if (pctPerMs > 0) {
          row.runwayDays = (Math.max(0, 100 - latest.usedPct) / pctPerMs) / 86_400_000;
        }
      }
    }
    rows.push(row);
  }

  return rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.window.localeCompare(b.window));
}

const FIVE_MIN_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

function floorBucket(tsMs: number, bucketMs: number): string {
  return new Date(Math.floor(tsMs / bucketMs) * bucketMs).toISOString();
}

function bumpBucket(map: Map<string, CacheEfficiencyBucket>, bucketStart: string, uncachedTokens: number, cacheReadTokens: number): void {
  const bucket = map.get(bucketStart) ?? { bucketStart, uncachedTokens: 0, cacheReadTokens: 0 };
  bucket.uncachedTokens += uncachedTokens;
  bucket.cacheReadTokens += cacheReadTokens;
  map.set(bucketStart, bucket);
}

function sortedBuckets(map: Map<string, CacheEfficiencyBucket>): CacheEfficiencyBucket[] {
  return [...map.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
}

/**
 * Regress p50/p90 latency per stage transition from raw item.captured/item.queued/
 * build.dispatched/gate.passed/item.merged events. Only merges landing inside the trailing
 * window count (matches trajectory.ts's `dispatchedAt within [from, now]` convention); a
 * transition is skipped per-item when either endpoint event never happened for that item.
 * Pure — no I/O.
 */
function computePipelineLatency(events: LedgerEvent[], opts: { days?: number; now?: string } = {}): PipelineLatencySummary {
  const days = opts.days ?? 7;
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const fromMs = nowMs - days * 24 * 60 * 60 * 1000;
  const from = new Date(fromMs).toISOString();
  const to = new Date(nowMs).toISOString();

  type Stamps = { capturedAt?: number; queuedAt?: number; buildingAt?: number; gatedAt?: number };
  const stamps = new Map<string, Stamps>();
  const samples: Record<string, number[]> = {
    'captured→queued': [],
    'queued→building': [],
    'building→gated': [],
    'gated→merged': [],
  };

  for (const ev of events) {
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts)) continue;
    if (ev.type === 'item.merged') {
      const s = stamps.get(ev.item);
      if (s && ts >= fromMs && ts <= nowMs) {
        if (s.capturedAt !== undefined && s.queuedAt !== undefined && s.queuedAt >= s.capturedAt) {
          samples['captured→queued'].push(s.queuedAt - s.capturedAt);
        }
        if (s.queuedAt !== undefined && s.buildingAt !== undefined && s.buildingAt >= s.queuedAt) {
          samples['queued→building'].push(s.buildingAt - s.queuedAt);
        }
        if (s.buildingAt !== undefined && s.gatedAt !== undefined && s.gatedAt >= s.buildingAt) {
          samples['building→gated'].push(s.gatedAt - s.buildingAt);
        }
        if (s.gatedAt !== undefined && ts >= s.gatedAt) {
          samples['gated→merged'].push(ts - s.gatedAt);
        }
      }
      continue;
    }
    if (ev.type !== 'item.captured' && ev.type !== 'item.queued' && ev.type !== 'build.dispatched' && ev.type !== 'gate.passed') continue;
    const s = stamps.get(ev.item) ?? {};
    if (ev.type === 'item.captured') s.capturedAt = ts;
    else if (ev.type === 'item.queued') s.queuedAt = ts;
    else if (ev.type === 'build.dispatched') s.buildingAt = ts;
    else if (ev.type === 'gate.passed') s.gatedAt = ts;
    stamps.set(ev.item, s);
  }

  const stages: PipelineLatencyStage[] = [];
  for (const [name, values] of Object.entries(samples)) {
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    stages.push({
      name,
      samples: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
    });
  }

  return { stages, window: { days, from, to } };
}

/** index = ceil(len * p) - 1, floored at 0 — matches the p90 convention used across loopkit. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function accumulate(map: Map<string, CostRow>, key: string, tokens: number, usd: number): void {
  const row = map.get(key) ?? { key, tokens: 0, usd: 0, calls: 0 };
  row.tokens += tokens;
  row.usd += usd;
  row.calls += 1;
  map.set(key, row);
}

/** Sort rows by usd desc, then tokens desc, then key asc for stable output. */
function sortRows(map: Map<string, CostRow>): CostRow[] {
  return [...map.values()].sort(
    (a, b) => b.usd - a.usd || b.tokens - a.tokens || a.key.localeCompare(b.key),
  );
}

/**
 * Sum total USD spent today (dispatch + reactor) filtered to a specific ISO day string
 * (e.g. '2026-07-11'). Uses the same day-bucket as foldCosts (ev.ts.slice(0, 10)) so
 * figures always agree with the cost panel. Pure — no I/O.
 */
export function spendForDay(events: LedgerEvent[], isoDay: string): number {
  let total = 0;
  for (const ev of events) {
    if (ev.type !== 'cost.usage') continue;
    if (ev.ts.slice(0, 10) !== isoDay) continue;
    const d = ev.data as { usd?: unknown };
    const usd = typeof d.usd === 'number' && Number.isFinite(d.usd) ? d.usd : 0;
    total += usd;
  }
  return total;
}

export function foldCosts(events: LedgerEvent[], opts: { pipelineLatencyDays?: number; now?: string } = {}): CostSummary {
  const todayKey = (opts.now ?? new Date().toISOString()).slice(0, 10);
  const byLoop = new Map<string, CostRow>();
  const byLoopToday = new Map<string, CostRow>();
  const byProvider = new Map<string, CostRow>();
  const byDay = new Map<string, CostRow>();
  let totalTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  let codexQuotaPercent: number | undefined;
  let codexQuotaTs: string | undefined;
  const quotaHistory = new Map<string, QuotaPoint[]>();
  const usageEvents: Array<{ ts: string; provider: string; tokens: number; usd: number }> = [];
  const cacheByLoop = new Map<string, { totalTokens: number; cacheReadTokens: number; cacheInstrumented: boolean; buckets5m: Map<string, CacheEfficiencyBucket>; buckets1h: Map<string, CacheEfficiencyBucket> }>();

  for (const ev of events) {
    if (ev.type === 'quota.snapshot') {
      const d = ev.data as { provider?: unknown; window?: unknown; usedPct?: unknown; resetsAt?: unknown; planType?: unknown; windowMinutes?: unknown };
      if (typeof d.provider !== 'string' || typeof d.window !== 'string'
        || typeof d.usedPct !== 'number' || !Number.isFinite(d.usedPct)) continue;
      const point: QuotaPoint = {
        provider: d.provider,
        window: d.window,
        usedPct: d.usedPct,
        ts: ev.ts,
        ...(typeof d.resetsAt === 'string' ? { resetsAt: d.resetsAt } : {}),
        ...(typeof d.planType === 'string' ? { planType: d.planType } : {}),
        ...(typeof d.windowMinutes === 'number' && Number.isFinite(d.windowMinutes) ? { windowMinutes: d.windowMinutes } : {}),
      };
      const key = `${d.provider}:${d.window}`;
      const list = quotaHistory.get(key) ?? [];
      list.push(point);
      quotaHistory.set(key, list);
      continue;
    }
    if (ev.type !== 'cost.usage') continue;
    const d = ev.data as { provider?: unknown; loop?: unknown; tokens?: unknown; usd?: unknown; quotaPercent?: unknown; cachedInputTokens?: unknown };
    const provider = typeof d.provider === 'string' ? d.provider : 'unknown';
    const loop = typeof d.loop === 'string' ? d.loop : 'unknown';
    const tokens = typeof d.tokens === 'number' && Number.isFinite(d.tokens) ? d.tokens : 0;
    const usd = typeof d.usd === 'number' && Number.isFinite(d.usd) ? d.usd : 0;
    const day = ev.ts.slice(0, 10);

    accumulate(byLoop, loop, tokens, usd);
    if (day === todayKey) accumulate(byLoopToday, loop, tokens, usd);
    accumulate(byProvider, provider, tokens, usd);
    accumulate(byDay, day, tokens, usd);
    totalTokens += tokens;
    totalUsd += usd;
    totalCalls += 1;
    usageEvents.push({ ts: ev.ts, provider, tokens, usd });

    // Latest reading wins — quotaPercent is a point-in-time subscription-quota snapshot,
    // never additive across events (see CostSummary.codexQuotaPercent).
    if (provider === 'codex' && typeof d.quotaPercent === 'number' && Number.isFinite(d.quotaPercent)
      && (!codexQuotaTs || ev.ts > codexQuotaTs)) {
      codexQuotaPercent = d.quotaPercent;
      codexQuotaTs = ev.ts;
    }

    // Cache efficiency — see CostSummary.cacheEfficiency for the instrumentation-gap caveat.
    const cachedInputTokens = typeof d.cachedInputTokens === 'number' && Number.isFinite(d.cachedInputTokens) ? d.cachedInputTokens : undefined;
    const evMs = Date.parse(ev.ts);
    const cache = cacheByLoop.get(loop) ?? { totalTokens: 0, cacheReadTokens: 0, cacheInstrumented: false, buckets5m: new Map(), buckets1h: new Map() };
    cache.totalTokens += tokens;
    const cacheRead = cachedInputTokens ?? 0;
    cache.cacheReadTokens += cacheRead;
    if (cachedInputTokens !== undefined) cache.cacheInstrumented = true;
    if (Number.isFinite(evMs)) {
      const uncached = Math.max(0, tokens - cacheRead);
      bumpBucket(cache.buckets5m, floorBucket(evMs, FIVE_MIN_MS), uncached, cacheRead);
      bumpBucket(cache.buckets1h, floorBucket(evMs, ONE_HOUR_MS), uncached, cacheRead);
    }
    cacheByLoop.set(loop, cache);
  }

  const quotaSnapshots = [...quotaHistory.values()].flat().sort((a, b) => a.ts.localeCompare(b.ts));

  const cacheEfficiency: CacheEfficiencyRow[] = [...cacheByLoop.entries()]
    .map(([loop, c]) => ({
      loop,
      totalTokens: c.totalTokens,
      cacheReadTokens: c.cacheReadTokens,
      cacheInstrumented: c.cacheInstrumented,
      cacheHitPercent: c.cacheInstrumented && c.totalTokens > 0 ? (c.cacheReadTokens / c.totalTokens) * 100 : null,
      buckets5m: sortedBuckets(c.buckets5m),
      buckets1h: sortedBuckets(c.buckets1h),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.loop.localeCompare(b.loop));

  return {
    byLoop: sortRows(byLoop),
    byLoopToday: sortRows(byLoopToday),
    // Days read best oldest→newest.
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byProvider: sortRows(byProvider),
    totalTokens,
    totalUsd,
    totalCalls,
    ...(codexQuotaPercent !== undefined ? { codexQuotaPercent } : {}),
    quotaSnapshots,
    quotaCapacity: computeQuotaCapacity(quotaHistory, usageEvents, { now: opts.now }),
    cacheEfficiency,
    pipelineLatency: computePipelineLatency(events, { days: opts.pipelineLatencyDays, now: opts.now }),
  };
}
