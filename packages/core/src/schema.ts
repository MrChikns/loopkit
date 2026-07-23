/**
 * schema.ts — Event envelope and initial type set for the loopkit ledger.
 *
 * Envelope: { id, ts, actor, item, type, data, v? }
 * Unknown event types are preserved by the fold (forward-compatible).
 * Hand-rolled validation; zero runtime dependencies.
 */

/**
 * Ledger envelope schema version, stamped on every event `makeEvent` constructs (the one
 * construction path — every appendEvent call site funnels through it). Absent `v` on an
 * existing ledger line means version 1 (legacy ledgers predate this field; no reclassification
 * needed). Bump only alongside an actual envelope shape change, with a migration note here —
 * this is not speculative migration machinery, just the version marker doctrine requires before
 * public ledgers proliferate.
 */
export const LEDGER_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// ULID-like id generation (hand-rolled, no deps)
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(n: bigint, width: number): string {
  let s = '';
  for (let i = 0; i < width; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

let lastMs = 0n;
let seq = 0n;

/** Generate a monotonic ULID-like id string. */
export function newId(): string {
  const now = BigInt(Date.now());
  if (now === lastMs) {
    seq += 1n;
  } else {
    lastMs = now;
    seq = 0n;
  }
  // 10 chars timestamp (48-bit ms) + 16 chars (80 bits) making the id MONOTONIC within a ms:
  // the per-ms sequence occupies the HIGH 30 bits so same-ms ids sort in creation order, and
  // 50 random low bits keep them unique. The sequence MUST dominate the random term (not be
  // added to it) so the ledger's id-tiebreak is deterministic. Consumers only ever compare ids
  // for equality/ordering, never parse the low bits.
  const rand = BigInt(Math.floor(Math.random() * 2 ** 30)) & ((1n << 50n) - 1n);
  const randPart = ((seq & ((1n << 30n) - 1n)) << 50n) | rand;
  return 'ev-' + encodeBase32(now, 10) + encodeBase32(randPart & ((1n << 80n) - 1n), 16);
}

// ---------------------------------------------------------------------------
// Event data shapes
// ---------------------------------------------------------------------------

export type Sensitivity = 'public' | 'internal' | 'private';

/**
 * Delivery lane. A lane is a workflow config — {worker, gate, delivery, publish-boundary} —
 * over the one ledger, NOT a role or identity. The router assigns a lane from intent signals; absent =
 * 'engineering' (the reference lane), which is why every existing/historical event without this
 * field folds to 'engineering' with zero reclassification. Kept a bare `string` — new lanes are
 * config rows, not enum edits.
 */
export const DEFAULT_LANE = 'engineering';

// item domain
export interface ItemCapturedData {
  source: string;
  text: string;
  attachments?: string[];
  sensitivity?: Sensitivity;
  /** Delivery lane. Absent → 'engineering'. See DEFAULT_LANE. */
  lane?: string;
  /**
   * TARGET EXTERNALIZATION (docs/event-model.md §"Capture intent against a target"): the
   * registered target name this item builds against. OPTIONAL — absent = legacy mode, the item
   * builds against the plane's own repoRoot exactly as before targets existed. Stamped by
   * `loopctl new` when exactly one target is registered (or via `--target <name>`). Every
   * downstream event inherits the item's target via the fold, not by re-stamping the field.
   */
  target?: string;
  /**
   * Opaque stable target id (see TargetRegisteredData.targetId) — the identity stamp that
   * survives target renames. New captures stamp BOTH `targetId` and `target` (the mutable
   * display name, kept alongside for display/back-compat); the fold resolves legacy captures
   * that carry only the name against the registered targets.
   */
  targetId?: string;
  /** Secondary legacy source-id ref (older ledgers may carry externally-captured source ids). */
  externalRef?: string;
  /**
   * Stable armed-id of the self-arming predicate that fired this capture. Present
   * only on reactor-armed captures; it is the once-ever dedup key (a predicate whose id
   * already appears on an item.captured never re-fires). See armed.ts.
   */
  armedId?: string;
  /** The conversation id this item was born from (optional; items without a conversation stay legal). */
  convRef?: string;
  /** The item id this item is a sibling of (a tangent spun off an item thread — never spec bloat). */
  parentItem?: string;
  /**
   * The operator msg.in event id that spawned this capture (a sibling-spawn engagement
   * outcome). Carries causation so the reply is deduped — the engagement projection treats the
   * reply as answered once any event references it via inReplyTo.
   */
  inReplyTo?: string;
}
export interface ItemRoutedData {
  route: string;
  reply: string;
  /** Provider used for this routing (attributability for degraded routings). */
  provider?: string;
  /** Model alias used for this routing */
  model?: string;
  /** True when the provider lacked tool support (degraded routing path) */
  degraded?: boolean;
  /** Delivery lane the router assigned. Absent → 'engineering'. See DEFAULT_LANE. */
  lane?: string;
  /**
   * Router-stamped short title, 3-5 words. A direct LLM output (TITLE: in the conductor
   * block), not computed server-side. Absent on any routing where the model omitted it —
   * consumers fall back to the deterministic shortTitle() spec/text truncation (see
   * threads-adapter.ts).
   */
  title?: string;
}
export interface ItemQueuedData { spec: string; touches?: string; model?: string; effort?: string; priority?: string; repairContext?: string;
  /** Delivery lane. Absent → 'engineering'. See DEFAULT_LANE. */
  lane?: string;
  /**
   * The operator msg.in event id this queue directly answers, when it is emitted as
   * part of a deterministic approve verb (e.g. the stored-spec dependency-resolved path in
   * cli.ts cmdApprove) rather than via the LLM router. Lets the engagement projection mark the
   * reply answered immediately, so it is never re-picked as an "unanswered" reply for a second,
   * redundant engagement pass.
   */
  inReplyTo?: string;
}
/**
 * 'decision' = this park blocks the queue on an operator decision; counted by the SLO
 * decisions probe and pushed once, and the ONLY kind that reaches the operator needs-you
 * desk. 'ops' = a mechanical/infra failure the plane owns (no-commit, merge conflict,
 * tests-red, infra:*, breaker) — it routes to the health lane and auto-requeues under the
 * breaker, never the operator's desk. 'hold' = a legacy transient/infra park (same
 * non-decision category as 'ops'). 'decomposition' = an already-approved item the classifier
 * can't build because it is a multi-slice epic — it goes to the planner lane, NOT the
 * operator's desk (re-asking an approved item is a bounce). absent / 'ops' / 'hold' /
 * 'decomposition' are never counted or pushed. Old events without parkKind fall back to a
 * substring match on reason to preserve backward-compat.
 */
export type ParkKind = 'decision' | 'ops' | 'hold' | 'decomposition';
/**
 * Leader-leader escalation doctrine ("escalate with intent, never a bare question" —
 * intent-based leadership): the structured payload a park SHOULD carry when it asks an
 * operator to decide something. All four fields optional (back-compat — legacy events may
 * omit this field; a park missing this shape still folds and still renders, just from the
 * raw `reason` string as before).
 */
export interface EscalationPayload {
  /** What the emitter intends to do (the proposed action), stated as an intent, not a question. */
  intent: string;
  /** The evidence/reasoning behind the intent. */
  evidence: string;
  /** The main risk of proceeding (or of the open question itself). */
  risk: string;
  /** What the emitter recommends the operator do. */
  recommendation: string;
}
export interface ItemParkedData {
  reason: string;
  parkKind?: ParkKind;
  /**
   * A build-ready spec, stored verbatim (transcribe-not-transform — never LLM-invented) when
   * this park is a dependency-wait on another in-flight item (the reason names it, e.g.
   * "depends on <item>"). LIVE only while state==='parked' (same lifecycle as
   * parkReason/parkKind) — archived to lastStoredSpec and cleared on exit-from-parked.
   * On operator approve, a stored spec lets the reactor re-verify the dependency deterministically
   * against the fold and queue directly, skipping a second LLM routing call.
   */
  storedSpec?: string;
  /**
   * Advisory novelty tag (failure catalog). The fold derives this deterministically
   * from computeParkFingerprint — emitters may omit it; a supplied value is never trusted over
   * the fold's own derivation (this field exists so emitters CAN carry the reactor's own
   * pre-computed tag through, not so an external source can override the catalog).
   */
  novelty?: 'first-seen' | 'repeat-known';
  /**
   * Escalation-with-intent payload (see {@link EscalationPayload}). Optional for back-compat;
   * LIVE only while state==='parked' — same lifecycle as parkReason/parkKind/storedSpec
   * (archived to lastEscalation and cleared on exit-from-parked).
   */
  escalation?: EscalationPayload;
}
export interface UnparkedData {
  by?: string;
  /** See ItemQueuedData.inReplyTo — same causation/dedupe purpose. */
  inReplyTo?: string;
}
export interface ItemApprovedData {
  by: string;
  /**
   * File paths from a touches-overstep park's file list, captured at approval time
   * (operator or auto-approve). Durable so a later build attempt touching the SAME
   * paths (or same directory) is not re-parked — see dispatch.ts loadApprovedTouches.
   */
  approvedTouches?: string[];
  /** See ItemQueuedData.inReplyTo — same causation/dedupe purpose. */
  inReplyTo?: string;
}
export interface ItemRejectedData {
  by: string;
  /** See ItemQueuedData.inReplyTo — same causation/dedupe purpose. */
  inReplyTo?: string;
}
/** item.reopened: the one event that transitions any terminal state back to 'queued'. */
export interface ItemReopenedData { by: string; reason: string }
/**
 * item.escalated — run-control verb (console parity): the operator flagged a `building` or
 * `queued` item for attention WITHOUT interrupting it — unlike item.parked, this never changes
 * ItemState (see fold.ts), so it is safe to fire on a live build without racing its own
 * terminal events. Purely additive forensics (escalatedAt/escalatedBy).
 */
export interface ItemEscalatedData { by: string; reason?: string }
/**
 * item.blocked — WI-084 park pathologist: the victim item is blocked on a repair WI (a
 * plane-infra-bug the pathologist auto-captured). ADDITIVE, NON-transition — mirrors
 * item.escalated exactly (never calls transition(), safe to fire on a parked item without
 * racing its own state). The victim releases (rec.blockedOn cleared) when the reactor requeues
 * it — see fold.ts item.queued case and clearParkFields; no separate item.unblocked event.
 */
export interface ItemBlockedData {
  /** The WI this item is blocked on (the repair item). */
  onItem: string;
  /** Why (short). */
  reason?: string;
}
/**
 * Leader-leader "certify, don't brief" doctrine (intent-based leadership — "a
 * certification of understanding, not an assertion of completion"). All three fields
 * optional (back-compat — legacy events may omit this field; a merge missing this shape
 * still folds and still renders, the acceptance desk just shows "no certification provided"
 * instead of the three lines).
 */
export interface CertificationPayload {
  /** What could break as a result of this change. */
  couldBreak: string;
  /** The signal that would detect it breaking. */
  detection: string;
  /** The rollback path if it does. */
  rollback: string;
  /**
   * WI-098 — cross-target pattern portability ("harvest portable patterns at boundaries").
   * A free-form note in the shape `"applies to: <target-a>, <target-b> | none"` declaring which
   * OTHER registered targets this change's pattern generalizes to, so the reactor can capture a
   * sibling item there (see reactor.ts stepPortabilityPromotion). OPTIONAL in general (a merge
   * without it still folds and renders), but REQUIRED when the item is ADR-bearing (references a
   * D-NNN / ADR) or an incident-fix — enforced advisorily, not as a hard gate (see
   * {@link isPortabilityRequired}). `none` (or an empty target list) means "nothing generalizes";
   * absent means "the worker didn't consider portability" — the two are deliberately distinct so
   * the grooming bounce can nudge only the latter.
   */
  portability?: string;
}

/**
 * WI-098 — does this item OWE a portability note (certification.portability)? True when the
 * item is ADR-bearing (its spec/text names a `D-NNN` or `ADR-NNN`) or is an incident-fix (repair
 * lane / an incident-shaped spec). Pure/deterministic string test, never an LLM call — the
 * reactor's portability-grooming bounce keys on it, exactly as escalation-grooming keys on
 * readsAsBareQuestion. A false negative just skips the nudge; it never blocks a merge.
 */
export function isPortabilityRequired(fields: { spec?: string; text?: string; lane?: string; repairContext?: string }): boolean {
  const hay = `${fields.spec ?? ''}\n${fields.text ?? ''}`;
  if (/\b(D-\d{2,}|ADR-\d+)\b/.test(hay)) return true;                 // ADR-bearing
  if (fields.repairContext) return true;                              // a repair build (incident-fix)
  if (fields.lane === 'repair') return true;                         // repair lane
  if (/\b(incident|regression|post-?mortem|hotfix)\b/i.test(hay)) return true; // incident-shaped
  return false;
}

/**
 * ADR-009 — result of the single strict portability-note parser (see {@link parsePortabilityTargets}).
 * `targets` is always the best-effort set of syntactically valid target names extracted (lower-cased,
 * deduped) — populated even when `errors` is non-empty, so a tolerant reader (the reactor) can use it
 * as-is. `none` is true only for an explicit "none" body (distinct from an empty/absent note, which
 * is `targets: [], none: false`). `errors` is non-empty whenever the note did not fully conform to
 * the ADR-009 grammar — a strict caller (the amend verb) rejects on any entry.
 */
export interface PortabilityParseResult {
  targets: string[];
  none: boolean;
  errors: string[];
}

const PORTABILITY_TARGET_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * ADR-009 — the ONE validating parser for a certification.portability note (grammar in
 * docs/decisions/ADR-009-portability-completion.md). Strict about shape (empty body is always an
 * error; each comma-separated entry must match `target := [A-Za-z0-9._-]{1,64}`) but TOLERANT about
 * salvage: a malformed entry is recorded in `errors` and simply excluded from `targets`, rather than
 * discarding the whole note — this is what lets the reactor's read stay lenient (it only ever consumes
 * `.targets`, ignoring `.errors`) while the amend verb enforces strictness by checking `.errors`.
 * Registration (is a name an actually-registered target?) is NOT this parser's job — it has no
 * access to the targets registry; that check lives in the verb.
 */
export function parsePortabilityTargets(portability: string | undefined): PortabilityParseResult {
  if (portability === undefined) return { targets: [], none: false, errors: [] };
  const trimmed = portability.trim();
  const marker = /^applies to:\s*/i.exec(trimmed);
  const body = (marker ? trimmed.slice(marker[0].length) : trimmed).trim();
  if (!body) return { targets: [], none: false, errors: ['empty body'] };
  if (/^none$/i.test(body)) return { targets: [], none: true, errors: [] };

  const errors: string[] = [];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of body.split(',').map(s => s.trim())) {
    if (!raw) { errors.push('empty target name'); continue; }
    if (/^none$/i.test(raw)) { errors.push(`stray "none" inside a target list: "${raw}"`); continue; }
    if (!PORTABILITY_TARGET_RE.test(raw)) { errors.push(`malformed target name: "${raw}"`); continue; }
    const lower = raw.toLowerCase();
    if (!seen.has(lower)) { seen.add(lower); targets.push(lower); }
  }
  return { targets, none: false, errors };
}
export interface ItemMergedData {
  commit: string;
  deployed?: boolean;
  /** How this item was attributed in a batch merge (absent on single-item merges that had no manifest). */
  attribution?: 'manifest' | 'commit-subject';
  /**
   * TRUST-HARDENING: actual-diff evidence captured at merge time (additive; absent on legacy
   * merges and on no-code merges such as the planning lane). The acceptance tier classifies from
   * `changedFiles` when present — a merge with real code changes can never fall into the
   * "no code changed → auto" branch just because its declared `touches` were empty/missing.
   * `baseSha`..`headSha` is the exact range `changedFiles` was diffed over; `gateCommand` is the
   * command that proved the build. `changedFiles` is capped at 200 entries with
   * `changedFilesTruncated:true` set beyond that, so the oversized-event guard never trips.
   */
  baseSha?: string;
  headSha?: string;
  changedFiles?: string[];
  changedFilesTruncated?: boolean;
  gateCommand?: string;
  /**
   * SESSION MODE: the attended session that built and merged this item (conductor path).
   * Absent on every beat-built merge — the fold treats both identically (mode-agnostic events);
   * this is attribution only, never behavior.
   */
  sessionId?: string;
  /**
   * Certify-don't-brief payload (see {@link CertificationPayload}). Optional for back-compat;
   * sourced from the worker's manifest (WorkerManifest.certification) when present.
   */
  certification?: CertificationPayload;
}

/** TRUST-HARDENING: cap on the changedFiles evidence list so a huge merge never trips the
 *  oversized-event guard. Entries beyond the cap are dropped and changedFilesTruncated is set. */
export const MERGE_EVIDENCE_FILES_CAP = 200;
/**
 * ADR-009 — item.certification-amended: the operator's confirmed reply to the portability-nudge
 * (see {@link CertificationPayload.portability}). Closes the completion loop that a bare `msg.in`
 * reply never could: an explicit verb-appended event the fold merges into
 * `mergeCertification.portability`, last-writer-wins. `field` is deliberately extensible (only
 * `'portability'` today) so a future amendable certification field doesn't need a new event type.
 */
export interface ItemCertificationAmendedData {
  /** Amendable certification field. Only 'portability' today; extensible by design. */
  field: 'portability';
  /** Canonical normalized note: `applies to: <a>, <b>` or `applies to: none`. */
  portability: string;
  /** Parsed target names (lower-cased canonical). Empty ⇒ none. */
  targets: string[];
  /** Actor stamp — 'operator' for CLI/console, bridge ids otherwise. */
  by: string;
  /** Dedup link to the msg.in trail (mirrors approve/reject). */
  inReplyTo?: string;
}
export interface ItemAcceptedData {
  by: string;
  provisional?: boolean;
  /** Acceptance tier the item classified into ('auto' | 'optional' | 'review' | 'must'). */
  tier?: string;
  /** Human-readable classification reason, carried into the msg.out trail. */
  reason?: string;
}
export interface ItemFeedbackData {
  text: string;
  /** Runs-dir-relative attachment paths uploaded alongside this feedback (console uploads). */
  attachments?: string[];
}
export interface ItemBriefedData { brief: string; model?: string }
/**
 * item.respec — an operator reply on an item thread steered the work: the spec is amended.
 * Emitted by the reactor engagement step alongside an item.queued (re-queue for a fresh build).
 * `inReplyTo` carries causation (the operator msg.in event id) for idempotent dedupe.
 */
export interface ItemRespecData { spec: string; reason: string; inReplyTo?: string }
/**
 * engagement.baseline — a single deploy-time marker event (item 'system'). Operator replies at
 * or before its ts are legacy-unresolved and never auto-engaged; only replies AFTER it enter the
 * engagement projection. Appended once at deploy via
 * `loopctl append engagement.baseline --item system --data '{}'` (NOT written by the beat, so a
 * stale/replayed ledger never mass-engages its historical replies). Earliest baseline wins.
 */
export type EngagementBaselineData = Record<string, never>;

// target domain (TARGET EXTERNALIZATION — docs/event-model.md §"Register a target")
/**
 * target.registered — the plane was explicitly pointed at (and consented to) an external git
 * repo. Appended by `loopctl target add` after it validated the repo + parsed its manifest and
 * showed the manifest's commands to the operator. Addressed by the target `name` (the envelope
 * `item` field), which is the global handle downstream events reference. Append-only: a changed
 * manifest for an already-registered target appends target.manifest-updated, never a mutation.
 */
export interface TargetRegisteredData {
  /**
   * Opaque stable target identity (`tgt-<8 lowercase base32>`, see target.ts mintTargetId),
   * minted ONCE at first registration. Identity ≠ name (docs/event-model.md §"Register a
   * target"): renames never change it, and re-registering a previously seen repoPath revives
   * the ORIGINAL id (repoPath is the stable revival key). Optional only for back-compat —
   * registration events written before this field existed lack it, and the fold synthesizes a
   * deterministic repoPath-derived fallback (target.ts fallbackTargetId) so old ledgers keep
   * folding to a stable identity. New writers ALWAYS stamp it.
   */
  targetId?: string;
  name: string;
  repoPath: string;      // absolute path to the target repo on the host
  manifestHash: string;  // stable content hash of the manifest at registration time
  defaultBranch: string; // branch finished builds merge into
}
/**
 * target.manifest-updated — the manifest at an already-registered target changed since the last
 * registration/update (detected by hash at build time). Carries only the new hash (+ the possibly
 * changed defaultBranch); the registration's repoPath is immutable.
 */
export interface TargetManifestUpdatedData {
  /** Opaque stable target id (see TargetRegisteredData.targetId). Optional for back-compat;
   *  when absent the fold resolves the record by name. New writers always stamp it. */
  targetId?: string;
  name: string;
  manifestHash: string;
  defaultBranch?: string;
}

// session domain (attended session mode — claim leases)
/**
 * Default claim lease length. A claim older than its ttl no longer defers the beats even
 * if the claiming session still heartbeats — the operator re-claims to renew (or the claim
 * verb renews on re-claim). One constant, shared by the fold's lease math and the claim verb.
 */
export const DEFAULT_CLAIM_TTL_MINUTES = 60;

/**
 * Default stale-claim reap age (ADR-007), in milliseconds: how old a claim that already
 * reads INACTIVE (isClaimActive false — ttl expired or the claiming session's dead-man
 * gone) must be before the doctor appends an explicit item.released for audit-trail hygiene.
 * Generous by design — 2x DEFAULT_CLAIM_TTL_MINUTES — so a live operator whose heartbeat
 * merely lagged past the dead-man bound is never reaped out from under a claim it is
 * actively working; the reap is forensic cleanup, not a second liveness check.
 */
export const DEFAULT_CLAIM_REAP_AGE_MS = 2 * DEFAULT_CLAIM_TTL_MINUTES * 60_000;

/**
 * session.started — an attended operator session opened. Addressed by the sessionId
 * (envelope `item`), like target.* events are addressed by the target name; `data.sessionId`
 * carries the same id explicitly so consumers never parse the envelope addressee.
 */
export interface SessionStartedData { sessionId: string; source?: string }
/** session.heartbeat — liveness pulse from an attended session (dead-man input). */
export interface SessionHeartbeatData { sessionId: string }
/** session.ended — the session closed; the end verb releases all its claims in the same locked append. */
export interface SessionEndedData { sessionId: string }
/**
 * item.claimed — an attended session leased this queued item: the away beats defer to the
 * session while the claim is ACTIVE (ttl unexpired AND the session's heartbeat fresh — see
 * fold.ts isClaimActive, the ONE predicate). A crashed session's stale heartbeat auto-expires
 * every claim back to the shared queue (dead-man semantics); nothing is ever mutated to release.
 */
export interface ItemClaimedData { sessionId: string; ttlMinutes: number }
/** item.released — the claim on this item is explicitly returned to the shared queue. */
export interface ItemReleasedData {
  reason?: string;
  /**
   * The session whose claim this release consumed (ADR-007 stale-claim reap). OPTIONAL —
   * absent on every release predating this field (an explicit `session end` release, a manual
   * `session release`) and never required by the fold, which clears `rec.claim` unconditionally
   * on item.released regardless of this field's presence.
   */
  sessionId?: string;
}

// conversation domain
export interface ConvStartedData {
  source: string;  // e.g. 'console' | 'cli' | a fork's own channel adapter name
  title?: string;
}
export interface ConvPromotedData {
  items: string[];  // [<item-id>, ...]
}
export interface ConvClosedData {
  reason: string;  // 'operator' | 'idle' | ...
}

// msg domain
export interface MsgInData {
  text: string;
  /** Runs-dir-relative attachment paths uploaded alongside this reply (console uploads). */
  attachments?: string[];
}
export interface MsgOutData {
  text: string;
  /**
   * The operator msg.in event id this message answers. Present on every engagement outcome;
   * the fold's engagement projection uses it to mark a reply answered (idempotent dedupe) and
   * to key the operator-silence acceptance hold on causation.
   */
  inReplyTo?: string;
  /**
   * True when this msg.out PROPOSES a destructive verb (accept/reject/approve) that awaits
   * deterministic confirmation (an exact console verb pattern / form verb). The LLM never
   * emits the verb itself; a pending proposal holds the item from auto-acceptance.
   */
  proposal?: boolean;
}

// build domain
export interface BuildDispatchedData {
  attempt: number;
  worktree?: string;
  branch?: string;
  pid?: number;
  /**
   * Process-GROUP id of a detached build worker (from `setsid`), recorded BEFORE the beat
   * detaches and exits. Distinct from `pid` (the beat's own pid, recorded by the legacy
   * synchronous path): a detached worker outlives the beat, so its liveness — and the
   * cancel/breaker kill target — is the group (`kill(-pgid, …)`), not a single pid. Absent on
   * legacy synchronous builds and on planning-lane builds. The doctor's orphan predicate keys
   * on pgid + the exit-file protocol (exitfile.ts): pgid-dead + exit-file-present-uncollected =
   * completed-awaiting-collection (never orphan); pgid-dead + no-exit-file past one collection
   * cycle = crashed.
   */
  pgid?: number;
  provider?: string;
  model?: string;
  /**
   * How the model was selected.
   * 'router'    → model was chosen by the routing table (active mode, data pick)
   * 'data'      → alias for 'router' (data-driven pick)
   * 'explore'   → exploration pick (epsilon-greedy cold-start)
   * absent      → incumbent (off/advisory mode or no data qualified)
   */
  modelSource?: 'router' | 'data' | 'explore';
  /**
   * Advisory mode: what 'active' mode would have picked, when it differs from the incumbent
   * model. Recorded for calibration visibility. Absent when the advisory choice is the same as
   * the incumbent, or in non-advisory modes.
   */
  modelAdvisory?: string;
}
export interface BuildFinishedData { commit: string }
/**
 * errorFingerprint: a deterministic hash of stderrTail (see fold.ts computeErrorFingerprint),
 * used by the doctor's thrashing detector to spot 3 consecutive identical-cause crashes.
 * Optional — the fold derives it from stderrTail itself, so older/other emitters that omit
 * it still fold correctly (never trust an upstream-supplied hash, always re-derive it
 * deterministically from the raw stderrTail).
 */
/**
 * A single ledger event stripped to ts/type/item (no data blob) — capture-time
 * "what else was happening on the plane" evidence attached to a crash/stall event.
 */
export interface DoctorLedgerContextEntry { ts: string; type: string; item: string }
export interface BuildCrashedData {
  reason: string;
  stderrTail?: string;
  errorFingerprint?: string;
  /** Oneline `git log` subjects on master since the last merge (bounded, deterministic). */
  gitLogSince?: string[];
  /** Nearby ledger events (any item) around the failure, for change-correlation. */
  surroundingEvents?: DoctorLedgerContextEntry[];
}
/**
 * build.cancel-requested (run-controls hard-stop) —
 * a pure ledger write from the console's confirm-gated Stop verb. `attempt` pins the exact
 * build attempt this cancel targets: the in-beat cancel poll and the pre-dispatch check both
 * treat a cancel-requested for attempt N as consumed/moot once attempt N is no longer the
 * item's current build (a late-arriving cancel for a finished/superseded attempt is a no-op —
 * the attempt-matching race the contract calls out).
 */
export interface BuildCancelRequestedData { attempt: number; by: string }
/**
 * build.cancelled — terminal event for a build the dispatch beat killed via the provider's
 * existing SIGTERM→SIGKILL escalation (claudeCli.ts). Carries the SAME attempt the
 * cancel-requested targeted, so the fold handler can guard against a late/duplicate event
 * acting on a different (later) build. Deliberate stop ⇒ the item parks `hold`, no auto-requeue.
 */
export interface BuildCancelledData { attempt: number; by: string }
/**
 * build.stalled — the doctor detected a build whose worker PID is alive but has made no
 * progress (no new worktree commit / log / stderr write) for stalledBuildMinutes. Distinct
 * from build.crashed (dead PID): the reactor kills the live worker before salvage. Folds like
 * build.crashed — archives the build and returns the item to 'queued'.
 */
export interface BuildStalledData {
  reason: string;
  idleMinutes?: number;
  stderrTail?: string;
  /** Oneline `git log` subjects on master since the last merge (bounded, deterministic). */
  gitLogSince?: string[];
  /** Nearby ledger events (any item) around the failure, for change-correlation. */
  surroundingEvents?: DoctorLedgerContextEntry[];
}
/**
 * build.superseded — a completed dispatch build whose terminal path re-read the ledger under the
 * lock immediately before gate/merge/push and found the item ALREADY terminal (an attended
 * session merged it while this detached build was in flight, via a stale-claim takeover). The
 * build is not merged again; its branch is salvaged for review. Audit-only: never a state
 * transition (the item is already terminal), it simply records why a finished build did not ship.
 */
export interface BuildSupersededData {
  /** The superseded build's attempt number. */
  attempt: number;
  /** Human-readable why (includes the terminal state found on re-fold). */
  reason: string;
  /** The salvaged branch kept for operator review. */
  branch?: string;
}

// gate domain
/** `reason` disambiguates which lane's gate ran (e.g. 'tests green' vs 'claim-audit passed: ...'). Optional — events may carry only `tests`. */
export interface GatePassedData { tests?: string; reason?: string }
export interface GateFailedData { reason: string }
export interface GateParkedData { reason: string }

// merge domain
export interface MergeTransientFailData { reason: string; transientCount: number }

// deploy domain
export interface DeploySucceededData { commit?: string }
export interface DeployFailedData { reason: string; stderr?: string }

// review domain
export interface ReviewFindingData { [key: string]: unknown }
/**
 * review.verdict — emitted by the LLM-as-judge merge-review stage.
 * Advisory-only: never changes item state or merge behavior.
 * verdict:'unparseable' means the judge produced output that could not be parsed.
 * verdict:'unavailable' (TRUST-HARDENING) means the judge ATTEMPT never produced any usable
 * output — a provider error/timeout. It is recorded explicitly (rather than the old silent
 * fail-open) so an evidence gap is never invisible; the acceptance classifier floors any item
 * carrying it at 'review' (never auto/optional). `reason` carries the provider error text.
 */
export interface ReviewVerdictData {
  verdict: 'pass' | 'fail' | 'unparseable' | 'unavailable';
  confidence: number;          // [0, 1]
  specSatisfied: 'yes' | 'partial' | 'no' | 'unknown';
  scopeCreep: 'none' | 'minor' | 'major' | 'unknown';
  testTheatre: 'none' | 'suspected' | 'unknown';
  reasons: string[];           // up to 5 bullets from the judge
  model: string;               // model used for this judge run
  judge: 'merge-review';   // stable tag for this judge slot
  /** TRUST-HARDENING: present on verdict:'unavailable' — the provider error/timeout text. */
  reason?: string;
}

// ops domain
export interface SloBreachData { indicator: string; value: number | string; target: number | string }
export interface SloRecoveredData { key: string }
export interface CostUsageData {
  provider: string;
  loop: string;
  tokens: number;
  usd?: number;
  wi?: string;
  /** Agentic turn count (proxy from the CLI num_turns — approximation, not exact tool calls). */
  turns?: number;
  /** Wall-clock duration of the provider call in milliseconds (from the CLI duration_ms). */
  durationMs?: number;
  /** Raw token breakdown (some provider rollout sessions carry these per token_count event). */
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /**
   * Subscription quota consumed so far, 0-100 (e.g. rate_limits.primary.used_percent from a
   * rollout). Unpriceable subscription metric, not a per-call charge — a point-in-time reading,
   * never additive. Consumers must take the latest reading, never sum it across events.
   */
  quotaPercent?: number;
}
export interface LoopBeatData { loop: string; result: string }
/**
 * quota.snapshot — a point-in-time subscription-quota reading for one provider:window pair
 * (e.g. a provider's five_hour/seven_day rate limits from a statusline, or a primary rate
 * limit from a rollout token_count event). Never additive across events — consumers fold the
 * full history per provider:window to regress capacity/runway (see costs.ts
 * computeQuotaCapacity), unlike cost.usage's tokens/usd fields which do sum.
 */
export interface QuotaSnapshotData {
  provider: string;    // 'claude' | 'codex'
  window: string;      // 'five_hour' | 'seven_day' | 'primary'
  usedPct: number;     // 0-100
  resetsAt?: string;   // ISO8601, when known
  planType?: string;
  source?: string;     // 'statusline' | 'codex-rollout'
  /** Window length in minutes (e.g. a provider's rate_limits.primary.window_minutes, 10080 for
   *  a 7-day window) — lets consumers derive a human label ("7d window") instead of hardcoding
   *  one per window key. Absent on readings whose window keys are already semantic
   *  ('five_hour' / 'seven_day') and on older replays. */
  windowMinutes?: number;
}
export interface HealProposedData { key: string; action: string; tier: string; detail?: string }
export interface HealExecutedData { key: string; action: string; evidence: string; revert: string }
export interface HealVerifiedData { key: string; action: string }
export interface HealEscalatedData { key: string; reason: string; count: number }
export interface HealGraduatedData { key: string }
/**
 * heal.shadowed — a shadow-mode rule's breach condition fired; records what
 * the rule WOULD have done (its tier: 'auto-heal' | 'nudge' | 'escalate') without taking
 * the action. Pure telemetry, never a state transition — mirrors heal.proposed's shape
 * so the two read identically except for intent (armed-but-not-yet-executed vs.
 * deliberately not-armed).
 */
export interface HealShadowedData { key: string; action: string; wouldHave: string }

/**
 * tier.recalibrated — self-tuning acceptance-tier windows.
 * Emitted by the reactor's stepTierCalibration when the operator's verdict history
 * (clean accepts vs. problem reports) justifies shrinking or growing a tuned tier's
 * ('optional' | 'review') auto-accept window. Event-sourced (one-home): the effective
 * window for a tier is the latest tier.recalibrated.windowHours for that tier, else the
 * config default — never a config-file mutation.
 */
export interface TierRecalibratedData {
  tier: string;
  windowHours: number;
  prevWindowHours: number;
  reason: string;
  cleanAccepts: number;
  problems: number;
}

/**
 * diagnosis.recorded — WI-084 park pathologist: the verdict for one FAILURE park (gate-red /
 * crash / infra — never parkKind:'decision', which is an operator question, not a plane
 * failure). One diagnosis per park EVENT (dedup key: parkFingerprint — see fold.ts
 * computeParkFingerprint / ItemRecord.lastDiagnosedFingerprint). Never a state transition by
 * itself; the reactor's stepPathology follows it with the actual state-changing event
 * (item.queued / item.blocked / item.parked) implied by `actedAs`.
 */
export interface DiagnosisRecordedData {
  /** Fingerprint of the park EVENT this diagnosis is for (see below) — dedup key. */
  parkFingerprint: string;
  classification: 'transient-infra' | 'plane-infra-bug' | 'items-own-code' | 'unparseable' | 'unavailable';
  /** Cited evidence bullets from the model (up to ~5). */
  evidence: string[];
  /** The proposed action, free text from the model. */
  proposedAction: string;
  /** The action the reactor actually took as a result. */
  actedAs: 'requeued-transient' | 'blocked-on-repair' | 'requeued-own-code' | 'parked-review' | 'skipped';
  model: string;
  /** present on classification:'unavailable' — the provider error/timeout text (mirror ReviewVerdictData.reason). */
  reason?: string;
  /** the repair WI id, present only when actedAs==='blocked-on-repair'. */
  repairItem?: string;
}

/** All recognized data shapes by type string */
export type EventDataMap = {
  'item.captured': ItemCapturedData;
  'item.routed': ItemRoutedData;
  'item.queued': ItemQueuedData;
  'item.parked': ItemParkedData;
  'item.unparked': UnparkedData;
  'item.approved': ItemApprovedData;
  'item.rejected': ItemRejectedData;
  'item.reopened': ItemReopenedData;
  'item.escalated': ItemEscalatedData;
  'item.blocked': ItemBlockedData;
  'item.merged': ItemMergedData;
  'item.certification-amended': ItemCertificationAmendedData;
  'item.accepted': ItemAcceptedData;
  'item.feedback': ItemFeedbackData;
  'item.briefed': ItemBriefedData;
  'item.respec': ItemRespecData;
  'item.claimed': ItemClaimedData;
  'item.released': ItemReleasedData;
  'session.started': SessionStartedData;
  'session.heartbeat': SessionHeartbeatData;
  'session.ended': SessionEndedData;
  'engagement.baseline': EngagementBaselineData;
  'conv.started': ConvStartedData;
  'conv.promoted': ConvPromotedData;
  'conv.closed': ConvClosedData;
  'target.registered': TargetRegisteredData;
  'target.manifest-updated': TargetManifestUpdatedData;
  'deploy.succeeded': DeploySucceededData;
  'deploy.failed': DeployFailedData;
  'msg.in': MsgInData;
  'msg.out': MsgOutData;
  'build.dispatched': BuildDispatchedData;
  'build.finished': BuildFinishedData;
  'build.crashed': BuildCrashedData;
  'build.stalled': BuildStalledData;
  'build.cancel-requested': BuildCancelRequestedData;
  'build.cancelled': BuildCancelledData;
  'build.superseded': BuildSupersededData;
  'gate.passed': GatePassedData;
  'gate.failed': GateFailedData;
  'gate.parked': GateParkedData;
  'merge.transient-fail': MergeTransientFailData;
  'review.finding': ReviewFindingData;
  'review.verdict': ReviewVerdictData;
  'slo.breach': SloBreachData;
  'slo.recovered': SloRecoveredData;
  'cost.usage': CostUsageData;
  'loop.beat': LoopBeatData;
  'quota.snapshot': QuotaSnapshotData;
  'heal.proposed': HealProposedData;
  'heal.executed': HealExecutedData;
  'heal.verified': HealVerifiedData;
  'heal.escalated': HealEscalatedData;
  'heal.graduated': HealGraduatedData;
  'heal.shadowed': HealShadowedData;
  'tier.recalibrated': TierRecalibratedData;
  'diagnosis.recorded': DiagnosisRecordedData;
};

export type KnownEventType = keyof EventDataMap;

/** The event envelope stored in the ledger */
export interface LedgerEvent<T extends string = string> {
  id: string;
  ts: string;       // ISO8601
  actor: string;
  item: string;     // WI-NNN
  type: T;
  data: T extends KnownEventType ? EventDataMap[T] : Record<string, unknown>;
  /** Envelope schema version (see LEDGER_SCHEMA_VERSION). Absent on legacy ledger lines — treat as 1. */
  v?: number;
}

// ---------------------------------------------------------------------------
// Hand-rolled validation
// ---------------------------------------------------------------------------

const KNOWN_TYPES = new Set<string>([
  'item.captured', 'item.routed', 'item.queued', 'item.parked', 'item.unparked',
  'item.approved', 'item.rejected', 'item.reopened', 'item.escalated', 'item.blocked', 'item.merged', 'item.certification-amended', 'item.accepted', 'item.feedback', 'item.briefed',
  'item.respec', 'engagement.baseline',
  'item.claimed', 'item.released',
  'session.started', 'session.heartbeat', 'session.ended',
  'msg.in', 'msg.out',
  'build.dispatched', 'build.finished', 'build.crashed', 'build.stalled',
  'build.cancel-requested', 'build.cancelled', 'build.superseded',
  'gate.passed', 'gate.failed', 'gate.parked',
  'merge.transient-fail',
  'deploy.succeeded', 'deploy.failed',
  'review.finding', 'review.verdict',
  'slo.breach', 'slo.recovered', 'cost.usage', 'loop.beat', 'quota.snapshot',
  'heal.proposed', 'heal.executed', 'heal.verified', 'heal.escalated', 'heal.graduated', 'heal.shadowed',
  'tier.recalibrated',
  'diagnosis.recorded',
  'conv.started', 'conv.promoted', 'conv.closed',
  'target.registered', 'target.manifest-updated',
]);

export function isKnownType(t: string): t is KnownEventType {
  return KNOWN_TYPES.has(t);
}

/**
 * Validate a parsed JSON object is a structurally valid event envelope.
 * Unknown event types are preserved (forward-compatible).
 * Throws a descriptive string on failure.
 */
export function validateEvent(raw: unknown): LedgerEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Event must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id'].startsWith('ev-')) {
    throw new Error(`Invalid id: ${JSON.stringify(r['id'])}`);
  }
  if (typeof r['ts'] !== 'string' || isNaN(Date.parse(r['ts'] as string))) {
    throw new Error(`Invalid ts: ${JSON.stringify(r['ts'])}`);
  }
  if (typeof r['actor'] !== 'string' || !r['actor']) {
    throw new Error(`Invalid actor: ${JSON.stringify(r['actor'])}`);
  }
  if (typeof r['item'] !== 'string' || !r['item']) {
    throw new Error(`Invalid item: ${JSON.stringify(r['item'])}`);
  }
  if (typeof r['type'] !== 'string' || !r['type']) {
    throw new Error(`Invalid type: ${JSON.stringify(r['type'])}`);
  }
  if (!r['data'] || typeof r['data'] !== 'object' || Array.isArray(r['data'])) {
    throw new Error(`Invalid data: must be an object`);
  }
  if (r['v'] !== undefined && typeof r['v'] !== 'number') {
    throw new Error(`Invalid v: ${JSON.stringify(r['v'])}`);
  }
  return r as unknown as LedgerEvent;
}

/**
 * Resolve operator-attachment absolute paths from an item's captured text.
 * Attachments are recorded as `attachment: <source-id>/<file> (<N> bytes)` markers in the
 * captured text; the files live under <uploadsRoot>/<source-id>/<file>
 * (uploadsRoot = LOOPKIT_UPLOADS_ROOT env, else <HOME>/.loopkit/uploads).
 * Returns absolute paths (existence NOT checked here — the caller may Read them).
 */
export function resolveAttachmentPaths(
  sourceText: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!sourceText) return [];
  const home = env['HOME'] ?? '';
  const root = env['LOOPKIT_UPLOADS_ROOT'] ?? (home ? `${home}/.loopkit/uploads` : '.loopkit/uploads');
  const out: string[] = [];
  const re = /^attachment:\s*(\S+\/[^\s(]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) {
    out.push(`${root}/${m[1]}`);
  }
  return out;
}

/**
 * Build an event object ready for appending. Caller provides all fields except id.
 */
export function makeEvent<T extends string>(
  actor: string,
  item: string,
  type: T,
  data: T extends KnownEventType ? EventDataMap[T] : Record<string, unknown>,
  ts?: string,
): LedgerEvent<T> {
  return {
    id: newId(),
    ts: ts ?? new Date().toISOString(),
    actor,
    item,
    type,
    data,
    v: LEDGER_SCHEMA_VERSION,
  } as LedgerEvent<T>;
}
