/**
 * beats/reactor.ts — The reactor beat (every 30s).
 *
 * Steps (all guarded — one failure never silently skips the rest):
 *   (a) importer sync: legacy markdown seams → ledger (tombstone — a no-op once no seams remain)
 *   (b) route NEW captured items via the conductor prompt + provider
 *         routing writes item.routed + msg.out events (the reply is durable in the
 *         ledger; the console renders it from the fold — no seam mirror)
 *   (c) apply operator verbs: approved items → run gate → merge if green
 *   (d) doctor sweep: orphans → build.crashed + requeue / breaker
 *   (e) SLO evaluate (edge-triggered breach + recover) + loop.beat summary
 *   (f) HEAL step: runbook lookup → propose|execute per OPS_AUTONOMY
 *
 * Guard: LOOPKIT_AUTONOMY=off → exit 0 immediately.
 * Lock: reactor.lock (mkdir-based, single process).
 * --dry-run flag: print planned actions, write nothing.
 *
 * Operational lessons encoded here:
 *   - The reactor NEVER takes the dispatch lock (approvals must not wait behind builds).
 *   - Conductor prompt is the routing prompt-of-record (.ai/loops/prompts/conductor.md).
 *   - False-green guard: if new items remain unrouted and nothing was written, exit nonzero.
 *   - Legacy markdown seams, if any ever existed, are retired; the ledger is the sole store.
 */

import { join, resolve, dirname } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadAllEventsWithQuarantine, appendEvents, withLock, diffMissingEvents } from '../ledger.js';
import { fold, FoldResult, ItemRecord, computeAcceptanceDebt, projectEngagement, UnansweredReply, isDecisionPark, isFirstSeenPark, shouldRequeueOpsPark } from '../fold.js';
import { runDoctor, defaultPidProbe, DoctorConfig, ProgressProbe, ExitFileProbe, WorktreeProbe, reapStaleClaims } from '../doctor.js';
import { enrichCrashOrStallEvent } from '../doctor-enrich.js';
import { exitFilePresent } from '../exitfile.js';
import { makeEvent, LedgerEvent, ItemQueuedData, ItemRejectedData, ItemCapturedData, resolveAttachmentPaths, DEFAULT_LANE, isPortabilityRequired, parsePortabilityTargets } from '../schema.js';
import { loadConfig, LoopkitConfig } from '../config.js';
import { makeRegistry, makeFileHealthFns, normalizeSensitivity } from '../providers/registry.js';
import { LlmProvider } from '../providers/types.js';
import {
  evaluateSloBoard, deriveSloState, makeRealProbes, makeDeployProbe, makeInstanceProbe,
  makePlaneCheckProbe, dispatchWedgeSecFor, SloRow, SloProbes, SloConfig,
} from '../slo.js';
import { getRunbook, RunbookContext, resolveHealMode } from '../runbooks.js';
import { setupWorktreeDeps , fireDeployOnMerge } from './worktree-deps.js';
import { beatLockOwnerAlive, writeBeatHeartbeat, BeatLockAcquisition, getChangedFiles, mergeEvidence, resolveProviderForSensitivity, itemSensitivity } from './dispatch.js';
import { classifyParkForAutoApprove, parseOverstepReason, parseDependencyReason } from '../approval.js';
import { classifyAcceptanceTier, splitTouches, acceptanceClassifyFiles, hasEvidenceGap } from '../acceptance.js';
import { readTargetManifest, resolveRegisteredTarget, lookupRegisteredTarget } from '../target.js';
import { normalizeTouches } from '../touches.js';
import { decideTierWindow, effectiveTierWindows, tallyVerdictsSince, TierCalibrationConfig } from '../calibration.js';
import { spendForDay } from '../costs.js';
import { readLastbeat, writeLastbeat, countsChanged } from '../hygiene.js';
import { captureSalvage } from '../salvage.js';
import { evaluateArmed, makeArmedProbe, ArmedProbe } from '../armed.js';
import { commitLedgerResidue, LedgerCommitResult } from '../ledgerCommit.js';
import { checkLedgerRegressionGuard } from '../regressionGuard.js';
import { LedgerMaxIds } from '../doctor.js';
import { captureWorktreeDiff } from '../judge.js';
import { buildPathologyPrompt, parsePathologyOutput, runPathology, formatEventTrail, TrailEvent } from '../pathology.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactorOptions {
  repoRoot: string;
  ledgerDir: string;
  /**
   * Resolved run-state root for THIS plane (watermarks, locks, notified stamps,
   * provider-fail counters, lastbeat/lastrun state). In plane-home mode the caller passes
   * the run dir that lives BESIDE the ledger (e.g. $LOOPKIT_HOME/runs/loopkit); when
   * absent, defaults to the embedded location under repoRoot
   * (<repoRoot>/.ai/runs/loopkit) for back-compat. Subdirectory shapes are identical
   * either way — only the root moves.
   */
  runDir?: string;
  dryRun?: boolean;
  /** Override autonomy check (for tests) */
  autonomy?: 'on' | 'off';
  /** Injected provider (for tests; overrides registry) */
  provider?: LlmProvider | null;
  /** Injected pid probe (for tests). `isGroup` marks a detached build's pgid, probed as a group. */
  pidProbe?: (pid: number, isGroup?: boolean) => boolean;
  /**
   * Injected kill function (for tests) — used by the stall-reap salvage step to signal a
   * stalled build's live worker before its worktree is read/removed. Called with the SAME id
   * the doctor probed as alive (a negative pgid for a detached build's process GROUP, a plain
   * pid for a legacy synchronous build) — see the pid/pgid selection note at the call site.
   * Defaults to `process.kill`.
   */
  killFn?: (id: number, signal: NodeJS.Signals) => void;
  /** Injected progress probe (for tests) — used for stall detection. */
  progressProbe?: (rec: ItemRecord) => number | null;
  /** Injected exit-file probe (for tests) — distinguishes a collected build from an orphaned one. */
  exitFileProbe?: ExitFileProbe;
  /**
   * Injected worktree-existence probe (for tests) — powers the post-collection-limbo reaper.
   * When absent, the real probe (existsSync on the build's recorded worktree path) is used.
   */
  worktreeProbe?: WorktreeProbe;
  /** Injected wall-clock (epoch ms) for the doctor's stall-age math (for tests). */
  now?: number;
  /** Injected current-branch probe (for tests). Defaults to `git branch --show-current`. */
  branchProbe?: (repoRoot: string) => string;
  /** Config override (for tests) */
  config?: LoopkitConfig;
  /**
   * Override OPS_AUTONOMY for the heal step (for tests).
   * Real value comes from process.env.OPS_AUTONOMY (default: propose).
   */
  opsAutonomy?: 'watch' | 'propose' | 'heal';
  /**
   * Injected SLO probes (for tests). When absent, real probes are used.
   */
  sloProbes?: SloProbes;
  /**
   * Injected spawn for runbook execution (for tests).
   * Signature: (cmd, args) => { ok, output }
   */
  runbookSpawn?: (cmd: string, args: string[]) => { ok: boolean; output: string };
  /**
   * Injected notify hook for nudge/escalate runbooks (for tests).
   * Called with the message string. May return a boolean delivery status —
   * return `false` to simulate a total-transport failure (stepNotifyDecisionParks then retries
   * and does NOT stamp). Returning void is treated as delivered (stepHeal + legacy tests unaffected).
   */
  notify?: (message: string) => void | boolean;
  /**
   * Injected gate runner for tests. Overrides runGateOnce in stepApplyVerbs so tests
   * can simulate timeout (timedOut: true) without actually running a command.
   * Called each time the gate runs (initial gate + post-rebase re-gate), so a stateful
   * closure can return different results on first vs. second call.
   */
  gateRunner?: (
    gateCommand: string,
    gateWorkdir: string,
    wtPath: string,
    dryRun: boolean,
    timeoutMs: number,
  ) => { passed: boolean; timedOut: boolean; reason: string; output?: string };
  /**
   * Injected push probe for tests. When provided, called in place of the real
   * `git push origin HEAD:master`. Called each time a push is attempted, so a
   * stateful closure can return different results on first vs. second call (enabling
   * the non-FF rebase-retry path to be tested without a real remote).
   */
  pushProbe?: () => { status: number | null; stderr?: Buffer | null };
  /**
   * Injected SLO board for the provisional-accept smoke check.
   * When provided, skips calling evaluateSloBoard inside stepProvisionalAccept.
   * Useful in tests to control exactly which rows are breached/met.
   */
  provisionalSloBoard?: import('../slo.js').SloRow[];

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
   * Injected provider health probe for the SLO board.
   * When absent, the real registry is queried.
   */
  providerHealthProbe?: import('../slo.js').SloProbes['providerHealth'];

  /**
   * Injected armed-predicate probe. When absent, a real shell probe is used.
   * Tests inject a fake so no shell runs.
   */
  armedProbe?: ArmedProbe;

  /**
   * Injected plane-check probe for the queue-stall / no-commit-park SLO rows.
   * When absent AND no `sloProbes` override is set, the configured validator script runs
   * (if any); tests should inject this directly to stay shell-free.
   */
  planeCheckProbe?: import('../slo.js').PlaneCheckProbe;

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
   * Injected dispatch-kick function (for tests). When absent, the real
   * `launchctl kickstart -k gui/<uid>/<cfg.dispatchKickLabel>` runs, and only when
   * `cfg.dispatchKickLabel` is non-empty (default off — see config.ts).
   */
  kickDispatch?: (label: string) => void;
}

function defaultBranchProbe(repoRoot: string): string {
  const r = spawnSync('git', ['branch', '--show-current'], { cwd: repoRoot, stdio: 'pipe' });
  return r.status === 0 ? r.stdout.toString().trim() : '';
}

/**
 * TARGET EXTERNALIZATION (docs/event-model.md §"Build execution": "Acceptance tiering
 * classifies against the target's boundaries block"): resolve the effective classification
 * boundaries for an item. For a targeted item whose manifest reads cleanly, use the target's
 * boundaries; for a legacy (untargeted) item — or if the manifest can't be read — fall back to
 * the plane config, so behavior with no targets is identical to before. `targetCache` memoizes
 * manifest reads within one beat (keyed by target name) to avoid re-reading per item.
 */
function boundariesForItem(
  rec: { target?: string; targetId?: string } | undefined,
  foldResult: import('../fold.js').FoldResult,
  cfg: LoopkitConfig,
  fallbackSurfacePrefixes: string[],
  targetCache: Map<string, { surfacePrefixes: string[]; planePrefixes: string[]; riskPatterns: string[] } | null>,
): { surfacePrefixes: string[]; planePrefixes: string[]; riskPatterns: string[] } {
  const planeDefaults = {
    surfacePrefixes: fallbackSurfacePrefixes,
    planePrefixes: cfg.autoApprove.planePrefixes,
    riskPatterns: cfg.autoApprove.escalationPatterns,
  };
  // Gate on the NAME field (the routing stamp) exactly as before: a coalesced/attributed
  // targetId alone must never flip a legacy item onto target boundaries. The stable
  // targetId only DISAMBIGUATES the registry lookup (and keys the cache) once the item is
  // genuinely targeted — two same-named targets can then never cross-classify.
  const name = rec?.target;
  if (!name) return planeDefaults;
  const cacheKey = rec?.targetId ?? name;
  if (!targetCache.has(cacheKey)) {
    const reg = (rec?.targetId ? foldResult.targets.byId(rec.targetId) : undefined)
      ?? foldResult.targets.byName(name);
    let resolved: { surfacePrefixes: string[]; planePrefixes: string[]; riskPatterns: string[] } | null = null;
    if (reg) {
      try {
        const m = readTargetManifest(reg.repoPath);
        resolved = {
          surfacePrefixes: m.boundaries.surfacePrefixes,
          planePrefixes: m.boundaries.planePrefixes,
          riskPatterns: m.boundaries.escalationPatterns,
        };
      } catch { resolved = null; }
    }
    targetCache.set(cacheKey, resolved);
  }
  return targetCache.get(cacheKey) ?? planeDefaults;
}

/**
 * Kick the dispatch beat immediately after a fresh item.queued append, instead of
 * waiting up to 60s for its StartInterval. No-op when `label` is empty (default — see
 * config.ts's `dispatchKickLabel`, off unless the plane config sets it).
 * Best-effort — a kick failure never fails the reactor beat; dispatch's own StartInterval=60
 * fallback still picks the item up. LOOPKIT_AUTONOMY=off must no-op here too (checked
 * independently of the reactor's own early-exit gate, since this fires from within
 * already-guarded steps).
 */
/**
 * NON-destructive kick args: `kickstart` WITHOUT `-k`. The `-k` variant KILLS and
 * relaunches the job — which would SIGKILL the dispatch beat mid-build on every item.queued
 * (including any requeues the churn itself produces), stranding the build and feeding an
 * orphan-detect→requeue loop. Plain `kickstart` starts dispatch if it is idle and no-ops
 * ("already running") if a build is in flight, so a newly-queued item is picked up by the
 * current build's successor beat instead of murdering the running build. Deliberate
 * wedge-restarts (runbooks.ts self-heal) keep `-k`; routine kicks must not. Pure + exported
 * so the no-`-k` contract is pinned by a test.
 */
export function dispatchKickArgs(uid: number, label: string): string[] {
  return ['kickstart', `gui/${uid}/${label}`];
}

function kickDispatch(label: string): void {
  if (!label || process.env['LOOPKIT_AUTONOMY'] === 'off') return;
  try {
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', dispatchKickArgs(uid, label), {
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch { /* best-effort — dispatch's StartInterval=60 fallback still runs */ }
}

export interface StepResult {
  step: string;
  ok: boolean;
  eventsWritten: number;
  mdWritten: boolean;
  detail?: string;
}

export interface ReactorResult {
  dryRun: boolean;
  steps: StepResult[];
  totalEventsWritten: number;
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

const LOCK_SUBDIR = 'reactor.lock';

/** Reactor wedge threshold: a lock older than this is presumed abandoned even when its
 *  recorded pid looks alive (pid reuse) — the pre-existing age heuristic, unchanged. */
const REACTOR_LOCK_WEDGE_MS = 20 * 60 * 1000;

/** @internal exported for tests */
export function acquireReactorLock(runDir: string): BeatLockAcquisition | null {
  const lockPath = join(runDir, LOCK_SUBDIR);
  const stampPid = () => { try { writeFileSync(join(lockPath, 'pid'), String(process.pid), 'utf8'); } catch { /* best-effort */ } };
  try {
    mkdirSync(lockPath, { recursive: false });
    stampPid();
    return { lockPath, reclaimed: false };
  } catch {
    // The lock exists. Stale signals, probed in the acquire path itself (a wedged beat can't
    // run its own doctor — same contract as the dispatch lock, one shared liveness predicate):
    //   • dead owner pid (SIGKILL residue — the release finally never ran);
    //   • NO readable pid file — an interrupted beat (kill/crash between mkdir and the pid
    //     stamp) leaves an empty lock dir that would otherwise wedge the lane;
    //   • the 20-min age threshold as the fallback for pid reuse (owner looks alive but no
    //     legitimate reactor beat runs that long).
    const ownerAlive = beatLockOwnerAlive(lockPath);
    try {
      const st = statSync(lockPath);
      const wedgedByAge = Date.now() - st.mtimeMs > REACTOR_LOCK_WEDGE_MS;
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
    return null; // another live instance holds the lock
  }
}

function releaseReactorLock(lockPath: string): void {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Gate runner (used by step c)
// ---------------------------------------------------------------------------

/**
 * Max number of gate-timeout transient failures before parking the approved item.
 * Distinguishes SIGKILL-at-timeout (transient, likely beat-load contention) from
 * a real non-zero exit (test red). After this many timeouts the item is parked
 * with a clear "timeout-not-red" message so the operator knows to investigate
 * concurrent dispatch worker load rather than assume a regression.
 */
const MAX_TRANSIENT_TIMEOUT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Run-state root resolution
// ---------------------------------------------------------------------------

/**
 * ONE rule for run-state resolution (no second parser): an explicit `opts.runDir` wins
 * (plane-home mode — run-state lives beside the ledger, outside the driven repo);
 * otherwise fall back to the embedded default under repoRoot. Every internal site that
 * needs run-state derives from this — never from `opts.repoRoot` directly.
 */
function resolveRunDir(opts: Pick<ReactorOptions, 'runDir' | 'repoRoot'>): string {
  return opts.runDir ?? join(opts.repoRoot, '.ai', 'runs', 'loopkit');
}

// ---------------------------------------------------------------------------
// Durable per-item provider-failure counter (routing + engagement)
// ---------------------------------------------------------------------------

/**
 * Guards against a re-send storm: on a provider failure, the routing/engagement steps could
 * otherwise leave the item UNANSWERED and re-send it to the LLM every 30s beat, unbounded. This
 * counter caps that. It is DURABLE (a JSON stamp under <runDir>/provider-fail/) so it
 * survives beat restarts, unlike an in-memory count. After MAX_PROVIDER_FAILURES consecutive
 * failures the caller parks (routing) / skips-with-an-ops-note (engagement); between failures it
 * backs off to no sooner than hourly. A success clears the stamp.
 */
const MAX_PROVIDER_FAILURES = 3;
const PROVIDER_FAIL_BACKOFF_MS = 60 * 60 * 1000; // retry no sooner than hourly

interface ProviderFailState { count: number; lastFailMs: number }

function providerFailPath(runDir: string, itemId: string): string {
  return join(runDir, 'provider-fail', `${itemId}.json`);
}

function readProviderFail(runDir: string, itemId: string): ProviderFailState | undefined {
  try {
    const raw = readFileSync(providerFailPath(runDir, itemId), 'utf8');
    const j = JSON.parse(raw) as ProviderFailState;
    if (typeof j.count === 'number' && typeof j.lastFailMs === 'number') return j;
  } catch { /* absent/unreadable → no prior failures */ }
  return undefined;
}

/** Persist a bumped failure count; returns the new count. Best-effort (never throws). */
function bumpProviderFail(runDir: string, itemId: string, nowMs: number): number {
  const prev = readProviderFail(runDir, itemId);
  const count = (prev?.count ?? 0) + 1;
  try {
    const fp = providerFailPath(runDir, itemId);
    mkdirSync(join(fp, '..'), { recursive: true });
    writeFileSync(fp, JSON.stringify({ count, lastFailMs: nowMs } satisfies ProviderFailState), 'utf8');
  } catch { /* best-effort */ }
  return count;
}

/** Clear the failure stamp on a successful provider call. Best-effort. */
function clearProviderFail(runDir: string, itemId: string): void {
  try { rmSync(providerFailPath(runDir, itemId), { force: true }); } catch { /* best-effort */ }
}

/**
 * True when the item is within its post-failure backoff window (retry not due yet). The caller
 * skips the LLM call entirely this beat — this is what stops the every-30s re-send storm while
 * still under the park threshold.
 */
function providerFailBackingOff(state: ProviderFailState | undefined, nowMs: number): boolean {
  if (!state) return false;
  if (state.count >= MAX_PROVIDER_FAILURES) return false; // at cap → caller parks, not backs off
  return (nowMs - state.lastFailMs) < PROVIDER_FAIL_BACKOFF_MS;
}


/**
 * Cap EVERY merge transient-fail path into a visible ops park, not just the gate-timeout path
 * (which alone honors MAX_TRANSIENT_TIMEOUT_RETRIES). The other transient-fail emitters
 * (master-ref unresolvable, worktree add, push-after-rebase, non-FF/auth push) would otherwise
 * retry forever, invisibly, every beat. This helper routes them all through the same cap: while
 * under the cap it emits merge.transient-fail (item stays approved, retried next beat); on the
 * Nth consecutive failure it parks parkKind:'ops', parkClass:'merge-transient' with the git
 * failure tail in the reason so the operator/health lane sees it.
 * Returns the events to push (never mutates the ledger directly).
 */
function mergeTransientEvents(
  rec: ItemRecord,
  reason: string,
): ReturnType<typeof makeEvent>[] {
  const newCount = (rec.transientFailCount ?? 0) + 1;
  const tail = reason.slice(0, 800);
  if (newCount >= MAX_TRANSIENT_TIMEOUT_RETRIES) {
    // parkClass is carried by a gate.parked event (the fold derives parkClass from gate.parked.reason,
    // not from item.parked — ItemParkedData has no parkClass field), mirroring the gate's own park path.
    return [
      makeEvent('reactor', rec.id, 'gate.failed', {
        reason: `merge transient-fail ${newCount}× — parked for investigation: ${tail}`,
      }),
      makeEvent('reactor', rec.id, 'gate.parked', { reason: 'merge-transient' }),
      makeEvent('reactor', rec.id, 'item.parked', {
        reason: `merge failed ${newCount}× (transient): ${tail}`,
        parkKind: 'ops',
      }),
    ];
  }
  return [
    makeEvent('reactor', rec.id, 'merge.transient-fail', {
      reason: tail,
      transientCount: newCount,
    }),
  ];
}


// Tail of the combined stdout+stderr embedded directly in the gate.failed reason.
const MERGE_GATE_REASON_TAIL = 800;
// Full combined-output cap persisted to the mergegate log artifact (matches dispatch.ts's
// GATE_LOG_CAP so both beats' gate logs are comparably sized).
const MERGE_GATE_LOG_CAP = 6_000;

function runGateOnce(
  gateCommand: string,
  gateWorkdir: string,
  repoRoot: string,
  dryRun: boolean,
  timeoutMs: number,
): { passed: boolean; timedOut: boolean; reason: string; output: string } {
  if (dryRun) return { passed: true, timedOut: false, reason: 'dry-run (not executed)', output: '' };
  const cwd = resolve(repoRoot, gateWorkdir);
  // Env hygiene (mirrors the dispatch gate): target code never inherits the plane's
  // identity vars, or repo-local config fixtures resolve against the plane's config.
  const gateEnv: NodeJS.ProcessEnv = { ...process.env };
  delete gateEnv['LOOPKIT_HOME'];
  delete gateEnv['LOOPKIT_LEDGER'];
  const result = spawnSync('sh', ['-c', gateCommand], {
    cwd,
    env: gateEnv,
    stdio: 'pipe',
    timeout: timeoutMs,
    // spawnSync's DEFAULT maxBuffer is 1 MiB; a gate whose diff pulls in extra
    // suites can emit more than that, and Node then kills the child with status null —
    // byte-for-byte identical to the timeout kill, which previously misdiagnosed several
    // ENOBUFS overflows as "timeout" parks (never reproducible attended, where no
    // maxBuffer applies).
    maxBuffer: 64 * 1024 * 1024,
  });
  // Combined stdout + stderr — a stdout-only failure (e.g. `npm test`'s red output) would
  // otherwise be invisible if the reason only sliced stderr, leaving gate.failed events reading
  // "gate exited 1: " with nothing after the colon.
  const combined = ((result.stdout?.toString() ?? '') + '\n' + (result.stderr?.toString() ?? '')).trim();
  if (result.status === 0) {
    return { passed: true, timedOut: false, reason: 'tests green', output: combined };
  }
  if (result.status === null) {
    // status null = Node killed the child: the timeout, or output overflowing
    // maxBuffer (error.code ENOBUFS). An ENOBUFS kill is deterministic — it must
    // not burn transient-timeout retries.
    const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errCode === 'ENOBUFS') {
      return {
        passed: false,
        timedOut: false,
        reason: 'gate output exceeded maxBuffer (ENOBUFS) — not a test failure; raise maxBuffer in runGateOnce',
        output: combined,
      };
    }
    return {
      passed: false,
      timedOut: true,
      reason: `gate killed after ${timeoutMs}ms (timeout)`,
      output: combined,
    };
  }
  const tail = combined.slice(-MERGE_GATE_REASON_TAIL);
  return { passed: false, timedOut: false, reason: `gate exited ${result.status}: ${tail}`, output: combined };
}

/**
 * Persist the merge gate's combined output (last ~6000 chars) to
 * `.ai/runs/loopkit/<WI>-mergegate-<n>.log`, matching the naming dispatch.ts's build
 * attempts already use for their own gate artifacts. Best-effort; never throws.
 */
function persistMergeGateLog(
  runDir: string,
  itemId: string,
  n: number,
  output: string,
): void {
  const logPath = join(runDir, `${itemId}-mergegate-${n}.log`);
  try {
    mkdirSync(runDir, { recursive: true });
    const tail = output.length > MERGE_GATE_LOG_CAP ? output.slice(-MERGE_GATE_LOG_CAP) : output;
    writeFileSync(logPath, tail, 'utf8');
  } catch (e) {
    process.stderr.write(`[reactor] artifact: failed to write mergegate log ${logPath}: ${e}\n`);
  }
}

// ---------------------------------------------------------------------------
// Step (b): route NEW captured items
// ---------------------------------------------------------------------------

/**
 * The three route classes the conductor prompt emits and this beat can act on
 * deterministically. Each maps to a real ledger transition (see parseRoutingDecision):
 *   build  → item.queued  (dispatch picks it up, Touches-disjoint)
 *   park   → item.parked  (needs-you board — costly-and-irreversible / needs an operator call)
 *   answer → item.routed  (question/status/ack — the reply is delivered, item comes to rest)
 */
export type RouteClass = 'build' | 'park' | 'answer';

export interface RoutingDecision {
  route: RouteClass;
  spec?: string;
  touches?: string;
  model?: string;
  effort?: string;
  priority?: string;
  /**
   * Delivery lane. Always resolved — defaults to DEFAULT_LANE ('engineering')
   * when the block omits LANE or names an unknown lane. Marketing is the only other
   * recognized lane today; its own execution path (worker/gate/delivery) is separate, so an
   * engineering item is entirely unaffected by this field.
   */
  lane: string;
  /** Router-stamped short title, 3-5 words. Absent when the model omitted TITLE. */
  title?: string;
  /** Operator-facing reply, delivered as msg.out. */
  reply: string;
  /**
   * False when a structured block was present but its ROUTE field was missing/garbled (not one
   * of build|park|answer). Defaulting such a garble to 'answer' would silently answer-and-forget
   * a build request. The caller treats routeValid:false as a provider failure (retry with the
   * per-item counter), never a silent answer. True when ROUTE was explicit-and-valid, OR when
   * there was no block at all (a plain-text answer is the legitimate degrade for a bare
   * question, not a garble).
   */
  routeValid: boolean;
}

const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PRIORITY = new Set(['blocker', 'high', 'medium', 'low']);
/** Lanes the router may assign. Unknown/absent → DEFAULT_LANE. */
const VALID_LANES = new Set(['engineering', 'marketing']);

/**
 * Parse the conductor prompt's structured routing block. Doctrine (transcribe, don't
 * transform): the LLM emits key:value lines, this deterministic wall parses + validates them
 * into canonical events — never trust free prose to carry routing state. Robust to sloppy
 * output: unknown ROUTE → 'answer' (never lose the item), invalid MODEL/EFFORT/PRIORITY
 * dropped (→ dispatch defaults), and a reply with no block at all degrades to delivering the
 * whole text as an answer.
 *
 * Recognized keys (each starts a field; values may span following non-key lines):
 *   ROUTE: build|park|answer   SPEC: <what to build / park reason>
 *   TOUCHES: <comma-sep path prefixes>   MODEL: haiku|sonnet|opus
 *   EFFORT: low|medium|high|xhigh|max    PRIORITY: blocker|high|medium|low
 *   LANE: engineering|marketing    TITLE: <3-5 word short title>
 *   REPLY: <operator-facing text>
 */
export function parseRoutingDecision(text: string): RoutingDecision {
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*(ROUTE|SPEC|TOUCHES|MODEL|EFFORT|PRIORITY|LANE|TITLE|REPLY)\s*:\s*(.*)$/);
    if (m) {
      current = m[1];
      fields[current] = m[2];
    } else if (current) {
      fields[current] += (fields[current] ? '\n' : '') + rawLine;
    }
  }
  const hadBlock = Object.keys(fields).length > 0;
  const norm = (s?: string): string => (s ?? '').trim();

  const routeRaw = norm(fields['ROUTE']).toLowerCase();
  const route: RouteClass = routeRaw === 'build' ? 'build' : routeRaw === 'park' ? 'park' : 'answer';
  // A block WITH a ROUTE line that isn't build|park|answer is a garble (retry),
  // NOT a silent 'answer'. No block at all → a bare plain-text answer is legitimate (routeValid).
  const routeValid = !hadBlock || routeRaw === 'build' || routeRaw === 'park' || routeRaw === 'answer';
  const model = norm(fields['MODEL']).toLowerCase();
  const effort = norm(fields['EFFORT']).toLowerCase();
  const priority = norm(fields['PRIORITY']).toLowerCase();
  const lane = norm(fields['LANE']).toLowerCase();
  const spec = norm(fields['SPEC']) || undefined;
  const title = norm(fields['TITLE']) || undefined;

  // REPLY is what the operator sees. Missing REPLY but a block present → a route-appropriate
  // default (never surface the raw key:value lines). No block at all → the whole text.
  const reply = norm(fields['REPLY'])
    || (hadBlock
      ? (route === 'build' ? 'Queued for build.' : spec || 'Noted.')
      : text.trim());

  return {
    route,
    spec,
    touches: norm(fields['TOUCHES']) || undefined,
    model: VALID_MODELS.has(model) ? model : undefined,
    effort: VALID_EFFORTS.has(effort) ? effort : undefined,
    priority: VALID_PRIORITY.has(priority) ? priority : undefined,
    // Unknown/absent lane → the engineering reference lane. Never lose the item.
    lane: VALID_LANES.has(lane) ? lane : DEFAULT_LANE,
    title,
    reply,
    routeValid,
  };
}

// ---------------------------------------------------------------------------
// Touches grounding against a target repo's real tree (routing-wall post-processing)
// ---------------------------------------------------------------------------

/**
 * Deterministic WALL post-processing (never a prompt change): ground a routed Touches
 * string against a target repo's REAL top-level tree. The router sometimes names path
 * prefixes that don't exist in the target repo (an embedded-style layout, or a wrong
 * package name) — lane disjointness would then rest on fiction. A prefix is kept when its
 * first path segment names a real top-level entry of the target tree; otherwise it is
 * dropped (the '*' wildcard always survives). All prefixes dropped ⇒ touches undefined,
 * i.e. the item serializes the lane as a wildcard — safer than fictional disjointness.
 * @internal exported for tests
 */
export function groundTouchesAgainstTree(
  touches: string,
  topLevel: ReadonlySet<string>,
): { touches?: string; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const prefix of normalizeTouches(touches)) {
    if (prefix === '*') { kept.push(prefix); continue; }
    const head = prefix.split('/')[0];
    if (head && topLevel.has(head)) kept.push(prefix);
    else dropped.push(prefix);
  }
  return { touches: kept.length > 0 ? kept.join(', ') : undefined, dropped };
}

/**
 * Top-level entry names of a repo's committed tree (`git ls-tree --name-only HEAD` at the
 * target's repoPath). Returns null when the tree is unreadable (not a git repo, no commit
 * yet) — grounding then SKIPS, fail-open: an unreadable tree must never drop real Touches.
 */
function readTargetTopLevelTree(repoPath: string): Set<string> | null {
  const r = spawnSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: repoPath, stdio: 'pipe' });
  if (r.status !== 0) return null;
  const names = r.stdout.toString().split('\n').map(s => s.trim()).filter(Boolean);
  return new Set(names);
}

// ---------------------------------------------------------------------------
// Step (b1.5): reactor engagement routing on work-item threads
// ---------------------------------------------------------------------------

/** Max operator replies engaged per beat (each is one LLM call; keeps the 30s beat bounded). */
const ENGAGE_PER_BEAT = 6;
/** How many trailing thread messages to hand the engagement prompt as context. */
const ENGAGE_TRAIL_TAIL = 8;

export type EngagementKind = 'answer' | 'steer' | 'verdict' | 'unpark' | 'sibling' | 'unparseable';

export interface EngagementOutcome {
  kind: EngagementKind;
  /** Operator-facing reply text (always present for a parseable outcome). */
  reply: string;
  /** steer/sibling: the amended-or-new spec. */
  spec?: string;
  /** verdict: the PROPOSED verb — a recommendation only, never executed by the LLM. */
  verdict?: 'accept' | 'reject';
}

/**
 * Deterministic wall parsing the engagement prompt's OUTCOME block (mirrors parseRoutingDecision).
 * A destructive verb is NEVER derived here — a 'verdict' outcome only records the LLM's PROPOSAL;
 * the operator confirms via an exact console verb pattern. Missing/garbled block, or an outcome
 * lacking the field it needs (steer/sibling without SPEC, verdict without VERDICT, any without
 * REPLY) ⇒ 'unparseable' so the reactor parks it for ops rather than guessing.
 */
export function parseEngagementOutcome(text: string): EngagementOutcome {
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*(OUTCOME|REPLY|SPEC|VERDICT)\s*:\s*(.*)$/);
    if (m) {
      current = m[1];
      fields[current] = m[2];
    } else if (current) {
      fields[current] += (fields[current] ? '\n' : '') + rawLine;
    }
  }
  const norm = (s?: string): string => (s ?? '').trim();
  const outcomeRaw = norm(fields['OUTCOME']).toLowerCase();
  const reply = norm(fields['REPLY']);
  const spec = norm(fields['SPEC']) || undefined;
  const verdictRaw = norm(fields['VERDICT']).toLowerCase();
  const verdict = verdictRaw === 'accept' ? 'accept' : verdictRaw === 'reject' ? 'reject' : undefined;

  const KINDS = new Set(['answer', 'steer', 'verdict', 'unpark', 'sibling']);
  const fallback = (): EngagementOutcome => ({ kind: 'unparseable', reply: reply || text.trim().slice(0, 500) });
  if (!KINDS.has(outcomeRaw)) return fallback();
  if (!reply) return fallback();
  if ((outcomeRaw === 'steer' || outcomeRaw === 'sibling') && !spec) return fallback();
  if (outcomeRaw === 'verdict' && !verdict) return fallback();
  return { kind: outcomeRaw as EngagementKind, reply, spec, verdict };
}

/**
 * Degraded routing note.
 * Prepended to routing prompts when the resolved provider lacks tool support.
 * Tells the classifier to rely on text alone and prefer conservative outcomes.
 */
const DEGRADED_ROUTING_NOTE =
  'NOTE: repo tools unavailable — classify from the text alone; when uncertain, prefer route=answer with a question rather than guessing.';

// ---------------------------------------------------------------------------
// Step (a2): deterministic decomposition-unpark handler
//
// An approved-but-too-big epic is tagged parkKind:'decomposition' so it rests off the
// operator's desk instead of bouncing back in a loop. Without this step nothing acts on
// that park — it just sits there. This step closes the gap: whenever a decomposition park
// is unparked, deterministically queue a lane='planning' item to decompose it, then rest
// the epic again under the same parkKind. Zero-LLM (transcribe, don't re-decide) — the
// classifier already made this call once when it set parkKind:'decomposition'; re-asking it
// via stepRoute would either loop or waste a call, so this step MUST run BEFORE stepRoute in
// the same beat: both read 'queued'-with-no-spec items, and this one needs first pick so the
// epic never re-enters the classifier.
//
// A FRESH classification of a decomposition park (the classifier judges it a multi-slice
// epic for the first time, inside stepRoute's isDecomp path) needs the exact same
// child-emission — otherwise an approved-but-just-reclassified epic reroutes to
// parkKind:'decomposition' with no planning child ever queued, stranding it silently (the
// operator's needs-you desk filter hides it, and nothing re-triggers without another
// operator unpark). The two helpers below are the shared emission logic for both call sites.
// ---------------------------------------------------------------------------

/** Epic id a decomposition child references, recovered from either its source or spec. */
function decomposedEpicIdFor(rec: Pick<ItemRecord, 'source' | 'sourceText'>): string | undefined {
  if (rec.source?.startsWith('decompose:')) return rec.source.slice('decompose:'.length);
  const m = /^decompose (WI-\d+):/.exec(rec.sourceText ?? '');
  return m ? m[1] : undefined;
}

/** Has a 'decompose <epicId>:' planning child already been queued (by source or spec)? */
function decompositionChildExists(items: Iterable<ItemRecord>, epicId: string): boolean {
  for (const rec of items) {
    if (decomposedEpicIdFor(rec) === epicId) return true;
  }
  return false;
}

/** All epics already tracked by an emitted decomposition child, as of the loaded fold. */
function collectDecomposedEpics(items: Iterable<ItemRecord>): Set<string> {
  const set = new Set<string>();
  for (const rec of items) {
    const epicId = decomposedEpicIdFor(rec);
    if (epicId) set.add(epicId);
  }
  return set;
}

/** Planning-child capture+queue pair — the deterministic emission both steps share. */
function makeDecompositionChildEvents(
  epicId: string,
  reason: string,
  wiNum: number,
): { childId: string; events: LedgerEvent[] } {
  const childId = `WI-${String(wiNum).padStart(3, '0')}`;
  const childSpec = `decompose ${epicId}: ${reason}`;
  return {
    childId,
    events: [
      makeEvent('reactor', childId, 'item.captured', {
        source: `decompose:${epicId}`,
        text: childSpec,
      }),
      makeEvent('reactor', childId, 'item.queued', {
        spec: childSpec,
        lane: 'planning',
      } as ItemQueuedData),
    ],
  };
}

/**
 * WI-098 — cross-target pattern promotion ("harvest portable patterns at boundaries — never leave
 * them in chat"). When a MERGED item's certification carries a portability note naming OTHER
 * registered targets, capture a sibling item on each so the generalizable pattern lands as durable
 * work on the right project instead of being rediscovered later. The captured sibling is:
 *   - PARKED as a decision when the source work is product-shaped (an operator must ratify how the
 *     pattern applies to that target's product surface), OR
 *   - QUEUED when the source work is mechanical (a tooling/infra change the plane can just build).
 * docs/method.md stays the durable home for ratified GENERIC patterns; this step never edits it —
 * it only files the per-target work item (tracked as a sibling concern).
 *
 * Idempotent: each promoted sibling carries source `portability:<sourceWI>:<targetName>` and the
 * step skips any (source, target) pair that already has one — a standing merged item is promoted
 * exactly once per named target, never re-captured every beat.
 *
 * ADVISORY nudge (same shape as escalation-grooming): a merged item that OWED a portability note
 * (ADR-bearing / incident-fix, isPortabilityRequired) but shipped without one gets ONE msg.out
 * asking the producer to state portability. Never a hard gate — the merge already happened; this
 * only prompts the harvest it skipped.
 */
const PORTABILITY_NUDGE_MARKER = 'portability-nudge:';

/** Product-shaped source work ⇒ the promoted sibling parks as a decision (an operator ratifies how
 *  the pattern applies to that target's product); mechanical work ⇒ it queues. Heuristic, keyed on
 *  the source item's lane + spec shape — a false call only changes park-vs-queue, never correctness. */
function isProductShapedSource(rec: ItemRecord): boolean {
  const lane = rec.lane;
  if (lane === 'engineering' || lane === 'repair') return false;   // build/tooling/repair work is mechanical
  if (lane === 'planning' || lane === 'marketing' || lane === 'product') return true;
  const hay = `${rec.spec ?? ''}\n${rec.sourceText ?? ''}`;
  return /\b(product|pricing|packaging|surface|UX|onboarding|policy|doctrine|ADR|D-\d{2,})\b/i.test(hay);
}

async function stepPortabilityPromotion(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'portability-promotion';
  // Staged flag (method.md "the rollback is written before the flip"): multi-target
  // portability isn't proven yet (README's "Honest scope"), so this defaults off — an unset
  // flag is byte-for-byte "the step never runs." No lock taken, no events read, when disabled.
  if (!cfg.portabilityPromotion?.enabled) {
    return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'disabled (portabilityPromotion.enabled=false)' };
  }
  try {
    let written = 0;
    let promotedCount = 0;
    let nudgedCount = 0;
    const skippedUnregistered: string[] = [];
    await withLock(opts.ledgerDir, async (tx) => {
      const allEvents = await tx.loadAll();
      const foldResult = fold(allEvents);
      const events: LedgerEvent[] = [];
      let nextNum = foldResult.maxWiNum;

      // Existing promotion siblings, keyed by their source stamp — the once-per-(source,target)
      // idempotency guard (extended synchronously below so two named targets in one note don't
      // collide on a WI number within this beat).
      const promotedPairs = new Set<string>();
      for (const rec of foldResult.items.values()) {
        if (rec.source && rec.source.startsWith('portability:')) promotedPairs.add(rec.source);
      }

      for (const rec of foldResult.items.values()) {
        // Only harvest from an item that actually SHIPPED (merged/accepted) — a parked or in-flight
        // item's certification isn't final.
        if (rec.state !== 'merged' && rec.state !== 'accepted') continue;

        const cert = rec.mergeCertification;
        // ADR-009: the parser is strict-with-salvage (see schema.ts) — the reactor's read stays
        // tolerant by consuming only `.targets` and ignoring `.errors` (a malformed entry among
        // otherwise-valid ones just drops that one name; the amend verb is the strict gate).
        const targets = parsePortabilityTargets(cert?.portability).targets;

        // ADVISORY nudge: owed a portability note but shipped without one (or with a blank/none it
        // shouldn't have). Bounded once per item via the msg.out marker.
        const owed = isPortabilityRequired({
          spec: rec.spec, text: rec.sourceText, lane: rec.lane, repairContext: rec.repairContext,
        });
        if (owed && !cert?.portability) {
          const alreadyNudged = rec.messages.some(
            (m) => m.direction === 'out' && m.text.startsWith(PORTABILITY_NUDGE_MARKER),
          );
          if (!alreadyNudged) {
            events.push(makeEvent('reactor', rec.id, 'msg.out', {
              text: `${PORTABILITY_NUDGE_MARKER} This ADR-bearing/incident-fix item shipped without a portability note. State which other targets its pattern applies to (or "none") so the harvest isn't lost — run \`loopctl portability ${rec.id} "applies to: <targets> | none"\`.`,
            }));
            nudgedCount++;
          }
        }

        if (targets.length === 0) continue;

        const productShaped = isProductShapedSource(rec);
        for (const targetName of targets) {
          // Never promote onto the item's OWN target (that's not cross-target).
          const ownTarget = rec.target;
          if (ownTarget && targetName === ownTarget) continue;

          // Resolve against the registered targets — an unregistered name captures nothing
          // (surfaced in the detail; the operator can register it and the promotion fires next beat).
          const targetRec = foldResult.targets.byName(targetName);
          if (!targetRec) { skippedUnregistered.push(`${rec.id}→${targetName}`); continue; }

          const sourceStamp = `portability:${rec.id}:${targetName}`;
          if (promotedPairs.has(sourceStamp)) continue;
          promotedPairs.add(sourceStamp);

          nextNum += 1;
          const childId = `WI-${String(nextNum).padStart(3, '0')}`;
          const patternRef = (rec.title ?? rec.spec ?? rec.sourceText ?? rec.id).slice(0, 120);
          const childText = `Apply the pattern from ${rec.id} ("${patternRef}") to ${targetName}.`;

          events.push(makeEvent('reactor', childId, 'item.captured', {
            source: sourceStamp,
            text: childText,
            target: targetName,
            targetId: targetRec.targetId,
          } as ItemCapturedData));

          if (productShaped) {
            // Product-shaped ⇒ park as a decision so an operator ratifies how the pattern applies
            // to that target's product surface before it becomes build work.
            events.push(makeEvent('reactor', childId, 'item.parked', {
              reason: `Portability of ${rec.id}'s pattern to ${targetName} — ratify how it applies to this target's product before building.`,
              parkKind: 'decision',
            }));
          } else {
            // Mechanical ⇒ queue it directly; dispatch builds it against the named target.
            events.push(makeEvent('reactor', childId, 'item.queued', {
              spec: childText,
            } as ItemQueuedData));
          }
          promotedCount++;
        }
      }

      if (!opts.dryRun && events.length > 0) {
        await tx.append(events);
        written = events.length;
      }
    });

    const bits: string[] = [];
    if (promotedCount > 0) bits.push(`promoted ${promotedCount} sibling(s)`);
    if (nudgedCount > 0) bits.push(`nudged ${nudgedCount} for missing portability`);
    if (skippedUnregistered.length > 0) bits.push(`skipped ${skippedUnregistered.length} unregistered target(s): ${skippedUnregistered.join(', ')}`);
    return {
      step,
      ok: true,
      eventsWritten: written,
      mdWritten: false,
      detail: bits.length === 0 ? 'no portability notes to promote' : bits.join('; '),
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

async function stepDecompositionUnpark(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'decomposition-unpark';
  try {
    let written = 0;
    let queuedCount = 0;
    await withLock(opts.ledgerDir, async (tx) => {
      const allEvents = await tx.loadAll();
      const foldResult = fold(allEvents);

      // The fold clears parkKind/parkReason on item.unparked (fold.ts) — recover what
      // they were AT THE MOMENT of the last unpark from the raw event stream.
      const lastParkKind = new Map<string, string | undefined>();
      const lastParkReason = new Map<string, string | undefined>();
      const parkKindAtUnpark = new Map<string, string | undefined>();
      const parkReasonAtUnpark = new Map<string, string | undefined>();
      for (const ev of allEvents) {
        if (ev.type === 'item.parked') {
          const d = ev.data as { reason?: string; parkReason?: string; parkKind?: string };
          lastParkKind.set(ev.item, d.parkKind);
          lastParkReason.set(ev.item, d.reason ?? d.parkReason);
        } else if (ev.type === 'item.unparked') {
          parkKindAtUnpark.set(ev.item, lastParkKind.get(ev.item));
          parkReasonAtUnpark.set(ev.item, lastParkReason.get(ev.item));
        }
      }

      const events: LedgerEvent[] = [];
      let nextNum = foldResult.maxWiNum;

      for (const rec of foldResult.items.values()) {
        // Same predicate stepRoute uses for the unpark→reroute orphan class:
        // a spec-less 'queued' item that was just unparked.
        const speclessQueued = rec.state === 'queued' && (rec.spec ?? '').trim().length === 0;
        if (!speclessQueued || !rec.lastUnparkedAt) continue;
        if (parkKindAtUnpark.get(rec.id) !== 'decomposition') continue;
        // Idempotency: don't double-queue if a child already exists — e.g. one
        // was already emitted by stepRoute's isDecomp path earlier this same beat.
        if (decompositionChildExists(foldResult.items.values(), rec.id)) continue;

        const rawReason = parkReasonAtUnpark.get(rec.id) ?? rec.sourceText ?? rec.id;
        const reason = rawReason.replace(/^\s*needs planner decomposition:\s*/i, '').trim() || rec.id;

        nextNum += 1;
        const { childId, events: childEvents } = makeDecompositionChildEvents(rec.id, reason, nextNum);
        events.push(...childEvents);

        // Rest the epic off the operator's desk again (same parkKind) — the planner now
        // owns slicing it; this also keeps stepRoute from reclassifying it this beat.
        events.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: `queued for planner decomposition as ${childId}`,
          parkKind: 'decomposition',
        }));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `Queued ${childId} to decompose this epic (planning lane).`,
        }));

        queuedCount++;
      }

      if (!opts.dryRun && events.length > 0) {
        await tx.append(events);
        written = events.length;
      }
    });

    return {
      step,
      ok: true,
      eventsWritten: written,
      mdWritten: false,
      detail: queuedCount === 0 ? 'no decomposition unparks' : `queued ${queuedCount} planning-lane item(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

/**
 * Zombie cleanup: a decomposition-parked epic that rests again after stepDecompositionUnpark
 * (reason: "queued for planner decomposition as WI-NNN") would otherwise sit parked forever —
 * the planning child owns the work going forward, but nothing else closes the parent. This step
 * auto-closes any parkKind:'decomposition' item whose current park reason references a WI-NNN
 * that already exists in the fold (the child has been captured, so the parent is superseded). No
 * `item.superseded` type exists in the schema (KNOWN_TYPES) — `item.rejected` is the closest
 * existing terminal event; the human-readable "superseded by" detail rides a companion msg.out,
 * matching the reason/msg.out split stepDecompositionUnpark uses.
 */
async function stepDecompositionGrooming(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'decomposition-grooming';
  try {
    let written = 0;
    let closedCount = 0;
    await withLock(opts.ledgerDir, async (tx) => {
      const allEvents = await tx.loadAll();
      const foldResult = fold(allEvents);

      const events: LedgerEvent[] = [];
      // Match the CANONICAL decomposition-child ref only. A bare /WI-\d+/ would hit the first
      // WI mention anywhere in the reason, so an unrelated WI reference (e.g. "like WI-042")
      // could close the epic against the wrong child. Accept either the canonical template
      // ("...as WI-NNN") OR a WI-NNN whose captured item.source points back at THIS epic
      // (source === decompose:<epic>) — the child the decomposition path actually spawned.
      const CANONICAL_CHILD_RE = /\bas (WI-\d+)\b/;
      for (const rec of foldResult.items.values()) {
        if (rec.state !== 'parked' || rec.parkKind !== 'decomposition') continue;
        const reason = rec.parkReason ?? '';

        // Prefer the canonical "...as WI-NNN" child; else fall back to any WI mention but ONLY when
        // that child's source proves it descends from this epic.
        let childId: string | undefined;
        const canon = CANONICAL_CHILD_RE.exec(reason);
        if (canon) {
          childId = canon[1];
        } else {
          for (const m2 of reason.matchAll(/\bWI-\d+\b/g)) {
            const cand = foldResult.items.get(m2[0]);
            if (cand && cand.source === `decompose:${rec.id}`) { childId = m2[0]; break; }
          }
        }
        if (!childId || childId === rec.id) continue;
        const child = foldResult.items.get(childId);
        if (!child) continue;

        // Even a canonical-template match must be verified to descend from THIS epic when the
        // child carries a source — a copied/typo'd reason must not close the wrong epic.
        if (child.source && child.source !== `decompose:${rec.id}`) continue;

        // A child that folded to 'rejected' means the decomposition intent was
        // dropped, NOT delivered — closing the epic as "superseded" would silently lose the work.
        // Skip the close and surface a needs-attention ops note (once — dedup on the child ref).
        if (child.state === 'rejected') {
          const already = allEvents.some(ev =>
            ev.item === rec.id && ev.type === 'msg.out' &&
            /decomposition child .* was rejected/.test(String((ev.data as { text?: string }).text ?? '')));
          if (!already) {
            events.push(makeEvent('reactor', rec.id, 'msg.out', {
              text: `Needs attention: decomposition child ${childId} was rejected — the epic ${rec.id} is NOT superseded (its intent was dropped, not delivered). Re-decompose or reject ${rec.id} explicitly.`,
            }));
          }
          continue;
        }

        events.push(makeEvent('reactor', rec.id, 'item.rejected', { by: 'reactor' } as ItemRejectedData));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `Closed — superseded by ${childId} (decomposition grooming).`,
        }));
        closedCount++;
      }

      if (!opts.dryRun && events.length > 0) {
        await tx.append(events);
        written = events.length;
      }
    });

    return {
      step,
      ok: true,
      eventsWritten: written,
      mdWritten: false,
      detail: closedCount === 0 ? 'no decomposition zombies' : `closed ${closedCount} decomposition-superseded item(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

/**
 * Leader-leader escalation doctrine bounce (WI-056, intent-based leadership — "escalate
 * with intent, never a bare question"). A `parkKind:'decision'` park is exactly the kind that
 * reaches the operator's needs-you desk — it SHOULD carry the four-field escalation payload
 * (intent/evidence/risk/recommendation), not a bare question. This step flags the ones that
 * don't: no `escalation` payload AND the reason reads as a bare question (ends with '?', or
 * lacks any of the doctrine's marker words). It appends ONE msg.out asking the producer to
 * restate — bounded per (item, parkFingerprint) so a standing park is never re-bounced every
 * beat forever (the same dedup shape stepNotifyDecisionParks uses, but keyed off the ledger's
 * own msg.out trail rather than a separate stamp file — this bounce is advisory prose, not a
 * paged notification, so it doesn't need the notify step's delivery-retry machinery).
 */
const ESCALATION_BOUNCE_MARKER = 'escalation-bounce:';

/** A park reason "reads as a bare question" per WI-056: it ends with '?', or it never
 *  states an intent (no "I intend to" / "intend to" / "recommend" language at all). Advisory
 *  heuristic only — false negatives (a well-formed reason this misses) just skip the bounce,
 *  never wrongly block a real decision from reaching the desk. */
function readsAsBareQuestion(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.endsWith('?')) return true;
  return !/\b(intend to|recommend|recommendation)\b/i.test(trimmed);
}

async function stepEscalationGrooming(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'escalation-grooming';
  try {
    let written = 0;
    let bouncedCount = 0;
    await withLock(opts.ledgerDir, async (tx) => {
      const allEvents = await tx.loadAll();
      const foldResult = fold(allEvents);

      const events: LedgerEvent[] = [];
      for (const rec of foldResult.items.values()) {
        if (!isDecisionPark(rec)) continue;
        if (rec.escalation) continue; // already carries the four-field payload
        const reason = rec.parkReason ?? '';
        if (!readsAsBareQuestion(reason)) continue;

        // Bounded: never bounce the SAME standing park (same fingerprint) twice.
        const fp = rec.parkFingerprint;
        const alreadyBounced = fp !== undefined && rec.messages.some(
          (m) => m.direction === 'out' && m.text.startsWith(`${ESCALATION_BOUNCE_MARKER}${fp}`),
        );
        if (alreadyBounced) continue;

        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `${ESCALATION_BOUNCE_MARKER}${fp ?? ''} Please restate this park with intent, not a bare question: state (1) what you intend to do, (2) the evidence, (3) the main risk, (4) your recommendation. Current reason: "${reason}"`,
        }));
        bouncedCount++;
      }

      if (!opts.dryRun && events.length > 0) {
        await tx.append(events);
        written = events.length;
      }
    });

    return {
      step,
      ok: true,
      eventsWritten: written,
      mdWritten: false,
      detail: bouncedCount === 0 ? 'no bare-question decision parks' : `bounced ${bouncedCount} decision park(s) for missing escalation`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

async function stepRoute(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
  provider: LlmProvider | null,
  degraded = false,
  providerRegistry?: ReturnType<typeof makeRegistry> | null,
): Promise<StepResult> {
  const step = 'route';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    // Find items to route:
    //   (a) 'captured' — never routed yet.
    //   (b) 'queued' WITHOUT a spec — the unpark→spec-less-queued orphan class.
    //       An item.unparked returns a never-built decision-park to 'queued', but a spec is only
    //       ever set by item.queued (emitted on a 'build' route), so such an item can never be
    //       dispatched (dispatch picks `state==='queued' && spec`) and — before this — no beat
    //       ever re-routed it: it orphaned silently for hours. Treating spec-less 'queued' as
    //       routable is the queue-doctor invariant (self-heal): no item may rest in 'queued'
    //       without a build spec — it is either routed to build or surfaced/parked, every beat.
    const toRoute: ItemRecord[] = [];
    for (const rec of foldResult.items.values()) {
      // Never route an item with no text — a phantom/malformed capture would send the
      // conductor prompt with "(empty)" to the provider and hallucinate a reply.
      if ((rec.sourceText ?? '').trim().length === 0) continue;
      const speclessQueued = rec.state === 'queued' && (rec.spec ?? '').trim().length === 0;
      if (rec.state === 'captured' || speclessQueued) toRoute.push(rec);
    }

    if (toRoute.length === 0) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'no new items to route' };
    }

    // Zero-LLM path when no provider
    if (!provider) {
      return {
        step,
        ok: true,
        eventsWritten: 0,
        mdWritten: false,
        detail: `${toRoute.length} items awaiting routing — no provider available (zero-LLM beat)`,
      };
    }

    // Load the conductor prompt-of-record
    const promptPath = join(opts.repoRoot, cfg.promptsDir, 'conductor.md');
    let conductorPrompt: string;
    try {
      conductorPrompt = readFileSync(promptPath, 'utf8');
    } catch {
      return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: `conductor prompt missing: ${promptPath}` };
    }

    // In degraded mode (tool-less fallback), prepend the degradation note to every prompt.
    const promptPrefix = degraded ? `${DEGRADED_ROUTING_NOTE}\n\n` : '';

    const events: ReturnType<typeof makeEvent>[] = [];

    // Touches-grounding corrections made this beat (target items only) — surfaced in the
    // step detail so a dropped fictional prefix is visible in the beat log.
    const touchesCorrections: string[] = [];

    // Beat-scoped allocator + idempotency guard for the isDecomp reclassify path below. Seeded
    // from the persisted fold, then extended synchronously the moment a child is allocated so
    // two epics reclassified in the same beat (routeOne runs concurrently in chunks, but each
    // allocation itself is synchronous) can never collide on a WI number or double-queue the
    // same epic.
    const decomposedEpics = collectDecomposedEpics(foldResult.items.values());
    let nextDecompNum = foldResult.maxWiNum;
    const maybeEmitDecompositionChild = (epicId: string, reason: string): LedgerEvent[] => {
      if (decomposedEpics.has(epicId)) return [];
      decomposedEpics.add(epicId);
      nextDecompNum += 1;
      return makeDecompositionChildEvents(epicId, reason, nextDecompNum).events;
    };

    // Route in PARALLEL chunks of 4 — serial provider calls inside the single-lock beat could
    // otherwise leave a burst of operator captures sitting in 'captured' for minutes. Routing
    // calls are short; 4 concurrent is far under the width that would pressure the account on
    // long builds.
    const ROUTE_PARALLEL = 4;
    const chunks: ItemRecord[][] = [];
    for (let i = 0; i < toRoute.length; i += ROUTE_PARALLEL) chunks.push(toRoute.slice(i, i + ROUTE_PARALLEL));

    const routeOne = async (rec: ItemRecord): Promise<ReturnType<typeof makeEvent>[]> => {
      const out: ReturnType<typeof makeEvent>[] = [];
      // TRUST-HARDENING (defect c): resolve the provider for THIS item's own sensitivity,
      // fail-closed. The beat's global `provider` was resolved once against a hardcoded 'internal';
      // routing a 'private' item through it would send the item's text + attachments to whatever
      // the internal chain resolves to (an external provider by default) — the exact end-to-end
      // hole. Here we re-resolve against the item's tier (unknown/garbage → 'private' via
      // normalizeSensitivity, the most restrictive). When no provider is allowed+healthy for the
      // item's tier, we SKIP it this beat rather than route it through a disallowed provider (it is
      // re-attempted next beat once a compliant provider is healthy — same wait-or-park contract as
      // the doc). The registry is absent only on the injected-provider test path, where the caller's
      // single provider is used as before (all fixtures are default-'internal' items).
      const itemSensitivity = normalizeSensitivity(rec.sensitivity ?? 'internal');
      let itemProvider: LlmProvider | null = provider;
      if (providerRegistry) {
        itemProvider = providerRegistry.resolveWithHealth(itemSensitivity, { requireTools: !degraded });
        if (!itemProvider && !degraded) {
          // No tool-capable provider for this tier — try tool-less (degraded), still tier-scoped.
          itemProvider = providerRegistry.resolveWithHealth(itemSensitivity, { requireTools: false });
        }
      }
      if (!itemProvider) {
        // Fail-closed: no allowed+healthy provider for this item's sensitivity. Leave it 'captured'
        // (no events) — a later beat retries once a compliant provider recovers; it is NEVER routed
        // through a provider disallowed for its tier.
        process.stderr.write(
          `[reactor] route: ${rec.id} sensitivity=${itemSensitivity} — no allowed+healthy provider, skipping (fail-closed)\n`,
        );
        return out;
      }

      // Build a focused routing prompt for this item
      const attachPaths = resolveAttachmentPaths(rec.sourceText);
      const attachSection = attachPaths.length > 0
        ? `\n\nATTACHMENTS (operator uploaded — you MAY Read these image/file paths before classifying):\n${attachPaths.map(p => `- ${p}`).join('\n')}`
        : '';
      // A spec-less 'queued' item that the operator unparked is an APPROVED decision-park: the
      // operator already answered "yes, do this". Bias it to build — never re-park it for
      // the same decision (that would loop). The one exception is a genuine multi-slice epic that
      // can't be one buildable slice: park it as needs-decomposition so it surfaces for the planner
      // rather than dispatching a too-big build.
      const isApprovedReroute = rec.state === 'queued'
        && (rec.spec ?? '').trim().length === 0
        && !!rec.lastUnparkedAt;
      const approvalSection = isApprovedReroute
        ? `\n\nOPERATOR APPROVED — this item was parked for a decision and the operator has now approved proceeding (unparked). Prefer ROUTE: build with a concrete SPEC + TOUCHES. NEVER re-park it with the same bundled reason — that bounces it straight back onto the operator's desk in an endless loop. You have two — and only two — park escape-hatches, and you MUST pick the one that fits:
 • PURE MULTI-SLICE EPIC (only slicing/sequencing remains — NO unresolved choice) → ROUTE: park, and SPEC MUST begin with "needs planner decomposition: <one line why>". This routes to the planner and leaves the operator's desk.
 • A SPECIFIC unresolved choice the approval did NOT settle (an architecture/scope/design fork) → ROUTE: park, and SPEC MUST begin with "needs decision: <the ONE precise open question>". State that exact question only — do NOT restate the original bundled reason.`
        : '';
      const itemPrompt = `${promptPrefix}${conductorPrompt}\n\nROUTE THIS ITEM ONLY:\nID: ${rec.id}\nTEXT: ${rec.sourceText ?? '(empty)'}${attachSection}${approvalSection}\n\nReturn ONLY the ROUTE:/SPEC:/TOUCHES:/MODEL:/PRIORITY:/REPLY: block described above.`;

      if (opts.dryRun) {
        out.push(makeEvent('reactor', rec.id, 'item.routed', {
          route: 'dry-run',
          reply: 'dry-run: routing not executed',
        }));
        out.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: 'dry-run: routing not executed',
        }));
        return out;
      }

      // Back off a failing item (don't re-send to the LLM every beat). At the cap
      // we park instead of retrying; between failures we wait out the hourly backoff window.
      const failState = readProviderFail(resolveRunDir(opts), rec.id);
      const nowMs = Date.now();
      if (failState && failState.count >= MAX_PROVIDER_FAILURES) {
        out.push(makeEvent('reactor', rec.id, 'gate.parked', { reason: 'provider-fail' }));
        out.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: `routing failed ${failState.count}× (provider unavailable/garbled) — parked for ops; retry the router or re-capture`,
          parkKind: 'ops',
        }));
        clearProviderFail(resolveRunDir(opts), rec.id); // park is terminal for the retry loop; reset the stamp
        return out;
      }
      if (providerFailBackingOff(failState, nowMs)) {
        return out; // within backoff window — try again a later beat, no LLM call, no events
      }

      const result = await itemProvider.run({
        prompt: itemPrompt,
        model: cfg.models.conductor,
        cwd: opts.repoRoot,
        // Read-only tools — omitted in degraded mode (tool-less provider).
        // The reactor owns the ledger writes now (item.queued/parked/routed +
        // msg.out are emitted below from the parsed decision). The router only classifies —
        // it must not edit files or git (that also keeps the 30s beat well under timeout; a
        // routing prompt that reads/writes files can otherwise drive multi-minute timeouts).
        ...(degraded ? {} : { tools: ['Read', 'Grep', 'Glob'] }),
        timeoutMs: 3 * 60 * 1000,
      });

      if (!result.ok) {
        // Provider failure — bump the durable counter (parks at the cap next beat),
        // note it, and leave the item 'captured' for a backed-off retry. No every-beat re-send.
        bumpProviderFail(resolveRunDir(opts), rec.id, nowMs);
        out.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `routing failed: ${result.error} (attempt bumped; backing off)`,
        }));
        return out;
      }

      // Parse the structured routing decision from the reply (deterministic wall).
      const decision = parseRoutingDecision(result.text);

      // A garbled ROUTE (block present, ROUTE not build|park|answer) is a FAILURE to
      // retry, never a silent 'answer' that could answer-and-forget a build request. Treat it exactly
      // like a provider failure (counter + backoff + eventual park), not a route.
      if (!decision.routeValid) {
        bumpProviderFail(resolveRunDir(opts), rec.id, nowMs);
        out.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: 'routing garbled: router returned an unparseable ROUTE — retrying (backing off)',
        }));
        return out;
      }

      // A valid decision — clear any prior failure stamp so the counter reflects consecutive failures only.
      clearProviderFail(resolveRunDir(opts), rec.id);

      // TARGET items: ground the routed Touches against the target repo's REAL tree
      // (deterministic wall post-processing — resolves the target through the same
      // registration rule as the build lanes, then drops prefixes whose top-level segment
      // doesn't exist there). The correction is noted in the operator reply + step detail.
      let reply = decision.reply;
      if (decision.route === 'build' && decision.touches && rec.target) {
        const reg = lookupRegisteredTarget(foldResult.targets, rec);
        const tree = reg ? readTargetTopLevelTree(reg.repoPath) : null;
        if (reg && tree) {
          const grounded = groundTouchesAgainstTree(decision.touches, tree);
          if (grounded.dropped.length > 0) {
            decision.touches = grounded.touches;
            reply = `${reply}\n(Touches grounded against target '${reg.name}': dropped ${grounded.dropped.join(', ')} — not present in the target tree)`;
            touchesCorrections.push(`${rec.id} dropped ${grounded.dropped.join(', ')}`);
          }
        }
      }

      // Emit the state-transition event FIRST (queued/parked), THEN item.routed as
      // metadata — the fold guards item.routed from regressing an already-queued/parked
      // item back to 'routed', so ordering matters here.
      if (decision.route === 'build') {
        const queuedData: ItemQueuedData = { spec: decision.spec ?? (rec.sourceText ?? '') };
        if (decision.touches) queuedData.touches = decision.touches;
        if (decision.model) queuedData.model = decision.model;
        if (decision.effort) queuedData.effort = decision.effort;
        if (decision.priority) queuedData.priority = decision.priority;
        // Carry the router-assigned lane onto the queued item (default engineering).
        queuedData.lane = decision.lane;
        out.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
      } else if (decision.route === 'park') {
        // The conductor prompt defines park = "needs an operator decision/steer" (costly-and-irreversible
        // OR ambiguous). Every conductor park is a decision park, counted by the SLO probe.
        //
        // Do NOT bounce an already-approved item back onto the operator's needs-you desk.
        // When the operator unparks (approves) an item and the classifier STILL can't build it, the
        // park is one of two kinds, and only one is an operator decision:
        //   • "needs planner decomposition: …" → a pure slicing job for the planner lane. Tag it
        //     parkKind:'decomposition' so it leaves the operator's desk (the desk filter shows only
        //     'decision'); the operator already approved — re-asking them would bounce the approval.
        //   • "needs decision: …" → the approval did NOT settle a specific open architecture/scope
        //     choice. Stays parkKind:'decision' (on the desk) — but the directive forces a sharper
        //     single question, never the same bundled reason that looked like a bounce.
        const parkSpec = decision.spec ?? decision.reply;
        const isDecomp = isApprovedReroute && /^\s*needs planner decomposition/i.test(parkSpec);
        // A FRESH decomposition classification needs the same
        // planning child stepDecompositionUnpark queues for an already-tagged park — otherwise
        // this reroute strands the operator's approval with no child ever queued (the desk
        // filter hides the re-park, and no future unpark fires to trigger one). Emit the
        // child BEFORE the epic's re-park so it never rests off-desk with nothing tracking it.
        if (isDecomp) {
          const reason = parkSpec.replace(/^\s*needs planner decomposition:\s*/i, '').trim() || rec.id;
          out.push(...maybeEmitDecompositionChild(rec.id, reason));
        }
        // A park whose reason names a dependency on another in-flight item (e.g.
        // "depends on WI-359") is a wait, not an open question about WHAT to build — the build
        // is already event-modeled in the operator's own capture text. Store it verbatim
        // (transcribe, never invent) so a later approve can re-verify the dependency and queue
        // deterministically, skipping a second routing LLM call.
        const dep = !isDecomp ? parseDependencyReason(parkSpec) : null;
        const storedSpec = dep && (rec.sourceText ?? '').trim() ? rec.sourceText : undefined;
        out.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: parkSpec,
          parkKind: isDecomp ? 'decomposition' : 'decision',
          ...(storedSpec ? { storedSpec } : {}),
        }));
      }

      // The reply is durable as item.routed.reply + a msg.out event, rendered from the
      // fold — threads render from the fold directly, so there is no external message-file
      // seam to mirror writes into.
      // Record provider+model so degraded routings are attributable.
      out.push(makeEvent('reactor', rec.id, 'item.routed', {
        route: decision.route,
        reply: reply.slice(0, 2000),
        provider: itemProvider.name,
        model: cfg.models.conductor,
        // The lane rides item.routed for every route class (build/park/answer).
        lane: decision.lane,
        // Router-stamped short title, when the model gave one.
        ...(decision.title ? { title: decision.title } : {}),
        ...(degraded ? { degraded: true } : {}),
      }));
      out.push(makeEvent('reactor', rec.id, 'msg.out', {
        text: reply.slice(0, 2000),
      }));

      // Write cost.usage to ops ledger
      if (result.usage) {
        out.push(makeEvent('reactor', rec.id, 'cost.usage', {
          provider: itemProvider.name,
          loop: 'reactor',
          tokens: result.usage.out,
          usd: result.usage.usd,
        }));
      }
      return out;
    };

    for (const chunk of chunks) {
      const results = await Promise.all(chunk.map((rec) => routeOne(rec).catch(() => [])));
      for (const r of results) events.push(...r);
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
      if (events.some((e) => e.type === 'item.queued')) (opts.kickDispatch ?? kickDispatch)(cfg.dispatchKickLabel);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: `routed ${toRoute.length} items`
        + (touchesCorrections.length > 0 ? `; grounded touches: ${touchesCorrections.join('; ')}` : ''),
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

/**
 * Step (b1.5): engage operator replies on work-item threads.
 *
 * Walks the fold's `projectEngagement().unanswered` work-list (post-baseline operator msg.in with
 * no outcome referencing them) and, per reply, runs the engagement prompt with the item's context
 * (state + current spec + capped trail tail) → parses ONE typed outcome → appends exactly the
 * events that outcome implies, EVERY branch carrying `inReplyTo` so the reply is deduped and never
 * re-engaged:
 *   answer  → msg.out{inReplyTo}
 *   steer   → item.respec{inReplyTo} + item.queued (re-queue) + msg.out{inReplyTo}
 *   verdict → msg.out{inReplyTo, proposal:true}  — PROPOSES accept/reject; operator confirms via the
 *             exact console verb pattern. The LLM never emits item.accepted/rejected.
 *   unpark  → msg.out{inReplyTo, proposal:true}  — PROPOSES approve; operator confirms deterministically.
 *   sibling → item.captured{convRef?, parentItem, inReplyTo} (new WI) + msg.out{inReplyTo}
 *   unparseable → item.parked{parkKind:'ops'} (health lane) + msg.out{inReplyTo} — never a guessed verb.
 *
 * Steering a finished/in-flight item (merged/accepted/done/rejected/building/gated) can't safely
 * regress it, so such a steer is downgraded to a sibling capture (scope drift → sibling, never spec
 * bloat). A provider failure leaves the reply UNANSWERED (no outcome emitted) → re-picked next beat.
 */
async function stepEngageReplies(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
  provider: LlmProvider | null,
  providerRegistry?: ReturnType<typeof makeRegistry> | null,
): Promise<StepResult> {
  const step = 'engage';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const { baselineTs, unanswered } = projectEngagement(allEvents);
    if (baselineTs === undefined) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'no engagement.baseline — engagement dormant' };
    }
    if (unanswered.length === 0) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'no unanswered replies' };
    }
    if (!provider) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: `${unanswered.length} replies awaiting engagement — no provider (zero-LLM beat)` };
    }

    const promptPath = join(opts.repoRoot, cfg.promptsDir, 'engagement.md');
    let basePrompt: string;
    try {
      basePrompt = readFileSync(promptPath, 'utf8');
    } catch {
      return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: `engagement prompt missing: ${promptPath}` };
    }

    const foldResult = fold(allEvents);
    // Beat-local WI allocator for sibling spawns. Seeded from the fold (which already reflects any
    // WIs stepRoute allocated earlier this beat, since that step appended before this one loaded),
    // extended synchronously per alloc so sequential engagements never collide on a number.
    let nextWiNum = foldResult.maxWiNum;
    const allocWi = (): string => {
      nextWiNum += 1;
      return `WI-${String(nextWiNum).padStart(3, '0')}`;
    };

    const batch = unanswered.slice(0, ENGAGE_PER_BEAT);
    const events: ReturnType<typeof makeEvent>[] = [];

    const engageOne = async (reply: UnansweredReply): Promise<LedgerEvent[]> => {
      const out: LedgerEvent[] = [];
      const irt = reply.evId;
      const rec = foldResult.items.get(reply.item);

      if (opts.dryRun) {
        out.push(makeEvent('reactor', reply.item, 'msg.out', { text: 'dry-run: engagement not executed', inReplyTo: irt }));
        return out;
      }

      const trailTail = (rec?.messages ?? [])
        .slice(-ENGAGE_TRAIL_TAIL)
        .map(m => `${m.direction === 'in' ? 'OPERATOR' : 'AGENT'}: ${m.text}`)
        .join('\n');
      const specSection = rec?.spec ? `\nSPEC (current):\n${rec.spec}` : '';
      const stateSection = rec ? `\nITEM STATE: ${rec.state}` : '';
      const itemPrompt = `${basePrompt}\n\nENGAGE THIS REPLY ON ${reply.item}:${stateSection}${specSection}\n\nRECENT THREAD (most recent last):\n${trailTail || '(no prior messages)'}\n\nOPERATOR'S NEW REPLY:\n${reply.text}\n\nReturn ONLY the OUTCOME:/REPLY:/SPEC:/VERDICT: block described above.`;

      // Cap the engagement provider-failure retry (mirrors stepRoute). Keyed under
      // an 'engage:' namespace so it never collides with routing's counter for the same item id.
      const failKey = `engage:${reply.item}`;
      const failState = readProviderFail(resolveRunDir(opts), failKey);
      const nowMs = Date.now();
      if (failState && failState.count >= MAX_PROVIDER_FAILURES) {
        // At the cap: stop re-engaging every beat. Skip with ONE ops note (dedup: only when the
        // reply isn't already trailed as skipped) and answer the reply so it stops re-picking —
        // an inReplyTo msg.out marks it handled without guessing a verb.
        const already = (rec?.messages ?? []).some(m =>
          m.direction === 'out' && m.text.includes('engagement skipped (provider unavailable'));
        if (!already) {
          out.push(makeEvent('reactor', reply.item, 'msg.out', {
            text: `engagement skipped (provider unavailable ${failState.count}×) — reply not auto-handled; ops will re-run the engagement or the operator can re-send.`,
            inReplyTo: irt,
          }));
        }
        clearProviderFail(resolveRunDir(opts), failKey);
        return out;
      }
      if (providerFailBackingOff(failState, nowMs)) {
        return out; // within backoff window — retry a later beat, no LLM call
      }

      // TRUST-HARDENING (defect: sensitivity bypass): resolve the provider for THIS reply's item
      // by its own sensitivity, fail-closed. The engagement prompt carries the item's spec + the
      // operator thread; routing a private-only item through the beat-global `internal` provider
      // would leak it. An unknown item (fold miss) is treated as 'private' — the most restrictive.
      // No allowed+healthy provider for the tier ⇒ leave the reply UNANSWERED (re-picked next beat),
      // never routed through a disallowed provider. No registry (test path) ⇒ beat provider unchanged.
      const replySensitivity = rec ? itemSensitivity(rec) : 'private';
      const replyProvider = resolveProviderForSensitivity(providerRegistry ?? null, provider, replySensitivity, { requireTools: true });
      if (!replyProvider) {
        process.stderr.write(
          `[reactor] engage: ${reply.item} sensitivity=${replySensitivity} — no allowed+healthy provider, leaving unanswered (fail-closed)\n`,
        );
        return out;
      }

      const result = await replyProvider.run({
        prompt: itemPrompt,
        model: cfg.models.conductor,
        cwd: opts.repoRoot,
        tools: ['Read', 'Grep', 'Glob'],
        timeoutMs: 3 * 60 * 1000,
      });

      // Provider failure → bump the durable counter (parks the retry at the cap),
      // leave the reply UNANSWERED for a backed-off re-pick. No every-beat re-send storm.
      if (!result.ok) {
        bumpProviderFail(resolveRunDir(opts), failKey, nowMs);
        return out;
      }
      // Success — clear the failure stamp (consecutive-failure semantics).
      clearProviderFail(resolveRunDir(opts), failKey);

      const outcome = parseEngagementOutcome(result.text);

      // Steering finished/in-flight work can't safely regress the item — downgrade to a sibling
      // (scope drift → sibling item, never in-place spec bloat / a double-dispatch of a live build).
      // In-place steer stays legal only for pre-build / parked states.
      const steerInPlaceOk = rec
        && (rec.state === 'captured' || rec.state === 'routed' || rec.state === 'queued' || rec.state === 'parked');
      let kind: EngagementKind = outcome.kind;
      if (kind === 'steer' && !steerInPlaceOk) kind = rec ? 'sibling' : 'answer';

      switch (kind) {
        case 'answer':
          out.push(makeEvent('reactor', reply.item, 'msg.out', { text: outcome.reply.slice(0, 2000), inReplyTo: irt }));
          break;

        case 'steer': {
          const spec = outcome.spec!;
          out.push(makeEvent('reactor', reply.item, 'item.respec', { spec, reason: `operator steer (reply ${irt})`, inReplyTo: irt }));
          const qd: ItemQueuedData = { spec };
          if (rec?.touches) qd.touches = rec.touches;
          if (rec?.model) qd.model = rec.model;
          if (rec?.effort) qd.effort = rec.effort;
          if (rec?.lane) qd.lane = rec.lane;
          out.push(makeEvent('reactor', reply.item, 'item.queued', qd));
          out.push(makeEvent('reactor', reply.item, 'msg.out', { text: outcome.reply.slice(0, 2000), inReplyTo: irt }));
          break;
        }

        case 'verdict':
          out.push(makeEvent('reactor', reply.item, 'msg.out', {
            text: `${outcome.reply.slice(0, 1800)}\n\n(Proposed: ${outcome.verdict}. This is a recommendation — I won't accept or reject on my own. To apply it, reply with the exact confirm: "✅ accept ${reply.item}" to accept, or "✔ resolve ${reply.item}" to dismiss.)`,
            inReplyTo: irt,
            proposal: true,
          }));
          break;

        case 'unpark':
          out.push(makeEvent('reactor', reply.item, 'msg.out', {
            text: `${outcome.reply.slice(0, 1800)}\n\n(Proposed: unpark and proceed. I won't approve on my own. To apply it, reply with the exact confirm: "▶ parked ${reply.item}: approve" to approve, or "▶ parked ${reply.item}: decline" to decline.)`,
            inReplyTo: irt,
            proposal: true,
          }));
          break;

        case 'sibling': {
          const childId = allocWi();
          // convRef (born-from CONV) is wired in S1 with the CONV entity; a sibling here carries
          // only its parentItem + causation.
          const capture: Record<string, unknown> = {
            source: `sibling:${reply.item}`,
            text: outcome.spec ?? outcome.reply,
            parentItem: reply.item,
            inReplyTo: irt,
          };
          out.push(makeEvent('reactor', childId, 'item.captured', capture as never));
          out.push(makeEvent('reactor', reply.item, 'msg.out', {
            text: `${outcome.reply.slice(0, 1800)}\n\n(Spun this off as ${childId} so it stays separate from ${reply.item}.)`,
            inReplyTo: irt,
          }));
          break;
        }

        case 'unparseable':
        default:
          // Park for the ops health lane, never guess a verb. The msg.out{inReplyTo}
          // dedupes the reply so the same unparseable output is not re-engaged every beat.
          out.push(makeEvent('reactor', reply.item, 'item.parked', {
            reason: `engagement-parser: could not classify the operator reply on ${reply.item}`,
            parkKind: 'ops',
          }));
          out.push(makeEvent('reactor', reply.item, 'msg.out', {
            text: `I couldn't confidently interpret that reply, so I flagged it for the ops health lane rather than guess. Could you restate what you'd like done on ${reply.item}?`,
            inReplyTo: irt,
          }));
          break;
      }

      if (result.usage) {
        out.push(makeEvent('reactor', reply.item, 'cost.usage', {
          provider: provider!.name,
          loop: 'reactor',
          tokens: result.usage.out,
          usd: result.usage.usd,
        }));
      }
      return out;
    };

    // Sequential — bounds the beat and keeps sibling WI allocation race-free.
    for (const reply of batch) {
      const r = await engageOne(reply).catch(() => [] as LedgerEvent[]);
      events.push(...r);
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
      if (events.some((e) => e.type === 'item.queued')) (opts.kickDispatch ?? kickDispatch)(cfg.dispatchKickLabel);
    }

    const deferred = unanswered.length - batch.length;
    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: `engaged ${batch.length} reply(ies)${deferred > 0 ? ` (+${deferred} deferred to next beat)` : ''}`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (b1.8): bounded auto-requeue of no-commit ops-parks
// ---------------------------------------------------------------------------

/**
 * No-commit ops-parks (dispatch.ts: worker produced no commit, or left the worktree dirty/
 * on the wrong branch) are the plane's own mechanical failure class — they should auto-requeue
 * under the normal breaker cap like the doctor's orphan/stall reap and the merge-gate red
 * requeue, never sit parked waiting on the operator. Without this step they would have no
 * requeue path at all: nothing would ever re-pick them, so they'd sit parked indefinitely with
 * attempts=1. Runs before stepAutoApprove — a freshly requeued item is 'queued', not 'parked',
 * so the auto-approve scan (which explicitly skips parkKind 'ops') never sees it either way;
 * ordering just keeps this ops-only lane visibly separate from the operator-approval lane below.
 */
async function stepUnparkOpsRequeue(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'unpark-ops-requeue';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    const events: ReturnType<typeof makeEvent>[] = [];
    let requeued = 0;
    for (const rec of foldResult.items.values()) {
      if (!shouldRequeueOpsPark(rec, cfg.breakerN)) continue;
      const queuedData: ItemQueuedData = {
        spec: rec.spec ?? '',
        repairContext: `Transient ops-park requeued (attempt ${rec.attempts}/${cfg.breakerN}): ${rec.parkReason ?? 'ops-park'}`,
      };
      if (rec.touches) queuedData.touches = rec.touches;
      if (rec.model) queuedData.model = rec.model;
      if (rec.effort) queuedData.effort = rec.effort;
      if (rec.priority) queuedData.priority = rec.priority;
      events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
      requeued++;
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
      (opts.kickDispatch ?? kickDispatch)(cfg.dispatchKickLabel);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: requeued === 0 ? 'no transient ops-parks to requeue' : `requeued ${requeued} transient ops-park(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (b1.9): WI-084 the park pathologist
// ---------------------------------------------------------------------------

/**
 * Park kinds the pathologist NEVER diagnoses — 'decision' is an operator question, not a
 * plane failure (the pathologist only handles FAILURE parks: gate-red/crash/infra), and
 * 'decomposition' is the planner lane (re-diagnosing an already-approved epic split is a
 * bounce, exactly the same reasoning stepAutoApprove already applies for parkKind:'ops').
 */
const PATHOLOGY_EXCLUDED_PARK_KINDS = new Set<string | undefined>(['decision', 'decomposition']);

/**
 * On every FAILURE park (gate-red / crash / infra — NEVER parkKind:'decision'), spawn ONE
 * bounded read-only LLM diagnosis pass, get a structured verdict, then act by classification:
 *   - transient-infra   → bounded auto-requeue (rides the EXISTING breaker cap).
 *   - plane-infra-bug   → auto-capture a repair WI (engineering lane) + block the victim on it;
 *                         when the blocker merges, auto-requeue the victim.
 *   - items-own-code    → requeue ONCE with the diagnosis injected (repairContext); a SECOND
 *                         own-code failure parks for review (parkKind:'decision') with the
 *                         diagnosis attached as an EscalationPayload.
 * FAIL-OPEN: provider absent/erroring/unparseable → skip note, park stands EXACTLY as today.
 * Every action (including a skip) appends a msg.out 'pathology: ' note so existing thread/desk
 * surfaces show it with zero UI changes (no packages/opsui or packages/console touch).
 *
 * WI-099 — blocked-victim wait-timeout: a victim's blocker can be rejected or itself parked
 * instead of merging, in which case the release loop below is a permanent no-op and the victim
 * sits blocked with no signal (silently off the needs-you desk, per the parkKind decision/ops
 * taxonomy — see docs/event-model.md). Once a victim has been parked longer than
 * cfg.pathology.blockedWaitTimeoutHours AND its blocker has still not merged, re-park the
 * victim as parkKind:'decision' carrying the original blockedOn diagnosis as an
 * EscalationPayload, so it surfaces on the operator desk instead of staying silently parked.
 */
async function stepPathology(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
  provider: LlmProvider | null,
  providerRegistry?: ReturnType<typeof makeRegistry> | null,
): Promise<StepResult> {
  const step = 'pathology';
  try {
    if (!cfg.pathology?.enabled) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'pathology disabled' };
    }

    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    const events: LedgerEvent[] = [];
    let released = 0;
    let diagnosed = 0;
    let skipped = 0;

    // FIRST: blocked-victim RELEASE (no provider needed, cheap, always runs). A victim blocked
    // on a repair WI (item.blocked.onItem) is released the moment that repair item merges —
    // requeue clears blockedOn via the fold's item.queued case.
    //
    // WI-099: when the blocker is NOT merged (rejected / re-parked / still building), leaving
    // the victim parked forever used to be a silent no-op. Instead, once the victim has been
    // parked past blockedWaitTimeoutHours, re-park it as parkKind:'decision' so it reaches the
    // operator desk with the original blocked-on diagnosis attached.
    const blockedWaitTimeoutMs =
      (cfg.pathology.blockedWaitTimeoutHours ?? 24) * 60 * 60 * 1000;
    const nowMs = opts.now ?? Date.now();
    for (const rec of foldResult.items.values()) {
      if (rec.state !== 'parked' || !rec.blockedOn) continue;
      // WI-099: the wait-timeout re-park below sets parkKind:'decision' but (like every
      // item.parked event, see fold.ts) leaves blockedOn in place as a forensic breadcrumb —
      // only item.queued clears it. Once this item has already been escalated to the decision
      // desk, it belongs to the operator, not to this release loop: skip it so a later blocker
      // merge cannot silently auto-requeue past the operator's park, and so the timeout check
      // below cannot re-fire the escalation on every subsequent beat.
      if (rec.parkKind === 'decision') continue;
      const blockerId = rec.blockedOn;
      const blocker = foldResult.items.get(blockerId);
      if (blocker && blocker.state === 'merged') {
        const queuedData: ItemQueuedData = {
          spec: rec.spec ?? '',
          repairContext: `blocker ${blockerId} merged — auto-requeued (pathology)`,
        };
        if (rec.touches) queuedData.touches = rec.touches;
        if (rec.model) queuedData.model = rec.model;
        if (rec.effort) queuedData.effort = rec.effort;
        if (rec.priority) queuedData.priority = rec.priority;
        events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `pathology: blocker ${blockerId} merged, requeuing.`,
        }));
        released++;
        continue;
      }

      // Blocker hasn't merged yet — still building is fine, no timeout applies until the
      // parked-since age crosses the threshold below.
      const parkedAtMs = rec.parkedAt ? Date.parse(rec.parkedAt) : NaN;
      if (!Number.isFinite(parkedAtMs) || nowMs - parkedAtMs < blockedWaitTimeoutMs) continue;

      const blockerState = blocker?.state ?? 'unknown (gone from the ledger)';
      events.push(makeEvent('reactor', rec.id, 'item.parked', {
        reason: `blocked-victim wait-timeout: blocker ${blockerId} has not merged (state: ${blockerState}) after ${cfg.pathology.blockedWaitTimeoutHours ?? 24}h`,
        parkKind: 'decision',
        escalation: {
          intent: `Decide how to unblock this item — its repair WI ${blockerId} did not merge within the wait window.`,
          evidence: `Blocked since ${rec.parkedAt ?? 'unknown'} on ${blockerId}, currently ${blockerState}.`,
          risk: 'This item has been silently stuck behind a repair that will never release it automatically.',
          recommendation: `Check ${blockerId}: if it was rejected or parked, either fix/re-approve it, or reject/requeue this victim directly.`,
        },
      }));
      events.push(makeEvent('reactor', rec.id, 'msg.out', {
        text: `pathology: blocked-victim wait-timeout — ${blockerId} has not merged (state: ${blockerState}); re-parked for review with the original diagnosis.`,
      }));
    }

    // SECOND: diagnose fresh failure parks — dedup on parkFingerprint, never re-diagnose a
    // decision/decomposition park, never re-enter a park already handled by the release above.
    const candidates = [...foldResult.items.values()].filter((rec) =>
      rec.state === 'parked'
      && !PATHOLOGY_EXCLUDED_PARK_KINDS.has(rec.parkKind)
      && !rec.blockedOn
      && rec.parkFingerprint !== undefined
      && rec.parkFingerprint !== rec.lastDiagnosedFingerprint,
    );

    if (candidates.length === 0) {
      if (!opts.dryRun && events.length > 0) {
        await appendEvents(opts.ledgerDir, events);
        if (events.some((e) => e.type === 'item.queued')) (opts.kickDispatch ?? kickDispatch)(cfg.dispatchKickLabel);
      }
      return {
        step,
        ok: true,
        eventsWritten: events.length,
        mdWritten: false,
        detail: released === 0 ? 'no failure parks to diagnose' : `released ${released} blocked victim(s)`,
      };
    }

    if (opts.dryRun) {
      return {
        step,
        ok: true,
        eventsWritten: 0,
        mdWritten: false,
        detail: `dry-run: would diagnose ${candidates.length} park(s), release ${released} blocked victim(s)`,
      };
    }

    // Provider absent → every candidate gets a recorded skip (visible, never silent) and the
    // park stands unchanged. This is the "provider absent → park stands, skip note" path.
    if (!provider) {
      for (const rec of candidates) {
        events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
          parkFingerprint: rec.parkFingerprint!,
          classification: 'unavailable',
          evidence: [],
          proposedAction: '',
          actedAs: 'skipped',
          model: '',
          reason: 'no provider',
        }));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: 'pathology: skipped — no diagnosis provider available; park stands.',
        }));
        skipped++;
      }
      await appendEvents(opts.ledgerDir, events);
      return {
        step,
        ok: true,
        eventsWritten: events.length,
        mdWritten: false,
        detail: `skipped ${skipped} diagnosis(es) — no provider; released ${released} blocked victim(s)`,
      };
    }

    const model = cfg.pathology.model ?? 'opus';
    const timeoutMs = cfg.pathology.timeoutMs ?? 180_000;
    const maxTrailEvents = cfg.pathology.maxTrailEvents ?? 15;
    const maxDiffChars = cfg.pathology.maxDiffChars ?? 12_000;

    // WI id allocator for repair items — mirrors stepArmed exactly: fold once, then increment a
    // LOCAL counter per allocation (nextWiId always reads maxWiNum+1, so calling it twice would
    // collide). Provider calls happen first (slow, no ledger state needed beyond this snapshot
    // fold); the repair-id allocation + append happen inside withLock below (contract-approved
    // v1 simplification: a longer critical section is fine here — low frequency, dedup-bounded).
    for (const rec of candidates) {
      // TRUST-HARDENING (defect: sensitivity bypass): resolve the diagnosis provider for THIS item
      // by its own sensitivity, fail-closed. The pathology prompt carries the item's failure trail
      // AND its worktree diff; routing a private-only item through the beat-global `internal`
      // provider would leak its source. No allowed+healthy provider for the tier ⇒ record a visible
      // skip (park stands, exactly like the provider-absent path) rather than route to a disallowed
      // provider. No registry (injected-provider test path) ⇒ the beat provider is used unchanged.
      const itemProvider = resolveProviderForSensitivity(providerRegistry ?? null, provider, itemSensitivity(rec), { requireTools: false });
      if (!itemProvider) {
        events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
          parkFingerprint: rec.parkFingerprint!,
          classification: 'unavailable',
          evidence: [],
          proposedAction: '',
          actedAs: 'skipped',
          model: '',
          reason: `sensitivity(${itemSensitivity(rec)}): no allowed+healthy provider — fail-closed`,
        }));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: 'pathology: skipped — no diagnosis provider allowed for this item\'s sensitivity; park stands.',
        }));
        skipped++;
        continue;
      }

      const itemEvents = allEvents.filter((ev) => ev.item === rec.id) as TrailEvent[];
      const eventTrail = formatEventTrail(itemEvents, maxTrailEvents);
      const lastBuild = rec.currentBuild ?? rec.builds[rec.builds.length - 1];
      const gateCrashTail = lastBuild?.stderrTail ?? rec.parkReason ?? '';
      const wt = lastBuild?.worktree;
      // Best-effort diff — captureWorktreeDiff returns '' on ANY git error (wrong base, missing
      // worktree, etc), so a wrong mergeBase or gone worktree degrades to empty context, never a
      // crash. Not worth perfect mergeBase resolution (contract ADDENDUM) — 'main' is the plane
      // default; empty diff is a legitimate, common input the prompt already handles.
      const diff = wt ? captureWorktreeDiff(wt, 'main', maxDiffChars) : '';

      const prompt = buildPathologyPrompt(rec.id, rec.parkReason ?? '', rec.parkKind, eventTrail, gateCrashTail, diff);
      const res = await runPathology(itemProvider, model, prompt, timeoutMs);

      if (res.usage) {
        events.push(makeEvent('reactor', rec.id, 'cost.usage', {
          provider: itemProvider.name,
          loop: 'pathology',
          tokens: res.usage.in + res.usage.out,
          usd: res.usage.usd,
          wi: rec.id,
          turns: res.usage.turns,
          durationMs: res.usage.durationMs,
        }));
      }

      if (res.parsed === null || res.parsed.classification === 'unparseable') {
        events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
          parkFingerprint: rec.parkFingerprint!,
          classification: 'unavailable',
          evidence: [],
          proposedAction: '',
          actedAs: 'skipped',
          model,
          reason: res.providerError ?? 'unparseable',
        }));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `pathology: skipped — ${res.providerError ?? 'unparseable diagnosis output'}; park stands.`,
        }));
        skipped++;
        continue;
      }

      const parsed = res.parsed;
      diagnosed++;

      if (parsed.classification === 'transient-infra') {
        if (rec.attempts >= cfg.breakerN) {
          events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
            parkFingerprint: rec.parkFingerprint!,
            classification: 'transient-infra',
            evidence: parsed.evidence,
            proposedAction: parsed.proposedAction,
            actedAs: 'parked-review',
            model,
          }));
          events.push(makeEvent('reactor', rec.id, 'msg.out', {
            text: `pathology: transient but breaker exhausted (${rec.attempts}/${cfg.breakerN}) — parking for review. ${parsed.proposedAction}`,
          }));
          events.push(makeEvent('reactor', rec.id, 'item.parked', {
            reason: rec.parkReason ?? 'transient-infra, breaker exhausted',
            parkKind: 'decision',
            escalation: {
              intent: 'Requeue once the underlying transient condition clears.',
              evidence: parsed.evidence.join('; ') || '(none cited)',
              risk: 'The breaker is exhausted; another auto-requeue would exceed the cap.',
              recommendation: parsed.proposedAction || 'Re-run manually or unpark once the infra issue is confirmed resolved.',
            },
          }));
        } else {
          const queuedData: ItemQueuedData = {
            spec: rec.spec ?? '',
            repairContext: `pathology(transient-infra): ${parsed.proposedAction}`,
          };
          if (rec.touches) queuedData.touches = rec.touches;
          if (rec.model) queuedData.model = rec.model;
          if (rec.effort) queuedData.effort = rec.effort;
          if (rec.priority) queuedData.priority = rec.priority;
          events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
          events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
            parkFingerprint: rec.parkFingerprint!,
            classification: 'transient-infra',
            evidence: parsed.evidence,
            proposedAction: parsed.proposedAction,
            actedAs: 'requeued-transient',
            model,
          }));
          events.push(makeEvent('reactor', rec.id, 'msg.out', {
            text: `pathology: transient-infra — auto-requeued (attempt ${rec.attempts + 1}/${cfg.breakerN}). ${parsed.proposedAction}`,
          }));
        }
      } else if (parsed.classification === 'plane-infra-bug') {
        // Repair-WI allocation under lock — mirrors stepArmed exactly (fresh fold + local
        // counter, so multiple candidates in the same beat never collide on a WI number).
        let repairWiId = '';
        await withLock(opts.ledgerDir, async (tx) => {
          const lockEvents = await tx.loadAll();
          const lockResult = fold(lockEvents);
          const nextNum = lockResult.maxWiNum + 1;
          repairWiId = `WI-${String(nextNum).padStart(3, '0')}`;
          const evidenceList = parsed.evidence.length > 0 ? parsed.evidence.join('\n- ') : '(no evidence cited)';
          await tx.append([
            makeEvent('reactor', repairWiId, 'item.captured', {
              source: 'reactor:pathology',
              text: `Plane infra bug blocking ${rec.id}: \n- ${evidenceList}\nProposed: ${parsed.proposedAction}`,
              lane: 'engineering',
            }),
          ]);
        });
        events.push(makeEvent('reactor', rec.id, 'item.blocked', {
          onItem: repairWiId,
          reason: 'plane-infra-bug (pathology)',
        }));
        events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
          parkFingerprint: rec.parkFingerprint!,
          classification: 'plane-infra-bug',
          evidence: parsed.evidence,
          proposedAction: parsed.proposedAction,
          actedAs: 'blocked-on-repair',
          model,
          repairItem: repairWiId,
        }));
        events.push(makeEvent('reactor', rec.id, 'msg.out', {
          text: `pathology: plane-infra-bug — captured repair ${repairWiId}, holding this item until it merges.`,
        }));
      } else {
        // items-own-code
        if ((rec.ownCodeFailures ?? 0) >= 1) {
          events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
            parkFingerprint: rec.parkFingerprint!,
            classification: 'items-own-code',
            evidence: parsed.evidence,
            proposedAction: parsed.proposedAction,
            actedAs: 'parked-review',
            model,
          }));
          events.push(makeEvent('reactor', rec.id, 'msg.out', {
            text: `pathology: second own-code failure — parking for review with diagnosis. ${parsed.proposedAction}`,
          }));
          events.push(makeEvent('reactor', rec.id, 'item.parked', {
            reason: rec.parkReason ?? 'items-own-code, second failure',
            parkKind: 'decision',
            escalation: {
              intent: 'Requeue with the diagnosis applied once the operator confirms the fix direction.',
              evidence: parsed.evidence.join('; ') || '(none cited)',
              risk: 'A second own-code failure on the same fingerprint — auto-retry is no longer safe.',
              recommendation: parsed.proposedAction || 'Review the diagnosis and respec or manually fix.',
            },
          }));
        } else {
          const queuedData: ItemQueuedData = {
            spec: rec.spec ?? '',
            repairContext: `pathology(items-own-code): ${parsed.proposedAction}. Evidence: ${parsed.evidence.join('; ')}`,
          };
          if (rec.touches) queuedData.touches = rec.touches;
          if (rec.model) queuedData.model = rec.model;
          if (rec.effort) queuedData.effort = rec.effort;
          if (rec.priority) queuedData.priority = rec.priority;
          events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
          events.push(makeEvent('reactor', rec.id, 'diagnosis.recorded', {
            parkFingerprint: rec.parkFingerprint!,
            classification: 'items-own-code',
            evidence: parsed.evidence,
            proposedAction: parsed.proposedAction,
            actedAs: 'requeued-own-code',
            model,
          }));
          events.push(makeEvent('reactor', rec.id, 'msg.out', {
            text: `pathology: items-own-code — requeued once with the diagnosis injected. ${parsed.proposedAction}`,
          }));
        }
      }
    }

    if (events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
      if (events.some((e) => e.type === 'item.queued')) (opts.kickDispatch ?? kickDispatch)(cfg.dispatchKickLabel);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: `diagnosed ${diagnosed} park(s), skipped ${skipped}, released ${released} blocked victim(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (b2): auto-approve — delegated park classes → item.approved (no operator park)
// ---------------------------------------------------------------------------

/**
 * Delegated approval boundary. Scan parked items whose park class is a
 * delegated one (touches-overstep same-origin, or plane-only spine) and silently approve
 * them with a msg.out trail note — they never reach the needs-you board.
 * The following apply-verbs step (same beat) then gates + merges them like any approval.
 * The hard escalation list (money/external/contracts/authz/migrations) always parks.
 */
async function stepAutoApprove(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'auto-approve';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    const events: ReturnType<typeof makeEvent>[] = [];
    let approved = 0;
    for (const rec of foldResult.items.values()) {
      if (rec.state !== 'parked') continue;
      // Never re-enter an ops-park (belt-and-braces against a parkClass-survival ping-pong; the
      // fold side is guarded separately — this is the reactor-side guard).
      // Ops parks (merge-transient, no-commit, breaker, infra) are the plane's own health lane, not
      // a delegated-approval class; the classifier already returns autoApprove:false for them, but
      // this makes the boundary explicit and cheap.
      if (rec.parkKind === 'ops') continue;
      const decision = classifyParkForAutoApprove(rec, cfg.autoApprove);
      if (!decision.autoApprove) continue;
      // Only auto-approve a park that still has a mergeable branch — otherwise there is
      // nothing for apply-verbs to merge (would immediately re-park on branch-missing).
      const lastBuild = rec.builds[rec.builds.length - 1];
      const branch = rec.currentBuild?.branch ?? lastBuild?.branch;
      if (!branch) continue;

      // Capture the overstep file list at approval time so a later build attempt
      // touching the same paths (or same directory) isn't re-parked (dispatch.ts).
      const approvedTouches = decision.parkClass === 'touches-overstep'
        ? parseOverstepReason(rec.parkReason ?? '')?.files
        : undefined;
      events.push(makeEvent('reactor', rec.id, 'item.approved', {
        by: 'reactor:delegated-approval',
        ...(approvedTouches && approvedTouches.length > 0 ? { approvedTouches } : {}),
      }));
      events.push(makeEvent('reactor', rec.id, 'msg.out', {
        text: `Auto-approved (delegated approval boundary): ${decision.reason}. Merging on green — no operator sign-off needed.`,
      }));
      approved++;
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: approved === 0 ? 'no delegated parks' : `auto-approved ${approved} delegated park(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Target-aware approved merge (step c, for items belonging to a registered target)
// ---------------------------------------------------------------------------

/**
 * Merge an APPROVED item that belongs to a registered target into THAT target's repo —
 * never the plane's own repoRoot. Mirrors the dispatch target lane's shape: resolve the
 * registration through the one shared rule (target.ts resolveRegisteredTarget — no second
 * copy), verify the branch in the target repo, merge in a detached scratch worktree of the
 * target's defaultBranch, run the MANIFEST's gateCommand there (with the manifest's
 * depsWorkdirs provisioned from the target's own checkout), then fast-forward the target's
 * defaultBranch to the gated merge commit. No push and no plane deploy: a target repo
 * advances its own local defaultBranch (like the dispatch target lane) and fires only its
 * own manifest deployCommand. Untargeted items never reach this path — their flow stays
 * byte-identical to before.
 */
function applyApprovedTargetMerge(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
  foldResult: FoldResult,
  rec: ItemRecord,
  branch: string,
  runDir: string,
): { events: ReturnType<typeof makeEvent>[]; merged: boolean } {
  const events: ReturnType<typeof makeEvent>[] = [];

  const resolution = resolveRegisteredTarget(foldResult.targets, rec);
  if (!resolution.ok) {
    const reason = `approved merge: ${resolution.error}`;
    events.push(makeEvent('reactor', rec.id, 'gate.failed', { reason }));
    events.push(makeEvent('reactor', rec.id, 'item.parked', { reason, parkKind: 'ops' }));
    return { events, merged: false };
  }
  const { reg, manifest } = resolution;
  const targetRoot = reg.repoPath;
  // Changed manifest → append target.manifest-updated (append-only, never mutate the
  // registration) and use the new one — same contract as the dispatch build lane.
  if (resolution.manifestChanged) {
    events.push(makeEvent('reactor', reg.name, 'target.manifest-updated', {
      targetId: reg.targetId,
      name: reg.name,
      manifestHash: resolution.manifestHash,
      defaultBranch: manifest.defaultBranch,
    }));
  }

  // Verify the branch exists IN THE TARGET REPO — a same-named branch in the plane's own
  // cwd must never satisfy this check (checking the plane cwd here is what false-negatived
  // finished target builds back into the queue).
  const branchCheck = spawnSync('git', ['rev-parse', '--verify', branch], {
    cwd: targetRoot, stdio: 'pipe',
  });
  if (branchCheck.status !== 0) {
    events.push(makeEvent('reactor', rec.id, 'gate.failed', {
      reason: `approved branch ${branch} no longer exists in target '${reg.name}'`,
    }));
    events.push(makeEvent('reactor', rec.id, 'item.parked', {
      reason: `approved branch ${branch} missing in target '${reg.name}' — rebuild needed`,
      parkKind: 'ops',
    }));
    return { events, merged: false };
  }

  if (opts.dryRun) {
    events.push(makeEvent('reactor', rec.id, 'gate.passed', { tests: 'dry-run (not executed)' }));
    events.push(makeEvent('reactor', rec.id, 'item.merged', { commit: 'dry-run', deployed: false }));
    return { events, merged: true };
  }

  // Base: the target's OWN defaultBranch (never the plane's master). Detach at the SHA so
  // whatever branch the target's primary tree has checked out can never block the merge.
  const baseShaResult = spawnSync('git', ['rev-parse', manifest.defaultBranch], {
    cwd: targetRoot, stdio: 'pipe',
  });
  if (baseShaResult.status !== 0) {
    events.push(...mergeTransientEvents(rec,
      `target default branch '${manifest.defaultBranch}' unresolvable: ${baseShaResult.stderr?.toString().trim() ?? 'unknown'}`));
    return { events, merged: false };
  }
  const baseSha = baseShaResult.stdout.toString().trim();

  // Scratch worktree next to the target repo, namespaced by the opaque targetId so two
  // targets sharing a parent dir + worktreePrefix can never clobber each other's merges.
  const wtPath = join(targetRoot, '..', `${manifest.worktreePrefix}${reg.targetId}-appr-${rec.id.replace('WI-', '')}`);
  spawnSync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: targetRoot, stdio: 'pipe' });
  const wtAdd = spawnSync('git', ['worktree', 'add', '--detach', wtPath, baseSha], {
    cwd: targetRoot, stdio: 'pipe',
  });

  let mergeSha = '';
  // TRUST-HARDENING: real changed-file evidence for the target item.merged event.
  let targetMergeEvidence: Partial<import('../schema.js').ItemMergedData> | undefined;
  try {
    if (wtAdd.status !== 0) {
      events.push(...mergeTransientEvents(rec,
        `target worktree setup failed: ${wtAdd.stderr?.toString().trim() ?? 'unknown'}`));
      return { events, merged: false };
    }

    const mergeResult = spawnSync('git', [
      'merge', '--no-ff', '-m', `feat(reactor): ${rec.id} — approved merge (target ${reg.name})`, branch,
    ], { cwd: wtPath, stdio: 'pipe' });
    if (mergeResult.status !== 0) {
      events.push(makeEvent('reactor', rec.id, 'gate.failed', {
        reason: `merge conflict on approved branch (target '${reg.name}')`,
      }));
      if (rec.repairContext) {
        // Already been through one repair cycle — fall back to park.
        events.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: 'approved merge: conflict (repair attempt also failed) — rebuild needed',
          parkKind: 'ops',
        }));
      } else {
        const conflictOutput = [
          mergeResult.stdout?.toString().trim(),
          mergeResult.stderr?.toString().trim(),
        ].filter(Boolean).join('\n').slice(0, 800);
        const queuedData: ItemQueuedData = {
          spec: rec.spec ?? '',
          repairContext: `Merge conflict integrating '${branch}' into ${manifest.defaultBranch} (target '${reg.name}').\n${conflictOutput}`,
        };
        if (rec.touches) queuedData.touches = rec.touches;
        if (rec.model) queuedData.model = rec.model;
        if (rec.effort) queuedData.effort = rec.effort;
        if (rec.priority) queuedData.priority = rec.priority;
        events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
      }
      return { events, merged: false };
    }

    // Provision node_modules from the TARGET repo's own checkout (manifest.depsWorkdirs) —
    // the deps source is the target's repoPath, never the plane's embedded repo.
    if (manifest.depsWorkdirs.length > 0) {
      const depsSetup = setupWorktreeDeps(targetRoot, wtPath, manifest.depsWorkdirs);
      if (depsSetup.buildFailures.length > 0) {
        events.push(makeEvent('reactor', rec.id, 'gate.failed', {
          reason: `target file:-dep build failed: ${depsSetup.buildFailures.join('; ')}`,
        }));
        events.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: 'approved merge: target file:-dep build failed — rebuild needed',
          parkKind: 'ops',
        }));
        return { events, merged: false };
      }
    }

    // Gate: the TARGET MANIFEST's command, in its gateWorkdir, in the merge worktree.
    const runGate = opts.gateRunner ?? runGateOnce;
    const gateResult = runGate(manifest.gateCommand, manifest.gateWorkdir, wtPath, false, cfg.mergeGateTimeoutMs);
    if (!gateResult.passed) {
      persistMergeGateLog(runDir, rec.id, 1, gateResult.output ?? '');
      if (gateResult.timedOut) {
        // Gate killed at timeout — transient, not a real test failure (same cap as untargeted).
        const newCount = (rec.transientFailCount ?? 0) + 1;
        if (newCount >= MAX_TRANSIENT_TIMEOUT_RETRIES) {
          events.push(makeEvent('reactor', rec.id, 'gate.failed', {
            reason: `merge gate timed out ${newCount}× — parked for investigation (not test-red; investigate beat-load contention)`,
          }));
          events.push(makeEvent('reactor', rec.id, 'item.parked', {
            reason: `merge gate timed out ${newCount}×: not a test failure — investigate beat-load contention`,
            parkKind: 'ops',
          }));
        } else {
          events.push(makeEvent('reactor', rec.id, 'merge.transient-fail', {
            reason: gateResult.reason,
            transientCount: newCount,
          }));
        }
        return { events, merged: false };
      }
      // Real test red — auto-requeue with repair context while the breaker has room.
      events.push(makeEvent('reactor', rec.id, 'gate.failed', {
        reason: `gate red after approved merge: ${gateResult.reason}`,
      }));
      if (rec.attempts >= cfg.breakerN) {
        events.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: `breaker: ${rec.attempts} attempts exhausted — approved merge failed gate`,
          parkKind: 'ops',
        }));
      } else {
        const queuedData: ItemQueuedData = {
          spec: rec.spec ?? '',
          repairContext: `Gate red after approved merge: ${gateResult.reason}`,
        };
        if (rec.touches) queuedData.touches = rec.touches;
        if (rec.model) queuedData.model = rec.model;
        if (rec.effort) queuedData.effort = rec.effort;
        if (rec.priority) queuedData.priority = rec.priority;
        events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
      }
      return { events, merged: false };
    }

    mergeSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath, stdio: 'pipe' })
      .stdout.toString().trim();

    // TRUST-HARDENING: capture the real changed-file list while the merged worktree still exists
    // (torn down in the finally). --no-ff merge ⇒ baseSha is the pre-merge default branch, so the
    // diff over baseSha..HEAD is exactly the approved branch's changes. mergeEvidence caps the list
    // and sets changedFilesTruncated so acceptance tiers from the real diff, not declared touches.
    targetMergeEvidence = mergeEvidence(
      baseSha, mergeSha, getChangedFiles(wtPath, baseSha), manifest.gateCommand);

    // Advance the target's defaultBranch to the exact gated merge commit (shared object
    // store — the commit already exists in the target repo). Fast-forward only: if the
    // branch advanced concurrently, retry next beat rather than landing an ungated tree.
    const checkout = spawnSync('git', ['checkout', manifest.defaultBranch], { cwd: targetRoot, stdio: 'pipe' });
    if (checkout.status !== 0) {
      events.push(...mergeTransientEvents(rec,
        `cannot checkout target default branch '${manifest.defaultBranch}': ${checkout.stderr?.toString().trim() ?? 'unknown'}`));
      return { events, merged: false };
    }
    const ff = spawnSync('git', ['merge', '--ff-only', mergeSha], { cwd: targetRoot, stdio: 'pipe' });
    if (ff.status !== 0) {
      events.push(...mergeTransientEvents(rec,
        `target default branch '${manifest.defaultBranch}' advanced during the gate — retrying: ${ff.stderr?.toString().trim() ?? 'unknown'}`));
      return { events, merged: false };
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: targetRoot, stdio: 'pipe' });
  }

  // Success — clean up the merged branch in the target repo (best-effort).
  spawnSync('git', ['branch', '-D', branch], { cwd: targetRoot, stdio: 'pipe' });

  // Per-target deploy hook only — never the plane's own deployCommand.
  if (manifest.deployCommand) fireDeployOnMerge(targetRoot, manifest.deployCommand, [rec.id]);

  events.push(makeEvent('reactor', rec.id, 'gate.passed', { tests: 'green' }));
  events.push(makeEvent('reactor', rec.id, 'item.merged', {
    commit: mergeSha,
    deployed: !!manifest.deployCommand,
    ...(targetMergeEvidence ?? {}),
  }));
  return { events, merged: true };
}

// ---------------------------------------------------------------------------
// Step (c): apply operator verbs (approved items → gate → merge)
// ---------------------------------------------------------------------------

async function stepApplyVerbs(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'apply-verbs';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    // Find approved items that have a branch to merge
    const approved: ItemRecord[] = [];
    for (const rec of foldResult.items.values()) {
      if (rec.state === 'approved' && rec.currentBuild?.branch) {
        approved.push(rec);
      }
      // Also check builds array for a branch from a gated build
      if (rec.state === 'approved' && !rec.currentBuild?.branch && rec.builds.length > 0) {
        const lastBuild = rec.builds[rec.builds.length - 1];
        if (lastBuild.branch) {
          // Expose the branch via a temporary overlay
          (rec as ItemRecord & { _approvedBranch?: string })._approvedBranch = lastBuild.branch;
          approved.push(rec);
        }
      }
    }

    if (approved.length === 0) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'no approved items' };
    }

    const events: ReturnType<typeof makeEvent>[] = [];
    let mergedThisBeat = false;
    const mergedWiIds: string[] = [];
    let processed = 0;
    const runDir = resolveRunDir(opts);

    for (const rec of approved) {
      const branch = rec.currentBuild?.branch
        ?? (rec as ItemRecord & { _approvedBranch?: string })._approvedBranch;
      if (!branch) continue;

      // An item belonging to a registered target merges into THAT target's repo — branch
      // verification, merge worktree, manifest gate, and defaultBranch all resolved against
      // the target (same resolution rule as the dispatch build lane). Gated on the NAME
      // field exactly like the dispatch lane: a coalesced/attributed targetId alone never
      // flips a legacy item off the plane path.
      if (rec.target) {
        const targetOutcome = applyApprovedTargetMerge(opts, cfg, foldResult, rec, branch, runDir);
        events.push(...targetOutcome.events);
        if (targetOutcome.merged) processed++;
        continue;
      }

      // Verify the branch exists
      const branchCheck = spawnSync('git', ['rev-parse', '--verify', branch], {
        cwd: opts.repoRoot,
        stdio: 'pipe',
      });
      if (branchCheck.status !== 0) {
        events.push(makeEvent('reactor', rec.id, 'gate.failed', {
          reason: `approved branch ${branch} no longer exists`,
        }));
        events.push(makeEvent('reactor', rec.id, 'item.parked', {
          reason: `approved branch ${branch} missing — rebuild needed`,
          parkKind: 'ops',
        }));
        continue;
      }

      if (opts.dryRun) {
        events.push(makeEvent('reactor', rec.id, 'gate.passed', {
          tests: 'dry-run (not executed)',
        }));
        mergedThisBeat = true;
      events.push(makeEvent('reactor', rec.id, 'item.merged', {
          commit: 'dry-run',
          deployed: false,
        }));
        processed++;
        continue;
      }

      // Resolve master's HEAD SHA before creating the worktree.  Detaching at a specific
      // SHA (not the branch name) avoids "branch already checked out" errors regardless of
      // what branch the primary tree is on — a parallel dev session on a feature branch must
      // never block the reactor's approve path.
      const masterShaResult = spawnSync('git', ['rev-parse', 'master'], {
        cwd: opts.repoRoot, stdio: 'pipe',
      });
      if (masterShaResult.status !== 0) {
        // Capped — retries then parks parkKind:'ops' on the Nth failure.
        events.push(...mergeTransientEvents(rec,
          `master ref unresolvable: ${masterShaResult.stderr?.toString().trim() ?? 'unknown'}`));
        continue;
      }
      const masterSha = masterShaResult.stdout.toString().trim();

      // Ledger-merge guard: snapshot the LIVE ledger (repoRoot's working directory — includes
      // whatever this beat and any concurrent dispatch/reactor activity have appended but not
      // yet committed) before the merge below. masterSha above is a commit ref; it can never
      // see this uncommitted tail. After the merge, diff the snapshot against what actually
      // made it into the merged worktree and re-append anything missing — see the check
      // further down, right before the worktree is torn down.
      const preMergeSnapshot = await loadAllEventsWithQuarantine(opts.ledgerDir);

      const wtPath = join(opts.repoRoot, '..', `${cfg.worktreePrefix}appr-${rec.id.replace('WI-', '')}`);

      // Clean up any stale worktree from a previous failed attempt.
      spawnSync('git', ['worktree', 'remove', wtPath, '--force'], {
        cwd: opts.repoRoot, stdio: 'pipe',
      });

      const wtAdd = spawnSync('git', ['worktree', 'add', '--detach', wtPath, masterSha], {
        cwd: opts.repoRoot, stdio: 'pipe',
      });

      let commitSha = '';
      // TRUST-HARDENING: real changed-file evidence for the item.merged event. Captured inside the
      // try (while the merged worktree still exists) and read after the finally teardown. Without
      // it, acceptance would fall back to declared `touches`, defeating "tier from the real diff".
      let approvedMergeEvidence: Partial<import('../schema.js').ItemMergedData> | undefined;

      try {
        if (wtAdd.status !== 0) {
          const why = wtAdd.stderr?.toString().trim() ?? 'unknown';
          // Capped merge transient-fail.
          events.push(...mergeTransientEvents(rec, `worktree setup failed: ${why}`));
          continue;
        }

        // Merge with a real commit in the throwaway worktree — this doubles as the gate
        // test tree and the production commit; no --no-commit+abort dance required.
        const mergeResult = spawnSync('git', [
          'merge', '--no-ff', '-m', `feat(reactor): ${rec.id} — approved merge`, branch,
        ], { cwd: wtPath, stdio: 'pipe' });

        if (mergeResult.status !== 0) {
          events.push(makeEvent('reactor', rec.id, 'gate.failed', {
            reason: 'merge conflict on approved branch',
          }));
          if (rec.repairContext) {
            // Already been through one repair cycle — fall back to park.
            events.push(makeEvent('reactor', rec.id, 'item.parked', {
              reason: 'approved merge: conflict (repair attempt also failed) — rebuild needed',
              parkKind: 'ops',
            }));
          } else {
            const conflictOutput = [
              mergeResult.stdout?.toString().trim(),
              mergeResult.stderr?.toString().trim(),
            ].filter(Boolean).join('\n').slice(0, 800);
            const queuedData: ItemQueuedData = {
              spec: rec.spec ?? '',
              repairContext: `Merge conflict integrating '${branch}' into master.\n${conflictOutput}`,
            };
            if (rec.touches) queuedData.touches = rec.touches;
            if (rec.model) queuedData.model = rec.model;
            if (rec.effort) queuedData.effort = rec.effort;
            if (rec.priority) queuedData.priority = rec.priority;
            events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
          }
          continue;
        }

        // Set up node_modules for every deps workdir — spine diffs always touch the
        // framework's own package, so the gate runs that suite too; a missing link there was a
        // source of `tsc: command not found` approve-gate failures. For a workdir with
        // local `file:` deps this overlays the main tree's node_modules but points the file:
        // package at the WORKTREE's copy so an approved branch changing both the package and
        // the app is gated against the branch source, not the stale main tree.
        const depsSetup = setupWorktreeDeps(opts.repoRoot, wtPath, cfg.depsWorkdirs ?? [cfg.appWorkdir]);
        if (depsSetup.buildFailures.length > 0) {
          // Gate would run against stale dist and silently green — fail fast.
          const tail = depsSetup.buildFailures.join('; ');
          events.push(makeEvent('reactor', rec.id, 'gate.failed', {
            reason: `file:-dep build failed: ${tail}`,
          }));
          events.push(makeEvent('reactor', rec.id, 'item.parked', {
            reason: 'approved merge: file:-dep build failed — rebuild needed',
            parkKind: 'ops',
          }));
          continue;
        }

        const runGate = opts.gateRunner ?? runGateOnce;
        const gateResult = runGate(cfg.gateCommand, cfg.gateWorkdir, wtPath, false, cfg.mergeGateTimeoutMs);
        if (!gateResult.passed) {
          persistMergeGateLog(runDir, rec.id, 1, gateResult.output ?? '');
          if (gateResult.timedOut) {
            // Gate was killed at timeout — transient, not a real test failure.
            // Leave the item approved so the next beat retries; cap at 3 total timeouts.
            const newCount = (rec.transientFailCount ?? 0) + 1;
            if (newCount >= MAX_TRANSIENT_TIMEOUT_RETRIES) {
              events.push(makeEvent('reactor', rec.id, 'gate.failed', {
                reason: `merge gate timed out ${newCount}× — parked for investigation (not test-red; investigate beat-load contention)`,
              }));
              events.push(makeEvent('reactor', rec.id, 'item.parked', {
                reason: `merge gate timed out ${newCount}×: not a test failure — investigate beat-load contention`,
                parkKind: 'ops',
              }));
            } else {
              events.push(makeEvent('reactor', rec.id, 'merge.transient-fail', {
                reason: gateResult.reason,
                transientCount: newCount,
              }));
            }
            continue;
          }
          // status > 0: real test failure. This is a mechanical failure the
          // plane owns, so auto-requeue with repair context while the breaker still has room
          // (attempts < breakerN); only park (as an ops-park, off the operator's desk) once the
          // breaker is exhausted. The breaker (rec.attempts, bumped per build.dispatched) is the
          // token guard against an infinite requeue loop.
          events.push(makeEvent('reactor', rec.id, 'gate.failed', {
            reason: `gate red after approved merge: ${gateResult.reason}`,
          }));
          if (rec.attempts >= cfg.breakerN) {
            // Breaker exhausted — stop retrying and rest on the health lane (ops-park).
            events.push(makeEvent('reactor', rec.id, 'item.parked', {
              reason: `breaker: ${rec.attempts} attempts exhausted — approved merge failed gate`,
              parkKind: 'ops',
            }));
          } else {
            const queuedData: ItemQueuedData = {
              spec: rec.spec ?? '',
              repairContext: `Gate red after approved merge: ${gateResult.reason}`,
            };
            if (rec.touches) queuedData.touches = rec.touches;
            if (rec.model) queuedData.model = rec.model;
            if (rec.effort) queuedData.effort = rec.effort;
            if (rec.priority) queuedData.priority = rec.priority;
            events.push(makeEvent('reactor', rec.id, 'item.queued', queuedData));
          }
          continue;
        }

        commitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: wtPath, stdio: 'pipe',
        }).stdout.toString().trim();

        // Fetch before push to reduce the non-FF window from a concurrent push.
        spawnSync('git', ['fetch', 'origin', 'master'], { cwd: wtPath, stdio: 'pipe' });

        // Push the merge commit to origin/master from the worktree.  The primary tree's
        // branch is never touched; subsequent beats see the new HEAD via the fetch below.
        const doPush = () => opts.pushProbe
          ? opts.pushProbe()
          : spawnSync('git', ['push', 'origin', 'HEAD:master'], { cwd: wtPath, stdio: 'pipe' });

        const pushResult = doPush();
        if (pushResult.status !== 0) {
          const why = pushResult.stderr?.toString().trim() ?? 'unknown';
          const isNonFf = why.includes('rejected') || why.includes('non-fast-forward');
          if (isNonFf) {
            // Master advanced between our merge and the push. Fetch the new tip, reset the
            // worktree, re-merge the approved branch, and re-run the gate before retrying —
            // this upholds the invariant that no build reaches master without a gate that
            // covers all commits since the branch point.
            spawnSync('git', ['fetch', 'origin', 'master:master'], { cwd: wtPath, stdio: 'pipe' });
            spawnSync('git', ['reset', '--hard', 'master'], { cwd: wtPath, stdio: 'pipe' });
            const remerge = spawnSync('git', ['merge', '--no-ff', '-m',
              `feat(reactor): ${rec.id} — approved merge`, branch,
            ], { cwd: wtPath, stdio: 'pipe' });
            if (remerge.status !== 0) {
              spawnSync('git', ['merge', '--abort'], { cwd: wtPath, stdio: 'pipe' });
              events.push(makeEvent('reactor', rec.id, 'gate.failed', {
                reason: 'post-rebase merge conflict on approved branch',
              }));
              events.push(makeEvent('reactor', rec.id, 'item.parked', {
                reason: 'approved merge: post-rebase conflict — rebuild needed',
                parkKind: 'ops',
              }));
              continue;
            }
            const reDeps = setupWorktreeDeps(opts.repoRoot, wtPath, cfg.depsWorkdirs ?? [cfg.appWorkdir]);
            if (reDeps.buildFailures.length > 0) {
              events.push(makeEvent('reactor', rec.id, 'gate.failed', {
                reason: `post-rebase file:-dep build failed: ${reDeps.buildFailures.join('; ')}`,
              }));
              events.push(makeEvent('reactor', rec.id, 'item.parked', {
                reason: 'post-rebase merge: file:-dep build failed — rebuild needed',
                parkKind: 'ops',
              }));
              continue;
            }
            const reGate = runGate(cfg.gateCommand, cfg.gateWorkdir, wtPath, false, cfg.mergeGateTimeoutMs);
            if (!reGate.passed) {
              persistMergeGateLog(runDir, rec.id, 2, reGate.output ?? '');
              events.push(makeEvent('reactor', rec.id, 'gate.failed', {
                reason: `gate red after post-rebase merge: ${reGate.reason}`,
              }));
              events.push(makeEvent('reactor', rec.id, 'item.parked', {
                reason: 'post-rebase approved merge failed gate — retry or rebuild',
                parkKind: 'ops',
              }));
              continue;
            }
            commitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
              cwd: wtPath, stdio: 'pipe',
            }).stdout.toString().trim();
            const retryPush = doPush();
            if (retryPush.status !== 0) {
              const retryWhy = retryPush.stderr?.toString().trim() ?? 'unknown';
              // Capped merge transient-fail.
              events.push(...mergeTransientEvents(rec, `push to origin failed after rebase: ${retryWhy}`));
              continue;
            }
            // Retry push succeeded — fall through to fast-forward + success path.
          } else {
            // Capped merge transient-fail (non-FF/auth push).
            events.push(...mergeTransientEvents(rec, `push to origin failed: ${why}`));
            continue;
          }
        }

        // Ledger-merge guard: heal any event that was live in repoRoot before the merge but
        // didn't make it into the pushed merge commit. wtPath still holds the merged tree at
        // this point (removed in `finally` below), so this is the last chance to compare
        // against it. Fail-open: a broken check must never undo an already-pushed,
        // already-gated merge. loadAllEvents's id-dedupe (ledger.ts) makes re-appending
        // idempotent even if this runs more than once for the same gap.
        try {
          const mergedEvents = await loadAllEventsWithQuarantine(join(wtPath, '.ai', 'ledger'));
          const missing = diffMissingEvents(preMergeSnapshot, mergedEvents);
          if (missing.length > 0) {
            await appendEvents(opts.ledgerDir, missing);
            process.stderr.write(
              `[reactor] ledger-merge guard: re-appended ${missing.length} event(s) not present after ` +
              `the ${rec.id} merge (ids: ${missing.map(e => e.id).join(', ')})\n`,
            );
          }
        } catch (e) {
          process.stderr.write(`[reactor] ledger-merge guard check failed (fail-open): ${e}\n`);
        }

        // TRUST-HARDENING: capture the real changed-file list before the worktree is torn down.
        // HEAD is the --no-ff merge commit, so HEAD^1 is the pre-merge master and the diff over
        // HEAD^1..HEAD is exactly the approved branch's changes — robust to the non-FF rebase path
        // above having advanced master. mergeEvidence caps + sets changedFilesTruncated for us.
        const changedFiles = getChangedFiles(wtPath, 'HEAD^1');
        const baseShaResolved = spawnSync('git', ['rev-parse', 'HEAD^1'], { cwd: wtPath, stdio: 'pipe' })
          .stdout.toString().trim();
        approvedMergeEvidence = mergeEvidence(baseShaResolved, commitSha, changedFiles, cfg.gateCommand);

        // Fast-forward the primary tree's local master ref so subsequent git ops in this
        // beat see the new HEAD (best-effort — a non-zero exit doesn't block the merge).
        spawnSync('git', ['fetch', 'origin', 'master:master'], {
          cwd: opts.repoRoot, stdio: 'pipe',
        });
      } finally {
        spawnSync('git', ['worktree', 'remove', wtPath, '--force'], {
          cwd: opts.repoRoot, stdio: 'pipe',
        });
      }

      // Success path — only reached when no continue was triggered inside the try block.
      // Clean up the merged branch from the primary tree (best-effort).
      spawnSync('git', ['branch', '-D', branch], { cwd: opts.repoRoot, stdio: 'pipe' });

      events.push(makeEvent('reactor', rec.id, 'gate.passed', { tests: 'green' }));
      mergedThisBeat = true;
      mergedWiIds.push(rec.id);
      events.push(makeEvent('reactor', rec.id, 'item.merged', {
        commit: commitSha,
        deployed: false,
        ...(approvedMergeEvidence ?? {}),
      }));
      processed++;
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    // An approved merge advanced master → deploy detached (self-locking).
    if (mergedThisBeat && !opts.dryRun) fireDeployOnMerge(opts.repoRoot, cfg.deployCommand, mergedWiIds);

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: `processed ${processed} approved merges`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (c2): notify once per needs-decision park (durable dedupe)
// ---------------------------------------------------------------------------

/**
 * Fire the phone notify hook ONCE per (item, park-event) for decision parks still in
 * state 'parked'. Dedupe is durable: a stamp file named after the park-event id is written
 * to .ai/runs/loopkit/notified/ so beat retries never re-push. An item that is auto-approved
 * and merged before this step runs is already in state 'merged' — it is NOT pushed.
 *
 * The needs-test push (a merged item landing in an acceptance tier that wants operator eyes)
 * is a separate step — see stepNotifyNeedsTest below.
 */
async function stepNotifyDecisionParks(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'notify-decision-parks';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    const notifiedDir = join(resolveRunDir(opts), 'notified');
    const notifyHook = join(opts.repoRoot, cfg.notifyHook);

    // Notify is delivered-or-retried. The default notifyFn returns the hook's
    // exit status as a boolean (true = a transport delivered). opts.notify (tests / stepHeal)
    // returning void is treated as delivered (undefined !== false) so its callers are unaffected;
    // a test injects `() => false` to simulate a total-transport failure. The .ai/notify-phone.sh
    // hook exits non-zero when NO transport delivered, so a real park emitted
    // while every notify transport is down is retried next beat instead of being silently
    // stamped-away.
    const notifyFn: (msg: string) => boolean | void = opts.notify ?? ((msg: string) => {
      if (!existsSync(notifyHook)) return false;
      try {
        const r = spawnSync(notifyHook, [msg], { stdio: 'pipe', timeout: 10_000 });
        return r.status === 0;
      } catch {
        return false;
      }
    });

    // Stop paging after this long of *consecutive delivery failures* for one
    // standing decision — a permanently-broken transport must not re-attempt (and re-fail) forever.
    const FAILURE_GIVEUP_MS = 24 * 60 * 60 * 1000;

    let pushed = 0;
    let skipped = 0;
    let gaveUp = 0;
    const opsEvents: ReturnType<typeof makeEvent>[] = [];

    for (const rec of foldResult.items.values()) {
      // The ONE decision predicate (imported from fold.js).
      if (!isDecisionPark(rec)) continue;

      // Novelty gate (failure catalog): a repeat of an already-known failure fingerprint is
      // already routed through the bounded auto-requeue health lane — don't re-page the operator
      // for it. It still sits on the needs-you board (badged 'repeat'), just silently.
      if (!isFirstSeenPark(rec)) continue;

      // Dedup key is item + sha1(parkReason), NOT the park EVENT id. A re-parked
      // item carrying the SAME standing reason notifies exactly once (a per-event key would
      // re-page every re-park); a genuinely different reason produces a new key so it may notify again.
      const reason = rec.parkReason ?? '';
      const reasonHash = createHash('sha1').update(reason).digest('hex').slice(0, 16);
      const stampKey = `${rec.id}.${reasonHash}`;
      const stampPath = join(notifiedDir, stampKey);
      const failMarkPath = join(notifiedDir, `${stampKey}.failing`);

      // Already delivered for this (item, reason) — skip.
      if (existsSync(stampPath)) {
        skipped++;
        continue;
      }

      // Gave up after 24h of delivery failures — one ops note, then stop retrying.
      if (existsSync(failMarkPath)) {
        try {
          const firstFailMs = Number(readFileSync(failMarkPath, 'utf8').trim());
          if (Number.isFinite(firstFailMs) && Date.now() - firstFailMs >= FAILURE_GIVEUP_MS) {
            opsEvents.push(makeEvent('reactor', rec.id, 'msg.out', {
              text: `loopkit ops: phone notify for ${rec.id} undelivered ${(FAILURE_GIVEUP_MS / 3_600_000).toFixed(0)}h — giving up (transport down). Decide on the console.`,
            }));
            // Promote the fail-mark to the stamp so it is treated as handled (no more retries).
            if (!opts.dryRun) {
              try { writeFileSync(stampPath, '', 'utf8'); } catch { /* best-effort */ }
              try { rmSync(failMarkPath, { force: true }); } catch { /* best-effort */ }
            }
            gaveUp++;
            continue;
          }
        } catch { /* unreadable mark — fall through to a fresh attempt */ }
      }

      const subject = `loopkit: decision needed — ${rec.id}`;
      const body = `${rec.id} is parked and blocking the queue. Decide on the console's needs-you board.\n${reason.slice(0, 400)}`;

      if (!opts.dryRun) {
        const delivered = notifyFn(`${subject}\n${body}`) !== false;
        try {
          mkdirSync(notifiedDir, { recursive: true });
          if (delivered) {
            // Stamp ONLY on confirmed delivery; clear any prior fail-mark.
            writeFileSync(stampPath, '', 'utf8');
            if (existsSync(failMarkPath)) rmSync(failMarkPath, { force: true });
            pushed++;
          } else {
            // Not delivered → do NOT stamp; record the first-failure time so the 24h give-up
            // window can start counting, and retry next beat.
            if (!existsSync(failMarkPath)) writeFileSync(failMarkPath, String(Date.now()), 'utf8');
            skipped++;
          }
        } catch { /* best-effort, never crash the beat */ }
      } else {
        pushed++;
      }
    }

    if (!opts.dryRun && opsEvents.length > 0) {
      await appendEvents(opts.ledgerDir, opsEvents);
    }

    return {
      step,
      ok: true,
      eventsWritten: opsEvents.length,
      mdWritten: false,
      detail: pushed === 0 && skipped === 0 && gaveUp === 0
        ? 'no decision parks'
        : `pushed=${pushed} skipped(deduped/undelivered)=${skipped} gave-up=${gaveUp}`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (c3): needs-test phone push — notify once per merged item that lands in an
// acceptance tier wanting operator eyes ('review'/'must').
// ---------------------------------------------------------------------------

/**
 * Fire the phone notify hook ONCE per item that reaches state 'merged' and classifies into
 * the 'review' or 'must' acceptance tier — the tiers that want the operator to actually look
 * at the slice, as opposed to 'auto'/'optional' which resolve on their own. Tier is derived
 * from the SAME classifier stepProvisionalAccept uses (classifyAcceptanceTier over
 * acceptanceClassifyFiles + the item's resolved boundaries) — this step never re-derives
 * tiering rules of its own.
 *
 * Dedupe mirrors stepNotifyDecisionParks: a stamp file keyed on the item id is written to
 * .ai/runs/loopkit/notified/ (a distinct sub-namespace from the decision-park stamps) so a
 * merged item is pushed exactly once, ever, regardless of how many beats re-observe it in
 * state 'merged'. Delivery failures are never stamped — the push simply retries next beat, so
 * an item is never silently dropped, just never spammed once delivered.
 */
async function stepNotifyNeedsTest(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'notify-needs-test';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    const notifiedDir = join(resolveRunDir(opts), 'notified-needs-test');
    const notifyHook = join(opts.repoRoot, cfg.notifyHook);

    const notifyFn: (msg: string) => boolean | void = opts.notify ?? ((msg: string) => {
      if (!existsSync(notifyHook)) return false;
      try {
        const r = spawnSync(notifyHook, [msg], { stdio: 'pipe', timeout: 10_000 });
        return r.status === 0;
      } catch {
        return false;
      }
    });

    const tiersCfg = cfg.acceptance?.tiers;
    const surfacePrefixes = tiersCfg?.surfacePrefixes ?? [];
    const targetBoundaryCache = new Map<string, { surfacePrefixes: string[]; planePrefixes: string[]; riskPatterns: string[] } | null>();

    let pushed = 0;
    let skipped = 0;

    for (const rec of foldResult.items.values()) {
      if (rec.state !== 'merged') continue;

      const stampPath = join(notifiedDir, rec.id);
      if (existsSync(stampPath)) {
        skipped++;
        continue;
      }

      const files = acceptanceClassifyFiles(rec.mergeChangedFiles, rec.touches);
      const bounds = boundariesForItem(rec, foldResult, cfg, surfacePrefixes, targetBoundaryCache);
      const { tier } = classifyAcceptanceTier(files, rec.judgeVerdict, {
        surfacePrefixes: bounds.surfacePrefixes,
        planePrefixes: bounds.planePrefixes,
        riskPatterns: bounds.riskPatterns,
        confidenceFloor: tiersCfg?.confidenceFloor,
      }, hasEvidenceGap(rec.mergeChangedFiles, rec.touches, {
        gateCommand: rec.mergeGateCommand,
        baseSha: rec.mergeBaseSha,
        headSha: rec.mergeHeadSha,
      }), rec.mergeChangedFilesTruncated === true);

      // Only the tiers that want operator eyes push a phone notify. 'auto'/'optional' resolve
      // on their own — pushing those would spam the operator on every routine merge.
      if (tier !== 'review' && tier !== 'must') continue;

      const title = rec.spec ?? rec.sourceText ?? '';
      const subject = `loopkit: ${rec.id} awaiting your test`;
      const body = `${rec.id}${title ? ` — ${title.slice(0, 200)}` : ''}\ntier: ${tier}\nmerged and awaiting your test on the console.`;

      if (!opts.dryRun) {
        // Fire-and-forget: a throwing notifyFn (a hostile/broken injected transport) is treated
        // the same as an explicit `false` — undelivered, retried next beat — never a step failure.
        let delivered: boolean;
        try {
          delivered = notifyFn(`${subject}\n${body}`) !== false;
        } catch {
          delivered = false;
        }
        try {
          if (delivered) {
            mkdirSync(notifiedDir, { recursive: true });
            writeFileSync(stampPath, '', 'utf8');
            pushed++;
          } else {
            skipped++;
          }
        } catch { /* best-effort, never crash the beat */ }
      } else {
        pushed++;
      }
    }

    return {
      step,
      ok: true,
      eventsWritten: 0,
      mdWritten: false,
      detail: pushed === 0 && skipped === 0
        ? 'no merged items in review/must tier'
        : `pushed=${pushed} skipped(deduped/undelivered)=${skipped}`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (d): doctor sweep
// ---------------------------------------------------------------------------

/**
 * Real progress probe. Returns the newest epoch-ms across a building item's
 * deterministic progress signals — the worker log mtime, the worker stderr mtime, and the
 * worktree branch's last commit time — or null when none can be read (⇒ the doctor will not
 * reap: absence of a signal is not evidence of a stall). No pane scraping.
 */
export function makeProgressProbe(runDir: string): ProgressProbe {
  return (rec) => {
    let newest: number | null = null;
    const consider = (ms: number | null): void => {
      if (ms != null && Number.isFinite(ms) && (newest == null || ms > newest)) newest = ms;
    };
    const attempt = rec.currentBuild?.attempt ?? rec.attempts;
    // worker log + stderr mtimes (the agent streams output here as it works)
    for (const p of [join(runDir, `${rec.id}-attempt-${attempt}.log`), join(runDir, `${rec.id}-agent.err`)]) {
      try {
        if (existsSync(p)) consider(statSync(p).mtimeMs);
      } catch { /* unreadable → ignore this signal */ }
    }
    // last commit on the worktree branch (a committing agent is making progress)
    const wt = rec.currentBuild?.worktree;
    if (wt && existsSync(wt)) {
      try {
        const r = spawnSync('git', ['-C', wt, 'log', '-1', '--format=%ct'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        const sec = parseInt((r.stdout ?? '').trim(), 10);
        if (Number.isFinite(sec)) consider(sec * 1000);
      } catch { /* not a git worktree yet → ignore */ }
    }
    return newest;
  };
}

async function stepDoctor(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'doctor';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);
    const runDir = resolveRunDir(opts);
    mkdirSync(runDir, { recursive: true });
    const now = opts.now ?? Date.now();
    const doctorConfig: DoctorConfig = {
      breakerN: cfg.breakerN,
      stalledBuildMinutes: cfg.stalledBuildMinutes,
      now,
    };
    const pidProbe = opts.pidProbe ?? defaultPidProbe;
    const progressProbe = opts.progressProbe ?? makeProgressProbe(runDir);
    // Real probe wired so the collection-vs-orphan guard finds real exit files for detached
    // builds — it stays inert unless a caller passes a non-default probe. `runDir` here
    // (`.ai/runs/loopkit`) is the same directory dispatch.ts's `artifactDir` defaults to, so
    // the beat writing the exit file and the doctor reading it agree on where to look.
    const exitFileProbe: ExitFileProbe = opts.exitFileProbe
      ?? (rec => rec.currentBuild ? exitFilePresent(runDir, rec.id, rec.currentBuild.attempt) : false);
    // Real worktree-existence probe wired so the POST-COLLECTION-LIMBO reaper is active in the
    // live plane (previously only the always-present default existed, so that leg of the
    // exit-file guard was dead code: a build whose exit file is present but whose worktree was
    // reaped can sit invisibly in 'building' forever). "Worktree gone" = the build's recorded
    // worktree path no longer exists on disk; combined with a stale dispatch (config.now past
    // limboMaxMs) that is a build the collector can never finish. Inert unless a caller injects
    // a probe; harmless when the worktree is still present (the normal collectable case defers).
    const worktreeProbe: WorktreeProbe = opts.worktreeProbe
      ?? (rec => rec.currentBuild?.worktree ? existsSync(rec.currentBuild.worktree) : true);

    const doctorResult = runDoctor(foldResult, pidProbe, doctorConfig, 'reactor', progressProbe, exitFileProbe, worktreeProbe);

    // ADR-007 "stale claims are reaped, never silently dropped": a claim that already reads
    // inactive (isClaimActive false) never blocks a pick, but for audit-trail/fold hygiene the
    // doctor additionally releases it explicitly once it has read inactive for a while.
    //
    // Correctness: this proposal is computed from `foldResult` at the TOP of the step, but the
    // actual append happens further below (after salvage/notify, which can take real time). An
    // attended operator session can append a fresh `item.claimed` for the same item in that
    // window; releasing the stale claim after that would silently erase the fresh one. So the
    // reap is re-verified under the ledger lock (mirrors stepDecompositionUnpark/-Grooming's
    // withLock(tx.loadAll → fold → tx.append) pattern above): re-fold immediately before
    // appending, and only release claims that STILL read inactive on that fresh fold. A claim
    // that changed in the interim (re-claimed, or already released) is naturally excluded.
    let reapEvents: LedgerEvent[] = [];
    if (!opts.dryRun) {
      await withLock(opts.ledgerDir, async (tx) => {
        const freshEvents = await tx.loadAll();
        const freshResult = fold(freshEvents);
        reapEvents = reapStaleClaims(freshResult, freshResult.sessions, now);
        if (reapEvents.length > 0) {
          await tx.append(reapEvents);
        }
      });
    }

    if (doctorResult.actions.length === 0 && reapEvents.length === 0) {
      return { step, ok: true, eventsWritten: reapEvents.length, mdWritten: false, detail: reapEvents.length === 0 ? 'no orphans' : `${reapEvents.length} stale claims reaped` };
    }

    const events = [...doctorResult.actions.flatMap(a => a.events)];

    // Attach deterministic capture-time diagnosis (git log since last merge +
    // surrounding ledger context) to the build.crashed/build.stalled event itself, before
    // it's written — a repair worker picking the requeue up cold gets change-correlation
    // evidence up front instead of rediscovering it via ad-hoc greps. No-op on every other
    // event type in this batch (item.queued, item.parked).
    for (let i = 0; i < events.length; i++) {
      events[i] = enrichCrashOrStallEvent(events[i]!, opts.repoRoot, allEvents);
    }

    // Salvage capture for reaped builds: before writing events (and
    // removing worktrees), capture uncommitted partial work from any orphan OR stalled item
    // whose recorded worktree still exists. Stalled items are alive — kill the worker first
    // (SIGTERM) so it stops writing before we salvage and remove its worktree.
    const stalledIds = new Set(doctorResult.stalled.map(r => r.id));
    const salvageEnabled = cfg.salvage?.enabled !== false;
    const killFn = opts.killFn ?? ((id: number, signal: NodeJS.Signals) => { process.kill(id, signal); });
    if (!opts.dryRun && salvageEnabled) {
      for (const rec of [...doctorResult.orphans, ...doctorResult.stalled]) {
        const wtPath = rec.currentBuild?.worktree;
        const kind: 'orphan' | 'stalled' = stalledIds.has(rec.id) ? 'stalled' : 'orphan';
        // Reap the live worker of a stalled build before touching its worktree. A detached
        // build records only a pgid (no pid, per BuildDispatchedData) — same liveness-id
        // selection as the doctor's own probe (runDoctor: `livenessId = pgid ?? pid`), and the
        // same negative-id-targets-the-GROUP convention as defaultPidProbe. Signalling the bare
        // pgid (positive) would hit an unrelated/nonexistent pid, leaving the real group running
        // and free to keep writing into the worktree while salvage reads it.
        if (kind === 'stalled') {
          const pgid = rec.currentBuild?.pgid;
          const pid = rec.currentBuild?.pid;
          if (typeof pgid === 'number') {
            try { killFn(-pgid, 'SIGTERM'); } catch { /* already gone → fine */ }
          } else if (typeof pid === 'number') {
            try { killFn(pid, 'SIGTERM'); } catch { /* already gone → fine */ }
          }
        }
        if (!wtPath) continue;
        try {
          if (!existsSync(wtPath)) continue;
          const attempt = rec.currentBuild?.attempt ?? rec.attempts;
          const workerLogPath = join(runDir, `${rec.id}-attempt-${attempt}.log`);
          const sr = captureSalvage(wtPath, rec.id, attempt, runDir, kind, cfg.salvage ?? {}, workerLogPath);
          if (sr.trailMessage) {
            events.push(makeEvent('reactor', rec.id, 'msg.out', { text: sr.trailMessage }));
          }
          // Remove the orphan worktree after salvage (otherwise it would leak)
          try {
            spawnSync('git', ['worktree', 'remove', wtPath, '--force'], {
              cwd: opts.repoRoot, stdio: 'pipe',
            });
          } catch { /* fail-soft — removal is best-effort */ }
        } catch (e) {
          process.stderr.write(`[doctor] salvage: ${rec.id} error: ${e}\n`);
        }
      }
    }

    // Notify on park-breaker actions
    const notifyHook = join(opts.repoRoot, cfg.notifyHook);
    for (const action of doctorResult.actions) {
      if (action.type === 'park-breaker' && existsSync(notifyHook)) {
        if (!opts.dryRun) {
          try {
            spawnSync(notifyHook, [
              `loopkit: breaker tripped on ${action.item} after ${action.attempt} attempts`,
            ], { stdio: 'pipe' });
          } catch { /* notify is best-effort */ }
        }
      }
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length + reapEvents.length,
      mdWritten: false,
      detail: `${doctorResult.orphans.length} orphans; ${doctorResult.stalled.length} stalled; ${doctorResult.actions.filter(a => a.type === 'park-breaker').length} breaker trips; ${reapEvents.length} stale claims reaped`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (d2): acceptance tiering (generalizes an earlier provisional-accept mechanism)
//
// Classify every merged item into an attention tier (acceptance.ts) and auto-accept
// once its tier's window has elapsed, subject to these guards:
//   - merged state (no item.accepted yet), mergedAt present
//   - operator silence: no msg.in on the item after the merge event
//   - current SLO board shows NO breach for loop-reactor, loop-dispatch, instances
// Tier 'must' (judge fail, or a risk-flagged path) NEVER auto-accepts. Classification
// is driven by the fold record's `touches` (the item's declared/changed file set) —
// no git diff-tree call, no per-commit shelling out.
// Cap: `acceptance.tiers.perBeatCap` acceptances per beat (default 25), across all tiers.
// ---------------------------------------------------------------------------

/**
 * The SLO rows that the acceptance-tiering gate checks for health.
 * Must all be non-breached for the plane to self-accept.
 */
const PROVISIONAL_ACCEPT_SLO_KEYS = new Set(['loop-reactor', 'loop-dispatch', 'instances']);

/**
 * Step (d1): verdict-history tier calibration.
 *
 * Self-tunes the 'optional' and 'review' auto-accept windows from the operator's actual
 * verdicts since the last recalibration (or ever, if never tuned): a clean-accept streak
 * with zero problems shrinks the window (bother the operator less); any problem report grows it
 * (safety valve — bother the operator more). Event-sourced: writes `tier.recalibrated`,
 * never touches loopkit.config.json. Runs BEFORE stepProvisionalAccept so a recalibrated
 * window is current for that beat's accept decisions. 'auto' (already immediate/silent)
 * and 'must' (never auto-accepts) are not tuned.
 */
async function stepTierCalibration(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'tier-calibration';
  try {
    const tiersCfg = cfg.acceptance?.tiers;
    const calibCfg = tiersCfg?.calibration;
    if (calibCfg?.enabled === false) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'tier calibration disabled' };
    }

    const surfacePrefixes = tiersCfg?.surfacePrefixes ?? [];
    const optionalAfterHours = tiersCfg?.optionalAfterHours ?? 48;
    const reviewAfterHours = tiersCfg?.reviewAfterHours ?? 168;
    const resolvedCalibCfg: TierCalibrationConfig = {
      enabled: calibCfg?.enabled ?? true,
      demoteAfterCleanAccepts: calibCfg?.demoteAfterCleanAccepts ?? 5,
      demoteFactor: calibCfg?.demoteFactor ?? 0.5,
      promoteFactor: calibCfg?.promoteFactor ?? 2.0,
      windowFloorHours: calibCfg?.windowFloorHours ?? 1,
      windowCeilingHours: calibCfg?.windowCeilingHours ?? 336,
    };

    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);

    // TARGET EXTERNALIZATION: memoize per-target manifest boundary reads within this beat.
    const calibTargetBoundaryCache = new Map<string, { surfacePrefixes: string[]; planePrefixes: string[]; riskPatterns: string[] } | null>();
    const classifyTier = (itemId: string): string | undefined => {
      const rec = foldResult.items.get(itemId);
      if (!rec) return undefined;
      const bounds = boundariesForItem(rec, foldResult, cfg, surfacePrefixes, calibTargetBoundaryCache);
      // TRUST-HARDENING (defect a): classify from ACTUAL merge evidence when present, falling back
      // to declared touches only for legacy items without evidence.
      return classifyAcceptanceTier(acceptanceClassifyFiles(rec.mergeChangedFiles, rec.touches), rec.judgeVerdict, {
        surfacePrefixes: bounds.surfacePrefixes,
        planePrefixes: bounds.planePrefixes,
        riskPatterns: bounds.riskPatterns,
      }, hasEvidenceGap(rec.mergeChangedFiles, rec.touches, {
        gateCommand: rec.mergeGateCommand,
        baseSha: rec.mergeBaseSha,
        headSha: rec.mergeHeadSha,
      })).tier;
    };

    const { windows, watermark } = effectiveTierWindows(allEvents, {
      optional: optionalAfterHours,
      review: reviewAfterHours,
    });
    const stats = tallyVerdictsSince(allEvents, watermark, classifyTier);

    const events: ReturnType<typeof makeEvent>[] = [];
    let recalibrated = 0;
    for (const tier of ['optional', 'review'] as const) {
      const decision = decideTierWindow(windows[tier], stats[tier], resolvedCalibCfg);
      if (!decision) continue;
      events.push(makeEvent('reactor', `tier-${tier}`, 'tier.recalibrated', {
        tier,
        windowHours: decision.newWindowHours,
        prevWindowHours: windows[tier],
        reason: decision.reason,
        cleanAccepts: stats[tier].cleanAccepts,
        problems: stats[tier].problems,
      }));
      recalibrated++;
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: recalibrated === 0 ? 'no change' : `recalibrated ${recalibrated} tier window(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

async function stepProvisionalAccept(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'provisional-accept';
  try {
    const tiersCfg = cfg.acceptance?.tiers;
    const tiersEnabled = tiersCfg?.enabled ?? true;
    if (!tiersEnabled) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'tiers disabled' };
    }

    const surfacePrefixes = tiersCfg?.surfacePrefixes ?? [];
    const autoAfterHours = tiersCfg?.autoAfterHours ?? 2;
    const configOptionalAfterHours = tiersCfg?.optionalAfterHours ?? 48;
    const configReviewAfterHours = tiersCfg?.reviewAfterHours ?? 168;
    const perBeatCap = tiersCfg?.perBeatCap ?? 25;
    const now = Date.now();

    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    // Use the calibrated effective windows (latest tier.recalibrated per
    // tier, else the config default) for 'optional'/'review'. 'auto' stays fixed — it is
    // already immediate/silent and is not tuned.
    const { windows: effectiveWindows } = effectiveTierWindows(allEvents, {
      optional: configOptionalAfterHours,
      review: configReviewAfterHours,
    });
    const optionalAfterHours = effectiveWindows.optional;
    const reviewAfterHours = effectiveWindows.review;
    const foldResult = fold(allEvents);

    // Evaluate the SLO board for the smoke check (re-use the injected board in tests,
    // or evaluate a fresh board against real probes). We only care about PLANE health rows.
    let smokeBoard: import('../slo.js').SloRow[];
    if (opts.provisionalSloBoard) {
      smokeBoard = opts.provisionalSloBoard;
    } else {
      // Same resolved run-dir + expected-labels wiring as stepSloEvaluate — the smoke
      // check must read the SAME plane's run-state, or it withholds accepts on a ghost.
      const probes: import('../slo.js').SloProbes = opts.sloProbes
        ?? (await import('../slo.js')).makeRealProbes(opts.repoRoot, resolveRunDir(opts), cfg.slo?.expectedLaunchdLabels, cfg.slo?.probePaths);
      probes.now = () => now;
      if (!opts.sloProbes) {
        probes.deploy = (await import('../slo.js')).makeDeployProbe(opts.repoRoot);
        probes.instanceProbe = (await import('../slo.js')).makeInstanceProbe();
      }
      smokeBoard = (await import('../slo.js')).evaluateSloBoard(cfg.slo, probes, allEvents);
    }
    // Check: every monitored health row must be affirmatively 'met'. Unknown ≠ healthy —
    // a probe error withholds auto-acceptance (evidence absent, not evidence green).
    const sloHealthy = smokeBoard
      .filter(r => PROVISIONAL_ACCEPT_SLO_KEYS.has(r.key))
      .every(r => r.status === 'met');

    // Consecutive-skip streak (durable across beats via lastbeat.json, same shape as the
    // queue-stall streak): a healthy beat resets it to 0; an unhealthy beat increments
    // it. Read by stepSloEvaluate (via FoldProbeData.acceptSkipStreak) to render the
    // 'accept-skip' SLO row — this silent-stall class would otherwise be invisible (only the
    // acceptance backlog inflating), never surfaced as a health signal of its own.
    const runsDir = dirname(resolveRunDir(opts)); // …/runs parent — lastbeat.json subdirs keep their shape
    const prevAcceptSkip = readLastbeat(runsDir, 'accept-skip');
    const prevAcceptSkipStreak = Number((prevAcceptSkip?.counts as { streak?: number } | undefined)?.streak) || 0;
    const acceptSkipStreak = sloHealthy ? 0 : prevAcceptSkipStreak + 1;
    if (!opts.dryRun) {
      writeLastbeat(runsDir, 'accept-skip', { streak: acceptSkipStreak });
    }

    // The plane-SLO smoke gate is a WITHHOLD signal for NON-auto tiers only. The
    // 'auto' tier is "nothing to test" (no-code / gate-proven plane internals) — the smoke gate
    // protects nothing for it, so it must never be hostage to plane-SLO health. We therefore do
    // not return early on !sloHealthy: the loop runs, and the gate is applied per-item by tier.
    const nonAutoWithheld = !sloHealthy;
    // Visible-reason ops event on the TRANSITION into the withheld state (dedup on state change,
    // not every beat) — the failing SLO keys, so the operator/console sees WHY non-auto accepts stall.
    const withheldEvents: ReturnType<typeof makeEvent>[] = [];
    if (nonAutoWithheld && prevAcceptSkipStreak === 0) {
      const failingKeys = smokeBoard
        .filter(r => PROVISIONAL_ACCEPT_SLO_KEYS.has(r.key) && r.status !== 'met')
        .map(r => `${r.key}=${r.status}`)
        .join(', ');
      withheldEvents.push(makeEvent('reactor', 'system', 'msg.out', {
        text: `accept.withheld: non-auto tier acceptance withheld — plane SLO not met (${failingKeys || 'unknown'}). Auto-tier accepts continue; non-auto resumes on recovery.`,
      }));
    }

    // The operator-silence hold is CAUSATION-keyed, not "any msg.in after merge".
    // heldItems (from the SAME fold pass that computes the engagement work-list, so a reply landing
    // mid-beat is visible to both reads or neither) holds an item while it has an UNANSWERED
    // post-baseline reply, OR an open verdict/unpark proposal awaiting the operator's confirm. It
    // clears once the reply's outcome event lands (carrying its inReplyTo) and no proposal is
    // pending; any newer reply re-arms it. Legacy pre-baseline replies no longer pin a merge forever.
    const { heldItems } = projectEngagement(allEvents);
    // The operator-silence hold expires after holdMaxHours so a never-answered reply
    // can't pin an item forever (and drop a review-tier item out of the needs-you window).
    const holdMaxHours = tiersCfg?.holdMaxHours ?? 72;
    const holdMaxMs = holdMaxHours * 3_600_000;

    // Withheld-state ops event (edge-triggered) is appended alongside accepts.
    const events: ReturnType<typeof makeEvent>[] = [...withheldEvents];
    let accepted = 0;
    // TARGET EXTERNALIZATION: memoize per-target manifest boundary reads within this beat.
    const targetBoundaryCache = new Map<string, { surfacePrefixes: string[]; planePrefixes: string[]; riskPatterns: string[] } | null>();

    for (const rec of foldResult.items.values()) {
      if (accepted >= perBeatCap) break;
      // Only consider items in 'merged' state (no item.accepted yet).
      if (rec.state !== 'merged') continue;
      const mergedAt = rec.mergedAt;
      if (!mergedAt) continue;

      const mergedMs = new Date(mergedAt).getTime();
      if (isNaN(mergedMs)) continue;

      // TRUST-HARDENING (defect a): classify from ACTUAL merge evidence when present, falling
      // back to declared touches only for legacy items without evidence.
      const files = acceptanceClassifyFiles(rec.mergeChangedFiles, rec.touches);
      // TARGET EXTERNALIZATION: a targeted item classifies against its target's boundaries.
      const bounds = boundariesForItem(rec, foldResult, cfg, surfacePrefixes, targetBoundaryCache);
      const { tier, reason } = classifyAcceptanceTier(files, rec.judgeVerdict, {
        surfacePrefixes: bounds.surfacePrefixes,
        planePrefixes: bounds.planePrefixes,
        riskPatterns: bounds.riskPatterns,
        confidenceFloor: tiersCfg?.confidenceFloor,
      }, hasEvidenceGap(rec.mergeChangedFiles, rec.touches, {
        gateCommand: rec.mergeGateCommand,
        baseSha: rec.mergeBaseSha,
        headSha: rec.mergeHeadSha,
      }), rec.mergeChangedFilesTruncated === true);

      // 'must' tier never auto-accepts.
      if (tier === 'must') continue;

      // The plane-SLO smoke gate withholds NON-auto tiers only. 'auto' is
      // "nothing to test" so it accepts even while the plane is unhealthy; optional/review wait.
      if (nonAutoWithheld && tier !== 'auto') continue;

      // Operator-silence guard: hold an item whose engagement is
      // unresolved — an unanswered post-baseline reply (the agent still owes a response) or a
      // pending verdict/unpark proposal — so a change the operator is actively steering is not
      // silently accepted. EXCEPT the 'auto' tier (no-code or gate-proven plane internals: there
      // is nothing to verify, so it must not pin in the queue). Once the reactor answers the reply
      // this same beat, the hold clears next beat — the bottleneck the tiering removes stays removed.
      if (tier !== 'auto') {
        const heldSince = heldItems.get(rec.id);
        if (heldSince !== undefined) {
          const heldSinceMs = new Date(heldSince).getTime();
          const heldExpired = Number.isFinite(heldSinceMs) && (now - heldSinceMs) >= holdMaxMs;
          if (!heldExpired) continue; // still within the hold window — wait for the operator.
          // Hold expired → resume normal tier windows. Emit ONE ops note (dedup:
          // skip if a prior hold-expiry note already exists for this item's current hold onset).
          const already = allEvents.some(ev =>
            ev.item === rec.id && ev.type === 'msg.out' &&
            String((ev.data as { text?: string }).text ?? '').includes('operator-silence hold expired') &&
            String((ev.data as { text?: string }).text ?? '').includes(heldSince));
          if (!already) {
            events.push(makeEvent('reactor', rec.id, 'msg.out', {
              text: `operator-silence hold expired after ${holdMaxHours}h (held since ${heldSince}) — ${rec.id} resumes normal tier acceptance windows.`,
            }));
          }
        }
      }

      const windowHours = tier === 'auto' ? autoAfterHours
        : tier === 'optional' ? optionalAfterHours
        : reviewAfterHours; // 'review'
      const windowMs = windowHours * 3_600_000;
      if (now - mergedMs < windowMs) continue; // not due yet

      const hoursElapsed = ((now - mergedMs) / 3_600_000).toFixed(1);
      const trailText = [
        `tier acceptance: tier=${tier}.`,
        `  reason: ${reason}`,
        `  merged: ${mergedAt} (${hoursElapsed}h ago, window=${windowHours}h)`,
        `  files (${files.length}): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` ... +${files.length - 5} more` : ''}`,
        `  slo: loop-reactor/loop-dispatch/instances all non-breached`,
        `  operator-silence: ${tier === 'auto' ? 'not required for auto tier (nothing to test)' : 'no unresolved engagement (reply answered / no pending proposal)'}`,
      ].join('\n');

      events.push(makeEvent('reactor', rec.id, 'item.accepted', {
        by: `reactor:tier-${tier}`,
        provisional: true,
        tier,
        reason,
      }));
      events.push(makeEvent('reactor', rec.id, 'msg.out', {
        text: trailText,
      }));
      accepted++;
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: accepted === 0 ? 'no eligible items' : `tier-accepted ${accepted} item(s) (cap=${perBeatCap})`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (e): SLO evaluate — edge-triggered breach + recover + loop.beat summary
// ---------------------------------------------------------------------------

async function stepSloEvaluate(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
  opsEvents: LedgerEvent[],
  providerRegistry?: ReturnType<typeof makeRegistry> | null,
): Promise<{ result: StepResult; board: SloRow[]; dispatchWedgeSec?: number }> {
  const step = 'slo-evaluate';
  try {
    const allEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const foldResult = fold(allEvents);
    const items = Array.from(foldResult.items.values());

    // Build fold-derived pipeline data for SLO probes
    const now = Date.now();
    const unroutedItems = items.filter(r => r.state === 'captured');
    let oldestUnroutedMin: number | undefined;
    for (const rec of unroutedItems) {
      const capAt = rec.capturedAt ?? rec.createdAt;
      if (capAt) {
        const ageMin = (now - new Date(capAt).getTime()) / 60_000;
        oldestUnroutedMin = oldestUnroutedMin === undefined
          ? ageMin : Math.max(oldestUnroutedMin, ageMin);
      }
    }

    const parkedItems = items.filter(r => r.state === 'parked');
    let oldestParkedH: number | undefined;
    for (const rec of parkedItems) {
      const parkedAt = rec.parkedAt;
      if (parkedAt) {
        const ageH = (now - new Date(parkedAt).getTime()) / 3_600_000;
        oldestParkedH = oldestParkedH === undefined
          ? ageH : Math.max(oldestParkedH, ageH);
      }
    }

    // Build SLO probes — inject fakes in tests, use real probes in production.
    // Pass the RESOLVED run dir (plane-home mode: run-state lives beside the ledger, not
    // under the driven repo — an unresolved default here once read a sibling plane's stale
    // lastrun and breached loop-reactor/loop-dispatch every beat) and the expected launchd
    // labels (enables the per-label `launchctl print` fallback in the launchd probe).
    const probes: SloProbes = opts.sloProbes
      ?? makeRealProbes(opts.repoRoot, resolveRunDir(opts), cfg.slo?.expectedLaunchdLabels, cfg.slo?.probePaths);
    probes.now = () => now;
    // Deploy + instance probes are loopkit-native (they must be filled here rather than assumed).
    // Only fill them when the caller didn't inject a full probe set (tests inject their own).
    if (!opts.sloProbes) {
      probes.deploy = makeDeployProbe(opts.repoRoot);
      probes.instanceProbe = makeInstanceProbe();
    }
    // plane-check diagnostic probe — real invocation only when the caller didn't inject its own
    // probe set (keeps every existing sloProbes-fake test shell-free) AND a validator script is
    // configured (cfg.slo.probePaths.planeCheckScript); unset ⇒ the probe is a no-op.
    if (opts.planeCheckProbe) {
      probes.planeCheck = opts.planeCheckProbe;
    } else if (!opts.sloProbes) {
      probes.planeCheck = makePlaneCheckProbe(opts.repoRoot, cfg.slo?.probePaths?.planeCheckScript);
    }

    // Queue-stall consecutive-beat streak. evaluateSloBoard stays a pure snapshot, so
    // the streak is beat-local state this step owns (same lastbeat.json pattern as the reactor/
    // dispatch heartbeats), fed by the plane-check probe's dispatchability verdict.
    const runsDir = dirname(resolveRunDir(opts)); // …/runs parent — lastbeat.json subdirs keep their shape
    const planeCheckRows = probes.planeCheck ? probes.planeCheck() : undefined;
    const dispatchStalled = planeCheckRows?.find(r => r.check === 'dispatchability')?.status === 'FAIL';
    const prevQueueStall = readLastbeat(runsDir, 'queue-stall');
    const prevStreak = Number((prevQueueStall?.counts as { streak?: number } | undefined)?.streak) || 0;
    const queueStallStreak = dispatchStalled ? prevStreak + 1 : 0;
    if (!opts.dryRun) {
      writeLastbeat(runsDir, 'queue-stall', { streak: queueStallStreak });
    }

    // No-commit-reason item.parked events in the trailing 24h — a systemic
    // worker/allowlist failure, not item-level noise (surfaced by the plane-check validator's dedicated check).
    const noCommitParkCount24h = allEvents.filter(ev =>
      ev.type === 'item.parked' &&
      now - new Date(ev.ts).getTime() < 24 * 60 * 60 * 1000 &&
      /no-commit/i.test(String((ev.data as { reason?: string }).reason ?? '')),
    ).length;
    // ONE decision predicate — the fold's isDecisionPark (state==='parked'
    // && parkKind==='decision'), imported from fold.js. No reason-substring fallback.
    // The accept-skip streak is written by stepProvisionalAccept (which runs
    // earlier in the same beat) — read-only here, same lastbeat.json file, no re-derivation.
    const acceptSkipBeat = readLastbeat(runsDir, 'accept-skip');
    const acceptSkipStreak = Number((acceptSkipBeat?.counts as { streak?: number } | undefined)?.streak) || 0;
    // Inject fold data
    const { acceptanceCount, oldestAcceptanceHours } = computeAcceptanceDebt(foldResult, now);
    probes.fold = () => ({
      unrouted: { count: unroutedItems.length, oldestMin: oldestUnroutedMin },
      oldestAcceptanceHours,
      oldestDecisionHours: undefined,
      acceptanceCount,
      acceptSkipStreak,
      decisionCount: parkedItems.filter(isDecisionPark).length,
      queueStallStreak,
      noCommitParkCount24h,
    });

    // Inject spend probe when a daily budget ceiling is configured.
    // Uses the already-loaded opsEvents (cost.usage events live on the ops ledger);
    // allEvents covers the full ledger so dispatch spend is included.
    const sloWithCeiling: SloConfig = { ...cfg.slo };
    // Work-shaped dispatch wedge threshold: a dispatch beat may legitimately hold its lock
    // for (items it can drain this beat) × buildTimeout, not a flat 55 min — the flat
    // threshold once read a live multi-item beat as wedged and kickstart-killed it. Shape =
    // items currently building + queued (what the running/next beat could serially drain).
    if (sloWithCeiling.dispatchWedgeSec === undefined) {
      const workShape = items.filter(r => r.state === 'building' || r.state === 'queued').length;
      sloWithCeiling.dispatchWedgeSec = dispatchWedgeSecFor(Math.max(1, workShape), cfg.buildTimeoutMinutes);
    }
    if (cfg.ci?.reenableOn) {
      sloWithCeiling.ciReenableOn = cfg.ci.reenableOn;
    }
    const dispatchCeiling = cfg.budget?.dispatchDailyUsd;
    if (dispatchCeiling !== undefined && Number.isFinite(dispatchCeiling) && dispatchCeiling > 0) {
      sloWithCeiling.dispatchDailyUsdCeiling = dispatchCeiling;
      if (!probes.todayDispatchSpendUsd) {
        const today = new Date(now).toISOString().slice(0, 10);
        const spend = spendForDay(allEvents, today);
        probes.todayDispatchSpendUsd = () => spend;
      }
    }

    // Inject provider health probe.
    // Use the injected probe from tests; otherwise derive from the live registry.
    if (!probes.providerHealth) {
      if (opts.providerHealthProbe) {
        probes.providerHealth = opts.providerHealthProbe;
      } else if (providerRegistry) {
        // Derive from the registry: check the internal chain for health.
        // Capture registry reference so the closure is stable even if the outer
        // variable is reassigned (it isn't, but this satisfies TypeScript's control-flow).
        const reg = providerRegistry;
        probes.providerHealth = () => {
          // TRUST-HARDENING (defect c): this is a PLANE-LEVEL health readout of the reference
          // ('internal') routing lane for the SLO board — it reads on-disk health markers only and
          // sends NO item text, no repo material, to any provider. Resolving a per-item sensitivity
          // here is meaningless (there is no item); 'internal' is the correct, justified literal for
          // "is the primary routing lane healthy". Per-item fail-closed resolution happens at the
          // actual routing/build call sites (stepRoute, dispatch), not in this observability probe.
          const chain = reg.chainFor('internal');
          if (chain.length === 0) return { status: 'all-unhealthy' as const };
          const primary = chain[0]!;
          const primaryHealthy = !reg.isUnhealthy(primary);
          if (primaryHealthy) return { status: 'primary-healthy' as const, primaryProvider: primary, activeProvider: primary };
          // Primary is down — check the rest of the chain
          const allowed = reg.allowedProviders('internal');
          for (let i = 1; i < chain.length; i++) {
            const name = chain[i]!;
            if (!allowed.includes(name)) continue;
            if (!reg.isUnhealthy(name)) {
              return { status: 'fallback-active' as const, primaryProvider: primary, activeProvider: name };
            }
          }
          return { status: 'all-unhealthy' as const, primaryProvider: primary };
        };
      }
    }

    const board = evaluateSloBoard(sloWithCeiling, probes, opsEvents);

    // Derive last-known state from ops ledger
    const prevState = deriveSloState(opsEvents);

    const events: LedgerEvent[] = [];

    // Edge-triggered: emit slo.breach on green→red, slo.recovered on red→green
    for (const row of board) {
      const prev = prevState.get(row.key);
      const isBreach = row.status === 'breached';
      const wasBreached = prev === 'breached';

      if (isBreach && !wasBreached) {
        events.push(makeEvent('reactor', 'system', 'slo.breach', {
          indicator: row.key,
          value: row.detail ?? row.value,
          target: row.target,
        }));
      } else if (!isBreach && wasBreached) {
        events.push(makeEvent('reactor', 'system', 'slo.recovered', {
          key: row.key,
        }));
      }
    }

    // Edge-triggered loop.beat: write lastbeat.json every beat (liveness/latest-result);
    // only append a ledger event when the counts materially change (activity transition)
    // or on first boot (no previous lastbeat.json).  Idle ticks stop accumulating.
    const building = items.filter(r => r.state === 'building');
    const beatCounts = {
      total: foldResult.items.size,
      queued: items.filter(r => r.state === 'queued').length,
      building: building.length,
      parked: items.filter(r => r.state === 'parked').length,
      merged: items.filter(r => r.state === 'merged').length,
      breached: board.filter(r => r.status === 'breached').map(r => r.key),
    };
    const prevBeat = readLastbeat(runsDir, 'reactor');
    const beatTs = new Date().toISOString();
    if (!opts.dryRun) {
      writeLastbeat(runsDir, 'reactor', beatCounts, beatTs);
    }
    if (countsChanged(prevBeat?.counts, beatCounts)) {
      // Material change: record this transition in the permanent ledger
      events.push(makeEvent('reactor', 'system', 'loop.beat', {
        loop: 'reactor',
        result: JSON.stringify(beatCounts),
      }));
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    const newBreaches = events.filter(e => e.type === 'slo.breach').length;
    const newRecovers = events.filter(e => e.type === 'slo.recovered').length;
    return {
      board,
      dispatchWedgeSec: sloWithCeiling.dispatchWedgeSec,
      result: {
        step,
        ok: true,
        eventsWritten: events.length,
        mdWritten: false,
        detail: `${newBreaches} new breach(es), ${newRecovers} recover(s)`,
      },
    };
  } catch (e) {
    return {
      board: [],
      result: { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) },
    };
  }
}

// ---------------------------------------------------------------------------
// Step (f): HEAL — runbook lookup, propose/execute per OPS_AUTONOMY
// ---------------------------------------------------------------------------

/**
 * Anti-flap: count heal.executed events for a key in the rolling 6 h window.
 */
function healCountInWindow(key: string, opsEvents: LedgerEvent[], windowMs: number, now: number): number {
  return opsEvents.filter(ev =>
    ev.item === 'system' &&
    ev.type === 'heal.executed' &&
    (ev.data as { key?: string }).key === key &&
    now - new Date(ev.ts).getTime() < windowMs,
  ).length;
}

/** True if a heal.graduated event exists for this key */
function isGraduated(key: string, opsEvents: LedgerEvent[]): boolean {
  return opsEvents.some(ev =>
    ev.item === 'system' &&
    ev.type === 'heal.graduated' &&
    (ev.data as { key?: string }).key === key,
  );
}

/** True if a nudge/escalate for this key was sent recently (dedup: 1 per 6 h) */
function wasPushedRecently(key: string, opsEvents: LedgerEvent[], windowMs: number, now: number): boolean {
  return opsEvents.some(ev =>
    ev.item === 'system' &&
    (ev.type === 'heal.escalated') &&
    (ev.data as { key?: string }).key === key &&
    now - new Date(ev.ts).getTime() < windowMs,
  );
}

/** Build the real spawn adapter from spawnSync */
function makeSpawnAdapter(repoRoot: string): (cmd: string, args: string[]) => { ok: boolean; output: string } {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 15_000 });
    const output = ((r.stdout?.toString() ?? '') + (r.stderr?.toString() ?? '')).trim();
    return { ok: r.status === 0, output };
  };
}

async function stepHeal(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
  board: SloRow[],
  opsEvents: LedgerEvent[],
  dispatchWedgeSec?: number,
): Promise<StepResult> {
  const step = 'heal';
  try {
    const opsAutonomy = opts.opsAutonomy
      ?? (process.env['OPS_AUTONOMY'] as 'watch' | 'propose' | 'heal' | undefined)
      ?? 'propose';

    if (opsAutonomy === 'watch') {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'OPS_AUTONOMY=watch — heal disabled' };
    }

    const now = Date.now();
    const ANTI_FLAP_WINDOW = 6 * 60 * 60 * 1000; // 6 h
    const MAX_HEALS_PER_WINDOW = 3;
    const NUDGE_DEDUP_WINDOW = 6 * 60 * 60 * 1000;

    // Derive last-known state for breach check
    const prevState = deriveSloState(opsEvents);

    // Build spawn adapter
    const spawnFn = opts.runbookSpawn ?? makeSpawnAdapter(opts.repoRoot);

    // Notification hook
    const notifyHookPath = join(opts.repoRoot, cfg.notifyHook);
    const notifyFn = opts.notify ?? ((msg: string) => {
      if (existsSync(notifyHookPath)) {
        try {
          spawnSync(notifyHookPath, [msg], { stdio: 'pipe', timeout: 10_000 });
        } catch { /* best-effort */ }
      }
    });

    const events: LedgerEvent[] = [];
    let healsProposed = 0;
    let healsExecuted = 0;
    let nudgesSent = 0;
    let healsShadowed = 0;

    for (const row of board) {
      if (row.status !== 'breached') continue;

      const runbook = getRunbook(row.key);
      if (!runbook) continue; // no runbook for this key → ignore

      // Shadow mode: a rule's mode is read fresh from config every beat (never
      // cached) — 'shadow' records what the rule WOULD have done and takes no action at
      // all (no notify, no propose, no execute, no anti-flap bookkeeping). Appends
      // unconditionally: this is pure telemetry, not an action, so it needs no dedup.
      if (resolveHealMode(row.key, cfg.healRules) === 'shadow') {
        events.push(makeEvent('reactor', 'system', 'heal.shadowed', {
          key: row.key,
          action: runbook.action,
          wouldHave: runbook.tier,
        }));
        healsShadowed++;
        continue;
      }

      const tier = runbook.tier;

      if (tier === 'nudge') {
        // Deduplicate: only nudge once per NUDGE_DEDUP_WINDOW
        if (!wasPushedRecently(row.key, opsEvents, NUDGE_DEDUP_WINDOW, now)) {
          notifyFn(`[loopkit] ${row.key} breached: ${row.value} — ${runbook.action}`);
          // Emit a heal.proposed for the nudge so it's visible
          events.push(makeEvent('reactor', 'system', 'heal.proposed', {
            key: row.key,
            action: runbook.action,
            tier,
            detail: row.value,
          }));
          // Record the escalation for dedup (reuse heal.escalated for nudge dedup too)
          events.push(makeEvent('reactor', 'system', 'heal.escalated', {
            key: row.key,
            reason: `nudge sent: ${row.value}`,
            count: 1,
          }));
          nudgesSent++;
        }
        continue;
      }

      if (tier === 'escalate') {
        if (!wasPushedRecently(row.key, opsEvents, NUDGE_DEDUP_WINDOW, now)) {
          notifyFn(`[loopkit] ESCALATE ${row.key}: ${row.value}`);
          events.push(makeEvent('reactor', 'system', 'heal.escalated', {
            key: row.key,
            reason: row.value,
            count: 1,
          }));
          nudgesSent++;
        }
        continue;
      }

      // tier === 'auto-heal'
      const day1Exempt = runbook.day1Exempt === true;
      const shouldExecute = runbook.execute !== undefined && (
        opsAutonomy === 'heal' ||
        isGraduated(row.key, opsEvents) ||
        day1Exempt
      );

      if (!shouldExecute) {
        // propose mode — write heal.proposed, skip execution
        events.push(makeEvent('reactor', 'system', 'heal.proposed', {
          key: row.key,
          action: runbook.action,
          tier,
          detail: row.value,
        }));
        healsProposed++;
        continue;
      }

      // Execute mode — check anti-flap first
      const executedCount = healCountInWindow(row.key, opsEvents, ANTI_FLAP_WINDOW, now);
      if (executedCount >= MAX_HEALS_PER_WINDOW) {
        // Anti-flap: escalate
        if (!wasPushedRecently(row.key, opsEvents, ANTI_FLAP_WINDOW, now)) {
          notifyFn(`[loopkit] anti-flap escalation for ${row.key}: healed ${executedCount} times in 6h without recovery`);
          events.push(makeEvent('reactor', 'system', 'heal.escalated', {
            key: row.key,
            reason: `anti-flap: ${executedCount} heals in 6h`,
            count: executedCount,
          }));
        }
        continue;
      }

      // Execute the runbook
      const ctx: RunbookContext = {
        spawn: spawnFn,
        repoRoot: opts.repoRoot,
        runDir: resolveRunDir(opts),
        key: row.key,
        detail: row.detail,
        reactorLabel: cfg.loops.reactorLabel,
        dispatchLabel: cfg.loops.dispatchLabel,
        // Work-shaped wedge threshold (stepSloEvaluate computes it once per beat) — the
        // loop-dispatch runbook's lock-clear must use the SAME threshold the SLO board
        // classified with, never a divergent flat constant.
        ...(dispatchWedgeSec !== undefined ? { dispatchWedgeMs: dispatchWedgeSec * 1000 } : {}),
      };

      if (opts.dryRun) {
        events.push(makeEvent('reactor', 'system', 'heal.proposed', {
          key: row.key,
          action: runbook.action,
          tier,
          detail: `dry-run: ${row.value}`,
        }));
        healsProposed++;
        continue;
      }

      try {
        const evidence = await runbook.execute!(ctx);
        events.push(makeEvent('reactor', 'system', 'heal.executed', {
          key: row.key,
          action: runbook.action,
          evidence,
          revert: runbook.revert,
        }));
        healsExecuted++;
      } catch (err) {
        // Execution failed — escalate
        notifyFn(`[loopkit] heal failed for ${row.key}: ${err}`);
        events.push(makeEvent('reactor', 'system', 'heal.escalated', {
          key: row.key,
          reason: `execution failed: ${err}`,
          count: executedCount + 1,
        }));
      }
    }

    if (!opts.dryRun && events.length > 0) {
      await appendEvents(opts.ledgerDir, events);
    }

    return {
      step,
      ok: true,
      eventsWritten: events.length,
      mdWritten: false,
      detail: `proposed=${healsProposed} executed=${healsExecuted} nudges=${nudgesSent} shadowed=${healsShadowed} autonomy=${opsAutonomy}`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Step (g): self-arming trigger map
//
// Evaluate every armed predicate; on a false→true edge (dedup by a stable armed-id)
// emit item.captured so the deferred step flows through normal routing/dispatch.
// - Non-escalation payloads queue directly (the payload already carries the routing
//   decision — spec/touches/priority — so the conductor is skipped; there is no operator
//   to reply to). Dispatch picks it up Touches-disjoint next beat.
// - Escalation-class payloads (priority 'escalation') park for the operator.
// Id allocation + append run under the ledger lock so an armed capture can't collide
// with a concurrent `loopctl new` (both read maxWiNum then append) — mirrors cli `new`.
// ---------------------------------------------------------------------------

async function stepArmed(
  opts: ReactorOptions,
  cfg: LoopkitConfig,
): Promise<StepResult> {
  const step = 'armed';
  try {
    const armed = cfg.armed ?? [];
    if (armed.length === 0) {
      return { step, ok: true, eventsWritten: 0, mdWritten: false, detail: 'no armed predicates' };
    }
    const probe = opts.armedProbe ?? makeArmedProbe(opts.repoRoot);

    let written = 0;
    let fired = 0;
    await withLock(opts.ledgerDir, async (tx) => {
      const allEvents = await tx.loadAll();

      // Edge dedup: an armed-id that already produced an item.captured never fires again.
      const alreadyFired = new Set<string>();
      for (const ev of allEvents) {
        if (ev.type === 'item.captured') {
          const aId = (ev.data as { armedId?: string }).armedId;
          if (typeof aId === 'string' && aId) alreadyFired.add(aId);
        }
      }

      const firings = evaluateArmed(armed, alreadyFired, probe);
      if (firings.length === 0) return;

      const result = fold(allEvents);
      let nextNum = result.maxWiNum;
      const events: LedgerEvent[] = [];
      for (const f of firings) {
        nextNum += 1;
        const wiId = `WI-${String(nextNum).padStart(3, '0')}`;
        events.push(makeEvent('reactor', wiId, 'item.captured', {
          source: `armed:${f.armedId}`,
          text: f.capture.text,
          armedId: f.armedId,
        }));
        if (f.escalation) {
          // Costly-AND-irreversible armed payloads park for the operator, never auto-build.
          events.push(makeEvent('reactor', wiId, 'item.parked', {
            reason: `armed trigger ${f.armedId} fired (escalation): ${f.capture.text}`,
            parkKind: 'decision',
          }));
        } else {
          const queued: ItemQueuedData = { spec: f.capture.text };
          if (f.capture.touches) queued.touches = f.capture.touches;
          if (f.capture.priority) queued.priority = f.capture.priority;
          events.push(makeEvent('reactor', wiId, 'item.queued', queued));
        }
        fired += 1;
      }

      if (!opts.dryRun && events.length > 0) {
        await tx.append(events);
        written = events.length;
        if (events.some((e) => e.type === 'item.queued')) (opts.kickDispatch ?? kickDispatch)(cfg.dispatchKickLabel);
      }
    });

    return {
      step,
      ok: true,
      eventsWritten: written,
      mdWritten: false,
      detail: fired === 0 ? 'no armed edges' : `fired ${fired} armed trigger(s)`,
    };
  } catch (e) {
    return { step, ok: false, eventsWritten: 0, mdWritten: false, detail: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runReactor(opts: ReactorOptions): Promise<ReactorResult> {
  // Autonomy gate — fail-safe: an unset LOOPKIT_AUTONOMY defaults to OFF (not on).
  // The launchd shims source .ai/loops/config.env which sets it explicitly, so production
  // behaviour is unchanged. Bare/cron/test invocations without the env set are safe-by-default.
  const envVal = process.env['LOOPKIT_AUTONOMY'];
  if (opts.autonomy === undefined && envVal === undefined) {
    process.stderr.write('[loopkit] LOOPKIT_AUTONOMY unset — defaulting to OFF (fail-safe); set it in .ai/loops/config.env\n');
  }
  const autonomy = opts.autonomy ?? (envVal ?? 'off');
  // Resolved run-state root for this plane — computed ONCE here and used for every
  // run-state site below (lock, regression-guard watermarks, health markers).
  const runDir = resolveRunDir(opts);
  // Liveness signal for the ops-console heartbeat probe (read as <runs>/reactor/lastrun —
  // the beat's own lastrun dir is a SIBLING of the loopkit dir under the same runs root).
  try {
    const lastrunDir = join(dirname(runDir), 'reactor');
    mkdirSync(lastrunDir, { recursive: true });
    writeFileSync(join(lastrunDir, 'lastrun'), String(Math.floor(Date.now() / 1000)), 'utf8');
  } catch { /* non-fatal */ }
  if (autonomy === 'off') {
    return {
      dryRun: opts.dryRun ?? false,
      steps: [{ step: 'autonomy-gate', ok: true, eventsWritten: 0, mdWritten: false, detail: 'LOOPKIT_AUTONOMY=off — no-op' }],
      totalEventsWritten: 0,
    };
  }

  // Load config
  const cfg = opts.config ?? loadConfig(opts.repoRoot);

  // Acquire lock
  mkdirSync(runDir, { recursive: true });
  const lock = acquireReactorLock(runDir);
  if (!lock) {
    return {
      dryRun: opts.dryRun ?? false,
      steps: [{ step: 'lock', ok: false, eventsWritten: 0, mdWritten: false, detail: 'reactor already running (lock held)' }],
      totalEventsWritten: 0,
    };
  }
  const lockPath = lock.lockPath;

  try {
    // Halt BEFORE any step touches a truncated ledger — a re-fold
    // of a shrunk file looks identical to "nothing new happened" and would let the doctor
    // silently re-dispatch already-merged work (a ledger-wipe incident class).
    if (!opts.dryRun) {
      const regressionGuard = await checkLedgerRegressionGuard({
        repoRoot: opts.repoRoot,
        ledgerDir: opts.ledgerDir,
        runDir,
        loop: 'reactor',
        notifyHook: cfg.notifyHook,
        notify: opts.notify,
        readMaxIds: opts.ledgerMaxIdsProbe,
      });
      if (regressionGuard.halted) {
        return {
          dryRun: false,
          steps: [{
            step: 'ledger-regression-guard', ok: false, eventsWritten: 0, mdWritten: false,
            detail: regressionGuard.detail,
          }],
          totalEventsWritten: 0,
        };
      }
    }

    // Resolve provider for routing step (health-aware).
    // Routing uses tools=['Read','Grep','Glob'] for normal operation. When the primary
    // provider is unhealthy, we fall back to a tool-less provider (e.g. ollama) if configured
    // in the internal chain. The degraded routing prompt prepends a note about tool unavailability.
    let provider: LlmProvider | null = null;
    let providerRegistry = null as ReturnType<typeof makeRegistry> | null;
    let routingDegraded = false;   // true when the resolved provider lacks tools

    if (opts.provider !== undefined) {
      provider = opts.provider;
      // When a provider is injected, check its supportsTools flag for degraded routing.
      // supportsTools=undefined defaults to true (backwards-compat with test fakes).
      routingDegraded = provider !== null && provider.supportsTools === false;
    } else {
      // No explicit override — resolve from registry with health-awareness
      const healthFns = opts.readMarker
        ? { readMarker: opts.readMarker, writeMarker: opts.writeMarker, clearMarker: opts.clearMarker }
        : makeFileHealthFns(runDir);
      providerRegistry = makeRegistry({
        providers: Object.fromEntries(
          Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }])
        ),
        sensitivityAllowlists: cfg.sensitivityAllowlists,
        chains: cfg.chains,
        cooldownMs: cfg.providerCooldownMs,
      }, healthFns);

      // Plane-baseline resolution: 'internal' is the reference lane used only to (a) decide whether
      // ANY provider exists for this beat and (b) supply the engagement-step provider. TRUST-
      // HARDENING (defect c): the ROUTING step no longer routes items through this global provider —
      // it re-resolves EACH item against the item's own sensitivity fail-closed (stepRoute, given
      // providerRegistry below). So a 'private' item is never sent through this 'internal'-resolved
      // provider; this literal only gates plane liveness + the reference degraded-mode flag.
      provider = providerRegistry.resolveWithHealth('internal', { requireTools: true });
      if (!provider) {
        // No tool-capable provider available — try without tools (degraded routing)
        provider = providerRegistry.resolveWithHealth('internal', { requireTools: false });
        routingDegraded = provider !== null;
      }
    }

    const steps: StepResult[] = [];

    // Long-beat heartbeat (mirror of dispatch's between-items stamp): the reactor's step
    // loop can run long too (routing/engagement steps make provider calls per item), so
    // refresh the mid-beat liveness stamp between steps — the staleness probe prefers it
    // over the beat-start lastrun, and a truly frozen beat stops refreshing it.
    const pushStep = (r: StepResult): void => {
      steps.push(r);
      if (!opts.dryRun) writeBeatHeartbeat(runDir, 'reactor');
    };

    // A stale lock (dead/missing owner pid, or wedged by age) was reclaimed during
    // acquisition — surface it as a step so the recovery is visible in the beat detail.
    if (lock.reclaimed) {
      steps.push({
        step: 'lock', ok: true, eventsWritten: 0, mdWritten: false,
        detail: `reclaimed stale lock (${lock.reclaimedWhy})`,
      });
      process.stderr.write(`[reactor] reclaimed stale lock (${lock.reclaimedWhy})\n`);
    }

    // Step (a2): deterministic decomposition-unpark handler (zero-LLM; MUST run
    // before stepRoute so a just-unparked decomposition-park never re-enters the classifier)
    // Step (a1.5): auto-close a decomposition-parked epic once its rest-park
    // reason references a planning child that already existed as of the START of this beat.
    // MUST run BEFORE stepDecompositionUnpark: that step's own rest-park (freshly written this
    // beat) must survive at least one beat before grooming considers it superseded — closing it
    // in the very same beat it rests would contradict the "epic rests, tracked by the child"
    // contract (an unpark test asserts the epic stays parked post-unpark).
    pushStep(await stepDecompositionGrooming(opts, cfg));

    pushStep(await stepDecompositionUnpark(opts, cfg));

    // Step (a2): WI-098 cross-target pattern promotion — a merged item whose certification names
    // OTHER registered targets its pattern applies to gets a sibling item captured on each (parked
    // as decision when product-shaped, queued when mechanical), so the harvest lands as durable
    // per-target work. Advisory-nudges an ADR/incident merge that owed a portability note but
    // shipped without one. Idempotent per (source, target).
    pushStep(await stepPortabilityPromotion(opts, cfg));

    // Step (b): route new captured items (degraded = tool-less fallback active). TRUST-HARDENING
    // (defect c): pass the registry so routing resolves EACH item's own sensitivity fail-closed,
    // not the beat's single hardcoded-'internal' provider.
    pushStep(await stepRoute(opts, cfg, provider, routingDegraded, providerRegistry));

    // Step (b1.5): engage operator replies on work-item threads (after route so a just-routed
    // item's first reply is visible; before accept so an answered/held reply is causation-current)
    pushStep(await stepEngageReplies(opts, cfg, provider, providerRegistry));

    // Step (b1.8): bounded auto-requeue of no-commit ops-parks (before auto-approve;
    // requeued items are 'queued' by the time auto-approve scans, so ordering is cosmetic but
    // keeps the ops-only requeue lane visibly ahead of the operator-approval lane)
    pushStep(await stepUnparkOpsRequeue(opts, cfg));

    // Step (b1.9): WI-084 the park pathologist — the deterministic no-commit requeue lane above
    // runs first (cheap, no LLM); pathology handles the REMAINING failure parks that lane didn't
    // already requeue (before auto-approve, since a diagnosed-and-requeued item is 'queued' by
    // the time auto-approve scans — ordering keeps this LLM lane visibly ahead of that one).
    pushStep(await stepPathology(opts, cfg, provider, providerRegistry));

    // Step (b2): auto-approve delegated park classes (before apply-verbs merges them)
    pushStep(await stepAutoApprove(opts, cfg));

    // Step (c): apply operator verbs
    pushStep(await stepApplyVerbs(opts, cfg));

    // Step (c2): notify once per needs-decision park (AFTER apply-verbs so
    // auto-approved-then-merged items are already in 'merged' state and never pushed)
    pushStep(await stepNotifyDecisionParks(opts, cfg));

    // Step (c3): escalation-format grooming bounce (WI-056) — a decision park with no
    // structured escalation payload and a bare-question-shaped reason gets bounced once,
    // asking the producer to restate with intent (leader-leader doctrine).
    pushStep(await stepEscalationGrooming(opts, cfg));

    // Step (d): doctor sweep
    pushStep(await stepDoctor(opts, cfg));

    // Step (d1): tier calibration (before accept — recalibrated windows
    // must be current for this beat's accept decisions)
    pushStep(await stepTierCalibration(opts, cfg));

    // Step (d2): provisional acceptance (after doctor — plane health confirmed above)
    pushStep(await stepProvisionalAccept(opts, cfg));

    // Step (d3): needs-test phone push — notify once per merged item landing in a
    // review/must acceptance tier (after provisional-accept so tiering reflects any
    // calibration/window change made earlier this beat)
    pushStep(await stepNotifyNeedsTest(opts, cfg));

    // Load ops ledger for SLO state derivation (only ops segment needed)
    const opsEvents = await loadAllEventsWithQuarantine(opts.ledgerDir);
    const opsOnly = opsEvents.filter(ev =>
      ev.type.startsWith('slo.') ||
      ev.type.startsWith('heal.') ||
      ev.type === 'loop.beat' ||
      ev.type === 'cost.usage',
    );

    // Step (e): SLO evaluate (edge-triggered breach + recover)
    const { result: sloResult, board, dispatchWedgeSec } = await stepSloEvaluate(opts, cfg, opsOnly, providerRegistry);
    pushStep(sloResult);

    // Step (f): HEAL step (given the beat's work-shaped dispatch wedge threshold so the
    // loop-dispatch runbook clears locks on the SAME threshold the board classified with)
    pushStep(await stepHeal(opts, cfg, board, opsOnly, dispatchWedgeSec));

    // Step (g): self-arming trigger map — fire item.captured on predicate false→true edges
    pushStep(await stepArmed(opts, cfg));

    const totalEventsWritten = steps.reduce((s, r) => s + r.eventsWritten, 0);
    return { dryRun: opts.dryRun ?? false, steps, totalEventsWritten };
  } finally {
    // Commit ledger residue every beat (not just on a clean exit —
    // `finally` also covers the regression-guard halt and any thrown error) so the uncommitted
    // window is bounded to one beat cycle instead of hours. No-ops when the ledger is clean.
    if (!opts.dryRun) {
      const commitFn = opts.commitResidue ?? commitLedgerResidue;
      const commitResult = commitFn(opts.repoRoot, opts.ledgerDir, 'reactor');
      if (commitResult.committed) {
        process.stderr.write(`[reactor] ${commitResult.detail}\n`);
      }
    }
    releaseReactorLock(lockPath);
  }
}
