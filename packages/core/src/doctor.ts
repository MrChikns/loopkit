/**
 * doctor.ts — Pure function over the fold: detect orphaned/stalled builds and propose actions.
 *
 * Orphan definition: an item in 'building' state with a dispatched build that has
 * a KNOWN dead pid (pid liveness is injected for testability) and no terminal build event.
 * A build whose dispatched event carries no pid at all (e.g. planning-lane, which runs
 * synchronously in the beat with no worker pid to record) is NOT checkable via this path —
 * it is treated as unknown/alive, not dead. Stall detection is the backstop.
 *
 * Stalled definition: an item in 'building' state whose pid is ALIVE but which has
 * made no progress for stalledBuildMinutes — progress being the newest of the worktree's
 * last commit, the worker log, and the worker stderr (a deterministic signal, injected via
 * progressProbe; the reactor supplies the real one). This catches a wedged-but-alive worker
 * that the dead-pid orphan check misses.
 *
 * Proposed actions (same for orphan and stall; the emitted build.* event differs):
 *   - append build.crashed|build.stalled + requeue (attempt < breakerN)
 *   - append build.crashed|build.stalled + item.parked reason 'breaker' (attempt >= breakerN)
 *
 * This is a pure function — it reads fold state (+ injected probes) and returns proposals;
 * the caller decides whether to actually apply them (and kills the live pid for stalls).
 */

import { FoldResult, ItemRecord, SessionRecord, computeErrorFingerprint, isClaimActive } from './fold.js';
import { makeEvent, LedgerEvent, DEFAULT_CLAIM_REAP_AGE_MS } from './schema.js';

export interface DoctorConfig {
  breakerN: number;  // park after this many attempts; default 3
  /**
   * Minutes an alive build may make no progress before it is reaped as stalled.
   * Stall detection is OPT-IN: it only runs when both stalledBuildMinutes and now are
   * provided (the reactor passes them; unit tests of the orphan path can omit them).
   */
  stalledBuildMinutes?: number;
  /** Injected wall-clock (epoch ms) for stall-age math. Absent ⇒ stall detection is skipped. */
  now?: number;
  /**
   * Grace window (ms) a DETACHED build (pgid recorded) gets between "group leader dead"
   * and being reaped as an orphan, so a worker that has finished but not yet written its exit
   * file — or a just-spawned worker whose group briefly looks dead — is not double-executed. A
   * dead detached group with NO exit file is only an orphan once its dispatch is older than this
   * (needs config.now; absent ⇒ defer, never reap). Legacy synchronous builds (pid only, no
   * pgid) are unaffected: they keep the immediate dead-pid orphan behaviour. Default one
   * collection cycle ≈ 1.5 dispatch beats.
   */
  collectionCycleMs?: number;
  /**
   * Post-collection-limbo closure: an item whose exit file IS present (so the plain exit-file
   * guard above defers it as collectable-forever) but whose worktree is gone AND whose
   * dispatch is older than this many ms is POST-COLLECTION-LIMBO, not awaiting collection —
   * the collector has no worktree left to diff/merge from and will never finish it. This
   * closes a class of build that can sit invisible for hours across hundreds of beats if
   * left undetected. Requires a clock (config.now) AND a worktree probe reporting absence;
   * either missing ⇒ inert (never a false reap of a build genuinely mid-collection). Default
   * 4h — comfortably inside a multi-hour incident window.
   */
  limboMaxMs?: number;
}

/** Default detached-build collection grace: 1.5 × the 60s dispatch beat. */
export const DEFAULT_COLLECTION_CYCLE_MS = 90_000;

/** Default post-collection-limbo age: 4 hours. */
export const DEFAULT_LIMBO_MAX_MS = 4 * 60 * 60 * 1000;

export type DoctorAction =
  | { type: 'requeue'; item: string; attempt: number; events: LedgerEvent[] }
  | { type: 'park-breaker'; item: string; attempt: number; events: LedgerEvent[] };

export interface DoctorResult {
  orphans: ItemRecord[];
  /** Items whose alive worker was reaped as stalled (the caller must kill their pid). */
  stalled: ItemRecord[];
  actions: DoctorAction[];
}

// ---------------------------------------------------------------------------
// Ledger truncation guard
// ---------------------------------------------------------------------------

/** Ledger segment basename (e.g. `work-2026-07.jsonl`) → max event id seen in it. */
export type LedgerMaxIds = Record<string, string>;

export interface LedgerRegression {
  file: string;
  watermark: string;
  /** null when the file has disappeared entirely (not merely shrunk). */
  current: string | null;
}

export interface LedgerRegressionResult {
  regressed: boolean;
  regressions: LedgerRegression[];
  /** Watermarks to persist: advances for files at/above their prior watermark, holds for
   *  regressed files (so the incident stays visible until the file recovers past it). */
  nextWatermarks: LedgerMaxIds;
}

/**
 * Pure comparison of the ledger's current per-file max event id against the
 * last-persisted watermark. A regression (current < watermark, or the file vanished) means the
 * segment lost history since it was last observed — exactly what would let the doctor silently
 * re-dispatch already-merged items after a ledger-wipe incident: a
 * truncated file folds to a shorter-but-internally-consistent history, which looks identical to
 * "nothing new happened" from the fold's point of view. This function only detects it; the
 * caller (the regression guard) decides to halt + notify.
 */
export function detectLedgerRegression(
  segments: LedgerMaxIds,
  watermarks: LedgerMaxIds,
): LedgerRegressionResult {
  const regressions: LedgerRegression[] = [];
  const nextWatermarks: LedgerMaxIds = { ...watermarks };

  for (const [file, watermark] of Object.entries(watermarks)) {
    const current = Object.prototype.hasOwnProperty.call(segments, file) ? segments[file] : null;
    if (current === null || current < watermark) {
      regressions.push({ file, watermark, current });
    }
  }

  for (const [file, current] of Object.entries(segments)) {
    const prior = watermarks[file];
    if (prior === undefined || current > prior) {
      nextWatermarks[file] = current;
    }
  }

  return { regressed: regressions.length > 0, regressions, nextWatermarks };
}

/**
 * Probe function type — injected for testability.
 * Returns true if the pid is alive, false if dead or unknown.
 *
 * `isGroup` distinguishes the two liveness ids the doctor probes: a LEGACY synchronous build
 * records a single beat PID (probe that exact process); a DETACHED build records its process-
 * GROUP id (pgid) and must be probed as a GROUP — a live worker whose group LEADER has already
 * exited (the leader forked the real work and reaped out) still keeps the group alive, and
 * probing only the leader would misread that group as dead and orphan-reap a running build.
 */
export type PidProbe = (pid: number, isGroup?: boolean) => boolean;

/**
 * Progress probe — injected for testability. Returns the epoch-ms timestamp of the
 * most recent progress signal for a building item (newest of: last worktree commit, worker
 * log mtime, worker stderr mtime), or null when it cannot be determined — in which case the
 * doctor does NOT reap (absence of evidence is not evidence of a stall).
 */
export type ProgressProbe = (rec: ItemRecord) => number | null;

/**
 * Exit-file probe — injected for testability. Returns true when an `<WI>-a<N>.exit`
 * sentinel is present on disk for the item's current build (complete OR mid-write) — i.e. the
 * detached worker has finished/is finishing and the build is COLLECTABLE, not orphaned. The
 * reactor supplies the real one (exitfile.exitFilePresent against the runs dir); the default
 * returns false, which keeps the legacy pid-only orphan path byte-identical (no exit files exist
 * in that world). This is the pivot that closes a double-execution bug class: a finished
 * detached build must read as completed-awaiting-collection, never orphan-crash-and-requeue.
 */
export type ExitFileProbe = (rec: ItemRecord) => boolean;

/**
 * Worktree-existence probe — injected for testability. Returns true when
 * the build's worktree (rec.currentBuild.worktree) still exists on disk, false when it is
 * gone. Default returns true (present), which keeps the post-collection-limbo predicate
 * inert for every caller that doesn't inject a real filesystem check — never a false reap.
 */
export type WorktreeProbe = (rec: ItemRecord) => boolean;

/** Default worktree probe: assume present unless the caller proves otherwise. */
export function defaultWorktreeProbe(_rec: ItemRecord): boolean {
  return true;
}

/**
 * Default pid probe using process.kill(id, 0).
 *
 * For a LEGACY synchronous build (`isGroup` false/absent) this probes the single recorded beat
 * PID — while that process lives, the build lives.
 *
 * For a DETACHED build (`isGroup` true) the recorded id is a process-GROUP id (pgid, == the
 * leader's pid under setsid), and we must probe the whole GROUP, not just the leader. Signalling
 * a NEGATIVE pid targets the process group: `process.kill(-pgid, 0)` succeeds while ANY member of
 * the group is still alive. This is the correctness fix for the orphan-reap defect — a detached
 * worker whose group leader has exited but whose real build process is still running now reads as
 * ALIVE (group has a live member), instead of being misread as a dead group and orphan-reaped.
 *
 * A dead group and a dead pid both surface the same way: process.kill throws ESRCH (no such
 * process/group) → false. EPERM (exists but not signallable) counts as ALIVE — the process is
 * there, we just may not own it — which is the safe direction (never a false orphan).
 */
export function defaultPidProbe(pid: number, isGroup = false): boolean {
  try {
    process.kill(isGroup ? -pid : pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process/group exists but we lack permission to signal it → treat as ALIVE.
    if ((e as NodeJS.ErrnoException)?.code === 'EPERM') return true;
    return false;
  }
}

/** Default progress probe: no signal (null) ⇒ stall detection is inert unless the caller injects one. */
export function defaultProgressProbe(_rec: ItemRecord): number | null {
  return null;
}

/** Default exit-file probe: no exit file ⇒ collection inversion is inert (legacy behaviour). */
export function defaultExitFileProbe(_rec: ItemRecord): boolean {
  return false;
}

/**
 * Pure stall test. Returns idle/age ms when the alive build has been dispatched at
 * least stalledBuildMinutes AND has shown no progress for at least that long; else null.
 * Requires config.now and config.stalledBuildMinutes — otherwise stall detection is skipped.
 */
export function detectStall(
  rec: ItemRecord,
  config: DoctorConfig,
  progressProbe: ProgressProbe,
): { idleMs: number; ageMs: number } | null {
  const { now, stalledBuildMinutes } = config;
  if (now == null || !stalledBuildMinutes || stalledBuildMinutes <= 0) return null;
  const dispatchedAt = rec.currentBuild?.dispatchedAt;
  if (!dispatchedAt) return null;
  const stalledMs = stalledBuildMinutes * 60_000;
  const dispatchedMs = new Date(dispatchedAt).getTime();
  if (isNaN(dispatchedMs)) return null;
  const ageMs = now - dispatchedMs;
  if (ageMs < stalledMs) return null; // too young to judge — never reap a fresh build
  const lastProgress = progressProbe(rec);
  if (lastProgress == null) return null; // can't tell → don't reap
  const idleMs = now - lastProgress;
  if (idleMs < stalledMs) return null; // still making progress
  return { idleMs, ageMs };
}

/**
 * Run the doctor: find orphaned builds and generate proposed append events.
 *
 * @param result  - fold result
 * @param pidProbe - function to check if a pid is alive
 * @param config  - breaker config
 * @param actor   - actor string for generated events
 */
export function runDoctor(
  result: FoldResult,
  pidProbe: PidProbe = defaultPidProbe,
  config: DoctorConfig = { breakerN: 3 },
  actor: string = 'doctor',
  progressProbe: ProgressProbe = defaultProgressProbe,
  exitFileProbe: ExitFileProbe = defaultExitFileProbe,
  worktreeProbe: WorktreeProbe = defaultWorktreeProbe,
): DoctorResult {
  const orphans: ItemRecord[] = [];
  const stalled: ItemRecord[] = [];
  const actions: DoctorAction[] = [];

  /**
   * Build the (build.* ended) + (requeue | park-breaker) action pair shared by the orphan
   * and stall paths. `endedEvent` is the build.crashed or build.stalled event; `resumeNote`
   * is threaded into the requeue's repairContext so the relaunched worker knows the
   * prior attempt was reaped and re-checks git/tests rather than cold-starting.
   */
  const reapAction = (
    rec: ItemRecord,
    attempt: number,
    endedEvent: LedgerEvent,
    resumeNote?: string,
  ): DoctorAction => {
    // Thrashing detector: this reap's fingerprint (same derivation the fold uses — see
    // computeErrorFingerprint) against the 2 MOST RECENT already-archived builds. Only the
    // last 2 are considered (not every past crash), so an item that thrashed long ago, then
    // genuinely changed cause, is never falsely re-flagged. Fires regardless of breakerN — a
    // recurring identical cause is a distinct signal from "ran out of retries", so it must not
    // wait for (or consume) the plain retry-count cap.
    const endedStderrTail = (endedEvent.data as Record<string, unknown>)['stderrTail'];
    const endedFingerprint =
      typeof endedStderrTail === 'string' ? computeErrorFingerprint(endedStderrTail) : undefined;
    const priorTwoFingerprints = rec.builds.slice(-2).map(b => b.errorFingerprint);
    const isThrashing =
      endedFingerprint !== undefined &&
      priorTwoFingerprints.length === 2 &&
      priorTwoFingerprints.every(fp => fp === endedFingerprint);

    if (isThrashing) {
      const parkedEvent = makeEvent(actor, rec.id, 'item.parked', {
        reason: `thrashing: 3 identical fingerprints (${endedFingerprint})`,
        parkKind: 'ops',
      });
      return { type: 'park-breaker', item: rec.id, attempt, events: [endedEvent, parkedEvent] };
    }

    if (attempt >= config.breakerN) {
      const parkedEvent = makeEvent(actor, rec.id, 'item.parked', {
        reason: `breaker: ${attempt} attempts exhausted`,
        parkKind: 'ops',
      });
      return { type: 'park-breaker', item: rec.id, attempt, events: [endedEvent, parkedEvent] };
    }
    const requeuedEvent = makeEvent(actor, rec.id, 'item.queued', {
      spec: rec.spec ?? '',
      touches: rec.touches,
      model: rec.model,
      priority: rec.priority,
      ...(resumeNote ? { repairContext: resumeNote } : {}),
    });
    return { type: 'requeue', item: rec.id, attempt, events: [endedEvent, requeuedEvent] };
  };

  for (const [, rec] of result.items) {
    if (rec.state !== 'building') continue;
    if (!rec.currentBuild) continue;

    const { pid, pgid, attempt } = rec.currentBuild;

    // Liveness id: a DETACHED build records its process-GROUP id (pgid) and no beat pid,
    // because the beat exits without awaiting it; the group LEADER's pid equals the pgid under
    // setsid, so probing pgid tells us whether the group still lives. A LEGACY synchronous build
    // records the beat's own pid and no pgid. A missing id (planning-lane) means liveness is NOT
    // CHECKABLE, not dead — treating "no id" as "orphan" reaped still-running builds; stall
    // detection is the evidence-based backstop there.
    const isDetached = pgid != null;
    const livenessId = pgid ?? pid;
    // A detached build's livenessId is a process-GROUP id — probe the GROUP (isGroup=true), so a
    // live worker with a dead group leader is not misread as dead. A legacy build's livenessId is
    // a single pid — probe that process directly.
    const isDead = livenessId != null && !pidProbe(livenessId, isDetached);
    if (!isDead) {
      // Alive (or not checkable) — is it wedged? (Stall detection; inert unless config.now/probe supplied.)
      const stall = detectStall(rec, config, progressProbe);
      if (stall) {
        stalled.push(rec);
        const idleMinutes = Math.round(stall.idleMs / 60_000);
        const stalledEvent = makeEvent(actor, rec.id, 'build.stalled', {
          reason: `stalled: no progress for ${idleMinutes}m (${pgid != null ? `pgid ${pgid}` : `pid ${pid ?? 'unknown'}`} alive)`,
          idleMinutes,
          stderrTail: rec.currentBuild.stderrTail ?? '',
        });
        const resumeNote =
          `Your previous attempt (#${attempt}) stalled — no commit/log/stderr progress for ` +
          `${idleMinutes} minutes and was reaped. Re-check the current state (git status, ` +
          `build/tests) and carry the task to completion.`;
        actions.push(reapAction(rec, attempt, stalledEvent, resumeNote));
      }
      continue;
    }

    // ── Exit-file inversion (closes a double-execution bug class) ──────────────
    // The liveness id is dead. Before reaping as an orphan, ask whether the detached worker
    // left an exit sentinel: "dead group + exit-file present" = COMPLETED-AWAITING-COLLECTION,
    // NOT an orphan. The next dispatch beat's collection phase will gate/merge it; reaping it
    // here would build.crashed→requeue a build that is about to merge (double execution).
    let limboReap = false;
    if (exitFileProbe(rec)) {
      // "exit file present" only means collectable-forever when
      // collection can actually still happen. If the worktree is ALSO gone and the dispatch
      // is stale past limboMaxMs, the collector has nothing left to diff/merge from — this is
      // POST-COLLECTION-LIMBO, not awaiting collection, and must be reaped like any orphan.
      // Requires both a clock and a worktree probe; either absent defers, same fail-safe
      // contract as the collection-cycle grace below.
      const limboMs = config.limboMaxMs ?? DEFAULT_LIMBO_MAX_MS;
      const dispatchedAt = rec.currentBuild.dispatchedAt;
      const dispatchedMs = dispatchedAt ? new Date(dispatchedAt).getTime() : NaN;
      const isStale = config.now != null && !isNaN(dispatchedMs) && (config.now - dispatchedMs) >= limboMs;
      const isWorktreeGone = !worktreeProbe(rec);
      if (!(isStale && isWorktreeGone)) {
        continue; // still genuinely collectable — leave it for the collector
      }
      limboReap = true;
    }

    // Dead detached group with NO exit file yet: only an orphan once the dispatch is older than
    // one collection cycle. Inside the grace window a worker may simply not have written its exit
    // file yet (or its group briefly looks dead mid-teardown) — reaping now races the collector.
    // Requires a clock (config.now); without one we defer rather than risk a false orphan-crash.
    // Legacy synchronous builds (pgid == null) are exempt from the grace — they keep the
    // immediate dead-pid orphan behaviour, so this whole block is inert until detach lands.
    if (isDetached) {
      const graceMs = config.collectionCycleMs ?? DEFAULT_COLLECTION_CYCLE_MS;
      const dispatchedAt = rec.currentBuild.dispatchedAt;
      const dispatchedMs = dispatchedAt ? new Date(dispatchedAt).getTime() : NaN;
      const young = config.now == null || isNaN(dispatchedMs) || (config.now - dispatchedMs) < graceMs;
      if (young) continue; // too fresh (or unjudgeable) — give the worker a cycle to land its exit file
    }

    // A dead LEGACY (synchronous) beat pid means the build stopped, and reaping it here is
    // correct — but the child worker MAY have been reparented to launchd (pid 1) by a beat rotation
    // and could have committed before/while dying. The double-execution risk (requeue rebuilds work
    // an orphaned worker already committed) is handled at REQUEUE time by the reality-check
    // (branch-has-commits → merge; already-in-master → retire), not by an unreliable file-mtime
    // liveness heuristic here. So the doctor keeps its immediate dead-pid reap for legacy builds.

    orphans.push(rec);

    const stderrTail = rec.currentBuild.stderrTail ?? '';
    const crashedEvent = makeEvent(actor, rec.id, 'build.crashed', {
      reason: limboReap ? 'post-collection-limbo: exit file present but worktree gone and dispatch stale' : 'orphan-detected',
      stderrTail,
    });
    actions.push(reapAction(rec, attempt, crashedEvent));
  }

  // Second pass: items in 'routed' state with route === 'build'.
  // The routing step writes item.queued BEFORE item.routed; finding route:'build' in
  // 'routed' state means item.queued was never committed (misclassification or write
  // failure). No build was in flight, so no build.crashed needed — emit item.queued
  // directly so dispatch can pick the item up on the next beat.
  for (const [, rec] of result.items) {
    if (rec.state !== 'routed') continue;
    if (rec.route !== 'build') continue;

    orphans.push(rec);

    const requeuedEvent = makeEvent(actor, rec.id, 'item.queued', {
      spec: rec.spec ?? rec.sourceText ?? '',
      touches: rec.touches,
      model: rec.model,
      priority: rec.priority,
    });
    actions.push({
      type: 'requeue',
      item: rec.id,
      attempt: rec.attempts,
      events: [requeuedEvent],
    });
  }

  return { orphans, stalled, actions };
}

// ---------------------------------------------------------------------------
// Dist drift (self-deploy backstop)
// ---------------------------------------------------------------------------

export interface DistDriftResult {
  drifted: boolean;
  /** How far the last merge is ahead of the built dist, in ms. 0 when not drifted. */
  behindMs: number;
}

/**
 * Pure dist-drift check: a merge landed (lastMergeMs) more recently than the target's dist
 * was last built (distMtimeMs) — the beats are executing code older than what was just
 * merged (the class of incident that motivated this check: a target's `deployCommand` was
 * empty, so merges never rebuilt the dist the beats actually exec). Mirrors this file's other
 * checks — the caller supplies the real clock/mtime, this function only compares them.
 *
 * `lastMergeMs === null` (nothing has merged for this target yet) ⇒ never drifted, nothing
 * to be behind. `distMtimeMs === null` (dist doesn't exist at all) ⇒ maximally drifted, aged
 * from the merge to `now`.
 */
export function detectDistDrift(
  lastMergeMs: number | null,
  distMtimeMs: number | null,
  now: number,
): DistDriftResult {
  if (lastMergeMs == null) return { drifted: false, behindMs: 0 };
  if (distMtimeMs == null) return { drifted: true, behindMs: Math.max(0, now - lastMergeMs) };
  const behindMs = lastMergeMs - distMtimeMs;
  return behindMs > 0 ? { drifted: true, behindMs } : { drifted: false, behindMs: 0 };
}

// ---------------------------------------------------------------------------
// Stale-claim reap (ADR-007 — claim arbitration)
// ---------------------------------------------------------------------------

/**
 * THE stale-claim reap (ADR-007 "stale claims are reaped, never silently dropped") — pure,
 * no I/O. A claim never blocks a pick once it reads inactive (isClaimActive false: ttl
 * expired, or the claiming session's dead-man heartbeat gone) — that check is computed at
 * read time, nothing here changes it. But for a clean audit trail and fold hygiene, this
 * function additionally proposes an explicit `item.released` for every item whose claim
 * has been inactive for at least `reapAgeMs`, naming the reaped session and the reason.
 *
 * Deliberately conservative:
 *   - an ACTIVE claim (live session, ttl unexpired) is never reaped — isClaimActive gates it.
 *   - a claim that just went inactive (ttl freshly expired, or heartbeat freshly stale) is left
 *     alone until it clears `reapAgeMs` — the generous default (DEFAULT_CLAIM_REAP_AGE_MS)
 *     protects an operator whose heartbeat merely lagged past the dead-man bound.
 *   - a terminal-state item never carries a live claim (the fold clears it on every
 *     queued-consuming/terminal transition) — nothing to reap there; this function only ever
 *     considers `rec.claim` as folded, so it is a natural no-op on such items.
 *
 * The caller (reactor) is responsible for re-verifying the SAME inactive claim is still
 * present under the ledger lock immediately before appending — see stepDoctor — so a fresh
 * concurrent claim landing between this proposal and the append can never be erased.
 */
export function reapStaleClaims(
  result: FoldResult,
  sessions: Map<string, SessionRecord>,
  nowMs: number,
  reapAgeMs: number = DEFAULT_CLAIM_REAP_AGE_MS,
  actor: string = 'doctor',
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const [, rec] of result.items) {
    const claim = rec.claim;
    if (!claim) continue;
    if (isClaimActive(rec, sessions, nowMs)) continue;   // still active — never reaped
    const claimedMs = Date.parse(claim.claimedAt);
    if (!Number.isFinite(claimedMs)) continue;
    const ageMs = nowMs - claimedMs;
    if (ageMs < reapAgeMs) continue;   // freshly inactive — give the dead-man bound room
    events.push(makeEvent(actor, rec.id, 'item.released', {
      reason: `stale claim reaped: session ${claim.sessionId} no longer active (ttl/dead-man)`,
      sessionId: claim.sessionId,
    }));
  }
  return events;
}
