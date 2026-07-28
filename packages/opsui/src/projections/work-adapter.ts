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
import type { FoldActiveItem } from './fold-adapter.ts';
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
      // Plane-owned mechanical/infra park (never an operator action target) — requeue re-tries it, dismiss is
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
    // decomposition parks need nothing from the operator (queued for planner decomposition) —
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

export const WORK_GROUP_IDS = [
  'needs-decision',
  'in-progress',
  'waiting-dependency',
  'queued',
  'recovering',
  'held',
  'planning',
] as const;

export type WorkGroupId = typeof WORK_GROUP_IDS[number];
export type WorkGroupFilter = WorkGroupId | 'all';
export const WORK_GROUP_PAGE_SIZE = 8;

export const WORK_GROUP_PAGE_PARAMS: Record<WorkGroupId, string> = {
  'needs-decision': 'decisionPage',
  'in-progress': 'progressPage',
  'waiting-dependency': 'dependencyPage',
  queued: 'queuedPage',
  recovering: 'recoveringPage',
  held: 'heldPage',
  planning: 'planningPage',
};

const WORK_GROUP_META: Record<WorkGroupId, { label: string; description: string }> = {
  'needs-decision': { label: 'Needs decision', description: 'One concrete operator call' },
  'in-progress': { label: 'In progress', description: 'Building, gating, or landing now' },
  'waiting-dependency': { label: 'Waiting on dependency', description: 'Blocked by a named work item or active scope' },
  queued: { label: 'Queued', description: 'Ready and waiting for capacity' },
  recovering: { label: 'Recovering', description: 'Plane-owned retry or breaker recovery' },
  held: { label: 'Held', description: 'Deliberately paused' },
  planning: { label: 'Planning', description: 'Waiting for planner decomposition' },
};

export function parseWorkGroup(value: string | null | undefined): WorkGroupFilter {
  return value && (WORK_GROUP_IDS as readonly string[]).includes(value)
    ? value as WorkGroupId
    : 'all';
}

export type WorkGroupPage = {
  id: WorkGroupId;
  label: string;
  description: string;
  total: number;
  page: number;
  pageCount: number;
  items: WorkItem[];
  prevHref?: string;
  nextHref?: string;
};

export type WorkGroupFilterLink = {
  id: WorkGroupFilter;
  label: string;
  count: number;
  href: string;
  active: boolean;
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
  group?: WorkGroupId;
  reason?: string;
  age?: string;
  blocker?: { id: string; state?: string; parkKind?: string };
  nextAction?: string;
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
   *  and decomposition parks — those need nothing from the operator). */
  actions?: WorkItemAction[];
  /** Park INTENT kind (ops parks are plane-owned — never an operator action target) —
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
  /** Adapter-owned semantic groups. Optional only for compatibility with older fixtures. */
  groups?: WorkGroupPage[];
  groupFilter?: WorkGroupFilter;
  groupFilters?: WorkGroupFilterLink[];
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

// Sub-tier within the in-flight group (group 1, WI-102): building/testing/gated (still running)
// ahead of approved (already decided, just waiting to land) — checked before PRIORITY_SORT so
// priority never pulls an approved row above an actively-building one.
const IN_FLIGHT_SUBSORT: Record<string, number> = {
  building: 0, testing: 0, gated: 0, approved: 1,
};

// Secondary sort within every group (WI-102): priority — blocker items surface first even
// within their attention band, then high/medium/low, then unset/unrecognized last.
const PRIORITY_SORT: Record<string, number> = {
  blocker: 0, high: 1, medium: 2, low: 3,
};

const WORK_GROUP_ORDER = new Map<WorkGroupId, number>(
  WORK_GROUP_IDS.map((id, index) => [id, index]),
);

function blockerIdFromReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return /(?:waiting|blocked)\s+on\s+(WI-\d+)/iu.exec(reason)?.[1];
}

/** The one Work-board semantic classifier. Scheduling evidence can refine a queued item into
 *  a dependency wait or an exhausted item into a decision, but presentation never re-decides
 *  the group. */
export function classifyWorkGroup(
  item: Pick<FoldActiveItem, 'state' | 'parkKind' | 'blockedOn'>,
  queueBlocking?: QueueBlockingRow,
): WorkGroupId {
  if (item.state === 'parked' && item.parkKind === 'decision') return 'needs-decision';
  if (queueBlocking?.reason?.includes('needs fresh unpark')) return 'needs-decision';
  if (item.state === 'parked' && item.parkKind === 'hold') return 'held';
  if (item.state === 'parked' && item.parkKind === 'decomposition') return 'planning';
  if (item.blockedOn || item.state === 'blocked' || blockerIdFromReason(queueBlocking?.reason)) {
    return 'waiting-dependency';
  }
  if (item.state === 'building' || item.state === 'testing' || item.state === 'gated' || item.state === 'approved') {
    return 'in-progress';
  }
  if (item.state === 'parked') return 'recovering';
  return 'queued';
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

function workAge(
  item: Pick<FoldActiveItem, 'state' | 'createdAt' | 'queuedAt' | 'buildingAt' | 'parkedAt' | 'approvedAt'>,
  nowMs: number,
): string | undefined {
  const at = item.state === 'building'
    ? item.buildingAt
    : item.state === 'approved'
      ? item.approvedAt
      : item.state === 'parked'
        ? item.parkedAt
        : item.queuedAt ?? item.createdAt;
  if (!at) return undefined;
  const atMs = Date.parse(at);
  return Number.isFinite(atMs) ? formatAge(nowMs - atMs) : undefined;
}

function workReason(
  group: WorkGroupId,
  stateLabel: string,
  parkReason: string,
  queueBlocking: QueueBlockingRow | undefined,
  blockerId: string | undefined,
): string {
  if (group === 'waiting-dependency') {
    return queueBlocking?.reason ?? (blockerId ? `Blocked on ${blockerId}` : 'Waiting on a dependency');
  }
  if (group === 'queued') return queueBlocking?.reason ?? 'Ready; waiting for worker capacity';
  if (group === 'in-progress') return stateLabel;
  if (parkReason) return parkReason;
  if (group === 'held') return 'Deliberately paused';
  if (group === 'planning') return 'Waiting for planner decomposition';
  if (group === 'recovering') return 'No recovery reason recorded';
  return 'Decision reason not recorded';
}

function nextActionFor(
  group: WorkGroupId,
  parkKind: string | undefined,
  parkReason: string,
  blocker: { id: string; state?: string; parkKind?: string } | undefined,
): string {
  switch (group) {
    case 'needs-decision':
      return parkKind === 'decision' ? 'Approve or decline' : 'Escalate for a fresh unpark';
    case 'in-progress':
      return 'Plane gates and lands it';
    case 'waiting-dependency':
      if (!blocker) return 'Wait for the active scope conflict to clear';
      if (blocker.parkKind === 'hold') return `Resume ${blocker.id} first`;
      if (blocker.parkKind === 'decision') return `Resolve ${blocker.id} first`;
      if (blocker.state === 'rejected' || blocker.state === 'answered' || blocker.state === 'done' || blocker.state === 'missing') {
        return 'Plane escalates after the dependency wait window';
      }
      return `Wait for ${blocker.id} to land`;
    case 'queued':
      return 'Plane starts it when capacity and scope are available';
    case 'recovering':
      return parkReason.startsWith('breaker:') ? 'Requeue now or dismiss' : 'Plane retries; breaker escalates';
    case 'held':
      return 'Resume when ready';
    case 'planning': {
      const successor = parseDecompositionSuccessor(parkReason);
      return successor ? `Wait for planner item ${successor}` : 'Planner creates the next slice';
    }
  }
}

function pageHref(
  group: WorkGroupId,
  targetPage: number,
  selected: WorkGroupFilter,
  pages: Record<WorkGroupId, number>,
): string {
  const query: string[] = [];
  if (selected !== 'all') query.push(`group=${encodeURIComponent(selected)}`);
  for (const id of WORK_GROUP_IDS) {
    const page = id === group ? targetPage : pages[id];
    if (page > 1) query.push(`${WORK_GROUP_PAGE_PARAMS[id]}=${page}`);
  }
  const qs = query.length > 0 ? `?${query.join('&')}` : '';
  return `/work${qs}#work-group-${group}`;
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
  opts: {
    ledgerSequence: number;
    staleAfterSeconds?: number;
    workforce?: WorkforceSection;
    backlog?: BacklogRow[];
    nextPath?: string;
    group?: string | null;
    pages?: Partial<Record<WorkGroupId, number>>;
    pageSize?: number;
  } = { ledgerSequence: 0 },
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
  const queueBlockingById = new Map(
    (fold.queueBlocking ?? []).map((row) => [row.id, row]),
  );

  // Adapter-owned semantic group order, then in-progress substate, then priority. Stable sort
  // preserves ledger order when all explicit attention keys tie.
  const sorted = [...fold.active].sort((a, b) => {
    const groupA = classifyWorkGroup(a, queueBlockingById.get(a.id));
    const groupB = classifyWorkGroup(b, queueBlockingById.get(b.id));
    const ga = WORK_GROUP_ORDER.get(groupA) ?? WORK_GROUP_IDS.length;
    const gb = WORK_GROUP_ORDER.get(groupB) ?? WORK_GROUP_IDS.length;
    if (ga !== gb) return ga - gb;
    if (groupA === 'in-progress') {
      // Within in-flight: building/testing/gated ahead of approved.
      const ia = IN_FLIGHT_SUBSORT[a.state] ?? 0;
      const ib = IN_FLIGHT_SUBSORT[b.state] ?? 0;
      if (ia !== ib) return ia - ib;
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
    const blockedOn  = typeof ext['blockedOn']  === 'string' ? ext['blockedOn']  : undefined;
    const blockerState = typeof ext['blockerState'] === 'string' ? ext['blockerState'] : undefined;
    const blockerParkKind = typeof ext['blockerParkKind'] === 'string' ? ext['blockerParkKind'] : undefined;
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

    // WI-362: interim routing status overrides the plain state label/color while an operator
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
    const queueBlocking = queueBlockingById.get(id);
    const group = classifyWorkGroup({
      state,
      ...(parkKind ? { parkKind } : {}),
      ...(blockedOn ? { blockedOn } : {}),
    }, queueBlocking);
    const reasonBlocker = blockerIdFromReason(queueBlocking?.reason);
    const blockerId = blockedOn ?? reasonBlocker;
    const blocker = blockerId
      ? {
          id: blockerId,
          ...(blockedOn && blockerState ? { state: blockerState } : {}),
          ...(blockedOn && blockerParkKind ? { parkKind: blockerParkKind } : {}),
        }
      : undefined;
    const age = workAge({
      state,
      ...(typeof ext['createdAt'] === 'string' ? { createdAt: ext['createdAt'] } : {}),
      ...(queuedAt ? { queuedAt } : {}),
      ...(buildingAt ? { buildingAt } : {}),
      ...(parkedAt ? { parkedAt } : {}),
      ...(typeof ext['approvedAt'] === 'string' ? { approvedAt: ext['approvedAt'] } : {}),
    }, nowMs);
    const reason = workReason(group, label, parkReason, queueBlocking, blockerId);
    const nextAction = nextActionFor(group, parkKind, parkReason, blocker);

    const metadata: string[] = [];
    if (priority && priority !== 'unset') metadata.push(`${priority} priority`);
    if (age) metadata.push(`age ${age}`);
    if (blocker) metadata.push(`blocked by ${blocker.id}${blocker.state ? ` · ${blocker.state}` : ''}`);
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
      group,
      reason,
      ...(age ? { age } : {}),
      ...(blocker ? { blocker } : {}),
      nextAction,
      summary: reason,
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

  const groupFilter = parseWorkGroup(opts.group);
  const pageSize = Number.isFinite(opts.pageSize) && (opts.pageSize ?? 0) > 0
    ? Math.floor(opts.pageSize!)
    : WORK_GROUP_PAGE_SIZE;
  const requestedPages = Object.fromEntries(
    WORK_GROUP_IDS.map((id) => {
      const rawPage = opts.pages?.[id] ?? 1;
      return [id, Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1];
    }),
  ) as Record<WorkGroupId, number>;

  const groups: WorkGroupPage[] = WORK_GROUP_IDS.map((id) => {
    const allItems = active.filter((item) => item.group === id);
    const pageCount = Math.max(1, Math.ceil(allItems.length / pageSize));
    const page = Math.min(requestedPages[id], pageCount);
    requestedPages[id] = page;
    const start = (page - 1) * pageSize;
    const meta = WORK_GROUP_META[id];
    return {
      id,
      label: meta.label,
      description: meta.description,
      total: allItems.length,
      page,
      pageCount,
      items: allItems.slice(start, start + pageSize),
    };
  });

  // Pagination links preserve every other group's current page, so paging Recovering never
  // resets Needs decision (and vice versa). Filters intentionally reset pagination: switching
  // attention modes always starts at the first row.
  for (const group of groups) {
    if (group.page > 1) {
      group.prevHref = pageHref(group.id, group.page - 1, groupFilter, requestedPages);
    }
    if (group.page < group.pageCount) {
      group.nextHref = pageHref(group.id, group.page + 1, groupFilter, requestedPages);
    }
  }
  const groupFilters: WorkGroupFilterLink[] = [
    {
      id: 'all',
      label: 'All',
      count: active.length,
      href: '/work',
      active: groupFilter === 'all',
    },
    ...groups.map((group) => ({
      id: group.id,
      label: group.label,
      count: group.total,
      href: `/work?group=${encodeURIComponent(group.id)}#work-board`,
      active: groupFilter === group.id,
    })),
  ];

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
      glance: buildGlance(fold.counts, parkedKinds),
      active,
      groups,
      groupFilter,
      groupFilters,
      answered,
      shippedThisWeek,
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
