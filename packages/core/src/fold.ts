/**
 * fold.ts — Pure deterministic fold: events → per-item state.
 *
 * State machine:
 *   captured → routed → queued → building → gated → parked → approved → merged → accepted
 *           ↘ answered (terminal, on item.routed with route in [answer,question,duplicate,merged])
 *                                          ↘ done (on gate.passed + merged)
 *                                  rejected (terminal)
 *                                  done (terminal)
 *
 * All intermediate parked states re-enter via unparked → queued.
 * Unknown event types are forwarded without changing state (forward-compatible).
 *
 * TERMINAL states (symmetric state machine): `merged`, `rejected`, `accepted`, `answered`,
 * `done`. Once an item reaches a terminal state, a late STATE-transitioning event (a duplicate
 * approval, a stray park/merge/reject, a gate result) is recorded for its DATA (messages,
 * verdicts, deploy flags, briefs) but never regresses the state. The two legitimate transitions
 * OUT of a terminal state are:
 *   (a) `merged` → `accepted` on item.accepted (the operator's/reactor's acceptance), and
 *   (b) any terminal → `queued` on item.reopened (an explicit re-open, clears park fields,
 *       records reopenedBy/reason).
 * Rationale: a duplicate item.approved after item.merged once drove the reactor's branch-missing
 * path and parked an already-shipped item; a stray item.merged once flipped a building item to
 * merged. The guard extends to all terminals symmetrically because item.rejected → later
 * item.merged replays could fold a shipped item as `rejected`.
 *
 * Park-field lifecycle: parkReason/parkKind/parkClass are LIVE only while
 * state === 'parked'. Every exit-from-parked transition (unparked, approved, merged, accepted,
 * rejected, re-dispatch) archives them to lastParkReason/lastParkKind (forensics survive) and
 * clears the live fields, so a non-parked record never carries a stale park label.
 */

import { createHash } from 'node:crypto';
import { LedgerEvent, DEFAULT_LANE, DEFAULT_CLAIM_TTL_MINUTES } from './schema.js';
import { fallbackTargetId } from './target.js';

/**
 * Deterministic error fingerprint (a pure hash, never an LLM judgement) used by the
 * doctor's thrashing detector to recognize 3 consecutive crashes with the same underlying
 * cause. Same stderrTail → same fingerprint, every replay.
 */
export function computeErrorFingerprint(stderrTail: string): string {
  return createHash('sha1').update(stderrTail).digest('hex').slice(0, 16);
}

/**
 * Deterministic failure-CLASS fingerprint (same pure-hash discipline as
 * computeErrorFingerprint) for the novelty-vs-known-failure catalog. Identifies
 * "the same underlying park reason" across different items so a repeat failure already routed
 * through the bounded auto-requeue health lane doesn't re-page the operator every occurrence.
 * Normalization is deliberately shallow (trim/lowercase/collapse whitespace) — no parsing or
 * redaction of the reason text.
 */
export function computeParkFingerprint(reason: string | undefined, parkKind?: string): string {
  const normalized = (reason ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha1').update(`${parkKind ?? ''}:${normalized}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-item state
// ---------------------------------------------------------------------------

export type ItemState =
  | 'captured'
  | 'routed'
  | 'answered'
  | 'queued'
  | 'building'
  | 'gated'
  | 'parked'
  | 'approved'
  | 'merged'
  | 'accepted'
  | 'rejected'
  | 'done';

export interface ItemBuild {
  attempt: number;
  pid?: number;
  /** Detached worker process-GROUP id (from build.dispatched.pgid). See schema.ts. */
  pgid?: number;
  worktree?: string;
  branch?: string;
  provider?: string;
  model?: string;
  dispatchedAt?: string;
  finishedAt?: string;
  crashedAt?: string;
  crashReason?: string;
  stderrTail?: string;
  /**
   * Deterministic hash of stderrTail (computeErrorFingerprint), set only when stderrTail is a
   * non-empty string — absent stderrTail means "no signal", not "matches every other absent
   * signal", so it must never collide with another build's absent fingerprint.
   */
  errorFingerprint?: string;
}

export interface ThreadMessage {
  ts: string;
  direction: 'in' | 'out';
  text: string;
}

/**
 * SESSION MODE: the live claim lease on a queued item (item.claimed). LIVE only while the
 * item sits in the shared queue — cleared by item.released and by every queued-consuming or
 * terminal transition (dispatch, park, merge, accept, reject, terminal routing, reopen).
 * Expiry is NEVER folded in: the fold is pure, so "is this claim still deferring the beats?"
 * is computed at read time by isClaimActive (the ONE predicate) from claimedAt + ttl + the
 * claiming session's last heartbeat vs a caller-supplied now.
 */
export interface ItemClaim {
  sessionId: string;
  claimedAt: string;   // ISO ts of the item.claimed event
  ttlMinutes: number;
}

export interface ItemRecord {
  id: string;          // WI-NNN
  state: ItemState;
  createdAt?: string;
  capturedAt?: string;
  routedAt?: string;
  answeredAt?: string;
  queuedAt?: string;
  buildingAt?: string;  // last dispatch ts
  gatedAt?: string;
  parkedAt?: string;
  lastUnparkedAt?: string;
  approvedAt?: string;
  mergedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  /** Who/what closed the item (item.rejected.by): 'operator' for an actual operator decline,
   *  'reactor'/other for a machine-driven closure (duplicate-of-merged, decomposition supersede).
   *  Undefined on older replays — consumers treat that as operator-equivalent (absence never
   *  means "unknown machine action"). */
  rejectedBy?: string;
  doneAt?: string;
  /** ts of the most recent item.reopened (a terminal→queued re-open). */
  reopenedAt?: string;
  /** who requested the re-open (item.reopened.by), forensics only. */
  reopenedBy?: string;
  /** why the item was re-opened (item.reopened.reason), forensics only. */
  reopenReason?: string;
  /** ts of the most recent item.escalated (a run-control flag; never a state transition). */
  escalatedAt?: string;
  /** who escalated (item.escalated.by), forensics only. */
  escalatedBy?: string;

  // source data from capture
  sourceText?: string;
  sensitivity?: string;
  source?: string;    // legacy source-id compatibility (older ledgers may carry externally-captured source ids)
  externalRef?: string;    // secondary legacy source-id ref
  /**
   * Delivery lane. Set by the router (item.routed/queued) or a lane-tagged capture; defaults
   * to 'engineering' for every item lacking the field, so a golden replay of the pre-lane
   * ledger reclassifies nothing.
   */
  lane: string;

  // build tracking
  attempts: number;
  builds: ItemBuild[];
  currentBuild?: ItemBuild;

  // ── Lifetime clean-landing counters (WI-108, companion to attempts) ──────────────────────
  // MONOTONE accumulators over the WHOLE lifecycle — unlike the last-occurrence timestamps
  // (parkedAt/escalatedAt) and `attempts` (bumped only on build.dispatched), these count how
  // many times each rough-landing signal ever fired for this WI, so a summary consumer can
  // compute a per-WI "clean landing" rate (did it park/crash/red/escalate on the way to merge?)
  // without re-scanning the raw event stream. Never reset — a re-open keeps the history. Absent
  // (undefined) on a record that has seen zero of that signal; consumers treat absent as 0.
  /** Count of item.parked events (every park, decision OR ops). */
  lifetimeParkCount?: number;
  /** Count of build.crashed + build.stalled events (worker died / made no progress). */
  lifetimeCrashCount?: number;
  /** Count of gate.failed + gate.parked events (a build proved red / oversteps its scope). */
  lifetimeGateRedCount?: number;
  /**
   * Operator-attention count: item.escalated events PLUS decision-kind parks (parkKind==='decision').
   * These are the landings that actually reached the operator's needs-you desk, distinct from
   * lifetimeParkCount which counts every park including the ops-lane ones the plane self-heals.
   */
  lifetimeEscalationCount?: number;

  // spec and routing
  spec?: string;
  route?: string;
  /** Router-stamped short title (item.routed.title). Absent on older replays and on routings
   *  where the model omitted it — consumers fall back to spec/text truncation. */
  title?: string;
  touches?: string;
  /**
   * TARGET EXTERNALIZATION (docs/event-model.md §"Capture intent against a target"): the
   * registered target name this work item is built against, stamped from item.captured.target.
   * ABSENT → legacy mode: the item builds against the plane's own repoRoot exactly as before
   * multi-target existed. Every downstream beat keys "is this a targeted build?" on this field
   * being present, so a ledger with no targets folds identically to the pre-target codebase.
   */
  target?: string;
  /**
   * Opaque stable target identity (see TargetRecord.targetId): the explicit `targetId`
   * stamped on the item's events, else resolved from the target NAME against the registered
   * targets, else coalesced at the end of the fold (FoldOptions.defaultTarget / the sole
   * registered target). Attribution/namespacing identity ONLY — `target` (the name) stays
   * the field the beats key routing on, so coalescing never changes build behavior.
   */
  targetId?: string;
  model?: string;
  effort?: string;
  priority?: string;
  repairContext?: string;

  // scout context pack (item.briefed)
  brief?: { text: string; at: string };

  // judge verdict (review.verdict). Advisory-only; never a state transition.
  // The quality signals (specSatisfied/scopeCreep/testTheatre) are folded too so the
  // acceptance overseer gate (acceptance.ts) can ratchet a merged item's tier upward.
  judgeVerdict?: {
    verdict: 'pass' | 'fail' | 'unparseable' | 'unavailable';
    confidence: number;
    specSatisfied?: 'yes' | 'partial' | 'no' | 'unknown';
    scopeCreep?: 'none' | 'minor' | 'major' | 'unknown';
    testTheatre?: 'none' | 'suspected' | 'unknown';
    at: string;
  };

  // park/park-class/approve tracking
  parkReason?: string;
  /**
   * The park INTENT kind ('decision' | 'ops') from item.parked.parkKind.
   * 'decision' = the operator must call it (conductor park, product-spine/overstep); it reaches
   * the operator needs-you desk. 'ops' = a mechanical/infra failure the plane owns (no-commit,
   * merge conflict, tests-red, infra:*, breaker); it routes to the health lane, never the desk.
   */
  parkKind?: string;
  /**
   * The gate's park CLASS token from gate.parked.reason ('touches-overstep' | 'spine'),
   * distinct from the human-readable parkReason (which item.parked overwrites). The
   * reactor's auto-approve classifier keys on this.
   */
  parkClass?: string;
  /**
   * The parkReason archived at the moment the item last EXITED 'parked' (via
   * unpark/approve/merge/accept/reject/re-dispatch). Live parkReason is cleared on exit so a
   * non-parked record never carries a stale label; this preserves it for forensics.
   */
  lastParkReason?: string;
  /** The parkKind archived at the last exit-from-parked (forensics; see lastParkReason). */
  lastParkKind?: string;
  /**
   * A build-ready spec stored on a dependency-wait park (item.parked.storedSpec).
   * LIVE only while state==='parked' — same lifecycle as parkReason/parkKind:
   * archived to lastStoredSpec and cleared on every exit-from-parked.
   */
  storedSpec?: string;
  /** The storedSpec archived at the last exit-from-parked (forensics; see lastParkReason). */
  lastStoredSpec?: string;
  /**
   * The failure-class fingerprint (computeParkFingerprint) of the LIVE park, set on the same
   * item.parked event as parkReason/parkKind. Live only while state==='parked' — cleared on
   * exit-from-parked like its siblings (park-field lifecycle above).
   */
  parkFingerprint?: string;
  /**
   * Novelty tag for the LIVE park (failure catalog): 'first-seen' the first time
   * this fingerprint is ever recorded across the whole fold, 'repeat-known' every time after.
   * Advisory-only — it gates phone-push/desk-push surfacing (reactor.ts), never the
   * park's own lifecycle (parkKind decision/ops stays the authority on where the item routes).
   */
  parkNovelty?: 'first-seen' | 'repeat-known';
  /**
   * Escalation-with-intent payload (item.parked.escalation — leader-leader doctrine, "escalate
   * with intent, never a bare question"). LIVE only while state==='parked' — same lifecycle as
   * parkReason/parkKind/storedSpec: archived to lastEscalation and cleared on exit-from-parked.
   * Optional — absent on every park emitted before this field existed, and on any park whose
   * emitter didn't supply one (the desk falls back to rendering the raw parkReason).
   */
  escalation?: { intent: string; evidence: string; risk: string; recommendation: string };
  /** The escalation payload archived at the last exit-from-parked (forensics; see lastParkReason). */
  lastEscalation?: { intent: string; evidence: string; risk: string; recommendation: string };
  /**
   * WI-084 park pathologist: the repair WI this item is blocked on (item.blocked.onItem).
   * LIVE while state==='parked' — same park-field lifecycle as parkReason/parkKind (cleared by
   * clearParkFields on every exit-from-parked, and explicitly on item.queued so a bare requeue
   * without an unpark still releases it — see the item.queued fold case).
   */
  blockedOn?: string;
  /**
   * WI-084 park pathologist: the parkFingerprint (see computeParkFingerprint) the pathologist
   * last diagnosed for this item (diagnosis.recorded.parkFingerprint). Dedup key — stepPathology
   * skips an item whose CURRENT rec.parkFingerprint already equals this, so a repeat identical
   * park reuses the prior diagnosis instead of spawning a second provider call.
   */
  lastDiagnosedFingerprint?: string;
  /**
   * WI-084 park pathologist: count of diagnosis.recorded events classified 'items-own-code' for
   * this item. Never reset (monotone) — used to enforce "first own-code failure requeues once,
   * second parks for review".
   */
  ownCodeFailures?: number;
  mergeCommit?: string;
  deployed?: boolean;
  /**
   * TRUST-HARDENING: actual-diff evidence folded from item.merged (additive; absent on legacy
   * merges and no-code merges). The acceptance classifier prefers `mergeChangedFiles` over the
   * declared `touches` so a merge with real code changes can never be mis-classified 'auto' just
   * because its declared touches were empty. `mergeBaseSha`..`mergeHeadSha` is the diff range;
   * `mergeChangedFilesTruncated` marks a >200-file list; `mergeGateCommand` is the proving command.
   */
  mergeBaseSha?: string;
  mergeHeadSha?: string;
  mergeChangedFiles?: string[];
  mergeChangedFilesTruncated?: boolean;
  mergeGateCommand?: string;
  /**
   * Certify-don't-brief payload (item.merged.certification — leader-leader doctrine: "a
   * certification of understanding, not an assertion of completion"). Optional — absent on
   * every merge predating this field, and on any merge whose worker manifest didn't supply
   * one (the acceptance desk renders a visible "no certification provided" line, never blank).
   * `couldBreak`/`detection`/`rollback` are optional (rather than required, as a merge-sourced
   * certification always fills them) because ADR-009's item.certification-amended can synthesize
   * this record from scratch on an item with no prior certification at all — only `portability`
   * is guaranteed set in that minimal shape.
   */
  mergeCertification?: { couldBreak?: string; detection?: string; rollback?: string; portability?: string };
  /** True when the item was accepted provisionally by reactor:oc6-provisional. */
  provisionalAccept?: boolean;

  /** SESSION MODE: live claim lease (see ItemClaim). Undefined = unclaimed. */
  claim?: ItemClaim;

  // transient merge failure tracking (state stays approved; retried next beat)
  transientFailCount?: number;
  lastTransientError?: string;

  // thread messages
  messages: ThreadMessage[];

  // timestamps per state transition (keyed by state name)
  transitions: Partial<Record<ItemState, string>>;
}

/**
 * One-parser rule for the dispatched branch: `currentBuild.branch` carries it while a build
 * is in flight, but the fold archives currentBuild into builds[] the moment the item leaves
 * the building state (gate park, crash, finish) — so a gate-parked item has NO currentBuild
 * and its branch lives only on the last builds[] entry. Every consumer that needs "the
 * branch this item was built on" (summary projection, approve verb's branch-gone check)
 * must resolve through this shared chain; reading only `currentBuild?.branch` silently
 * drops the branch for parked items.
 */
export function resolveItemBranch(rec: ItemRecord): string | undefined {
  return rec.currentBuild?.branch ?? rec.builds[rec.builds.length - 1]?.branch;
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export interface ConvMessage {
  ts: string;
  direction: 'in' | 'out';
  text: string;
}

export interface ConversationRecord {
  id: string;          // CONV-NNN
  state: 'active' | 'closed';
  createdAt?: string;
  closedAt?: string;
  source?: string;     // e.g. 'console' | 'cli' | a fork's own channel adapter name
  title?: string;
  messages: ConvMessage[];
  spawnedItems: string[];  // [WI-NNN, ...]
}

/**
 * TARGET EXTERNALIZATION (docs/event-model.md §"Register a target"): the registration
 * record projected from target.registered / target.manifest-updated events. The ledger is
 * truth; this map is the derived TargetBoard convenience the fold exposes. Keyed by the
 * opaque `targetId` (identity ≠ name); `name` is a mutable display handle.
 */
export interface TargetRecord {
  /**
   * Opaque stable target identity, the map key. From the registration event's `targetId`
   * when stamped; for legacy registration events that predate the field, the fold
   * synthesizes a deterministic repoPath-derived fallback (target.ts fallbackTargetId) so
   * old ledgers fold to the same identity on every replay — no ledger rewrite, ever.
   * Re-registering a previously seen repoPath (rename, archive-revive) keeps the ORIGINAL
   * id: repoPath is the stable revival key (docs/event-model.md §"Target lifecycle").
   */
  targetId: string;
  /** Mutable display handle — never an identity key; two targets may even share a name. */
  name: string;
  /** Absolute path to the target repo on the host (from the registration event). */
  repoPath: string;
  /** Branch the plane merges this target's finished builds into. */
  defaultBranch: string;
  /** Stable content hash of the manifest as of the latest registration/update event. */
  manifestHash: string;
  registeredAt: string;
  /** ts of the most recent target.manifest-updated, when the manifest has changed since add. */
  updatedAt?: string;
}

/**
 * The targets projection: a Map keyed by opaque `targetId`, with explicit secondary
 * lookups. `get`/`has` keep a TRANSITIONAL name-fallback (a miss on the id key re-tries as
 * a name scan) so callers written when the map was name-keyed keep resolving during the
 * cutover — new code must use `byId`/`byName`/`byRepoPath` explicitly and must never
 * persist a name as an identity key (docs/event-model.md: "Nothing downstream may key on
 * name").
 */
export class TargetsProjection extends Map<string, TargetRecord> {
  /** Primary lookup — exact targetId key, no fallback. */
  byId(targetId: string): TargetRecord | undefined {
    return super.get(targetId);
  }
  /** Display-name scan (first match in registration order). Names are mutable and MAY
   *  collide across targets — use only for operator-facing handles, never identity. */
  byName(name: string): TargetRecord | undefined {
    for (const rec of this.values()) if (rec.name === name) return rec;
    return undefined;
  }
  /** repoPath scan — the stable identity-revival key (one project, one id, forever). */
  byRepoPath(repoPath: string): TargetRecord | undefined {
    for (const rec of this.values()) if (rec.repoPath === repoPath) return rec;
    return undefined;
  }
  override get(key: string): TargetRecord | undefined {
    return super.get(key) ?? this.byName(key);
  }
  override has(key: string): boolean {
    return super.has(key) || this.byName(key) !== undefined;
  }
}

/**
 * SESSION MODE: one attended session's fold record (session.started / session.heartbeat /
 * session.ended). The map holds the LAST heartbeat per session; liveness ("is this session's
 * dead-man still fresh?") is computed at read time by isClaimActive from a supplied now,
 * never folded in.
 */
export interface SessionRecord {
  sessionId: string;
  startedAt?: string;
  /** ts of the most recent session.heartbeat (absent until the first beat). */
  lastHeartbeatAt?: string;
  /** ts of session.ended — an ended session's claims never defer the beats again. */
  endedAt?: string;
  source?: string;
}

/** One fingerprint's tally in the failure catalog (see computeParkFingerprint). */
export interface FailureCatalogEntry {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FoldResult {
  items: Map<string, ItemRecord>;
  conversations: Map<string, ConversationRecord>;
  /**
   * TARGET EXTERNALIZATION: registered targets (targetId → record; see TargetsProjection
   * for the secondary name/repoPath lookups). Empty when no target has ever been
   * registered — the legacy/default single-repo mode, in which the plane's own repoRoot is
   * the build target and no item carries a `target`.
   */
  targets: TargetsProjection;
  /** Max WI number seen (for new-item id allocation) */
  maxWiNum: number;
  /** Max CONV number seen (for new-conversation id allocation) */
  maxConvNum: number;
  /**
   * Novelty-vs-known-failure catalog, keyed by computeParkFingerprint(parkReason, parkKind).
   * Pure fold derivation over item.parked events, in event order — a fresh replay rebuilds it
   * deterministically, never preserves stale state (append-only ES doctrine).
   */
  failureCatalog: Map<string, FailureCatalogEntry>;
  /**
   * SESSION MODE: attended sessions (sessionId → record; last heartbeat per session).
   * Empty when no session has ever started — the always-away legacy mode, in which no
   * item ever carries a claim and the beats behave exactly as before sessions existed.
   */
  sessions: Map<string, SessionRecord>;
}

function newItem(id: string): ItemRecord {
  return {
    id,
    state: 'captured',
    lane: DEFAULT_LANE,   // every item defaults to the engineering lane
    attempts: 0,
    builds: [],
    messages: [],
    transitions: {},
  };
}

/**
 * Extract a `lane` off an event's data, keeping the current value when the field is
 * absent. Old events lack the field, so items fold to their existing lane — DEFAULT_LANE
 * from newItem — with zero reclassification.
 */
function foldLane(d: Record<string, unknown>, current: string): string {
  return typeof d['lane'] === 'string' && d['lane'] ? d['lane'] : current;
}

/** Matches a repo-relative file path with an extension, e.g. `packages/core/src/beats/reactor.ts`. */
const FILE_PATH_RE = /\b((?:[\w.-]+\/)+[\w.-]+\.\w+)\b/g;

/**
 * A conventional package-source root (e.g. `packages/core/src`, `apps/example/src`) — the
 * recommended DIRECTORY-level Touches for any broad "plane"/"app" work (never a bare file,
 * always the enclosing directory). But for a spec scoped to one area, the root is far wider
 * than the real footprint and serializes every other item naming the same root (a set of
 * queued items all stamped the same package root are none dispatchable together).
 */
function isBarePackageRoot(prefix: string): boolean {
  const segs = prefix.split('/');
  return segs.length >= 2 && segs[segs.length - 1] === 'src';
}

/** Longest shared leading path (segment-boundary) across a set of directory paths. */
function commonDirPrefix(dirs: string[]): string {
  const segLists = dirs.map(d => d.split('/'));
  let common = segLists[0] ?? [];
  for (const segs of segLists.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && segs[i] === common[i]) i++;
    common = common.slice(0, i);
  }
  return common.join('/');
}

/**
 * Narrow ONE Touches prefix from a bare package root down to the directory that actually
 * contains the files the spec names, e.g. `packages/core/src` + a spec naming
 * `packages/core/src/beats/reactor.ts` → `packages/core/src/beats`. Deterministic string
 * extraction only (transcribe-not-transform) — never re-guesses via an LLM. Keeps the
 * directory (not file) granularity so companion writes beside the named file stay in-scope
 * (file-level Touches would false-positive an overstep park). Falls back to the original
 * prefix, unchanged, whenever the spec names no files under it or the files span multiple
 * subdirectories with no narrower common ancestor.
 */
function narrowOnePrefix(prefix: string, spec: string): string {
  const norm = prefix.replace(/\/+$/, '');
  if (!isBarePackageRoot(norm)) return prefix;
  const matches = new Set<string>();
  for (const m of spec.matchAll(FILE_PATH_RE)) {
    const path = m[1] as string;
    if (path.startsWith(norm + '/')) matches.add(path);
  }
  if (matches.size === 0) return prefix;
  const dirs = [...matches].map(p => p.slice(0, p.lastIndexOf('/')));
  const common = commonDirPrefix(dirs);
  return common.length > norm.length ? common : prefix;
}

/**
 * Narrow a comma-separated Touches string's bare-package-root prefixes using file paths
 * named in the item's spec text. See `narrowOnePrefix`. A no-op when `spec` is absent or a
 * prefix isn't a bare root — existing well-scoped Touches pass through untouched. Runs at
 * fold time (a pure read-model derivation, not a ledger mutation): the raw `item.queued`
 * event keeps whatever the conductor declared; only the projected `rec.touches` used for
 * dispatch scheduling narrows. That also means already-logged choked items self-heal the
 * moment this ships — no backfill needed.
 */
export function narrowQueuedTouches(touches: string, spec: string | undefined): string {
  if (!spec) return touches;
  return touches.split(',').map(s => s.trim()).filter(Boolean)
    .map(p => narrowOnePrefix(p, spec))
    .join(',');
}

/**
 * Parse a review.verdict event's data into the folded judgeVerdict shape.
 * Captures the quality signals (specSatisfied/scopeCreep/testTheatre) alongside
 * verdict+confidence so the acceptance overseer gate can key on them. Enum fields that
 * are absent or unrecognized fold to undefined (treated as 'unknown' downstream).
 * Returns undefined when the core verdict/confidence fields are missing or invalid.
 */
function parseJudgeVerdict(
  d: Record<string, unknown>,
  ts: string,
): NonNullable<ItemRecord['judgeVerdict']> | undefined {
  const v = d['verdict'];
  const c = d['confidence'];
  // TRUST-HARDENING: 'unavailable' (a judge attempt that never produced a usable verdict) folds
  // like the other verdicts so the acceptance classifier can floor it at 'review'.
  if ((v !== 'pass' && v !== 'fail' && v !== 'unparseable' && v !== 'unavailable') || typeof c !== 'number') {
    return undefined;
  }
  const spec = d['specSatisfied'];
  const scope = d['scopeCreep'];
  const theatre = d['testTheatre'];
  return {
    verdict: v,
    confidence: c,
    specSatisfied:
      spec === 'yes' || spec === 'partial' || spec === 'no' || spec === 'unknown' ? spec : undefined,
    scopeCreep:
      scope === 'none' || scope === 'minor' || scope === 'major' || scope === 'unknown' ? scope : undefined,
    testTheatre:
      theatre === 'none' || theatre === 'suspected' || theatre === 'unknown' ? theatre : undefined,
    at: ts,
  };
}

/**
 * Extract item.parked's optional escalation payload (leader-leader doctrine — "escalate with
 * intent, never a bare question"). Fail-soft/lenient like every other park field: any shape
 * that isn't a plain object with all four fields as non-empty strings folds to `undefined`
 * (never a partially-filled block) so the desk's fallback-to-rawReason path is a clean
 * either/or, not a half-populated render.
 */
function parseEscalation(d: Record<string, unknown>): ItemRecord['escalation'] {
  const raw = d['escalation'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const intent = typeof r['intent'] === 'string' ? r['intent'] : '';
  const evidence = typeof r['evidence'] === 'string' ? r['evidence'] : '';
  const risk = typeof r['risk'] === 'string' ? r['risk'] : '';
  const recommendation = typeof r['recommendation'] === 'string' ? r['recommendation'] : '';
  if (!intent || !evidence || !risk || !recommendation) return undefined;
  return { intent, evidence, risk, recommendation };
}

/**
 * TRUST-HARDENING: fold the actual-diff merge evidence from an item.merged event onto the record.
 * Additive and fail-soft: any field absent or wrong-typed is simply left unset (legacy merges and
 * no-code merges carry none). `changedFiles` is kept as a string[] for the acceptance classifier.
 */
function foldMergeEvidence(rec: ItemRecord, d: Record<string, unknown>): void {
  if (typeof d['baseSha'] === 'string') rec.mergeBaseSha = d['baseSha'];
  if (typeof d['headSha'] === 'string') rec.mergeHeadSha = d['headSha'];
  if (Array.isArray(d['changedFiles'])) {
    rec.mergeChangedFiles = d['changedFiles'].filter((x): x is string => typeof x === 'string');
  }
  if (d['changedFilesTruncated'] === true) rec.mergeChangedFilesTruncated = true;
  if (typeof d['gateCommand'] === 'string') rec.mergeGateCommand = d['gateCommand'];
  const cert = parseCertification(d);
  if (cert) rec.mergeCertification = cert;
}

/**
 * Extract item.merged's optional certification payload (leader-leader doctrine — "a
 * certification of understanding, not an assertion of completion"). All-or-nothing like
 * {@link parseEscalation}: any shape that isn't a plain object with all three fields as
 * non-empty strings folds to `undefined` (never a partially-filled block).
 */
function parseCertification(d: Record<string, unknown>): ItemRecord['mergeCertification'] {
  const raw = d['certification'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const couldBreak = typeof r['couldBreak'] === 'string' ? r['couldBreak'] : '';
  const detection = typeof r['detection'] === 'string' ? r['detection'] : '';
  const rollback = typeof r['rollback'] === 'string' ? r['rollback'] : '';
  if (!couldBreak || !detection || !rollback) return undefined;
  // WI-098: fold the optional portability note alongside the three required fields (additive;
  // absent on every merge predating it). The reactor's portability-promotion step reads it.
  const portability = typeof r['portability'] === 'string' && r['portability'].trim() ? r['portability'] : undefined;
  return { couldBreak, detection, rollback, ...(portability ? { portability } : {}) };
}

function wiNum(id: string): number {
  const m = id.match(/^WI-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function convNum(id: string): number {
  const m = id.match(/^CONV-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Archive the live park fields to their `last*` forensics slots and clear them. Called on
 * EVERY exit-from-parked transition (unpark, approve, merge, accept, reject, re-dispatch) so
 * a non-parked record never carries a stale park label, while history survives.
 * parkClass is cleared too (it is a live park attribute, not forensics-archived — the reactor's
 * auto-approve classifier only reads it while parked).
 */
function clearParkFields(rec: ItemRecord): void {
  if (rec.parkReason !== undefined) rec.lastParkReason = rec.parkReason;
  if (rec.parkKind !== undefined) rec.lastParkKind = rec.parkKind;
  if (rec.storedSpec !== undefined) rec.lastStoredSpec = rec.storedSpec;
  if (rec.escalation !== undefined) rec.lastEscalation = rec.escalation;
  rec.parkReason = undefined;
  rec.parkKind = undefined;
  rec.parkClass = undefined;
  rec.storedSpec = undefined;
  rec.parkFingerprint = undefined;
  rec.parkNovelty = undefined;
  rec.escalation = undefined;
  // WI-084: blockedOn is a park-lifecycle field too (live only while state==='parked', waiting
  // on the repair item) — clear it on every exit-from-parked, same as its siblings above.
  rec.blockedOn = undefined;
}

/** States from which only item.accepted (merged→accepted) or item.reopened may transition;
 *  all other state-changing events are recorded for data but never regress state. */
const TERMINAL_STATES = new Set<ItemState>(['merged', 'rejected', 'accepted', 'answered', 'done']);

/**
 * THE terminal-state predicate (one home — reads the SAME TERMINAL_STATES set the fold uses to
 * no-op late state-changing events). An item is terminal once it has merged/rejected/accepted/
 * answered/done: no build should still be trying to land it. dispatch's terminal path re-checks
 * this under the ledger lock before a second merge, so a stale-claim takeover can never
 * double-deliver an already-shipped item.
 */
export function isItemTerminal(rec: Pick<ItemRecord, 'state'>): boolean {
  return TERMINAL_STATES.has(rec.state);
}

/**
 * Optional fold inputs. The fold stays pure — config never reaches it directly; callers
 * that hold a plane config pass the relevant keys in here.
 */
export interface FoldOptions {
  /**
   * TARGET COALESCING (docs/event-model.md §"Compatibility & migration"): items whose
   * events carry NO target stamp fold with `targetId = defaultTarget` — the plane-level
   * config key the cutover parity check depends on (fold an embedded single-target ledger
   * with `defaultTarget` set to that deployment's name and diff the summaries). The value
   * may be a registered target's id or name (resolved to the id), or — for a legacy ledger
   * with no registration events at all — any literal string, used as the id verbatim.
   */
  defaultTarget?: string;
}

/**
 * Fold a list of events into per-item state and conversations.
 * Events must be sorted by ts ascending.
 * Processes both work-item and conversation addressees.
 */
export function fold(events: LedgerEvent[], opts?: FoldOptions): FoldResult {
  const items = new Map<string, ItemRecord>();
  const conversations = new Map<string, ConversationRecord>();
  const targets = new TargetsProjection();
  const failureCatalog = new Map<string, FailureCatalogEntry>();
  const sessions = new Map<string, SessionRecord>();
  let maxWiNum = 0;
  let maxConvNum = 0;

  function getOrCreateItem(id: string): ItemRecord {
    if (!items.has(id)) {
      const rec = newItem(id);
      items.set(id, rec);
    }
    const n = wiNum(id);
    if (n > maxWiNum) maxWiNum = n;
    return items.get(id)!;
  }

  function getOrCreateConv(id: string): ConversationRecord {
    if (!conversations.has(id)) {
      const rec: ConversationRecord = {
        id,
        state: 'active',
        messages: [],
        spawnedItems: [],
      };
      conversations.set(id, rec);
    }
    const n = convNum(id);
    if (n > maxConvNum) maxConvNum = n;
    return conversations.get(id)!;
  }

  function transition(rec: ItemRecord, state: ItemState, ts: string): void {
    rec.state = state;
    rec.transitions[state] = ts;
  }

  for (const ev of events) {
    // Process both WI-NNN and CONV-NNN addressees. Ops-segment events (loop.beat, slo.breach — keyed 'system')
    // must never materialize a phantom item record.
    const isWi = /^WI-\d+$/.test(ev.item);
    const isConv = /^CONV-\d+$/.test(ev.item);

    // TARGET EXTERNALIZATION (docs/event-model.md §"Register a target"): target.* events are
    // addressed by the target NAME (a global handle), not a WI-/CONV- id, so they are routed
    // here BEFORE the WI/CONV filter. Everything else keyed by a non-WI/CONV item (loop.beat,
    // slo.breach on 'system') still falls through to the `continue` below, exactly as before —
    // this branch only claims the two new event types, so a legacy ledger is unaffected.
    if (ev.type === 'target.registered' || ev.type === 'target.manifest-updated') {
      const td = ev.data as Record<string, unknown>;
      const name = typeof td['name'] === 'string' ? td['name'] : ev.item;
      if (!name) continue;
      const stampedId = typeof td['targetId'] === 'string' && td['targetId'] ? td['targetId'] : undefined;
      if (ev.type === 'target.registered') {
        const repoPath = typeof td['repoPath'] === 'string' ? td['repoPath'] : '';
        // IDENTITY PIN (docs/event-model.md §"Target lifecycle"): repoPath is the stable
        // revival key — re-registering a previously seen repoPath (a rename, an
        // archive-revive) keeps the ORIGINAL targetId, so one project holds one identity
        // forever and a name change never re-mints or fragments history across ids.
        const revived = repoPath ? targets.byRepoPath(repoPath) : undefined;
        // BACK-COMPAT: registration events written before `targetId` existed carry none —
        // synthesize a stable fallback DETERMINISTICALLY from the repoPath (hash-derived,
        // target.ts fallbackTargetId) so a legacy ledger folds the same target to the same
        // id on every replay, with no ledger rewrite. Because the fallback derives from the
        // same key revival pins on, legacy re-registrations converge on one id too.
        const targetId = revived?.targetId ?? stampedId ?? fallbackTargetId(repoPath || name);
        targets.set(targetId, {
          targetId,
          name,
          repoPath: repoPath || (revived?.repoPath ?? ''),
          defaultBranch: typeof td['defaultBranch'] === 'string' ? td['defaultBranch'] : 'main',
          manifestHash: typeof td['manifestHash'] === 'string' ? td['manifestHash'] : '',
          registeredAt: revived?.registeredAt ?? ev.ts,
          ...(revived ? { updatedAt: ev.ts } : {}),
        });
      } else {
        // manifest-updated: never mutates the registration, only the hash + updatedAt
        // (append-only). Resolve by the stamped id first; legacy events carry only the name.
        const rec = (stampedId ? targets.byId(stampedId) : undefined) ?? targets.byName(name);
        if (rec) {
          if (typeof td['manifestHash'] === 'string') rec.manifestHash = td['manifestHash'];
          if (typeof td['defaultBranch'] === 'string') rec.defaultBranch = td['defaultBranch'];
          rec.updatedAt = ev.ts;
        }
      }
      continue;
    }

    // SESSION MODE: session.* events are addressed by the sessionId (a global handle, like
    // target.* events by target name), so they are routed here BEFORE the WI/CONV filter.
    // Only these three types are claimed; everything else keyed by a non-WI/CONV item still
    // falls through to the `continue` below, exactly as before.
    if (ev.type === 'session.started' || ev.type === 'session.heartbeat' || ev.type === 'session.ended') {
      const sd = ev.data as Record<string, unknown>;
      const sessionId = typeof sd['sessionId'] === 'string' && sd['sessionId'] ? sd['sessionId'] : ev.item;
      if (!sessionId) continue;
      let ses = sessions.get(sessionId);
      if (!ses) {
        ses = { sessionId };
        sessions.set(sessionId, ses);
      }
      if (ev.type === 'session.started') {
        ses.startedAt = ses.startedAt ?? ev.ts;
        if (typeof sd['source'] === 'string') ses.source = sd['source'];
      } else if (ev.type === 'session.heartbeat') {
        ses.lastHeartbeatAt = ev.ts;
      } else {
        ses.endedAt = ev.ts;
      }
      continue;
    }

    if (!isWi && !isConv) continue;
    const d = ev.data as Record<string, unknown>;

    // Handle CONV-NNN events
    if (isConv) {
      const conv = getOrCreateConv(ev.item);
      switch (ev.type) {
        case 'conv.started':
          conv.createdAt = conv.createdAt ?? ev.ts;
          conv.source = typeof d['source'] === 'string' ? d['source'] : conv.source;
          conv.title = typeof d['title'] === 'string' ? d['title'] : conv.title;
          break;
        case 'conv.promoted': {
          const items = Array.isArray(d['items']) ? d['items'].filter((x: unknown) => typeof x === 'string') : [];
          for (const item of items) {
            if (!conv.spawnedItems.includes(item)) {
              conv.spawnedItems.push(item);
            }
          }
          break;
        }
        case 'conv.closed':
          conv.state = 'closed';
          conv.closedAt = ev.ts;
          break;
        case 'msg.in':
          conv.messages.push({
            ts: ev.ts,
            direction: 'in',
            text: typeof d['text'] === 'string' ? d['text'] : '',
          });
          break;
        case 'msg.out':
          conv.messages.push({
            ts: ev.ts,
            direction: 'out',
            text: typeof d['text'] === 'string' ? d['text'] : '',
          });
          break;
      }
      continue;
    }

    const rec = getOrCreateItem(ev.item);

    // merged is TERMINAL. Once an item has merged, a late state-changing event (a duplicate
    // approval, a stray park/merge, a gate result) is recorded but never regresses the state —
    // messages still thread through below. Rationale: a duplicate item.approved after
    // item.merged once drove the reactor branch-missing path and parked an already-shipped
    // item; a stray item.merged once flipped a building item to merged.
    if (TERMINAL_STATES.has(rec.state)) {
      switch (ev.type) {
        case 'msg.in':
        case 'item.feedback':
          rec.messages.push({
            ts: ev.ts,
            direction: 'in',
            text: typeof d['text'] === 'string' ? d['text'] : '',
          });
          break;
        case 'msg.out':
          rec.messages.push({
            ts: ev.ts,
            direction: 'out',
            text: typeof d['text'] === 'string' ? d['text'] : '',
          });
          break;
        // item.accepted is the one legitimate post-merge transition (acceptance) — only
        // fires from 'merged'; a stray item.accepted on rejected/answered/done is a no-op.
        case 'item.accepted':
          if (rec.state !== 'merged') break;
          transition(rec, 'accepted', ev.ts);
          rec.acceptedAt = ev.ts;
          rec.provisionalAccept = (d['provisional'] === true) ? true : undefined;
          clearParkFields(rec);
          break;
        // item.reopened: the ONE event that transitions any terminal state
        // back to 'queued'. Clears park fields and records who/why for forensics.
        case 'item.reopened':
          transition(rec, 'queued', ev.ts);
          rec.queuedAt = ev.ts;
          rec.reopenedAt = ev.ts;
          rec.reopenedBy = typeof d['by'] === 'string' ? d['by'] : undefined;
          rec.reopenReason = typeof d['reason'] === 'string' ? d['reason'] : undefined;
          clearParkFields(rec);
          break;
        case 'deploy.succeeded':
          rec.deployed = true;
          break;
        case 'deploy.failed':
          rec.deployed = false;
          break;
        case 'item.briefed':
          // Store the scout brief even on already-merged items (latest wins; harmless).
          if (typeof d['brief'] === 'string' && d['brief']) {
            rec.brief = { text: d['brief'], at: ev.ts };
          }
          break;
        case 'review.verdict': {
          // Store judge verdict even on already-merged items (latest wins; advisory only).
          const parsed = parseJudgeVerdict(d, ev.ts);
          if (parsed) rec.judgeVerdict = parsed;
          break;
        }
        // item.certification-amended (ADR-009): the amend verb's precondition (merged/accepted)
        // means this event ALWAYS arrives on an already-terminal item — it must be handled here,
        // not just in the main switch below, or it would silently no-op through the `default`
        // branch. See the main switch's case for the full fail-soft/last-writer-wins doc comment.
        case 'item.certification-amended': {
          const field = d['field'];
          const portability = d['portability'];
          if (field === 'portability' && typeof portability === 'string') {
            rec.mergeCertification = { ...rec.mergeCertification, portability };
          }
          break;
        }
        default:
          // Every other event — including item.approved / item.parked / item.merged /
          // gate.* — is a no-op on an already-terminal item.
          break;
      }
      continue;
    }

    switch (ev.type) {
      case 'item.captured':
        transition(rec, 'captured', ev.ts);
        rec.capturedAt = ev.ts;
        rec.createdAt = rec.createdAt ?? ev.ts;
        rec.sourceText = typeof d['text'] === 'string' ? d['text'] : undefined;
        rec.sensitivity = typeof d['sensitivity'] === 'string' ? d['sensitivity'] : undefined;
        rec.source = typeof d['source'] === 'string' ? d['source'] : rec.source;
        rec.externalRef = typeof d['externalRef'] === 'string' ? d['externalRef'] : rec.externalRef;
        rec.lane = foldLane(d, rec.lane);
        // TARGET EXTERNALIZATION: stamp the target name when the capture carries one. Absent →
        // rec.target stays undefined = legacy build against the plane's own repoRoot.
        rec.target = typeof d['target'] === 'string' ? d['target'] : rec.target;
        // Identity stamp (id, not name) — new captures carry both; legacy captures with only
        // a name are resolved (and unstamped items coalesced) in the post-pass below.
        rec.targetId = typeof d['targetId'] === 'string' ? d['targetId'] : rec.targetId;
        break;

      case 'item.routed': {
        const route = typeof d['route'] === 'string' ? d['route'] : undefined;
        const TERMINAL_ROUTES = new Set(['answer', 'question', 'duplicate', 'merged']);
        if (route && TERMINAL_ROUTES.has(route)) {
          // Terminal classification: item closed without entering the build queue.
          // Transition unconditionally — a terminal route always wins.
          transition(rec, 'answered', ev.ts);
          rec.answeredAt = ev.ts;
          rec.claim = undefined;   // terminal — any claim lease is consumed
        } else if (rec.state === 'captured') {
          // Non-terminal route (conductor/build): only transition from captured to routed.
          // Guard: reactor emits queued then routed for conductor-route items, so we must
          // not regress an already-queued item.
          transition(rec, 'routed', ev.ts);
        }
        rec.routedAt = ev.ts;
        rec.route = route;
        rec.lane = foldLane(d, rec.lane);
        const title = typeof d['title'] === 'string' ? d['title'].trim() : '';
        if (title) rec.title = title;
        break;
      }

      case 'item.queued': {
        transition(rec, 'queued', ev.ts);
        rec.queuedAt = ev.ts;
        rec.spec = typeof d['spec'] === 'string' ? d['spec'] : rec.spec;
        const newTouches = typeof d['touches'] === 'string' ? d['touches']
          : Array.isArray(d['touches']) ? d['touches'].join(',')
          : undefined;
        rec.touches = newTouches ? narrowQueuedTouches(newTouches, rec.spec) : rec.touches;
        rec.model = typeof d['model'] === 'string' ? d['model'] : rec.model;
        rec.effort = typeof d['effort'] === 'string' ? d['effort'] : rec.effort;
        rec.priority = typeof d['priority'] === 'string' ? d['priority'] : rec.priority;
        rec.repairContext = typeof d['repairContext'] === 'string' ? d['repairContext'] : undefined;
        rec.lane = foldLane(d, rec.lane);
        // WI-084: a requeue (with or without a preceding unpark) is the release signal for a
        // pathologist block — the victim is no longer waiting on the repair item.
        rec.blockedOn = undefined;
        break;
      }

      case 'item.parked':
        transition(rec, 'parked', ev.ts);
        rec.parkedAt = ev.ts;
        rec.parkReason = typeof d['reason'] === 'string' ? d['reason']
          : typeof d['parkReason'] === 'string' ? d['parkReason']
          : undefined;
        rec.parkKind = typeof d['parkKind'] === 'string' ? d['parkKind'] : undefined;
        // WI-108 lifetime counters — every park bumps the park count; a decision-kind park
        // additionally bumps the operator-attention count (it reaches the needs-you desk).
        rec.lifetimeParkCount = (rec.lifetimeParkCount ?? 0) + 1;
        if (rec.parkKind === 'decision') {
          rec.lifetimeEscalationCount = (rec.lifetimeEscalationCount ?? 0) + 1;
        }
        // storedSpec is fully specified by THIS event (no gate.parked pairing to preserve,
        // unlike parkClass) — reset every park, like parkReason.
        rec.storedSpec = typeof d['storedSpec'] === 'string' ? d['storedSpec'] : undefined;
        // escalation is likewise fully specified by THIS event — reset every park (absent on
        // a re-park with no escalation supplied, same as storedSpec).
        rec.escalation = parseEscalation(d);
        {
          const fp = computeParkFingerprint(rec.parkReason, rec.parkKind);
          rec.parkFingerprint = fp;
          const entry = failureCatalog.get(fp);
          if (!entry) {
            failureCatalog.set(fp, { count: 1, firstSeenAt: ev.ts, lastSeenAt: ev.ts });
            rec.parkNovelty = 'first-seen';
          } else {
            entry.count += 1;
            entry.lastSeenAt = ev.ts;
            rec.parkNovelty = 'repeat-known';
          }
        }
        rec.claim = undefined;   // queued-consuming transition — the lease is consumed
        // parkClass is NOT touched here: a gate.parked immediately preceding this item.parked
        // in the SAME park sets the class token, and item.parked carries only the human reason —
        // wiping it would destroy the pairing the auto-approve classifier keys on. A STALE
        // class from a PRIOR park cycle is already cleared on exit-from-parked (clearParkFields),
        // so a fresh re-park with no gate.parked starts clean without any wipe here.
        if (rec.currentBuild) {
          rec.builds.push({ ...rec.currentBuild });
          rec.currentBuild = undefined;
        }
        break;

      case 'item.unparked':
        clearParkFields(rec);
        transition(rec, 'queued', ev.ts);
        rec.queuedAt = ev.ts;
        rec.lastUnparkedAt = ev.ts;
        break;

      case 'item.approved':
        transition(rec, 'approved', ev.ts);
        rec.approvedAt = ev.ts;
        clearParkFields(rec);
        break;

      case 'item.rejected':
        transition(rec, 'rejected', ev.ts);
        rec.rejectedAt = ev.ts;
        rec.rejectedBy = typeof d['by'] === 'string' ? d['by'] : undefined;
        clearParkFields(rec);
        rec.claim = undefined;   // terminal — any claim lease is consumed
        break;

      case 'item.merged':
        transition(rec, 'merged', ev.ts);
        rec.claim = undefined;   // terminal — any claim lease is consumed
        rec.mergedAt = ev.ts;
        rec.mergeCommit = typeof d['commit'] === 'string' ? d['commit'] : undefined;
        rec.deployed = typeof d['deployed'] === 'boolean' ? d['deployed'] : undefined;
        foldMergeEvidence(rec, d);
        clearParkFields(rec);
        rec.transientFailCount = 0;
        if (rec.currentBuild) {
          rec.currentBuild.finishedAt = ev.ts;
          rec.builds.push({ ...rec.currentBuild });
          rec.currentBuild = undefined;
        }
        break;

      // item.certification-amended (ADR-009) — the operator's confirmed portability reply.
      // ADDITIVE, NON-transition (mirrors item.escalated/item.blocked): pure annotation onto
      // rec.mergeCertification, safe to fire on a merged/accepted item without racing any other
      // event. Fail-soft: an unknown `field` or non-string `portability` is ignored outright
      // (never throws, never partially applies). Last-writer-wins on re-amendment — a later
      // amendment simply overwrites the prior `portability` string, which is also what gives
      // the reactor's nudge dedup (keyed on `cert.portability` being set) free idempotency.
      case 'item.certification-amended': {
        const field = d['field'];
        const portability = d['portability'];
        if (field !== 'portability' || typeof portability !== 'string') break;
        rec.mergeCertification = { ...rec.mergeCertification, portability };
        break;
      }

      case 'item.accepted':
        transition(rec, 'accepted', ev.ts);
        rec.acceptedAt = ev.ts;
        rec.provisionalAccept = (d['provisional'] === true) ? true : undefined;
        clearParkFields(rec);
        rec.claim = undefined;   // terminal — any claim lease is consumed
        break;

      // item.reopened only means something transitioning OUT of a terminal state (see the
      // TERMINAL_STATES guard above) — arriving on a non-terminal (e.g. queued/building)
      // record is a harmless no-op.
      case 'item.reopened':
        break;

      // item.escalated — run-control flag (console parity): records who/when but never calls
      // transition(), so it is safe to fire on a live 'building' item without racing the
      // worker's own terminal build/gate/merge events.
      case 'item.escalated':
        rec.escalatedAt = ev.ts;
        rec.escalatedBy = typeof d['by'] === 'string' ? d['by'] : undefined;
        // WI-108 operator-attention count: an explicit escalation reaches the operator (alongside
        // decision-kind parks, counted in item.parked). This case never calls transition() so it
        // fires safely on any state, including a late escalate on a live 'building' item.
        rec.lifetimeEscalationCount = (rec.lifetimeEscalationCount ?? 0) + 1;
        break;

      // item.blocked — WI-084 park pathologist: the victim is blocked on a repair WI.
      // ADDITIVE, NON-transition — mirrors item.escalated exactly (never calls transition(),
      // so it is safe to fire on a parked item without racing its own park/unpark events).
      // Fold unconditionally, like escalated; it is only meaningful while the item is parked,
      // but recording it regardless is harmless and keeps this case as simple as its sibling.
      case 'item.blocked':
        rec.blockedOn = typeof d['onItem'] === 'string' ? d['onItem'] : undefined;
        break;

      case 'item.feedback':
        // Feedback doesn't change state
        rec.messages.push({
          ts: ev.ts,
          direction: 'in',
          text: typeof d['text'] === 'string' ? d['text'] : '',
        });
        break;

      case 'msg.in':
        rec.messages.push({
          ts: ev.ts,
          direction: 'in',
          text: typeof d['text'] === 'string' ? d['text'] : '',
        });
        break;

      case 'msg.out':
        rec.messages.push({
          ts: ev.ts,
          direction: 'out',
          text: typeof d['text'] === 'string' ? d['text'] : '',
        });
        break;

      case 'build.dispatched': {
        const attempt = typeof d['attempt'] === 'number' ? d['attempt'] : rec.attempts + 1;
        rec.attempts = Math.max(rec.attempts, attempt);
        const build: ItemBuild = {
          attempt,
          pid: typeof d['pid'] === 'number' ? d['pid'] : undefined,
          pgid: typeof d['pgid'] === 'number' ? d['pgid'] : undefined,
          worktree: typeof d['worktree'] === 'string' ? d['worktree'] : undefined,
          branch: typeof d['branch'] === 'string' ? d['branch'] : undefined,
          provider: typeof d['provider'] === 'string' ? d['provider'] : undefined,
          model: typeof d['model'] === 'string' ? d['model'] : undefined,
          dispatchedAt: ev.ts,
        };
        rec.currentBuild = build;
        transition(rec, 'building', ev.ts);
        rec.buildingAt = ev.ts;
        clearParkFields(rec);
        rec.claim = undefined;   // queued-consuming transition — the lease is consumed
        break;
      }

      case 'build.finished':
        if (rec.currentBuild) {
          rec.currentBuild.finishedAt = ev.ts;
        }
        transition(rec, 'gated', ev.ts);
        rec.gatedAt = ev.ts;
        break;

      // build.crashed (dead PID) and build.stalled (alive-but-no-progress) fold
      // identically — archive the build and return the item to 'queued'. The doctor pairs
      // each with a following item.queued (requeue) or item.parked (breaker) that sets the
      // final state; the reason string distinguishes them on the build record / board.
      case 'build.crashed':
      case 'build.stalled':
        rec.lifetimeCrashCount = (rec.lifetimeCrashCount ?? 0) + 1;  // WI-108 lifetime counter
        if (rec.currentBuild) {
          rec.currentBuild.crashedAt = ev.ts;
          rec.currentBuild.crashReason = typeof d['reason'] === 'string' ? d['reason'] : undefined;
          rec.currentBuild.stderrTail = typeof d['stderrTail'] === 'string' ? d['stderrTail'] : undefined;
          rec.currentBuild.errorFingerprint =
            rec.currentBuild.stderrTail !== undefined
              ? computeErrorFingerprint(rec.currentBuild.stderrTail)
              : undefined;
          rec.builds.push({ ...rec.currentBuild });
          rec.currentBuild = undefined;
        }
        transition(rec, 'queued', ev.ts);
        rec.queuedAt = ev.ts;
        break;

      // build.superseded: audit-only. Only ever appended when the item is ALREADY terminal (a
      // stale-claim takeover let a detached dispatch build finish after an attended session
      // merged) — so it normally hits the terminal-state guard above and never reaches here. A
      // no-op in the main switch too: it must never regress a non-terminal item's state.
      case 'build.superseded':
        break;

      // build.cancel-requested: a pure ledger write from the console's Stop verb. Recorded on
      // the thread (via the composer's msg.in, appended alongside it by the route handler) but
      // never itself a state transition — the dispatch beat's cancel poll and pre-dispatch check
      // read the raw event stream for unconsumed cancel-requested events, not this fold field.
      case 'build.cancel-requested':
        break;

      // build.cancelled — state-guarded (run-controls contract non-negotiable): only acts when
      // the item is currently 'building' AND the event's attempt matches currentBuild.attempt.
      // A late/duplicate cancelled event on any other state, or targeting a superseded attempt,
      // is a no-op — it must never regress a merged/gated/queued item back to parked. Deliberate
      // stop ⇒ archive the build and park `hold` (no auto-requeue), distinct from build.crashed's
      // return-to-queued.
      case 'build.cancelled': {
        const targetAttempt = typeof d['attempt'] === 'number' ? d['attempt'] : undefined;
        if (rec.state !== 'building' || !rec.currentBuild) break;
        if (targetAttempt !== undefined && rec.currentBuild.attempt !== targetAttempt) break;
        rec.currentBuild.crashedAt = ev.ts;
        rec.currentBuild.crashReason = 'cancelled by operator';
        rec.builds.push({ ...rec.currentBuild });
        rec.currentBuild = undefined;
        transition(rec, 'parked', ev.ts);
        rec.parkedAt = ev.ts;
        rec.parkReason = 'stopped by operator';
        rec.parkKind = 'hold';
        break;
      }

      case 'gate.passed':
        transition(rec, 'gated', ev.ts);
        rec.gatedAt = ev.ts;
        break;

      case 'gate.failed':
        transition(rec, 'parked', ev.ts);
        rec.parkedAt = ev.ts;
        rec.lifetimeGateRedCount = (rec.lifetimeGateRedCount ?? 0) + 1;  // WI-108 lifetime counter
        rec.parkReason = typeof d['reason'] === 'string' ? d['reason'] : 'gate.failed';
        if (rec.currentBuild) {
          rec.builds.push({ ...rec.currentBuild });
          rec.currentBuild = undefined;
        }
        break;

      case 'gate.parked':
        transition(rec, 'parked', ev.ts);
        rec.parkedAt = ev.ts;
        rec.lifetimeGateRedCount = (rec.lifetimeGateRedCount ?? 0) + 1;  // WI-108 lifetime counter
        // gate.parked.reason carries the park CLASS token ('touches-overstep' | 'spine');
        // record it separately from parkReason, which the following item.parked overwrites
        // with the human-readable detail. The auto-approve classifier keys on this.
        rec.parkClass = typeof d['reason'] === 'string' ? d['reason'] : rec.parkClass;
        rec.parkReason = typeof d['reason'] === 'string' ? d['reason'] : 'gate.parked';
        if (rec.currentBuild) {
          rec.builds.push({ ...rec.currentBuild });
          rec.currentBuild = undefined;
        }
        break;

      case 'merge.transient-fail':
        // Transient merge failure (push non-FF, worktree setup, master unresolvable).
        // Reactor-lane items stay 'approved' — the reactor re-picks them next beat
        // automatically. Dispatch-lane items sit in 'gated', which dispatch's picker never
        // re-scans, so dispatch pairs this event with an explicit item.queued to make the
        // item pickable again; this event alone never changes state.
        rec.transientFailCount = (rec.transientFailCount ?? 0) + 1;
        rec.lastTransientError = typeof d['reason'] === 'string' ? d['reason'] : 'unknown';
        break;

      case 'deploy.succeeded':
        rec.deployed = true;
        break;

      case 'deploy.failed':
        rec.deployed = false;
        break;

      // item.respec — an operator reply steered the work; amend the spec in place.
      // NOT a state transition on its own — the reactor pairs it with an item.queued that
      // does the transition (a parked/queued item re-enters the build queue with the new spec).
      // The paired msg.out carries the reason onto the trail. On terminal (merged) items this is
      // unreachable — the merged guard above no-ops it — so steering finished work never regresses
      // an item (the reactor downgrades such a steer to a sibling capture instead).
      case 'item.respec':
        rec.spec = typeof d['spec'] === 'string' ? d['spec'] : rec.spec;
        break;

      // SESSION MODE — item.claimed leases a queued item to an attended session; never a
      // state transition (the item stays 'queued'; the beats defer via isClaimActive at
      // read time). A re-claim by the same session renews the lease (latest event wins).
      case 'item.claimed': {
        const sessionId = typeof d['sessionId'] === 'string' && d['sessionId'] ? d['sessionId'] : undefined;
        if (sessionId) {
          const ttl = typeof d['ttlMinutes'] === 'number' && d['ttlMinutes'] > 0
            ? d['ttlMinutes'] : DEFAULT_CLAIM_TTL_MINUTES;
          rec.claim = { sessionId, claimedAt: ev.ts, ttlMinutes: ttl };
        }
        break;
      }

      // item.released — the claim returns to the shared queue; never a state transition.
      case 'item.released':
        rec.claim = undefined;
        break;

      // item.briefed — stores the scout context pack without changing state (latest wins)
      case 'item.briefed':
        if (typeof d['brief'] === 'string' && d['brief']) {
          rec.brief = { text: d['brief'], at: ev.ts };
        }
        break;

      // review.finding: no-op (future slot)
      case 'review.finding':
        break;

      // review.verdict (judge): store latest verdict; NEVER a state transition.
      case 'review.verdict': {
        const parsed = parseJudgeVerdict(d, ev.ts);
        if (parsed) rec.judgeVerdict = parsed;
        break;
      }

      // diagnosis.recorded — WI-084 park pathologist verdict for one park EVENT. NEVER a state
      // transition by itself (the reactor's stepPathology follows it with the state-changing
      // event `actedAs` implies). Sets the dedup marker + bumps the own-code failure counter.
      case 'diagnosis.recorded': {
        const fp = typeof d['parkFingerprint'] === 'string' ? d['parkFingerprint'] : undefined;
        if (fp) rec.lastDiagnosedFingerprint = fp;
        if (d['classification'] === 'items-own-code') {
          rec.ownCodeFailures = (rec.ownCodeFailures ?? 0) + 1;
        }
        break;
      }

      // ops events don't change item state
      case 'slo.breach':
      case 'cost.usage':
      case 'loop.beat':
        break;

      default:
        // Unknown event type — preserve item but don't change state (forward-compatible)
        break;
    }
  }

  // ── TARGET-ID resolution + null-target coalescing (post-pass) ─────────────────────────
  // Identity/attribution ONLY, never routing: rec.target (the NAME field the beats key the
  // target lane on) is left exactly as the events stamped it, so a ledger folded with a
  // defaultTarget builds byte-identically to one folded without. Resolution order per item:
  //   1. explicit targetId stamped on the item's events (folded above)
  //   2. the item's target NAME resolved against the registered targets
  //   3. opts.defaultTarget — a registered target's id/name (resolved to the id), else the
  //      literal value verbatim (the legacy-ledger upgrade path: the cutover parity check
  //      folds an embedded ledger, which has no registration events, with defaultTarget set
  //      to that deployment's name — docs/event-model.md §"Compatibility & migration")
  //   4. the sole registered target, when exactly one exists
  //   5. undefined — an ambiguous multi-target ledger with no default stays unstamped.
  const soleTarget = targets.size === 1 ? [...targets.values()][0] : undefined;
  const defaultTargetRec = opts?.defaultTarget ? targets.get(opts.defaultTarget) : undefined;
  for (const rec of items.values()) {
    if (!rec.targetId && rec.target) rec.targetId = targets.byName(rec.target)?.targetId;
    if (!rec.targetId) {
      if (opts?.defaultTarget) rec.targetId = defaultTargetRec?.targetId ?? opts.defaultTarget;
      else if (soleTarget) rec.targetId = soleTarget.targetId;
    }
  }

  return { items, conversations, targets, maxWiNum, maxConvNum, failureCatalog, sessions };
}

/**
 * Allocate the next WI id from the fold result.
 */
export function nextWiId(result: FoldResult): string {
  return `WI-${String(result.maxWiNum + 1).padStart(3, '0')}`;
}

/**
 * Allocate the next CONV id from the fold result.
 */
export function nextConvId(result: FoldResult): string {
  return `CONV-${String(result.maxConvNum + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Acceptance debt
// ---------------------------------------------------------------------------

const ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Acceptance debt = merged items still awaiting the operator's test. A slice that
 * has merged but has no `item.accepted` sits in `merged` state (accepting it is
 * the one legit post-merge transition → `accepted`), so the debt is exactly the
 * still-`merged` items, windowed to the last `windowMs` by merge time.
 *
 * ONE derivation feeds two consumers: the reactor's acceptance SLO probe (so its
 * nudge runbook can fire) and dev-brief's accept-debt line.
 */
export function computeAcceptanceDebt(
  result: FoldResult,
  nowMs: number,
  windowMs: number = ACCEPTANCE_WINDOW_MS,
): { acceptanceCount: number; oldestAcceptanceHours: number | undefined } {
  let acceptanceCount = 0;
  let oldestAcceptanceHours: number | undefined;
  for (const rec of result.items.values()) {
    if (rec.state !== 'merged' || !rec.mergedAt) continue;
    const mergedMs = new Date(rec.mergedAt).getTime();
    if (isNaN(mergedMs) || nowMs - mergedMs >= windowMs) continue;
    acceptanceCount += 1;
    const ageH = (nowMs - mergedMs) / 3_600_000;
    oldestAcceptanceHours = oldestAcceptanceHours === undefined
      ? ageH : Math.max(oldestAcceptanceHours, ageH);
  }
  return { acceptanceCount, oldestAcceptanceHours };
}

// ---------------------------------------------------------------------------
// Session-mode claim lease (one predicate)
// ---------------------------------------------------------------------------

/**
 * Expected attended-session heartbeat cadence. The conductor beats between items (and the
 * operator can `session beat` manually); a session silent for longer than ~3× this cadence
 * is treated as dead and its claims stop deferring the beats (dead-man release — computed,
 * never mutated: the claims simply read as inactive from then on).
 */
export const SESSION_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** Dead-man staleness bound: heartbeat older than this ⇒ the session no longer holds claims. */
export const SESSION_HEARTBEAT_STALE_MS = 3 * SESSION_HEARTBEAT_INTERVAL_MS;

/**
 * THE session-liveness predicate (one home). A session is ALIVE iff it has started, has not
 * ended, and its last signal (heartbeat, else start) is fresher than SESSION_HEARTBEAT_STALE_MS
 * (dead-man: a crashed session reads as dead the moment its heartbeat goes stale — computed,
 * never mutated). Both isClaimActive (does this lease still defer the beats?) and planeMode
 * (is an operator attached right now?) route through this ONE check so the console badge and the
 * dispatch picker can never disagree on whether a session is live.
 */
export function isSessionActive(
  ses: Pick<SessionRecord, 'endedAt' | 'lastHeartbeatAt' | 'startedAt'> | undefined,
  nowMs: number,
): boolean {
  if (!ses || ses.endedAt !== undefined) return false;               // absent/ended session
  const lastSignal = ses.lastHeartbeatAt ?? ses.startedAt;
  if (!lastSignal) return false;
  const lastMs = Date.parse(lastSignal);
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs <= SESSION_HEARTBEAT_STALE_MS;               // dead-man freshness
}

/**
 * THE plane execution mode (attended vs. away dual-mode), derived — never stored. 'attended' iff any session
 * is live (isSessionActive): an operator is at the machine, so CLI intents are handled by the
 * attended conductor and the away beats defer to its claims. Otherwise 'away': the background
 * reactor/dispatch beats run autonomously. Mode-switching is just session events (start/end +
 * the dead-man), so this reads the current truth straight off the fold with no config knob.
 */
export function planeMode(sessions: Map<string, SessionRecord>, nowMs: number): 'attended' | 'away' {
  for (const ses of sessions.values()) if (isSessionActive(ses, nowMs)) return 'attended';
  return 'away';
}

/**
 * THE claim-lease predicate (one home — mirrors isDecisionPark's one-predicate doctrine).
 * A claim is ACTIVE — i.e. the away beats must defer this item to the attended session — iff:
 *   1. the item carries a live claim (fold-cleared on release and on every consuming transition),
 *   2. the claim's ttl is unexpired at `nowMs`, and
 *   3. the claiming session is alive: started, not ended, and its last signal (heartbeat, else
 *      start) is fresher than SESSION_HEARTBEAT_STALE_MS (dead-man: a crashed session's stale
 *      heartbeat auto-releases every claim back to the shared queue, no mutation needed).
 * Every consumer — the dispatch/reactor pick filters, the conductor, projections — MUST use
 * this ONE predicate; a second implementation is how two lanes come to disagree on one lease.
 */
export function isClaimActive(
  rec: Pick<ItemRecord, 'claim'>,
  sessions: Map<string, SessionRecord>,
  nowMs: number,
): boolean {
  const claim = rec.claim;
  if (!claim) return false;
  const claimedMs = Date.parse(claim.claimedAt);
  if (!Number.isFinite(claimedMs)) return false;
  if (nowMs - claimedMs > claim.ttlMinutes * 60_000) return false;   // lease expired
  return isSessionActive(sessions.get(claim.sessionId), nowMs);      // unknown/ended/stale ⇒ inactive
}

/**
 * THE decision-park predicate (one home). An item is an operator-facing decision park iff it
 * is currently parked AND its parkKind is 'decision'. Every consumer (needs-you desk, phone
 * notify, decisions SLO probe, dev-brief) MUST use this ONE predicate. Mechanical/infra parks
 * (parkKind 'ops'/'hold'/'decomposition'/absent) are deliberately NOT decision parks.
 */
export function isDecisionPark(rec: Pick<ItemRecord, 'state' | 'parkKind'>): boolean {
  return rec.state === 'parked' && rec.parkKind === 'decision';
}

/**
 * THE held-park predicate (one home) — companion to isDecisionPark. An item is "held" iff it
 * is parked with the operator-owned 'hold' kind (an explicit console Stop or Hold verb; see
 * verbs.ts stopBuild/holdItem). Every consumer that needs to offer the Resume run-control verb
 * MUST use this ONE predicate rather than re-deriving `parkKind === 'hold'`.
 */
export function isHeldPark(rec: Pick<ItemRecord, 'state' | 'parkKind'>): boolean {
  return rec.state === 'parked' && rec.parkKind === 'hold';
}

/**
 * THE ops-park predicate (one home) — everything parked that is neither an operator decision
 * park nor an operator hold: 'ops'/'decomposition'/absent parkKind, i.e. a park the plane owns
 * mechanically. Every consumer that needs to offer the Requeue-now/Dismiss run-control verbs
 * MUST use this ONE predicate.
 */
export function isOpsPark(rec: Pick<ItemRecord, 'state' | 'parkKind'>): boolean {
  return rec.state === 'parked' && !isDecisionPark(rec) && !isHeldPark(rec);
}

/**
 * THE novelty predicate (failure catalog): true when the item's LIVE park is either a fresh
 * fingerprint (absent parkNovelty predates this feature — treated as first-seen so old ledgers
 * keep paging) or explicitly tagged 'first-seen'. Gates phone-push/desk-push surfacing only —
 * it is orthogonal to isDecisionPark (parkKind still owns routing/lifecycle).
 */
export function isFirstSeenPark(rec: Pick<ItemRecord, 'parkNovelty'>): boolean {
  return rec.parkNovelty !== 'repeat-known';
}

/**
 * THE interim-status predicate: true in the narrow window between an operator verb landing
 * (item.approved / item.unparked) and the reactor's follow-up state (item.merged for an
 * approval; a fresh dispatch off item.queued for an unpark). 'approved' is always this
 * window — its only exits are item.merged/item.rejected, never a further intermediate state.
 * 'queued' only counts when the queued state is the DIRECT result of the most recent unpark —
 * `lastUnparkedAt` fresher than `parkedAt` (same freshness check cli.ts's breaker gate already
 * uses) — so an item unparked long ago, later re-parked, and queued again for unrelated reasons
 * does not read as still-routing. `lastUnparkedAt` is never cleared, so once the item advances
 * past 'queued' (building, merged, re-parked, …) this predicate naturally goes false again
 * without any extra bookkeeping.
 */
export function isInterimApprovedStatus(
  rec: Pick<ItemRecord, 'state' | 'lastUnparkedAt' | 'parkedAt'>,
): boolean {
  if (rec.state === 'approved') return true;
  if (rec.state !== 'queued' || !rec.lastUnparkedAt) return false;
  return !rec.parkedAt || rec.lastUnparkedAt > rec.parkedAt;
}

/**
 * Transient ops-park reasons this predicate is allowed to auto-requeue (bounded by
 * `attempts < breakerN`). An ALLOWLIST, not a denylist — only reasons we KNOW are transient and
 * safe to rebuild from a fresh worktree off current main:
 *   - `no-commit:` — the worker exited without committing (dispatch.ts writes this prefix; same
 *     substring the noCommitParkCount24h SLO probe matches).
 *   - `target merge conflict` — the built branch couldn't fast-merge because the target's default
 *     branch moved under it DURING the build (dispatch.ts merge step). A fresh rebuild off the now
 *     -settled main clears it; this was the WI-046-class park that used to sit forever because it
 *     matched no requeue path and no other path requeues it (verified: not doctor.ts, not reactor
 *     merge-gate — those handle orphaned/stalled builds, never this dispatch-time merge park).
 * Terminal/exhausted ops-parks (`breaker: … exhausted`, `thrashing: …`, `merge gate timed out …`,
 * `file:-dep build failed`) are deliberately NOT matched — they are the STOP state, must not loop.
 */
const REQUEUABLE_OPS_PARK_REASON = /^(no-commit:|target merge conflict\b)/i;

/**
 * THE transient ops-park requeue predicate (one predicate/parser). Selects the parkKind:'ops'
 * items the reactor's stepUnparkOpsRequeue is allowed to re-queue, bounded by the breaker.
 */
export function shouldRequeueOpsPark(
  rec: Pick<ItemRecord, 'state' | 'parkKind' | 'parkReason' | 'attempts'>,
  breakerN: number,
): boolean {
  if (rec.state !== 'parked' || rec.parkKind !== 'ops') return false;
  if (!REQUEUABLE_OPS_PARK_REASON.test(rec.parkReason ?? '')) return false;
  return rec.attempts < breakerN;
}

// ---------------------------------------------------------------------------
// Engagement projection
// ---------------------------------------------------------------------------

/** an operator reply on an item thread awaiting the reactor's engagement (post-baseline, unanswered). */
export interface UnansweredReply {
  /** The msg.in event id — the causation key every outcome event references via inReplyTo. */
  evId: string;
  item: string;   // WI-NNN
  text: string;
  ts: string;
}

export interface EngagementProjection {
  /** Earliest engagement.baseline event ts (undefined ⇒ feature dormant, nothing engaged). */
  baselineTs: string | undefined;
  /** Post-baseline operator replies with no outcome event referencing them (the reactor's work-list). */
  unanswered: UnansweredReply[];
  /**
   * Items whose auto-acceptance is held: an item with an unanswered post-baseline reply
   * (agent's turn), OR an open verdict/unpark proposal (msg.out proposal:true)
   * with no later confirming verb (accept/reject/approve). Cleared once the reply is answered and
   * no proposal is pending; re-armed by any newer msg.in. Maps id → ISO ts of when the hold
   * began (earliest unanswered-reply ts, or the proposal ts for proposal-holds) — a Map so
   * consumers can surface hold age, not just membership; `.has()` still works for callers that
   * only need the boolean check.
   */
  heldItems: Map<string, string>;
}

const WI_RE = /^WI-\d+$/;

/**
 * Project the engagement work-list and the hold set in ONE pass over the raw event
 * stream (single-pass keeps the hold read consistent with the reply read — a reply landing
 * mid-beat is either visible to both or neither, never a torn view). Replay-safe and
 * deterministic: derives everything from events, no wall-clock, no external watermark.
 *
 * Answered = referenced by any event's `inReplyTo` (every engagement outcome carries it), so
 * dedupe is idempotent — a re-picked reply that was already answered is dropped here.
 */
export function projectEngagement(events: LedgerEvent[]): EngagementProjection {
  // Baseline = earliest engagement.baseline ts. Absent ⇒ dormant (engage nothing) — the deploy
  // ritual appends the baseline; only replies strictly after it are ever engaged.
  let baselineTs: string | undefined;
  const answered = new Set<string>();
  for (const ev of events) {
    if (ev.type === 'engagement.baseline') {
      if (baselineTs === undefined || ev.ts < baselineTs) baselineTs = ev.ts;
    }
    const irt = (ev.data as Record<string, unknown>)['inReplyTo'];
    if (typeof irt === 'string' && irt) answered.add(irt);
  }

  const unanswered: UnansweredReply[] = [];
  if (baselineTs !== undefined) {
    for (const ev of events) {
      if (ev.type !== 'msg.in' || !WI_RE.test(ev.item)) continue;
      if (!(ev.ts > baselineTs)) continue;      // at/before baseline ⇒ legacy-unresolved
      if (answered.has(ev.id)) continue;         // already answered ⇒ deduped
      const d = ev.data as Record<string, unknown>;
      unanswered.push({
        evId: ev.id,
        item: ev.item,
        text: typeof d['text'] === 'string' ? d['text'] : '',
        ts: ev.ts,
      });
    }
  }

  const heldItems = new Map<string, string>();
  // unanswered reply ⇒ agent's turn, hold — the EARLIEST reply ts is the hold onset.
  for (const r of unanswered) {
    const prev = heldItems.get(r.item);
    if (!prev || r.ts < prev) heldItems.set(r.item, r.ts);
  }

  // Open-proposal hold: a verdict/unpark proposal (msg.out proposal:true) holds the item until a
  // confirming verb (accept/reject/approve) lands after it. Only pre-terminal proposals matter to
  // the accept step (it evaluates 'merged' items), but computing over all items is harmless.
  const lastProposalTs = new Map<string, string>();
  const lastConfirmTs = new Map<string, string>();
  for (const ev of events) {
    if (!WI_RE.test(ev.item)) continue;
    const d = ev.data as Record<string, unknown>;
    if (ev.type === 'msg.out' && d['proposal'] === true) {
      const prev = lastProposalTs.get(ev.item);
      if (!prev || ev.ts > prev) lastProposalTs.set(ev.item, ev.ts);
    } else if (ev.type === 'item.accepted' || ev.type === 'item.rejected' || ev.type === 'item.approved') {
      const prev = lastConfirmTs.get(ev.item);
      if (!prev || ev.ts > prev) lastConfirmTs.set(ev.item, ev.ts);
    }
  }
  for (const [item, propTs] of lastProposalTs) {
    const confirmTs = lastConfirmTs.get(item);
    if (!confirmTs || confirmTs < propTs) {
      const prev = heldItems.get(item);
      if (!prev || propTs < prev) heldItems.set(item, propTs);
    }
  }

  return { baselineTs, unanswered, heldItems };
}
