// Threads fold adapter — maps the loopkit fold's `threads` projection (the
// WI-145 summary --json shape) into a typed
// `ProjectionEnvelope<ThreadsData>`. Thread data is validated through the one
// `isFoldSummary` parser (single-reader discipline); malformed input
// yields a LOUD failure envelope, never a calm empty state that
// reads as "no threads yet".

import type { OperationalState } from '../states/operational-state.ts';
import { deriveItemStatus, STATUS_CATALOG, type StatusId } from '../states/status-catalog.ts';
import type { GlanceMetric } from './command-projection.ts';
import { isFoldSummary, isResolvableExternalRef } from './fold-adapter.ts';
import type { FoldSummary, FoldThread } from './fold-adapter.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';

export type { FoldThread };

export type ThreadMessage = {
  ts: string;
  direction: 'in' | 'out';
  text: string;
};

/** Where a thread's underlying work item stands, joined against fold.active/recentMerged/
 *  recentRejected (WI-307). A mechanical/ops park (plane-owned — never a founder action
 *  target) never surfaces as
 *  'needs-you' — only a genuine founder decision park does; 'unknown' covers a thread with
 *  no matching work item at all (answered/duplicate route, or not yet picked up).
 *  'rejected' vs 'superseded' (WI-331): both fold from item.rejected, split by
 *  recentRejected[].rejectedBy — 'rejected' is a real founder decline, 'superseded' is a
 *  machine-driven closure (reactor duplicate-of-merged / decomposition supersede) that the
 *  founder never actually rejected. Absent `rejectedBy` (pre-WI-331 replays) reads as
 *  founder-equivalent, i.e. 'rejected' — never silently reclassified.
 *  'awaiting-planner' and 'on-hold' (WI-127) split out of the old blanket ops-park→'building'
 *  collapse: a decomposition park is queued for the planner (not being actively built), and a
 *  hold park is a deliberate pause — both deserve their own catalog-backed reading rather than
 *  reading as "a worker is on it right now". Plain ops-parks/awaiting-retry still fold to
 *  'building' (see {@link deriveThreadState}) — that carve-out is unchanged by this split. */
export type ThreadState =
  | 'queued'
  | 'building'
  | 'needs-you'
  | 'awaiting-planner'
  | 'on-hold'
  | 'merged'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'unknown';

/** ThreadState → the status-catalog id whose TONE this badge must always match (WI-086/
 *  WI-087) — a thread card is a conversation-level view of the same underlying work item
 *  Command/Missions/the item hub render, so its colour can never legitimately diverge from
 *  theirs (that per-surface tone drift, not just the label text, was the WI-086 bug class).
 *  Label text stays thread-specific ({@link THREAD_STATE_LABEL} below) — a conversation card
 *  reads "Needs you"/"Settled" rather than the fuller "Needs your decision"/"Unknown" copy,
 *  a deliberate, documented shorter framing rather than an accidental drift. */
const THREAD_STATE_STATUS_ID: Record<ThreadState, StatusId> = {
  queued: 'queued',
  building: 'building',
  'needs-you': 'parked-decision',
  'awaiting-planner': 'parked-decomposition',
  'on-hold': 'parked-hold',
  merged: 'merged',
  accepted: 'accepted',
  rejected: 'rejected',
  superseded: 'superseded',
  unknown: 'unknown',
};

/** Thread-specific shorter label text — the tone always comes from the catalog
 *  ({@link THREAD_STATE_STATUS_ID}), only the wording is thread-card-local. */
const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  queued: 'Queued',
  building: 'Building',
  'needs-you': 'Needs you',
  'awaiting-planner': 'Awaiting planner',
  'on-hold': 'On hold',
  merged: 'Merged',
  accepted: 'Accepted',
  rejected: 'Rejected',
  superseded: 'Superseded',
  unknown: 'Settled',
};

/** Badge shape per joined state — tone sourced from the ONE status catalog
 *  (status-catalog.ts), label from the thread-specific wording above. */
export const THREAD_STATE_BADGE: Record<ThreadState, { state: OperationalState; label: string }> =
  Object.fromEntries(
    (Object.keys(THREAD_STATE_STATUS_ID) as ThreadState[]).map((threadState) => [
      threadState,
      { state: STATUS_CATALOG[THREAD_STATE_STATUS_ID[threadState]].tone, label: THREAD_STATE_LABEL[threadState] },
    ]),
  ) as Record<ThreadState, { state: OperationalState; label: string }>;

/** One conversation thread rendered in the threads projection. */
export type ThreadCard = {
  id: string;           // WI-NNN
  externalRef?: string;      // EXT-NNN — used as the reply `replyTo` value
  outCount: number;
  lastOutTs?: string;
  messages: ThreadMessage[];
  /** Display label — always the WI id. A channel-style externalRef (e.g. 'console',
   *  'telegram') is captured separately as {@link channel} rather than displacing it here. */
  label: string;
  /** Present only when externalRef is a channel marker, not a genuinely resolvable
   *  per-intent address (see isResolvableExternalRef, fold-adapter.ts) — rendered as a
   *  small tag before the title instead of overriding the id-chip label. */
  channel?: string;
  /** Joined work-item lifecycle state — drives the operator-facing status badge. */
  state: ThreadState;
  /** Present only when state is 'needs-you' — why an operator decision is pending. */
  parkReason?: string;
  /** Present only when state is 'superseded' — the WI id that closed this one, extracted
   *  from the reactor's "Closed — superseded by WI-NNN" msg.out trail (WI-331). Absent when
   *  the closure has no such trail entry (older replays, or a machine reject with no
   *  companion message) — the badge alone still reads correctly without it. */
  supersededBy?: string;
  /** One-line title shown in the collapsed summary row: the router-stamped
   *  title (WI-310) when the model gave one, else the deterministic
   *  {@link shortTitle} fallback. Empty string when neither is available —
   *  callers fall back to `label`/`id`, never "undefined". */
  title: string;
};

/** Deterministic one-line title fallback (WI-308) — a proper router-stamped title
 *  is queued separately as WI-310. Takes the first line of `text`, strips a
 *  trivial leading markdown/emoji "verb" prefix, and truncates at a word
 *  boundary to ~48 chars with an ellipsis. Never calls a model. Empty/missing
 *  text yields `''` so the caller can fall back to the thread id, never the
 *  literal string "undefined". */
export function shortTitle(text: string | undefined | null): string {
  if (!text) return '';
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  // Strip a leading markdown bullet/heading marker or a single leading emoji
  // "verb" glyph (e.g. "✨ Build the settings screen" → "Build the settings screen").
  const stripped = firstLine
    .replace(/^[#*\-\s]+/, '')
    .replace(/^\p{Extended_Pictographic}️?\s*/u, '')
    .trim();
  if (!stripped) return '';
  const MAX = 48;
  if (stripped.length <= MAX) return stripped;
  const truncated = stripped.slice(0, MAX);
  const lastSpace = truncated.lastIndexOf(' ');
  // A path-heavy first line (e.g. "In packages/opsui/src/projections/fold-adapter.ts, the
  // Glance…") can have its only word boundary within the first few characters — cutting
  // there collapses the title to something like "In…". When the word-boundary cut would be
  // shorter than MIN_WORD_CUT, cut mid-token at MAX instead so the title stays usable.
  const MIN_WORD_CUT = 12;
  const cut = lastSpace >= MIN_WORD_CUT ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}

/** The typed payload the threads projection renders. */
export type ThreadsData = {
  glance: GlanceMetric[];
  threads: ThreadCard[];
};

function buildGlance(threads: ThreadCard[]): GlanceMetric[] {
  const withReplies = threads.filter((t) => t.outCount > 0).length;
  return [
    {
      label: 'Conversations',
      value: threads.length,
      footnote: threads.length ? 'captured intents with thread history' : 'no threads yet',
      state: threads.length ? 'neutral' : 'success',
      open: { kind: 'evidence', id: 'thread-list' },
    },
    {
      label: 'With replies',
      value: withReplies,
      footnote: withReplies ? 'conductor has responded' : 'awaiting first reply',
      state: withReplies > 0 ? 'success' : 'neutral',
      open: { kind: 'evidence', id: 'thread-list' },
    },
  ];
}

/** Parked-status catalog id → ThreadState — the parked branch of {@link deriveThreadState}
 *  routes through {@link deriveItemStatus} (the ONE status deriver, status-catalog.ts) rather
 *  than re-deriving decision-vs-ops itself, then narrows the catalog's five parked ids down
 *  to this thread-card vocabulary. 'parked-ops'/'awaiting-retry' deliberately keep folding to
 *  'building' — a mechanical/infra park the plane auto-recovers from is never an operator
 *  action target, so the card should still read as in motion, same as before this map existed. */
const PARKED_STATUS_TO_THREAD_STATE: Partial<Record<StatusId, ThreadState>> = {
  'parked-decision': 'needs-you',
  'parked-decomposition': 'awaiting-planner',
  'parked-hold': 'on-hold',
  'parked-ops': 'building',
  'awaiting-retry': 'building',
};

/** Join a thread against its work item's lifecycle (fold.active / recentMerged /
 *  recentRejected) to derive the founder-facing state, plus the joined item's `spec`
 *  when one exists (feeds the {@link shortTitle} fallback). Absent from all three ⇒
 *  'unknown' (settled/not-yet-started), never a guess. */
function deriveThreadState(
  threadId: string,
  fold: FoldSummary,
): { state: ThreadState; parkReason?: string; spec?: string } {
  const active = fold.active.find((a) => a.id === threadId);
  if (active) {
    const spec = active.spec ? { spec: active.spec } : {};
    if (active.state === 'parked') {
      const status = deriveItemStatus({
        state: 'parked',
        ...(active.parkKind ? { parkKind: active.parkKind } : {}),
        breakerTripped: (active.parkReason ?? '').startsWith('breaker:'),
      });
      const state = PARKED_STATUS_TO_THREAD_STATE[status.id] ?? 'building';
      return {
        state,
        ...(state === 'needs-you' && active.parkReason ? { parkReason: active.parkReason } : {}),
        ...spec,
      };
    }
    if (active.state === 'queued' || active.state === 'routed') return { state: 'queued', ...spec };
    return { state: 'building', ...spec }; // building / testing / approved
  }
  const merged = fold.recentMerged.find((m) => m.id === threadId);
  if (merged) return { state: merged.accepted ? 'accepted' : 'merged', ...(merged.spec ? { spec: merged.spec } : {}) };
  const rejected = (fold.recentRejected ?? []).find((r) => r.id === threadId);
  if (rejected) {
    // A real founder decline vs a machine-driven closure — see the ThreadState doc comment.
    const isMachineClosed = !!rejected.rejectedBy && rejected.rejectedBy !== 'founder';
    return { state: isMachineClosed ? 'superseded' : 'rejected' };
  }
  return { state: 'unknown' };
}

/** The reactor's decomposition-grooming closure trail reads "Closed — superseded by WI-NNN
 *  (...)" (@loopkit/core src/beats/reactor.ts stepDecompositionGrooming) — pull the id back
 *  out of the newest matching out-message for the 'superseded' badge's secondary line
 *  (WI-331). No match ⇒ undefined; the badge still reads correctly without it. */
function extractSupersededBy(messages: ThreadMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.direction !== 'out') continue;
    const match = /superseded by (WI-\d+)/i.exec(m.text);
    if (match) return match[1];
  }
  return undefined;
}

/** Most-recent-reply-first tie-break key, shared by threads-adapter.ts and fold-adapter.ts's
 *  buildThreads: a genuinely resolvable per-intent external ref (isResolvableExternalRef,
 *  fold-adapter.ts) is address-unique and may still order threads by it, but a channel-style
 *  ref (e.g. 'console') is shared by every capture on that channel and must never displace the
 *  WI id as the sort key — same channel-vs-resolvable-ref distinction as {@link toCard}'s
 *  label/channel split. */
export function threadSortKey(t: { id: string; externalRef?: string }): string {
  return t.externalRef && isResolvableExternalRef(t.externalRef) ? t.externalRef : t.id;
}

/** Exported so Command can build the same ThreadCard shape for its "Conversations" region
 *  (nav IA rewire) without re-deriving the mapping. */
export function toCard(t: FoldThread, fold: FoldSummary): ThreadCard {
  const msgs: ThreadMessage[] = (t.messages ?? []).map((m) => ({
    ts: m.ts,
    direction: m.direction,
    text: m.text,
  }));
  const { state, parkReason, spec } = deriveThreadState(t.id, fold);
  const supersededBy = state === 'superseded' ? extractSupersededBy(msgs) : undefined;
  // Prefer the router-stamped title (WI-310, a direct LLM output) when present; else fall
  // back to the deterministic spec-then-first-message truncation (WI-308).
  const title = (t.title && t.title.trim())
    || shortTitle(spec)
    || shortTitle(msgs[0]?.text);
  return {
    id: t.id,
    ...(t.externalRef ? { externalRef: t.externalRef } : {}),
    outCount: t.outCount,
    ...(t.lastOutTs ? { lastOutTs: t.lastOutTs } : {}),
    messages: msgs,
    label: t.id,
    ...(t.externalRef && !isResolvableExternalRef(t.externalRef) ? { channel: t.externalRef } : {}),
    state,
    ...(parkReason ? { parkReason } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    title,
  };
}

/** Build the threads projection envelope from a raw fold summary.
 *  Malformed input yields a `failed` envelope (loud fold failure). */
export function threadsProjectionFromFold(
  raw: unknown,
  opts: { ledgerSequence: number; foldVersion?: string; staleAfterSeconds?: number } = { ledgerSequence: 0 },
): ProjectionEnvelope<ThreadsData> {
  const foldVersion = opts.foldVersion ?? 'loopkit';
  const staleAfter = opts.staleAfterSeconds ?? 45;

  if (!isFoldSummary(raw)) {
    return {
      projectionId: 'threads',
      schemaVersion: SCHEMA_VERSION,
      foldVersion,
      ledgerSequence: opts.ledgerSequence,
      generatedAt: new Date().toISOString(),
      freshUntil: new Date().toISOString(),
      state: 'failed',
      data: { glance: [], threads: [] },
      evidence: [{ id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' }],
    };
  }

  const fold = raw;
  const generatedAt = fold.generatedAt;
  const nowMs = new Date(generatedAt).getTime();
  const freshUntil = new Date(nowMs + staleAfter * 1000).toISOString();

  // Most-recent-reply first; ties broken by threadSortKey (resolvable externalRef, else id).
  const foldThreads = (fold.threads ?? []) as FoldThread[];
  const sorted = [...foldThreads].sort((a, b) => {
    const ta = a.lastOutTs ? new Date(a.lastOutTs).getTime() : 0;
    const tb = b.lastOutTs ? new Date(b.lastOutTs).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return threadSortKey(a).localeCompare(threadSortKey(b));
  });

  const threads = sorted.map((t) => toCard(t, fold));

  return {
    projectionId: 'threads',
    schemaVersion: SCHEMA_VERSION,
    foldVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: { glance: buildGlance(threads), threads },
    evidence: [
      { id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' },
    ],
  };
}
