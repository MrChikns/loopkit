// Fold adapter — the typed boundary between the loopkit fold substrate and the
// command projection. It reads the `loopctl summary --json` shape (a clean
// projection of the event ledger, seams retired — WI-145) and produces a
// typed `ProjectionEnvelope<CommandData>`. Nothing downstream ever sees raw fold
// fields; malformed input folds to a LOUD failure envelope.
//
// The loopkit lifecycle vocabulary (queued/building/approved/parked/merged/…) is
// substrate-specific, so its → status catalog entry (id/label/tone/icon/meaning) is
// derived HERE (and by every other adapter) through the ONE deriver, deriveItemStatus
// (status-catalog.ts, WI-086/WI-087) — the design-system's own canonical maps
// stay for its own WorkState union.

import type { OperationalState } from '../states/operational-state.ts';
import { deriveItemStatus } from '../states/status-catalog.ts';
import type { CommandData, CommandEvent, DecisionBlock, GlanceMetric, PipelineFlow, PipelineStage, RecentIntent } from './command-projection.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { toCard as toThreadCard } from './threads-adapter.ts';
import type { ThreadCard } from './threads-adapter.ts';

/** The subset of `loopctl summary --json` the command projection reads (see
 *  @loopkit/core cli.ts `cmdSummary`). Extra fields are ignored, not required. */
export type FoldActiveItem = {
  id: string;
  state: string;
  priority?: string;
  /** Build attempts so far (loopkit ItemRecord.attempts, bumped per build.dispatched) — the
   *  same breaker token `loopctl summary --json` always emits (WI-354). Absent only on a
   *  malformed/older payload; never fabricated as 0 by a consumer. */
  attempts?: number;
  /** Comma-joined path list as loopkit emits it (@loopkit/core src/fold.ts) — split with
   *  {@link toTouchList} before iterating; NOT a `string[]`. */
  touches?: string;
  spec?: string;
  parkReason?: string;
  /** Park INTENT kind (ops parks are plane-owned — never a founder action target): 'decision'
   *  reaches the founder's needs-you desk; 'ops' is a mechanical/infra failure the plane owns
   *  → health lane, never the desk. */
  parkKind?: string;
  /** Leader-leader escalation-with-intent payload (item.parked.escalation), when the emitter
   *  supplied one — absent on every park predating this field, and on any park whose emitter
   *  didn't fill in all four fields (loopkit fold.ts parseEscalation is all-or-nothing). The
   *  decision desk prefers this over deriving whatItIs/whyParked from the raw parkReason. */
  escalation?: { intent: string; evidence: string; risk: string; recommendation: string };
  externalRef?: string;
  createdAt?: string;
  /** State-transition timestamps (loopkit ItemRecord), forwarded straight through by
   *  `loopctl summary --json`. Used by the STUCK glance tile (WI-319) to derive a per-item
   *  "last activity" age without re-deriving anything from raw ledger events. */
  queuedAt?: string;
  buildingAt?: string;
  parkedAt?: string;
  approvedAt?: string;
  /** Timestamp of the most recent item.unparked (loopkit ItemRecord.lastUnparkedAt),
   *  never cleared once set. Paired with `parkedAt` by the missions board's
   *  interim-status check (WI-362, mirrors @loopkit/core src/fold.ts's isInterimApprovedStatus)
   *  to tell "just unparked, awaiting dispatch" apart from a queued item unrelated to the
   *  last unpark. */
  lastUnparkedAt?: string;
  /** Dispatched worktree branch (loopkit ItemRecord.currentBuild.branch, falling back to the
   *  last archived build once a gate park closes the attempt — WI-386) — present once a build
   *  has actually been dispatched; absent for a queued/not-yet-picked item. */
  branch?: string;
  /** Whether `branch` still exists in git (loopkit `git rev-parse --verify`, WI-386) — only
   *  emitted for parked items with a resolved branch; absent everywhere else. `false` means a
   *  worktree was cleaned up / the branch is otherwise gone, so approving must requeue a fresh
   *  build rather than merge. See {@link approveActionLabel}. */
  branchAlive?: boolean;
  /** The assembled scout context pack the agent was given before building (item.briefed —
   *  loopkit ItemRecord.brief). Absent when the item was built without one — never fabricated. */
  brief?: { text: string; at: string; model?: string };
};

export type FoldMergedItem = {
  id: string;
  mergedAt?: string;
  mergeCommit?: string;
  spec?: string;
  /** File prefixes the slice changed — drives the WI-180 origin chip on the delivery stream.
   *  Comma-joined string as loopkit emits it (@loopkit/core src/fold.ts); split with
   *  {@link toTouchList} — NOT a `string[]`. */
  touches?: string;
  /** Acceptance tier the item classified into ('auto'|'optional'|'review'|'must'),
   *  emitted by `loopctl summary --json` for non-accepted items. Drives the desk's tier badge. */
  tier?: string;
  /** Whether the founder has accepted this shipped slice (WI-213). */
  accepted?: boolean;
  acceptedAt?: string;
  /** Capture timestamp (loopkit ItemRecord.createdAt), carried through for the FLOW glance
   *  tile's capture→merge cycle-time median (WI-319). Absent on older ledger rows. */
  createdAt?: string;
  /** Build attempts at merge time, for the RELIABILITY glance tile's first-attempt-merge-rate
   *  (WI-319). Absent on pre-WI-319 CLI builds — treated as a first-try merge (attempts ?? 1). */
  attempts?: number;
  /** Certify-don't-brief payload (item.merged.certification), when the worker's manifest
   *  supplied one — absent on every merge predating this field, and on any merge whose
   *  manifest didn't fill in all three fields. The acceptance desk renders a visible
   *  "no certification provided" line when absent, never a silent blank. */
  certification?: { couldBreak: string; detection: string; rollback: string };
  /** Lifetime clean-landing counters (loopkit ItemRecord, WI-108) — how many times each
   *  rough-landing signal fired on the way to THIS merge, over the item's whole lifecycle
   *  (not just the final attempt). Absent === 0 (loopkit only emits non-zero counts) — a
   *  clean straight-through merge carries none of these fields. Drives the RELIABILITY
   *  glance tile's per-WI clean-landing rate (WI-089). */
  lifetimeParkCount?: number;
  lifetimeCrashCount?: number;
  lifetimeGateRedCount?: number;
  lifetimeEscalationCount?: number;
};

/** One conversation thread from the fold — added by the WI-145
 *  summary --json shape; absent on older CLI builds (treat as []). */
export type FoldThread = {
  id: string;
  externalRef?: string;
  lastOutTs?: string;
  outCount: number;
  messages?: Array<{ ts: string; direction: 'in' | 'out'; text: string }>;
  /** Router-stamped short title (WI-310), a direct LLM output. Absent on pre-WI-310
   *  items — {@link toCard} falls back to the deterministic {@link shortTitle}. */
  title?: string;
};

export type FoldSummary = {
  counts: Record<string, number>;
  active: FoldActiveItem[];
  recentMerged: FoldMergedItem[];
  /** Same shape as {@link recentMerged}, trimmed to a wider 30-day horizon instead of 7d
   *  (WI-360) — feeds the Glance window picker's '30d' option. A superset of recentMerged
   *  (30d ⊇ 7d), built from the same record in `loopctl summary --json` (@loopkit/core src/
   *  cli.ts), never a second construction of the same shape. Absent on older CLIs — callers
   *  fall back to `recentMerged` rather than fabricating an empty 30d window. */
  recentMerged30d?: FoldMergedItem[];
  recentRejected?: Array<{
    id: string;
    spec?: string;
    /** Who/what closed the item (loopkit ItemRecord.rejectedBy, WI-331): 'founder' for an
     *  actual founder decline; a machine actor (e.g. 'reactor') for an autonomous closure
     *  (duplicate-of-merged, decomposition supersede). Absent on pre-WI-331 replays — treated
     *  as founder-equivalent by threads-adapter.ts, matching the CLI's own default. */
    rejectedBy?: string;
  }>;
  /** Terminal-routed items (route=answer|question|duplicate|merged) — WI-196. */
  recentAnswered?: Array<{ id: string; spec?: string; route?: string; answeredAt?: string }>;
  /** Compact thread projection (WI-145). */
  threads?: FoldThread[];
  /** Self-tuning acceptance windows (hours) — the effective 'optional'/'review'
   *  auto-accept windows after verdict-history calibration. Absent on older CLIs. */
  tierWindows?: { optional?: number; review?: number };
  /** "Why isn't this building?" scheduling readout (@loopkit/core src/cli.ts buildQueueBlocking)
   *  — one row per queued/parked item, computed from the SAME predicates dispatch itself gates
   *  on (touchesConflict, BUILDER_BREAKER_N), so it can never silently disagree with real
   *  dispatch behaviour. Absent on older CLIs (treated as []). */
  queueBlocking?: Array<{ id: string; runnable: boolean; reason?: string }>;
  /** Items captured in the last 24h, across ALL states (not just `active`) — the FLOW glance
   *  tile's intake side. Absent on older CLIs, treated as 0. */
  capturedLast24h?: number;
  /** Same intake count over 7d — the FLOW tile's intake side when the 7d window is selected
   *  (the 24h count under a 7d selection would otherwise mismatch the window). Absent on
   *  older CLIs — the tile then falls back to the 24h count, tagged honestly. */
  capturedLast7d?: number;
  /** Same intake count over 30d (the 30d window option). Same fallback rule. */
  capturedLast30d?: number;
  generatedAt: string;
};

const SCHEMA_VERSION = '1';

/** Where a work item's changes land, derived once from its `touches` prefixes (WI-180).
 *  'plane' = the delivery plane's own tooling (the loopkit framework + ops console);
 *  'target' = the target repo the plane is building; 'mixed' = both. Rendered as an origin
 *  chip on every work surface so the operator can tell at a glance whether a slice touches the
 *  plane that runs the work or the target repo itself. */
export type ItemOrigin = 'target' | 'plane' | 'mixed';

// Plane touch prefixes: the delivery plane's own tooling — the loopkit packages and the
// plane's config/state directory. Everything else (the target repo's own source) is target.
// A deployment can override these via classifyOrigin's opts to match its own layout.
const DEFAULT_OPS_TOUCH_RE = /(?:^|\/)(?:packages\/(?:core|ui|opsui|console)|\.loopkit(?:\/|$)|\.ai(?:\/|$))/;

/** Per-deployment origin-classification config. Defaults classify the loopkit packages and
 *  the plane's own state dir as 'plane' and everything else as 'target'. */
export interface OriginConfig {
  /** Touch-path prefixes that mark a change as plane tooling ('plane'). */
  opsTouch?: RegExp;
}

/** Normalize the fold's `touches` into a path list. loopkit emits it as a COMMA-JOINED
 *  STRING (the fold's item summary) — not an array — so consumers must split it; a bare
 *  `for..of` over the string walks characters (the WI-020 misclassification bug: every
 *  touched item read as 'target', so Plane was always 0). Tolerant of a legacy array
 *  shape too. Blank/empty ⇒ []. */
export function toTouchList(touches?: string | string[]): string[] {
  if (!touches) return [];
  const parts = Array.isArray(touches) ? touches : touches.split(',');
  return parts.map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Shape of a resolvable per-intent external ref (e.g. 'EXT-77', 'WI-129') — the ONE
 *  pattern console/src/server.ts's `/threads/:ref` route accepts (it imports this same
 *  constant, so the two can never drift apart). loopkit's own console composer stamps
 *  every item it captures with the literal channel marker `source: 'ext:console'`
 *  (server.ts's `/intent` handler) rather than a unique per-intent id — core's summary.ts
 *  still derives an `externalRef` of `'console'` from that prefix (so the item shows up
 *  as a thread immediately), but `'console'` fails this shape and is NOT an addressable
 *  reply/thread-detail target: every caller that turns an externalRef into a
 *  `/threads/<ref>` link must fall back to the canonical `/item/<id>` hub instead. */
export const RESOLVABLE_EXTERNAL_REF_RE = /^[A-Z]+-\d+$/;

export function isResolvableExternalRef(ref: string): boolean {
  return RESOLVABLE_EXTERNAL_REF_RE.test(ref);
}

/** Derive the origin chip once, at the fold boundary. No touches ⇒ undefined (an
 *  un-scoped item has no derivable origin, so the surface simply shows no chip rather
 *  than guessing). */
export function deriveOrigin(
  touches?: string | string[],
  opts: OriginConfig = {},
): ItemOrigin | undefined {
  const opsTouch = opts.opsTouch ?? DEFAULT_OPS_TOUCH_RE;
  const list = toTouchList(touches);
  if (list.length === 0) return undefined;
  let ops = false;
  let product = false;
  for (const t of list) {
    if (opsTouch.test(t)) ops = true;
    // Anything not matching the plane-tooling prefixes is the target repo's own code ⇒ target.
    else product = true;
  }
  if (ops && product) return 'mixed';
  return ops ? 'plane' : 'target';
}

/** The origin chip is neutral-toned everywhere (it classifies, it doesn't alarm); the
 *  label carries the meaning per the never-colour-alone rule. */
export function originBadge(origin: ItemOrigin): { state: OperationalState; label: string } {
  const label = origin === 'plane' ? 'Plane' : origin === 'mixed' ? 'Mixed' : 'Target';
  return { state: 'neutral', label };
}

/** loopkit lifecycle state → visual state, decided once at the boundary — now a thin
 *  wrapper over the ONE status deriver (status-catalog.ts deriveItemStatus, WI-086/WI-087)
 *  rather than this module's own lookup table. Callers that only need the tone (not the
 *  full catalog label) keep this name so the diff for WI-086 stayed a behavior fix, not a
 *  call-site rename sweep. */
function foldState(state: string): OperationalState {
  return deriveItemStatus({ state }).tone;
}

function count(counts: Record<string, number>, ...states: string[]): number {
  return states.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SIX_HOURS_MS = 6 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const THIRTY_DAYS_MS = 30 * DAY_MS;

/** The three Glance time-window options (WI-359, '30d' added WI-360). fold.recentMerged is
 *  already pre-trimmed to 7d by loopkit and fold.recentMerged30d to 30d — both windows read
 *  straight off the fold's own pre-trimmed arrays, never re-derived here. */
export type GlanceWindow = '24h' | '7d' | '30d';
const GLANCE_WINDOW_MS: Record<GlanceWindow, number> = { '24h': DAY_MS, '7d': SEVEN_DAYS_MS, '30d': THIRTY_DAYS_MS };
/** The default window when no `?window` param is present. ONE source of truth so the picker's
 *  displayed-active state (command-projection) and every tile's computation (buildGlance) can
 *  never disagree — otherwise the picker can highlight 24h while Reliability still computes over 7d. */
export const DEFAULT_GLANCE_WINDOW: GlanceWindow = '24h';

/** "4h" / "19h" / "2d" — mirrors work-adapter.ts's formatAge (not shared: this file must
 *  not import from a downstream projection). */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) return '< 1h';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Age of the OLDEST valid timestamp in the list, or undefined when none are parseable —
 *  callers render the count without an age suffix rather than a fabricated "unknown". */
function oldestAge(nowMs: number, timestamps: Array<string | undefined>): string | undefined {
  const valid = timestamps
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  return valid.length > 0 ? formatAge(nowMs - Math.min(...valid)) : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Last state-transition timestamp for an active item — the newest of createdAt/queuedAt/
 *  buildingAt/parkedAt/approvedAt that is present. Undefined when the fold carries none of
 *  them (never fabricated as "now", which would hide genuine staleness). */
function lastActivityMs(item: FoldActiveItem): number | undefined {
  const candidates = [item.createdAt, item.queuedAt, item.buildingAt, item.parkedAt, item.approvedAt]
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

/** Is this a usable fold summary? A malformed/empty payload must fail loud, not
 *  render an empty operating picture that looks calm. Exported so
 *  sibling adapters (acceptance, …) validate the substrate through the ONE parser
 *  rather than re-deriving the shape (single-reader discipline). */
export function isFoldSummary(value: unknown): value is FoldSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.counts === 'object' && v.counts !== null &&
    Array.isArray(v.active) &&
    Array.isArray(v.recentMerged) &&
    typeof v.generatedAt === 'string'
  );
}

function specLabel(item: { id: string; spec?: string }): string {
  const spec = (item.spec ?? '').trim();
  return spec ? `${item.id} · ${spec}` : item.id;
}

/** Spec text ONLY, no `id ·` prefix — the pulse renders the id as its own chip, so the
 *  building/queue rows want the bare description (clamped to 2 lines in CSS), not the
 *  id repeated inline: a short description, at most 2 lines. */
function pulseTitle(item: { id: string; spec?: string }): string {
  const spec = (item.spec ?? '').trim();
  return spec || item.id;
}

// ─── Decision block helpers ───────────────────────────────────────────────────

type ParkClass = 'touches-overstep' | 'spine' | 'push-failed' | 'conflict' | 'no-commit' | 'other';

function classifyPark(reason: string): ParkClass {
  if (reason.includes('needs-decision: files outside declared Touches')) return 'touches-overstep';
  if (reason.includes('needs-decision: touches spine')) return 'spine';
  if (reason.includes('push failed')) return 'push-failed';
  if (reason.includes('conflict')) return 'conflict';
  if (/no[\s-]commit/i.test(reason)) return 'no-commit';
  return 'other';
}

function buildDecisionBlock(item: FoldActiveItem): DecisionBlock {
  const reason = item.parkReason ?? '';
  const cls = classifyPark(reason);

  // spec (CLI already collapses spec ?? sourceText) gives a human-readable one-liner
  const whatItIs = (item.spec ?? item.id).slice(0, 120);

  let whyParked: string;
  switch (cls) {
    case 'touches-overstep': {
      const match = reason.match(/Touches \([^)]*\): (.+)/);
      const fileList = match ? match[1]!.trim() : '(see detail)';
      const fileCount = fileList === '(see detail)' ? 1 : fileList.split(',').length;
      whyParked = `The build also changed ${fileCount} file${fileCount !== 1 ? 's' : ''} outside its declared scope: ${fileList}`;
      break;
    }
    case 'spine': {
      const match = reason.match(/touches spine \(([^)]+)\)/);
      const files = match ? match[1]!.trim() : '(see detail)';
      whyParked = `It changes the reactor/plane spine (${files}), which always needs your sign-off`;
      break;
    }
    case 'push-failed':
      whyParked = 'The merge push failed — safe to approve to retry';
      break;
    case 'conflict':
      whyParked = 'The merge had conflicts — rebuild needed';
      break;
    case 'no-commit':
      whyParked = 'The worker made no commit — nothing to merge';
      break;
    default:
      whyParked = reason || 'Park reason not recorded';
  }

  // State-driven, not a blanket assumption: a built item merges its actual branch; an
  // unbuilt decision park (e.g. WI-351) has no branch to merge — approving it re-queues
  // the item for a worker to build/execute instead.
  const whatApproves = item.branch
    ? `Merges branch ${item.branch} into master and deploys`
    : `Re-queues ${item.id} for a worker to build and execute`;

  let recommendation: string | undefined;
  switch (cls) {
    case 'push-failed':
      recommendation = 'Push failure is transient — safe to approve to retry';
      break;
    case 'touches-overstep':
      recommendation = 'Review the extra files; if they are related to the declared change, safe to approve';
      break;
    case 'spine':
      recommendation = 'Spine changes always need review — check the listed files before approving';
      break;
    // conflict / no-commit are ops-parks (plane-owned — never a founder action target) — they never reach this desk, and the
    // old "Decline to re-queue" text lied (Decline → item.rejected is terminal, no re-queue path).
    default:
      recommendation = undefined;
  }

  // Every item reaching this desk is a decision park (isDecisionPark), so `unblockNote`'s
  // parkKind switch always lands on the same generic line here — not concrete, just filler.
  // State it in terms of the actual decision instead, mirroring `whatApproves` above.
  const unblock = item.branch
    ? 'Your approve/decline call — the branch is built and waiting on you'
    : 'Your approve/decline call — nothing has been built yet';

  return {
    whatItIs,
    whyParked,
    whatApproves,
    unblock,
    ...(recommendation ? { recommendation } : {}),
    rawReason: reason,
    ...(item.escalation ? { escalation: item.escalation } : {}),
  };
}

// ─── Park-kind routing (ops parks are plane-owned — never a founder action target) ──
// A parked item is a *decision* the founder must call (conductor park, product-spine,
// touches-overstep) only when tagged parkKind:'decision'. Everything else parked
// (no-commit, merge conflict, tests-red, infra:*, breaker) is an *ops* failure the plane
// owns; it never reaches the needs-you desk, it surfaces on the health lane and
// auto-requeues.
/** Exported so threads-adapter.ts can join a thread's parked work item against the SAME
 *  decision-vs-ops predicate (ops parks are plane-owned — never a founder action target)
 *  rather than re-deriving it — a second copy of this classification is the drift smell
 *  the fold layer exists to avoid.
 *  Strict predicate: every emitter now stamps `parkKind`, so the
 *  legacy `parkReason.startsWith('needs-decision')` fallback is removed — a single,
 *  unambiguous field decides this, never a string-prefix guess. */
export function isDecisionPark(i: FoldActiveItem): boolean {
  return i.state === 'parked' && i.parkKind === 'decision';
}
function isOpsPark(i: FoldActiveItem): boolean {
  return i.state === 'parked' && !isDecisionPark(i);
}

/** Parse the planner successor id out of a decomposition park reason (reactor.ts stamps
 *  "queued for planner decomposition as WI-NNN"). Returns undefined when unparseable — the
 *  caller falls back to a generic "planner lane" label rather than guessing. Exported
 *  (part of the parkKind-aware "what unblocks this" line) so every surface that renders a
 *  parked item's "what unblocks this" line shares this ONE parse rather than re-deriving it
 *  (one-parser rule). Lives here (the base boundary layer) rather than in work-adapter.ts so
 *  both fold-adapter.ts's own decision desk and work-adapter.ts can share it without a
 *  reverse import cycle. */
export function parseDecompositionSuccessor(reason: string): string | undefined {
  const m = /queued for planner decomposition as (WI-\d+)/u.exec(reason);
  return m?.[1];
}

/** parkKind-aware "what unblocks this" line for any surface that renders a parked item —
 *  Command/decision-desk cards, stream rows, Missions board rows. One switch over
 *  `parkKind`, reusing {@link parseDecompositionSuccessor} for the decomposition case rather
 *  than re-deriving the successor id (one-parser rule). Plain text — the caller wraps
 *  it in whatever markup its own surface uses. Undefined `parkKind` (ledger rows predating
 *  parkKind) falls back to the decision copy, matching isDecisionPark's own default treatment. */
export function unblockNote(parkKind: string | undefined, parkReason: string | undefined): string {
  switch (parkKind) {
    case 'decision':
      return 'Approve or reject below';
    case 'hold':
      return 'Resume when ready';
    case 'ops':
      return 'Auto-retries; escalates on breaker';
    case 'decomposition': {
      const successor = parseDecompositionSuccessor(parkReason ?? '');
      return successor ? `Waiting on planner → ${successor}` : 'Waiting on planner';
    }
    default:
      return 'Approve or reject below';
  }
}

/**
 * Interim-status predicate (WI-362): mirrors @loopkit/core src/fold.ts's
 * `isInterimApprovedStatus` formula on the FoldActiveItem shape — ops-ui never imports
 * loopkit directly (same cross-package-boundary reason isDecisionPark/isOpsPark carry their
 * own local copies of the loopkit formula). True in the narrow window between a founder verb
 * landing (approved / a fresh unpark) and the reactor's follow-up (merged / a fresh dispatch):
 * 'approved' is always this window; 'queued' only counts when it's the direct result of the
 * most recent unpark (lastUnparkedAt fresher than parkedAt).
 *
 * Lives here (the base boundary layer) rather than in work-adapter.ts so status-catalog.ts's
 * {@link import('../states/status-catalog.ts').deriveItemStatus} callers — fold-adapter.ts's
 * own buildRecentIntents (WI-086) and work-adapter.ts (re-exported below for its existing
 * callers) — share the ONE formula instead of each carrying a copy.
 */
export function isInterimApprovedStatus(
  state: string,
  lastUnparkedAt: string | undefined,
  parkedAt: string | undefined,
): boolean {
  if (state === 'approved') return true;
  if (state !== 'queued' || !lastUnparkedAt) return false;
  return !parkedAt || lastUnparkedAt > parkedAt;
}

/** Approve-button label for a parked decision item (mirrors the parkKind-aware "what
 *  unblocks this" line pattern, and `whatApproves` above): a dispatched build with a live
 *  branch merges that branch on approve (reactor approve-path); a parked-unbuilt item (or
 *  one whose branch is gone) re-queues for a fresh build instead (cli.ts approve-verb
 *  fallback). Exported so work-adapter.ts's Missions/item-hub run controls and this
 *  module's own decision desk render the SAME label from the SAME `branch`/`branchAlive`
 *  signals, never two copies (one-parser rule) — the WI-378 incident was this exact drift with a fixed
 *  "Approve — requeue" string; WI-386 fixed cmdSummary dropping `branch` for gate-parked
 *  items (currentBuild archived into builds[]) and added `branchAlive` so a stale branch
 *  (worktree cleaned up) still truthfully shows "requeue", not "merge". `branchAlive`
 *  undefined (non-parked items, or cmdSummary didn't check) is treated as alive — only an
 *  explicit `false` flips the label to requeue. */
export function approveActionLabel(branch: string | undefined, branchAlive?: boolean): string {
  return branch && branchAlive !== false ? 'Approve — merge built branch' : 'Approve — requeue for build';
}

/** Shipped-but-still-needs-a-verdict predicate — must/review tier, not yet accepted. Shared
 *  by the Glance "To test" tile's count (buildGlance) and Command's own To-test region
 *  (buildToTest below) so the two can never disagree on how many items are awaiting a
 *  founder works/found-a-problem call. */
function isAwaitingVerdict(m: FoldMergedItem): boolean {
  return !m.accepted && (m.tier === 'must' || m.tier === 'review');
}

// ─── Region builders ──────────────────────────────────────────────────────────

/** Glance is attention-oriented: each tile answers a distinct operator question rather than a
 *  bare flow count:
 *    DECISIONS     — parked items that actually need an approve/decline call
 *    TO TEST       — shipped slices awaiting a works/found-a-problem verdict
 *    STUCK         — what's not moving and needs a look (breaker-tripped or stale)
 *    FLOW          — is the queue draining or growing, and how fast is a slice landing
 *    RELIABILITY   — is the plane shipping clean, or churning through repair attempts
 *  Decisions and To test are split (not one combined "Needs you" tile) so the to-test half of the
 *  count has its own click-through. All tiles read straight off the already-mapped `fold.active` /
 *  `fold.recentMerged` — no new re-derivation of state, only arithmetic over existing fields
 *  (FoldActiveItem/FoldMergedItem carry the extra timestamps/counts this needs — see their doc comments). */
/** Compact "what's actually happening" teaser rendered below the collapsed All-clear line —
 *  sourced ONLY from data buildGlance already maps off `fold.active`/`fold.recentMerged`/`fold.counts`,
 *  never a new fold re-derivation. */
export type GlancePulse = {
  building: Array<{ id: string; title: string; age?: string; href: string }>;
  queue: { depth: number; next?: { id: string; title: string; href: string } };
  /** Merges within the SELECTED window (not a fixed calendar "today") — so the row tracks the
   *  24h/7d/30d picker like every other tile does. `window` carries the active selection so the
   *  label can name it ("last 24h" / "last 7 days"). */
  shipped: { count: number; window: GlanceWindow; cycleLabel: string };
};

function buildPulse(
  fold: FoldSummary,
  nowMs: number,
  cycleLabel: string,
  shipped: { count: number; window: GlanceWindow },
): GlancePulse {
  const building = fold.active
    .filter((i) => i.state === 'building' || i.state === 'approved')
    .slice(0, 3)
    .map((i) => {
      const last = lastActivityMs(i);
      return {
        id: i.id,
        title: pulseTitle(i),
        ...(last !== undefined ? { age: formatAge(nowMs - last) } : {}),
        href: `/item/${i.id}`,
      };
    });

  const queued = fold.active.filter((i) => i.state === 'queued' || i.state === 'routed');
  const next = queued[0];

  return {
    building,
    queue: {
      depth: queued.length,
      ...(next ? { next: { id: next.id, title: pulseTitle(next), href: `/item/${next.id}` } } : {}),
    },
    shipped: { count: shipped.count, window: shipped.window, cycleLabel },
  };
}

function buildGlance(fold: FoldSummary, opts: { window?: GlanceWindow } = {}): { metrics: GlanceMetric[]; allClear: boolean; pulse: GlancePulse } {
  const nowMs = new Date(fold.generatedAt).getTime();
  // `fold.recentMerged` is already pre-trimmed to 7d upstream (loopkit), and
  // `fold.recentMerged30d` to 30d (WI-360), so those two windows are the full sets as-is —
  // re-filtering by `mergedAt` here would wrongly drop merges that carry no timestamp. Only
  // the narrower '24h' window needs a local timestamp filter. An older fold without
  // recentMerged30d falls back to the 7d array rather than fabricating an empty 30d window.
  const mergedInWindow = (w: GlanceWindow) =>
    w === '7d'
      ? fold.recentMerged
      : w === '30d'
      ? fold.recentMerged30d ?? fold.recentMerged
      : fold.recentMerged.filter((m) => {
          const t = m.mergedAt ? new Date(m.mergedAt).getTime() : NaN;
          return Number.isFinite(t) && nowMs - t < GLANCE_WINDOW_MS[w];
        });

  // ── NEEDS YOU: decision parks + must/review-tier slices awaiting acceptance ──
  // These are two DIFFERENT founder actions (approve/decline a park vs.
  // test a shipped slice), so they render as two separately-linked tiles — a single
  // combined count that always opened the decision desk hid the to-test half entirely.
  const decisionParks = fold.active.filter(isDecisionPark);
  const awaitingAcceptance = fold.recentMerged.filter(isAwaitingVerdict);
  const decisionAge = oldestAge(nowMs, decisionParks.map((i) => i.parkedAt));
  const acceptanceAge = oldestAge(nowMs, awaitingAcceptance.map((m) => m.mergedAt));

  // ── STUCK: breaker-tripped ops parks ∪ anything unchanged 6h+, regardless of parkKind ──
  const breakerTripped = fold.active.filter((i) => isOpsPark(i) && (i.parkReason ?? '').startsWith('breaker:'));
  const staleSixHours = fold.active.filter((i) => {
    const last = lastActivityMs(i);
    return last !== undefined && nowMs - last > SIX_HOURS_MS;
  });
  const stuckIds = new Set([...breakerTripped, ...staleSixHours].map((i) => i.id));
  const stuckAges = [...breakerTripped, ...staleSixHours]
    .map((i) => lastActivityMs(i))
    .filter((t): t is number => t !== undefined);
  const stuckOldest = stuckAges.length > 0 ? formatAge(nowMs - Math.min(...stuckAges)) : undefined;
  const stuckParts: string[] = [];
  if (breakerTripped.length > 0) stuckParts.push(`${breakerTripped.length} breaker-tripped`);
  if (staleSixHours.length > 0) stuckParts.push(`${staleSixHours.length} unchanged 6h+`);

  // ── FLOW: intake vs drain over the selected window + median capture→merge cycle time (7d).
  //    `opts.window`, when given, drives BOTH the Flow and Reliability windows below (WI-359);
  //    absent, both fall back to the SAME DEFAULT_GLANCE_WINDOW the picker highlights, so a
  //    no-param load never shows a tile scoped to a window the chip contradicts.
  const flowWindow: GlanceWindow = opts.window ?? DEFAULT_GLANCE_WINDOW;
  // Intake must follow the SAME window as drain — otherwise the footnote can pair a 24h capture
  // count with a 7d selection ("35 in / 161 out (7d)"). The wider counts are absent on older
  // CLIs; fall back to 24h with its honest tag.
  const capturedByWindow: Record<GlanceWindow, number | undefined> = {
    '24h': fold.capturedLast24h,
    '7d': fold.capturedLast7d,
    '30d': fold.capturedLast30d,
  };
  const capturedIn = capturedByWindow[flowWindow] !== undefined
    ? { n: capturedByWindow[flowWindow]!, tag: flowWindow }
    : { n: fold.capturedLast24h ?? 0, tag: '24h' as GlanceWindow };
  const mergedFlow = mergedInWindow(flowWindow);
  const mergedInFlowWindow = mergedFlow.length;
  const queued = count(fold.counts, 'queued', 'routed');
  // WI-371: the median capture→merge cycle time MUST follow the selected window. It previously
  // always read fold.recentMerged (the fixed 7d set), so the headline showed the same value for
  // 24h/7d/30d while the footnote counts changed — a window-invariant, internally-inconsistent
  // tile (7d median over a 30d out-count). Scope it to the SAME window-filtered merged set the
  // out-count uses (mergedInWindow), so the number tracks the chip.
  const cycleTimesMs = mergedFlow
    .filter((m) => !!m.createdAt && !!m.mergedAt)
    .map((m) => new Date(m.mergedAt!).getTime() - new Date(m.createdAt!).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const cycleMedianMs = median(cycleTimesMs);
  const cycleLabel = cycleMedianMs !== undefined ? `${(cycleMedianMs / HOUR_MS).toFixed(1)}h` : '–';

  // ── RELIABILITY: per-WI clean-landing rate over the selected window (+ a fixed 30d
  //    reference), WI-089 / WI-129 ──
  // Headline switched from "first-attempt merge rate" (attempts===1, one attempt-count field)
  // to "clean landing" (WI-108 lifetime counters, one outcome per WI): a merged item is clean
  // iff it never parked/crashed/gate-failed/escalated ANYWHERE on its road to merge — a WI that
  // gate-failed once then passed on attempt 2 is not "first try" but it's also not the rough
  // landing the founder actually cares about catching, so this reads truer than attempts alone.
  const isCleanLanding = (m: FoldMergedItem): boolean =>
    !m.lifetimeParkCount && !m.lifetimeCrashCount && !m.lifetimeGateRedCount && !m.lifetimeEscalationCount;
  // WI-129: the headline (and its denominator) now read from the SAME window-filtered merged set
  // the picker drives on every other tile (mergedInWindow(reliabilityWindow) — shared with the
  // "this try" secondary below), instead of hardcoding fold.recentMerged (a fixed 7d slice). It
  // used to never move when the founder changed the Glance window filter.
  const reliabilityWindow: GlanceWindow = opts.window ?? DEFAULT_GLANCE_WINDOW;
  const reliabilityMerged = mergedInWindow(reliabilityWindow);
  const cleanHeadline = reliabilityMerged.filter(isCleanLanding).length;
  const totalHeadline = reliabilityMerged.length;
  const cleanPctHeadline = totalHeadline > 0 ? Math.round((cleanHeadline / totalHeadline) * 100) : undefined;
  // Fixed 30d reference point, independent of the picker, so the founder keeps a longer-horizon
  // comparison even while scrubbing the headline window narrower (24h/7d). fold.recentMerged30d
  // is already pre-trimmed to 30d upstream (WI-360).
  const merged30d = fold.recentMerged30d ?? fold.recentMerged;
  const clean30d = merged30d.filter(isCleanLanding).length;
  const total30d = merged30d.length;
  const cleanPct30d = total30d > 0 ? Math.round((clean30d / total30d) * 100) : undefined;
  const RELIABILITY_TARGET_PCT = 90;

  // Secondary line — the ORIGINAL per-attempt computation (attempts===1 share of merges in the
  // selected window), kept as-is but relabeled: it measures attempt-level luck on the final try,
  // not whether the WI's whole lifecycle was clean, so it must never be confused with the
  // headline above. Shares reliabilityMerged with the headline — both track the same window.
  const mergedTotal = totalHeadline;
  const firstAttempt = reliabilityMerged.filter((m) => (m.attempts ?? 1) === 1).length;
  const reliabilityPct = mergedTotal > 0 ? Math.round((firstAttempt / mergedTotal) * 100) : undefined;

  // When the three alarm tiles (Decisions/To test/Stuck) are all zero, Command has nothing that
  // needs the operator — the tiles collapse to a single "All clear" line and a compact pulse
  // teaser takes their place.
  const allClear = decisionParks.length === 0 && awaitingAcceptance.length === 0 && stuckIds.size === 0;
  // Shipped-row count follows the SAME window-filtered merged set the Flow tile drains over
  // (mergedInFlowWindow / flowWindow), not a fixed calendar "today" — so the pulse tracks the picker.
  const pulse = buildPulse(fold, nowMs, cycleLabel, { count: mergedInFlowWindow, window: flowWindow });

  const metrics: GlanceMetric[] = [
    {
      label: 'Decisions',
      value: decisionParks.length,
      footnote: decisionParks.length > 0
        ? `waiting on you${decisionAge ? ` (oldest ${decisionAge})` : ''}`
        : 'all clear',
      state: decisionParks.length > 0 ? 'warning' : 'success',
      href: '#decision-desk',
      open: { kind: 'projection', id: 'decisions' },
    },
    {
      label: 'To test',
      value: awaitingAcceptance.length,
      footnote: awaitingAcceptance.length > 0
        ? `shipped, awaiting your verdict${acceptanceAge ? ` (oldest ${acceptanceAge})` : ''}`
        : 'all caught up',
      state: awaitingAcceptance.length > 0 ? 'warning' : 'success',
      href: '/acceptance',
      open: { kind: 'projection', id: 'acceptance' },
    },
    {
      label: 'Stuck',
      value: stuckIds.size,
      footnote: stuckParts.length > 0
        ? `${stuckParts.join(' · ')}${stuckOldest ? ` (oldest ${stuckOldest})` : ''}`
        : 'none stuck',
      state: stuckIds.size > 0 ? 'warning' : 'success',
      href: '/work',
      open: { kind: 'projection', id: 'workforce' },
    },
    {
      label: 'Flow',
      value: cycleLabel,
      // WI-371: lead the footnote with "median cycle" so the headline value isn't mistaken for an
      // average / p90 / build-time — it is the MEDIAN capture→merge lead time over `flowWindow`.
      // No `mergedTotal (reliabilityWindow)` middle term: it duplicated the Reliability tile's
      // denominator (and under a unified window, the out-count itself).
      footnote: `median cycle · ${capturedIn.n} in${capturedIn.tag !== flowWindow ? ` (${capturedIn.tag})` : ''} / ${mergedInFlowWindow} out (${flowWindow}) · ${queued} queued`,
      state: queued > 5 ? 'warning' : 'neutral',
      href: '/work',
      open: { kind: 'projection', id: 'work' },
    },
    {
      label: 'Reliability',
      // Headline is the clean-landing rate over the SELECTED window (WI-129) — the target line
      // (90%) is judged against THIS number, not the fixed-30d or attempt-level secondaries, so
      // the value shown must be the one the target marker applies to.
      value: cleanPctHeadline !== undefined ? `${cleanPctHeadline}%` : '–',
      // Footnote packs: windowed clean-landing count (labelled with the window it's actually
      // scoped to) · a fixed 30d clean-landing rate+count for longer-horizon context · the 90%
      // target marker · the attempt-level secondary (explicitly relabeled "this try" so it can
      // never be mistaken for the clean-landing headline) · a one-tap link to the dirty items.
      footnote: totalHeadline > 0
        ? `${cleanHeadline}/${totalHeadline} clean landing (${reliabilityWindow}) · ${cleanPct30d !== undefined ? `${clean30d}/${total30d} clean (30d)` : 'no merges (30d)'} · target ${RELIABILITY_TARGET_PCT}% · this try: ${mergedTotal > 0 ? `${firstAttempt}/${mergedTotal} (${reliabilityWindow})` : `no merges (${reliabilityWindow})`}`
        : `no merges yet (${reliabilityWindow}) · target ${RELIABILITY_TARGET_PCT}%`,
      state: totalHeadline === 0 ? 'neutral' : cleanPctHeadline! >= RELIABILITY_TARGET_PCT ? 'success' : 'warning',
      // One-tap link to the current dirty-item list — /work is the Missions board every other
      // Glance drill (Stuck, Flow) already opens; there is no separate "dirty items" surface.
      href: '/work',
      open: { kind: 'projection', id: 'work' },
    },
  ];

  return { metrics, allClear, pulse };
}

function buildDecisionDesk(fold: FoldSummary): CommandEvent[] {
  return fold.active
    .filter(isDecisionPark)
    .map((i) => {
    const origin = deriveOrigin(i.touches);
    // Deterministic verb forms (zero-JS): spine parks use the spine verb, other parks
    // the parked verb — both matched by the app's /intent short-circuit.
    const isSpine = classifyPark(i.parkReason ?? '') === 'spine';
    const post = '/intent?next=/command';
    const approveIntent = isSpine
      ? `\u{1F6E1} spine ${i.id}: approve`
      : `\u25B6 parked ${i.id}: approve`;
    const declineIntent = isSpine
      ? `\u{1F6E1} spine ${i.id}: reject`
      : `\u25B6 parked ${i.id}: decline`;
    return {
      state: 'warning' as OperationalState,
      title: specLabel(i),
      metadata: ['parked', ...(i.priority ? [i.priority] : [])],
      decisionBlock: buildDecisionBlock(i),
      badge: { state: 'critical' as OperationalState, label: 'Needs you', emphasis: 'blocking' as const },
      ...(origin ? { originChip: originBadge(origin) } : {}),
      // Same verb LABELS as Missions/the item hub (work-adapter.ts buildRunControlActions) —
      // one wording for the same POST verb everywhere it renders (Command-vs-Missions split).
      actions: [
        { id: `approve:${i.id}`, label: approveActionLabel(i.branch, i.branchAlive), emphasis: 'primary' as const, form: { action: post, intent: approveIntent } },
        { id: `decline:${i.id}`, label: 'Decline — retire', emphasis: 'danger' as const, form: { action: post, intent: declineIntent } },
      ],
      // Every "Item detail" evidence link points at the item hub (`/item/<id>`).
      evidence: { id: i.id, label: 'Item detail →', href: `/item/${i.id}` },
    };
    });
}

/** WI-354: the STUCK glance tile only flags an ops-park once it's breaker-tripped or 6h+
 *  stale (buildGlance above) — anything younger/mid-recovery is otherwise invisible on
 *  Command (the WI-348 incident: parked 3.5h at attempts=1, Glance read "none stuck", the
 *  desk read "Clear"). This lists every OTHER active ops-park — id/age/attempts/retry
 *  state — visibility only, no actions (ops parks are plane-owned — never a
 *  founder action target). `unblockNote` is reused (not re-derived, one-parser rule)
 *  for the retry-state line, so it can never read differently than the health card's own
 *  "auto-retries; escalates on breaker" narrative for the same park class. */
function buildOpsParks(fold: FoldSummary): CommandEvent[] {
  const nowMs = new Date(fold.generatedAt).getTime();
  return fold.active
    .filter((i) => i.state === 'parked' && i.parkKind === 'ops' && !(i.parkReason ?? '').startsWith('breaker:'))
    .filter((i) => {
      const last = lastActivityMs(i);
      return last === undefined || nowMs - last <= SIX_HOURS_MS;
    })
    .map((i) => {
      const last = lastActivityMs(i);
      const age = last !== undefined ? formatAge(nowMs - last) : 'unknown';
      const attempts = i.attempts ?? 0;
      return {
        state: 'warning' as OperationalState,
        title: specLabel(i),
        metadata: [i.id, age, `${attempts} attempt${attempts === 1 ? '' : 's'}`, unblockNote(i.parkKind, i.parkReason)],
        evidence: { id: i.id, label: 'Item detail →', href: `/item/${i.id}` },
      };
    });
}

/** Building/approved items reshaped to `CommandEvent[]` — the one place this extraction
 *  happens, shared by the Conductor region and the pipeline's building stage (WI-355) so
 *  the two never drift apart (one-parser rule). */
function buildBuildingEvents(fold: FoldSummary): CommandEvent[] {
  const nowMs = new Date(fold.generatedAt).getTime();
  return fold.active
    .filter((i) => i.state === 'building' || i.state === 'approved')
    .map((i) => {
      // `touches` is a comma-joined string — count real paths, not string chars.
      const fileCount = toTouchList(i.touches).length;
      const last = lastActivityMs(i);
      const age = last !== undefined ? formatAge(nowMs - last) : undefined;
      // ONE status deriver (status-catalog.ts, WI-086/WI-087): this badge used to hand-roll
      // its own "Approved — merging" string, a THIRD copy of the same approved→merging
      // translation work-adapter.ts and item-hub-adapter.ts each derived independently.
      const status = deriveItemStatus({ state: i.state });
      return {
        state: status.tone,
        title: specLabel(i),
        metadata: [i.state, ...(fileCount ? [`${fileCount} file${fileCount === 1 ? '' : 's'}`] : []), ...(age ? [age] : [])],
        badge: { state: status.tone, label: status.label },
        evidence: { id: i.id, label: 'Item detail →', href: `/item/${i.id}` },
      };
    });
}

function buildConductor(fold: FoldSummary): CommandData['conductor'] {
  const workers = buildBuildingEvents(fold);
  const headline = workers.length ? `${workers.length} in flight` : 'Idle';
  return { headline, state: workers.length ? 'progress' : 'neutral', workers };
}

/** WI-355: the "preparing" pipeline stage — items in `captured`/`routed` state, currently
 *  invisible anywhere on Command (the old scheduling readout only ever listed `queued` and
 *  `parked` rows — see `buildQueueBlocking`, @loopkit/core src/cli.ts). `fold.active` never
 *  actually carries `captured` items (only queued/routed/building/approved/parked reach it),
 *  so in practice this surfaces `routed` items only — the filter is kept honest against both
 *  states rather than hardcoding the one that happens to fire today. */
function buildPreparing(fold: FoldSummary): CommandEvent[] {
  const nowMs = new Date(fold.generatedAt).getTime();
  return fold.active
    .filter((i) => i.state === 'captured' || i.state === 'routed')
    .map((i) => {
      const last = lastActivityMs(i);
      const age = last !== undefined ? formatAge(nowMs - last) : undefined;
      return {
        state: foldState(i.state),
        title: specLabel(i),
        metadata: [i.state, ...(age ? [age] : [])],
        evidence: { id: i.id, label: 'Item detail →', href: `/item/${i.id}` },
      };
    });
}

/** WI-355: the "queued" pipeline stage — the same `queueBlocking` rows the old scheduling
 *  region rendered (@loopkit/core src/cli.ts `buildQueueBlocking`), enriched with item age
 *  via a plain id join against `fold.active` — never re-deriving `runnable`/`reason`
 *  (one-predicate rule). `buildQueueBlocking` also appends parked items
 *  (`reason: "parked: …"`) to explain why the queue is stuck; those are filtered out here so
 *  they never duplicate the decision desk / Active ops-parks card (ops parks are plane-owned
 *  — never a founder action target). */
function buildQueuedPipelineStage(fold: FoldSummary): CommandEvent[] {
  const activeById = new Map(fold.active.map((i) => [i.id, i]));
  const nowMs = new Date(fold.generatedAt).getTime();
  return (fold.queueBlocking ?? [])
    .filter((row) => activeById.get(row.id)?.state !== 'parked')
    .map((row) => {
      const item = activeById.get(row.id);
      const last = item ? lastActivityMs(item) : undefined;
      const age = last !== undefined ? formatAge(nowMs - last) : undefined;
      return {
        state: (row.runnable ? 'success' : 'warning') as OperationalState,
        title: item ? specLabel(item) : row.id,
        metadata: [row.runnable ? 'runnable' : 'blocked', ...(age ? [age] : [])],
        ...(row.reason ? { summary: row.reason } : {}),
        evidence: { id: row.id, label: 'Item detail →', href: `/item/${row.id}` },
      };
    });
}

/** WI-355: the three flow-ordered pipeline stages (preparing → queued → building) that
 *  replace the "Why isn't this building?" diagnostic on Command — `schedulingRegion` stays
 *  in service for Missions (work-projection.ts engineRegion), this is Command's own honest,
 *  flow-shaped picture of the same build lane. */
function buildPipelineFlow(fold: FoldSummary): PipelineFlow {
  return {
    preparing: buildPreparing(fold),
    queued: buildQueuedPipelineStage(fold),
    building: buildBuildingEvents(fold),
  };
}

/** Human-format an auto-accept window given in hours (e.g. 168 → "7d", 84 → "3.5d", 48 →
 *  "48h"). Shared by {@link mergedItemBadge} — the ONE place a merged item's tier turns
 *  into a badge, so its countdown text can never drift from a second, differently-worded
 *  copy (the exact WI-086 drift class, applied to the acceptance-tier axis). */
function formatWindow(hours: number | undefined, fallback: string): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return fallback;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

/** Acceptance-tier-aware badge for a merged item — the ONE deriver for a merged item's
 *  tier/accepted badge, called by both Command's delivery stream and the acceptance desk's
 *  queue rows. Before this, each surface hand-rolled its own tier→label mapping and they
 *  said different things for the same item at the same moment (delivery stream: "Delivered
 *  — needs your test"; acceptance desk: "Needs your test") — the same cross-projection
 *  drift WI-086/WI-087 closed for lifecycle-state badges, recurring on the acceptance-tier
 *  axis. `windows` (fold.tierWindows) drives the review/optional countdown text with the
 *  ACTUAL verdict-tuned wait, never a hardcoded default. */
export function mergedItemBadge(
  item: { tier?: string | undefined; accepted?: boolean | undefined },
  windows?: { optional?: number; review?: number },
): { state: OperationalState; label: string; emphasis?: 'recommended' } {
  if (item.accepted) return { state: 'success', label: 'Accepted' };
  switch (item.tier) {
    case 'must':
      return { state: 'warning', label: 'Needs your test', emphasis: 'recommended' };
    case 'review':
      return { state: 'progress', label: `Review — auto-accepts in ${formatWindow(windows?.review, '7d')}` };
    case 'optional':
      return { state: 'neutral', label: `Auto-accepts in ${formatWindow(windows?.optional, '48h')}` };
    case 'auto':
      return { state: 'success', label: 'Auto-accepted — no action needed' };
    default:
      return { state: 'warning', label: 'Needs your test', emphasis: 'recommended' };
  }
}

/** The one mapper from a merged fold item to a `CommandEvent` row — shared by the delivery
 *  stream (every recent merge) and the To-test region (just the awaiting-verdict subset), so
 *  the same merged item can never render a different badge/title/action in the two places. */
function mergedEventFor(m: FoldMergedItem, fold: FoldSummary): CommandEvent {
  const origin = deriveOrigin(m.touches);
  const post = '/intent?next=/command';
  const acceptIntent = `✅ accept ${m.id}`;
  // Only must/review tiers need a founder verdict at all — optional/auto
  // auto-accept on their own (a timer, or immediately) with nothing for the founder to do,
  // so neither gets the urgent Accept affordance (mirrors the badge split above).
  const needsAcceptAction = !m.accepted && (m.tier === 'must' || m.tier === 'review' || m.tier === undefined);
  return {
    state: 'success' as OperationalState,
    title: specLabel(m),
    metadata: [m.accepted ? 'accepted' : 'shipped', ...(m.mergeCommit ? [m.mergeCommit.slice(0, 7)] : [])],
    badge: mergedItemBadge(m, fold.tierWindows),
    ...(origin ? { originChip: originBadge(origin) } : {}),
    ...(needsAcceptAction
      ? { actions: [{ id: `accept:${m.id}`, label: 'Accept', emphasis: 'primary' as const, form: { action: post, intent: acceptIntent } }] }
      : {}),
    // Item-hub link sweep (WI-349): every "Item detail" evidence link now points at the
    // canonical hub, not the retired per-item timeline view.
    evidence: { id: `detail-${m.id}`, label: 'Item detail →', href: `/item/${m.id}` },
  };
}

function buildDeliveryStream(fold: FoldSummary): CommandEvent[] {
  // Newest first — the fold emits insertion (event) order.
  return [...fold.recentMerged]
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
    .map((m) => mergedEventFor(m, fold));
}

/** Command's "To test" region (WI-128): the actual shipped-awaiting-verdict rows, oldest
 *  first — the longest-waiting slice needs the founder's attention soonest. Reuses the SAME
 *  `isAwaitingVerdict` predicate the Glance "To test" tile counts and the SAME `mergedEventFor`
 *  mapper the delivery stream renders with, so this region's row count and each row's badge
 *  can never drift from what Glance/the delivery stream say about the same merged item. */
function buildToTest(fold: FoldSummary): CommandEvent[] {
  return fold.recentMerged
    .filter(isAwaitingVerdict)
    .sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? ''))
    .map((m) => mergedEventFor(m, fold));
}

function buildPipeline(fold: FoldSummary): PipelineStage[] {
  return [
    { label: 'Queued', count: count(fold.counts, 'queued', 'routed'), state: 'neutral' },
    { label: 'Building', count: count(fold.counts, 'building', 'testing'), state: 'progress' },
    { label: 'Approved', count: count(fold.counts, 'approved'), state: 'progress' },
    { label: 'Parked', count: count(fold.counts, 'parked'), state: count(fold.counts, 'parked') > 0 ? 'warning' : 'neutral' },
    { label: 'Merged', count: fold.recentMerged.length, state: 'success' },
  ];
}

function buildHealth(fold: FoldSummary): CommandData['opsHealth'] {
  const blocked = count(fold.counts, 'blocked');
  if (blocked > 0) return { headline: `${blocked} blocked`, state: 'critical' };
  // Non-decision parks (plane-owned — never a founder action target) surface here, never on the founder's needs-you desk.
  // They further split by parkKind: 'decomposition' is an approved item waiting on the
  // planner lane, 'hold' is a deliberate deferral, and everything else is a plain 'ops'
  // mechanical/infra failure — 'stuck' if the breaker tripped, otherwise mid-recovery (the
  // reactor auto-requeues it). Only breaker-tripped and hold need eyes; awaiting-auto-retry
  // and awaiting-planner are normal-state counts, so this line is never critical, and only
  // warning when a bucket that actually needs attention is non-empty.
  const nonDecisionParks = fold.active.filter(isOpsPark);
  const decomposition = nonDecisionParks.filter((i) => i.parkKind === 'decomposition');
  const hold = nonDecisionParks.filter((i) => i.parkKind === 'hold' || (i.parkReason ?? '').startsWith('hold:'));
  const opsParks = nonDecisionParks.filter((i) => i.parkKind !== 'decomposition' && !hold.includes(i));

  if (opsParks.length === 0 && decomposition.length === 0 && hold.length === 0) {
    return { headline: 'Lane healthy', state: 'success' };
  }

  const stuck = opsParks.filter((i) => (i.parkReason ?? '').startsWith('breaker:')).length;
  // The count logic here was already right — only the verb overclaimed.
  // 'auto-recovering' implied the plane was actively fixing it; it's really just waiting
  // on the next scheduled retry attempt.
  const recovering = opsParks.length - stuck;
  const parts: string[] = [];
  if (recovering > 0) parts.push(`${recovering} awaiting auto-retry`);
  if (stuck > 0) parts.push(`${stuck} stuck — breaker tripped`);
  if (decomposition.length > 0) parts.push(`${decomposition.length} awaiting planner`);
  if (hold.length > 0) parts.push(`${hold.length} on hold`);

  const state: OperationalState = stuck > 0 || hold.length > 0 ? 'warning' : 'success';
  return { headline: parts.join(' · '), state };
}

const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;

/** First line, clamped to 80 chars with an ellipsis — shared by every text source the
 *  strip can fall back to (thread opening message, bare `spec`) so no caller re-derives
 *  its own truncation rule. */
function truncateLine(raw: string): string {
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
}

/** Derive the strip's foldState + thread-sourced metadata for one item id, shared by every
 *  source (thread/active/recentMerged) that can produce a candidate row — one derivation,
 *  never three drifting copies (one-parser rule). */
function deriveRecentIntentState(
  id: string,
  fold: FoldSummary,
  activeById: Map<string, FoldActiveItem>,
  mergedIds: Set<string>,
  rejectedById: Map<string, string | undefined>,
  answeredIds: Set<string>,
  thread: FoldThread | undefined,
): string {
  const activeItem = activeById.get(id);
  if (activeItem) return activeItem.state;
  if (mergedIds.has(id)) return 'merged';
  if (rejectedById.has(id)) {
    // WI-331: split a real founder decline from a machine-driven closure — a bare
    // 'rejected' state read as a founder reject even when the reactor closed it
    // autonomously (duplicate-of-merged, decomposition supersede). Absent `rejectedBy`
    // (pre-WI-331 replays) reads as founder-equivalent, matching threads-adapter.ts.
    const rejectedBy = rejectedById.get(id);
    const isMachineClosed = !!rejectedBy && rejectedBy !== 'founder';
    return isMachineClosed ? 'superseded' : 'rejected';
  }
  if (answeredIds.has(id)) {
    // WI-196 terminal routes (answer/question/duplicate/merged) rest in 'answered';
    // without this branch they fell through to the replied-thread 'routed' fallback
    // and read as stuck on the strip.
    return 'answered';
  }
  if (thread && thread.outCount > 0) return 'routed';
  return 'captured';
}

/** One candidate row before dedup/windowing — `activityMs` is the timestamp this item's
 *  24h-window membership is judged on (thread first-in ts / mergedAt / active state
 *  timestamp), never a fabricated "now". `hasThreadText` marks a row that carries an actual
 *  opening/reply message, so the dedupe step below can prefer it over a spec-only row for
 *  the same id. */
type RecentIntentCandidate = {
  intent: RecentIntent;
  activityMs: number | undefined;
  hasThreadText: boolean;
};

/** Build the strip from every recently-TOUCHED item, not just threads — WI-061: in
 *  attended fast-drain mode nothing ever replies (no msg.out, no externalRef), so a
 *  captured/merged item never became a "thread" (core summary.ts `isThread`) and was
 *  invisible here even though it's current work. Thread-ness now only contributes the EXT
 *  chip / thread link / opening-message text to a row that already qualifies by being
 *  active, recently merged, or recently captured — it never gates whether the row appears
 *  at all. Sourced from the union of `fold.recentMerged` (newest mergedAt first),
 *  `fold.active`, and `fold.threads` (captured-in-24h even with zero messages); an id
 *  present in more than one source renders ONCE, preferring the richer (thread-text +
 *  merged-state) row (`mergeCandidate` below).
 *
 *  `nowFn` (default `Date.now`) is the same injectable-clock shape core's slo.ts uses
 *  (`SloProbes.now`) — production callers never pass it (real wall clock), tests pass a
 *  fixed clock so the 24h-window filter judges against the SAME instant the fixture's
 *  timestamps were authored against, rather than whatever moment the test happens to run. */
function buildRecentIntents(fold: FoldSummary, nowFn: () => number = Date.now): RecentIntent[] {
  const activeById = new Map(fold.active.map((a) => [a.id, a]));
  const mergedById = new Map(fold.recentMerged.map((m) => [m.id, m]));
  const mergedIds = new Set(mergedById.keys());
  const threadById = new Map((fold.threads ?? []).map((t) => [t.id, t]));
  // rejectedBy (WI-331): a machine-closed item (e.g. reactor duplicate-of-merged /
  // decomposition supersede) must never read as a founder rejection on the strip —
  // mirrors threads-adapter.ts's deriveThreadState split.
  const rejectedById = new Map((fold.recentRejected ?? []).map((r) => [r.id, r.rejectedBy]));
  const answeredIds = new Set((fold.recentAnswered ?? []).map((a) => a.id));
  const now = nowFn();

  // Union of every id that could plausibly belong on the strip: active work, recently
  // merged work, and any thread (which may be captured-only, with zero messages).
  const ids = new Set<string>([...activeById.keys(), ...mergedById.keys(), ...threadById.keys()]);

  function buildCandidate(id: string): RecentIntentCandidate | null {
    const activeItem = activeById.get(id);
    const merged = mergedById.get(id);
    const thread = threadById.get(id);
    const firstIn = (thread?.messages ?? []).find((m) => m.direction === 'in');

    // Latest relevant activity: thread's first-in ts, else mergedAt, else the active
    // item's own last-transition timestamp (createdAt/queuedAt/buildingAt/parkedAt/
    // approvedAt). Undefined only when none of the three sources carry a usable
    // timestamp — such a row passes the 24h filter rather than being fabricated as "now".
    const threadOrMergeMs = [firstIn?.ts, merged?.mergedAt]
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime())
      .find((t) => Number.isFinite(t));
    const activityMs = threadOrMergeMs ?? (activeItem ? lastActivityMs(activeItem) : undefined);

    if (activityMs !== undefined && now - activityMs > TWENTY_FOUR_H_MS) return null;

    const foldState = deriveRecentIntentState(id, fold, activeById, mergedIds, rejectedById, answeredIds, thread);

    const hasThreadText = !!(firstIn?.text && firstIn.text.trim().length > 0);
    const rawText = firstIn?.text ?? activeItem?.spec ?? merged?.spec ?? '';
    const text = truncateLine(rawText) || id;
    const timestamp = firstIn?.ts ?? merged?.mergedAt ?? (activeItem ? isoFromMs(lastActivityMs(activeItem)) : undefined);

    // ONE status deriver (status-catalog.ts, WI-086/WI-087): this is the exact fix for the
    // reported bug — the strip used to render the bare `foldState` string as the badge label
    // (e.g. 'queued'), while Missions (work-adapter.ts) derived a richer interim label
    // ('queued — routing…') for the SAME item from the SAME fold. `foldState` here is
    // already resolved by deriveRecentIntentState (raw active state, or 'merged'/
    // 'superseded'/'rejected'/'answered'/'routed'/'captured') — deriveItemStatus only needs
    // the parkKind/breaker/interim signals a plain active item carries.
    const status = deriveItemStatus({
      state: foldState,
      ...(activeItem?.parkKind ? { parkKind: activeItem.parkKind } : {}),
      breakerTripped: (activeItem?.parkReason ?? '').startsWith('breaker:'),
      interimApproved: activeItem
        ? isInterimApprovedStatus(activeItem.state, activeItem.lastUnparkedAt, activeItem.parkedAt)
        : false,
    });

    const intent: RecentIntent = {
      id,
      text,
      foldState,
      opState: status.tone,
      statusLabel: status.label,
      ...(thread?.externalRef ? { externalRef: thread.externalRef } : {}),
      ...(timestamp ? { timestamp } : {}),
      // Item-hub link sweep (WI-349): the strip's "timeline" link now opens the item hub —
      // field name kept (RecentIntent.timelineHref) to avoid a wider rename across callers.
      timelineHref: `/item/${id}`,
      // A channel-style externalRef (e.g. 'console') isn't a resolvable per-intent address
      // (see isResolvableExternalRef) — route the "thread" link at the item hub instead of
      // a /threads/<ref> page the router can never resolve for it.
      ...(thread?.externalRef
        ? { threadHref: isResolvableExternalRef(thread.externalRef) ? `/threads/${thread.externalRef}` : `/item/${id}` }
        : {}),
    };

    return { intent, activityMs, hasThreadText };
  }

  const byId = new Map<string, RecentIntentCandidate>();
  for (const id of ids) {
    const candidate = buildCandidate(id);
    if (!candidate) continue;
    const existing = byId.get(id);
    // Dedupe: prefer the richer row — thread text over none, then the more complete
    // (merged) state over an active/captured one. `hasThreadText` alone would keep a
    // captured-only thread row over a genuinely-merged duplicate, so state richness
    // breaks the tie once thread-text presence is equal.
    if (!existing) {
      byId.set(id, candidate);
    } else {
      const candidateRicher =
        (candidate.hasThreadText && !existing.hasThreadText) ||
        (candidate.hasThreadText === existing.hasThreadText && candidate.intent.foldState === 'merged' && existing.intent.foldState !== 'merged');
      if (candidateRicher) byId.set(id, candidate);
    }
  }

  return [...byId.values()]
    .sort((a, b) => (b.intent.timestamp ?? '').localeCompare(a.intent.timestamp ?? ''))
    .slice(0, 5)
    .map((c) => c.intent);
}

function isoFromMs(ms: number | undefined): string | undefined {
  return ms !== undefined ? new Date(ms).toISOString() : undefined;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Build the command projection envelope from a raw fold summary. Unknown/malformed
 *  input yields a `failed` envelope (loud fold failure) — never a
 *  falsely-calm empty picture.
 *
 *  `opts.now` (default `Date.now`, same injectable-clock shape as core's slo.ts
 *  `SloProbes.now`): the recent-intents strip's 24h-window filter reads this instead of
 *  the real wall clock directly, so a test can pin both the fixture's timestamps and the
 *  "now" they're judged against to the same fixed instant — production callers never pass
 *  it (real wall clock throughout, behavior unchanged). */
export function commandProjectionFromFold(
  raw: unknown,
  opts: { ledgerSequence: number; foldVersion?: string; staleAfterSeconds?: number; window?: GlanceWindow; now?: () => number } = { ledgerSequence: 0 },
): ProjectionEnvelope<CommandData> {
  const foldVersion = opts.foldVersion ?? 'loopkit';
  const staleAfter = opts.staleAfterSeconds ?? 45;

  if (!isFoldSummary(raw)) {
    return {
      projectionId: 'command',
      schemaVersion: SCHEMA_VERSION,
      foldVersion,
      ledgerSequence: opts.ledgerSequence,
      generatedAt: new Date().toISOString(),
      freshUntil: new Date().toISOString(),
      state: 'failed',
      data: emptyCommandData(),
      evidence: [
        { id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' },
      ],
    };
  }

  const fold = raw;
  const generatedAt = fold.generatedAt;
  const freshUntil = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();
  const glance = buildGlance(fold, opts.window ? { window: opts.window } : {});

  return {
    projectionId: 'command',
    schemaVersion: SCHEMA_VERSION,
    foldVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: glance.metrics,
      glanceAllClear: glance.allClear,
      glancePulse: glance.pulse,
      conductor: buildConductor(fold),
      deliveryStream: buildDeliveryStream(fold),
      decisionDesk: buildDecisionDesk(fold),
      toTest: buildToTest(fold),
      opsParks: buildOpsParks(fold),
      opsHealth: buildHealth(fold),
      pipeline: buildPipeline(fold),
      recentIntents: buildRecentIntents(fold, opts.now ?? Date.now),
      threads: buildThreads(fold),
      // WI-355: preparing/queued/building, replacing the flat queueBlocking pass-through.
      pipelineFlow: buildPipelineFlow(fold),
    },
    evidence: [
      { id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' },
    ],
  };
}

/** Nav IA rewire: the same thread-card build + most-recent-reply-first sort
 *  threads-adapter.ts's `threadsProjectionFromFold` uses, reused here (not copied)
 *  so Command's folded-in "Conversations" region can never drift from the
 *  standalone Threads route's ordering. */
function buildThreads(fold: FoldSummary): ThreadCard[] {
  const foldThreads = (fold.threads ?? []) as FoldThread[];
  const sorted = [...foldThreads].sort((a, b) => {
    const ta = a.lastOutTs ? new Date(a.lastOutTs).getTime() : 0;
    const tb = b.lastOutTs ? new Date(b.lastOutTs).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return (a.externalRef ?? a.id).localeCompare(b.externalRef ?? b.id);
  });
  return sorted.map((t) => toThreadCard(t, fold));
}

function emptyCommandData(): CommandData {
  return {
    glance: [],
    glanceAllClear: false,
    glancePulse: { building: [], queue: { depth: 0 }, shipped: { count: 0, window: DEFAULT_GLANCE_WINDOW, cycleLabel: '–' } },
    conductor: { headline: 'unavailable', state: 'critical', workers: [] },
    deliveryStream: [],
    decisionDesk: [],
    toTest: [],
    opsParks: [],
    opsHealth: { headline: 'unavailable', state: 'critical' },
    pipeline: [],
    recentIntents: [],
    threads: [],
    pipelineFlow: { preparing: [], queued: [], building: [] },
  };
}
