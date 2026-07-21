// Status catalog — WI-086/WI-087. ONE source of truth for what a work-item's lifecycle
// status MEANS: id, label, tone, icon, and a one-line meaning. `operational-state.ts`
// already owns the visual TONE axis (canonical/semantic-states.json) — this
// module sits one layer above it, mapping every raw fold state + interim qualifier + park
// kind a work item can be in to exactly one catalog entry. `deriveItemStatus` (below) is the
// single deriver: every adapter that used to build its own label (fold-adapter.ts
// buildRecentIntents, work-adapter.ts foldStateLabel, item-hub-adapter.ts foldStateLabel)
// now calls this instead — that's what closes the WI-086 bug (the same item read
// 'queued — routing…' on Missions and bare 'queued' on Command because each adapter derived
// its own label from the same raw fold state).
//
// Strict closed union: never `string` for a semantic status id.

import type { OperationalState } from './operational-state.ts';

/** Every operational status id a work item can carry, across every surface (Command,
 *  Missions, Acceptance, item hub). Interim qualifiers (`routing`, `awaiting-retry`,
 *  `awaiting-dispatch`, `awaiting-verdict`) are distinct ids, not a suffix bolted onto a
 *  base id — that's what let three adapters each invent their own suffix string. */
export type StatusId =
  | 'captured'
  | 'routing'
  | 'queued'
  | 'awaiting-dispatch'
  | 'building'
  | 'collecting'
  | 'parked-decision'
  | 'parked-ops'
  | 'parked-hold'
  | 'parked-decomposition'
  | 'awaiting-retry'
  | 'blocked'
  | 'merged'
  | 'awaiting-verdict'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'answered'
  | 'done'
  | 'unknown';

export type StatusCatalogEntry = {
  id: StatusId;
  /** Founder-facing label — what every StatusBadge across every surface renders. */
  label: string;
  /** Visual tone — always one of the six canonical OperationalState values (never invented
   *  per-status colour); StatusBadge's whole colour contract lives at that layer. */
  tone: OperationalState;
  /** Shape marker reused from StatusBadge's existing emphasis vocabulary (never
   *  colour alone) — 'dot' is the default marker, 'diamond' calls out a blocking state,
   *  'star' a recommended one. Not a bespoke icon set; this repo owns no icon library
   *  (canonical doc §"icon library or owned icon set" — deliberately out of scope). */
  icon: 'dot' | 'diamond' | 'star';
  /** One-line meaning — what an operator should understand this status to mean. Rendered in
   *  the stories catalog entry (WI-087 item 5) so the vocabulary is visible documentation. */
  meaning: string;
};

/** The full catalog, in the order the stories gallery renders it. Every {@link StatusId}
 *  has exactly one entry — the exhaustiveness test in status-catalog.test.ts fails the
 *  build the moment a new id is added here without an entry, or a fold state without a
 *  mapping in {@link deriveItemStatus}. */
export const STATUS_CATALOG: Record<StatusId, StatusCatalogEntry> = {
  captured: {
    id: 'captured',
    label: 'Captured',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'Intent landed on the ledger; not yet routed or queued.',
  },
  routing: {
    id: 'routing',
    label: 'Routing',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'The reactor is classifying this intent into a work item.',
  },
  queued: {
    id: 'queued',
    label: 'Queued',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'Waiting for dispatch to pick it up; nothing is building yet.',
  },
  'awaiting-dispatch': {
    id: 'awaiting-dispatch',
    label: 'Queued — routing…',
    tone: 'progress',
    icon: 'dot',
    meaning: 'A founder verb just landed (approve / unpark); the reactor has not yet followed up with a fresh dispatch.',
  },
  building: {
    id: 'building',
    label: 'Building',
    tone: 'progress',
    icon: 'dot',
    meaning: 'A worker is actively building this item right now.',
  },
  collecting: {
    id: 'collecting',
    label: 'Collecting results',
    tone: 'progress',
    icon: 'dot',
    meaning: 'The build finished and the gate is running or the approval/merge follow-up is in flight.',
  },
  'parked-decision': {
    id: 'parked-decision',
    label: 'Needs your decision',
    tone: 'critical',
    icon: 'diamond',
    meaning: 'Parked on a founder-owned call (conductor park, product-spine, touches-overstep) — the queue is blocked until you answer.',
  },
  'parked-ops': {
    id: 'parked-ops',
    label: 'Parked — recovering',
    tone: 'warning',
    icon: 'star',
    meaning: 'A mechanical/infra failure the plane owns; it auto-retries on the reactor beat, never a founder action target.',
  },
  'parked-hold': {
    id: 'parked-hold',
    label: 'On hold',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'Deliberately deferred — resume when ready; not blocking anything in the meantime.',
  },
  'parked-decomposition': {
    id: 'parked-decomposition',
    label: 'Awaiting planner',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'Approved but too large to build as-is; queued for the planner to split into smaller items.',
  },
  'awaiting-retry': {
    id: 'awaiting-retry',
    label: 'Awaiting retry',
    tone: 'warning',
    icon: 'star',
    meaning: "An ops-park whose breaker hasn't tripped yet — the reactor will auto-requeue it on the next beat.",
  },
  blocked: {
    id: 'blocked',
    label: 'Blocked',
    tone: 'critical',
    icon: 'diamond',
    meaning: 'A hard failure stopped this item; it needs attention before anything else can happen to it.',
  },
  merged: {
    id: 'merged',
    label: 'Merged',
    tone: 'success',
    icon: 'dot',
    meaning: 'Shipped to the branch; may still be awaiting founder acceptance.',
  },
  'awaiting-verdict': {
    id: 'awaiting-verdict',
    label: 'Awaiting your verdict',
    tone: 'warning',
    icon: 'star',
    meaning: 'Merged and deployed; the founder has not yet accepted or rejected it on the acceptance desk.',
  },
  accepted: {
    id: 'accepted',
    label: 'Accepted',
    tone: 'success',
    icon: 'dot',
    meaning: 'Shipped and verified by the founder — closed, no further action.',
  },
  rejected: {
    id: 'rejected',
    label: 'Rejected',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'The founder declined this item; it is closed.',
  },
  superseded: {
    id: 'superseded',
    label: 'Superseded',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'Closed automatically by the plane (duplicate-of-merged, decomposition supersede) — never a founder decline.',
  },
  answered: {
    id: 'answered',
    label: 'Answered',
    tone: 'success',
    icon: 'dot',
    meaning: 'Resolved as a question/duplicate/answer route rather than shipped code — closed, no further action.',
  },
  done: {
    id: 'done',
    label: 'Done',
    tone: 'success',
    icon: 'dot',
    meaning: 'Terminal state for work that closed outside the merge/accept/reject/answer routes.',
  },
  unknown: {
    id: 'unknown',
    label: 'Unknown',
    tone: 'neutral',
    icon: 'dot',
    meaning: 'Not present in any fold bucket the hub knows about — usually a stale or malformed link, never fabricated.',
  },
};

/** Every catalog entry, in declaration order — the stories gallery and the exhaustiveness
 *  test iterate this rather than `Object.keys` so ordering is explicit and stable. */
export const STATUS_IDS: readonly StatusId[] = [
  'captured',
  'routing',
  'queued',
  'awaiting-dispatch',
  'building',
  'collecting',
  'parked-decision',
  'parked-ops',
  'parked-hold',
  'parked-decomposition',
  'awaiting-retry',
  'blocked',
  'merged',
  'awaiting-verdict',
  'accepted',
  'rejected',
  'superseded',
  'answered',
  'done',
  'unknown',
];

/** The minimal fold-shaped fields {@link deriveItemStatus} needs — a subset every
 *  fold-derived record (FoldActiveItem, a merged/rejected/answered row, a thread join) can
 *  satisfy without importing the concrete fold types here (states/ sits below projections/
 *  in the dependency order; a reverse import would create a cycle). */
export type ItemStatusInput = {
  /** Raw lifecycle state — loopkit's ItemState vocabulary (captured/routed/queued/building/
   *  gated/parked/approved/merged/accepted/rejected/done), plus the projection-local
   *  synthetic states (testing/blocked/superseded/answered) already in use across adapters. */
  state: string;
  /** Only meaningful when state === 'parked': 'decision' | 'ops' | 'hold' | 'decomposition'. */
  parkKind?: string;
  /** Ops-park breaker signal — mirrors fold-adapter.ts's own `parkReason.startsWith('breaker:')`
   *  check. Undefined/false ⇒ the ops-park reads as still-recovering (awaiting-retry); true ⇒
   *  the breaker tripped (parked-ops, needs eyes even though it's plane-owned). */
  breakerTripped?: boolean;
  /** WI-362 interim-approved-status signal (work-adapter.ts isInterimApprovedStatus): true in
   *  the narrow window between a founder verb landing (approve / fresh unpark) and the
   *  reactor's follow-up (merged / a fresh dispatch). */
  interimApproved?: boolean;
  /** For a rejected item: who/what closed it. A machine actor (e.g. 'reactor') reads as
   *  'superseded'; 'founder' or absent (pre-WI-331 replays) reads as a real 'rejected'. */
  rejectedBy?: string;
  /** For a merged item: has the founder already accepted it? Distinguishes 'merged'
   *  (still awaiting-verdict once combined with `awaitingVerdict`) from a settled ship. */
  accepted?: boolean;
  /** Explicit override for the merged-but-not-yet-accepted acceptance-desk case — set by
   *  callers (acceptance-adapter) that know an item is sitting in the acceptance queue,
   *  rather than re-deriving that from `accepted === false` (which also covers a plain
   *  'merged' row on Command/Missions, where the plain 'merged' label is correct). */
  awaitingVerdict?: boolean;
};

/** The single deriver: fold-shaped data → one catalog entry. Every adapter that used to
 *  build its own status label calls this instead (WI-086's fix). Unknown/malformed input
 *  never falls through to a fabricated label — it resolves to the explicit 'unknown' entry. */
export function deriveItemStatus(input: ItemStatusInput): StatusCatalogEntry {
  const id = deriveStatusId(input);
  return STATUS_CATALOG[id];
}

function deriveStatusId(input: ItemStatusInput): StatusId {
  const { state } = input;

  if (state === 'parked') {
    if (input.parkKind === 'decision') return 'parked-decision';
    if (input.parkKind === 'hold') return 'parked-hold';
    if (input.parkKind === 'decomposition') return 'parked-decomposition';
    // 'ops' (or an unstamped legacy park, which fold-adapter.ts's isOpsPark also treats as
    // ops-owned): breaker-tripped needs eyes, still-recovering is the calmer awaiting-retry.
    return input.breakerTripped ? 'parked-ops' : 'awaiting-retry';
  }

  if (state === 'queued' || state === 'routed') {
    return input.interimApproved ? 'awaiting-dispatch' : state === 'routed' ? 'routing' : 'queued';
  }
  if (state === 'approved') return input.interimApproved !== false ? 'awaiting-dispatch' : 'collecting';
  if (state === 'building') return 'building';
  if (state === 'testing' || state === 'gated') return 'collecting';
  if (state === 'blocked') return 'blocked';
  if (state === 'captured') return 'captured';

  if (state === 'merged' || state === 'accepted') {
    if (input.accepted || state === 'accepted') return 'accepted';
    if (input.awaitingVerdict) return 'awaiting-verdict';
    return 'merged';
  }

  if (state === 'rejected') {
    const isMachineClosed = !!input.rejectedBy && input.rejectedBy !== 'founder';
    return isMachineClosed ? 'superseded' : 'rejected';
  }
  if (state === 'superseded') return 'superseded';
  if (state === 'answered') return 'answered';
  if (state === 'done') return 'done';

  return 'unknown';
}

/** Emphasis derived from tone alone (mirrors work-adapter.ts's own badgeEmphasis rule,
 *  the never-colour-alone contract): critical → blocking (diamond marker), warning
 *  → recommended (star marker), everything else → default (dot). Every {@link StatusId}'s
 *  hand-authored `icon` field above was chosen to already agree with this derivation — the
 *  exhaustiveness test (status-catalog.test.ts) checks that agreement never drifts. */
export function emphasisForTone(tone: OperationalState): 'default' | 'blocking' | 'recommended' {
  if (tone === 'critical') return 'blocking';
  if (tone === 'warning') return 'recommended';
  return 'default';
}

/** StatusBadge's existing prop shape (component contract unchanged, no redesign)
 *  built FROM a catalog entry rather than a free label string. Callers that used to hand
 *  StatusBadge a raw `{state, label}` pair they derived themselves now pass a
 *  {@link StatusCatalogEntry} through this instead, so a status can only ever be rendered
 *  with its ONE catalog-assigned tone+label+emphasis. */
export function statusBadgeProps(
  entry: StatusCatalogEntry,
  opts: { size?: 'sm' | 'md' } = {},
): { state: OperationalState; label: string; emphasis: 'default' | 'blocking' | 'recommended'; size?: 'sm' | 'md' } {
  return {
    state: entry.tone,
    label: entry.label,
    emphasis: emphasisForTone(entry.tone),
    ...(opts.size ? { size: opts.size } : {}),
  };
}
