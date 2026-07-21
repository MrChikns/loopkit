// Health projection adapter — WI-160. Maps an OpsHealthBoard (produced by
// buildOpsHealthBoard / loopctl slo --json in the app layer) into a typed
// ProjectionEnvelope<HealthData>. The adapter owns the SloStatus → OperationalState
// mapping, decided once at the boundary. Malformed input yields a `failed`
// envelope — loud, never calm.

import type { GlanceMetric } from './command-projection.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { ArtifactsData } from './artifacts-adapter.ts';

const SCHEMA_VERSION = '1';

export type SloStatus = 'met' | 'at-risk' | 'breached' | 'unknown' | 'paused';

/** One SLO row in the health projection — mirrors the host app's own SloRow shape,
 *  with `status` → `state` (ops-ui convention) and `href` → `evidence`. */
export type HealthSloRow = {
  key: string;
  label: string;
  state: SloStatus;
  value: string;
  target: string;
  evidence?: string;
  /** Graduation metadata: stable for N clean days, eligible to promote its SLO target. */
  graduation?: { cleanDays: number; eligible: boolean };
};

export type HealthPane = {
  title: string;
  rows: HealthSloRow[];
};

export type HealthRollup = {
  state: SloStatus;
  label: string;
  breached: number;
  atRisk: number;
};

export type HealthData = {
  glance: GlanceMetric[];
  rollup: HealthRollup;
  panes: HealthPane[];
  /** Self-heal activity feed (heal.proposed / heal.executed / heal.escalated,
   *  the reactor's heal step) — optional so callers built before this slice still
   *  type-check without it. */
  healActivity?: HealActivityEntry[];
  /** Active time window the healActivity feed was filtered to (WI-359 follow-up) —
   *  drives the feed's WindowPicker active state. Present iff healActivity is. */
  healWindow?: '24h' | '7d' | '30d';
  /** Current OPS_AUTONOMY tier the reactor's heal step runs at — badges the feed above
   *  so the founder can judge readiness to raise it (watch → propose → heal). */
  opsAutonomy?: OpsAutonomyMode;
  /** Nav collapse 9→5 (WI-350): the System page's top strip — quota utilization, spend,
   *  first-pass rate, acceptance split (plane-observability-adapter.ts's
   *  `analyticsStripFromData`, same logic Analytics itself uses). Absent when the caller
   *  hasn't wired plane-observability data through yet (strip omitted, never blank). */
  analyticsStrip?: GlanceMetric[];
  /** Nav collapse 9→5 (WI-350): real build artifacts (gate logs, diffs, salvage patches),
   *  passed through untouched — same data artifacts-adapter.ts's own `readArtifacts` call
   *  produces. Absent when the caller hasn't wired it through yet (region omitted). */
  artifacts?: ArtifactsData;
};

export type OpsAutonomyMode = 'watch' | 'propose' | 'heal';

/** One heal.* ledger event (item === 'system'), shaped for the activity feed.
 *  Mirrors the three heal event data shapes in @loopkit/core src/schema.ts —
 *  fields not carried by a given `kind` are simply absent. */
export type HealActivityEntry = {
  ts: string;
  key: string;
  kind: 'proposed' | 'executed' | 'escalated';
  /** proposed/executed: the runbook action; escalated: the reason it escalated. */
  action: string;
  tier?: string;
  detail?: string;
  evidence?: string;
  count?: number;
};

/** SloStatus → OperationalState: the single mapping point so downstream
 *  renderers never re-derive it (mirrors state semantics). */
export const SLO_STATE_TO_OP: Record<SloStatus, OperationalState> = {
  met:       'success',
  'at-risk': 'warning',
  breached:  'critical',
  unknown:   'neutral',
  paused:    'neutral',
};

// --- Type guards (local mirror of app-side OpsHealthBoard — no cross-pkg import) --

function isSloRow(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['key'] === 'string' && typeof r['label'] === 'string'
    && typeof r['value'] === 'string' && typeof r['target'] === 'string'
    && typeof r['status'] === 'string';
}

function isSloPane(v: unknown): v is { title: string; rows: unknown[] } {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p['title'] === 'string' && Array.isArray(p['rows']);
}

/** Return true if `raw` looks like an OpsHealthBoard from the app layer. */
export function isOpsHealthBoard(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b['panes'])) return false;
  const rollup = b['rollup'];
  if (!rollup || typeof rollup !== 'object') return false;
  const r = rollup as Record<string, unknown>;
  return typeof r['status'] === 'string' && typeof r['label'] === 'string';
}

// --- Helpers ------------------------------------------------------------------

function toSloStatus(s: string): SloStatus {
  if (s === 'met' || s === 'at-risk' || s === 'breached' || s === 'unknown' || s === 'paused') return s;
  return 'unknown';
}

function buildGlance(rollup: HealthRollup): GlanceMetric[] {
  const op = SLO_STATE_TO_OP[rollup.state];
  const target = { kind: 'projection' as const, id: 'health' };
  return [
    {
      label: 'System health',
      value: rollup.label,
      footnote: rollup.breached > 0
        ? `${rollup.breached} SLO${rollup.breached !== 1 ? 's' : ''} breached`
        : rollup.atRisk > 0 ? `${rollup.atRisk} at risk` : 'all indicators checked',
      state: op,
      open: target,
    },
    {
      label: 'Breached',
      value: rollup.breached,
      footnote: rollup.breached ? 'needs immediate attention' : 'none',
      state: rollup.breached > 0 ? 'critical' : 'success',
      open: target,
    },
    {
      label: 'At risk',
      value: rollup.atRisk,
      footnote: rollup.atRisk ? 'approaching threshold' : 'none',
      state: rollup.atRisk > 0 ? 'warning' : 'success',
      open: target,
    },
  ];
}

function toRow(r: Record<string, unknown>): HealthSloRow {
  const grad = r['graduation'];
  const graduation =
    grad && typeof grad === 'object'
      ? {
          cleanDays: Number((grad as Record<string, unknown>)['cleanDays'] ?? 0),
          eligible: Boolean((grad as Record<string, unknown>)['eligible']),
        }
      : undefined;
  return {
    key: r['key'] as string,
    label: r['label'] as string,
    state: toSloStatus(r['status'] as string),
    value: r['value'] as string,
    target: r['target'] as string,
    ...(typeof r['href'] === 'string' ? { evidence: r['href'] as string } : {}),
    ...(graduation !== undefined ? { graduation } : {}),
  };
}

// --- Heal activity feed (WI-326) -----------------------------------------------
// The app layer hands us raw ledger events (RawEvent-shaped: {ts, type, data, ...}),
// unfiltered. We pick out heal.proposed/executed/escalated and validate each `data`
// shape against @loopkit/core src/schema.ts before trusting a field.

function isRawHealEvent(v: unknown): v is { ts: string; type: string; data: Record<string, unknown> } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['ts'] === 'string' && typeof r['type'] === 'string'
    && !!r['data'] && typeof r['data'] === 'object';
}

function toHealActivityEntry(ev: { ts: string; type: string; data: Record<string, unknown> }): HealActivityEntry | undefined {
  const d = ev.data;
  if (typeof d['key'] !== 'string') return undefined;

  if (ev.type === 'heal.proposed') {
    if (typeof d['action'] !== 'string' || typeof d['tier'] !== 'string') return undefined;
    return {
      ts: ev.ts, key: d['key'], kind: 'proposed', action: d['action'], tier: d['tier'],
      ...(typeof d['detail'] === 'string' ? { detail: d['detail'] } : {}),
    };
  }
  if (ev.type === 'heal.executed') {
    if (typeof d['action'] !== 'string' || typeof d['evidence'] !== 'string') return undefined;
    return { ts: ev.ts, key: d['key'], kind: 'executed', action: d['action'], evidence: d['evidence'] };
  }
  if (ev.type === 'heal.escalated') {
    if (typeof d['reason'] !== 'string') return undefined;
    return {
      ts: ev.ts, key: d['key'], kind: 'escalated', action: d['reason'],
      ...(typeof d['count'] === 'number' ? { count: d['count'] } : {}),
    };
  }
  return undefined;
}

/** Build the heal activity feed from raw ledger events (any item; heal events all
 *  carry item === 'system'). Unknown types and malformed shapes are filtered out —
 *  fail-soft: a bad row never breaks the whole feed. Sorted
 *  newest-first regardless of input order. */
export function healActivityFromEvents(raw: unknown[]): HealActivityEntry[] {
  return raw
    .filter(isRawHealEvent)
    .map(toHealActivityEntry)
    .filter((e): e is HealActivityEntry => e !== undefined)
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

// --- Entry point -------------------------------------------------------------

/** Build the health projection envelope from a raw OpsHealthBoard.
 *  Unknown or malformed input yields a `failed` envelope. */
export function healthProjectionFromBoard(
  raw: unknown,
  opts: {
    ledgerSequence: number;
    boardVersion?: string;
    staleAfterSeconds?: number;
    generatedAt?: string;
    /** Passed through untouched into `data.healActivity` — build via
     *  healActivityFromEvents at the call site. */
    healActivity?: HealActivityEntry[];
    /** Current OPS_AUTONOMY tier, passed through into `data.opsAutonomy`. */
    opsAutonomy?: OpsAutonomyMode;
    /** Passed through untouched into `data.analyticsStrip`. */
    analyticsStrip?: GlanceMetric[];
    /** Passed through untouched into `data.artifacts`. */
    artifacts?: ArtifactsData;
    /** Time window for the self-heal activity feed (WI-359 follow-up) — filters
     *  `healActivity` by entry ts and drives the feed's WindowPicker active state.
     *  The SLO board itself is current-state and is never window-filtered. */
    window?: '24h' | '7d' | '30d';
  } = { ledgerSequence: 0 },
): ProjectionEnvelope<HealthData> {
  const boardVersion = opts.boardVersion ?? 'opshealth@1';
  const staleAfter = opts.staleAfterSeconds ?? 300;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  const FAILED: ProjectionEnvelope<HealthData> = {
    projectionId: 'health',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: boardVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil: generatedAt,
    state: 'failed',
    data: {
      glance: [],
      rollup: { state: 'unknown', label: 'board unavailable', breached: 0, atRisk: 0 },
      panes: [],
    },
    evidence: [{ id: 'health-board', kind: 'metric-query', label: 'loopctl slo --json + OS probes' }],
  };

  if (!isOpsHealthBoard(raw)) return FAILED;

  const board = raw as {
    rollup: { status: string; label: string; breached: number; atRisk: number };
    panes: unknown[];
  };

  const nowMs = new Date(generatedAt).getTime();
  const freshUntil = new Date(nowMs + staleAfter * 1000).toISOString();

  const rollup: HealthRollup = {
    state: toSloStatus(board.rollup.status),
    label: board.rollup.label,
    breached: board.rollup.breached ?? 0,
    atRisk: board.rollup.atRisk ?? 0,
  };

  const panes: HealthPane[] = board.panes
    .filter(isSloPane)
    .map((p) => ({
      title: p.title,
      rows: p.rows.filter(isSloRow).map(toRow),
    }));

  return {
    projectionId: 'health',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: boardVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(rollup), rollup, panes,
      ...(opts.healActivity !== undefined
        ? (() => {
            const w = opts.window ?? '7d';
            const cutoffMs = (w === '24h' ? 24 : w === '30d' ? 30 * 24 : 7 * 24) * 60 * 60 * 1000;
            return {
              healActivity: opts.healActivity.filter((e) => {
                const t = new Date(e.ts).getTime();
                return Number.isFinite(t) && nowMs - t < cutoffMs;
              }),
              healWindow: w,
            };
          })()
        : {}),
      ...(opts.opsAutonomy ? { opsAutonomy: opts.opsAutonomy } : {}),
      ...(opts.analyticsStrip ? { analyticsStrip: opts.analyticsStrip } : {}),
      ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    },
    evidence: [
      { id: 'health-board', kind: 'metric-query', label: 'loopctl slo --json + OS probes' },
    ],
  };
}
