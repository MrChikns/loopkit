// Planner projection adapter. Takes typed gate-map waves and
// groomable-backlog rows directly (fixture-driven; the wire-up slice binds the real
// gate-map and fold sources). The state vocabulary lives at the boundary, decided
// once here — the design-system maps stay separate (single-reader discipline).

import type { OperationalState } from '../states/operational-state.ts';
import type { GlanceMetric } from './command-projection.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';

/** One gate-map wave row — gate id, short title, lane stage, open/closed status,
 *  and optionally what gate this one opens (for dependency display). */
export type GateRow = {
  id: string;
  title: string;
  stage: string;
  status: string;
  opens?: string;
};

/** One groomable-backlog row — loopkit work item in a plannable state. */
export type BacklogRow = {
  id: string;
  title: string;
  priority: string;
  state: string;
};

/** The typed payload the planner projection renders. */
export type PlannerData = {
  glance: GlanceMetric[];
  gates: GateRow[];
  backlog: BacklogRow[];
};

function gateStatusToOp(status: string): OperationalState {
  if (status === 'open')   return 'success';
  if (status === 'active') return 'progress';
  return 'neutral';
}

function backlogStateToOp(state: string): OperationalState {
  if (state === 'blocked')  return 'critical';
  if (state === 'parked')   return 'warning';
  if (state === 'building') return 'progress';
  return 'neutral';
}

// Exported so the projection can re-use the same mapping for badge styling.
export { gateStatusToOp, backlogStateToOp };

function buildGlance(gates: GateRow[], backlog: BacklogRow[]): GlanceMetric[] {
  const openCount  = gates.filter((g) => g.status === 'open' || g.status === 'active').length;
  const groomable  = backlog.filter((r) => r.state === 'queued' || r.state === 'routed').length;
  const needsAttn  = backlog.filter((r) => r.state === 'blocked' || r.state === 'parked').length;
  return [
    {
      label: 'Open gates',
      value: openCount,
      footnote: openCount ? 'groomable work available' : 'no gates open yet',
      state: openCount ? 'success' : 'neutral',
      open: { kind: 'evidence', id: 'gate-map' },
    },
    {
      label: 'Groomable',
      value: groomable,
      footnote: groomable ? 'queued and waiting' : 'nothing to groom',
      state: groomable ? 'neutral' : 'success',
      open: { kind: 'evidence', id: 'planner-backlog' },
    },
    {
      label: 'Needs attention',
      value: needsAttn,
      footnote: needsAttn ? 'parked or blocked' : 'nothing blocked',
      state: needsAttn ? 'warning' : 'success',
      open: { kind: 'evidence', id: 'planner-backlog' },
    },
  ];
}

/** Build the planner projection envelope from typed gate and backlog arrays.
 *  No fold summary is needed — the wire-up slice provides the real sources. */
export function plannerProjectionFromInput(
  input: { gates: GateRow[]; backlog: BacklogRow[] },
  opts: { ledgerSequence: number; generatedAt: string; staleAfterSeconds?: number; gateMapLabel?: string },
): ProjectionEnvelope<PlannerData> {
  const staleAfter  = opts.staleAfterSeconds ?? 45;
  const generatedAt = opts.generatedAt;
  const nowMs       = new Date(generatedAt).getTime();
  const freshUntil  = new Date(nowMs + staleAfter * 1000).toISOString();

  return {
    projectionId: 'planner',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'fixture',
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance:  buildGlance(input.gates, input.backlog),
      gates:   input.gates,
      backlog: input.backlog,
    },
    evidence: [
      { id: 'gate-map',         kind: 'artifact',      label: opts.gateMapLabel ?? 'gate map' },
      { id: 'planner-backlog',  kind: 'fold-definition', label: 'loopctl summary --json' },
    ],
  };
}
