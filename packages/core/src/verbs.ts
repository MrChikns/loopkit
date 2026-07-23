/**
 * verbs.ts — the operator-facing ledger-write verbs (capture / approve / reject / accept),
 * extracted so the CLI (`loopctl new|approve|reject|accept`) and any other caller (the
 * console's HTTP write path) share ONE implementation. Every append here goes through
 * `withLock` (ledger.ts) — the single-writer lock the rest of the plane also uses.
 *
 * These functions are argv-agnostic: they take typed options, never a `string[]` rest
 * array, and they THROW a `VerbError` on a usage/validation problem instead of calling
 * `console.error`/`process.exit` — a long-running HTTP server cannot exit the process on
 * a bad request. `cli.ts`'s cmdNew/cmdApprove/cmdAccept are now thin argv-parsing wrappers
 * around these (see cli.ts) so CLI behavior (messages, exit codes) is unchanged.
 */

import { spawnSync } from 'node:child_process';
import { withLock } from './ledger.js';
import { fold, nextWiId, resolveItemBranch, ItemRecord, TargetRecord } from './fold.js';
import { makeEvent, ItemQueuedData, ItemEscalatedData, parsePortabilityTargets } from './schema.js';
import { parseOverstepReason, resolveStoredSpecApproval } from './approval.js';

/** Thrown for any usage/validation failure — callers decide how to surface it (CLI exit vs HTTP 4xx). */
export class VerbError extends Error {}

// ---------------------------------------------------------------------------
// captureIntent — `loopctl new "<text>"`
// ---------------------------------------------------------------------------

export interface CaptureIntentOptions {
  text: string;
  /** Capture origin; mirrors --source. Defaults to 'cli'. */
  source?: string;
  /** Explicit target name; mirrors --target. Must name a registered target when given. */
  target?: string;
  /** Runs-dir-relative attachment paths already stored by the caller (console uploads). */
  attachments?: string[];
}

export interface CaptureIntentResult {
  wiId: string;
  /** Display name of the resolved target (mutable handle, kept for messages/back-compat). */
  target?: string;
  /** Opaque stable id of the resolved target — the identity stamp on the captured event. */
  targetId?: string;
}

/**
 * Append `item.captured`. Target resolution mirrors the CLI exactly (docs/event-model.md
 * §"Capture intent against a target"): an explicit target always wins; with no explicit
 * target, exactly one registered target is stamped automatically; zero registered targets
 * captures untargeted (legacy single-repo mode); more than one requires an explicit target.
 */
export async function captureIntent(
  ledgerDir: string,
  opts: CaptureIntentOptions,
): Promise<CaptureIntentResult> {
  const text = opts.text;
  if (!text) throw new VerbError('text is required');
  const source = opts.source ?? 'cli';
  const actor = source.startsWith('ext:') ? 'operator' : 'cli';
  const targetFlag = opts.target;

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const registeredNames = [...result.targets.values()].map(t => t.name);

    // Resolution yields the full registration RECORD: the capture stamps the stable
    // targetId (identity) alongside the display name (docs/event-model.md: identity ≠ name).
    let target: TargetRecord | undefined;
    if (targetFlag !== undefined) {
      target = result.targets.byId(targetFlag) ?? result.targets.byName(targetFlag);
      if (!target) {
        throw new VerbError(
          `Unknown target '${targetFlag}'. Registered targets: ${registeredNames.length ? registeredNames.join(', ') : '(none)'}`,
        );
      }
    } else if (result.targets.size === 1) {
      target = [...result.targets.values()][0];
    } else if (result.targets.size > 1) {
      throw new VerbError(
        `${result.targets.size} targets registered (${registeredNames.join(', ')}); pass a target to select one.`,
      );
    }
    // no registered targets → target stays undefined (legacy capture).

    const wiId = nextWiId(result);
    const ev = makeEvent(actor, wiId, 'item.captured', {
      source,
      text,
      ...(target !== undefined ? { target: target.name, targetId: target.targetId } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    });
    await tx.append([ev]);
    return { wiId, target: target?.name, targetId: target?.targetId };
  });
}

// ---------------------------------------------------------------------------
// approveOrReject — `loopctl approve|reject <id>`
// ---------------------------------------------------------------------------

export interface ApproveOrRejectOptions {
  /** Working directory for the branch-existence git check. Defaults to cwd. */
  repoRoot?: string;
  trail?: string;
  /** Actor to stamp on a reject (machine callers pass their own; default 'operator'). */
  by?: string;
}

export type ApproveOrRejectLabel = 'Approved' | 'Rejected' | 'Requeued' | 'Unparked' | 'no-op';

export interface ApproveOrRejectResult {
  wiId: string;
  label: ApproveOrRejectLabel;
  message: string;
}

/**
 * Append the approve/reject verb event(s). Preconditions, terminal-state no-ops, the
 * branch-gone requeue path, and the stored-spec fast path are all identical to the
 * CLI's cmdApprove — this IS that logic, only argv-parsing and process.exit were removed.
 */
export async function approveOrReject(
  ledgerDir: string,
  rawId: string,
  verb: 'approve' | 'reject',
  opts: ApproveOrRejectOptions = {},
): Promise<ApproveOrRejectResult> {
  if (!rawId) throw new VerbError('id is required');
  if (!/^WI-\d+$/.test(rawId)) {
    throw new VerbError(`'${rawId}' is not a valid work-item id (expected WI-NNN)`);
  }
  const trailText = opts.trail ?? `🛡 spine ${rawId}: ${verb}`;
  const rejectBy = opts.by ?? 'operator';
  const repoRoot = opts.repoRoot ?? process.cwd();

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);

    const wiId = rawId;

    const rec = result.items.get(wiId);
    if (verb === 'approve' && rec?.state === 'merged') {
      return { wiId, label: 'no-op', message: `${wiId} is already merged — approve is a no-op (merged is terminal).` };
    }

    const isParkedUnbuilt = verb === 'approve' && rec?.state === 'parked' && (rec?.builds.length ?? 0) === 0;

    const storedSpecResult = isParkedUnbuilt && rec ? resolveStoredSpecApproval(rec, result.items) : undefined;
    if (storedSpecResult?.kind === 'unresolved') {
      return {
        wiId,
        label: 'no-op',
        message: `${wiId}: waiting on ${storedSpecResult.depId} to merge — not yet approved (stored spec ready; re-approve once ${storedSpecResult.depId} merges).`,
      };
    }

    const approvedTouches = !isParkedUnbuilt && verb === 'approve' && rec?.parkClass === 'touches-overstep'
      ? parseOverstepReason(rec.parkReason ?? '')?.files
      : undefined;

    const hasBuilds = !isParkedUnbuilt && verb === 'approve' && (rec?.builds.length ?? 0) > 0;
    let branchGone = false;
    if (hasBuilds && rec) {
      const branch = resolveItemBranch(rec);
      if (branch) {
        const branchCheck = spawnSync('git', ['rev-parse', '--verify', branch], { cwd: repoRoot, stdio: 'pipe' });
        branchGone = branchCheck.status !== 0;
      }
    }

    const msgEv = makeEvent('cli', wiId, 'msg.in', { text: trailText });

    const verbEvs = storedSpecResult?.kind === 'resolved' && rec
      ? (() => {
          const queuedData: ItemQueuedData = { spec: storedSpecResult.spec, inReplyTo: msgEv.id };
          if (rec.touches) queuedData.touches = rec.touches;
          if (rec.model) queuedData.model = rec.model;
          if (rec.effort) queuedData.effort = rec.effort;
          if (rec.priority) queuedData.priority = rec.priority;
          if (rec.lane) queuedData.lane = rec.lane;
          return [
            makeEvent('cli', wiId, 'item.unparked' as const, { by: 'operator', inReplyTo: msgEv.id }),
            makeEvent('cli', wiId, 'item.queued' as const, queuedData),
          ];
        })()
      : branchGone && rec
      ? (() => {
          const queuedData: ItemQueuedData = { spec: rec.spec ?? rec.sourceText ?? '', inReplyTo: msgEv.id };
          if (rec.touches) queuedData.touches = rec.touches;
          if (rec.model) queuedData.model = rec.model;
          if (rec.effort) queuedData.effort = rec.effort;
          if (rec.priority) queuedData.priority = rec.priority;
          if (rec.lane) queuedData.lane = rec.lane;
          return [
            makeEvent('cli', wiId, 'item.unparked' as const, { by: 'operator', inReplyTo: msgEv.id }),
            makeEvent('cli', wiId, 'item.queued' as const, queuedData),
          ];
        })()
      : [
          isParkedUnbuilt
            ? makeEvent('cli', wiId, 'item.unparked' as const, { by: 'operator', inReplyTo: msgEv.id })
            : verb === 'approve'
              ? makeEvent('cli', wiId, 'item.approved' as const, {
                  by: 'operator',
                  inReplyTo: msgEv.id,
                  ...(approvedTouches && approvedTouches.length > 0 ? { approvedTouches } : {}),
                })
              : makeEvent('cli', wiId, 'item.rejected' as const, { by: rejectBy, inReplyTo: msgEv.id }),
        ];
    await tx.append([...verbEvs, msgEv]);

    const label: ApproveOrRejectLabel = storedSpecResult?.kind === 'resolved' ? 'Approved'
      : branchGone ? 'Requeued'
      : isParkedUnbuilt ? 'Unparked'
      : verb === 'approve' ? 'Approved' : 'Rejected';
    const message = storedSpecResult?.kind === 'resolved'
      ? `Approved ${wiId} — queued for build with the stored spec (${storedSpecResult.depId} merged, no routing call needed)`
      : branchGone
      ? `${wiId}: branch lost — requeued for rebuild (approve would have been silently re-parked)`
      : `${label} ${wiId}`;
    return { wiId, label, message };
  });
}

// ---------------------------------------------------------------------------
// acceptItem — `loopctl accept <id>`
// ---------------------------------------------------------------------------

export interface AcceptItemOptions {
  trail?: string;
}

export interface AcceptItemResult {
  wiId: string;
  accepted: boolean;
  message: string;
}

/** Append `item.accepted`. Only a `merged` item can be accepted — anything else is a no-op. */
export async function acceptItem(
  ledgerDir: string,
  rawId: string,
  opts: AcceptItemOptions = {},
): Promise<AcceptItemResult> {
  if (!rawId) throw new VerbError('id is required');
  const trailText = opts.trail ?? `✅ accept ${rawId}`;

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);

    const wiId = rawId;

    const rec: ItemRecord | undefined = result.items.get(wiId);
    if (!rec || rec.state !== 'merged') {
      return {
        wiId,
        accepted: false,
        message: `${wiId} is not awaiting acceptance (state: ${rec?.state ?? 'unknown'}) — accept is a no-op.`,
      };
    }

    const verbEv = makeEvent('cli', wiId, 'item.accepted', { by: 'operator' });
    const msgEv = makeEvent('cli', wiId, 'msg.in', { text: trailText });
    await tx.append([verbEv, msgEv]);
    return { wiId, accepted: true, message: `Accepted ${wiId}` };
  });
}

// ---------------------------------------------------------------------------
// amendPortability — `loopctl portability <id> "<reply body>"` (ADR-009)
// ---------------------------------------------------------------------------

export interface AmendPortabilityOptions {
  /** Actor stamp for the amendment's `by` field (default 'operator'; bridge callers pass their own id). */
  by?: string;
  /** Overrides the msg.in trail text; defaults to the raw reply body. */
  trail?: string;
}

export type AmendPortabilityOutcome = 'amended' | 'no-op' | 'rejected';

export interface AmendPortabilityResult {
  wiId: string;
  outcome: AmendPortabilityOutcome;
  message: string;
  /** The canonical normalized note, present only when outcome === 'amended'. */
  portability?: string;
  /** The parsed target names, present only when outcome === 'amended'. */
  targets?: string[];
}

/**
 * Append `item.certification-amended` (ADR-009) — the deterministic confirm path that closes
 * the portability-nudge loop. Precondition: item is `merged` or `accepted` (only a shipped item
 * has a certification to amend) — anything else is a no-op, mirroring acceptItem's precondition
 * shape. On a parse or unknown-target error, appends ONLY the operator-facing `msg.out` (no
 * amendment event, no msg.in trail — the reply never became a confirmed amendment) and returns
 * outcome:'rejected'; the caller decides how to surface that (CLI exit code, HTTP 4xx). On
 * success, appends `[amendedEv, msgInTrail]` linked via `inReplyTo`, exactly the approve/reject
 * verb-appends-an-event pattern.
 */
export async function amendPortability(
  ledgerDir: string,
  rawId: string,
  replyBody: string,
  opts: AmendPortabilityOptions = {},
): Promise<AmendPortabilityResult> {
  if (!rawId) throw new VerbError('id is required');
  if (!/^WI-\d+$/.test(rawId)) {
    throw new VerbError(`'${rawId}' is not a valid work-item id (expected WI-NNN)`);
  }
  if (replyBody === undefined || replyBody === null) throw new VerbError('reply body is required');
  const by = opts.by ?? 'operator';
  const wiId = rawId;

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);

    const rec: ItemRecord | undefined = result.items.get(wiId);
    if (!rec || (rec.state !== 'merged' && rec.state !== 'accepted')) {
      return {
        wiId,
        outcome: 'no-op',
        message: `${wiId} is not merged/accepted (state: ${rec?.state ?? 'unknown'}) — only a shipped item has a certification to amend.`,
      };
    }

    const parsed = parsePortabilityTargets(replyBody);
    if (parsed.errors.length > 0) {
      const msgOut = makeEvent('cli', wiId, 'msg.out', {
        text: `Could not amend ${wiId}'s portability note: ${parsed.errors.join('; ')}. `
          + `Reply with "applies to: <target>, <target>" or "applies to: none".`,
      });
      await tx.append([msgOut]);
      return {
        wiId,
        outcome: 'rejected',
        message: `${wiId}: portability reply rejected — ${parsed.errors.join('; ')}`,
      };
    }

    // Registration check mirrors the reactor's own resolution (fold.ts TargetsProjection.byName)
    // exactly — never accept a name here that the reactor's promotion step couldn't itself resolve.
    const unknown = parsed.targets.filter(t => !result.targets.byName(t));
    if (unknown.length > 0) {
      const registeredNames = [...result.targets.values()].map(t => t.name);
      const msgOut = makeEvent('cli', wiId, 'msg.out', {
        text: `Could not amend ${wiId}'s portability note: unknown target(s) ${unknown.join(', ')}. `
          + `Registered targets: ${registeredNames.length ? registeredNames.join(', ') : '(none registered)'}.`,
      });
      await tx.append([msgOut]);
      return {
        wiId,
        outcome: 'rejected',
        message: `${wiId}: portability reply rejected — unknown target(s) ${unknown.join(', ')}`,
      };
    }

    const portability = parsed.targets.length === 0 ? 'applies to: none' : `applies to: ${parsed.targets.join(', ')}`;
    const msgIn = makeEvent('cli', wiId, 'msg.in', { text: opts.trail ?? replyBody });
    const amendedEv = makeEvent('cli', wiId, 'item.certification-amended', {
      field: 'portability',
      portability,
      targets: parsed.targets,
      by,
      inReplyTo: msgIn.id,
    });
    await tx.append([amendedEv, msgIn]);
    return { wiId, outcome: 'amended', message: `Amended ${wiId} portability: ${portability}`, portability, targets: parsed.targets };
  });
}

// ---------------------------------------------------------------------------
// captureFeedback — "Found a problem" on a merged item: append `item.feedback`,
// then open a linked follow-up item through captureIntent.
// ---------------------------------------------------------------------------

export interface CaptureFeedbackOptions {
  text: string;
  /** Runs-dir-relative attachment paths already stored by the caller (console uploads). */
  attachments?: string[];
}

export interface CaptureFeedbackResult {
  wiId: string;
  followUpId: string;
  message: string;
}

/**
 * Append `item.feedback` to a merged item, then capture a follow-up item through the SAME
 * `captureIntent` every other capture goes through — its text names the origin item so the two
 * stay linked in the ledger's own record, no bespoke relation field needed. Two separate lock
 * acquisitions, deliberately not one: `withLock` (ledger.ts) is not reentrant, so calling
 * `captureIntent` from inside this verb's own `withLock` would self-block on the lock it already
 * holds. Only a merged item is awaiting acceptance/feedback — anything else is rejected.
 */
export async function captureFeedback(
  ledgerDir: string,
  rawId: string,
  opts: CaptureFeedbackOptions,
): Promise<CaptureFeedbackResult> {
  if (!rawId) throw new VerbError('id is required');
  const text = opts.text?.trim();
  if (!text) throw new VerbError('text is required');

  const { wiId, target } = await withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);

    const wiId = rawId;
    const rec: ItemRecord | undefined = result.items.get(wiId);
    if (!rec) throw new VerbError(`No such item: ${rawId}`);
    if (rec.state !== 'merged') {
      throw new VerbError(
        `${wiId} is not awaiting acceptance (state: ${rec.state}) — feedback applies to merged items only.`,
      );
    }

    const ev = makeEvent('operator', wiId, 'item.feedback', {
      text,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    });
    await tx.append([ev]);
    return { wiId, target: rec.target };
  });

  const captured = await captureIntent(ledgerDir, {
    text: `Found a problem in ${wiId}: ${text}`,
    source: `feedback:${wiId}`,
    target,
  });

  return {
    wiId,
    followUpId: captured.wiId,
    message: `Reported a problem on ${wiId} — opened ${captured.wiId} as a follow-up`,
  };
}

// ---------------------------------------------------------------------------
// replyToItem — append an operator reply to an item's message thread
// ---------------------------------------------------------------------------

export interface ReplyToItemOptions {
  text: string;
  /** Actor to stamp on the msg.in event. Defaults to 'operator' — every reply through this
   *  verb is a human typing into a thread (the console's inline reply box today; any other
   *  caller identifies itself the same way `captureIntent`'s `source` does). */
  actor?: string;
  /** Runs-dir-relative attachment paths already stored by the caller (console uploads). */
  attachments?: string[];
}

export interface ReplyToItemResult {
  wiId: string;
  message: string;
}

/**
 * Append `msg.in` to an existing item's thread. This is the ONE place a reply gets appended —
 * the console's `/item/<id>/reply` route calls this, never appending a `msg.in` event itself,
 * so CLI and console replies stay indistinguishable in the fold (fold.ts's `ItemRecord.messages`
 * already threads any `msg.in`/`msg.out` on an item, terminal or not).
 */
export async function replyToItem(
  ledgerDir: string,
  rawId: string,
  opts: ReplyToItemOptions,
): Promise<ReplyToItemResult> {
  if (!rawId) throw new VerbError('id is required');
  const text = opts.text?.trim();
  if (!text) throw new VerbError('text is required');
  const actor = opts.actor ?? 'operator';

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);

    const wiId = rawId;
    if (!result.items.has(wiId)) {
      throw new VerbError(`No such item: ${rawId}`);
    }

    const ev = makeEvent(actor, wiId, 'msg.in', {
      text,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    });
    await tx.append([ev]);
    return { wiId, message: `Reply added to ${wiId}` };
  });
}

// ---------------------------------------------------------------------------
// Run-control verbs — stop / hold / resume / requeue / escalate / dismiss
// (console parity: Missions per-state verb set, mirrors approve/reject/accept above)
// ---------------------------------------------------------------------------

export interface RunControlOptions {
  /** Actor to stamp on the verb event. Defaults to 'operator' (every run-control verb today is
   *  a human clicking a console button). */
  by?: string;
}

export interface RunControlResult {
  wiId: string;
  message: string;
}

/**
 * Append `build.cancel-requested` — the run-controls hard-stop's ONE console-side write (the
 * dispatch beat's cancel poll + per-item attribution on kill already exist, see
 * beats/dispatch.ts hasUnconsumedCancelRequest). Only a `building` item with a live build can
 * be stopped; the dispatch beat parks it `hold` once the worker is actually killed.
 */
export async function stopBuild(
  ledgerDir: string,
  rawId: string,
  opts: RunControlOptions = {},
): Promise<RunControlResult> {
  if (!rawId) throw new VerbError('id is required');
  const by = opts.by ?? 'operator';

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const wiId = rawId;
    const rec = result.items.get(wiId);
    if (!rec || rec.state !== 'building' || !rec.currentBuild) {
      throw new VerbError(`${wiId} is not building (state: ${rec?.state ?? 'unknown'}) — stop applies to building items only.`);
    }

    const verbEv = makeEvent('cli', wiId, 'build.cancel-requested', { attempt: rec.currentBuild.attempt, by });
    const msgEv = makeEvent('cli', wiId, 'msg.in', { text: `⏹ stop requested for ${wiId}` });
    await tx.append([verbEv, msgEv]);
    return { wiId, message: `Stop requested for ${wiId} — the build will be cancelled shortly` };
  });
}

/** Append `item.parked` (parkKind 'hold') — pulls a `queued` item out of the dispatch queue
 *  without a build in flight to interrupt. Resume (unparkItem) is the inverse. */
export async function holdItem(
  ledgerDir: string,
  rawId: string,
  opts: RunControlOptions = {},
): Promise<RunControlResult> {
  if (!rawId) throw new VerbError('id is required');
  const by = opts.by ?? 'operator';

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const wiId = rawId;
    const rec = result.items.get(wiId);
    if (!rec || rec.state !== 'queued') {
      throw new VerbError(`${wiId} is not queued (state: ${rec?.state ?? 'unknown'}) — hold applies to queued items only.`);
    }

    const verbEv = makeEvent('cli', wiId, 'item.parked', { reason: 'held by operator', parkKind: 'hold' });
    const msgEv = makeEvent('cli', wiId, 'msg.in', { text: `⏸ hold requested for ${wiId} by ${by}` });
    await tx.append([verbEv, msgEv]);
    return { wiId, message: `Held ${wiId}` };
  });
}

export type UnparkVerb = 'resume' | 'requeue';

const UNPARK_LABEL: Record<UnparkVerb, string> = { resume: 'Resumed', requeue: 'Requeued' };
const UNPARK_TRAIL: Record<UnparkVerb, string> = { resume: '▶ resume', requeue: '🔁 requeue' };

/**
 * Append `item.unparked` — returns any parked item to the queue. Two console-facing labels
 * share this ONE implementation (Hard rule: one parser/predicate per behavior): 'resume' names
 * the held→queued verb (isHeldPark), 'requeue' names the ops-parked→queued verb (isOpsPark) —
 * the ledger event and the fold transition are identical either way.
 */
export async function unparkItem(
  ledgerDir: string,
  rawId: string,
  verb: UnparkVerb,
  opts: RunControlOptions = {},
): Promise<RunControlResult> {
  if (!rawId) throw new VerbError('id is required');
  const by = opts.by ?? 'operator';

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const wiId = rawId;
    const rec = result.items.get(wiId);
    if (!rec || rec.state !== 'parked') {
      throw new VerbError(`${wiId} is not parked (state: ${rec?.state ?? 'unknown'}) — ${verb} applies to parked items only.`);
    }

    const verbEv = makeEvent('cli', wiId, 'item.unparked', { by });
    const msgEv = makeEvent('cli', wiId, 'msg.in', { text: `${UNPARK_TRAIL[verb]} ${wiId}` });
    await tx.append([verbEv, msgEv]);
    return { wiId, message: `${UNPARK_LABEL[verb]} ${wiId}` };
  });
}

/**
 * Append `item.escalated` — flags a `building` or `queued` item for operator attention WITHOUT
 * interrupting it (never a state transition; see fold.ts's item.escalated case). Distinct from
 * Stop/Hold, which both take the item OUT of active work.
 */
export async function escalateItem(
  ledgerDir: string,
  rawId: string,
  opts: RunControlOptions & { reason?: string } = {},
): Promise<RunControlResult> {
  if (!rawId) throw new VerbError('id is required');
  const by = opts.by ?? 'operator';

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const wiId = rawId;
    const rec = result.items.get(wiId);
    if (!rec || (rec.state !== 'building' && rec.state !== 'queued')) {
      throw new VerbError(`${wiId} is not building or queued (state: ${rec?.state ?? 'unknown'}) — escalate applies to active work only.`);
    }

    const reason = opts.reason?.trim();
    const data: ItemEscalatedData = { by, ...(reason ? { reason } : {}) };
    const verbEv = makeEvent('cli', wiId, 'item.escalated', data);
    const msgEv = makeEvent('cli', wiId, 'msg.in', { text: `🚩 escalated ${wiId}` });
    await tx.append([verbEv, msgEv]);
    return { wiId, message: `Escalated ${wiId} for operator attention` };
  });
}

/**
 * Dismiss a terminal ops-park. Reuses `approveOrReject`'s reject path verbatim (Hard rule: one
 * parser/predicate per behavior) — item.rejected is already the ledger's one "close this item
 * for good" event; dismiss is that same event under the run-control verb set's own name/trail.
 */
export async function dismissItem(
  ledgerDir: string,
  rawId: string,
  opts: RunControlOptions = {},
): Promise<ApproveOrRejectResult> {
  return approveOrReject(ledgerDir, rawId, 'reject', {
    by: opts.by ?? 'operator',
    trail: `🚫 dismiss ${rawId}`,
  });
}
