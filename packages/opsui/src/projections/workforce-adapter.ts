// Workforce fold adapter — typed boundary between the loopkit plane's beat/worker
// state and the workforce projection. Reads a `WorkforceSummary` (distinct from
// `FoldSummary` — it carries beat-lastrun age + inflight build detail not present
// in the fold summary) and produces a typed `ProjectionEnvelope<WorkforceData>`.
// Malformed input yields a `failed` envelope (loud failure) — never a
// falsely-calm empty picture that reads as "all quiet" over a broken plane.
//
// Freshness thresholds mirror the loopkit SLO defaults (@loopkit/core src/slo.ts):
//   reactor: 10 × 30 s = 300 s     dispatch: 10 × 60 s = 600 s
// OperationalState is decided here, at the boundary, once — not re-derived downstream.

import type { GlanceMetric } from './command-projection.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { OperationalState } from '../states/operational-state.ts';

const SCHEMA_VERSION = '1';
const REACTOR_STALE_SEC  = 300;  // 10 × 30 s
const DISPATCH_STALE_SEC = 600;  // 10 × 60 s

// ─── Input types (the raw WorkforceSummary shape) ─────────────────────────────

/** Raw beat status from the workforce-status payload. */
export type BeatInfoRaw = { name: string; pid?: number; ageSec?: number };

/** One active build's key fields. */
export type BuildRecord = {
  id: string;
  attempt: number;
  model?: string;
  elapsedMin?: number;
  budgetMin?: number;
  /** Dispatched worktree branch — present once the worker's branch/worktree exists (WI run-card
   *  polish). Absent items still render (no fake dispatch-phase claim). */
  branch?: string;
  /** Comma-joined touched-path prefixes as loopkit emits them (@loopkit/core src/fold.ts) — split
   *  with {@link toTouchList} (fold-adapter.ts) before iterating; NOT a `string[]`. */
  touches?: string;
};

/** An item that exhausted its retry budget (breaker tripped). */
export type BreakerRecord = { id: string; attempts: number; spec?: string };

/** The input shape produced by the workforce-status endpoint (beat lastrun + fold active). */
export type WorkforceSummary = {
  beats: BeatInfoRaw[];
  inflight: BuildRecord[];
  recentOutcomes: Array<{ id: string; outcome: 'merged' | 'parked' | 'rejected'; spec?: string; at?: string }>;
  breakerStates: BreakerRecord[];
  generatedAt: string;
};

// ─── Output types (the WorkforceData the projection renders) ──────────────────

/** Beat info with OperationalState computed at the adapter boundary. */
export type BeatRecord = BeatInfoRaw & { state: OperationalState; stateLabel: string };

/** A recent build outcome with computed visual state. */
export type OutcomeRecord = {
  id: string;
  outcome: 'merged' | 'parked' | 'rejected';
  spec?: string;
  at?: string;
  state: OperationalState;
};

/** The typed payload the workforce projection renders. */
export type WorkforceData = {
  glance: GlanceMetric[];
  beats: BeatRecord[];
  inflight: BuildRecord[];
  recentOutcomes: OutcomeRecord[];
  breakerStates: BreakerRecord[];
};

// ─── Validator ────────────────────────────────────────────────────────────────

export function isWorkforceSummary(v: unknown): v is WorkforceSummary {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r['beats']) &&
    Array.isArray(r['inflight']) &&
    Array.isArray(r['recentOutcomes']) &&
    Array.isArray(r['breakerStates']) &&
    typeof r['generatedAt'] === 'string'
  );
}

// ─── Transforms ───────────────────────────────────────────────────────────────

function staleSec(name: string): number {
  return name === 'dispatch' ? DISPATCH_STALE_SEC : REACTOR_STALE_SEC;
}

function toBeatRecord(raw: BeatInfoRaw): BeatRecord {
  const threshold = staleSec(raw.name);
  let state: OperationalState;
  let stateLabel: string;
  if (raw.ageSec === undefined) {
    state = 'warning'; stateLabel = 'unknown';
  } else if (raw.ageSec > threshold * 2) {
    state = 'critical'; stateLabel = 'stale';
  } else if (raw.ageSec > threshold) {
    state = 'warning'; stateLabel = 'lagging';
  } else {
    state = 'success'; stateLabel = 'current';
  }
  return { ...raw, state, stateLabel };
}

function toOutcomeRecord(
  raw: WorkforceSummary['recentOutcomes'][number],
): OutcomeRecord {
  const state: OperationalState =
    raw.outcome === 'merged' ? 'success' :
    raw.outcome === 'rejected' ? 'neutral' : 'warning';
  return { ...raw, state };
}

function buildGlance(summary: WorkforceSummary, beats: BeatRecord[]): GlanceMetric[] {
  const alive = beats.filter((b) => b.state === 'success').length;
  const total = beats.length;
  const beatState: OperationalState =
    total === 0 ? 'neutral' :
    alive === total ? 'success' :
    alive === 0 ? 'critical' : 'warning';

  const inFlight = summary.inflight.length;
  const breakerCount = summary.breakerStates.length;

  return [
    {
      label: 'Beats alive',
      value: total > 0 ? `${alive}/${total}` : '—',
      footnote:
        total === 0 ? 'no beat data' :
        alive === total ? 'all beats current' : 'one or more lagging',
      state: beatState,
      open: { kind: 'evidence', id: 'beat-status' },
    },
    {
      label: 'In flight',
      value: inFlight,
      footnote: inFlight ? 'active worker sessions' : 'lane idle',
      state: inFlight ? 'progress' : 'neutral',
      open: { kind: 'evidence', id: 'inflight-builds' },
    },
    {
      label: 'Breakers',
      value: breakerCount,
      footnote: breakerCount ? 'items exhausted retries' : 'no breakers tripped',
      state: breakerCount ? 'critical' : 'success',
      open: { kind: 'evidence', id: 'breaker-states' },
    },
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Build the workforce projection envelope from a raw workforce summary.
 *  Unknown or malformed input yields a `failed` envelope. */
export function workforceProjectionFromSummary(
  raw: unknown,
  opts: { ledgerSequence: number; foldVersion?: string; staleAfterSeconds?: number } = { ledgerSequence: 0 },
): ProjectionEnvelope<WorkforceData> {
  const foldVersion = opts.foldVersion ?? 'loopkit';
  const staleAfter = opts.staleAfterSeconds ?? 45;

  if (!isWorkforceSummary(raw)) {
    return {
      projectionId: 'workforce',
      schemaVersion: SCHEMA_VERSION,
      foldVersion,
      ledgerSequence: opts.ledgerSequence,
      generatedAt: new Date().toISOString(),
      freshUntil: new Date().toISOString(),
      state: 'failed',
      data: { glance: [], beats: [], inflight: [], recentOutcomes: [], breakerStates: [] },
      evidence: [{ id: 'workforce-summary', kind: 'fold-definition', label: 'workforce status' }],
    };
  }

  const generatedAt = raw.generatedAt;
  const freshUntil = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();
  const beats = raw.beats.map(toBeatRecord);
  const recentOutcomes = raw.recentOutcomes.map(toOutcomeRecord);

  return {
    projectionId: 'workforce',
    schemaVersion: SCHEMA_VERSION,
    foldVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(raw, beats),
      beats,
      inflight: raw.inflight,
      recentOutcomes,
      breakerStates: raw.breakerStates,
    },
    evidence: [
      { id: 'workforce-summary', kind: 'fold-definition', label: 'workforce status' },
    ],
  };
}
