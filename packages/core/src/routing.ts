/**
 * routing.ts — Eval-driven model routing.
 *
 * Pure decision module: no I/O, no side effects. Inputs in, decision out.
 * Wired into dispatch.ts (spawn phase) and exposed via `loopctl routing`.
 *
 * POLICY OVERVIEW
 * ───────────────
 * The routing table is built from the trajectory attempt records (projectTrajectory)
 * bucketed by spec size. For each bucket × model cell the table records:
 *   - samples:        total attempts in the window
 *   - firstPassRate:  fraction of attempt-1 records whose outcome is 'merged'
 *   - avgUsd:         mean cost across ALL attempts (including repairs)
 *
 * Three modes:
 *   off      → return the incumbent model unchanged (exactly today's behaviour).
 *   advisory → return the incumbent but also compute what 'active' would pick;
 *              the caller records the advisory choice as modelAdvisory in the
 *              build.dispatched event. DEFAULT — calibrate before acting.
 *   active   → pick the model with the highest firstPassRate among those meeting
 *              minSamples in the current bucket; ties go to the lower-avgUsd model;
 *              if nothing qualifies, fall back to the incumbent (safe).
 *
 * EXPLORATION (cold-start escape hatch)
 * ──────────────────────────────────────
 * All ~110+ historical attempts used the same model (sonnet). A cheaper candidate
 * can never accumulate samples — and therefore can never win — unless something
 * deliberately tries it. With mode='active' and the small bucket (≤1500 chars),
 * when cfg.routing.exploreModel (default 'haiku') has fewer than minSamples in the
 * window, dispatch picks it with probability exploreRate (default 0.1).
 *
 * Exploration fires ONLY in:
 *   - 'active' mode
 *   - small bucket only (large/medium specs have higher stakes)
 *   - when the candidate model is under-sampled (< minSamples)
 *   - with injected rand() so tests are deterministic (never Math.random inline)
 *
 * NON-STATIONARITY CAVEAT
 * ───────────────────────
 * First-pass merge rates drift as the repo grows, model releases change capability,
 * and spec complexity shifts. The windowDays parameter (default 30) keeps the table
 * fresh by discarding old data; periodic re-review of the advisory output is the
 * intended operating discipline (run `loopctl routing` to inspect the table before
 * flipping to 'active').
 *
 * GRADUATION PATH
 * ───────────────
 * 1. Keep mode='advisory' (default). Run builds. Inspect `loopctl routing` regularly.
 * 2. When the table has sufficient data (minSamples per cell), flip mode='active' in
 *    loopkit.config.json. The advisory column in `loopctl routing` shows what the
 *    active policy would have picked — use it to verify sanity before flipping.
 * 3. Watch for regime changes (new model, repo structure shift) and consider widening
 *    windowDays or resetting exploreRate to re-sample.
 */

import { AttemptRecord } from './trajectory.js';

// ---------------------------------------------------------------------------
// Spec size buckets
// ---------------------------------------------------------------------------

/**
 * Bucket a spec string by character length.
 *
 * 'small'  → < 1500 chars (aligns with BATCH_SPEC_MAX in dispatch.ts — co-location threshold)
 * 'medium' → < 6000 chars
 * 'large'  → ≥ 6000 chars
 */
export type SpecBucket = 'small' | 'medium' | 'large';

export function bucketSpec(spec: string): SpecBucket {
  const len = spec.length;
  if (len < 1500) return 'small';
  if (len < 6000) return 'medium';
  return 'large';
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

export interface RoutingCell {
  /** Total attempts in the window for this bucket × model */
  samples: number;
  /**
   * Fraction of attempt-1 records with outcome 'merged'.
   * Only attempt-1 records count for firstPassRate (excludes repairs).
   */
  firstPassRate: number;
  /** Mean cost (USD) across ALL attempts (including repair attempts) */
  avgUsd: number;
}

/** Routing table: bucket → model → cell */
export type RoutingTable = Record<SpecBucket, Record<string, RoutingCell>>;

/**
 * Build a routing table from trajectory attempt records.
 *
 * @param attempts - from projectTrajectory(events).attempts
 * @param opts.windowDays - rolling window in days (default 30)
 * @param opts.now - injectable "now" ISO8601 string for tests (default real now)
 */
export function buildRoutingTable(
  attempts: AttemptRecord[],
  opts: { windowDays?: number; now?: string } = {},
): RoutingTable {
  const windowDays = opts.windowDays ?? 30;
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const fromMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  // Initialize empty table
  const table: RoutingTable = {
    small: {},
    medium: {},
    large: {},
  };

  // We need the spec sizes to bucket attempts, but AttemptRecord doesn't carry the
  // spec text (it's in the fold, not in the projection). We need the caller to pass
  // the spec alongside. BUT: the design says "reuse projectTrajectory — do not
  // re-read files". The attempt record carries the wi id only; the caller can resolve
  // the spec from the fold. However, the signature buildRoutingTable(attempts, opts)
  // receives only AttemptRecord[]. We therefore accept an optional specsByWi map to
  // resolve buckets. When absent, we use 'unknown' and skip (caller may pass it in).
  // For the dispatch wiring, we compute the bucket from the queued item's own spec
  // before calling chooseModel, and pass it directly.
  //
  // For the `loopctl routing` CLI, we compute buckets from a parallel specsByWi lookup.
  // This avoids changing the AttemptRecord shape (a minor deviation from the spec is
  // noted here). The buildRoutingTable signature is extended to accept an optional map.

  // Intermediate accumulators: bucket → model → {attempt1Total, attempt1Merged, usdSum, count}
  type Acc = { a1Total: number; a1Merged: number; usdSum: number; count: number };
  const acc: Record<SpecBucket, Record<string, Acc>> = {
    small: {}, medium: {}, large: {},
  };

  for (const ar of attempts) {
    // Window filter
    const dispMs = Date.parse(ar.dispatchedAt);
    if (!Number.isFinite(dispMs) || dispMs < fromMs || dispMs > nowMs) continue;

    const model = ar.model;
    if (!model) continue; // no model attribution — skip (legacy events predating model attribution)

    // Bucket: use specBucket from the attempt record when available (extended below)
    const bucket: SpecBucket = (ar as AttemptRecord & { specBucket?: SpecBucket }).specBucket ?? 'small';

    if (!acc[bucket][model]) {
      acc[bucket][model] = { a1Total: 0, a1Merged: 0, usdSum: 0, count: 0 };
    }
    const cell = acc[bucket][model]!;
    cell.count++;
    if (ar.usd !== undefined) cell.usdSum += ar.usd;
    if (ar.attempt === 1) {
      cell.a1Total++;
      if (ar.outcome === 'merged') cell.a1Merged++;
    }
  }

  // Materialise cells
  for (const b of (['small', 'medium', 'large'] as SpecBucket[])) {
    for (const [model, cell] of Object.entries(acc[b])) {
      table[b][model] = {
        samples: cell.count,
        firstPassRate: cell.a1Total > 0 ? cell.a1Merged / cell.a1Total : 0,
        avgUsd: cell.count > 0 ? cell.usdSum / cell.count : 0,
      };
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// Extended attempt record with pre-bucketed spec (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Build a routing table where each attempt record has an associated spec bucket.
 * This is the call-site for `loopctl routing` and dispatch, where we have access
 * to the spec text and can pre-bucket each attempt before aggregation.
 *
 * @param attempts  - from projectTrajectory(events).attempts
 * @param specsByWi - map from WI id → spec text (or undefined per item)
 * @param opts      - windowDays, now
 */
export function buildRoutingTableWithSpecs(
  attempts: AttemptRecord[],
  specsByWi: Map<string, string | undefined>,
  opts: { windowDays?: number; now?: string } = {},
): RoutingTable {
  const windowDays = opts.windowDays ?? 30;
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const fromMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const table: RoutingTable = { small: {}, medium: {}, large: {} };
  type Acc = { a1Total: number; a1Merged: number; usdSum: number; count: number };
  const acc: Record<SpecBucket, Record<string, Acc>> = { small: {}, medium: {}, large: {} };

  for (const ar of attempts) {
    const dispMs = Date.parse(ar.dispatchedAt);
    if (!Number.isFinite(dispMs) || dispMs < fromMs || dispMs > nowMs) continue;

    const model = ar.model;
    if (!model) continue;

    const spec = specsByWi.get(ar.wi) ?? '';
    const bucket = bucketSpec(spec);

    if (!acc[bucket][model]) {
      acc[bucket][model] = { a1Total: 0, a1Merged: 0, usdSum: 0, count: 0 };
    }
    const cell = acc[bucket][model]!;
    cell.count++;
    if (ar.usd !== undefined) cell.usdSum += ar.usd;
    if (ar.attempt === 1) {
      cell.a1Total++;
      if (ar.outcome === 'merged') cell.a1Merged++;
    }
  }

  for (const b of (['small', 'medium', 'large'] as SpecBucket[])) {
    for (const [model, cell] of Object.entries(acc[b])) {
      table[b][model] = {
        samples: cell.count,
        firstPassRate: cell.a1Total > 0 ? cell.a1Merged / cell.a1Total : 0,
        avgUsd: cell.count > 0 ? cell.usdSum / cell.count : 0,
      };
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface RoutingConfig {
  /**
   * Routing mode.
   *   off      → incumbent always (today's behavior, no change)
   *   advisory → incumbent used but active-policy choice also computed + recorded
   *   active   → data-driven choice (with exploration in small bucket)
   * Default: 'advisory'
   */
  mode?: 'off' | 'advisory' | 'active';
  /**
   * Minimum sample count in a bucket × model cell before it can be chosen as the
   * winner in 'active' mode. Under this threshold the model is skipped.
   * Default: 5
   */
  minSamples?: number;
  /**
   * Rolling window (days) for the routing table — attempts outside the window
   * are excluded. Keeps the table fresh as the repo evolves.
   * Default: 30
   */
  windowDays?: number;
  /**
   * Probability [0, 1] of choosing the exploreModel in the 'small' bucket when
   * the model is under-sampled (< minSamples). Exploration only fires in 'active'
   * mode for the small bucket.
   * Default: 0.1
   */
  exploreRate?: number;
  /**
   * Model alias to explore in the 'small' bucket when it lacks minSamples.
   * Defaults to 'haiku' — the cheapest configured model.
   */
  exploreModel?: string;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const VALID_MODES = new Set(['off', 'advisory', 'active']);

/**
 * Validate and merge a raw routing config block with defaults.
 * Throws a descriptive error on invalid values (same contract as scout/judge merge).
 */
export function mergeRoutingConfig(
  raw: unknown,
  defaults: Required<RoutingConfig>,
): Required<RoutingConfig> {
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('loopkit.config.json: routing must be an object');
  }
  const r = raw as Record<string, unknown>;

  if ('mode' in r && !VALID_MODES.has(r['mode'] as string)) {
    throw new Error(
      `loopkit.config.json: routing.mode '${r['mode']}' is invalid — must be 'off', 'advisory', or 'active'`,
    );
  }
  if ('minSamples' in r) {
    const v = r['minSamples'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
      throw new Error(`loopkit.config.json: routing.minSamples must be a positive integer (got ${JSON.stringify(v)})`);
    }
  }
  if ('windowDays' in r) {
    const v = r['windowDays'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
      throw new Error(`loopkit.config.json: routing.windowDays must be a positive integer (got ${JSON.stringify(v)})`);
    }
  }
  if ('exploreRate' in r) {
    const v = r['exploreRate'];
    if (typeof v !== 'number' || !Number.isFinite(v) || (v as number) < 0 || (v as number) > 1) {
      throw new Error(`loopkit.config.json: routing.exploreRate must be a number in [0, 1] (got ${JSON.stringify(v)})`);
    }
  }
  if ('exploreModel' in r) {
    if (typeof r['exploreModel'] !== 'string' || !(r['exploreModel'] as string).trim()) {
      throw new Error(`loopkit.config.json: routing.exploreModel must be a non-empty string (got ${JSON.stringify(r['exploreModel'])})`);
    }
  }

  return {
    mode: typeof r['mode'] === 'string' && VALID_MODES.has(r['mode'] as string)
      ? r['mode'] as Required<RoutingConfig>['mode']
      : defaults.mode,
    minSamples: typeof r['minSamples'] === 'number' && Number.isFinite(r['minSamples']) && Number.isInteger(r['minSamples']) && (r['minSamples'] as number) >= 1
      ? r['minSamples'] as number
      : defaults.minSamples,
    windowDays: typeof r['windowDays'] === 'number' && Number.isFinite(r['windowDays']) && Number.isInteger(r['windowDays']) && (r['windowDays'] as number) >= 1
      ? r['windowDays'] as number
      : defaults.windowDays,
    exploreRate: typeof r['exploreRate'] === 'number' && Number.isFinite(r['exploreRate']) && (r['exploreRate'] as number) >= 0 && (r['exploreRate'] as number) <= 1
      ? r['exploreRate'] as number
      : defaults.exploreRate,
    exploreModel: typeof r['exploreModel'] === 'string' && (r['exploreModel'] as string).trim()
      ? r['exploreModel'] as string
      : defaults.exploreModel,
  };
}

export const ROUTING_CONFIG_DEFAULTS: Required<RoutingConfig> = {
  mode: 'advisory',
  minSamples: 5,
  windowDays: 30,
  exploreRate: 0.1,
  exploreModel: 'haiku',
};

// ---------------------------------------------------------------------------
// Model choice result
// ---------------------------------------------------------------------------

export interface ModelChoice {
  /** The model to actually use for the build. */
  model: string;
  /**
   * How this model was selected:
   *   'incumbent' → mode=off, or no data qualified, or advisory-returns-incumbent
   *   'data'      → active mode, chosen from table (highest firstPassRate)
   *   'explore'   → active mode, exploration pick (under-sampled candidate)
   */
  modelSource: 'incumbent' | 'data' | 'explore';
  /**
   * In advisory mode: what 'active' would have picked (when it differs from incumbent).
   * Undefined in off/active modes, or when active would pick the same as incumbent.
   */
  modelAdvisory?: string;
}

// ---------------------------------------------------------------------------
// Policy function
// ---------------------------------------------------------------------------

/**
 * Choose a model for the next build dispatch attempt.
 *
 * Pure function — no I/O, no side effects.
 *
 * @param table         - routing table from buildRoutingTable[WithSpecs]
 * @param bucket        - spec bucket for this item
 * @param incumbentModel - the model from item.queued or cfg.models.builderDefault
 * @param cfg           - resolved routing config (with defaults filled)
 * @param rand          - injected RNG, default Math.random; ALWAYS inject in tests
 */
export function chooseModel(
  table: RoutingTable,
  bucket: SpecBucket,
  incumbentModel: string,
  cfg: Required<RoutingConfig>,
  rand: () => number = Math.random,
): ModelChoice {
  // ── mode: off ──────────────────────────────────────────────────────────────
  if (cfg.mode === 'off') {
    return { model: incumbentModel, modelSource: 'incumbent' };
  }

  // ── Compute what 'active' would pick ──────────────────────────────────────
  const activeChoice = computeActiveChoice(table, bucket, incumbentModel, cfg, rand);

  // ── mode: advisory ────────────────────────────────────────────────────────
  if (cfg.mode === 'advisory') {
    // Always use the incumbent; record advisory when it differs.
    const advisory = activeChoice.model !== incumbentModel ? activeChoice.model : undefined;
    return {
      model: incumbentModel,
      modelSource: 'incumbent',
      ...(advisory !== undefined ? { modelAdvisory: advisory } : {}),
    };
  }

  // ── mode: active ──────────────────────────────────────────────────────────
  return activeChoice;
}

/**
 * Internal: compute the model 'active' mode would pick.
 * Called both from chooseModel (for advisory recording) and in active mode.
 */
function computeActiveChoice(
  table: RoutingTable,
  bucket: SpecBucket,
  incumbentModel: string,
  cfg: Required<RoutingConfig>,
  rand: () => number,
): ModelChoice {
  const bucketCells = table[bucket];

  // ── Exploration: small bucket only, when exploreModel is under-sampled ────
  if (bucket === 'small' && cfg.exploreRate > 0) {
    const exploreCell = bucketCells[cfg.exploreModel];
    const explorerSamples = exploreCell?.samples ?? 0;
    if (explorerSamples < cfg.minSamples) {
      // Fire with probability exploreRate
      if (rand() < cfg.exploreRate) {
        return { model: cfg.exploreModel, modelSource: 'explore' };
      }
    }
  }

  // ── Data-driven: among qualified models, pick highest firstPassRate ────────
  const qualified = Object.entries(bucketCells)
    .filter(([, cell]) => cell.samples >= cfg.minSamples);

  if (qualified.length === 0) {
    // No model has enough data — fall back to incumbent
    return { model: incumbentModel, modelSource: 'incumbent' };
  }

  // Sort: highest firstPassRate first; ties broken by lower avgUsd
  qualified.sort(([, a], [, b]) => {
    const rateDiff = b.firstPassRate - a.firstPassRate;
    if (Math.abs(rateDiff) > 1e-9) return rateDiff;
    return a.avgUsd - b.avgUsd;
  });

  const winner = qualified[0]![0];
  if (winner === incumbentModel) {
    // Data agrees with incumbent — still report as 'data' when in active mode
    return { model: winner, modelSource: 'data' };
  }
  return { model: winner, modelSource: 'data' };
}
