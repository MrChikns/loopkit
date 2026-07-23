// Work ledger fold adapter. Maps the loopkit fold substrate
// into a typed `ProjectionEnvelope<WorkLedgerData>`. Same isFoldSummary validator
// as the acceptance adapter (single-reader discipline): never re-derives
// the shape. The loopkit lifecycle vocab (building/approved/parked/…) → status catalog
// entry is decided by ONE deriver, {@link deriveItemStatus} (status-catalog.ts, WI-086/
// WI-087) — this adapter no longer keeps its own FOLD_STATE_TO_OPERATIONAL/foldStateLabel
// copies (that per-adapter drift was the WI-086 bug: the same item read
// 'queued — routing…' here and bare 'queued' on Command).

import { deriveItemStatus, emphasisForTone } from '../states/status-catalog.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { GlanceMetric } from './command-projection.ts';
import { approveActionLabel, deriveOrigin, isFoldSummary, isInterimApprovedStatus, originBadge, parseDecompositionSuccessor, unblockNote } from './fold-adapter.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { BacklogRow } from './planner-adapter.ts';
import type {
  BeatRecord,
  BuildRecord,
  OutcomeRecord,
  BreakerRecord,
} from './workforce-adapter.ts';

export type { BeatRecord, BuildRecord, OutcomeRecord, BreakerRecord } from './workforce-adapter.ts';
// Re-exported so existing callers of THIS module keep working (part of the parkKind-aware
// "what unblocks this" line, and the WI-362 interim-approved-status formula unified onto ONE
// copy, WI-086/WI-087): all three now
// live in fold-adapter.ts, the base boundary layer every adapter already imports from
// (deriveOrigin, isFoldSummary, originBadge) — a reverse import (fold-adapter → work-adapter)
// would create a cycle.
export { parseDecompositionSuccessor, unblockNote, isInterimApprovedStatus };

const SCHEMA_VERSION = '1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Run-controls verb buttons, decided once at the
 * fold-adapter boundary — never in the projection renderer, which only composes shared
 * components. Zero-JS `form:` actions posting to the deterministic verb regexes the
 * host app matches on; verb text/emoji here must match those regexes EXACTLY.
 *
 * Exported (item-hub link sweep, WI-349) so `item-hub-adapter.ts` reuses the SAME verb
 * builder for the hub's action region — one source for which verbs are valid per state,
 * never a second copy that could drift from the host app's verb regexes.
 *
 * @param siblingIds  Other active item ids sharing this item's dispatched branch (batch
 *   co-location) — drives the Stop confirm's "also interrupts WI-X, WI-Y" warning.
 * @param nextPath  Absolute `/command/...` path the verb's `?next=` return returns to —
 *   parameterized (nav IA rewire) so a caller on Workers
 *   returns to Workers, not hardcoded back to Missions/Work.
 */
export function buildRunControlActions(
  id: string,
  state: string,
  parkKind: string | undefined,
  siblingIds: string[],
  nextPath: string,
  branch?: string,
  branchAlive?: boolean,
): WorkItemAction[] {
  const action = `/intent?next=${encodeURIComponent(nextPath)}`;

  if (state === 'building') {
    const coLocationWarning = siblingIds.length > 0
      ? ` This build is batched with ${siblingIds.join(', ')} — stopping it also interrupts and requeues them.`
      : '';
    return [
      {
        id: `work.stop:${id}`,
        label: 'Stop',
        emphasis: 'danger',
        form: {
          action,
          intent: `⏹ stop ${id}`,
          confirm: `Stop ${id} mid-build?${coLocationWarning} This cannot be undone — the build is killed and parked for you to review.`,
        },
      },
      { id: `work.escalate:${id}`, label: 'Escalate', form: { action, intent: `🛎 escalate ${id}` } },
    ];
  }

  if (state === 'queued' || state === 'routed') {
    const actions: WorkItemAction[] = [
      { id: `work.hold:${id}`, label: 'Hold', form: { action, intent: `⏸ hold ${id}` } },
      { id: `work.escalate:${id}`, label: 'Escalate', form: { action, intent: `🛎 escalate ${id}` } },
    ];
    return actions;
  }

  if (state === 'parked') {
    if (parkKind === 'hold') {
      return [
        { id: `work.resume:${id}`, label: 'Resume', emphasis: 'primary', form: { action, intent: `▶ resume ${id}` } },
        { id: `work.retry-sonnet:${id}`, label: 'Retry with sonnet', form: { action, intent: `🔁 retry ${id}: sonnet` } },
        { id: `work.retry-opus:${id}`, label: 'Retry with opus', form: { action, intent: `🔁 retry ${id}: opus` } },
      ];
    }
    if (parkKind === 'decision') {
      // Same verb strings as the decision desk (PARKED_VERB_RE) — wired here too so Missions
      // parked rows stay actionable (not just an alarming badge) and a decision park can be
      // resolved from either surface.
      return [
        { id: `work.parked-approve:${id}`, label: approveActionLabel(branch, branchAlive), emphasis: 'primary', form: { action, intent: `▶ parked ${id}: approve` } },
        { id: `work.parked-decline:${id}`, label: 'Decline — retire', emphasis: 'danger', form: { action, intent: `▶ parked ${id}: decline` } },
      ];
    }
    if (parkKind === 'ops') {
      // Plane-owned mechanical/infra park (never a founder action target) — requeue re-tries it, dismiss is
      // a terminal no-action close (RESOLVE_VERB_RE) so it needs a confirm gate.
      return [
        { id: `work.resume:${id}`, label: 'Requeue now', emphasis: 'primary', form: { action, intent: `▶ resume ${id}` } },
        {
          id: `work.resolve:${id}`,
          label: 'Dismiss — no action',
          emphasis: 'danger',
          form: {
            action,
            intent: `✔ resolve ${id}`,
            confirm: `Dismiss ${id} with no further action? This is terminal — it will not be requeued.`,
          },
        },
      ];
    }
    // decomposition parks need nothing from the founder (queued for planner decomposition) —
    // no buttons, the projection renders a calm neutral badge instead.
    return [];
  }

  return [];
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return '< 1h';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Run-controls action — structurally the same
 *  shape as EventRowProps['actions'] (see components/types.ts EventAction), redeclared here
 *  so work-adapter.ts doesn't need a components/ import (adapters stay presentation-free). */
export type WorkItemAction = {
  id: string;
  label: string;
  emphasis?: 'default' | 'primary' | 'danger';
  form?: { action: string; intent: string; confirm?: string };
};

/** One active work item in the work ledger projection. */
export type WorkItem = {
  id: string;
  state: string;
  operationalState: OperationalState;
  stateLabel: string;
  emphasisForBadge: 'default' | 'blocking' | 'recommended';
  title: string;
  metadata: string[];
  summary?: string;
  spec?: string;
  /** WI-180 origin chip (target / plane / mixed), derived from touches at the boundary. */
  originChip?: { state: OperationalState; label: string };
  /** The assembled scout context pack the agent was given before building (item.briefed).
   *  Absent when the item was built without one — the evidence drawer renders an honest
   *  "no brief" message rather than omitting the block. */
  brief?: { text: string; at: string; model?: string };
  /** Run-controls verb buttons — Stop/Escalate on
   *  in-flight run cards, Hold/Escalate/Retry on queued rows, Resume on hold-parked rows,
   *  Approve/Decline (decision) or Requeue/Dismiss (ops) on parked rows.
   *  Absent/empty for states with no applicable verb (merged, accepted, rejected, answered,
   *  and decomposition parks — those need nothing from the founder). */
  actions?: WorkItemAction[];
  /** Park INTENT kind (ops parks are plane-owned — never a founder action target) —
   *  'decision' | 'ops' | 'hold' | 'decomposition' — set
   *  only when `state === 'parked'`. Drives which actions render and the row's honest
   *  classification — a bare 'parked' badge for every kind would be misleading. */
  parkKind?: string;
  /** For a `parkKind: 'decomposition'` park, the planner successor id parsed from the park
   *  reason ("queued for planner decomposition as WI-NNN") — undefined when unparseable, in
   *  which case the badge falls back to a generic "planner lane" label. */
  successorRef?: string;
  evidence: { id: string; label: string; href: string };
};

/** Workforce sub-fields folded into the Work page (console consolidation 1/4) —
 *  beat health, in-flight builds, breakers, and recent outcomes. Optional so
 *  fixtures/callers built before the fold still type-check without it. */
export type WorkforceSection = {
  beats: BeatRecord[];
  inflight: BuildRecord[];
  recentOutcomes: OutcomeRecord[];
  breakerStates: BreakerRecord[];
};

/** One row of the "why isn't this building?" scheduling readout — a queued or parked item
 *  that is NOT currently in flight, with a concrete reason when it's blocked. Read straight
 *  off the fold's `queueBlocking` (@loopkit/core src/cli.ts `buildQueueBlocking`), which
 *  computes it from the SAME predicates dispatch itself gates on — this projection only
 *  renders a readable list, it never re-decides runnability. */
export type QueueBlockingRow = { id: string; runnable: boolean; reason?: string };

/** The typed payload the work ledger projection renders. */
export type WorkLedgerData = {
  glance: GlanceMetric[];
  active: WorkItem[];
  answered: WorkItem[];
  shippedThisWeek: number;
  /** Console consolidation 1/4: the former standalone Workforce page's sections. */
  workforce?: WorkforceSection;
  /** Console consolidation 4/4: the retired Planner page's groomable-backlog rows —
   *  loopkit work items in a plannable state within open gates. Optional so
   *  fixtures/callers built before the fold still type-check without it. */
  backlog?: BacklogRow[];
  /** "Why isn't this building?" scheduling region. Absent/empty ⇒ the queue is clear. */
  queueBlocking?: QueueBlockingRow[];
};

// Primary sort order within the active board: operator-attention order (WI-102). Five groups,
// top to bottom: (0) decision parks — the only rows that genuinely need the operator's
// judgment; (1) in-flight (building/testing/gated, then approved) — progressing, worth
// watching; (2) blocked — stalled, may need a nudge; (3) queued/routed/captured — waiting its
// turn; (4) plane-owned parks (ops/hold/decomposition, and any parked item with an
// unrecognized/missing parkKind — plane-owned by default, never assumed to need the operator).
// `decision` parks are carved out of the `parked` state into their own top group by
// `attentionGroup` below; STATE_SORT only decides groups 1-4 for every OTHER state (including
// non-decision parked rows, which land in group 4 regardless of what STATE_SORT says for
// 'parked' — kept here only as the fallback group number for that state).
const STATE_SORT: Record<string, number> = {
  building: 1, testing: 1, gated: 1, approved: 1,
  blocked: 2,
  queued: 3, routed: 3, captured: 3,
  parked: 4,
};

// Sub-tier within the in-flight group (group 1, WI-102): building/testing/gated (still running)
// ahead of approved (already decided, just waiting to land) — checked before PRIORITY_SORT so
// priority never pulls an approved row above an actively-building one.
const IN_FLIGHT_SUBSORT: Record<string, number> = {
  building: 0, testing: 0, gated: 0, approved: 1,
};

// Secondary sort within the plane-owned park group (group 4, WI-102): ops/hold parks ahead of
// decomposition parks, which need nothing from anyone (already routed to the planner). An
// unrecognized/missing parkKind falls through to the same tier as ops/hold (plane-owned).
const PARK_KIND_SORT: Record<string, number> = {
  ops: 0, hold: 0, decomposition: 1,
};

// Secondary sort within every group (WI-102): priority — blocker items surface first even
// within their attention band, then high/medium/low, then unset/unrecognized last.
const PRIORITY_SORT: Record<string, number> = {
  blocker: 0, high: 1, medium: 2, low: 3,
};

/** Operator-attention group for a work item (WI-102): 0 = decision parks (need the operator),
 *  1 = in-flight, 2 = blocked, 3 = queued/routed/captured, 4 = plane-owned parks (ops/hold/
 *  decomposition, and any parked item with an unrecognized/missing parkKind — plane-owned by
 *  default, never assumed to need the operator). */
function attentionGroup(state: string, parkKind: string | undefined): number {
  if (state === 'parked' && parkKind === 'decision') return 0;
  return STATE_SORT[state] ?? 3;
}

/** Truthful "Parked" glance split: the count of parked items is not, by
 *  itself, a needs-you signal — only `parkKind: 'decision'` parks are. `ops`/`hold` parks are
 *  plane-owned (requeue/dismiss or resume, no operator judgment call) and `decomposition` parks
 *  are the planner's own queue. The tile shows the total but the "needs attention" subtitle
 *  only fires when a real decision is waiting. */
function buildGlance(counts: Record<string, number>, parkedKinds: Record<string, number>): GlanceMetric[] {
  const inFlight =
    (counts['building'] ?? 0) + (counts['testing'] ?? 0) +
    (counts['gated'] ?? 0) + (counts['approved'] ?? 0) + (counts['blocked'] ?? 0);
  const queued   = (counts['queued'] ?? 0) + (counts['routed'] ?? 0);
  const parked   = (counts['parked'] ?? 0);
  const decisionParked = parkedKinds['decision'] ?? 0;
  const planeOwnedParked = (parkedKinds['ops'] ?? 0) + (parkedKinds['hold'] ?? 0);
  const decompositionParked = parkedKinds['decomposition'] ?? 0;
  const inFlightState: OperationalState = inFlight ? 'progress' : 'neutral';
  const queuedState: OperationalState   = queued > 5 ? 'warning' : queued > 0 ? 'neutral' : 'success';
  const parkedState: OperationalState   = decisionParked ? 'warning' : parked ? 'neutral' : 'success';

  const footnoteParts: string[] = [];
  if (decisionParked > 0) footnoteParts.push('needs attention');
  if (planeOwnedParked > 0) footnoteParts.push(`${planeOwnedParked} plane-owned`);
  if (decompositionParked > 0) footnoteParts.push(`${decompositionParked} planner`);
  const parkedFootnote = footnoteParts.length > 0 ? footnoteParts.join(' · ') : 'nothing blocked';

  return [
    {
      label: 'In flight', value: inFlight,
      footnote: inFlight ? 'actively building' : 'none in flight',
      state: inFlightState,
      open: { kind: 'evidence', id: 'work-board' },
    },
    {
      label: 'Queued', value: queued,
      footnote: queued ? 'waiting to build' : 'lane clear',
      state: queuedState,
      open: { kind: 'evidence', id: 'work-board' },
    },
    {
      label: 'Parked', value: parked,
      footnote: parkedFootnote,
      state: parkedState,
      open: { kind: 'evidence', id: 'work-board' },
    },
  ];
}

/** Build the work ledger envelope from a raw fold summary.
 *  Malformed input yields a `failed` envelope (loud fold failure).
 *  `opts.workforce` (console consolidation 1/4) is passed through untouched into
 *  `data.workforce` when the envelope folds cleanly — the caller builds it via
 *  the same `WorkforceSummary` → typed-records transform the workforce adapter used.
 *  `opts.backlog` (console consolidation 4/4) is passed through the same way into
 *  `data.backlog` — the caller derives it via the same `foldBacklog` + gate-map
 *  filter the retired Planner page used.
 *  `opts.nextPath` (nav IA rewire) sets the run-control
 *  verbs' `?next=` return path — defaults to `/work` (Missions); Workers passes
 *  `/workers` so its own action buttons return to Workers. */
export function workProjectionFromFold(
  raw: unknown,
  opts: { ledgerSequence: number; staleAfterSeconds?: number; workforce?: WorkforceSection; backlog?: BacklogRow[]; nextPath?: string } = { ledgerSequence: 0 },
): ProjectionEnvelope<WorkLedgerData> {
  const staleAfter = opts.staleAfterSeconds ?? 45;
  const nextPath = opts.nextPath ?? '/work';

  if (!isFoldSummary(raw)) {
    return {
      projectionId: 'work',
      schemaVersion: SCHEMA_VERSION,
      foldVersion: 'loopkit',
      ledgerSequence: opts.ledgerSequence,
      generatedAt: new Date().toISOString(),
      freshUntil: new Date().toISOString(),
      state: 'failed',
      data: { glance: [], active: [], answered: [], shippedThisWeek: 0 },
      evidence: [{ id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' }],
    };
  }

  const fold = raw;
  const generatedAt = fold.generatedAt;
  const nowMs = new Date(generatedAt).getTime();
  const freshUntil = new Date(nowMs + staleAfter * 1000).toISOString();

  // Operator-attention order (WI-102): group first, then the group's own state sub-tier (in-
  // flight: building/testing/gated ahead of approved; plane-owned parks: ops/hold ahead of
  // decomposition), then priority within that sub-tier, then the existing relative order
  // (Array.prototype.sort is stable in Node, so ties fall through unchanged — no explicit
  // tertiary key needed).
  const sorted = [...fold.active].sort((a, b) => {
    const ga = attentionGroup(a.state, a.parkKind);
    const gb = attentionGroup(b.state, b.parkKind);
    if (ga !== gb) return ga - gb;
    if (ga === 1) {
      // Within in-flight: building/testing/gated ahead of approved.
      const ia = IN_FLIGHT_SUBSORT[a.state] ?? 0;
      const ib = IN_FLIGHT_SUBSORT[b.state] ?? 0;
      if (ia !== ib) return ia - ib;
    }
    if (ga === 4) {
      // Within the plane-owned park group: ops/hold ahead of decomposition.
      const pa = PARK_KIND_SORT[a.parkKind ?? ''] ?? 0;
      const pb = PARK_KIND_SORT[b.parkKind ?? ''] ?? 0;
      if (pa !== pb) return pa - pb;
    }
    const prioA = PRIORITY_SORT[a.priority ?? ''] ?? 4;
    const prioB = PRIORITY_SORT[b.priority ?? ''] ?? 4;
    return prioA - prioB;
  });

  // Run-controls batch co-location: items sharing
  // a dispatched branch are batched into one worktree/process — stopping the carrier also
  // interrupts every co-located sibling. Computed once here (branch → sibling ids) so the
  // Stop confirm can name them; a branch with only one item has no siblings to warn about.
  const branchGroups = new Map<string, string[]>();
  for (const item of fold.active) {
    const b = (item as unknown as Record<string, unknown>)['branch'];
    const bid = (item as unknown as Record<string, unknown>)['id'];
    if (typeof b !== 'string' || !b || typeof bid !== 'string') continue;
    const list = branchGroups.get(b) ?? [];
    list.push(bid);
    branchGroups.set(b, list);
  }

  const active: WorkItem[] = sorted.map((raw) => {
    // Cast to access loopkit fields not in the FoldActiveItem contract.
    const ext = raw as unknown as Record<string, unknown>;
    const state      = typeof ext['state']      === 'string' ? ext['state']      : 'captured';
    const id         = typeof ext['id']         === 'string' ? ext['id']         : '?';
    const spec       = typeof ext['spec']       === 'string' ? ext['spec'].trim() : '';
    const parkReason = typeof ext['parkReason'] === 'string' ? ext['parkReason'].trim() : '';
    const parkKind   = typeof ext['parkKind']   === 'string' ? ext['parkKind']   : undefined;
    const priority   = typeof ext['priority']   === 'string' ? ext['priority']   : '';
    const attempts   = typeof ext['attempts']   === 'number' ? ext['attempts']   : 0;
    const buildingAt = typeof ext['buildingAt'] === 'string' ? ext['buildingAt'] : '';
    const queuedAt   = typeof ext['queuedAt']   === 'string' ? ext['queuedAt']   : '';
    const parkedAt   = typeof ext['parkedAt']   === 'string' ? ext['parkedAt']   : undefined;
    const lastUnparkedAt = typeof ext['lastUnparkedAt'] === 'string' ? ext['lastUnparkedAt'] : undefined;
    const branch     = typeof ext['branch']     === 'string' ? ext['branch']     : undefined;
    const branchAlive = typeof ext['branchAlive'] === 'boolean' ? ext['branchAlive'] : undefined;
    const touches    = Array.isArray(ext['touches'])
      ? (ext['touches'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;
    const origin     = deriveOrigin(touches);
    const siblingIds = branch ? (branchGroups.get(branch) ?? []).filter((sid) => sid !== id) : [];
    const actions    = buildRunControlActions(id, state, parkKind, siblingIds, nextPath, branch, branchAlive);
    const rawBrief   = ext['brief'];
    const brief      = (typeof rawBrief === 'object' && rawBrief !== null
      && typeof (rawBrief as Record<string, unknown>)['text'] === 'string'
      && typeof (rawBrief as Record<string, unknown>)['at'] === 'string')
      ? {
          text: (rawBrief as Record<string, unknown>)['text'] as string,
          at: (rawBrief as Record<string, unknown>)['at'] as string,
          ...(typeof (rawBrief as Record<string, unknown>)['model'] === 'string'
            ? { model: (rawBrief as Record<string, unknown>)['model'] as string }
            : {}),
        }
      : undefined;

    // WI-362: interim routing status overrides the plain state label/color while a founder
    // verb has landed (approved / a fresh unpark) but the reactor hasn't yet followed up
    // (merged / dispatched) — isInterimApprovedStatus is the ONE formula (fold-adapter.ts),
    // fed into the ONE status deriver (status-catalog.ts deriveItemStatus, WI-086/WI-087) so
    // this label/tone is never re-invented per adapter.
    const interim  = isInterimApprovedStatus(state, lastUnparkedAt, parkedAt);
    const status   = deriveItemStatus({
      state,
      ...(parkKind ? { parkKind } : {}),
      breakerTripped: parkReason.startsWith('breaker:'),
      interimApproved: interim,
    });
    const opState  = status.tone;
    const label    = status.label;
    const emphasis = emphasisForTone(opState);

    const metadata: string[] = [];
    if (priority && priority !== 'unset') metadata.push(`${priority} priority`);
    if (state === 'building' && buildingAt) {
      metadata.push(`${formatAge(nowMs - new Date(buildingAt).getTime())} in flight`);
    }
    if ((state === 'queued' || state === 'routed') && queuedAt) {
      metadata.push(`queued ${formatAge(nowMs - new Date(queuedAt).getTime())}`);
    }
    if (attempts > 1) metadata.push(`attempt ${attempts}`);

    const title = spec
      ? `${id} — ${spec.length > 72 ? spec.slice(0, 72) + '…' : spec}`
      : id;
    const successorRef = state === 'parked' && parkKind === 'decomposition'
      ? parseDecompositionSuccessor(parkReason)
      : undefined;

    return {
      id,
      state,
      operationalState: opState,
      stateLabel: label,
      emphasisForBadge: emphasis,
      title,
      metadata,
      ...(parkReason ? { summary: parkReason } : {}),
      ...(spec       ? { spec }               : {}),
      ...(origin     ? { originChip: originBadge(origin) } : {}),
      ...(brief      ? { brief }              : {}),
      ...(actions.length > 0 ? { actions } : {}),
      ...(state === 'parked' && parkKind ? { parkKind } : {}),
      ...(successorRef ? { successorRef } : {}),
      // Item-hub link sweep (WI-349/WI-353): the evidence link opens the item hub — label
      // unified with fold-adapter.ts's own "Item detail →" (one label, every surface).
      evidence: {
        id: `timeline-${id}`,
        label: 'Item detail →',
        href: `/item/${id}`,
      },
    };
  });

  // Parked-kind counts for the glance tile split — read off the already-mapped `active`
  // items (single source, no re-derivation from raw fold data).
  const parkedKinds: Record<string, number> = {};
  for (const item of active) {
    if (item.state !== 'parked') continue;
    const k = item.parkKind ?? 'unknown';
    parkedKinds[k] = (parkedKinds[k] ?? 0) + 1;
  }

  const shippedThisWeek = (fold.recentMerged ?? []).filter((m) => {
    const t = m.mergedAt ? new Date(m.mergedAt).getTime() : NaN;
    return Number.isFinite(t) && nowMs - t < WEEK_MS;
  }).length;

  const answered: WorkItem[] = (fold.recentAnswered ?? []).map((raw) => {
    const id    = raw.id;
    const spec  = (raw.spec ?? '').trim();
    const route = raw.route ?? 'answered';
    const title = spec
      ? `${id} — ${spec.length > 72 ? spec.slice(0, 72) + '…' : spec}`
      : id;
    return {
      id,
      state: 'answered',
      operationalState: 'neutral' as OperationalState,
      stateLabel: route,
      emphasisForBadge: 'default' as const,
      title,
      metadata: [`route: ${route}`],
      // Item-hub link sweep (WI-349/WI-353): the evidence link opens the item hub — label
      // unified with fold-adapter.ts's own "Item detail →" (one label, every surface).
      evidence: {
        id: `timeline-${id}`,
        label: 'Item detail →',
        href: `/item/${id}`,
      },
    };
  });

  return {
    projectionId: 'work',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'loopkit',
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(fold.counts, parkedKinds), active, answered, shippedThisWeek,
      ...(opts.workforce ? { workforce: opts.workforce } : {}),
      ...(opts.backlog ? { backlog: opts.backlog } : {}),
      queueBlocking: fold.queueBlocking ?? [],
    },
    evidence: [
      { id: 'fold-summary',  kind: 'fold-definition', label: 'loopctl summary --json' },
      { id: 'work-ledger',   kind: 'ledger-events',   label: 'Ledger timeline', href: '/timeline' },
    ],
  };
}
