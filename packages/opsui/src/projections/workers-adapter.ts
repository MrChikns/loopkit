// Workers fold adapter — nav IA rewire. NET-NEW
// projection composed from the pieces relocated OUT of the Work ("Missions") page:
// in-flight run cards, queued/parked rows carrying their Hold/Resume/Retry/Stop/
// Escalate verbs, the "why isn't this building?" scheduling readout, and the
// beats/breaker workforce sections. This adapter is a thin wrapper over
// `workProjectionFromFold` (SAME fold, SAME item-building logic, relocation by
// reuse not re-derivation) with `nextPath` set to Workers' own route so its action
// buttons return to Workers, not Missions.

import { workProjectionFromFold } from './work-adapter.ts';
import type { WorkItem, WorkItemAction, WorkforceSection, QueueBlockingRow } from './work-adapter.ts';
import type { BuildRecord } from './workforce-adapter.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { GlanceMetric } from './command-projection.ts';

const SCHEMA_VERSION = '1';

/** States that render as a queued/parked row on Workers (run-control Hold/Resume/Retry/
 *  Escalate verbs) — building items get their own in-flight card instead, so they are
 *  excluded here to avoid a duplicate row for the same item. */
const QUEUED_ROW_STATES = new Set(['queued', 'routed', 'parked']);

/** One in-flight build JOINED with its run-control actions (Stop/Escalate) — `BuildRecord`
 *  (workforce-adapter.ts) carries the phase/touches detail, `WorkItem.actions` (work-adapter.ts,
 *  same fold) carries the verb buttons; the nav IA rewire wants BOTH on one card
 *  ("in-flight run cards (phase checklist, touches chips, Stop/Escalate)"), so this
 *  adapter joins them by id rather than inventing a third source. */
export type InflightBuild = BuildRecord & { actions?: WorkItemAction[] };

/** The typed payload the Workers projection renders. */
export type WorkersData = {
  glance: GlanceMetric[];
  /** Queued/parked items (NOT building — those render as in-flight cards) carrying their
   *  Hold/Resume/Retry/Escalate verbs. */
  queued: WorkItem[];
  /** In-flight builds joined with their Stop/Escalate actions. */
  inflight: InflightBuild[];
  workforce?: WorkforceSection;
  queueBlocking?: QueueBlockingRow[];
};

function buildGlance(queued: WorkItem[], inflight: InflightBuild[], workforce: WorkforceSection | undefined): GlanceMetric[] {
  const inFlight = inflight.length;
  const blocked = queued.length;
  const breakers = workforce?.breakerStates.length ?? 0;
  return [
    {
      label: 'In flight',
      value: inFlight,
      footnote: inFlight ? 'active worker sessions' : 'lane idle',
      state: inFlight ? 'progress' : 'neutral',
      open: { kind: 'evidence', id: 'inflight-builds' },
    },
    {
      label: 'Queued / parked',
      value: blocked,
      footnote: blocked ? 'waiting on a verb' : 'nothing waiting',
      state: blocked ? 'warning' : 'success',
      open: { kind: 'evidence', id: 'work-board' },
    },
    {
      label: 'Breakers',
      value: breakers,
      footnote: breakers ? 'items exhausted retries' : 'no breakers tripped',
      state: breakers ? 'critical' : 'success',
      open: { kind: 'evidence', id: 'breaker-states' },
    },
  ];
}

/** Build the Workers projection envelope from a raw fold summary. Reuses
 *  `workProjectionFromFold` (same fold, same run-control action wiring) with
 *  `nextPath: '/workers'` so relocated action buttons return here, not to
 *  Missions. Malformed input yields a `failed` envelope (loud fold failure). */
export function workersProjectionFromFold(
  raw: unknown,
  opts: { ledgerSequence: number; staleAfterSeconds?: number; workforce?: WorkforceSection } = { ledgerSequence: 0 },
): ProjectionEnvelope<WorkersData> {
  const inner = workProjectionFromFold(raw, {
    ledgerSequence: opts.ledgerSequence,
    ...(opts.staleAfterSeconds !== undefined ? { staleAfterSeconds: opts.staleAfterSeconds } : {}),
    ...(opts.workforce ? { workforce: opts.workforce } : {}),
    nextPath: '/workers',
  });

  if (inner.state === 'failed') {
    return {
      projectionId: 'workers',
      schemaVersion: SCHEMA_VERSION,
      foldVersion: inner.foldVersion,
      ledgerSequence: inner.ledgerSequence,
      generatedAt: inner.generatedAt,
      freshUntil: inner.freshUntil,
      state: 'failed',
      data: { glance: [], queued: [], inflight: [] },
      evidence: inner.evidence,
    };
  }

  const queued = inner.data.active.filter((item) => QUEUED_ROW_STATES.has(item.state));

  // Join workforce.inflight (BuildRecord: phase/touches detail) with the matching WorkItem's
  // actions (Stop/Escalate, computed by workProjectionFromFold at the SAME fold boundary) —
  // by id. A build with no matching WorkItem (shouldn't happen; both come from the same fold)
  // still renders, just without action buttons.
  const actionsById = new Map(inner.data.active.map((item) => [item.id, item.actions] as const));
  const buildList: BuildRecord[] = inner.data.workforce?.inflight ?? [];
  const joinInflight = (build: BuildRecord): InflightBuild => {
    const actions = actionsById.get(build.id);
    return actions && actions.length > 0 ? { ...build, actions } : { ...build };
  };
  const inflight: InflightBuild[] = buildList.map(joinInflight);

  return {
    projectionId: 'workers',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: inner.foldVersion,
    ledgerSequence: inner.ledgerSequence,
    generatedAt: inner.generatedAt,
    freshUntil: inner.freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(queued, inflight, inner.data.workforce),
      queued,
      inflight,
      ...(inner.data.workforce ? { workforce: inner.data.workforce } : {}),
      queueBlocking: inner.data.queueBlocking ?? [],
    },
    evidence: inner.evidence,
  };
}
