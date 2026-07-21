// Item hub adapter — WI-349 Slice 1.
// One canonical per-item page composed from the SAME fold + ledger data every other
// surface already reads — never a new data source. The host app assembles the raw
// inputs (fold summary, timeline rows, thread detail, artifacts, deploy receipt) and
// this adapter shapes them into a typed `ProjectionEnvelope<ItemHubData>`;
// malformed/missing input folds to a LOUD failure envelope, never a calm
// "item not found" that could be a broken fold.

import { deriveOrigin, isFoldSummary, isInterimApprovedStatus, originBadge, type FoldSummary } from './fold-adapter.ts';
import { buildRunControlActions, type WorkItemAction } from './work-adapter.ts';
import { buildAcceptanceVerbActions } from './acceptance-projection.ts';
import type { ArtifactRow } from './artifacts-adapter.ts';
import type { ThreadDetailData } from './thread-detail-projection.ts';
import type { TimelineRow } from './timeline-adapter.ts';
import type { OperationalState } from '../states/operational-state.ts';
import { deriveItemStatus } from '../states/status-catalog.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';

/** State header fields (spec: state badge, tier, origin, model, touches, created/updated). */
export type ItemHubHeader = {
  id: string;
  state: string;
  operationalState: OperationalState;
  stateLabel: string;
  spec?: string;
  tier?: string;
  origin?: { state: OperationalState; label: string };
  model?: string;
  touches: string[];
  /** Park reason free text (parked items only) — rendered as the header row's summary so
   *  a decision-id mention inside it (e.g. "blocked pending ADR-003 review") link-sweeps to its
   *  Knowledge anchor (WI-349), the same as every other surface that shows a park reason. */
  parkReason?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** The typed payload the item-hub projection renders. */
export type ItemHubData = {
  header: ItemHubHeader;
  actions: WorkItemAction[];
  timeline: TimelineRow[];
  /** Absent when the item never opened a founder conversation (no EXT ref) — the
   *  projection renders an honest "no conversation" empty state, never a crash. */
  thread?: ThreadDetailData;
  artifacts: ArtifactRow[];
  artifactsTruncated: boolean;
  deployReceipt?: { commit: string; deployed: boolean };
};

/** Last state-transition timestamp for an active item, mirroring fold-adapter's own
 *  lastActivityMs (kept local — a cross-module reverse import isn't warranted for one
 *  four-field max). Undefined when the fold carries none of the candidate timestamps. */
function lastActivity(candidates: Array<string | undefined>): string | undefined {
  const valid = candidates.filter((t): t is string => !!t && !Number.isNaN(new Date(t).getTime()));
  if (valid.length === 0) return undefined;
  return valid.reduce((latest, t) => (new Date(t).getTime() > new Date(latest).getTime() ? t : latest));
}

const failed = (
  itemId: string,
  reason: string,
  ledgerSequence: number,
): ProjectionEnvelope<ItemHubData> => {
  const now = new Date().toISOString();
  return {
    projectionId: 'item-hub',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'loopkit',
    ledgerSequence,
    generatedAt: now,
    freshUntil: now,
    state: 'failed',
    data: {
      header: {
        id: itemId,
        state: 'unknown',
        operationalState: 'neutral',
        stateLabel: 'unknown',
        touches: [],
      },
      actions: [],
      timeline: [],
      artifacts: [],
      artifactsTruncated: false,
    },
    evidence: [{ id: 'fold-summary', kind: 'fold-definition', label: reason }],
  };
};

/** Build the item-hub envelope for one WI-NNN from pre-assembled inputs. The app
 *  boundary reads the fold + ledger + artifact dir; this adapter only shapes it.
 *  An item absent from every fold bucket (active/recentMerged/recentRejected/
 *  recentAnswered) still renders — as an honest "not found in the current fold" header
 *  — rather than throwing, so a stale/very-old WI-NNN link never crashes the hub. */
export function itemHubProjectionFromInput(
  raw: unknown,
  input: {
    itemId: string;
    timeline: TimelineRow[];
    thread?: ThreadDetailData;
    artifacts: ArtifactRow[];
    artifactsTruncated: boolean;
    nextPath: string;
  },
  opts: { ledgerSequence: number; staleAfterSeconds?: number } = { ledgerSequence: 0 },
): ProjectionEnvelope<ItemHubData> {
  const staleAfter = opts.staleAfterSeconds ?? 45;

  if (!isFoldSummary(raw)) {
    return failed(input.itemId, 'loopctl summary --json', opts.ledgerSequence);
  }
  const fold: FoldSummary = raw;
  const generatedAt = fold.generatedAt;
  const freshUntil = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();

  const active = fold.active.find((a) => a.id === input.itemId);
  const merged = fold.recentMerged.find((m) => m.id === input.itemId);
  const rejected = fold.recentRejected?.find((r) => r.id === input.itemId);
  const answered = fold.recentAnswered?.find((a) => a.id === input.itemId);

  let state = 'unknown';
  let spec: string | undefined;
  let touches: string | undefined;
  let tier: string | undefined;
  let model: string | undefined;
  let createdAt: string | undefined;
  let parkReason: string | undefined;
  let actions: WorkItemAction[] = [];

  if (active) {
    state = active.state;
    spec = active.spec;
    touches = active.touches;
    model = active.brief?.model;
    createdAt = active.createdAt;
    if (active.state === 'parked') parkReason = active.parkReason;
    const nextPath = input.nextPath;
    const branchSiblings: string[] = []; // hub is single-item — sibling co-location warning
    // is a Missions/Workers board affordance; the hub still posts the SAME verb, just
    // without the "also interrupts WI-X" detail (the board remains the place to see siblings).
    actions = buildRunControlActions(active.id, active.state, active.parkKind, branchSiblings, nextPath, active.branch, active.branchAlive);
  } else if (merged) {
    state = merged.accepted ? 'accepted' : 'merged';
    spec = merged.spec;
    touches = merged.touches;
    tier = merged.tier;
    createdAt = merged.createdAt;
    actions = buildAcceptanceVerbActions(merged.id, spec ?? merged.id, merged.tier, merged.accepted, input.nextPath);
  } else if (rejected) {
    state = rejected.rejectedBy && rejected.rejectedBy !== 'founder' ? 'superseded' : 'rejected';
    spec = rejected.spec;
  } else if (answered) {
    state = 'answered';
    spec = answered.spec;
  }

  const touchList = touches ? touches.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const origin = deriveOrigin(touches);
  const updatedAt = active
    ? lastActivity([active.createdAt, active.queuedAt, active.buildingAt, active.parkedAt, active.approvedAt])
    : merged?.acceptedAt ?? merged?.mergedAt ?? answered?.answeredAt;

  // ONE status deriver (status-catalog.ts, WI-086/WI-087): `state` above is already fully
  // resolved (raw active state, or 'accepted'/'merged'/'superseded'/'rejected'/'answered') —
  // this used to be a THIRD independent FOLD_STATE_TO_OPERATIONAL/foldStateLabel copy that
  // had actually drifted from fold-adapter.ts's own table (answered/done read 'success' here,
  // 'neutral' there) before this fix.
  const status = deriveItemStatus({
    state,
    ...(active?.parkKind ? { parkKind: active.parkKind } : {}),
    breakerTripped: (active?.parkReason ?? '').startsWith('breaker:'),
    interimApproved: active
      ? isInterimApprovedStatus(active.state, active.lastUnparkedAt, active.parkedAt)
      : false,
  });

  const header: ItemHubHeader = {
    id: input.itemId,
    state,
    operationalState: status.tone,
    stateLabel: status.label,
    ...(spec ? { spec } : {}),
    ...(tier ? { tier } : {}),
    ...(origin ? { origin: originBadge(origin) } : {}),
    ...(model ? { model } : {}),
    touches: touchList,
    ...(parkReason ? { parkReason } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };

  return {
    projectionId: 'item-hub',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'loopkit',
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      header,
      actions,
      timeline: input.timeline,
      ...(input.thread ? { thread: input.thread } : {}),
      artifacts: input.artifacts,
      artifactsTruncated: input.artifactsTruncated,
      ...(merged?.mergeCommit ? { deployReceipt: { commit: merged.mergeCommit, deployed: true } } : {}),
    },
    evidence: [
      { id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' },
      { id: `ledger-${input.itemId}`, kind: 'ledger-events', label: `${input.itemId} ledger events`, href: `/item/${input.itemId}` },
    ],
  };
}
