/**
 * beats/dispatch.ts — The dispatch beat (every 60s).
 *
 * Picks queued items (Touches-disjoint parallel), creates git worktrees,
 * records build.dispatched, spawns the builder provider, then on completion:
 *   - gate passed + no spine → build.finished + gate.passed + item.merged (push)
 *   - spine touched → gate.parked {reason: 'spine'}
 *   - gate red → gate.failed + item.parked
 *
 * Captures agent stderr to .ai/runs/loopkit/WI-NNN-agent.err.
 *
 * Guard: LOOPKIT_AUTONOMY=off → exit 0 immediately.
 * Lock: dispatch.lock (separate from reactor.lock — builds never block approvals).
 * --dry-run flag: print planned actions, write nothing.
 *
 * Operational invariants encoded here:
 *   - Each merge advances master → serial gate+merge (next item reads updated master).
 *   - Missing Touches = unknown footprint → conflicts with everything.
 *   - Worktree setup is serial; provider spawns run in parallel.
 *   - Spine check: diff vs merge-base, NOT HEAD-vs-branch (avoids empty-diff blind spot).
 *   - stderr is captured to a per-WI file, never discarded (crash diagnostic channel).
 *   - Breaker: N consecutive gate.failed/no-commit parks stop new dispatches.
 *   - Attempt-unique branches (wi-NNN-a<attempt>) so a re-dispatch never clobbers a
 *     prior attempt's operator-reviewable parked branch.
 */

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadAllEventsWithQuarantine, appendEvents } from '../ledger.js';
import { alreadyShippedCommit } from '../reality-check.js';
import { fold, FoldResult, ItemRecord , isClaimActive, isItemTerminal } from '../fold.js';
import { makeEvent, resolveAttachmentPaths, ItemQueuedData, LedgerEvent, MERGE_EVIDENCE_FILES_CAP } from '../schema.js';
import { loadConfig, LoopkitConfig } from '../config.js';
import { makeRegistry, makeFileHealthFns, Sensitivity, normalizeSensitivity } from '../providers/registry.js';
import { LlmProvider } from '../providers/types.js';
import { parseOutput, extractUsage } from '../providers/claudeCli.js';
import { readExitFile } from '../exitfile.js';
import { setupWorktreeDeps, fireDeployOnMerge } from './worktree-deps.js';
import { spendForDay } from '../costs.js';
import { computeQuotaPressure } from '../quota-pressure.js';
import { captureWorktreeDiff, buildJudgePrompt, runJudge } from '../judge.js';
import { runClaimAuditGate } from '../acceptance.js';
import { TargetManifest, resolveRegisteredTarget } from '../target.js';
import { captureSalvage, findSalvagePatch, applySalvagePatch, buildResumeNote } from '../salvage.js';
import { projectTrajectory } from '../trajectory.js';
import {
  bucketSpec,
  buildRoutingTableWithSpecs,
  chooseModel,
  ROUTING_CONFIG_DEFAULTS,
  mergeRoutingConfig,
} from '../routing.js';
import { commitLedgerResidue, LedgerCommitResult } from '../ledgerCommit.js';
import { checkLedgerRegressionGuard } from '../regressionGuard.js';
import { LedgerMaxIds } from '../doctor.js';
import { readEpochStampFile } from '../slo.js';
import { withLock } from '../ledger.js';
import { mintSessionId } from '../session.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max build attempts before dispatch stops picking an item autonomously.
 * Operators can override by explicitly unparking (item.unparked after item.parked).
 */
export const BUILDER_BREAKER_N = 5;

/** 32 MiB cap on output-carrying spawnSync so a verbose gate/log never truncates at
 *  Node's 1 MiB default and parks green work with a garbage reason (known ENOBUFS class). */
export const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Builder worker allowed-tools list — passed as --allowedTools to every headless build spawn.
 * Shared by BOTH build lanes (the batch lane and the target lane). A spawn that omits it gets
 * permission-prompted on every file write, and a headless session has no approver — the worker
 * then honestly parks with "no commit" instead. Every lane that spawns a headless build must
 * pass this same list; a lane that forgets it silently starves.
 */
export const BUILDER_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)',
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git checkout:*)',
  'Bash(git restore:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(grep:*)', 'Bash(sed:*)', 'Bash(find:*)',
  // git rm/mv + mkdir: move/delete-shaped slices silently no-commit without them —
  // Write/Edit can create but never delete. Worktree-isolated, so the blast radius is one branch.
  'Bash(git rm:*)', 'Bash(git mv:*)', 'Bash(mkdir:*)',
  // exec-bit repair on authored scripts (repos with core.fileMode=false) — a finished slice
  // otherwise cannot land an executable script.
  'Bash(git update-index:*)',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Phase-2 terminal-loop worker handle (ADR-008). One shape for both a freshly-spawned
 * sync/detached worker (Phase 1, this beat) and a RECONSTRUCTED handle for a detached build
 * collected from a prior beat's exit file (collectDetachedBuilds) — the Phase-2 loop treats
 * both identically (one pipeline, no second parser).
 */
export interface WorkerEntry {
  recs: ItemRecord[];   // recs[0] is the carrier (drives worktree/branch/gate/merge)
  branch: string;
  wtPath: string;
  attempt: number;      // carrier attempt number — names the evidence log
  providerPromise: Promise<{ text: string; ok: boolean; error?: string; code?: string; usage?: { in: number; out: number; usd?: number; turns?: number; durationMs?: number } }> | null;
  spawned: boolean;
  errFile: string;
  /** TRUST-HARDENING (defect c): the group-scoped provider resolved from the group's most
   *  restrictive member sensitivity — reused in Phase 2 (the judge call sends the diff to a
   *  model, so it must honor the item's tier too). Null on the parked-early paths. */
  provider: LlmProvider | null;
}

export interface DispatchOptions {
  repoRoot: string;
  ledgerDir: string;
  /**
   * Resolved run-state root for THIS plane (watermarks, locks, salvage patches,
   * manifests, worker logs, lastrun state). In plane-home mode the caller passes the run
   * dir that lives BESIDE the ledger (e.g. $LOOPKIT_HOME/runs/loopkit); when absent,
   * defaults to the embedded location under repoRoot (<repoRoot>/.ai/runs/loopkit) for
   * back-compat. Subdirectory shapes are identical either way — only the root moves.
   */
  runDir?: string;
  dryRun?: boolean;
  autonomy?: 'on' | 'off';
  /** Injected provider (for tests) */
  provider?: LlmProvider | null;
  /** Config override (for tests) */
  config?: LoopkitConfig;
  /** Injected gate command result (for tests) */
  gateResult?: { passed: boolean; reason: string; output?: string };
  /**
   * Injected runs directory for artifact writes (for tests). When provided, artifacts
   * (gate logs, diffs) are written here instead of the resolved run dir (opts.runDir or
   * the embedded <repoRoot>/.ai/runs/loopkit default); this lets tests redirect to a
   * temp dir they control.
   */
  artifactRunsDir?: string;
  /** Injected current-branch probe (for tests). Defaults to `git branch --show-current`. */
  branchProbe?: (repoRoot: string) => string;
  /** Injected reactor-lock age probe (for tests) — seconds, or undefined when no lock. */
  reactorLockAgeSec?: () => number | undefined;
  /**
   * Injected reactor lastrun probe (for tests). Returns epoch seconds or undefined.
   * When absent, reads .ai/runs/reactor/lastrun from repoRoot.
   */
  reactorLastrunProbe?: () => number | undefined;
  /**
   * Injected reactor mid-beat heartbeat probe (for tests). Returns epoch seconds or
   * undefined. When absent, reads the reactor's `heartbeat` stamp beside its lastrun.
   */
  reactorHeartbeatProbe?: () => number | undefined;
  /**
   * Injected spawn for the cross-beat watchdog kickstart (for tests).
   */
  watchdogSpawn?: (cmd: string, args: string[]) => { ok: boolean; output: string };
  /**
   * Injected auth probe result (for tests). When absent, dispatch probes via
   * provider.run({prompt:'ping', timeoutMs:15_000}) before touching any item.
   */
  authProbeResult?: { ok: boolean };
  /**
   * Injected changed-files list for touches enforcement + spine check (for tests).
   * When provided, skips the `git diff --name-only` call in Phase 2.
   */
  touchesDiffFiles?: string[];
  /**
   * Injected scout provider result map for tests.
   * Keys are WI-NNN ids. When present, the real scout provider.run is skipped for that item.
   * Set to { ok: false, error: '...', code: 'unknown' } to simulate scout failure.
   */
  scoutResults?: Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } }>;
  /**
   * Injected scout-enabled override for tests. When set, overrides cfg.scout.enabled.
   */
  scoutEnabled?: boolean;
  /**
   * Injected push result (for tests). When provided, skips the real `git push` call.
   * Return `{ status: 0 }` to simulate success, `{ status: 1, stderr: '...' }` to simulate failure.
   */
  pushProbe?: () => { status: number | null; stderr?: Buffer | null };
  /**
   * Injected post-integration gate result (for tests). When provided, used as the
   * gate result after the rebase when master advanced since the branch was cut.
   * Leave unset to run the real gate command.
   */
  postIntegrationGateResult?: { passed: boolean; reason: string; output?: string };
  /**
   * Injected re-gate result (for tests) for the non-FF push-recovery path — used when the
   * push to origin is rejected because master advanced again between the merge and the push.
   * Leave unset to run the real gate command.
   */
  nonFfGateResult?: { passed: boolean; reason: string; output?: string };
  /**
   * Injected judge results map for tests.
   * Keys are WI-NNN ids. When present, the real judge provider.run is skipped for that item.
   * Set to { ok: false, error: '...', code: 'unknown' } to simulate judge failure (fail-open).
   * Set to { ok: true, text: '...' } to inject a specific judge response.
   * Set to null to simulate judge disabled for that item (no event, proceed).
   */
  judgeResults?: Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number; turns?: number; durationMs?: number } } | null>;
  /**
   * Injected judge-enabled override for tests. When set, overrides cfg.judge.enabled.
   */
  judgeEnabled?: boolean;

  /**
   * Injected health marker read function for tests.
   * When absent, uses file-based markers in .ai/runs/loopkit.
   */
  readMarker?: import('../providers/registry.js').ReadMarkerFn;
  /**
   * Injected health marker write function for tests.
   */
  writeMarker?: import('../providers/registry.js').WriteMarkerFn;
  /**
   * Injected health marker clear function for tests.
   */
  clearMarker?: import('../providers/registry.js').ClearMarkerFn;

  /**
   * Injected salvage enabled override for tests.
   * When set, overrides cfg.salvage.enabled.
   */
  salvageEnabled?: boolean;

  /**
   * Injected salvage capture function for tests.
   * When provided, replaces the real captureSalvage call at interruption sites.
   * Signature mirrors captureSalvage (wtPath, itemId, attempt, runDir, reason, cfg, logPath).
   */
  salvageCapture?: typeof import('../salvage.js').captureSalvage;

  /**
   * Injected RNG for model routing exploration.
   * When provided, replaces Math.random in chooseModel so tests are deterministic.
   * Defaults to Math.random when absent (real dispatch).
   */
  routingRand?: () => number;

  /**
   * Injected routing enabled override for tests.
   * When set, overrides cfg.routing.mode. Pass 'off' to disable routing in tests
   * that don't care about it.
   */
  routingMode?: 'off' | 'advisory' | 'active';

  /**
   * Run-controls hard-stop: poll interval, ms, for
   * the in-beat cancel check wired into provider.run's cancelCheck. Default 20_000
   * (~15-30s). Tests override this to a small value so a fake provider can synchronously observe
   * a cancel-requested without a real wall-clock wait.
   */
  cancelPollIntervalMs?: number;

  /**
   * Injected notify for tests — same contract as ReactorOptions.notify:
   * return `false` to simulate a total-transport failure, void/true for delivered. When absent,
   * the real `.ai/notify-phone.sh` hook runs.
   */
  notify?: (message: string) => void | boolean;
  /**
   * Injected ledger max-id probe for the regression guard (for
   * tests). When absent, the real ledger files under `ledgerDir` are read.
   */
  ledgerMaxIdsProbe?: (ledgerDir: string) => Promise<LedgerMaxIds>;
  /**
   * Injected commit-residue function (for tests). When absent, the
   * real `git add`/`git commit` scoped to `.ai/ledger/` runs. Never `git add -A`.
   */
  commitResidue?: (repoRoot: string, ledgerDir: string, label: string) => LedgerCommitResult;
  /**
   * Injected quota-pressure override for tests. When provided, replaces the real
   * computeQuotaPressure(allEvents, cfg.quotaPressure?.thresholdPct) call — return `true` to
   * simulate degraded mode without faking quota.snapshot events, `false` for healthy.
   */
  quotaPressureProbe?: () => boolean;
  /**
   * Injected dispatch pseudo-session id (ADR-007 claim-before-pick, for tests). When absent,
   * a fresh id is minted per run via mintSessionId() — the ADR-007 "per-run, not
   * permanent-shared" identity. Tests that need a deterministic non-judge event sequence
   * across independent runs (comparing event TYPES, which include the session-addressed
   * session.started/session.heartbeat/item.claimed envelope `item` = sessionId) pin this.
   */
  dispatchSessionId?: string;
}

export interface DispatchStepResult {
  item: string;
  dispatched: boolean;
  branch?: string;
  worktree?: string;
  pid?: number;
  gateOutcome?: 'passed' | 'failed' | 'parked-spine' | 'dry-run' | 'deferred' | 'dispatched';
  eventsWritten: number;
  detail?: string;
}

export interface DispatchResult {
  dryRun: boolean;
  dispatched: DispatchStepResult[];
  totalEventsWritten: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Claim-before-pick (ADR-007): the pure yield/keep decision
// ---------------------------------------------------------------------------

/** One item's claim-arbitration outcome against a fresh re-fold under the ledger lock. */
export interface ClaimArbitrationDecision {
  item: string;
  /** true = dispatch may build it; false = a foreign session's active claim or in-flight build wins. */
  keep: boolean;
  /** Present only when keep is false for a foreign CLAIM — the foreign session's id, for the detail. */
  foreignSessionId?: string;
  /** True when keep is false because a foreign in-flight build already holds the item (no claim). */
  foreignBuild?: boolean;
}

/**
 * THE claim-before-pick decision (ADR-007 gap 1 + WI-074 companion) — pure, no I/O. Given a
 * re-folded FoldResult (re-read under the ledger lock, AFTER the picker's own read), decide for
 * each candidate item whether dispatch keeps it or yields.
 *
 * An item YIELDS iff, in this fresh re-fold, EITHER:
 *   (a) it carries an active claim (isClaimActive) whose sessionId is NOT `dispatchSessionId` —
 *       an attended operator session claimed it in the read-to-arbitrate window; OR
 *   (b) it is already 'building' with a RECENT build.dispatched (WI-074): at claim-arbitration
 *       time dispatch has not yet appended its own build.dispatched this beat, so a candidate
 *       that is already building was transitioned by a FOREIGN actor (an attended fast-drain
 *       session, or a parallel beat) in that same window. Building it too would double-deliver.
 *       Only a RECENT build blocks (within `buildStaleMs`): a STALE building record is a reapable
 *       orphan the doctor owns and must not permanently block takeover.
 *
 * An item dispatch already claimed itself (a prior beat's claim renewed, or none at all) is KEPT.
 * This is the one place the yield decision lives — runDispatch and its tests both call this, so
 * it can never drift from what actually gets appended.
 */
export function decideClaimArbitration(
  candidateIds: string[],
  freshResult: FoldResult,
  dispatchSessionId: string,
  nowMs: number,
  buildStaleMs: number,
): ClaimArbitrationDecision[] {
  return candidateIds.map(id => {
    const rec2 = freshResult.items.get(id);
    // Item vanished from the fold entirely (shouldn't happen for a just-queued item) — keep,
    // nothing foreign to yield to.
    if (!rec2) return { item: id, keep: true };
    if (isClaimActive(rec2, freshResult.sessions, nowMs) && rec2.claim!.sessionId !== dispatchSessionId) {
      return { item: id, keep: false, foreignSessionId: rec2.claim!.sessionId };
    }
    // (b) foreign in-flight build — a recent build.dispatched by someone else.
    if (rec2.state === 'building' && rec2.buildingAt) {
      const buildingMs = Date.parse(rec2.buildingAt);
      if (Number.isFinite(buildingMs) && nowMs - buildingMs <= buildStaleMs) {
        return { item: id, keep: false, foreignBuild: true };
      }
    }
    return { item: id, keep: true };
  });
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

const LOCK_SUBDIR = 'dispatch.lock';

/** Probe whether the lock's owning beat process is still alive. Returns true (alive),
 *  false (provably dead — ESRCH), or null (no/unreadable pid file → stale acquisition
 *  residue: an interrupted beat that died between mkdir and the pid stamp).
 *  Shared with the reactor's lock — one liveness predicate, never a second copy. */
export function beatLockOwnerAlive(lockPath: string): boolean | null {
  try {
    const owner = parseInt(readFileSync(join(lockPath, 'pid'), 'utf8').trim(), 10);
    if (!Number.isFinite(owner)) return null;
    try { process.kill(owner, 0); return true; } // signal 0 = liveness probe, no signal sent
    catch { return false; }                       // ESRCH → owner is gone
  } catch { return null; }                         // no pid file (interrupted acquisition)
}

/** Result of a successful lock acquisition. `reclaimed` is set when a stale lock (dead or
 *  missing owner pid, or wedged by age) was removed first — surfaced in the beat detail. */
export interface BeatLockAcquisition {
  lockPath: string;
  reclaimed: boolean;
  reclaimedWhy?: string;
}

/** @internal exported for tests */
export function acquireDispatchLock(runDir: string, wedgeMs: number): BeatLockAcquisition | null {
  const lockPath = join(runDir, LOCK_SUBDIR);
  const stampPid = () => { try { writeFileSync(join(lockPath, 'pid'), String(process.pid), 'utf8'); } catch { /* best-effort */ } };
  try {
    mkdirSync(lockPath, { recursive: false });
    stampPid();
    return { lockPath, reclaimed: false };
  } catch {
    // The lock exists. A SIGKILL'd/SIGTERM'd beat never runs releaseDispatchLock (the finally is
    // skipped), so its lock lingers and every later beat no-ops. Three stale signals, probed in
    // the acquire path itself (a wedged beat can't run its own doctor):
    //   • dead owner pid — reclaimed the next beat (~30-60s), no waiting out the age heuristic;
    //   • NO readable pid file — an interrupted beat (kill/crash between mkdir and the pid
    //     stamp) leaves an empty lock dir that would otherwise wedge the lane forever;
    //   • the age threshold (buildTimeoutMinutes + 5 min slack) as the fallback for pid REUSE
    //     (owner looks alive but the lock is older than any legitimate build could run).
    const ownerAlive = beatLockOwnerAlive(lockPath);
    try {
      const st = statSync(lockPath);
      const wedgedByAge = Date.now() - st.mtimeMs > wedgeMs;
      if (ownerAlive !== true || wedgedByAge) {
        const why = ownerAlive === false ? 'owner pid dead'
          : ownerAlive === null ? 'no readable owner pid'
          : 'wedged by age';
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath, { recursive: false });
        stampPid();
        return { lockPath, reclaimed: true, reclaimedWhy: why };
      }
    } catch { /* raced or unreadable — treat as held */ }
    return null;
  }
}

function releaseDispatchLock(lockPath: string): void {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Mid-beat heartbeat
// ---------------------------------------------------------------------------

/**
 * Refresh a beat's mid-beat heartbeat stamp (`<runs>/<beat>/heartbeat`, epoch seconds —
 * the SAME stamp format as lastrun, read back by slo.ts readEpochStampFile: ONE format,
 * one parser). The beats call this BETWEEN work items in a long beat: lastrun is written
 * only at beat start, so a beat legitimately draining many items would otherwise read as
 * stale/dead to the staleness probe — which once kickstarted (killed) a live build
 * mid-beat. A truly frozen beat stops refreshing this stamp, so wedge detection survives.
 * Best-effort, never throws — a liveness stamp must not fail a build.
 */
export function writeBeatHeartbeat(runDir: string, beat: 'reactor' | 'dispatch'): void {
  try {
    const dir = join(dirname(runDir), beat);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat'), String(Math.floor(Date.now() / 1000)), 'utf8');
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Touches conflict detection
// ---------------------------------------------------------------------------

// Touches parsing/matching lives in ONE shared module — re-exported here so
// existing importers (cli.ts, projections) keep working.
import { normalizeTouches, touchesSegmentMatch, touchesConflict } from '../touches.js';
export { normalizeTouches, touchesSegmentMatch, touchesConflict };

// ---------------------------------------------------------------------------
// Batch co-location — group SMALL, Touches-overlapping items into one worktree
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = {
  blocker: 0, high: 1, medium: 2, low: 3,
};

/** Max spec length (chars) for a co-located batch item — bigger specs run alone. */
const BATCH_SPEC_MAX = 1500;

/**
 * Batch-eligible = SMALL and routine enough to share a worker run: sonnet model,
 * priority no more urgent than 'high' (blockers run isolated), bounded spec.
 */
export function isBatchEligible(rec: ItemRecord): boolean {
  const spec = rec.spec ?? '';
  const model = rec.model ?? 'sonnet'; // builder default is sonnet
  const rank = PRIORITY_ORDER[rec.priority ?? 'medium'] ?? 2;
  return model === 'sonnet'
    && rank >= PRIORITY_ORDER['high']   // excludes blocker (rank 0)
    && spec.length > 0 && spec.length < BATCH_SPEC_MAX;
}

/**
 * TRUST-HARDENING (defect c): the MOST RESTRICTIVE sensitivity across a co-located build group.
 * A batch worktree shares ONE worker process (one prompt carries every member's spec + the
 * shared diff), so the group must be routed under the strictest member's tier — routing a
 * batch containing a 'private' item through an 'internal' provider would leak it. Ordering:
 * private > internal > public. Each member's raw sensitivity is normalized fail-closed
 * (unknown/garbage → 'private') before the max is taken.
 */
const SENSITIVITY_RESTRICTION: Record<Sensitivity, number> = { public: 0, internal: 1, private: 2 };

export function groupSensitivity(recs: ItemRecord[]): Sensitivity {
  return groupSensitivityFor(recs);
}

/** A single item's sensitivity, normalized fail-closed (unknown/garbage → 'private'). */
export function itemSensitivity(rec: ItemRecord): Sensitivity {
  return normalizeSensitivity(rec.sensitivity ?? 'internal');
}

function groupSensitivityFor(recs: ItemRecord[]): Sensitivity {
  let worst: Sensitivity = 'public';
  for (const r of recs) {
    const s = itemSensitivity(r);
    if (SENSITIVITY_RESTRICTION[s] > SENSITIVITY_RESTRICTION[worst]) worst = s;
  }
  return worst;
}

/**
 * TRUST-HARDENING (defect: sensitivity bypass at content-bearing call sites): the ONE fail-closed
 * per-item/group provider resolver every content-bearing lane must use. Resolving through the
 * beat-global `internal` provider would send a private-only item's spec/diff/thread to whatever the
 * internal chain returns (an external provider by default) — the bypass the trust-boundary doc
 * claimed was closed "at every routing and build call site."
 *
 * Contract:
 *   - With a registry (production): resolve against the item's/group's own sensitivity tier,
 *     fail-closed — a private-only item whose tier has no allowed+healthy provider returns `null`,
 *     and the caller MUST park it rather than route it through the beat-global provider.
 *   - Without a registry (injected-provider test path): the caller's single `fallback` provider is
 *     used unchanged (fixtures are default-internal, so this can never widen a private item's reach).
 *
 * @param registry the beat's provider registry, or null on the injected-provider test path
 * @param fallback the beat-global provider to use only when there is no registry
 * @param sensitivity the item's (or group's) resolved sensitivity tier
 * @param opts resolveWithHealth options (e.g. { requireTools: true } for agentic build lanes)
 */
export function resolveProviderForSensitivity(
  registry: ReturnType<typeof makeRegistry> | null,
  fallback: LlmProvider | null,
  sensitivity: Sensitivity,
  opts: { requireTools?: boolean } = {},
): LlmProvider | null {
  if (!registry) return fallback;
  return registry.resolveWithHealth(sensitivity, opts);
}

/** Union of a group's declared Touches, or '*' if any member is undeclared (wildcard). */
function groupTouches(recs: ItemRecord[]): string | undefined {
  let t: string | undefined;
  for (const r of recs) {
    if (!r.touches) return '*';
    t = t ? `${t},${r.touches}` : r.touches;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Run-controls hard-stop — attempt-matched
// cancel-requested lookup. A pure scan over the raw event stream (not the fold, which
// intentionally treats build.cancel-requested as a no-op): a cancel-requested event only
// counts as "pending" for the EXACT attempt it named, and only until a terminal event for
// that same attempt (build.cancelled / build.crashed / build.stalled / item.merged / a later
// build.dispatched superseding it) has already been recorded. This is what makes a
// cancel-requested for attempt N a no-op once attempt N+1 is dispatched (the attempt-matching
// race the contract calls out) — re-reading the tail each poll means a stale request can never
// kill a newer, unrelated attempt.
// ---------------------------------------------------------------------------

/**
 * True when `itemId`'s ledger tail has an unconsumed build.cancel-requested targeting
 * exactly `attempt`. "Unconsumed" = no later event for the same item that would settle it
 * (a terminal build.* event, a fresh build.dispatched for a different attempt, or an
 * item.merged). Pure function over already-loaded events — callers re-read the ledger tail
 * on each poll/pre-dispatch check so a cancel request is observed within one poll interval.
 */
export function hasUnconsumedCancelRequest(
  events: LedgerEvent[],
  itemId: string,
  attempt: number,
): boolean {
  let pending = false;
  for (const ev of events) {
    if (ev.item !== itemId) continue;
    const d = ev.data as Record<string, unknown>;
    if (ev.type === 'build.cancel-requested' && typeof d['attempt'] === 'number' && d['attempt'] === attempt) {
      pending = true;
      continue;
    }
    if (pending && (
      (ev.type === 'build.cancelled' && d['attempt'] === attempt) ||
      (ev.type === 'build.crashed') ||
      (ev.type === 'build.stalled') ||
      (ev.type === 'build.dispatched' && d['attempt'] !== attempt) ||
      ev.type === 'item.merged'
    )) {
      pending = false;
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Gate runner
// ---------------------------------------------------------------------------

function runGate(
  gateCommand: string,
  gateWorkdir: string,
  wtPath: string,
  dryRun: boolean,
  baseSha?: string,
): { passed: boolean; reason: string; output: string } {
  if (dryRun) return { passed: true, reason: 'dry-run', output: '' };
  const cwd = resolve(wtPath, gateWorkdir);
  // Hand the gate an EXPLICIT diff base so a gate script scopes its per-package
  // suites off GATE_BASE_SHA..HEAD instead of ref-name heuristics that mis-scope in a
  // detached worktree. Harmless for a plain `npm test` gate command (ignores the var).
  // Env hygiene: the gate runs TARGET code — it must never inherit the PLANE's own
  // identity vars (LOOPKIT_HOME/LOOPKIT_LEDGER from the beat shim), or every target
  // test that reads its repo-local config gets hijacked by the plane's config. This
  // parked a green framework build: 43 config-fixture tests failed only under the
  // beat's exported LOOPKIT_HOME.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['LOOPKIT_HOME'];
  delete env['LOOPKIT_LEDGER'];
  if (baseSha) env['GATE_BASE_SHA'] = baseSha;
  const result = spawnSync('sh', ['-c', gateCommand], {
    cwd,
    env,
    stdio: 'pipe',
    timeout: 5 * 60 * 1000,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  // Combined stdout + stderr tail — persisted as the gate log artifact on failure.
  const combined = ((result.stdout?.toString() ?? '') + '\n' + (result.stderr?.toString() ?? '')).trim();
  if (result.status === 0) return { passed: true, reason: 'tests green', output: combined };
  // A stdout-only failure (e.g. plain `npm test` red output) must stay visible here — the
  // reason must never be built from stderr alone, or a red run with only stdout output
  // reports as an unexplained non-zero exit.
  const tail = combined.slice(-800);
  return { passed: false, reason: `gate exited ${result.status}: ${tail}`, output: combined };
}

/**
 * The item's delivery lane picks its definition-of-done gate. Absent lane
 * config or an unrecognized gate id both fall back to `npm test` — the default
 * engineering lane is unchanged. Only 'claim-audit' currently diverges.
 */
function resolveGateId(cfg: LoopkitConfig, lane: string): string {
  return cfg.lanes?.[lane]?.gate ?? 'npm test';
}

/**
 * Lane-aware gate dispatcher. Engineering (gate id 'npm test', the default)
 * runs the existing shell gate unchanged. Non-code lanes (gate id 'claim-audit') skip
 * `npm test` and run the claim-audit rubric instead (acceptance.ts, reused deterministic
 * guards). Both return the identical `{ passed, reason, output }` shape, so every caller
 * downstream (gate.passed/gate.failed events, merge/park logic) is untouched by which
 * gate ran.
 */
function runLaneGate(
  gateId: string,
  cfg: LoopkitConfig,
  wtPath: string,
  dryRun: boolean,
  baseSha: string | undefined,
  changedFiles: string[],
): { passed: boolean; reason: string; output: string } {
  if (gateId === 'claim-audit') {
    if (dryRun) return { passed: true, reason: 'dry-run', output: '' };
    return runClaimAuditGate(changedFiles, {
      surfacePrefixes: cfg.acceptance?.tiers?.surfacePrefixes ?? [],
      planePrefixes: cfg.autoApprove.planePrefixes,
      riskPatterns: cfg.autoApprove.escalationPatterns,
    });
  }
  return runGate(cfg.gateCommand, cfg.gateWorkdir, wtPath, dryRun, baseSha);
}

// ---------------------------------------------------------------------------
// Changed-files helper
// ---------------------------------------------------------------------------

export function getChangedFiles(wtPath: string, mergeBase: string): string[] {
  if (!mergeBase) return [];
  const diffResult = spawnSync('git', ['diff', '--name-only', `${mergeBase}..HEAD`], {
    cwd: wtPath, stdio: 'pipe', maxBuffer: SPAWN_MAX_BUFFER,
  });
  return diffResult.stdout.toString().trim().split('\n').filter(Boolean);
}

/**
 * TRUST-HARDENING: build the additive actual-diff evidence fields for an item.merged event.
 * `changedFiles` is capped at MERGE_EVIDENCE_FILES_CAP entries (with changedFilesTruncated set
 * beyond) so a huge merge never trips the oversized-event guard. Returns a partial object spread
 * into each item.merged; the acceptance tier later classifies from `changedFiles` rather than the
 * item's declared touches, closing the "empty touches → auto" hole.
 */
export function mergeEvidence(
  baseSha: string | undefined,
  headSha: string | undefined,
  changedFiles: string[],
  gateCommand: string,
): Partial<import('../schema.js').ItemMergedData> {
  const capped = changedFiles.slice(0, MERGE_EVIDENCE_FILES_CAP);
  const out: Partial<import('../schema.js').ItemMergedData> = {
    changedFiles: capped,
    ...(baseSha ? { baseSha } : {}),
    ...(headSha ? { headSha } : {}),
    ...(gateCommand ? { gateCommand } : {}),
  };
  if (changedFiles.length > MERGE_EVIDENCE_FILES_CAP) out.changedFilesTruncated = true;
  return out;
}

/**
 * Remove a build worktree, falling back to `rm -rf` + `git worktree prune` when
 * `git worktree remove --force` fails. A failed remove leaks the per-item build tree
 * with a heavy real-dir node_modules overlay, so every removal path must use this
 * rm-then-prune fallback or worktrees silently accumulate on disk.
 * Best-effort throughout — never throws.
 */
export function removeWorktree(repoRoot: string, wtPath: string): void {
  const removed = spawnSync('git', ['worktree', 'remove', wtPath, '--force'],
    { cwd: repoRoot, stdio: 'pipe' });
  if (removed.status !== 0) {
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// Worker evidence + worktree verification
// ---------------------------------------------------------------------------

/**
 * Persist the worker's final output (last ~100 lines) to
 * `.ai/runs/loopkit/<WI>-attempt-<N>.log` and return the log path. Called on EVERY
 * terminal path — a no-commit / dirty-tree park used to leave zero evidence. The
 * text is the provider's success output or its error string, whichever is present.
 */
function persistWorkerLog(
  runDir: string,
  itemId: string,
  attempt: number,
  output: string,
): string {
  const logPath = join(runDir, `${itemId}-attempt-${attempt}.log`);
  try {
    const tail = output.split('\n').slice(-100).join('\n');
    writeFileSync(logPath, tail, 'utf8');
  } catch { /* best-effort evidence — never block a terminal path */ }
  return logPath;
}

// Gate output cap: last ~6000 chars of combined stdout+stderr.
const GATE_LOG_CAP = 6_000;
// Diff cap: stat + patch, hard-capped at ~12000 chars.
// Used by persistDiff (repair evidence) — the judge uses its own cap from config.
const DIFF_CAP = 12_000;

/**
 * Persist the gate's combined output (last ~6000 chars) to
 * `.ai/runs/loopkit/<WI>-attempt-<N>.gate.log`. Best-effort; never throws.
 * Called on tests-red paths only — a pass does not write an artifact.
 */
function persistGateLog(
  runDir: string,
  itemId: string,
  attempt: number,
  output: string,
): void {
  const logPath = join(runDir, `${itemId}-attempt-${attempt}.gate.log`);
  try {
    const tail = output.length > GATE_LOG_CAP ? output.slice(-GATE_LOG_CAP) : output;
    writeFileSync(logPath, tail, 'utf8');
  } catch (e) {
    process.stderr.write(`[dispatch] artifact: failed to write gate log ${logPath}: ${e}\n`);
  }
}

/**
 * Persist `git diff <mergeBase>..HEAD` (--stat + patch) from the worktree to
 * `.ai/runs/loopkit/<WI>-attempt-<N>.diff`. Hard-capped at ~12000 chars.
 * Best-effort; never throws. Not called when there is no commit (no diff to capture).
 * Uses the shared captureWorktreeDiff helper (judge.ts) to avoid duplicating diff logic.
 */
function persistDiff(
  runDir: string,
  itemId: string,
  attempt: number,
  wtPath: string,
  mergeBase: string,
): void {
  const diffPath = join(runDir, `${itemId}-attempt-${attempt}.diff`);
  try {
    const content = captureWorktreeDiff(wtPath, mergeBase, DIFF_CAP);
    writeFileSync(diffPath, content, 'utf8');
  } catch (e) {
    process.stderr.write(`[dispatch] artifact: failed to write diff ${diffPath}: ${e}\n`);
  }
}

// Repair evidence section caps: total ~16000 chars; diff gets first priority.
const REPAIR_EVIDENCE_DIFF_MAX = 10_000;
const REPAIR_EVIDENCE_GATE_MAX = 6_000;
const REPAIR_CRITIQUE_INSTRUCTION = `REPAIR EVIDENCE — a prior attempt failed. Before writing any code: state in 2–4 sentences your diagnosis of WHY it failed, based on the evidence below. Then fix the ROOT CAUSE. Do not re-apply the same diff unchanged; if you conclude the prior approach was fundamentally right and only a detail was wrong, say so explicitly and fix the detail.`;

/**
 * Assemble a REPAIR EVIDENCE section for a retry prompt. Looks for the highest prior
 * attempt N that has artifacts on disk. Fail-open: when no artifacts exist, returns
 * undefined so the caller builds a cold prompt. Cap: ~16000 chars total.
 *
 * @param runDir  - the .ai/runs/loopkit directory
 * @param itemId  - WI-NNN
 * @param currentAttempt - the attempt number about to be dispatched (N+1)
 * @param repairContext  - existing repairContext string from the item fold (optional)
 */
export function assembleRepairEvidence(
  runDir: string,
  itemId: string,
  currentAttempt: number,
  repairContext?: string,
): string | undefined {
  // Walk from the highest prior attempt down to 1, pick the first with any artifact.
  for (let n = currentAttempt - 1; n >= 1; n--) {
    const diffPath = join(runDir, `${itemId}-attempt-${n}.diff`);
    const gatePath = join(runDir, `${itemId}-attempt-${n}.gate.log`);

    let diffText: string | undefined;
    let gateText: string | undefined;

    try {
      if (existsSync(diffPath)) diffText = readFileSync(diffPath, 'utf8');
    } catch { /* best-effort */ }
    try {
      if (existsSync(gatePath)) gateText = readFileSync(gatePath, 'utf8');
    } catch { /* best-effort */ }

    if (!diffText && !gateText) continue; // try a lower attempt number

    // Cap each piece proportionally (diff gets priority)
    const cappedDiff = diffText ? (diffText.length > REPAIR_EVIDENCE_DIFF_MAX ? diffText.slice(0, REPAIR_EVIDENCE_DIFF_MAX) + '\n[diff truncated]' : diffText) : undefined;
    const cappedGate = gateText ? (gateText.length > REPAIR_EVIDENCE_GATE_MAX ? gateText.slice(-REPAIR_EVIDENCE_GATE_MAX) : gateText) : undefined;

    const parts: string[] = [REPAIR_CRITIQUE_INSTRUCTION];
    if (cappedDiff) {
      parts.push(`\n--- diff from prior attempt ${n} (${itemId}) ---\n${cappedDiff}\n--- end diff ---`);
    }
    if (cappedGate) {
      parts.push(`\n--- gate output from prior attempt ${n} (${itemId}) ---\n${cappedGate}\n--- end gate output ---`);
    }
    if (repairContext) {
      parts.push(`\n--- prior repair context ---\n${repairContext}\n--- end prior repair context ---`);
    }

    return parts.join('\n');
  }
  return undefined; // no artifacts found — fail-open, prompt built cold
}

/**
 * Verify the worktree is in a mergeable shape after the worker exits: still on the
 * expected branch AND a clean tree (no uncommitted changes). A dirty tree means the
 * worker left work uncommitted (would be lost on merge); a wrong branch means it
 * checked something else out. Either is a no-commit-shaped failure, not a green build.
 * Returns null when clean, or a human-readable reason string when not.
 */
/** Dependency plumbing is never work product. setupWorktreeDeps provisions node_modules
 *  as SYMLINKS, and gitignore's dir-only `node_modules/` pattern does not match symlinks —
 *  so they surface as `??` in porcelain and would otherwise wrongly park a green committed build. */
export function isDependencyPlumbing(porcelainLine: string): boolean {
  const p = porcelainLine.slice(3).trim();
  return p === 'node_modules' || p === 'node_modules/' ||
    p.endsWith('/node_modules') || p.endsWith('/node_modules/') ||
    p.startsWith('node_modules/') || p.includes('/node_modules/');
}

/**
 * Worker manifests are left at the worktree root by the worker and must
 * not trigger the dirty-tree gate. They are never committed (excluded by root .gitignore),
 * so fixture repos that lack the root gitignore need this exemption as defence-in-depth.
 */
export function isWorkerManifest(porcelainLine: string): boolean {
  const p = porcelainLine.slice(3).trim();
  return /^MANIFEST-WI-[A-Za-z0-9-]+\.json$/.test(p);
}

function verifyWorktreeState(wtPath: string, expectedBranch: string): string | null {
  const cur = spawnSync('git', ['branch', '--show-current'], { cwd: wtPath, stdio: 'pipe' });
  const branch = cur.status === 0 ? cur.stdout.toString().trim() : '';
  if (branch !== expectedBranch) {
    return `worktree on '${branch || '(detached)'}' not the expected build branch '${expectedBranch}'`;
  }
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: wtPath, stdio: 'pipe', maxBuffer: SPAWN_MAX_BUFFER });
  const dirty = st.stdout.toString().trim()
    .split('\n')
    .filter(Boolean)
    .filter(l => !isDependencyPlumbing(l))
    .filter(l => !isWorkerManifest(l))
    .join('\n');
  if (dirty) {
    const firstLines = dirty.split('\n').slice(0, 5).join('; ');
    return `worktree has uncommitted changes (work would be lost on merge): ${firstLines}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker manifests
// ---------------------------------------------------------------------------

/**
 * Certify-don't-brief payload (leader-leader doctrine — "a certification of understanding,
 * not an assertion of completion"): what could break, the detection signal, and the rollback
 * path. Optional on the manifest — absent entirely when the worker didn't fill it in, never a
 * partially-filled block (see {@link parseManifest}'s all-or-nothing extraction).
 */
export interface WorkerCertification {
  couldBreak: string;
  detection: string;
  rollback: string;
}

/**
 * Structured self-report written by the worker to the worktree root.
 * Never committed; copied to `.ai/runs/loopkit/<WI>-attempt-<N>.manifest.json` for evidence.
 */
export interface WorkerManifest {
  wi: string;
  filesTouched: string[];
  testsAdded: string[];
  /** Honest self-assessment [0, 1] that the spec is fully satisfied. Data only — not a gate. */
  confidence: number;
  notes: string;
  /** Certify-don't-brief payload (see {@link WorkerCertification}). Optional — absent when the
   *  worker's manifest didn't supply all three fields. */
  certification?: WorkerCertification;
}

/**
 * Lenient parser for a MANIFEST-WI-*.json file written by a worker.
 * Missing or wrong-typed fields are defaulted; confidence is clamped to [0, 1].
 * Returns null on JSON parse failure or if the result is clearly not a manifest object.
 */
export function parseManifest(text: string): WorkerManifest | null {
  try {
    const raw = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const wi = typeof raw.wi === 'string' ? raw.wi : '';
    const filesTouched = Array.isArray(raw.filesTouched)
      ? raw.filesTouched.filter((x: unknown) => typeof x === 'string')
      : [];
    const testsAdded = Array.isArray(raw.testsAdded)
      ? raw.testsAdded.filter((x: unknown) => typeof x === 'string')
      : [];
    const rawConf = typeof raw.confidence === 'number' ? raw.confidence : 0;
    const confidence = Math.max(0, Math.min(1, rawConf));
    const notes = typeof raw.notes === 'string' ? raw.notes : '';
    const certification = parseWorkerCertification(raw.certification);
    return { wi, filesTouched, testsAdded, confidence, notes, ...(certification ? { certification } : {}) };
  } catch {
    return null;
  }
}

/** All-or-nothing extraction of the manifest's optional certification block — a shape with
 *  any field missing/wrong-typed folds to `undefined` rather than a half-filled report. */
function parseWorkerCertification(raw: unknown): WorkerCertification | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const couldBreak = typeof r['couldBreak'] === 'string' ? r['couldBreak'] : '';
  const detection = typeof r['detection'] === 'string' ? r['detection'] : '';
  const rollback = typeof r['rollback'] === 'string' ? r['rollback'] : '';
  if (!couldBreak || !detection || !rollback) return undefined;
  return { couldBreak, detection, rollback };
}

// ---------------------------------------------------------------------------
// Spine check (accepts pre-computed file list)
// ---------------------------------------------------------------------------

function checkSpine(spineRegex: string, changedFiles: string[]): { touched: boolean; files: string[] } {
  // An empty pattern means "no spine surfaces declared" (the framework default) — NOT "match
  // everything" (which `new RegExp('')` would otherwise do, since an empty pattern matches at
  // position 0 of any string).
  if (!spineRegex) return { touched: false, files: [] };
  const re = new RegExp(spineRegex);
  const spineFiles = changedFiles.filter(f => re.test(f));
  return { touched: spineFiles.length > 0, files: spineFiles };
}

// ---------------------------------------------------------------------------
// Touches enforcement (post-commit diff gate)
// ---------------------------------------------------------------------------

function isWithinTouches(file: string, prefixes: string[]): boolean {
  // Same segment-boundary rule the picker uses — a prefix contains a file
  // only when the file IS the prefix or lives strictly beneath it.
  for (const p of prefixes) {
    if (touchesSegmentMatch(p, file)) return true;
  }
  return false;
}

/** package-lock.json anywhere, and test files under the same package root as a touched prefix. */
function isTouchesExempt(file: string, prefixes: string[]): boolean {
  if (file.endsWith('package-lock.json')) return true;
  const isTestFile = /\/test\//.test(file) || /\.(test|spec)\.[jt]sx?$/.test(file);
  if (!isTestFile) return false;
  for (const p of prefixes) {
    const segs = p.split('/').filter(Boolean);
    const pkgRoot = segs.slice(0, 2).join('/');
    if (pkgRoot && (file.startsWith(pkgRoot + '/') || file.startsWith(p + '/'))) return true;
  }
  return false;
}

/**
 * Load the touched paths from every prior item.approved event for `itemId` that
 * carried an `approvedTouches` list (an operator or automatic approval of a touches-overstep
 * park). Reads the raw ledger events directly (not the fold, which drops per-event detail) —
 * transcribe, don't transform. Fail-safe: malformed data on an event is simply skipped,
 * never thrown — an unreadable prior approval falls back to re-parking, not silent acceptance.
 */
export function loadApprovedTouches(events: LedgerEvent[], itemId: string): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.item !== itemId || ev.type !== 'item.approved') continue;
    const files = (ev.data as { approvedTouches?: unknown }).approvedTouches;
    if (Array.isArray(files)) {
      for (const f of files) {
        if (typeof f === 'string') out.push(f);
      }
    }
  }
  return out;
}

/** True iff `file` is an exact match or same-directory sibling of a previously-approved path. */
function isPreviouslyApproved(file: string, approvedTouches: string[]): boolean {
  return approvedTouches.some(a => touchesSegmentMatch(a, file) || touchesSegmentMatch(dirname(a), file));
}

/**
 * Returns offending files outside declared touches, or null when touches is undefined or '*'.
 * `approvedTouches` — paths the operator or an automatic approval already approved on a prior
 * overstep park for this same item — are treated as inside the effective Touches: exact match
 * or same directory as an approved file. A genuinely new path (different directory) still parks.
 */
function checkTouchesOverstep(
  changedFiles: string[],
  touches: string,
  approvedTouches: string[] = [],
): string[] | null {
  if (touches === '*') return null;
  // ONE parser (normalizeTouches): strips trailing slashes so the picker and this
  // gate never disagree on prefix shape (items conventionally write `packages/ui/`).
  const prefixes = normalizeTouches(touches);
  if (prefixes.length === 0) return null;
  return changedFiles.filter(f =>
    !isWithinTouches(f, prefixes)
    && !isTouchesExempt(f, prefixes)
    && !isPreviouslyApproved(f, approvedTouches),
  );
}

// ---------------------------------------------------------------------------
// Manifest-scoped commit fallback
// ---------------------------------------------------------------------------

/**
 * The partition of a worktree's dirty paths relative to the fallback's commit scope.
 */
export interface ScopedDirtyPlan {
  /** Paths within scope (declared Touches ∪ manifest filesTouched) — safe to stage. */
  inScope: string[];
  /** Dirty paths outside scope — left uncommitted, surfaced as residue. */
  residue: string[];
}

/**
 * Partition a worktree's dirty paths into what the deterministic commit fallback may stage.
 * Scope = the union of the group's declared Touches prefixes and the workers'
 * manifest `filesTouched`. A blanket `git add -A` would sweep in scratch/residue (e.g.
 * a prompt file under `.ai/loops/prompts/`) that then trips the Touches-overstep park.
 * Staging only in-scope files avoids that class; residue stays uncommitted and is reported.
 *
 * `dirtyPaths` are raw paths (manifests + node_modules already stripped by the caller).
 * `touchPrefixes` are normalized declared-Touches prefixes — empty for a wildcard/undeclared group.
 * `manifestFiles` are exact worker-reported paths. In-scope = within a declared prefix (segment
 * boundary), Touches-exempt (package-lock / co-located tests), OR an exact manifest path.
 */
export function planScopedCommit(
  dirtyPaths: string[],
  touchPrefixes: string[],
  manifestFiles: string[],
): ScopedDirtyPlan {
  const manifestSet = new Set(manifestFiles);
  const inScope: string[] = [];
  const residue: string[] = [];
  for (const f of dirtyPaths) {
    const within = touchPrefixes.length > 0 &&
      (isWithinTouches(f, touchPrefixes) || isTouchesExempt(f, touchPrefixes));
    if (within || manifestSet.has(f)) inScope.push(f);
    else residue.push(f);
  }
  return { inScope, residue };
}

/**
 * Read each group member's `MANIFEST-<id>.json` from the worktree root and union its
 * `filesTouched`. Best-effort: a missing/malformed manifest contributes nothing (never throws).
 */
function readManifestFilesTouched(wtPath: string, ids: string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const mPath = join(wtPath, `MANIFEST-${id}.json`);
    if (!existsSync(mPath)) continue;
    try {
      const parsed = parseManifest(readFileSync(mPath, 'utf8'));
      if (parsed) for (const f of parsed.filesTouched) out.add(f);
    } catch { /* best-effort */ }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Scout prompt
// ---------------------------------------------------------------------------

/**
 * Build the read-only scout prompt for a single item. The scout output is stored
 * as an `item.briefed` event and injected into the subsequent build prompt.
 * Tools: Read, Grep, Glob — read-only; the scout MUST NOT modify any file.
 */
function buildScoutPrompt(itemId: string, spec: string, touches?: string): string {
  const touchesLine = touches ? `Declared Touches (code area): ${touches}\n` : '';
  return `You are a read-only scout preparing a context pack for an implementation agent that has never seen this repo. Your job is to orient the builder quickly so it can land the change on the first attempt.

Work item: ${itemId}
${touchesLine}Spec:
${spec}

Output STRICTLY in this shape (nothing else — no prose, no code):

BRIEF:
Files: up to 8 lines "path — why it must change"
Conventions: the patterns/idioms the change must follow, each citing one exemplar file path
Similar: the nearest similar shipped change (file or commit) worth imitating
Pitfalls: tests that pin current behavior, registries/allowlists needing updates, known gotchas

Max ~350 words total. Do NOT write implementation code. Do NOT modify any file.`;
}

/**
 * Parse a scout result leniently: extract text after the first BRIEF: marker if present,
 * else use the whole text. Hard-truncate to 4000 chars.
 */
export function parseBrief(text: string): string {
  const marker = text.indexOf('BRIEF:');
  const raw = marker !== -1 ? text.slice(marker) : text;
  return raw.trim().slice(0, 4000);
}

// ---------------------------------------------------------------------------
// Build prompt
// ---------------------------------------------------------------------------

/** Manifest instruction appended to every worker prompt. ~6 lines, compact.
 * Exported for testing. */
export const MANIFEST_INSTRUCTION = `
MANIFEST: Before finishing, write MANIFEST-<wi-id>.json at the WORKTREE ROOT (not committed) with:
{ "wi": "<WI-NNN>", "filesTouched": ["<path>", ...], "testsAdded": ["<path>", ...], "confidence": <0.0-1.0 honest estimate spec is fully satisfied>, "notes": "<one line: anything the reviewer should know>", "certification": { "couldBreak": "<what could break>", "detection": "<the signal that would catch it>", "rollback": "<how to undo this if it breaks>" } }
CERTIFICATION: green tests alone are a brief, not a certification — fill in "certification" honestly even when nothing looks risky (say so plainly, e.g. couldBreak: "nothing outside the touched files").
Do NOT commit this file. It is read by the dispatch gate for attribution and observability.`;

/** @internal exported for tests */
export function buildPrompt(
  spec: string,
  repairContext?: string,
  attachments?: string[],
  brief?: string,
  repairEvidence?: string,
  resumeNote?: string,
  playbookContent?: string,
): string {
  const base = `Implement this operator build/fix request as a SMALL, surgical, tested change, committed to the current branch by explicit path (never git add -A). COMMIT MECHANICS (your session's tool allowlist only matches plain single commands — anything else is silently denied and your work is lost): stage and commit as TWO separate Bash calls, \`git add <paths>\` then \`git commit -m "<message>"\`; never chain with && or ;, never prefix with cd, never use \`git -C <path>\` (you are already in the right directory), never use $(...) or heredocs in the commit command; keep the -m message single-line quoted. If a git command is denied, retry it in that plain form — do NOT finish without committing. Do NOT merge, push, or deploy — that is gated downstream by a script, not you. Follow the target repository's contributing/coding guidelines, if present; keep it minimal and in-scope. If it genuinely needs the durable spine (event contracts / authorization / migrations / router / shared schema), still implement it but say so in your final summary. If the request is unclear or too big for one safe slice, make the smallest sensible change and note what you deferred. COMMIT MESSAGE CONTENT: never copy an operator-private decision-log id (a bare \`D-NNN\` token) out of the request text below into a commit subject or body — describe the change/behavior instead, or cite the target repo's own local decision-log id (e.g. \`ADR-NNN\`) if it has one. ESCALATION FORMAT: if you defer something that needs an operator decision (rather than just noting it), never phrase it as a bare question — state it as an escalation with four parts: your INTENT (what you'd do), the EVIDENCE for it, the main RISK, and your RECOMMENDATION. Put that escalation in the manifest's "notes" field in that four-part form.`;
  const playbookSection = playbookContent
    ? `\n\nREPO PLAYBOOK (recurring lessons — keep these in mind throughout your implementation):\n${playbookContent}`
    : '';
  const briefSection = brief
    ? `\n\nCONTEXT PACK (prepared by a read-only scout at branch point; trust but verify against the code):\n${brief}`
    : '';
  const resumeSection = resumeNote ? `\n\n${resumeNote}` : '';
  const attachSuffix = attachments?.length
    ? `\n\nATTACHMENTS (operator uploaded — Read these paths before implementing):\n${attachments.map(p => '- ' + p).join('\n')}`
    : '';
  // Section order: base → REPO PLAYBOOK → CONTEXT PACK → RESUME NOTE → REPAIR EVIDENCE → REQUEST.
  // MANIFEST instruction is appended to every prompt so the worker writes a self-report.
  const prefix = `${base}${playbookSection}${briefSection}`;
  if (repairEvidence) {
    return `${prefix}${resumeSection}\n\n${repairEvidence}\n\nREQUEST: ${spec}${attachSuffix}${MANIFEST_INSTRUCTION}`;
  }
  if (resumeSection) {
    return `${prefix}${resumeSection}\n\nREQUEST: ${spec}${attachSuffix}${MANIFEST_INSTRUCTION}`;
  }
  if (repairContext) {
    return `${prefix}\n\nREPAIR CONTEXT — this is a repair run against fresh master. A previous build failed to merge cleanly; the context below explains what broke. Fix the root cause as part of this implementation.\n${repairContext}\n\nREQUEST: ${spec}${attachSuffix}${MANIFEST_INSTRUCTION}`;
  }
  return `${prefix} REQUEST: ${spec}${attachSuffix}${MANIFEST_INSTRUCTION}`;
}

/**
 * Prompt for a co-located batch. One worktree, N specs sharing a code area.
 * The worker must make ONE commit per item, each subject prefixed with the item id, so
 * dispatch can derive per-item ledger events from the commits.
 * The worker also writes one MANIFEST-<WI-id>.json per item at the worktree root.
 * @internal exported for tests
 */
export function buildBatchPrompt(items: { id: string; spec: string; brief?: string; repairEvidence?: string }[], playbookContent?: string): string {
  const playbookSection = playbookContent
    ? `\nREPO PLAYBOOK (recurring lessons — keep these in mind throughout):\n${playbookContent}\n`
    : '';
  const list = items
    .map((it, i) => {
      const briefSection = it.brief
        ? `\nCONTEXT PACK for ${it.id} (prepared by a read-only scout at branch point; trust but verify against the code):\n${it.brief}`
        : '';
      const evidenceSection = it.repairEvidence
        ? `\n${it.repairEvidence}`
        : '';
      return `### ITEM ${i + 1} — ${it.id}${briefSection}${evidenceSection}\n${it.spec}`;
    })
    .join('\n\n');
  const batchManifestInstruction = `
MANIFESTS: Before finishing, for EACH item write MANIFEST-<wi-id>.json at the WORKTREE ROOT (e.g. MANIFEST-${items[0].id}.json). Do NOT commit these files.
Format per file: { "wi": "<WI-NNN>", "filesTouched": ["<path>", ...], "testsAdded": ["<path>", ...], "confidence": <0.0-1.0 honest estimate spec is fully satisfied>, "notes": "<one line>", "certification": { "couldBreak": "<what could break>", "detection": "<the signal that would catch it>", "rollback": "<how to undo this if it breaks>" } }
CERTIFICATION: green tests alone are a brief, not a certification — fill in "certification" per item honestly even when nothing looks risky.`;
  return `Implement these ${items.length} operator build/fix requests in ONE worktree as SMALL, surgical, tested changes. They share a code area, so they are batched to share a single test run.
Make ONE SEPARATE COMMIT PER ITEM, and start each commit subject with the item id in parentheses — e.g. "feat(${items[0].id}): ..." — so each change is attributable. Commit by explicit path (never git add -A). COMMIT MESSAGE CONTENT: never copy an operator-private decision-log id (a bare \`D-NNN\` token) out of an item's spec text below into that item's commit subject or body — describe the change/behavior instead, or cite the target repo's own local decision-log id (e.g. \`ADR-NNN\`) if it has one.
Do NOT merge, push, or deploy — that is gated downstream by a script, not you. Follow the target repository's contributing/coding guidelines, if present; keep each change minimal and in-scope. If genuine spine work is needed (event contracts / authorization / migrations / router / shared schema), still implement it but say so. If an item is unclear or too big for one safe slice, make the smallest sensible change for it and note what you deferred; if you cannot safely do an item at all, skip it (leave it uncommitted) and say which. ESCALATION FORMAT: if any item defers something that needs an operator decision, never phrase it as a bare question — state it as an escalation with four parts (INTENT / EVIDENCE / RISK / RECOMMENDATION) in that item's manifest "notes" field.

${playbookSection}${list}${batchManifestInstruction}`;
}

// ---------------------------------------------------------------------------
// Cross-beat watchdog
// Dispatch checks the reactor's lastrun; reactor checks dispatch's lastrun.
// This runs even when OPS_AUTONOMY=propose.
// ---------------------------------------------------------------------------

const REACTOR_STALE_THRESHOLD_SEC = 10 * 30; // 10 reactor cycles = 300 s

/**
 * ONE rule for run-state resolution (no second parser): an explicit `opts.runDir` wins
 * (plane-home mode — run-state lives beside the ledger, outside the driven repo);
 * otherwise fall back to the embedded default under repoRoot. Every internal site that
 * needs run-state derives from this — never from `opts.repoRoot` directly.
 */
function resolveRunDir(opts: Pick<DispatchOptions, 'runDir' | 'repoRoot'>): string {
  return opts.runDir ?? join(opts.repoRoot, '.ai', 'runs', 'loopkit');
}

function crossBeatWatchdog(opts: DispatchOptions, cfg: LoopkitConfig): string | null {
  // Read reactor liveness stamps (the reactor's lastrun dir is a SIBLING of the loopkit
  // dir under the same runs root). Prefer the freshest of lastrun (beat start) and the
  // mid-beat heartbeat (refreshed between steps) — ONE stamp parser (slo.ts
  // readEpochStampFile), so a long reactor beat never reads as dead here.
  const lastrunFn = opts.reactorLastrunProbe
    ?? (() => readEpochStampFile(join(dirname(resolveRunDir(opts)), 'reactor', 'lastrun')));
  const heartbeatFn = opts.reactorHeartbeatProbe
    ?? (() => readEpochStampFile(join(dirname(resolveRunDir(opts)), 'reactor', 'heartbeat')));

  const lastrun = lastrunFn();
  if (lastrun === undefined) return null; // never ran — don't kickstart blindly
  const heartbeat = heartbeatFn();
  const freshest = heartbeat !== undefined && heartbeat > lastrun ? heartbeat : lastrun;

  const ageSec = Math.floor(Date.now() / 1000) - freshest;
  if (ageSec <= REACTOR_STALE_THRESHOLD_SEC) return null;

  // A fresh reactor.lock = a beat is legitimately running long (routing multiple items);
  // stale lastrun alone must never kill a live beat.
  // A very old lock is a wedge (SIGKILL residue) — clear it so the kickstart takes.
  const lockProbe = opts.reactorLockAgeSec ?? (() => {
    try {
      const st = statSync(join(resolveRunDir(opts), 'reactor.lock'));
      return Math.max(0, (Date.now() - st.mtimeMs) / 1000);
    } catch { return undefined; }
  });
  const lockAge = lockProbe();
  const WEDGE_REACTOR_SEC = 20 * 60;
  if (lockAge !== undefined && lockAge < WEDGE_REACTOR_SEC) return null; // beat in flight

  // Liveness gate before ANY lock-clear/kickstart: the wedge-age heuristic alone once
  // killed a live beat. If the lock's owner pid is provably ALIVE, the beat is in flight
  // however old its stamps look — report, never heal. Same predicate as the lock-reclaim
  // acquire path (beatLockOwnerAlive) — one parser, never a second copy.
  const lockPath = join(resolveRunDir(opts), 'reactor.lock');
  if (beatLockOwnerAlive(lockPath) === true) {
    return `watchdog: reactor stale ${ageSec}s but lock owner pid is alive — in-flight, no kickstart`;
  }
  if (lockAge !== undefined) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // Reactor is stale — kickstart it (runs regardless of OPS_AUTONOMY)
  const spawnFn = opts.watchdogSpawn ?? ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 10_000 });
    const output = ((r.stdout?.toString() ?? '') + (r.stderr?.toString() ?? '')).trim();
    return { ok: r.status === 0, output };
  });

  const reactorLabel = cfg.loops.reactorLabel;
  if (!reactorLabel) return null; // label not set in loopkit.config.json — skip kickstart
  const uid = process.getuid ? process.getuid() : 501;
  const r = spawnFn('launchctl', ['kickstart', '-k', `gui/${uid}/${reactorLabel}`]);
  return `watchdog: reactor stale ${ageSec}s; kickstart ${r.ok ? 'ok' : 'failed: ' + r.output}`;
}

// ---------------------------------------------------------------------------
// Planning lane — decomposes an approved epic into buildable child
// slices. No worktree, no branch, no commit, no merge: the worker only reads the repo
// (Read/Grep/Glob) and acts through ONE restricted Bash pattern (`loopctl new`, the
// validated ledger writer). It runs against the PRIMARY tree, the
// same way the reactor's classifier (stepRoute) does — it makes no file-system writes,
// so branch isolation buys nothing, and it sidesteps needing a fresh copy of the
// framework's own CLI build inside every worktree (the compiled CLI is rebuilt on
// demand, so a worktree without that rebuild step would be missing it).
// The non-code definition-of-done is satisfied by construction here rather than by a
// post-hoc spine/diff check: no git tool is ever granted, so "no source committed"
// always holds; gate.passed only needs >=1 new child item to have appeared in the ledger.
// ---------------------------------------------------------------------------

/** Absolute path to this framework's compiled CLI (`loopctl`). The `LOOPKIT_CLI` env
 *  var overrides it; otherwise it resolves next to the running beat module — the beat
 *  compiles to `dist/beats/dispatch.js` and the CLI to `dist/cli.js`, so the CLI is one
 *  directory up. Absolute so it resolves the same regardless of the agent's cwd. */
function resolveCliPath(): string {
  const envCli = process.env['LOOPKIT_CLI'];
  if (envCli) return resolve(envCli);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

/** The ONE Bash pattern a planner may use to act — an absolute path so it resolves the
 *  same regardless of the agent's cwd. */
function plannerToolset(): string[] {
  const cliPath = resolveCliPath();
  return ['Read', 'Grep', 'Glob', `Bash(node ${cliPath} new:*)`];
}

/** @internal exported for tests */
export function buildPlannerPrompt(plannerPromptContent: string, itemId: string, spec: string): string {
  return `${plannerPromptContent}\n\nDECOMPOSE THIS ITEM:\nID: ${itemId}\nSPEC: ${spec}\n\nReturn the QUEUED:/REMAINING: block described above — nothing else.`;
}

/**
 * Deterministic wall (transcribe, don't trust free prose): recover the planner's
 * REMAINING trail note from its final text. The agent's actual queuing already happened
 * via its `loopctl new` tool call — this only recovers a human-readable list of
 * not-yet-queued children for the msg.out trail. Fail-open: no `REMAINING:` marker → [].
 * @internal exported for tests
 */
export function parsePlannerRemaining(text: string): string[] {
  const m = text.match(/REMAINING:\s*\n([\s\S]*)/i);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * Dispatch every queued planning-lane item. Each runs serially against the primary tree
 * (no worktree): scout the child-count before/after the provider call — an increase means
 * `loopctl new` landed at least one child in the real ledger. Breaker/requeue mirrors the
 * engineering post-gate path (cfg.breakerN) so an epic that repeatedly fails to decompose
 * eventually parks instead of burning a provider call every beat forever.
 * @internal exported for tests
 */
export async function runPlanningLane(
  opts: DispatchOptions,
  cfg: LoopkitConfig,
  provider: LlmProvider,
  items: ItemRecord[],
  runDir: string,
  registry: ReturnType<typeof makeRegistry> | null = null,
): Promise<DispatchStepResult[]> {
  const results: DispatchStepResult[] = [];
  if (items.length === 0) return results;

  const promptPath = join(opts.repoRoot, cfg.promptsDir, 'planner.md');
  let plannerPromptContent: string;
  try {
    plannerPromptContent = readFileSync(promptPath, 'utf8');
  } catch {
    // No prompt-of-record: park every planning item as a mechanical/ops failure rather
    // than silently dropping it or spending a provider call with no prompt to send.
    const reason = `infra: planner prompt missing: ${promptPath}`;
    const events = items.flatMap(r => [
      makeEvent('dispatch', r.id, 'gate.failed', { reason }),
      makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' as const }),
    ]);
    if (!opts.dryRun) await appendEvents(opts.ledgerDir, events);
    for (const r of items) {
      results.push({ item: r.id, dispatched: false, gateOutcome: 'failed', eventsWritten: 2, detail: reason });
    }
    return results;
  }

  const tools = plannerToolset();

  for (const rec of items) {
    // Long-beat heartbeat: planning items run serially, one provider call each — refresh
    // the liveness stamp between items (see writeBeatHeartbeat).
    if (!opts.dryRun) writeBeatHeartbeat(runDir, 'dispatch');
    const attempt = (rec.attempts ?? 0) + 1;

    // TRUST-HARDENING (defect: sensitivity bypass): resolve THIS item's provider against its own
    // sensitivity, fail-closed. The planner prompt carries the item's spec (and its tools can read
    // repo content); routing a private-only item through the beat-global `internal` provider would
    // leak it. With a registry and no allowed+healthy provider for the item's tier, park it rather
    // than route through a disallowed provider. No registry (injected-provider test path) ⇒ the
    // caller's single provider is used unchanged.
    const itemProvider = resolveProviderForSensitivity(registry, provider, itemSensitivity(rec), { requireTools: true });
    if (registry && !itemProvider) {
      const reason = `sensitivity(${itemSensitivity(rec)}): no allowed+healthy provider for planning — parked fail-closed (never routed to a disallowed provider)`;
      await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const })]);
      results.push({ item: rec.id, dispatched: false, eventsWritten: 1, detail: reason });
      continue;
    }
    // Non-null past this point (registry path guarantees it; test path passes a concrete provider).
    const activeProvider = itemProvider ?? provider;

    await appendEvents(opts.ledgerDir, [
      makeEvent('dispatch', rec.id, 'build.dispatched', { attempt, model: cfg.models.builderDefault, provider: activeProvider.name }),
    ]);

    // Snapshot ids before the run so a successful `loopctl new` shows up as a fold diff.
    // The ledger's own append lock (cli.ts cmdNew / ledger withLock) makes this race-safe
    // against a concurrent capture; a same-second unrelated capture could in theory be
    // misattributed as this planner's child — an accepted low-probability MVP limitation.
    const beforeIds = new Set(fold(await loadAllEventsWithQuarantine(opts.ledgerDir)).items.keys());

    const spec = rec.spec ?? rec.sourceText ?? '';
    const prompt = buildPlannerPrompt(plannerPromptContent, rec.id, spec);
    const result = await activeProvider.run({
      prompt,
      model: cfg.models.builderDefault,
      cwd: opts.repoRoot,
      tools,
      timeoutMs: cfg.buildTimeoutMinutes * 60 * 1000,
    });

    persistWorkerLog(runDir, rec.id, attempt, result.ok ? result.text : (result.error ?? ''));

    if (result.ok && result.usage) {
      await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'cost.usage', {
        provider: activeProvider.name,
        loop: 'dispatch',
        tokens: (result.usage.in ?? 0) + (result.usage.out ?? 0),
        usd: result.usage.usd,
        wi: rec.id,
        ...(result.usage.turns !== undefined ? { turns: result.usage.turns } : {}),
        ...(result.usage.durationMs !== undefined ? { durationMs: result.usage.durationMs } : {}),
      })]);
    }

    if (!result.ok && result.code === 'auth') {
      const reason = 'infra: builder not logged in — run /login (planning lane)';
      await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'build.crashed', { reason })]);
      results.push({ item: rec.id, dispatched: true, gateOutcome: 'failed', eventsWritten: 1, detail: reason });
      continue;
    }

    const afterIds = fold(await loadAllEventsWithQuarantine(opts.ledgerDir)).items.keys();
    const newIds = [...afterIds].filter(id => !beforeIds.has(id));

    if (!result.ok || newIds.length === 0) {
      const reason = result.ok
        ? 'planning: no child item queued (loopctl new was not called)'
        : `planning: provider failed: ${result.error}`;
      const events: ReturnType<typeof makeEvent>[] = [makeEvent('dispatch', rec.id, 'gate.failed', { reason })];
      if (attempt >= cfg.breakerN) {
        events.push(makeEvent('dispatch', rec.id, 'item.parked', {
          reason: `breaker: ${attempt} attempts exhausted — ${reason}`,
          parkKind: 'ops',
        }));
      } else {
        events.push(makeEvent('dispatch', rec.id, 'item.queued', { spec, lane: 'planning' } as ItemQueuedData));
      }
      await appendEvents(opts.ledgerDir, events);
      results.push({ item: rec.id, dispatched: true, gateOutcome: 'failed', eventsWritten: events.length, detail: reason });
      continue;
    }

    const remaining = parsePlannerRemaining(result.text);
    const events: ReturnType<typeof makeEvent>[] = [
      makeEvent('dispatch', rec.id, 'gate.passed', { reason: `planning: queued ${newIds.length} child item(s) (${newIds.join(', ')})` }),
      makeEvent('dispatch', rec.id, 'item.merged', { commit: 'none (planning lane — no source changes)', deployed: false }),
    ];
    if (remaining.length > 0) {
      events.push(makeEvent('dispatch', rec.id, 'msg.out', {
        text: `Queued ${newIds.join(', ')}; ${remaining.length} more slice(s) still to decompose:\n${remaining.map(r => `- ${r}`).join('\n')}`,
      }));
    }
    await appendEvents(opts.ledgerDir, events);
    results.push({
      item: rec.id, dispatched: true, gateOutcome: 'passed', eventsWritten: events.length,
      detail: `queued ${newIds.join(', ')}`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Target lane (TARGET EXTERNALIZATION — docs/event-model.md §"Build execution")
// ---------------------------------------------------------------------------

/**
 * Resolve the effective git root + manifest for a targeted item, re-reading the manifest at
 * build time (docs/event-model.md §"Build execution": "Re-read the manifest at build time
 * (compare hash; changed manifest → append target.manifest-updated, use the new one)").
 * Returns undefined (and appends nothing) when the target is unregistered or its manifest can
 * no longer be read — the caller parks the item as an ops failure.
 */
async function resolveTargetForBuild(
  opts: DispatchOptions,
  foldResult: FoldResult,
  rec: ItemRecord,
): Promise<{ gitRoot: string; manifest: TargetManifest; targetId: string } | { error: string }> {
  const name = rec.target!;
  // Identity-first resolution through THE one shared rule (target.ts resolveRegisteredTarget):
  // the item's stable targetId wins; the mutable display name is only the legacy fallback
  // (docs/event-model.md: nothing downstream may key on name). The reactor's approved-merge
  // path resolves through the same rule — never a second copy.
  const resolution = resolveRegisteredTarget(foldResult.targets, rec);
  if (!resolution.ok) {
    return {
      error: resolution.kind === 'unregistered'
        ? `infra: item ${rec.id} ${resolution.error}`
        : `infra: ${resolution.error}`,
    };
  }
  const { reg, manifest } = resolution;
  // Changed manifest → append target.manifest-updated (append-only, never mutate the
  // registration) and use the new one. Keyed on the stable content hash.
  if (resolution.manifestChanged && !opts.dryRun) {
    await appendEvents(opts.ledgerDir, [makeEvent('dispatch', name, 'target.manifest-updated', {
      targetId: reg.targetId,
      name,
      manifestHash: resolution.manifestHash,
      defaultBranch: manifest.defaultBranch,
    })]);
  }
  return { gitRoot: reg.repoPath, manifest, targetId: reg.targetId };
}

/**
 * Sibling worktree dir name for a targeted build, namespaced by the target's OPAQUE id
 * (docs/event-model.md §"Build execution"): two targets sharing a parent directory, a
 * `worktreePrefix`, and even a display name can never clobber each other's builds — the
 * name-based dir this replaces collided for same-named/default-prefix siblings. The
 * targetId already carries the `tgt-` marker, so the dir stays operator-recognizable.
 * Only the target lane namespaces: an untargeted (embedded single-repo) build keeps its
 * unnamespaced `<prefix>wi-NNN-aN` path byte-identical — namespacing activates strictly
 * when a targetId is in play. @internal exported for tests
 */
export function targetWorktreeDirName(
  worktreePrefix: string,
  targetId: string,
  wiNum: string,
  attempt: number,
): string {
  return `${worktreePrefix}${targetId}-wi-${wiNum}-a${attempt}`;
}

/**
 * Terminal half of a targeted build — commit-check → manifest gate → merge into the target's
 * default branch → evidence. Shared by BOTH the sync spawn path and the detached-collection path
 * (ADR-008 §3): a collected detached target build reuses the EXACT gate/merge pipeline the sync
 * path uses, never a forked second implementation. `outcome` is the decoded provider (sync) or
 * exit-file (collection) result; `providerName` is best-effort cost attribution (a cross-beat
 * collector may not know which provider ran the detached worker → 'unknown'). Returns the single
 * DispatchStepResult the caller pushes.
 */
async function finalizeTargetBuild(
  opts: DispatchOptions,
  rec: ItemRecord,
  ctx: {
    gitRoot: string;
    manifest: TargetManifest;
    wtPath: string;
    branch: string;
    baseSha: string;
    targetRunDir: string;
    attempt: number;
    providerName?: string;
  },
  outcome:
    | { ok: true; text: string; usage?: { in: number; out: number; usd?: number } }
    | { ok: false; error: string },
): Promise<DispatchStepResult> {
  const { gitRoot, manifest, wtPath, branch, baseSha, targetRunDir, attempt } = ctx;

  persistWorkerLog(targetRunDir, rec.id, attempt, outcome.ok ? outcome.text : outcome.error);

  if (outcome.ok && outcome.usage) {
    await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'cost.usage', {
      provider: ctx.providerName ?? 'unknown', loop: 'dispatch',
      tokens: (outcome.usage.in ?? 0) + (outcome.usage.out ?? 0), usd: outcome.usage.usd, wi: rec.id,
    })]);
  }

  if (!outcome.ok) {
    const reason = `target build failed: ${outcome.error}`;
    removeWorktree(gitRoot, wtPath);
    await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'build.crashed', { reason })]);
    return { item: rec.id, dispatched: true, gateOutcome: 'failed', eventsWritten: 1, detail: reason };
  }

  // The worker must have committed. An empty branch (no commit past HEAD) is a no-commit park.
  const branchHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath, stdio: 'pipe' }).stdout?.toString().trim();
  if (!branchHead || branchHead === baseSha) {
    const reason = 'target build produced no commit';
    removeWorktree(gitRoot, wtPath);
    await appendEvents(opts.ledgerDir, [
      makeEvent('dispatch', rec.id, 'gate.failed', { reason }),
      makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const }),
    ]);
    return { item: rec.id, dispatched: true, gateOutcome: 'failed', eventsWritten: 2, detail: reason };
  }

  // ── Gate: the MANIFEST's gate command, in its gateWorkdir, in the worktree ─
  const gate = runGate(manifest.gateCommand, manifest.gateWorkdir, wtPath, false, baseSha);
  if (!gate.passed) {
    // Keep the branch for review (like the engineering park path); drop only the worktree.
    removeWorktree(gitRoot, wtPath);
    await appendEvents(opts.ledgerDir, [
      makeEvent('dispatch', rec.id, 'gate.failed', { reason: gate.reason }),
      makeEvent('dispatch', rec.id, 'item.parked', { reason: gate.reason, parkKind: 'ops' as const }),
    ]);
    return { item: rec.id, dispatched: true, gateOutcome: 'failed', eventsWritten: 2, detail: gate.reason };
  }

  // ── Merge into the target's default branch (in the target repo) ───────────
  const mergeResult = spawnSync('git', ['checkout', manifest.defaultBranch], { cwd: gitRoot, stdio: 'pipe' });
  if (mergeResult.status !== 0) {
    const reason = `infra: cannot checkout target default branch '${manifest.defaultBranch}': ${mergeResult.stderr?.toString().trim()}`;
    removeWorktree(gitRoot, wtPath);
    await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const })]);
    return { item: rec.id, dispatched: true, gateOutcome: 'passed', eventsWritten: 1, detail: reason };
  }
  const merge = spawnSync('git', ['merge', '--no-ff', '-m', `feat(dispatch): ${rec.id} (target ${manifest.name})`, branch], { cwd: gitRoot, stdio: 'pipe' });
  if (merge.status !== 0) {
    spawnSync('git', ['merge', '--abort'], { cwd: gitRoot, stdio: 'pipe' });
    const reason = `target merge conflict on '${manifest.defaultBranch}'`;
    removeWorktree(gitRoot, wtPath);
    await appendEvents(opts.ledgerDir, [
      makeEvent('dispatch', rec.id, 'gate.failed', { reason }),
      makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const }),
    ]);
    return { item: rec.id, dispatched: true, gateOutcome: 'passed', eventsWritten: 2, detail: reason };
  }
  const mergeCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, stdio: 'pipe' }).stdout?.toString().trim() ?? '';

  // Cleanup: drop the build worktree + branch (merge is in the target's default branch now).
  removeWorktree(gitRoot, wtPath);
  spawnSync('git', ['branch', '-D', branch], { cwd: gitRoot, stdio: 'pipe' });

  // Optional per-target deploy — self-locking, detached, against the target repo.
  if (manifest.deployCommand) fireDeployOnMerge(gitRoot, manifest.deployCommand, [rec.id]);

  // TRUST-HARDENING: actual-diff evidence for the target-lane merge.
  const targetChangedFiles = baseSha ? getChangedFiles(gitRoot, baseSha) : [];
  const targetEvidence = mergeEvidence(baseSha, mergeCommit, targetChangedFiles, manifest.gateCommand);
  await appendEvents(opts.ledgerDir, [
    makeEvent('dispatch', rec.id, 'gate.passed', { tests: gate.reason }),
    makeEvent('dispatch', rec.id, 'build.finished', { commit: mergeCommit }),
    makeEvent('dispatch', rec.id, 'item.merged', { commit: mergeCommit, deployed: !!manifest.deployCommand, ...targetEvidence }),
  ]);
  return {
    item: rec.id, dispatched: true, gateOutcome: 'passed', branch, worktree: wtPath,
    eventsWritten: 3, detail: `merged ${rec.id} into target '${manifest.name}' ${manifest.defaultBranch} (${mergeCommit.slice(0, 8)})`,
  };
}

/**
 * Dispatch every queued TARGETED item (rec.target set), serially, each against ITS target repo.
 * Mirrors the engineering path's build→gate→merge but with the git root, gate, worktree prefix,
 * and merge branch all taken from the target's manifest — NOT the plane's own repoRoot/config.
 * Ledger appends stay in the plane's own ledger (opts.ledgerDir), exactly as for legacy items.
 *
 * Kept a dedicated lane (like runPlanningLane) rather than threading a per-target root through
 * the batch pipeline: the batch machinery hardcodes the plane's `master` + shared primary tree
 * and its 100+ opts.repoRoot call sites are entangled with plane-runtime paths (.ai/runs,
 * prompts, notify). A separate serial lane keeps the existing legacy code path — and its 944
 * tests — byte-for-byte unchanged while giving targeted items a correct external-repo build.
 * @internal exported for tests
 */
export async function runTargetLane(
  opts: DispatchOptions,
  cfg: LoopkitConfig,
  provider: LlmProvider | null,
  foldResult: FoldResult,
  items: ItemRecord[],
  runDir: string,
  registry: ReturnType<typeof makeRegistry> | null = null,
): Promise<DispatchStepResult[]> {
  const results: DispatchStepResult[] = [];
  // ADR-008 phase A/B: SPAWN-side flag. Default false = today's sync-in-beat behaviour (no
  // targeted build ever records a pgid, so the collection scan below finds nothing).
  const detachedDispatch = cfg.execution?.detachedDispatch ?? false;
  // Exit files are written under the plane's artifact dir (opts.artifactRunsDir ?? runDir) — the
  // SAME dir the plane's collectDetachedBuilds reads from — so the collection scan reads them there.
  const artifactDir = opts.artifactRunsDir ?? runDir;

  // ── Cross-beat collection of THIS lane's own detached builds (ADR-008 §3, target lane) ──
  // A prior beat may have dispatched a targeted build DETACHED (pgid recorded, not awaited). Such
  // an item is 'building' with currentBuild.pgid set. Once its exit file lands, finalize it against
  // ITS target repo via the SAME gate/merge terminal the sync path uses (finalizeTargetBuild).
  // Targeted items are deliberately EXCLUDED from the plane's collectDetachedBuilds (that lane
  // gates/merges against the plane repo — a targeted build there would merge into the wrong repo),
  // so this lane owns their terminal. Reuses the pipeline; never a forked implementation.
  if (!opts.dryRun) {
    for (const rec of foldResult.items.values()) {
      if (rec.state !== 'building' || !rec.currentBuild || !rec.target) continue;
      const { pgid, branch: cbBranch, worktree: cbWorktree, attempt: cbAttempt } = rec.currentBuild;
      if (pgid == null || !cbBranch || !cbWorktree) continue;
      const exit = readExitFile(artifactDir, rec.id, cbAttempt);
      if (!exit) continue; // still running — defer (the doctor's grace covers a truly orphaned group)

      writeBeatHeartbeat(runDir, 'dispatch');
      const resolved = await resolveTargetForBuild(opts, foldResult, rec);
      if ('error' in resolved) {
        const reason = resolved.error;
        await appendEvents(opts.ledgerDir, [
          makeEvent('dispatch', rec.id, 'build.crashed', { reason }),
          makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const }),
        ]);
        results.push({ item: rec.id, dispatched: false, eventsWritten: 2, detail: reason });
        continue;
      }
      const { gitRoot, manifest, targetId } = resolved;
      const targetRunDir = join(runDir, targetId);
      try { mkdirSync(targetRunDir, { recursive: true }); } catch { /* best-effort evidence dir */ }
      // Reconstruct baseSha (the branch's fork point). The sync path captures target-repo HEAD in
      // the worktree BEFORE the build; for a collected build the equivalent is the merge-base of the
      // build branch and the target default branch — the same commit, robust to the default branch
      // having advanced since dispatch.
      const baseSha = spawnSync('git', ['merge-base', cbBranch, manifest.defaultBranch], { cwd: gitRoot, stdio: 'pipe' })
        .stdout?.toString().trim() ?? '';
      // Decode the exit file into the same resolved shape the sync path gets from provider.run(),
      // via the SAME parseOutput/extractUsage the plane collector uses (one-parser invariant).
      let text = '';
      let usage: { in: number; out: number; usd?: number } | undefined;
      if (exit.usageJsonPath) {
        try {
          const { obj } = parseOutput(readFileSync(exit.usageJsonPath, 'utf8'));
          if (obj) {
            if (typeof obj.result === 'string') text = obj.result;
            usage = extractUsage(obj) ?? usage;
          }
        } catch { /* best-effort — an unreadable usage json still yields a resolved result below */ }
      }
      const outcome = exit.exitCode === 0 && !exit.authFailure
        ? { ok: true as const, text, usage }
        : {
          ok: false as const,
          error: exit.authFailure
            ? 'detached worker: auth failure (session expired mid-build)'
            : `detached worker exited ${exit.exitCode ?? '(signalled)'}`,
        };
      results.push(await finalizeTargetBuild(opts, rec, {
        gitRoot, manifest, wtPath: cbWorktree, branch: cbBranch, baseSha, targetRunDir,
        attempt: cbAttempt, providerName: provider?.name,
      }, outcome));
    }
  }

  if (items.length === 0) return results;

  for (const rec of items) {
    // Long-beat heartbeat: this lane runs builds serially, so a full queue can hold the
    // beat for many × buildTimeout. Refresh the liveness stamp between items so the
    // staleness probe/watchdog never mistakes a progressing beat for a dead one.
    if (!opts.dryRun) writeBeatHeartbeat(runDir, 'dispatch');
    const attempt = (rec.attempts ?? 0) + 1;
    const resolved = await resolveTargetForBuild(opts, foldResult, rec);
    if ('error' in resolved) {
      const reason = resolved.error;
      if (!opts.dryRun) {
        await appendEvents(opts.ledgerDir, [
          makeEvent('dispatch', rec.id, 'build.crashed', { reason }),
          makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const }),
        ]);
      }
      results.push({ item: rec.id, dispatched: false, eventsWritten: opts.dryRun ? 0 : 2, detail: reason });
      continue;
    }
    const { gitRoot, manifest, targetId } = resolved;
    const wiNum = rec.id.replace('WI-', '').padStart(3, '0');
    const branch = `${manifest.worktreePrefix}wi-${wiNum}-a${attempt}`;
    const wtPath = join(gitRoot, '..', targetWorktreeDirName(manifest.worktreePrefix, targetId, wiNum, attempt));
    // Per-target run state (runs/<targetId>/): targeted-build worker logs are namespaced by
    // the stable target id so same-named targets never interleave evidence. Untargeted lanes
    // keep writing to runDir directly — byte-identical legacy behavior.
    const targetRunDir = join(runDir, targetId);
    try { mkdirSync(targetRunDir, { recursive: true }); } catch { /* best-effort evidence dir */ }
    const spec = rec.spec ?? rec.sourceText ?? '';

    if (opts.dryRun) {
      results.push({
        item: rec.id, dispatched: true, branch, worktree: wtPath, gateOutcome: 'dry-run',
        eventsWritten: 0, detail: `dry-run: would build ${rec.id} in target '${manifest.name}' → ${manifest.defaultBranch}`,
      });
      continue;
    }

    // TRUST-HARDENING (defect: sensitivity bypass): resolve THIS item's provider against its own
    // sensitivity, fail-closed. A target build sends the item's spec + the worktree file contents to
    // the provider; routing a private-only item through the beat-global `internal` provider would
    // leak it. With a registry and no allowed+healthy provider for the item's tier, park it rather
    // than route through a disallowed provider; no registry (injected-provider test path) ⇒ the
    // caller's single provider is used unchanged. Subsumes the old bare null-provider guard.
    const activeProvider = resolveProviderForSensitivity(registry, provider, itemSensitivity(rec), { requireTools: true });
    if (!activeProvider) {
      const reason = registry
        ? `sensitivity(${itemSensitivity(rec)}): no allowed+healthy provider for target build (${rec.id}) — parked fail-closed (never routed to a disallowed provider)`
        : `infra: no provider available for target build (${rec.id})`;
      await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const })]);
      results.push({ item: rec.id, dispatched: false, eventsWritten: 1, detail: reason });
      continue;
    }

    // ── Worktree of the TARGET repo ──────────────────────────────────────────
    removeWorktree(gitRoot, wtPath);
    spawnSync('git', ['branch', '-D', branch], { cwd: gitRoot, stdio: 'pipe' });
    const wtAdd = spawnSync('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], { cwd: gitRoot, stdio: 'pipe' });
    if (wtAdd.status !== 0) {
      const reason = `infra: target worktree add failed: ${wtAdd.stderr?.toString().trim()}`;
      await appendEvents(opts.ledgerDir, [
        makeEvent('dispatch', rec.id, 'build.crashed', { reason }),
        makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const }),
      ]);
      results.push({ item: rec.id, dispatched: false, eventsWritten: 2, detail: reason });
      continue;
    }

    // Provision node_modules from the TARGET repo's own checkout (manifest.depsWorkdirs) —
    // the target lane historically skipped this and every gate needing a local toolchain
    // (tsc et al.) failed 127. The deps source is the target's repoPath, never the plane's
    // embedded repo: a target knows its own dependency roots.
    if (manifest.depsWorkdirs.length > 0) {
      const depsSetup = setupWorktreeDeps(gitRoot, wtPath, manifest.depsWorkdirs);
      if (depsSetup.buildFailures.length > 0) {
        const reason = `infra: target file:-dep build failed: ${depsSetup.buildFailures.join('; ')}`;
        await appendEvents(opts.ledgerDir, [
          makeEvent('dispatch', rec.id, 'gate.failed', { reason }),
          makeEvent('dispatch', rec.id, 'item.parked', { reason, parkKind: 'ops' as const }),
        ]);
        results.push({ item: rec.id, dispatched: false, eventsWritten: 2, detail: reason });
        continue;
      }
    }

    // ADR-008 §2 detach eligibility (fail-closed) — the SAME rule the legacy lane uses: the flag is
    // on AND the provider is Claude-CLI (matched by name containing 'claude', so a test fixture like
    // 'fake-claude-cli' still counts). Anything else falls back to the sync path unchanged.
    const detachEligible = detachedDispatch && activeProvider.name.includes('claude');

    // build.dispatched timing mirrors the legacy lane: the SYNC path records it now, carrying the
    // beat's own pid. The DETACHED path defers it until after the spawn — once the pgid is known it
    // records pgid instead of pid, so the collection scan (top of this function) can find and drain
    // it a later beat. Recording pid here on a detach-eligible build would be wrong the moment the
    // child detaches, so it is deferred.
    if (!detachEligible) {
      await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'build.dispatched', {
        attempt, worktree: wtPath, branch, pid: process.pid, provider: activeProvider.name,
        model: rec.model ?? cfg.models.builderDefault,
      })]);
    }

    // ── Build worker in the target worktree ──────────────────────────────────
    const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath, stdio: 'pipe' }).stdout?.toString().trim();
    const prompt = buildPrompt(spec, rec.repairContext, resolveAttachmentPaths(rec.sourceText));

    // ── ADR-008 §2 detached branch: spawn, record pgid, DON'T await this beat ──
    // onSpawn fires synchronously (claudeCli.ts) before run() resolves, so spawnedPgid is set right
    // after the call returns its Promise. Deliberately NOT awaited — the target-lane collection scan
    // at the top of this function finalizes it via the exit file (written under artifactDir, the same
    // dir the scan reads from) on a later beat. The beat returns before completion.
    if (detachEligible) {
      let spawnedPgid: number | undefined;
      const detachedPromise = activeProvider.run({
        prompt,
        model: rec.model ?? cfg.models.builderDefault,
        cwd: wtPath,
        tools: BUILDER_TOOLS,
        timeoutMs: manifest.buildTimeoutMinutes * 60 * 1000,
        detached: true,
        onSpawn: pgid => { spawnedPgid = pgid; },
        exitFile: { runDir: artifactDir, itemId: rec.id, attempt },
      });
      // Fire-and-forget: never awaited this beat (providers never reject — a resolved failure is a
      // ProviderError result, drained via the exit file next beat). Swallow defensively regardless.
      void detachedPromise.catch(() => { /* drained cross-beat via the exit file */ });
      await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'build.dispatched', {
        attempt, worktree: wtPath, branch, pgid: spawnedPgid, provider: activeProvider.name,
        model: rec.model ?? cfg.models.builderDefault,
      })]);
      results.push({
        item: rec.id, dispatched: true, branch, worktree: wtPath, gateOutcome: 'dispatched',
        eventsWritten: 1, detail: `dispatched detached (pgid ${spawnedPgid ?? 'unknown'}) — not awaited this beat`,
      });
      continue;
    }

    // Sync path (unchanged behaviour): await the attached worker, then gate/merge via the shared
    // terminal (the SAME finalizeTargetBuild the collection scan uses — one pipeline, not a fork).
    const result = await activeProvider.run({
      prompt,
      model: rec.model ?? cfg.models.builderDefault,
      cwd: wtPath,
      // Same allowed-tools contract as the batch lane — omitting it permission-blocks every
      // write in a headless session (no approver) and the build parks with "no commit".
      tools: BUILDER_TOOLS,
      timeoutMs: manifest.buildTimeoutMinutes * 60 * 1000,
    });
    results.push(await finalizeTargetBuild(opts, rec, {
      gitRoot, manifest, wtPath, branch, baseSha: baseSha ?? '', targetRunDir, attempt, providerName: activeProvider.name,
    }, result.ok
      ? { ok: true, text: result.text, usage: result.usage }
      : { ok: false, error: result.error ?? 'unknown error' }));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Detached-build collection (ADR-008 phase A)
// ---------------------------------------------------------------------------

/**
 * Cross-beat collection pass (ADR-008 §3, phase B). UNCONDITIONAL — runs regardless of
 * `execution.detachedDispatch`, so any pgid-bearing 'building' item left by a prior beat
 * (even one dispatched before the flag was flipped on, or after it's flipped back off) still
 * drains. Considers every item that is:
 *   - state === 'building'
 *   - currentBuild.pgid != null (detached — a legacy pid-only build is never collected here;
 *     it keeps the doctor's ordinary dead-pid orphan path)
 *
 * Phase B: a detached group may be MULTI-ITEM (a co-located batch spawned as one worker). Such
 * a group shares one worktree/branch/pgid across all members, but only the CARRIER writes an
 * exit file. So items are bucketed by worktree, the carrier is the member with a readable exit
 * file for ITS attempt, and each bucket becomes ONE WorkerEntry (carrier first, companions
 * after) — a bucket with no readable carrier exit file yet is deferred WHOLE (never a
 * companion collected alone). The WorkerEntry carries an ALREADY-RESOLVED providerPromise
 * decoded from that carrier exit record via the SAME parseOutput/extractUsage the Phase-2
 * loop's own exit-file preference already uses (one-parser invariant, ADR-008 §3) — never a
 * second outcome parser.
 * A missing/unreadable usage JSON still yields a resolved result (ok when exitCode===0, a
 * generic error otherwise) so the terminal loop's exit-file-preference re-read at its own
 * `readExitFile` call is a no-op confirmation, not the sole source of truth.
 *
 * Pure over its inputs (no fs writes) — the caller feeds the returned handles into the same
 * Phase-2 terminal loop that processes freshly-spawned workers; there is no separate
 * collection pipeline.
 */
export function collectDetachedBuilds(
  foldResult: FoldResult,
  artifactDir: string,
): WorkerEntry[] {
  // PHASE B: a detached group may hold MORE than one item (a co-located batch spawned as one
  // detached worker). Every member is 'building' carrying the SAME pgid/branch/worktree, but
  // only the CARRIER (group[0], the id the exit file was written under) ever gets an exit file
  // — companions never do. Collecting each member independently (phase A's singleton-only shape)
  // would strand the companions in 'building' forever. So bucket every pgid-bearing building
  // item by its shared worktree, find the carrier (the member whose exit file is readable),
  // and reconstruct ONE WorkerEntry per group with the carrier first (recs[0] — the terminal
  // loop names the branch/merge off it) and the companions after. A singleton group is the
  // degenerate case (carrier == only member), byte-identical to phase A.
  const byWorktree = new Map<string, ItemRecord[]>();
  for (const rec of foldResult.items.values()) {
    if (rec.state !== 'building' || !rec.currentBuild) continue;
    // A TARGETED item's detached build is owned by the target lane (runTargetLane's own collection
    // scan), which gates/merges against ITS target repo. This plane pass gates/merges against the
    // plane repo, so admitting a targeted build here would merge target code into the wrong repo.
    if (rec.target) continue;
    const { pgid, branch, worktree } = rec.currentBuild;
    if (pgid == null) continue; // legacy sync build — not this pass's concern
    if (!branch || !worktree) continue; // can't reconstruct a terminal-loop handle without these
    const bucket = byWorktree.get(worktree);
    if (bucket) bucket.push(rec);
    else byWorktree.set(worktree, [rec]);
  }

  const collected: WorkerEntry[] = [];
  for (const members of byWorktree.values()) {
    // Carrier = the member whose exit file (written under ITS id, for ITS attempt) is readable.
    // Only one member ever writes one. If none is readable yet, the WHOLE group is not
    // collectable — defer it (the doctor's grace covers a truly orphaned group), never
    // strand-collect a companion on its own.
    let carrier: ItemRecord | undefined;
    let exitRecord: ReturnType<typeof readExitFile> | undefined;
    for (const rec of members) {
      const er = readExitFile(artifactDir, rec.id, rec.currentBuild!.attempt);
      if (er) { carrier = rec; exitRecord = er; break; }
    }
    if (!carrier || !exitRecord) continue;

    const { attempt, branch, worktree } = carrier.currentBuild!;

    // Decode the exit record into a resolved ProviderResult via the SAME parser the Phase-2
    // loop's own exit-file preference uses (one-parser invariant) — never a second parser.
    let text = '';
    let usage: { in: number; out: number; usd?: number; turns?: number; durationMs?: number } | undefined;
    if (exitRecord.usageJsonPath) {
      try {
        const { obj } = parseOutput(readFileSync(exitRecord.usageJsonPath, 'utf8'));
        if (obj) {
          if (typeof obj.result === 'string') text = obj.result;
          usage = extractUsage(obj) ?? usage;
        }
      } catch { /* best-effort — an unreadable usage json still yields a resolved result below */ }
    }
    const ok = exitRecord.exitCode === 0 && !exitRecord.authFailure;
    // authFailure (exitfile.ts) is the ONLY signal a cross-beat collector has that a detached
    // worker's terminal outcome was specifically "logged out mid-build" — decode it into the
    // same `code: 'auth'` the in-process sync path gets from ClaudeCliProvider.run(), so the
    // Phase-2 terminal loop's existing auth-failure branch (mark provider unhealthy, requeue via
    // build.crashed, never park/count toward the breaker) handles both paths identically.
    const providerPromise = Promise.resolve(
      ok
        ? { text, ok: true as const, usage }
        : {
          text: '',
          ok: false as const,
          error: exitRecord.authFailure
            ? 'detached worker: auth failure (session expired mid-build)'
            : `detached worker exited ${exitRecord.exitCode ?? '(signalled)'}`,
          code: exitRecord.authFailure ? 'auth' as const : undefined,
          usage,
        },
    );

    // Carrier first (recs[0] drives branch/gate/merge), companions after — mirrors the
    // spawn-side group order where group[0] is the carrier. The terminal loop emits the same
    // outcome for every member, so companion order among themselves is immaterial.
    const companions = members.filter(r => r !== carrier);
    collected.push({
      recs: [carrier, ...companions],
      branch: branch!,
      wtPath: worktree!,
      attempt,
      providerPromise,
      spawned: true,
      errFile: join(artifactDir, `${carrier.id}-agent.err`),
      provider: null,
    });
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDispatch(opts: DispatchOptions): Promise<DispatchResult> {
  // Autonomy gate — fail-safe: an unset LOOPKIT_AUTONOMY defaults to OFF (not on).
  // The launchd shims source .ai/loops/config.env which sets it explicitly, so production
  // behaviour is unchanged. Bare/cron/test invocations without the env set are safe-by-default.
  const envVal = process.env['LOOPKIT_AUTONOMY'];
  if (opts.autonomy === undefined && envVal === undefined) {
    process.stderr.write('[loopkit] LOOPKIT_AUTONOMY unset — defaulting to OFF (fail-safe); set it in .ai/loops/config.env\n');
  }
  const autonomy = opts.autonomy ?? (envVal ?? 'off');
  // Resolved run-state root for this plane — computed ONCE here and used for every
  // run-state site below (lock, artifacts, regression-guard watermarks, health markers).
  const resolvedRunDir = resolveRunDir(opts);
  // Liveness signal for the ops-console heartbeat probe (read as <runs>/dispatch/lastrun —
  // the beat's own lastrun dir is a SIBLING of the loopkit dir under the same runs root).
  try {
    const lastrunDir = join(dirname(resolvedRunDir), 'dispatch');
    mkdirSync(lastrunDir, { recursive: true });
    writeFileSync(join(lastrunDir, 'lastrun'), String(Math.floor(Date.now() / 1000)), 'utf8');
  } catch { /* non-fatal */ }
  if (autonomy === 'off') {
    return {
      dryRun: opts.dryRun ?? false,
      dispatched: [],
      totalEventsWritten: 0,
      detail: 'LOOPKIT_AUTONOMY=off — no-op',
    };
  }

  // Load config
  const cfg = opts.config ?? loadConfig(opts.repoRoot);
  // ADR-008 phase A: SPAWN-side only. Default false is byte-for-byte today's sync-in-beat
  // behaviour (no build ever records a pgid, so the collection pass below finds nothing).
  const detachedDispatch = cfg.execution?.detachedDispatch ?? false;

  // Acquire lock
  const runDir = resolvedRunDir;
  mkdirSync(runDir, { recursive: true });
  // Artifact directory for gate logs + diffs: defaults to runDir, overridable in tests.
  const artifactDir = opts.artifactRunsDir ?? runDir;
  const lockWedgeMs = (cfg.buildTimeoutMinutes + 5) * 60 * 1000;
  const lock = acquireDispatchLock(runDir, lockWedgeMs);
  if (!lock) {
    return {
      dryRun: opts.dryRun ?? false,
      dispatched: [],
      totalEventsWritten: 0,
      detail: 'dispatch already running (lock held)',
    };
  }
  const lockPath = lock.lockPath;
  // Surface the reclaim in the beat detail so a wedge-recovery is visible in the run log.
  const lockNote = lock.reclaimed ? `reclaimed stale lock (${lock.reclaimedWhy})` : undefined;
  if (lockNote) process.stderr.write(`[dispatch] ${lockNote}\n`);

  // Cross-beat watchdog: check reactor liveness (runs even in propose mode)
  if (!opts.dryRun) {
    const watchdogNote = crossBeatWatchdog(opts, cfg);
    if (watchdogNote) {
      process.stderr.write(`[dispatch] ${watchdogNote}\n`);
    }
  }

  try {
    // Halt BEFORE picking any queued item off a truncated ledger —
    // a re-fold of a shrunk file looks identical to "nothing new happened" and would let
    // dispatch re-build already-merged work (a ledger-wipe incident class).
    if (!opts.dryRun) {
      const regressionGuard = await checkLedgerRegressionGuard({
        repoRoot: opts.repoRoot,
        ledgerDir: opts.ledgerDir,
        runDir,
        loop: 'dispatch',
        notifyHook: cfg.notifyHook,
        notify: opts.notify,
        readMaxIds: opts.ledgerMaxIdsProbe,
      });
      if (regressionGuard.halted) {
        return {
          dryRun: false,
          dispatched: [],
          totalEventsWritten: 0,
          detail: regressionGuard.detail,
        };
      }
    }

    // Resolve provider — health-aware.
    // Use resolveWithHealth with requireTools=true: dispatch builds need an agentic tool loop.
    // The registry walks the configured chain, skipping unhealthy or tool-less providers.
    let provider: LlmProvider | null = null;
    let registry = null as ReturnType<typeof makeRegistry> | null;

    if (opts.provider !== undefined) {
      provider = opts.provider;
    } else {
      const healthFns = opts.readMarker
        ? { readMarker: opts.readMarker, writeMarker: opts.writeMarker, clearMarker: opts.clearMarker }
        : makeFileHealthFns(runDir);
      registry = makeRegistry({
        providers: Object.fromEntries(
          Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }])
        ),
        sensitivityAllowlists: cfg.sensitivityAllowlists,
        chains: cfg.chains,
        cooldownMs: cfg.providerCooldownMs,
      }, healthFns);
      // requireTools=true: dispatch builds require an agentic tool loop (builds need Read/Edit/Bash)
      provider = registry.resolveWithHealth('internal', { requireTools: true });
    }

    // Load ledger state
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    let foldResult = fold(allEvents);

    // ── Cross-beat collection pass (ADR-008 §3) ───────────────────────────
    // UNCONDITIONAL (not gated on execution.detachedDispatch): drains any pgid-bearing
    // 'building' item with a readable exit file, regardless of the flag's current value, so a
    // build dispatched detached under a since-flipped-off flag still gets collected. Runs
    // AFTER the initial fold but BEFORE the daily-budget/quota/empty-queue early returns and
    // before pick logic — those are SPAWN gates and must never strand an already-admitted,
    // finished build. The reconstructed handles feed the SAME Phase-2 terminal loop below
    // (prepended to `workers`); there is no separate collection pipeline.
    const collectedWorkers = opts.dryRun ? [] : collectDetachedBuilds(foldResult, artifactDir);
    if (collectedWorkers.length > 0) {
      process.stderr.write(`[dispatch] collected ${collectedWorkers.length} detached build(s) awaiting terminal processing: ${collectedWorkers.map(w => w.recs[0]!.id).join(', ')}\n`);
    }
    // Re-fold before picking new work (ADR-008 §3) — collection itself appends nothing yet
    // (the Phase-2 loop below appends the terminal events), so this is a no-op today, but
    // keeps the picker reading a fold taken AFTER collection as the plane evolves.
    foldResult = fold(await loadAllEventsWithQuarantine(opts.ledgerDir));

    // ADR-008 §3: SPAWN gates below (budget/quota/empty-queue) must never strand an
    // already-admitted, finished detached build. When collection found completed work,
    // each gate below skips picking NEW work (skipNewPicks) but falls through instead of
    // returning, so Phase 2 still drains collectedWorkers via the ordinary terminal loop.
    let skipNewPicks = false;
    let skipNewPicksDetail: string | undefined;

    // ── Daily budget ceiling ─────────────────────────────────────────
    // Watchdog MUST already have run above (happens regardless of autonomy/budget).
    // When a ceiling is configured, compute today's spend and bail out early if reached.
    const dailyCeiling = cfg.budget?.dispatchDailyUsd;
    if (dailyCeiling !== undefined && Number.isFinite(dailyCeiling) && dailyCeiling > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const todaySpend = spendForDay(allEvents, today);
      if (todaySpend >= dailyCeiling) {
        const detail = `daily budget reached: $${todaySpend.toFixed(4)} / $${dailyCeiling.toFixed(4)}`;
        process.stderr.write(`[dispatch] ${detail} — skipping picks\n`);
        if (collectedWorkers.length === 0) {
          return { dryRun: opts.dryRun ?? false, dispatched: [], totalEventsWritten: 0, detail };
        }
        skipNewPicks = true;
        skipNewPicksDetail = detail;
      }
    }

    // ── Quota-pressure degraded mode ──────────────────────────────────────────
    // Read-only gate over quota.snapshot history (see quota-pressure.ts): when any
    // provider:window's latest reading is at/above the configured threshold, stop picking
    // new items for this beat. Spawn-only — the reactor (routing, merges, doctor, report)
    // runs in a separate process and is unaffected.
    // Fail-open: no snapshot events or an absent/invalid threshold never trigger this.
    if (!skipNewPicks) {
      const quotaPressure = opts.quotaPressureProbe
        ? { degraded: opts.quotaPressureProbe(), breaches: [] as { provider: string; window: string; usedPct: number }[] }
        : computeQuotaPressure(allEvents, cfg.quotaPressure?.thresholdPct);
      if (quotaPressure.degraded) {
        const detail = quotaPressure.breaches.length > 0
          ? `quota pressure: ${quotaPressure.breaches.map(b => `${b.provider}:${b.window}=${b.usedPct.toFixed(1)}%`).join(', ')} >= ${cfg.quotaPressure?.thresholdPct}% — skipping picks`
          : 'quota pressure: degraded (test probe) — skipping picks';
        process.stderr.write(`[dispatch] ${detail}\n`);
        if (collectedWorkers.length === 0) {
          return { dryRun: opts.dryRun ?? false, dispatched: [], totalEventsWritten: 0, detail };
        }
        skipNewPicks = true;
        skipNewPicksDetail = detail;
      }
    }

    // Collect queued items, sorted by priority. ADR-008 §3: a budget/quota gate above that
    // found collected detached work to drain sets skipNewPicks — force the pick list empty so
    // this beat drains ONLY the already-admitted collected work, never a fresh spawn.
    let queued = skipNewPicks ? [] : Array.from(foldResult.items.values())
      // Session-mode deference: an item with an ACTIVE claim belongs to an attended
      // session; the beat skips it. Expired/stale claims read as unclaimed (computed,
      // never mutated) so a dead session releases its work within one beat.
      .filter(r => r.state === 'queued' && r.spec && !isClaimActive(r, foldResult.sessions, Date.now()))
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority ?? 'medium'] ?? 2;
        const pb = PRIORITY_ORDER[b.priority ?? 'medium'] ?? 2;
        return pa !== pb ? pa - pb : a.id.localeCompare(b.id);
      });

    // Declared here (rather than alongside allNewEvents/mergedWiIds below) so the pre-dispatch
    // cancel check immediately below can push its park results before the main dispatch loop.
    const results: DispatchStepResult[] = [];

    // Run-controls hard-stop, pre-dispatch check (the cheap path): a queued item can carry an
    // unconsumed cancel-requested from a
    // PRIOR attempt whose kill raced the terminal event (e.g. the operator hit Stop right as the
    // build finished/crashed on its own and the item already cycled back to queued). Rather than
    // silently re-dispatching under a live cancel, park it directly — no process involved, no
    // worktree spun up just to be killed again.
    if (!opts.dryRun && queued.length > 0) {
      const stillCancelled: string[] = [];
      const survivors: ItemRecord[] = [];
      for (const r of queued) {
        const nextAttempt = (r.attempts ?? 0) + 1;
        if (hasUnconsumedCancelRequest(allEvents, r.id, nextAttempt)) {
          stillCancelled.push(r.id);
        } else {
          survivors.push(r);
        }
      }
      if (stillCancelled.length > 0) {
        const cancelParkEvents = stillCancelled.flatMap(id => [
          makeEvent('dispatch', id, 'item.parked', { reason: 'stopped by operator', parkKind: 'hold' as const }),
        ]);
        await appendEvents(opts.ledgerDir, cancelParkEvents);
        for (const id of stillCancelled) {
          results.push({ item: id, dispatched: false, eventsWritten: 1, detail: 'stopped by operator (pre-dispatch cancel)' });
        }
        queued = survivors;
      }
    }

    if (queued.length === 0 && collectedWorkers.length === 0) {
      return {
        dryRun: opts.dryRun ?? false,
        dispatched: results,
        totalEventsWritten: results.reduce((n, r) => n + r.eventsWritten, 0),
        detail: results.length > 0 ? 'all queued items were stopped by operator' : (skipNewPicksDetail ?? 'no queued items'),
      };
    }

    // The planning lane runs its own dedicated path (runPlanningLane below) —
    // no worktree, no commit, no merge — never the engineering Touches/worktree machinery.
    // Same breaker skip as the engineering picker below (an exhausted item needs a fresh
    // unpark before it is retried).
    const planningQueued = queued.filter(r => {
      if (r.lane !== 'planning') return false;
      if (r.attempts >= BUILDER_BREAKER_N) {
        const freshUnpark = r.lastUnparkedAt && (!r.parkedAt || r.lastUnparkedAt > r.parkedAt);
        if (!freshUnpark) return false;
      }
      return true;
    });
    // TARGET EXTERNALIZATION: targeted items (rec.target set) run their own serial lane
    // (runTargetLane) against their target repo — never the plane's batch/worktree machinery.
    // Split them out BEFORE grouping so the legacy engineering path and its existing test
    // suite are byte-for-byte unchanged: with no targets registered, targetedQueued is always empty.
    const targetedQueued = queued.filter(r => r.lane !== 'planning' && r.target);
    const engineeringQueued = queued.filter(r => r.lane !== 'planning' && !r.target);

    // Collect in-flight touches (building items). A planning build never writes a file, so
    // it must never wildcard-block an engineering pick (or be blocked by one).
    const inflight = Array.from(foldResult.items.values()).filter(r => r.state === 'building' && r.lane !== 'planning');
    let inflightTouches: string | undefined;
    for (const rec of inflight) {
      if (!rec.touches) { inflightTouches = '*'; break; }
      inflightTouches = inflightTouches ? `${inflightTouches},${rec.touches}` : rec.touches;
    }

    // Select the dispatch groups. Each group becomes ONE worktree. Groups are
    // Touches-disjoint from each other (parallel worktrees can't share a footprint);
    // within a group, batch co-location may pull SMALL, Touches-OVERLAPPING
    // items into the same worker run so they share one gate + merge. batchMaxItems=1
    // disables co-location entirely (every group is a single item — legacy behaviour).
    const batchMax = Math.max(1, cfg.batchMaxItems ?? 1);
    const groups: ItemRecord[][] = [];

    for (const rec of engineeringQueued) {
      // Never dispatch something that conflicts with an in-flight build.
      if (inflightTouches && touchesConflict(rec.touches, inflightTouches)) continue;

      // Circuit breaker: skip items that have exhausted their attempt budget.
      // an operator can override by explicitly unparking (item.unparked after the last item.parked).
      if (rec.attempts >= BUILDER_BREAKER_N) {
        const freshUnpark = rec.lastUnparkedAt &&
          (!rec.parkedAt || rec.lastUnparkedAt > rec.parkedAt);
        if (!freshUnpark) continue;
      }

      // Co-locate an overlapping small item into an existing eligible group instead of
      // stranding it across beats (the whole point of batching — shared footprint items
      // otherwise serialise one-merge-at-a-time).
      if (batchMax > 1 && isBatchEligible(rec)) {
        const host = groups.find(g =>
          g.length < batchMax &&
          isBatchEligible(g[0]) &&
          touchesConflict(rec.touches, groupTouches(g)),
        );
        if (host) { host.push(rec); continue; }
      }

      // Otherwise start a new worktree — but only if it stays Touches-disjoint from every
      // other group (an overlapping item that couldn't co-locate waits for a later beat).
      if (groups.some(g => touchesConflict(rec.touches, groupTouches(g)))) continue;
      groups.push([rec]);
    }

    if (groups.length === 0 && planningQueued.length === 0 && targetedQueued.length === 0 && collectedWorkers.length === 0) {
      return {
        dryRun: opts.dryRun ?? false,
        dispatched: [],
        totalEventsWritten: 0,
        detail: 'all queued items conflict with in-flight or each other',
      };
    }

    // ── Pre-flight auth probe (health-aware breaker) ────────────
    // Run BEFORE any build.dispatched event so a logged-out beat never moves items to
    // 'building'. Only fires when there is real NEW work to dispatch this beat — a beat that
    // is only draining collected detached builds (ADR-008 §3, no fresh groups/planning/target
    // picks) never needs a live provider ping; skip it so a collection-only beat is not
    // blocked on provider health it doesn't need.
    if (!opts.dryRun && provider && (groups.length > 0 || planningQueued.length > 0 || targetedQueued.length > 0)) {
      const flagPath = join(runDir, 'dispatch-auth-failed');
      const probeOk = opts.authProbeResult
        ? opts.authProbeResult.ok
        : await (async () => {
            const r = await provider!.run({ prompt: 'ping', timeoutMs: 15_000 });
            // Only 'auth' code = logged out. Other failures (parse/spawn/timeout) are transient.
            if (!r.ok && r.code === 'auth') {
              // Mark current provider unhealthy and try to fall over
              if (registry) {
                registry.markUnhealthy(provider!.name, r.error ?? 'auth failure');
                const fallback = registry.resolveWithHealth('internal', { requireTools: true });
                if (fallback) {
                  process.stderr.write(`[dispatch] provider: ${provider!.name} auth failure — falling back to ${fallback.name}\n`);
                  provider = fallback;
                  return true; // continue with fallback
                }
              }
              return false;
            }
            return r.ok || r.code !== 'auth';
          })();
      if (!probeOk) {
        if (!existsSync(flagPath)) {
          try { writeFileSync(flagPath, String(Math.floor(Date.now() / 1000)), 'utf8'); } catch { /* ignore */ }
          process.stderr.write('[dispatch] infra: builder not logged in — run /login to restore the beat\n');
        }
        return {
          dryRun: false,
          dispatched: [],
          totalEventsWritten: 0,
          detail: 'infra: builder not logged in — run /login (flag: .ai/runs/loopkit/dispatch-auth-failed)',
        };
      }
      // Authenticated — self-recovery: clear the unhealthy marker and any stale flag.
      // This means a later beat where the ping succeeds automatically recovers visibility.
      if (registry) registry.clearUnhealthy(provider.name);
      try { rmSync(flagPath, { force: true }); } catch { /* ignore */ }
    }

    // Builder allowed tools — shared module constant (see BUILDER_TOOLS above): both the
    // batch lane and the target lane MUST pass it, or a headless worker gets permission-
    // prompted on every write and honestly parks with "no commit".
    const builderTools = BUILDER_TOOLS;

    // ── Build routing table once per beat ──────────────────────
    // Reuse the allEvents already loaded above; projectTrajectory is pure (no I/O).
    // The table is keyed bucket × model → { samples, firstPassRate, avgUsd }.
    // Use a specsByWi map so each item's spec can be bucketed correctly.
    const routingCfgRaw = mergeRoutingConfig(cfg.routing, ROUTING_CONFIG_DEFAULTS);
    const routingCfg = opts.routingMode !== undefined
      ? { ...routingCfgRaw, mode: opts.routingMode }
      : routingCfgRaw;
    const routingRand = opts.routingRand ?? Math.random.bind(Math);
    const trajectoryProjection = projectTrajectory(allEvents, { days: routingCfg.windowDays });
    // Build specsByWi from the fold: map each WI to its current spec text (or undefined).
    const specsByWiForRouting = new Map<string, string | undefined>(
      Array.from(foldResult.items.entries()).map(([id, r]) => [id, r.spec ?? r.sourceText]),
    );
    const routingTable = buildRoutingTableWithSpecs(
      trajectoryProjection.attempts,
      specsByWiForRouting,
      { windowDays: routingCfg.windowDays },
    );
    // ─────────────────────────────────────────────────────────────────────────

    let anyMerged = false;
    const mergedWiIds: string[] = [];
    const allNewEvents: ReturnType<typeof makeEvent>[] = [];

    // Dispatch the planning lane first — it touches no git state, so it runs
    // ahead of (and independent of) the engineering worktree/merge machinery below.
    if (planningQueued.length > 0) {
      if (opts.dryRun) {
        for (const r of planningQueued) {
          results.push({ item: r.id, dispatched: true, gateOutcome: 'dry-run', eventsWritten: 0, detail: 'dry-run: would run planner' });
        }
      } else if (!provider) {
        const reason = 'infra: no provider available for dispatch';
        const events = planningQueued.map(r => makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' as const }));
        await appendEvents(opts.ledgerDir, events);
        for (const r of planningQueued) results.push({ item: r.id, dispatched: false, eventsWritten: 1, detail: reason });
      } else {
        results.push(...await runPlanningLane(opts, cfg, provider, planningQueued, runDir, registry));
      }
    }

    // TARGET EXTERNALIZATION: targeted items build in their own serial lane, each against its
    // target repo (worktree + gate + merge there), independent of the plane's batch machinery.
    // Empty when no target is registered — legacy dispatch runs exactly as before.
    // Also run the lane when a prior beat left a DETACHED targeted build in flight (ADR-008 §3):
    // it is 'building' with a pgid but no fresh queued item, so targetedQueued would be empty — the
    // lane's own collection scan drains it against its target repo.
    const hasDetachedTargetBuild = !opts.dryRun && [...foldResult.items.values()].some(
      r => r.state === 'building' && !!r.target && r.currentBuild?.pgid != null,
    );
    if (targetedQueued.length > 0 || hasDetachedTargetBuild) {
      results.push(...await runTargetLane(opts, cfg, provider, foldResult, targetedQueued, runDir, registry));
    }

    // Pull master once so all worktrees branch from the same fresh HEAD
    if (!opts.dryRun) {
      spawnSync('git', ['pull', '--rebase', '--autostash'], {
        cwd: opts.repoRoot, stdio: 'pipe',
      });
    }

    // ── Phase 1: Spawn workers in parallel ────────────────────────────────

    // Playbook injection: read once; injected into every worker prompt.
    // Fail-open: missing file or read error → cold build (playbookContent stays undefined).
    const playbookEnabled = cfg.playbook?.enabled !== false;
    let playbookContent: string | undefined;
    if (playbookEnabled) {
      const playbookPath = join(opts.repoRoot, cfg.playbook?.path ?? '.ai/loops/playbook.md');
      try {
        const raw = readFileSync(playbookPath, 'utf8');
        const maxLines = cfg.playbook?.maxLines ?? 40;
        const lessons = raw.split('\n')
          .filter(l => l.trim() && !l.trimStart().startsWith('#'))
          .slice(0, maxLines);
        if (lessons.length > 0) playbookContent = lessons.join('\n');
      } catch { /* fail-open: no playbook file → cold build */ }
    }

    // ADR-008 §3: prepend collected (already-finished, awaiting-terminal-processing) detached
    // builds so the SAME Phase-2 terminal loop below drains them alongside any freshly-spawned
    // worker this beat starts — one pipeline, not a second parser or a second gate/merge path.
    const workers: WorkerEntry[] = [...collectedWorkers];

    // ── Claim-before-pick (ADR-007 gap 1 + 2) ───────────────────────────────
    // Close the read-to-spawn race: an attended operator session can claim an item in the
    // window between the picker's fold-read above and this beat actually spawning a worker.
    // Under the SAME per-item reservation path an attended session uses (item.claimed), and
    // under a live per-run pseudo-session (so isClaimActive reads dispatch's own claims as
    // active — ADR-007 gap 2), re-read + re-fold the ledger under the ledger lock, drop any
    // item a foreign session claimed in the meantime, and claim every surviving item in the
    // same locked append before spawning anything. Dry-run never writes claims (opts.dryRun).
    if (!opts.dryRun && groups.length > 0) {
      const candidateIds = groups.flatMap(g => g.map(r => r.id));
      const dispatchSessionId = opts.dispatchSessionId ?? mintSessionId();
      const claimTtlMinutes = cfg.buildTimeoutMinutes + 5;
      const decisions = await withLock(opts.ledgerDir, async (tx) => {
        const freshEvents = await tx.loadAll();
        const freshResult = fold(freshEvents);
        const nowMs = Date.now();
        // Same window a claim stays active (buildTimeout + 5 min): a build.dispatched newer than
        // this is a live foreign build to yield to; older is a reapable orphan the doctor owns.
        const decided = decideClaimArbitration(candidateIds, freshResult, dispatchSessionId, nowMs, claimTtlMinutes * 60_000);
        const kept = decided.filter(d => d.keep);
        if (kept.length > 0) {
          const lockEvents: LedgerEvent[] = [
            makeEvent('dispatch', dispatchSessionId, 'session.started', { sessionId: dispatchSessionId, source: 'dispatch' }),
            makeEvent('dispatch', dispatchSessionId, 'session.heartbeat', { sessionId: dispatchSessionId }),
            ...kept.map(d => makeEvent('dispatch', d.item, 'item.claimed', { sessionId: dispatchSessionId, ttlMinutes: claimTtlMinutes })),
          ];
          await tx.append(lockEvents);
        }
        return decided;
      });
      const yieldedIds = new Set(decisions.filter(d => !d.keep).map(d => d.item));
      if (yieldedIds.size > 0) {
        for (const d of decisions) {
          if (d.keep) continue;
          results.push({
            item: d.item,
            dispatched: false,
            eventsWritten: 0,
            detail: d.foreignBuild
              ? 'yielded to foreign in-flight build (recent build.dispatched)'
              : `yielded to attended claim (session ${d.foreignSessionId})`,
          });
        }
        // Drop yielded items from their groups; drop any group left empty.
        for (let i = groups.length - 1; i >= 0; i--) {
          const survivors = groups[i]!.filter(r => !yieldedIds.has(r.id));
          if (survivors.length === 0) {
            groups.splice(i, 1);
          } else {
            groups[i] = survivors;
          }
        }
      }
    }

    for (const group of groups) {
      // Long-beat heartbeat: worktree setup (incl. deps provisioning) is serial and can
      // take minutes per group — refresh the liveness stamp between groups.
      if (!opts.dryRun) writeBeatHeartbeat(resolvedRunDir, 'dispatch');
      const rec = group[0];   // carrier item — names the worktree/branch
      const wiNum = rec.id.replace('WI-', '').padStart(3, '0');
      // Attempt-unique branch: parks deliberately KEEP the prior attempt's branch
      // for operator review (spine/touches/tests-red paths below drop only the worktree, not the
      // branch). Reusing `wi-NNN` across attempts would clobber that reviewable branch with
      // `git branch -D` and no event. Naming each attempt `wi-NNN-a<attempt>` means a later
      // attempt never reuses or deletes an earlier attempt's branch. The fold's
      // currentBuild.branch carries this exact name, so the reactor merge/approve paths that read
      // the branch off the ledger keep working unchanged.
      const attemptNum = (rec.attempts ?? 0) + 1;
      const branch = `wi-${wiNum}-a${attemptNum}`;
      const wtPath = join(opts.repoRoot, '..', `${cfg.worktreePrefix}wi-${wiNum}-a${attemptNum}`);
      const errFile = join(runDir, `${rec.id}-agent.err`);

      // TRUST-HARDENING (defect c): resolve THIS group's builder provider against its most
      // restrictive member sensitivity, fail-closed. The beat's global `provider` was resolved
      // once against a hardcoded 'internal'; building a 'private' item (or a batch containing one)
      // through it would send that item's spec + worktree file contents to whatever the internal
      // chain resolves to (an external provider by default) — the end-to-end hole. When the group's
      // tier has no allowed+healthy tool-capable provider, we park the whole group fail-closed
      // rather than build it through a disallowed provider. On the injected-provider test path
      // (no registry) the caller's single provider is used unchanged (fixtures are default-internal).
      const grpSensitivity = groupSensitivity(group);
      const groupProvider: LlmProvider | null =
        resolveProviderForSensitivity(registry, provider, grpSensitivity, { requireTools: true });
      if (registry && !groupProvider) {
        const reason = `sensitivity(${grpSensitivity}): no allowed+healthy provider for this tier — parked fail-closed (never routed to a disallowed provider)`;
        for (const r of group) allNewEvents.push(makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' }));
        results.push({ item: rec.id, dispatched: false, eventsWritten: group.length, detail: reason });
        workers.push({ recs: group, branch, wtPath, attempt: attemptNum, providerPromise: null, spawned: false, errFile, provider: null });
        continue;
      }

      // ADR-008 §2 eligibility (fail-closed). PHASE B (core parallelism): detach now applies to
      // ANY engineering group on the Claude-CLI provider when the flag is on — no longer just
      // single-item groups. A group is ONE worktree/worker, so a multi-item (co-located batch)
      // group still runs its members SEQUENTIALLY inside that single detached worker, preserving
      // the intra-group file-ownership serialization; detaching only stops disjoint GROUPS from
      // serializing against each other whole-beat, so all Touches-disjoint groups now spawn in
      // parallel in one beat pass. Fail-closed still holds: a non-Claude provider or the flag off
      // falls back to the sync path unchanged. Matching by `.name` containing 'claude' (not a
      // strict equality) so a test fixture provider named e.g. 'fake-claude-cli' is still
      // recognized, per the ADR's stated fallback identification rule.
      const detachEligible = detachedDispatch && (groupProvider?.name.includes('claude') ?? false);

      // ── Eval-driven model routing ──────────────────────────
      // Incumbent = what the item requested (or config default).
      // chooseModel returns the actual model to use + advisory/source metadata.
      const carrierIncumbent = rec.model ?? cfg.models.builderDefault;
      const carrierSpec = rec.spec ?? rec.sourceText ?? '';
      const carrierBucket = bucketSpec(carrierSpec);
      const routingChoice = chooseModel(routingTable, carrierBucket, carrierIncumbent, routingCfg, routingRand);
      // ─────────────────────────────────────────────────────────────────────

      // build.dispatched is per-item: every group member moves to 'building' so no other
      // beat re-dispatches a co-located companion.
      // The routed model is recorded on the carrier; co-located companions keep their own model.
      const dispatchEventsFor = (extra: Record<string, unknown>) =>
        group.map(r => {
          const itemModel = r.id === rec.id
            ? routingChoice.model   // carrier: use routed model
            : (r.model ?? cfg.models.builderDefault); // companion: use own model
          const routingExtra: Record<string, unknown> = {
            ...(routingChoice.modelSource !== 'incumbent' ? { modelSource: routingChoice.modelSource } : {}),
            ...(routingChoice.modelAdvisory !== undefined ? { modelAdvisory: routingChoice.modelAdvisory } : {}),
          };
          return makeEvent('dispatch', r.id, 'build.dispatched', {
            attempt: (r.attempts ?? 0) + 1,
            worktree: wtPath,
            branch,
            model: itemModel,
            ...routingExtra,
            ...extra,
          });
        });

      if (opts.dryRun) {
        workers.push({ recs: group, branch, wtPath, attempt: attemptNum, providerPromise: null, spawned: true, errFile, provider: groupProvider });
        results.push({
          item: rec.id,
          dispatched: true,
          branch,
          worktree: wtPath,
          gateOutcome: 'dry-run',
          eventsWritten: 0,
          detail: group.length > 1
            ? `dry-run: would batch ${group.map(r => r.id).join('+')} to ${branch}`
            : `dry-run: would dispatch to ${branch}`,
        });
        allNewEvents.push(...dispatchEventsFor({ provider: provider?.name ?? 'none' }));
        continue;
      }

      // Remove stale worktree and branch
      removeWorktree(opts.repoRoot, wtPath);
      spawnSync('git', ['branch', '-D', branch], { cwd: opts.repoRoot, stdio: 'pipe' });

      // Create worktree
      const wtAdd = spawnSync('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], {
        cwd: opts.repoRoot, stdio: 'pipe',
      });
      if (wtAdd.status !== 0) {
        const reason = `infra: worktree add failed: ${wtAdd.stderr?.toString().trim()}`;
        for (const r of group) {
          allNewEvents.push(makeEvent('dispatch', r.id, 'build.crashed', { reason }));
          allNewEvents.push(makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' }));
        }
        results.push({
          item: rec.id, dispatched: false, eventsWritten: 2 * group.length, detail: reason,
        });
        workers.push({ recs: group, branch, wtPath, attempt: attemptNum, providerPromise: null, spawned: false, errFile, provider: groupProvider });
        continue;
      }

      // Set up node_modules for every deps workdir — the gate may run suites in more than
      // one package (the gate script rebuilds the framework's own package when the diff touches
      // it); a missing link there causes a `tsc: command not found` approve-gate failure. For a
      // workdir with local `file:` deps this overlays the main tree's node_modules but points
      // the file: package at the WORKTREE's copy so a branch changing both the package and the
      // app compiles against the branch source, not the stale main tree.
      const depsSetup = setupWorktreeDeps(opts.repoRoot, wtPath, cfg.depsWorkdirs ?? [cfg.appWorkdir]);
      if (depsSetup.buildFailures.length > 0) {
        // A file:-dep build that exits non-zero means the gate would run against stale dist
        // and silently green. Park immediately rather than lie.
        const reason = `infra: file:-dep build failed: ${depsSetup.buildFailures.join('; ')}`;
        for (const r of group) {
          allNewEvents.push(makeEvent('dispatch', r.id, 'gate.failed', { reason }));
          allNewEvents.push(makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' }));
        }
        results.push({
          item: rec.id, dispatched: false, eventsWritten: 2 * group.length, detail: reason,
        });
        removeWorktree(opts.repoRoot, wtPath);
        spawnSync('git', ['branch', '-D', branch], { cwd: opts.repoRoot, stdio: 'pipe' });
        workers.push({ recs: group, branch, wtPath, attempt: attemptNum, providerPromise: null, spawned: false, errFile, provider: groupProvider });
        continue;
      }

      if (!groupProvider) {
        const reason = 'infra: no provider available for dispatch';
        for (const r of group) allNewEvents.push(makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' }));
        results.push({ item: rec.id, dispatched: false, eventsWritten: group.length, detail: reason });
        workers.push({ recs: group, branch, wtPath, attempt: attemptNum, providerPromise: null, spawned: false, errFile, provider: groupProvider });
        continue;
      }

      // Append build.dispatched (→ 'building') here, right after worktree setup —
      // BEFORE the scout/brief stage below, which can run for ~90s. Appending it only after
      // provider.run() was spawned (post-scout) would leave counts.building at 0 for the whole
      // scout window even though a worktree + worker were already alive — the reactor/console
      // would under-report in-flight work.
      //
      // ADR-008 §2: a detach-eligible build's pgid is not known until AFTER groupProvider.run()
      // synchronously invokes onSpawn, so appending here (pre-scout, pre-spawn) would have to
      // carry `pid: process.pid` and then be wrong the moment the child detaches. For a
      // detach-eligible build, DEFER this append — it happens right after the spawn call below,
      // once spawnedPgid is known, carrying `pgid` instead of `pid`. The sync path (the common
      // case, and every non-eligible shape) keeps this exact pre-scout timing unchanged: the pid
      // recorded is always the beat's own pid, same as before this ADR landed.
      if (!detachEligible) {
        allNewEvents.push(...dispatchEventsFor({ pid: process.pid, provider: groupProvider.name }));
        await appendEvents(opts.ledgerDir, allNewEvents);
        allNewEvents.length = 0;
      }

      // The carrier's model drives the run; co-location only ever groups sonnet items.
      // Use the routed model (may be the same as incumbent in advisory mode).
      const model = routingChoice.model;
      const effort = rec.effort;

      // ── Scout stage ─────────────────────────────────────────
      // For each item in the group that has no stored brief, run ONE read-only scout call.
      // Fail-open: any failure → log + proceed cold. The scout NEVER blocks a build.
      // Items with a pre-existing rec.brief (from a prior beat's item.briefed event)
      // reuse the stored brief — that is the memoization point.
      const scoutEnabled = opts.scoutEnabled !== undefined
        ? opts.scoutEnabled
        : (cfg.scout?.enabled ?? true);
      const scoutModel = cfg.scout?.model ?? 'haiku';
      const scoutTimeoutMs = cfg.scout?.timeoutMs ?? 300_000;

      // Per-item brief map: populated during scout stage, consumed in the prompt below.
      const briefByItem = new Map<string, string>();

      if (scoutEnabled) {
        for (const r of group) {
          // Skip if already briefed (memoization: reuse the stored brief).
          if (r.brief?.text) {
            briefByItem.set(r.id, r.brief.text);
            continue;
          }

          // Scout call (injected result in tests, else real provider).
          let scoutResult: { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } };
          const injected = opts.scoutResults?.get(r.id);
          if (injected !== undefined) {
            scoutResult = injected;
          } else {
            const scoutRaw = await groupProvider.run({
              prompt: buildScoutPrompt(r.id, r.spec ?? r.sourceText ?? '', r.touches),
              model: scoutModel,
              cwd: wtPath,
              tools: ['Read', 'Grep', 'Glob'],
              timeoutMs: scoutTimeoutMs,
            });
            scoutResult = scoutRaw.ok
              ? { ok: true, text: scoutRaw.text, usage: scoutRaw.usage }
              : { ok: false, error: (scoutRaw as { error: string }).error, code: (scoutRaw as { code?: string }).code };
          }

          if (!scoutResult.ok || !scoutResult.text) {
            // Scout failed or returned empty — proceed cold, never block.
            process.stderr.write(
              `[dispatch] scout: ${r.id} failed (${scoutResult.error ?? 'empty result'}) — building cold\n`,
            );
            continue;
          }

          const brief = parseBrief(scoutResult.text);
          if (!brief) {
            process.stderr.write(`[dispatch] scout: ${r.id} returned empty brief — building cold\n`);
            continue;
          }

          briefByItem.set(r.id, brief);

          // Append item.briefed + cost.usage (scout) to the ledger now, before build.dispatched.
          const scoutEvents: ReturnType<typeof makeEvent>[] = [
            makeEvent('dispatch', r.id, 'item.briefed', { brief, model: scoutModel }),
          ];
          if (scoutResult.usage) {
            scoutEvents.push(makeEvent('dispatch', r.id, 'cost.usage', {
              provider: groupProvider.name,
              loop: 'scout',
              tokens: (scoutResult.usage.in ?? 0) + (scoutResult.usage.out ?? 0),
              usd: scoutResult.usage.usd,
              wi: r.id,
            }));
          }
          await appendEvents(opts.ledgerDir, scoutEvents);
        }
      }

      // Repair evidence assembly: for items with prior attempts, look up
      // the highest prior attempt that has gate-log + diff artifacts and assemble a
      // REPAIR EVIDENCE section with the critique-then-fix instruction. Fail-open:
      // missing artifacts → undefined → cold prompt (no crash, no park).
      const evidenceByItem = new Map<string, string | undefined>();
      for (const r of group) {
        if ((r.attempts ?? 0) > 0) {
          const ev = assembleRepairEvidence(artifactDir, r.id, (r.attempts ?? 0) + 1, r.repairContext);
          evidenceByItem.set(r.id, ev);
        }
      }

      // Salvage resume: if the highest prior attempt left a .salvage.patch,
      // try to apply it to the new worktree. Fail-open: apply failure → reference wording only.
      // Section order in prompt: CONTEXT PACK → RESUME NOTE → REPAIR EVIDENCE → REQUEST.
      const salvageEnabledForGroup = opts.salvageEnabled !== undefined ? opts.salvageEnabled : (cfg.salvage?.enabled !== false);
      const resumeNoteByItem = new Map<string, string | undefined>();
      if (salvageEnabledForGroup) {
        for (const r of group) {
          if ((r.attempts ?? 0) > 0) {
            try {
              const found = findSalvagePatch(artifactDir, r.id, (r.attempts ?? 0) + 1);
              if (found) {
                let mdContent = '';
                try {
                  if (existsSync(found.mdPath)) mdContent = readFileSync(found.mdPath, 'utf8');
                } catch { /* best-effort */ }
                const applied = applySalvagePatch(wtPath, found.patchPath);
                const note = buildResumeNote(applied, mdContent, found.patchPath);
                resumeNoteByItem.set(r.id, note);
              }
            } catch (e) {
              process.stderr.write(`[dispatch] salvage resume: ${r.id} error: ${e}\n`);
              // Fail-open: no resume note, proceed cold
            }
          }
        }
      }

      // One prompt: single spec, or a batch prompt listing every co-located spec.
      // Brief (context pack) is injected when available; repair evidence after it.
      // Resume note sits between CONTEXT PACK and REPAIR EVIDENCE.
      const prompt = group.length > 1
        ? buildBatchPrompt(group.map(r => ({ id: r.id, spec: r.spec ?? r.sourceText ?? '', brief: briefByItem.get(r.id), repairEvidence: evidenceByItem.get(r.id) })), playbookContent)
        : buildPrompt(rec.spec ?? rec.sourceText ?? '', rec.repairContext, resolveAttachmentPaths(rec.sourceText), briefByItem.get(rec.id), evidenceByItem.get(rec.id), resumeNoteByItem.get(rec.id), playbookContent);

      // Run-controls hard-stop cancel poll: re-reads the ledger tail and fires when ANY member
      // of the co-located group has an
      // unconsumed cancel-requested for ITS OWN attempt (matched per-item, not just the
      // carrier's). The console renders a Stop button on every building item, including
      // co-located siblings (recs[1..]) — a poll keyed only on the carrier would silently
      // ignore a sibling's Stop press (no kill, no event, no feedback: a truthfulness
      // violation for a control surface). Per-item matching is required, not just
      // whole-group-shares-the-carrier's-attempt: dispatchEventsFor computes
      // `attempt: (r.attempts ?? 0) + 1` PER ITEM `r` (see the build.dispatched fan-out
      // above), so a freshly-batched sibling on its 1st attempt can share a worktree with a
      // carrier on its 3rd — attempts are NOT uniform across a group. The terminal path below
      // re-derives the exact same per-item requestedIds set so attribution (who parks hold vs.
      // who requeues as a sibling) is computed once, consistently, from the same predicate.
      //
      // Cancel-vs-finish race (contract non-negotiable, adopted rule): the poll can only fire
      // while the child process is alive — once provider.run() resolves (the child already
      // exited, successfully or not), there is nothing left to kill. A cancel-requested that
      // lands after resolution is simply never observed by THIS poll; dispatch falls through to
      // the ordinary commit/gate/merge path below as if no cancel had been requested — the
      // simpler deterministic rule the contract asks for ("item proceeds"). The event is not
      // lost: hasUnconsumedCancelRequest keeps it "pending" until a later event resolves it, so
      // if the build instead crashes/times out for an unrelated reason the requeue is still
      // caught by the pre-dispatch check on the NEXT beat (unless the item merged in between, at
      // which point the fold's merged-terminal guard drops it as a no-op).
      const groupAttempts = new Map(group.map(r => [r.id, (r.attempts ?? 0) + 1] as const));
      const cancelCheck = opts.dryRun ? undefined : async () => {
        const tailEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
        return group.some(r => hasUnconsumedCancelRequest(tailEvents, r.id, groupAttempts.get(r.id)!));
      };

      // ADR-008 §2: the worker spawns ATTACHED (`detached: false`) unless this build is
      // detach-eligible (computed above: flag on, Claude-CLI provider — phase B: any group size,
      // a co-located batch detaches as one worker too). An attached child dies with the beat;
      // the doctor's dead-pid path requeues it
      // honestly. A detached child survives THIS beat returning (not a parent-process death —
      // that supervisor gap is explicitly out of phase A, see the ADR) — onSpawn fires
      // synchronously (before groupProvider.run() returns its Promise, per claudeCli.ts) so
      // spawnedPgid is already set the line after the call below.
      let spawnedPgid: number | undefined;

      // Spawn provider (non-blocking — runs in parallel). TRUST-HARDENING (defect c): use the
      // group-scoped provider resolved from the group's most-restrictive member sensitivity.
      const promise = groupProvider.run({
        prompt,
        model,
        ...(effort ? { effort } : {}),
        cwd: wtPath,
        tools: builderTools,
        timeoutMs: cfg.buildTimeoutMinutes * 60 * 1000,
        detached: detachEligible,
        onSpawn: pgid => { spawnedPgid = pgid; },
        exitFile: { runDir: artifactDir, itemId: rec.id, attempt: attemptNum },
        ...(cancelCheck ? { cancelCheck, cancelCheckIntervalMs: opts.cancelPollIntervalMs ?? 20_000 } : {}),
      }).then(r => ({ text: r.ok ? r.text : '', ok: r.ok, error: r.ok ? undefined : r.error, code: r.ok ? undefined : r.code, usage: r.ok ? r.usage : undefined }));

      if (!detachEligible) {
        // Sync path (unchanged): build.dispatched was already appended above, before the
        // scout stage — not here — so counts.building reflects the worker for the whole time
        // it's alive.
        workers.push({ recs: group, branch, wtPath, attempt: attemptNum, providerPromise: promise, spawned: true, errFile, provider: groupProvider });
        continue;
      }

      // ADR-008 §2 detached branch: onSpawn already fired synchronously above (claudeCli.ts
      // invokes it before returning the Promise), so spawnedPgid is set here. Append the
      // DEFERRED build.dispatched now, carrying pgid instead of pid — this is the only shape
      // difference from the sync event. dispatchEventsFor fans out over the WHOLE group, so on a
      // phase-B multi-item (co-located) group EVERY member's build.dispatched carries the SAME
      // group pgid/branch/worktree; only the carrier (group[0]) writes an exit file, and
      // collectDetachedBuilds reconstructs the whole group from that one carrier exit file (so a
      // companion is never stranded in 'building'). Deliberately do NOT push a handle into
      // `workers` (the array the Phase-2 loop below iterates) — the lower-risk of the two options
      // ADR-008 calls out for skipping this beat's await: no `w.detached`/continue branch needed
      // inside that already-dense loop. The beat returns without awaiting completion; a later
      // beat's collection pass (collectDetachedBuilds, ADR-008 §3) drains it via that exit file.
      allNewEvents.push(...dispatchEventsFor({ pgid: spawnedPgid, provider: groupProvider.name }));
      await appendEvents(opts.ledgerDir, allNewEvents);
      allNewEvents.length = 0;
      results.push({
        item: rec.id, dispatched: true, branch, worktree: wtPath, gateOutcome: 'dispatched',
        eventsWritten: group.length, detail: `dispatched detached (pgid ${spawnedPgid ?? 'unknown'}) — not awaited this beat`,
      });
    }

    // Flush dispatch events before waiting for providers
    if (!opts.dryRun && allNewEvents.length > 0) {
      await appendEvents(opts.ledgerDir, allNewEvents);
      allNewEvents.length = 0;
    }

    if (opts.dryRun) {
      return {
        dryRun: true,
        dispatched: results,
        totalEventsWritten: allNewEvents.length,
        detail: `dry-run: ${groups.length} worktree(s) would be dispatched`,
      };
    }

    // ── Phase 2: Wait for workers + serial gate+merge ─────────────────────

    for (const w of workers) {
      // Long-beat heartbeat: each worker wait + serial gate+merge can take up to a full
      // buildTimeout — refresh the liveness stamp between queue items so a beat draining
      // many items never reads as stale/dead to the SLO probe or the heal watchdog
      // (which once kickstarted — killed — a live multi-item beat on lastrun age alone).
      writeBeatHeartbeat(resolvedRunDir, 'dispatch');
      if (!w.spawned || !w.providerPromise) continue;
      const recs = w.recs;
      const rec = recs[0];   // carrier — names the worktree/branch/merge
      // Emit the same terminal outcome for every co-located item in the group.
      const forItems = (make: (id: string) => ReturnType<typeof makeEvent>[]) =>
        recs.flatMap(r => make(r.id));

      const providerResult = await w.providerPromise;

      // Prefer the exit-file payload — the SAME on-disk artifact a future cross-beat
      // collector would read, decoded via the SAME parseOutput/extractUsage claudeCli.ts
      // exports (one-parser invariant) — over the in-memory provider result, when both exist.
      // Fail-open: no exit file (test fakes, non-detached providers) or an unreadable/malformed
      // usage json → fall back to the provider's own resolved result, unchanged.
      let workerText = providerResult.ok ? providerResult.text : (providerResult.error ?? '');
      let workerUsage = providerResult.ok ? providerResult.usage : undefined;
      const exitRecord = readExitFile(artifactDir, rec.id, w.attempt);
      if (exitRecord?.usageJsonPath) {
        try {
          const { obj } = parseOutput(readFileSync(exitRecord.usageJsonPath, 'utf8'));
          if (obj) {
            if (typeof obj.result === 'string') workerText = obj.result;
            workerUsage = extractUsage(obj) ?? workerUsage;
          }
        } catch { /* best-effort — exit-file read never blocks the terminal path */ }
      }

      // Emit cost.usage for this build. Covers all terminal paths — success,
      // crash, auth, no-commit — whenever the provider returned any usage figures.
      // `wi` carries the work-item id(s) so future trajectory evals can attribute spend.
      // Pass through turns + durationMs when the provider returned them.
      if (providerResult.ok && workerUsage) {
        const costEvent = makeEvent('dispatch', recs[0].id, 'cost.usage', {
          provider: provider?.name ?? 'unknown',
          loop: 'dispatch',
          tokens: (workerUsage.in ?? 0) + (workerUsage.out ?? 0),
          usd: workerUsage.usd,
          wi: recs.map(r => r.id).join(','),
          ...(workerUsage.turns !== undefined ? { turns: workerUsage.turns } : {}),
          ...(workerUsage.durationMs !== undefined ? { durationMs: workerUsage.durationMs } : {}),
        });
        await appendEvents(opts.ledgerDir, [costEvent]);
      }

      // Evidence on EVERY terminal path: persist the worker's final output tail
      // to .ai/runs/loopkit/<WI>-attempt-<N>.log the moment it exits, before any branch.
      // No-commit / dirty-tree parks used to leave zero evidence; park reasons below cite
      // this path so the operator can read what the worker actually did.
      const logPath = persistWorkerLog(runDir, rec.id, w.attempt, workerText);

      // Write stderr tail from provider error (always, including auth/crash cases below)
      if (!providerResult.ok && providerResult.error) {
        try {
          writeFileSync(w.errFile, providerResult.error, 'utf8');
        } catch { /* ignore */ }
      }

      // Auth failure mid-build (session expired after the pre-flight probe passed).
      // Reset item to 'queued' via build.crashed — never park as no-commit, never count
      // toward the circuit breaker.
      if (!providerResult.ok && providerResult.code === 'auth') {
        const reason = `infra: builder not logged in — run /login (log: ${logPath})`;
        // Set the same alert flag the pre-flight probe uses: a session that
        // expires MID-build must raise the logged-out signal too, else the console/beat
        // health never learns the builder is down until the next empty-queue pre-flight.
        const flagPath = join(runDir, 'dispatch-auth-failed');
        // Mark provider unhealthy so the next beat's resolveWithHealth skips it.
        if (registry && provider) registry.markUnhealthy(provider.name, 'auth failure mid-build');
        if (!existsSync(flagPath)) {
          try { writeFileSync(flagPath, String(Math.floor(Date.now() / 1000)), 'utf8'); } catch { /* ignore */ }
          process.stderr.write('[dispatch] infra: builder logged out mid-build — run /login to restore the beat\n');
        }
        // Salvage capture: capture uncommitted work before removing worktree.
        // Best-effort: any failure → one stderr line, never affects the requeue flow.
        const salvageEnabled = opts.salvageEnabled !== undefined ? opts.salvageEnabled : (cfg.salvage?.enabled !== false);
        const salvageCfg = cfg.salvage ?? {};
        if (salvageEnabled && existsSync(w.wtPath)) {
          const salvageFn = opts.salvageCapture ?? captureSalvage;
          const sr = salvageFn(w.wtPath, rec.id, w.attempt, artifactDir, 'crash', salvageCfg, logPath);
          if (sr.trailMessage) {
            const trailEvent = makeEvent('dispatch', rec.id, 'msg.out', { text: sr.trailMessage });
            await appendEvents(opts.ledgerDir, [trailEvent]);
          }
        }
        const gateEvents = forItems(id => [makeEvent('dispatch', id, 'build.crashed', { reason })]);
        await appendEvents(opts.ledgerDir, gateEvents);
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
        });
        removeWorktree(opts.repoRoot, w.wtPath);
        spawnSync('git', ['branch', '-D', w.branch], { cwd: opts.repoRoot, stdio: 'pipe' });
        continue;
      }

      // Run-controls hard-stop terminal path:
      // the provider's cancel poll fired the SAME SIGTERM→SIGKILL escalation it uses for its own
      // timeout, and reported it back as code:'cancelled'. Attribution matters: whoever was
      // ACTUALLY requested (any group member, not just the carrier — see the cancelCheck comment
      // above) → build.cancelled {attempt} (fold parks it `hold`, deliberate — no auto-requeue).
      // Every other group member, requested or not, was killed as collateral damage of sharing
      // one process/worktree → the EXISTING build.crashed path with reason 'cancelled-sibling' so
      // it requeues through the same machinery every other crash uses (never parked hold unless
      // IT was requested). Re-reads the ledger tail once here (recomputing the same per-item
      // predicate the poll used) rather than trusting a closure value, since more cancel-requested
      // events may have landed between the poll's last tick and this terminal branch running.
      if (!providerResult.ok && providerResult.code === 'cancelled') {
        const reason = `stopped by operator mid-build (log: ${logPath})`;
        const tailEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
        const requestedIds = new Set(
          recs
            .map(r => ({ id: r.id, attempt: (r.attempts ?? 0) + 1 }))
            .filter(({ id, attempt }) => hasUnconsumedCancelRequest(tailEvents, id, attempt))
            .map(({ id }) => id),
        );
        // Fail-safe: a cancelled result with NO requester found (e.g. the requesting event was
        // consumed/raced away between the poll and here) still must not silently vanish — fall
        // back to the carrier so the operator always sees a hold-parked item to review, never a
        // build that was killed with zero ledger trail.
        if (requestedIds.size === 0) requestedIds.add(rec.id);

        // Salvage capture EXACTLY ONCE (contract non-negotiable): one captureSalvage call for
        // the shared worktree, before any branch-specific event is appended, mirroring the
        // auth-failure path above (which also captures once per worktree, not once per item).
        const salvageEnabled = opts.salvageEnabled !== undefined ? opts.salvageEnabled : (cfg.salvage?.enabled !== false);
        const salvageCfg = cfg.salvage ?? {};
        if (salvageEnabled && existsSync(w.wtPath)) {
          const salvageFn = opts.salvageCapture ?? captureSalvage;
          const sr = salvageFn(w.wtPath, rec.id, w.attempt, artifactDir, 'crash', salvageCfg, logPath);
          if (sr.trailMessage) {
            const trailEvent = makeEvent('dispatch', rec.id, 'msg.out', { text: sr.trailMessage });
            await appendEvents(opts.ledgerDir, [trailEvent]);
          }
        }
        const cancelEvents: ReturnType<typeof makeEvent>[] = recs.flatMap((r): ReturnType<typeof makeEvent>[] => {
          const attempt = (r.attempts ?? 0) + 1;
          return requestedIds.has(r.id)
            ? [makeEvent('dispatch', r.id, 'build.cancelled', { attempt, by: 'operator' })]
            : [makeEvent('dispatch', r.id, 'build.crashed', { reason: 'cancelled-sibling' })];
        });
        await appendEvents(opts.ledgerDir, cancelEvents);
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'failed', eventsWritten: cancelEvents.length, detail: reason,
        });
        removeWorktree(opts.repoRoot, w.wtPath);
        // The target's branch is discarded (a deliberate stop, not an operator-reviewable spine
        // park) — mirrors the crash/no-commit cleanup paths, unlike the attempt-unique spine-park
        // branch elsewhere in this file that is deliberately kept.
        spawnSync('git', ['branch', '-D', w.branch], { cwd: opts.repoRoot, stdio: 'pipe' });
        continue;
      }

      // Check if agent made a commit
      const headBefore = spawnSync('git', ['rev-parse', 'master'], {
        cwd: opts.repoRoot, stdio: 'pipe',
      }).stdout.toString().trim();
      const headBranch = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: w.wtPath, stdio: 'pipe',
      }).stdout.toString().trim();
      const branchBase = spawnSync('git', ['merge-base', 'master', 'HEAD'], {
        cwd: w.wtPath, stdio: 'pipe',
      }).stdout.toString().trim();

      let gateEvents: ReturnType<typeof makeEvent>[] = [];

      // ── Deterministic manifest-scoped commit fallback ──────────────────────
      // A worker's tool allowlist only prefix-matches PLAIN single commands, so any compound
      // command shape (`a && b`, `cd wt && git …`, `git -C wt …`, heredoc/-$() commit messages)
      // gets silently denied — the denial leaves a FINISHED, gate-ready tree uncommitted and the
      // item parks. This wall ends that class: if the worker left changes, dispatch stages ONLY
      // the files within scope — the group's declared Touches ∪ the workers' manifest
      // filesTouched — and commits them, so the normal gate + Touches-overstep checks judge the
      // result exactly as if the worker had committed. A blanket `git add -A` would sweep
      // scratch/residue into the commit and then trip the Touches-overstep park; scoped staging
      // avoids that by leaving residue uncommitted and surfacing it so the operator sees what the
      // worker actually did. Manifests + node_modules stay unstaged. Skipped when tests inject a
      // synthetic diff list. Runs whether or not the worker committed: residue left dirty AFTER a
      // commit (e.g. an exec-bit repair step run separately) otherwise parks at
      // verifyWorktreeState below.
      // residueNote is carried into the no-commit park reason / commit-fallback msg.out note.
      let headEffective = headBranch;
      let fallbackResidue: string[] = [];
      if (!opts.touchesDiffFiles && existsSync(w.wtPath)) {
        const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: w.wtPath, stdio: 'pipe', maxBuffer: SPAWN_MAX_BUFFER })
          .stdout.toString().split('\n')
          .filter(l => l.trim() && !/MANIFEST-WI-\d+\.json/.test(l) && !isDependencyPlumbing(l))
          .map(l => l.slice(3).trim())
          .filter(Boolean);
        if (dirty.length > 0) {
          const gt = groupTouches(recs);
          const touchPrefixes = (gt && gt !== '*') ? normalizeTouches(gt) : [];
          const manifestFiles = readManifestFilesTouched(w.wtPath, recs.map(r => r.id));
          const plan = planScopedCommit(dirty, touchPrefixes, manifestFiles);
          fallbackResidue = plan.residue;
          if (plan.inScope.length > 0) {
            const added = spawnSync('git', ['add', '--', ...plan.inScope],
              { cwd: w.wtPath, stdio: 'pipe' });
            if (added.status === 0) {
              const kind = headBranch === branchBase
                ? 'worker finished but its commit command was denied by the tool allowlist'
                : 'residue the worker left uncommitted after its own commit';
              const committed = spawnSync('git', ['commit', '-m',
                `feat(${rec.id}): worker output, committed by dispatch (${kind})`,
              ], { cwd: w.wtPath, stdio: 'pipe' });
              if (committed.status === 0) {
                headEffective = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: w.wtPath, stdio: 'pipe' })
                  .stdout.toString().trim();
                const residueNote = fallbackResidue.length > 0
                  ? ` — left ${fallbackResidue.length} out-of-scope change(s) uncommitted: ${fallbackResidue.slice(0, 8).join(', ')}`
                  : '';
                process.stderr.write(`[dispatch] ${rec.id}: ${kind} — dispatch committed ${plan.inScope.length} in-scope change(s)${residueNote}, proceeding to gate\n`);
                await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'msg.out', {
                  text: `dispatch committed the worker's in-scope output (${plan.inScope.length} change(s); ${kind})${residueNote} — gate judges it normally`,
                })]);
              }
            }
          }
        }
      }

      if (headEffective === branchBase) {
        // No commit made. Distinguish the SYSTEMIC sub-class: the worker
        // finished the code but a tool-permission denial blocked git add/commit — the final
        // message then asks for "approval". Surfacing it in the park reason makes the failure
        // class countable on the board instead of needing a human to open each attempt log.
        let denialNote = '';
        try {
          const finalText = readFileSync(logPath, 'utf8');
          if (/(explicit approval|requires approval|needs your approval|permission)/i.test(finalText)) {
            denialNote = ' — worker blocked by tool-permission denial on the commit step';
          }
        } catch { /* best-effort */ }
        const residueNote = fallbackResidue.length > 0
          ? ` — worker left ${fallbackResidue.length} out-of-scope change(s), all outside declared Touches: ${fallbackResidue.slice(0, 8).join(', ')}`
          : '';
        const reason = `no-commit: agent produced no commit${denialNote}${residueNote} (log: ${logPath})`;
        gateEvents = forItems(id => {
          // Reality check: a "no-commit" is frequently a STALE requeue of work that already
          // merged — each attempt correctly produces nothing, the gate reads it as
          // failure, and the reactor auto-requeues it forever unless this is caught. Before
          // parking, check git truth: if this WI already shipped to master (a non-ledger commit
          // tagged `(WI-NNN)`), RETIRE it instead of re-parking, breaking the loop at its source.
          // alreadyShippedCommit fails safe (null on any git error) → the normal no-commit park below.
          const shipped = alreadyShippedCommit(opts.repoRoot, id);
          if (shipped) {
            const short = shipped.slice(0, 8);
            return [
              makeEvent('dispatch', id, 'gate.passed', { tests: 'green', reason: `already shipped at ${short} — no-commit is a stale requeue; retiring instead of re-parking` }),
              makeEvent('dispatch', id, 'item.merged', { commit: short, deployed: true, attribution: 'commit-subject' }),
            ];
          }
          return [
            makeEvent('dispatch', id, 'gate.failed', { reason }),
            makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
          ];
        });
        // Salvage capture: a provider TIMEOUT lands here —
        // non-auth failures fall through to the commit check — and this is the headline
        // salvage case: a worker interrupted at minute 38 leaves uncommitted work in this
        // worktree. A finished-but-never-committed worker is equally salvageable. Best-effort.
        {
          const salvageEnabled = opts.salvageEnabled !== undefined ? opts.salvageEnabled : (cfg.salvage?.enabled !== false);
          if (salvageEnabled && existsSync(w.wtPath)) {
            const salvageFn = opts.salvageCapture ?? captureSalvage;
            const sr = salvageFn(w.wtPath, rec.id, w.attempt, artifactDir,
              !providerResult.ok && providerResult.code === 'timeout' ? 'timeout' : 'crash',
              cfg.salvage ?? {}, logPath);
            if (sr.trailMessage) {
              await appendEvents(opts.ledgerDir, [makeEvent('dispatch', rec.id, 'msg.out', { text: sr.trailMessage })]);
            }
          }
        }
        // Write stderr
        if (providerResult.error) {
          try { writeFileSync(w.errFile, providerResult.error, 'utf8'); } catch { /* ignore */ }
        }
        await appendEvents(opts.ledgerDir, gateEvents);
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
        });
        removeWorktree(opts.repoRoot, w.wtPath);
        spawnSync('git', ['branch', '-D', w.branch], { cwd: opts.repoRoot, stdio: 'pipe' });
        continue;
      }

      // Worker verification: a commit alone (HEAD != merge-base) does not prove a
      // mergeable build. Reject a dirty tree (worker left work uncommitted — lost on merge) or
      // a wrong/detached branch (worker checked something else out) as a no-commit-shaped park,
      // never a green build. Skipped when a diff-file list is injected (tests exercise the gate
      // logic directly against a synthetic worktree state).
      if (!opts.touchesDiffFiles) {
        const wtIssue = verifyWorktreeState(w.wtPath, w.branch);
        if (wtIssue) {
          const reason = `no-commit: ${wtIssue} (log: ${logPath})`;
          gateEvents = forItems(id => [
            makeEvent('dispatch', id, 'gate.failed', { reason }),
            makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
          ]);
          await appendEvents(opts.ledgerDir, gateEvents);
          results.push({
            item: rec.id, dispatched: true, branch: w.branch,
            gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
          });
          // Keep the branch for review — the worker's commit may still be salvageable.
          removeWorktree(opts.repoRoot, w.wtPath);
          continue;
        }
      }

      // ── Terminal re-check (WI-074): guard against a double-delivery ───────────
      // A stale-claim takeover can leave THIS beat holding a finished build for an item an
      // attended session ALREADY merged (its detached build was collected a beat later, ADR-008).
      // Immediately before the gate/merge/push sequence — which would append a SECOND item.merged
      // AND push a duplicate merge commit to master — re-read + re-fold the ledger UNDER THE LOCK.
      // If the carrier item is already terminal, this build is superseded: no-op the merge,
      // salvage the branch for review, release any claim still held, and record build.superseded
      // instead of shipping twice. Always runs — an in-flight build's item is normally 'building'
      // here, so this is a cheap re-fold pass-through except on the exact takeover race.
      {
        const superseded = await withLock(opts.ledgerDir, async (tx) => {
          const freshResult = fold(await tx.loadAll());
          const carrier = freshResult.items.get(rec.id);
          if (!carrier || !isItemTerminal(carrier)) return false;
          const events: LedgerEvent[] = recs.map(r => makeEvent('dispatch', r.id, 'build.superseded', {
            attempt: w.attempt,
            reason: `already ${carrier.state} by another session — dispatch build superseded, not re-merged`,
            branch: w.branch,
          }));
          // Release any claim dispatch still holds (build.dispatched normally consumes it, but a
          // lingering lease must not keep deferring the beats now the item has shipped).
          for (const r of recs) {
            if (freshResult.items.get(r.id)?.claim) {
              events.push(makeEvent('dispatch', r.id, 'item.released', { reason: 'build superseded — item already terminal' }));
            }
          }
          await tx.append(events);
          return true;
        });
        if (superseded) {
          // Salvage: keep the branch for operator review, drop only the worktree.
          removeWorktree(opts.repoRoot, w.wtPath);
          const reason = `superseded: ${rec.id} already terminal — build not re-merged, branch ${w.branch} kept`;
          process.stderr.write(`[dispatch] ${reason}\n`);
          results.push({
            item: rec.id, dispatched: true, branch: w.branch,
            gateOutcome: 'deferred', eventsWritten: recs.length, detail: reason,
          });
          continue;
        }
      }

      // ── Read worker manifests ─────────────────────────────────
      // Parse any MANIFEST-WI-*.json in the worktree root. Fail-open: absent or malformed
      // manifests log one stderr line and the build proceeds exactly as before.
      // Valid manifests are copied to the evidence directory for observability + attribution.
      const manifestByItem = new Map<string, WorkerManifest>();
      {
        for (const r of recs) {
          const mPath = join(w.wtPath, `MANIFEST-${r.id}.json`);
          if (!existsSync(mPath)) continue;
          let parsed: WorkerManifest | null = null;
          try {
            parsed = parseManifest(readFileSync(mPath, 'utf8'));
          } catch {
            // unreadable — treat as absent
          }
          if (!parsed) {
            process.stderr.write(`[dispatch] manifest: ${r.id} — malformed or missing, proceeding without it\n`);
            continue;
          }
          manifestByItem.set(r.id, parsed);
          // Copy to evidence convention path (fail-soft — never blocks the gate flow).
          const evidencePath = join(artifactDir, `${r.id}-attempt-${w.attempt}.manifest.json`);
          try {
            writeFileSync(evidencePath, JSON.stringify(parsed, null, 2), 'utf8');
          } catch (e) {
            process.stderr.write(`[dispatch] manifest: ${r.id} — could not copy to evidence: ${e}\n`);
          }
        }
      }

      // Compute changed files once — used by both the touches gate and the spine check.
      const changedFiles = opts.touchesDiffFiles ?? getChangedFiles(w.wtPath, branchBase);

      // Touches enforcement runs against the UNION of the group's declared prefixes (a
      // co-located batch legitimately spans all its members' footprints).
      const gt = groupTouches(recs);
      const ids = recs.map(r => r.id).join('+');
      if (!gt || gt === '*') {
        process.stderr.write(`[dispatch] warning: ${ids} has no Touches declared — treats as wildcard (conflicts with everything)\n`);
      } else {
        // Union of every prior approved-overstep for any item in this group — a
        // co-located batch's members each carry their own approval history.
        const approvedTouches = recs.flatMap(r => loadApprovedTouches(allEvents, r.id));
        const overstep = checkTouchesOverstep(changedFiles, gt, approvedTouches);
        if (overstep && overstep.length > 0) {
          const reason = `needs-decision: files outside declared Touches (${gt}): ${overstep.join(', ')}`;
          gateEvents = forItems(id => [
            makeEvent('dispatch', id, 'gate.parked', { reason: 'touches-overstep' }),
            makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'decision' }),
          ]);
          await appendEvents(opts.ledgerDir, gateEvents);
          removeWorktree(opts.repoRoot, w.wtPath);
          results.push({
            item: rec.id, dispatched: true, branch: w.branch,
            gateOutcome: 'parked-spine', eventsWritten: gateEvents.length, detail: reason,
          });
          continue;
        }
      }

      // Spine check
      const spineCheck = checkSpine(cfg.spineRegex, changedFiles);
      if (spineCheck.touched) {
        const reason = `spine: ${spineCheck.files.join(', ')}`;
        gateEvents = forItems(id => [
          makeEvent('dispatch', id, 'gate.parked', { reason: 'spine' }),
          makeEvent('dispatch', id, 'item.parked', {
            reason: `needs-decision: touches spine (${spineCheck.files.join(', ')}) — approve to merge`,
            parkKind: 'decision',
          }),
        ]);
        await appendEvents(opts.ledgerDir, gateEvents);
        // Keep the branch for review
        removeWorktree(opts.repoRoot, w.wtPath);
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'parked-spine', eventsWritten: gateEvents.length, detail: reason,
        });
        continue;
      }

      // Run gate (use injected result if provided) — the item's delivery lane picks the
      // definition-of-done: engineering keeps `npm test`, other lanes divert.
      const gateId = resolveGateId(cfg, rec.lane);
      const gateOutcome = opts.gateResult ?? runLaneGate(gateId, cfg, w.wtPath, false, branchBase, changedFiles);
      if (!gateOutcome.passed) {
        // Persist failure artifacts for the repair loop: gate log + diff.
        // Best-effort: any write failure is logged to stderr, never blocks park/gate flow.
        persistGateLog(artifactDir, rec.id, w.attempt, gateOutcome.output ?? '');
        persistDiff(artifactDir, rec.id, w.attempt, w.wtPath, branchBase);
        const reason = `tests-red: ${gateOutcome.reason}`;
        // tests-red is a mechanical failure the plane owns. Auto-requeue
        // with repair context while the breaker still has room (attempt < breakerN); only park
        // (ops-park, off the operator's desk) once the breaker is exhausted. w.attempt is this
        // build's attempt number (= rec.attempts+1 at dispatch), so it is the token guard.
        const testsRedRepair = `Gate red (tests-red): ${gateOutcome.reason}`;
        gateEvents = forItems(id => [makeEvent('dispatch', id, 'gate.failed', { reason })]);
        if (w.attempt >= cfg.breakerN) {
          for (const r of recs) {
            gateEvents.push(makeEvent('dispatch', r.id, 'item.parked', {
              reason: `breaker: ${w.attempt} attempts exhausted — ${reason}`,
              parkKind: 'ops',
            }));
          }
        } else {
          for (const r of recs) {
            const queuedData: ItemQueuedData = { spec: r.spec ?? r.sourceText ?? '', repairContext: testsRedRepair };
            if (r.touches) queuedData.touches = r.touches;
            if (r.model) queuedData.model = r.model;
            if (r.priority) queuedData.priority = r.priority;
            gateEvents.push(makeEvent('dispatch', r.id, 'item.queued', queuedData));
          }
        }
        await appendEvents(opts.ledgerDir, gateEvents);
        removeWorktree(opts.repoRoot, w.wtPath);
        // Keep branch for review (parked) / re-dispatch (requeued) — the next beat picks it up.
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
        });
        continue;
      }

      // Post-integration re-gate: if master advanced since this branch was cut, rebase
      // the branch onto the new tip and verify the combined state passes the gate before
      // merging. Invariant: no build reaches master without a gate that covers every commit
      // that landed since the branch point (including any parallel merges this beat).
      if (headBefore !== branchBase) {
        const rebaseResult = spawnSync('git', ['rebase', headBefore], {
          cwd: w.wtPath, stdio: 'pipe',
        });
        if (rebaseResult.status !== 0) {
          spawnSync('git', ['rebase', '--abort'], { cwd: w.wtPath, stdio: 'pipe' });
          const reason = `post-integration rebase conflict after master advanced`;
          gateEvents = forItems(id => [
            makeEvent('dispatch', id, 'gate.failed', { reason }),
            makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
          ]);
          await appendEvents(opts.ledgerDir, gateEvents);
          removeWorktree(opts.repoRoot, w.wtPath);
          spawnSync('git', ['branch', '-D', w.branch], { cwd: opts.repoRoot, stdio: 'pipe' });
          results.push({
            item: rec.id, dispatched: true, branch: w.branch,
            gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
          });
          continue;
        }
        const reGateOutcome = opts.postIntegrationGateResult
          ?? runLaneGate(gateId, cfg, w.wtPath, false, headBefore, changedFiles);
        if (!reGateOutcome.passed) {
          // Persist failure artifacts for the repair loop.
          persistGateLog(artifactDir, rec.id, w.attempt, reGateOutcome.output ?? '');
          persistDiff(artifactDir, rec.id, w.attempt, w.wtPath, headBefore);
          const reason = `post-integration tests-red: ${reGateOutcome.reason}`;
          gateEvents = forItems(id => [
            makeEvent('dispatch', id, 'gate.failed', { reason }),
            makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
          ]);
          await appendEvents(opts.ledgerDir, gateEvents);
          removeWorktree(opts.repoRoot, w.wtPath);
          spawnSync('git', ['branch', '-D', w.branch], { cwd: opts.repoRoot, stdio: 'pipe' });
          results.push({
            item: rec.id, dispatched: true, branch: w.branch,
            gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
          });
          continue;
        }
      }

      // ── Judge stage ─────────────────────────────────────────
      // Advisory-only: runs AFTER gate passes, BEFORE merge. Fail-open:
      // any error/timeout/unparseable → one stderr line, merge proceeds exactly as today.
      // NEVER parks, blocks, or reorders merges.
      {
        const judgeEnabled = opts.judgeEnabled !== undefined
          ? opts.judgeEnabled
          : (cfg.judge?.enabled ?? true);

        // TRUST-HARDENING (defect c): the judge call sends the item's diff (repo material) to a
        // model, so it must use the GROUP-scoped provider (resolved from the group's most
        // restrictive member sensitivity), not the beat-global 'internal' one. Falls back to the
        // beat-global provider only when no group provider was recorded (defensive; a spawned
        // worker always has one).
        const judgeProvider = w.provider ?? provider;
        if (judgeEnabled && judgeProvider) {
          const judgeModel = cfg.judge?.model ?? 'sonnet';
          const judgeTimeoutMs = cfg.judge?.timeoutMs ?? 240_000;
          const judgeMaxDiffChars = cfg.judge?.maxDiffChars ?? 20_000;

          // For each item in the group, run one judge call (carrier diff covers all)
          for (const r of recs) {
            const judgeSpec = r.spec ?? r.sourceText ?? '';

            // Capture the final diff (after rebase if it happened) for the judge.
            // Uses the shared helper (captureWorktreeDiff from judge.ts).
            const finalBase = headBefore !== branchBase ? headBefore : branchBase;
            const diff = captureWorktreeDiff(w.wtPath, finalBase, judgeMaxDiffChars);

            const prompt = buildJudgePrompt(r.id, judgeSpec, diff, r.touches);

            let judgeRunResult;
            const injected = opts.judgeResults?.get(r.id);
            if (injected !== undefined) {
              // Injected result (tests): null = simulate disabled, object = simulate response
              if (injected === null) {
                continue;  // skip this item (judge disabled for this item in test)
              }
              // Simulate a provider response
              if (!injected.ok) {
                judgeRunResult = { parsed: null, providerError: injected.error };
              } else {
                const { parseJudgeOutput } = await import('../judge.js');
                const parsed = parseJudgeOutput(injected.text ?? '');
                judgeRunResult = { parsed, usage: injected.usage };
              }
            } else {
              judgeRunResult = await runJudge(judgeProvider, judgeModel, prompt, judgeTimeoutMs);
            }

            if (!judgeRunResult.parsed) {
              // TRUST-HARDENING (defect b): the judge attempt errored/timed out and produced NO
              // usable verdict. The old path logged and merged with zero recorded penalty — a
              // silent evidence loss. Instead record an explicit review.verdict:'unavailable' so
              // the gap is visible in the ledger; the acceptance classifier floors any item
              // carrying it at 'review' (never auto/optional). The merge STILL proceeds — the
              // judge is advisory and never blocks — but the evidence gap is never silent again.
              const reason = judgeRunResult.providerError ?? 'unknown';
              process.stderr.write(
                `[dispatch] judge: ${r.id} provider error (${reason}) — recording review.verdict:unavailable, merge proceeds\n`,
              );
              const unavailableEvent = makeEvent('dispatch', r.id, 'review.verdict', {
                verdict: 'unavailable',
                confidence: 0,
                specSatisfied: 'unknown',
                scopeCreep: 'unknown',
                testTheatre: 'unknown',
                reasons: [`judge unavailable: ${reason.slice(0, 400)}`],
                model: judgeModel,
                judge: 'merge-review',
                reason,
              } as import('../schema.js').ReviewVerdictData);
              await appendEvents(opts.ledgerDir, [unavailableEvent]);
              continue;
            }

            const { parsed, usage } = judgeRunResult;
            // Append review.verdict event (advisory — never changes state)
            const verdictEvent = makeEvent('dispatch', r.id, 'review.verdict', {
              verdict: parsed.verdict,
              confidence: parsed.confidence,
              specSatisfied: parsed.specSatisfied,
              scopeCreep: parsed.scopeCreep,
              testTheatre: parsed.testTheatre,
              reasons: parsed.reasons,
              model: judgeModel,
              judge: 'merge-review',
            } as import('../schema.js').ReviewVerdictData);
            await appendEvents(opts.ledgerDir, [verdictEvent]);

            // Append cost.usage for judge call (mirrors scout/dispatch cost metering).
            // Pass through turns + durationMs when present.
            if (usage) {
              await appendEvents(opts.ledgerDir, [
                makeEvent('dispatch', r.id, 'cost.usage', {
                  provider: judgeProvider.name,
                  loop: 'judge',
                  tokens: (usage.in ?? 0) + (usage.out ?? 0),
                  usd: usage.usd,
                  wi: r.id,
                  ...(usage.turns !== undefined ? { turns: usage.turns } : {}),
                  ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
                }),
              ]);
            }

            // Log a human-readable one-liner so the beat log shows judge output
            process.stderr.write(
              `[dispatch] judge: ${r.id} verdict=${parsed.verdict} confidence=${parsed.confidence.toFixed(2)} spec=${parsed.specSatisfied} creep=${parsed.scopeCreep} theatre=${parsed.testTheatre}\n`,
            );
          }
        }
      }

      // Gate passed — but never merge unless the shared primary tree is actually on master
      // (a parallel session can switch the checked-out branch under a beat — known incident class).
      const curBranch = (opts.branchProbe ?? ((rr: string) => {
        const r = spawnSync('git', ['branch', '--show-current'], { cwd: rr, stdio: 'pipe' });
        return r.status === 0 ? r.stdout.toString().trim() : '';
      }))(opts.repoRoot);
      if (curBranch !== 'master') {
        // Keep worktree + branch; the build stays gate-passed-unmerged and retries next beat.
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'deferred', eventsWritten: 0,
          detail: `primary tree on '${curBranch}' not master — merge deferred`,
        });
        continue;
      }
      const mergeResult = spawnSync(
        'git',
        ['merge', '--no-ff', '-m', `feat(dispatch): ${ids}`, w.branch],
        { cwd: opts.repoRoot, stdio: 'pipe' },
      );

      if (mergeResult.status !== 0) {
        // Leave NOTHING half-merged in the shared tree — an un-aborted conflict blocks every
        // later merge and strands conflict markers in tracked files.
        spawnSync('git', ['merge', '--abort'], { cwd: opts.repoRoot, stdio: 'pipe' });
        const reason = `infra: merge conflict on ${w.branch}`;
        gateEvents = forItems(id => [
          makeEvent('dispatch', id, 'gate.failed', { reason }),
          makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
        ]);
        await appendEvents(opts.ledgerDir, gateEvents);
        removeWorktree(opts.repoRoot, w.wtPath);
        results.push({
          item: rec.id, dispatched: true, branch: w.branch,
          gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
        });
        continue;
      }

      let commitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: opts.repoRoot, stdio: 'pipe',
      }).stdout.toString().trim();

      // Push — a non-zero exit (non-FF, network, auth) must not advance the ledger to
      // item.merged; leave the item in its current state so the next beat retries.
      const doPush = () => opts.pushProbe
        ? opts.pushProbe()
        : spawnSync('git', ['push'], { cwd: opts.repoRoot, stdio: 'pipe' });
      const pushResult = doPush();
      if (pushResult.status !== 0) {
        const why = pushResult.stderr?.toString().trim() ?? 'unknown';
        const isNonFf = why.includes('rejected') || why.includes('non-fast-forward');
        let finalReason = `push to origin failed: ${why}`;
        let recovered = false;

        if (isNonFf) {
          // Master advanced AGAIN between our merge and the push (a second, later race than
          // the post-integration rebase above). Fetch the new tip, reset the primary tree onto
          // it, re-merge the approved branch, and re-run the gate before retrying — mirrors
          // reactor.ts's non-FF recovery (same invariant: no build reaches master without a
          // gate that covers all commits since the branch point).
          spawnSync('git', ['fetch', 'origin', 'master'], { cwd: opts.repoRoot, stdio: 'pipe' });
          const freshBase = spawnSync('git', ['rev-parse', 'origin/master'], { cwd: opts.repoRoot, stdio: 'pipe' })
            .stdout.toString().trim();
          spawnSync('git', ['reset', '--hard', 'origin/master'], { cwd: opts.repoRoot, stdio: 'pipe' });
          const remerge = spawnSync(
            'git', ['merge', '--no-ff', '-m', `feat(dispatch): ${ids}`, w.branch],
            { cwd: opts.repoRoot, stdio: 'pipe' },
          );
          if (remerge.status !== 0) {
            spawnSync('git', ['merge', '--abort'], { cwd: opts.repoRoot, stdio: 'pipe' });
            const reason = `infra: post-push-race merge conflict on ${w.branch}`;
            gateEvents = forItems(id => [
              makeEvent('dispatch', id, 'gate.failed', { reason }),
              makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
            ]);
            await appendEvents(opts.ledgerDir, gateEvents);
            removeWorktree(opts.repoRoot, w.wtPath);
            results.push({
              item: rec.id, dispatched: true, branch: w.branch,
              gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
            });
            continue;
          }
          // Re-gate against the FRESHLY-fetched origin/master, not the stale pre-race
          // branchBase — otherwise .ai/gate.sh scopes its suites off the wrong diff base and
          // mis-scopes what it runs. Recompute the changed-files list against the same fresh base.
          const freshChangedFiles = freshBase
            ? getChangedFiles(opts.repoRoot, freshBase)
            : changedFiles;
          const reGateOutcome = opts.nonFfGateResult
            ?? runLaneGate(gateId, cfg, opts.repoRoot, false, freshBase || branchBase, freshChangedFiles);
          if (!reGateOutcome.passed) {
            const reason = `post-push-race tests-red: ${reGateOutcome.reason}`;
            gateEvents = forItems(id => [
              makeEvent('dispatch', id, 'gate.failed', { reason }),
              makeEvent('dispatch', id, 'item.parked', { reason, parkKind: 'ops' }),
            ]);
            await appendEvents(opts.ledgerDir, gateEvents);
            removeWorktree(opts.repoRoot, w.wtPath);
            results.push({
              item: rec.id, dispatched: true, branch: w.branch,
              gateOutcome: 'failed', eventsWritten: gateEvents.length, detail: reason,
            });
            continue;
          }
          commitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: opts.repoRoot, stdio: 'pipe',
          }).stdout.toString().trim();
          const retryPush = doPush();
          if (retryPush.status === 0) {
            recovered = true;
          } else {
            const retryWhy = retryPush.stderr?.toString().trim() ?? 'unknown';
            finalReason = `push to origin failed after post-push-race re-merge: ${retryWhy}`;
          }
        }

        if (!recovered) {
          // A dispatch-lane item sits in 'gated' once its gate passes — unlike the reactor
          // lane, dispatch only ever re-picks 'queued' items, so a bare merge.transient-fail
          // would leave it stuck forever. Pair it with an explicit item.queued so it re-enters
          // the pickable pool next beat (fold.ts's item record carries the transientCount for
          // observability either way).
          const pushFailEvents = forItems(id => [
            makeEvent('dispatch', id, 'merge.transient-fail', {
              reason: finalReason,
              transientCount: (rec.transientFailCount ?? 0) + 1,
            }),
          ]);
          for (const r of recs) {
            const queuedData: ItemQueuedData = {
              spec: r.spec ?? r.sourceText ?? '',
              repairContext: `Transient push failure: ${finalReason}`,
            };
            if (r.touches) queuedData.touches = r.touches;
            if (r.model) queuedData.model = r.model;
            if (r.priority) queuedData.priority = r.priority;
            pushFailEvents.push(makeEvent('dispatch', r.id, 'item.queued', queuedData));
          }
          await appendEvents(opts.ledgerDir, pushFailEvents);
          removeWorktree(opts.repoRoot, w.wtPath);
          results.push({
            item: rec.id, dispatched: true, branch: w.branch,
            gateOutcome: 'failed', eventsWritten: pushFailEvents.length, detail: finalReason,
          });
          continue;
        }
      }

      // TRUST-HARDENING: actual-diff evidence for the acceptance tier. `changedFiles` is the diff
      // the branch introduced over `evidenceBase` (the base it was computed against — headBefore
      // after a post-integration rebase, else branchBase); `commitSha` is the merge commit.
      const evidenceBase = headBefore !== branchBase ? headBefore : branchBase;
      // The exact command that proved this build: the engineering gate command, or the lane's
      // gate id when a non-code lane diverted (e.g. 'claim-audit').
      const evidenceGateCommand = gateId === 'claim-audit' ? 'claim-audit' : cfg.gateCommand;
      const evidence = mergeEvidence(evidenceBase, commitSha, changedFiles, evidenceGateCommand);
      if (recs.length === 1) {
        gateEvents.push(makeEvent('dispatch', rec.id, 'gate.passed', { tests: 'green', reason: gateOutcome.reason }));
        anyMerged = true;
        mergedWiIds.push(rec.id);
        // Record attribution:'manifest' on single-item merges when a manifest exists.
        const singleManifest = manifestByItem.get(rec.id);
        gateEvents.push(makeEvent('dispatch', rec.id, 'item.merged', {
          commit: commitSha,
          deployed: false,
          ...(singleManifest ? { attribution: 'manifest' as const } : {}),
          ...(singleManifest?.certification ? { certification: singleManifest.certification } : {}),
          ...evidence,
        }));
      } else {
        // Per-item attribution:
        // PRIMARY: manifest.filesTouched intersects the actual merged diff — typed, reliable.
        // FALLBACK: Touches-prefix match OR commit-subject match when no manifest is present.
        // A commit-subject match gives the per-commit sha (best provenance); Touches-only
        // falls back to the merge commit sha. attribution field records which path was used.
        const subjectSha = new Map<string, string>();
        const logOut = spawnSync('git', ['log', '--format=%h%x09%s', `${branchBase}..HEAD`], {
          cwd: w.wtPath, stdio: 'pipe', maxBuffer: SPAWN_MAX_BUFFER,
        }).stdout.toString();
        for (const line of logOut.split('\n').filter(Boolean)) {
          const tab = line.indexOf('\t');
          const sha = line.slice(0, tab);
          const subj = line.slice(tab + 1);
          for (const r of recs) {
            if (!subjectSha.has(r.id) && subj.includes(r.id)) subjectSha.set(r.id, sha);
          }
        }
        for (const r of recs) {
          // --- Manifest-first attribution ---
          const manifest = manifestByItem.get(r.id);
          if (manifest && manifest.filesTouched.length > 0) {
            // An item is credited when its manifest's filesTouched intersects the actual merged diff.
            const manifestHit = manifest.filesTouched.some(f => changedFiles.includes(f));
            if (manifestHit) {
              const sha = subjectSha.get(r.id) ?? commitSha;
              gateEvents.push(makeEvent('dispatch', r.id, 'gate.passed', { tests: 'green', reason: gateOutcome.reason }));
              anyMerged = true;
              mergedWiIds.push(r.id);
              gateEvents.push(makeEvent('dispatch', r.id, 'item.merged', {
                commit: sha, deployed: false, attribution: 'manifest',
                ...(manifest.certification ? { certification: manifest.certification } : {}),
                ...evidence,
              }));
              continue;
            }
          }
          // --- Fallback: Touches-prefix match or commit-subject match ---
          const touchesPrefixes = r.touches ? normalizeTouches(r.touches) : [];
          const landedInTouches = touchesPrefixes.length > 0 &&
            changedFiles.some(f => isWithinTouches(f, touchesPrefixes));
          const sha = subjectSha.get(r.id) ?? (landedInTouches ? commitSha : undefined);
          if (sha) {
            gateEvents.push(makeEvent('dispatch', r.id, 'gate.passed', { tests: 'green', reason: gateOutcome.reason }));
            anyMerged = true;
            mergedWiIds.push(r.id);
            gateEvents.push(makeEvent('dispatch', r.id, 'item.merged', {
              commit: sha, deployed: false, attribution: 'commit-subject',
              ...(manifest?.certification ? { certification: manifest.certification } : {}),
              ...evidence,
            }));
          } else {
            // The batch MERGED to master, but no changed file is attributable to this
            // item within its Touches — its work was likely folded into a file another item
            // committed. This is NOT a no-commit failure (the batch shipped); parking it
            // `no-commit` wrongly counted toward the no-commit-park breaker and mis-signalled.
            // Park as ops with a distinct parkClass:'batch-attribution' (via the gate.parked
            // class token) and a reason that never matches the /no-commit/ breaker predicate.
            const reason = 'batched: no files attributable within Touches — batch merged, work may be shared; verify';
            gateEvents.push(makeEvent('dispatch', r.id, 'gate.parked', { reason: 'batch-attribution' }));
            gateEvents.push(makeEvent('dispatch', r.id, 'item.parked', { reason, parkKind: 'ops' }));
          }
        }
      }

      await appendEvents(opts.ledgerDir, gateEvents);

      // Cleanup
      removeWorktree(opts.repoRoot, w.wtPath);
      spawnSync('git', ['branch', '-D', w.branch], { cwd: opts.repoRoot, stdio: 'pipe' });

      results.push({
        item: rec.id, dispatched: true, branch: w.branch,
        gateOutcome: 'passed', eventsWritten: gateEvents.length,
        detail: recs.length > 1 ? `batch ${ids} merged at ${commitSha}` : `merged at ${commitSha}`,
      });
    }

    // master advanced → deploy detached (self-locking script; bursts coalesce).
    if (anyMerged && !opts.dryRun) fireDeployOnMerge(opts.repoRoot, cfg.deployCommand, mergedWiIds);

    const totalEventsWritten = results.reduce((s, r) => s + r.eventsWritten, 0);
    return { dryRun: false, dispatched: results, totalEventsWritten, ...(lockNote ? { detail: lockNote } : {}) };
  } finally {
    // Commit ledger residue every beat (not just on a clean exit —
    // `finally` also covers the regression-guard halt and any thrown error) so the uncommitted
    // window is bounded to one beat cycle instead of hours. No-ops when the ledger is clean.
    if (!opts.dryRun) {
      const commitFn = opts.commitResidue ?? commitLedgerResidue;
      const commitResult = commitFn(opts.repoRoot, opts.ledgerDir, 'dispatch');
      if (commitResult.committed) {
        process.stderr.write(`[dispatch] ${commitResult.detail}\n`);
      }
    }
    releaseDispatchLock(lockPath);
  }
}
