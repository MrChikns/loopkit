/**
 * slo.ts — The ONE SLO evaluator for loopkit.
 *
 * Keyed to the live loopkit plane (reactor + dispatch + optional freshness probes);
 * stale keys are retired as the plane evolves.
 *
 * SloRow is a stable shape so a console can render `loopctl slo --json`
 * directly with minimal glue.
 *
 * ALL I/O is injected: no direct fs/spawn/http calls here.
 * Every failed probe degrades to an "unknown" row — never crashes.
 */

import type { LedgerEvent } from './schema.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type SloStatus = 'met' | 'at-risk' | 'breached' | 'unknown';

export interface SloRow {
  key: string;
  label: string;
  value: string;   // measured, human-readable
  target: string;  // the SLO target
  status: SloStatus;
  detail?: string; // optional machine-readable measurement (e.g. raw number)
  /** Graduation info (see makeGraduationCounter below) */
  graduation?: {
    cleanDays: number;
    eligible: boolean; // cleanDays >= 14 OR a heal.graduated event exists for this key
    /** Calendar days with >=1 heal.shadowed for this key — shadow-mode burn-in
     *  visibility, tracked separately from cleanDays (which only counts heal.proposed
     *  days) so a rule's shadow calibration trend is visible before it is ever armed. */
    shadowDays: number;
  };
}

// ---------------------------------------------------------------------------
// SLO config (targets, instance ports, expected launchd labels)
// ---------------------------------------------------------------------------

export interface SloConfig {
  /** Max age of reactor lastrun before breach (seconds). Default: 10 × 30s = 300 */
  reactorFreshSec?: number;
  /** Max age of dispatch lastrun before breach (seconds). Default: 10 × 60s = 600 */
  dispatchFreshSec?: number;
  /** Max age of deploy commit not yet in the deploy-target checkout (hours). Default: 1 */
  deployBehindHours?: number;
  /** Max backup age (hours). Default: 26 */
  backupMaxHours?: number;
  /** Max nightly watcher report age (hours). Default: 26 */
  watchNightlyMaxHours?: number;
  /** Max hourly watcher report age (hours). Default: 2 */
  watchHourlyMaxHours?: number;
  /** Max acceptance-backlog age (hours). Default: 48 */
  acceptanceMaxHours?: number;
  /** Max decisions-waiting age (hours). Default: 72 */
  decisionMaxHours?: number;
  /** Max unrouted intent age (minutes). Default: 15 */
  unroutedMaxMin?: number;
  /** Max routing worst latency (minutes). Default: 15 */
  routingWorstMin?: number;
  /** atRiskFraction: value >= target * fraction → amber. Default: 0.8 */
  atRiskFraction?: number;
  /**
   * Consecutive dispatch beats a non-empty queue must show zero dispatchable
   * items before queue-stall breaches. Default: 3.
   */
  queueStallConsecutiveBeats?: number;
  /**
   * No-commit-reason park events in the trailing 24h before no-commit-park
   * breaches (systemic worker/allowlist failure). Default: 3.
   */
  noCommitParkThreshold?: number;
  /**
   * Minimum local-ahead commit count (from `git rev-list --left-right --count
   * master...origin/master`) for a beat to count as "diverged" when the reactor accumulates
   * the divergenceAheadStreak it injects via FoldProbeData. Not consumed directly by this
   * evaluator (which only classifies the pre-computed streak) — kept here so the threshold
   * is one config knob, not split across files. Default: 1.
   */
  divergenceAheadThreshold?: number;
  /**
   * Consecutive beats master must show >= divergenceAheadThreshold local-ahead
   * commits before the divergence SLO breaches (a stuck-merge / failed-push signal, same
   * streak shape as queueStallConsecutiveBeats). Default: 3.
   */
  divergenceAheadConsecutiveBeats?: number;
  /**
   * Consecutive reactor beats stepProvisionalAccept must skip tier accepts
   * (SLO smoke check unhealthy) before the 'accept-skip' row breaches — this silent-stall
   * class would otherwise only show up as an inflating acceptance backlog, hours later. Same
   * streak shape as queueStallConsecutiveBeats. Default: 3.
   */
  acceptSkipConsecutiveBeats?: number;
  /**
   * Reactor lock age (seconds) past which a held lock reads as a wedged beat rather
   * than a beat in flight. Default: 20 min.
   */
  reactorWedgeSec?: number;
  /**
   * Dispatch lock age (seconds) past which a held lock reads as a wedged beat.
   * The reactor beat injects a work-shaped value here (see dispatchWedgeSecFor: items the
   * beat may drain × build timeout + headroom) instead of trusting the flat default — a
   * flat threshold tuned for crash-orphaned locks once killed a LIVE multi-item beat.
   * Default: 55 min (1 item × 40-min build timeout + 15-min headroom).
   */
  dispatchWedgeSec?: number;

  /** Expected launchd labels to be loaded */
  expectedLaunchdLabels?: string[];
  /** Instance HTTP probe URLs (key → url) */
  instanceProbes?: Record<string, string>;
  /**
   * Daily dispatch budget ceiling in USD. When set, a `spend` SLO row is
   * included that breaches when today's dispatch spend reaches or exceeds this value.
   * Absent = no spend row emitted.
   */
  dispatchDailyUsdCeiling?: number;
  /**
   * ISO date (YYYY-MM-DD) after which the reactor's ci-reenable heal runbook
   * should re-enable the paused cloud CI workflows. Mirrors config.ts LoopkitConfig.ci.reenableOn
   * (injected here by the beat, same pattern as dispatchDailyUsdCeiling). Absent = no row emitted.
   */
  ciReenableOn?: string;
}

export const SLO_DEFAULTS: Required<Omit<SloConfig, 'expectedLaunchdLabels' | 'instanceProbes' | 'dispatchDailyUsdCeiling' | 'ciReenableOn'>> = {
  reactorFreshSec: 300,       // 10 × 30 s
  dispatchFreshSec: 600,      // 10 × 60 s
  deployBehindHours: 1,
  backupMaxHours: 26,
  watchNightlyMaxHours: 26,
  watchHourlyMaxHours: 2,
  acceptanceMaxHours: 48,
  decisionMaxHours: 72,
  unroutedMaxMin: 15,
  routingWorstMin: 15,
  atRiskFraction: 0.8,
  queueStallConsecutiveBeats: 3,
  noCommitParkThreshold: 3,
  divergenceAheadThreshold: 1,
  divergenceAheadConsecutiveBeats: 3,
  acceptSkipConsecutiveBeats: 3,
  reactorWedgeSec: 20 * 60,
  dispatchWedgeSec: 55 * 60,
};

/**
 * Work-shaped dispatch wedge threshold (seconds): the longest a dispatch beat could
 * legitimately hold its lock is bounded by how many items it may drain serially this beat
 * × the per-build timeout, plus headroom for worktree/gate/merge overhead. With the
 * defaults (cap 1 × 40 min + 15 min) this reproduces the old flat 55-min threshold, so an
 * unshaped plane behaves exactly as before. ONE formula — the SLO evaluator, the
 * loop-dispatch heal runbook, and any watchdog must all derive from here, never re-hardcode.
 */
export function dispatchWedgeSecFor(
  perBeatItemCap: number,
  buildTimeoutMinutes: number,
  headroomMin = 15,
): number {
  const cap = Math.max(1, Math.floor(perBeatItemCap));
  const timeout = Math.max(1, buildTimeoutMinutes);
  return cap * timeout * 60 + headroomMin * 60;
}

// ---------------------------------------------------------------------------
// Injectable probe interfaces
// ---------------------------------------------------------------------------

/** Result of reading a lastrun file (seconds epoch, or undefined if absent/unreadable) */
export type LastrunProbe = () => number | undefined;

/** Result of `launchctl list` parse */
export interface LaunchdJob {
  label: string;
  loaded: boolean;
  running: boolean;
  lastExit: number | null;
}
export type LaunchdProbe = () => LaunchdJob[] | undefined;

/** HTTP health probe: true = up, false = down, undefined = failed to check */
export type HttpProbe = (url: string) => boolean | undefined;

/** Backup age in hours (undefined = unknown) */
export type BackupAgeProbe = () => number | undefined;

/** Watch report mtime (ms epoch, 0 = absent, undefined = unknown) */
export type WatchMtimeProbe = () => number | undefined;

/** Deploy status */
export interface DeployStatus {
  behindCount: number;
  oldestUndeployedMs?: number;
}
export type DeployProbe = () => DeployStatus | undefined;

/**
 * `git rev-list --left-right --count master...origin/master` parsed into named
 * counts — left = commits on local master not yet on origin (a stuck-merge / failed-push
 * signal), right = commits on origin not yet on local. Never spawned from this evaluator;
 * the beat injects the result (see makeDivergenceProbe below for the real implementation).
 */
export interface DivergenceCounts {
  localAhead: number;
  originAhead: number;
}
export type DivergenceProbe = () => DivergenceCounts | undefined;

/** Fold-derived data for pipeline probes */
export interface FoldProbeData {
  /** Unrouted item count and oldest age in minutes */
  unrouted?: { count: number; oldestMin?: number };
  /** Oldest pending acceptance age in hours */
  oldestAcceptanceHours?: number;
  /** Oldest parked decision age in hours */
  oldestDecisionHours?: number;
  /** Total acceptance-pending count */
  acceptanceCount?: number;
  /** Total decision-pending count */
  decisionCount?: number;
  /**
   * Consecutive dispatch beats the queue was non-empty with zero dispatchable
   * items (fully Touches-serialized). 0 = currently dispatching fine.
   */
  queueStallStreak?: number;
  /** Count of item.parked events with a no-commit reason in the trailing 24h. */
  noCommitParkCount24h?: number;
  /**
   * Consecutive beats master has shown >= divergenceAheadThreshold local-ahead
   * commits (from the divergence probe), persisted by the reactor across beats the same
   * way queueStallStreak is. 0/absent-but-present-fold = currently in sync or unmeasured
   * this beat; undefined FoldProbeData entirely ⇒ the row reads 'unknown', never a breach.
   */
  divergenceAheadStreak?: number;
  /**
   * Consecutive reactor beats stepProvisionalAccept skipped tier accepts
   * because the PROVISIONAL_ACCEPT_SLO_KEYS smoke check ('loop-reactor', 'loop-dispatch',
   * 'instances') was not all 'met'. 0 = the last beat accepted normally. Persisted by the
   * reactor the same way queueStallStreak is — this evaluator only classifies it.
   */
  acceptSkipStreak?: number;
}

/**
 * One row of a configured plane-check validator's `--json` output — the deterministic
 * plane-state validator. Consumed for diagnostic detail only; the SLO breach conditions
 * themselves are computed from fold/ledger data (see FoldProbeData) so unit tests never need
 * a live shell.
 */
export interface PlaneCheckRow {
  status: string; // 'PASS' | 'WARN' | 'FAIL' | 'INFO'
  check: string;
  detail: string;
}
export type PlaneCheckProbe = () => PlaneCheckRow[] | undefined;

/**
 * Optional filesystem locations for the deployment-specific freshness probes, all relative
 * to repoRoot. Every field is opt-in: an unset path disables its SLO row rather than guessing
 * a layout, so a fork wires only the probes its own plane emits. Framework-neutral by default.
 */
export interface SloProbePaths {
  /** Directory whose mtime marks the last nightly watcher-report write. Enables `watch-nightly`. */
  watcherReportDir?: string;
  /** File whose mtime marks the last hourly watcher-report write. Enables `watch-hourly`. */
  watcherLatestReportFile?: string;
  /** Epoch-seconds stamp file written by the backup job. Enables `backup`. */
  backupLastrunFile?: string;
  /** Executable that emits deterministic plane-check rows on `--json`. Enables plane-check enrichment. */
  planeCheckScript?: string;
}

/**
 * Provider health status for the SLO provider row.
 * Determined by the dispatch/reactor beat after consulting the health registry.
 * - 'primary-healthy': the first (primary) provider in the internal chain is healthy.
 * - 'fallback-active': the primary is unhealthy but a fallback is healthy.
 * - 'all-unhealthy':   no healthy provider remains in the chain.
 */
export type ProviderHealthStatus = 'primary-healthy' | 'fallback-active' | 'all-unhealthy';

export interface ProviderProbeResult {
  status: ProviderHealthStatus;
  /** Name of the active provider (the one resolveWithHealth would return), or undefined. */
  activeProvider?: string;
  /** Name of the primary provider in the chain (first entry). */
  primaryProvider?: string;
}

/** All injected probes — any can be omitted (→ unknown row) */
export interface SloProbes {
  now?: () => number;
  reactorLastrun?: LastrunProbe;
  dispatchLastrun?: LastrunProbe;
  /**
   * Mid-beat heartbeat stamps (epoch seconds, same format as lastrun — ONE stamp
   * format). The beats refresh these BETWEEN work items in a long beat (lastrun is only
   * written at beat START), so the staleness classification prefers them: a fresh
   * heartbeat = the beat is alive and progressing, however old its lock/lastrun. A truly
   * frozen beat stops refreshing, so the wedge threshold still catches it.
   */
  reactorHeartbeat?: LastrunProbe;
  dispatchHeartbeat?: LastrunProbe;
  /** Age (sec) of the beat's mkdir lock — present = a beat is running now (or wedged). */
  reactorLockAgeSec?: () => number | undefined;
  dispatchLockAgeSec?: () => number | undefined;
  launchd?: LaunchdProbe;
  instanceProbe?: HttpProbe;
  backup?: BackupAgeProbe;
  watchNightly?: WatchMtimeProbe;
  watchHourly?: WatchMtimeProbe;
  deploy?: DeployProbe;
  fold?: () => FoldProbeData;
  /**
   * Today's dispatch spend in USD. Only evaluated when cfg.dispatchDailyUsdCeiling
   * is set. Callers inject the result of spendForDay(opsEvents, today) so no I/O is needed here.
   */
  todayDispatchSpendUsd?: () => number | undefined;
  /**
   * Provider health probe. Injected by the beat after consulting
   * the health registry; absent → 'unknown' SLO row.
   */
  providerHealth?: () => ProviderProbeResult | undefined;
  /**
   * Plane-check validator `--json` rows, injected by the beat. Used only to enrich
   * the queue-stall / no-commit-park row values with human-readable diagnostic detail —
   * breach classification itself comes from probes.fold().
   */
  planeCheck?: PlaneCheckProbe;
  /**
   * Raw local/origin-ahead commit counts, injected by the beat after consulting
   * git. Used only to enrich the divergence row's value string with a human-readable
   * count — breach classification comes from probes.fold().divergenceAheadStreak.
   */
  divergence?: DivergenceProbe;
}

// ---------------------------------------------------------------------------
// Classification helpers (lower-is-better)
// ---------------------------------------------------------------------------

function classifyMax(value: number | undefined, target: number, fraction: number): SloStatus {
  if (value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value > target) return 'breached';
  if (value >= target * fraction) return 'at-risk';
  return 'met';
}

function classifyBool(value: boolean | undefined): SloStatus {
  if (value === undefined) return 'unknown';
  return value ? 'met' : 'breached';
}

const worse = (a: SloStatus, b: SloStatus): SloStatus => {
  const rank: Record<SloStatus, number> = { met: 0, unknown: 1, 'at-risk': 2, breached: 3 };
  return rank[a] >= rank[b] ? a : b;
};

// ---------------------------------------------------------------------------
// Time formatting (compact, phone-row friendly)
// ---------------------------------------------------------------------------

function fmtMinutes(mins: number): string {
  if (!Number.isFinite(mins)) return '—';
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = mins / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.round(h / 24)}d`;
}
function fmtHours(h: number): string { return fmtMinutes(h * 60); }
function fmtSec(s: number): string { return fmtMinutes(s / 60); }

/** Strip a leading reverse-DNS-style vendor prefix (e.g. `com.example.`) from a launchd-style
 *  service label for compact display — generic, no hardcoded vendor/product prefix. */
function shortLabel(label: string): string {
  return label.replace(/^[a-z0-9-]+\.[a-z0-9-]+\./i, '');
}

// ---------------------------------------------------------------------------
// Board evaluator
// ---------------------------------------------------------------------------

export function evaluateSloBoard(
  cfg: SloConfig = {},
  probes: SloProbes = {},
  opsEvents: LedgerEvent[] = [],
): SloRow[] {
  const t = { ...SLO_DEFAULTS, ...cfg };
  const now = probes.now ? probes.now() : Date.now();
  const frac = t.atRiskFraction;
  const rows: SloRow[] = [];

  // Helper: compute graduation counters from ops ledger events for a key
  const graduationFor = makeGraduationCounter(opsEvents);

  // ── Loop liveness: reactor ───────────────────────────────────────────────
  {
    const lastrun = probes.reactorLastrun ? probes.reactorLastrun() : undefined;
    const heartbeat = probes.reactorHeartbeat ? probes.reactorHeartbeat() : undefined;
    // Prefer the heartbeat over beat-start lastrun: the beat refreshes it between
    // work items, so a long beat stays green as long as it is making progress.
    const freshest = heartbeat !== undefined && (lastrun === undefined || heartbeat > lastrun)
      ? heartbeat : lastrun;
    const ageSec = freshest !== undefined ? Math.max(0, (now / 1000) - freshest) : undefined;
    const hbAgeSec = heartbeat !== undefined ? Math.max(0, (now / 1000) - heartbeat) : undefined;
    // A fresh lock = a beat is RUNNING now; stale lastrun during a long beat is normal (lastrun
    // is written at beat start, so a long-running build reads as a false stall unless the lock
    // age is also checked — a watchdog that ignores lock age can kill a live build by mistake).
    // A very old lock = wedged (SIGKILL residue) — unless the heartbeat proves the beat is
    // still progressing between items. A truly frozen beat stops heartbeating and breaches.
    const lockAge = probes.reactorLockAgeSec ? probes.reactorLockAgeSec() : undefined;
    const WEDGE_REACTOR_SEC = t.reactorWedgeSec;
    let status: SloStatus; let value: string;
    if (lockAge !== undefined && lockAge < WEDGE_REACTOR_SEC) {
      status = 'met'; value = `beat in flight ${fmtSec(lockAge)}`;
    } else if (lockAge !== undefined && hbAgeSec !== undefined && hbAgeSec < WEDGE_REACTOR_SEC) {
      status = 'met'; value = `beat in flight ${fmtSec(lockAge)} (heartbeat ${fmtSec(hbAgeSec)} ago)`;
    } else if (lockAge !== undefined) {
      status = 'breached'; value = `wedged lock ${fmtSec(lockAge)}`;
    } else {
      status = ageSec !== undefined ? classifyMax(ageSec, t.reactorFreshSec, frac) : 'unknown';
      value = ageSec === undefined ? 'never ran' : `${fmtSec(ageSec)} ago`;
    }
    rows.push({
      key: 'loop-reactor',
      label: 'reactor · routes + heals (30 s)',
      value,
      target: `≤ ${fmtSec(t.reactorFreshSec)}`,
      status,
      detail: ageSec !== undefined ? String(Math.round(ageSec)) : undefined,
      graduation: graduationFor('loop-reactor'),
    });
  }

  // ── Loop liveness: dispatch ──────────────────────────────────────────────
  {
    const lastrun = probes.dispatchLastrun ? probes.dispatchLastrun() : undefined;
    const heartbeat = probes.dispatchHeartbeat ? probes.dispatchHeartbeat() : undefined;
    // Prefer the heartbeat over beat-start lastrun — see the loop-reactor note.
    const freshest = heartbeat !== undefined && (lastrun === undefined || heartbeat > lastrun)
      ? heartbeat : lastrun;
    const ageSec = freshest !== undefined ? Math.max(0, (now / 1000) - freshest) : undefined;
    const hbAgeSec = heartbeat !== undefined ? Math.max(0, (now / 1000) - heartbeat) : undefined;
    // Long builds hold the beat legitimately — see loop-reactor note. Wedge default = 55 min
    // (1 × buildTimeoutMinutes 40 + 15 headroom); the reactor injects a work-shaped value
    // via cfg.dispatchWedgeSec (dispatchWedgeSecFor) when the beat may drain several items.
    // A fresh mid-beat heartbeat keeps a long multi-item beat green past the lock-age wedge;
    // a truly frozen beat stops heartbeating and still breaches.
    const lockAge = probes.dispatchLockAgeSec ? probes.dispatchLockAgeSec() : undefined;
    const WEDGE_DISPATCH_SEC = t.dispatchWedgeSec;
    let status: SloStatus; let value: string;
    if (lockAge !== undefined && lockAge < WEDGE_DISPATCH_SEC) {
      status = 'met'; value = `beat in flight ${fmtSec(lockAge)}`;
    } else if (lockAge !== undefined && hbAgeSec !== undefined && hbAgeSec < WEDGE_DISPATCH_SEC) {
      status = 'met'; value = `beat in flight ${fmtSec(lockAge)} (heartbeat ${fmtSec(hbAgeSec)} ago)`;
    } else if (lockAge !== undefined) {
      status = 'breached'; value = `wedged lock ${fmtSec(lockAge)}`;
    } else {
      status = ageSec !== undefined ? classifyMax(ageSec, t.dispatchFreshSec, frac) : 'unknown';
      value = ageSec === undefined ? 'never ran' : `${fmtSec(ageSec)} ago`;
    }
    rows.push({
      key: 'loop-dispatch',
      label: 'dispatch · builds (60 s)',
      value,
      target: `≤ ${fmtSec(t.dispatchFreshSec)}`,
      status,
      detail: ageSec !== undefined ? String(Math.round(ageSec)) : undefined,
      graduation: graduationFor('loop-dispatch'),
    });
  }

  // ── Deploy freshness ─────────────────────────────────────────────────────
  {
    let status: SloStatus = 'unknown';
    let value = 'unknown';
    let detail: string | undefined;
    const deploy = probes.deploy ? probes.deploy() : undefined;
    if (deploy !== undefined) {
      if (deploy.behindCount === 0) {
        status = 'met'; value = 'in sync';
      } else {
        const oldestH = deploy.oldestUndeployedMs !== undefined
          ? (now - deploy.oldestUndeployedMs) / 3_600_000
          : t.deployBehindHours * 2; // unknown age → treat as over-target
        status = classifyMax(oldestH, t.deployBehindHours, frac);
        value = `${deploy.behindCount} behind${deploy.oldestUndeployedMs !== undefined ? ` · oldest ${fmtHours(oldestH)}` : ''}`;
        detail = String(oldestH);
      }
    }
    rows.push({
      key: 'deploy',
      label: 'Deploy freshness',
      value,
      target: `≤ ${t.deployBehindHours}h behind`,
      status,
      detail,
      graduation: graduationFor('deploy'),
    });
  }

  // ── Backup age ───────────────────────────────────────────────────────────
  {
    const age = probes.backup ? probes.backup() : undefined;
    const status = age === undefined ? 'unknown' : classifyMax(age, t.backupMaxHours, frac);
    const value = age === undefined ? 'unknown' : fmtHours(age);
    rows.push({
      key: 'backup',
      label: 'Backup age',
      value,
      target: `< ${t.backupMaxHours}h`,
      status,
      detail: age !== undefined ? String(age) : undefined,
      graduation: graduationFor('backup'),
    });
  }

  // ── launchd jobs healthy ─────────────────────────────────────────────────
  {
    const expectedLabels = cfg.expectedLaunchdLabels ?? [];
    const jobs = probes.launchd ? probes.launchd() : undefined;
    let status: SloStatus = expectedLabels.length === 0 ? 'unknown' : (jobs === undefined ? 'unknown' : 'met');
    let value = jobs === undefined ? 'unknown' : `${expectedLabels.length} loaded · exit 0`;

    if (jobs !== undefined && expectedLabels.length > 0) {
      const byLabel = new Map(jobs.map(j => [j.label, j]));
      const nonzeroExit = (j?: LaunchdJob) =>
        j?.lastExit !== null && j?.lastExit !== undefined && j.lastExit !== 0;
      const missing = expectedLabels.filter(l => !byLabel.get(l)?.loaded);
      const dead = expectedLabels.filter(l => {
        const j = byLabel.get(l);
        return j?.loaded && !j.running && nonzeroExit(j);
      });
      const flapped = expectedLabels.filter(l => {
        const j = byLabel.get(l);
        return j?.loaded && j.running && nonzeroExit(j);
      });

      if (missing.length > 0) {
        status = 'breached';
        value = `${missing.length} not loaded: ${missing.map(shortLabel).join(', ')}`;
      } else if (dead.length > 0) {
        status = 'breached';
        value = `${dead.length} dead (nonzero exit): ${dead.map(shortLabel).join(', ')}`;
      } else if (flapped.length > 0) {
        status = 'at-risk';
        value = `${flapped.length} restarted after error: ${flapped.map(shortLabel).join(', ')}`;
      } else {
        status = 'met';
        value = `${expectedLabels.length} loaded · exit 0`;
      }
    }

    rows.push({
      key: 'launchd',
      label: 'launchd jobs healthy',
      value,
      target: 'all loaded · exit 0',
      status,
      graduation: graduationFor('launchd'),
    });
  }

  // ── Instance probes (app / demo / ops) ──────────────────────────────────
  {
    const probeMap = cfg.instanceProbes ?? {};
    const names = Object.keys(probeMap);
    if (names.length === 0) {
      rows.push({
        key: 'instances',
        label: 'Instances up',
        value: 'no probes configured',
        target: 'all up',
        status: 'unknown',
      });
    } else {
      const results: Record<string, boolean | undefined> = {};
      for (const name of names) {
        const url = probeMap[name]!;
        results[name] = probes.instanceProbe ? probes.instanceProbe(url) : undefined;
      }
      const allKnown = Object.values(results).every(v => v !== undefined);
      const allUp = Object.values(results).every(v => v === true);
      const anyDown = Object.values(results).some(v => v === false);
      const status: SloStatus = !allKnown
        ? (anyDown ? 'breached' : 'unknown')
        : (allUp ? 'met' : 'breached');
      const fmt = (v: boolean | undefined) => v === undefined ? '?' : v ? 'up' : 'down';
      const value = names.map(n => `${n} ${fmt(results[n])}`).join(' · ');
      rows.push({
        key: 'instances',
        label: 'Instances up',
        value,
        target: 'all up',
        status,
        graduation: graduationFor('instances'),
      });
    }
  }

  // ── Watch reports: nightly + hourly ─────────────────────────────────────
  {
    const nightlyMs = probes.watchNightly ? probes.watchNightly() : undefined;
    const nightlyH = nightlyMs !== undefined && nightlyMs > 0
      ? (now - nightlyMs) / 3_600_000
      : undefined;
    const nStatus = classifyMax(nightlyH, t.watchNightlyMaxHours, frac);
    rows.push({
      key: 'watch-nightly',
      label: 'Nightly watch report',
      value: nightlyH === undefined ? 'no report' : `${fmtHours(nightlyH)} old`,
      target: `< ${t.watchNightlyMaxHours}h`,
      status: nStatus,
      detail: nightlyH !== undefined ? String(nightlyH) : undefined,
      graduation: graduationFor('watch-nightly'),
    });

    const hourlyMs = probes.watchHourly ? probes.watchHourly() : undefined;
    const hourlyH = hourlyMs !== undefined && hourlyMs > 0
      ? (now - hourlyMs) / 3_600_000
      : undefined;
    const hStatus = classifyMax(hourlyH, t.watchHourlyMaxHours, frac);
    rows.push({
      key: 'watch-hourly',
      label: 'Hourly watch report',
      value: hourlyH === undefined ? 'no report' : `${fmtHours(hourlyH)} old`,
      target: `< ${t.watchHourlyMaxHours}h`,
      status: hStatus,
      detail: hourlyH !== undefined ? String(hourlyH) : undefined,
      graduation: graduationFor('watch-hourly'),
    });
  }

  // ── Pipeline: unrouted backlog ───────────────────────────────────────────
  {
    const foldData = probes.fold ? probes.fold() : undefined;
    const u = foldData?.unrouted;
    let status: SloStatus;
    let value: string;
    if (u === undefined) {
      status = 'unknown'; value = 'unknown';
    } else if (u.count === 0) {
      status = 'met'; value = 'none';
    } else {
      status = classifyMax(u.oldestMin, t.unroutedMaxMin, frac);
      value = `${u.count} unrouted · oldest ${u.oldestMin !== undefined ? fmtMinutes(u.oldestMin) : '?'}`;
    }
    rows.push({
      key: 'unrouted',
      label: 'Unrouted backlog',
      value,
      target: `none > ${t.unroutedMaxMin}m`,
      status,
    });
  }

  // ── Pipeline: acceptance backlog ─────────────────────────────────────────
  {
    const foldData = probes.fold ? probes.fold() : undefined;
    const count = foldData?.acceptanceCount ?? 0;
    const oldestH = foldData?.oldestAcceptanceHours;
    const hasData = foldData !== undefined;
    const status: SloStatus = !hasData ? 'unknown'
      : count === 0 ? 'met'
      : classifyMax(oldestH, t.acceptanceMaxHours, frac);
    const value = !hasData ? 'unknown'
      : count === 0 ? 'none'
      : `${count} pending · oldest ${oldestH !== undefined ? fmtHours(oldestH) : '?'}`;
    rows.push({
      key: 'acceptance',
      label: 'Acceptance backlog',
      value,
      target: `none > ${t.acceptanceMaxHours}h`,
      status,
    });
  }

  // ── Pipeline: decisions waiting on operator ───────────────────────────────
  {
    const foldData = probes.fold ? probes.fold() : undefined;
    const count = foldData?.decisionCount ?? 0;
    const oldestH = foldData?.oldestDecisionHours;
    const hasData = foldData !== undefined;
    const status: SloStatus = !hasData ? 'unknown'
      : count === 0 ? 'met'
      : classifyMax(oldestH, t.decisionMaxHours, frac);
    const value = !hasData ? 'unknown'
      : count === 0 ? 'none'
      : `${count} waiting${oldestH !== undefined ? ` · oldest ${fmtHours(oldestH)}` : ''}`;
    rows.push({
      key: 'decisions',
      label: 'Decisions waiting on operator',
      value,
      target: `none > ${t.decisionMaxHours}h`,
      status,
    });
  }

  // ── Queue dispatchability ────────────────────────────────────────────────
  // Serves the reactor's plane self-diagnosis heal tier: Touches-serialization keeps a
  // healthy queue from ever dispatching. streak is a persisted per-beat counter (reactor.ts
  // owns the state file — this function stays a pure snapshot over injected values).
  {
    const planeCheckRows = probes.planeCheck ? probes.planeCheck() : undefined;
    const dispatchDetail = planeCheckRows?.find(r => r.check === 'dispatchability')?.detail;
    const foldData = probes.fold ? probes.fold() : undefined;
    const streak = foldData?.queueStallStreak;
    const hasData = foldData !== undefined;
    // A dispatchability FAIL is only ever raised when a single in-flight build's Touches
    // conflicts with every queued item — that's the picker serializing exactly as designed
    // (Touches-disjoint parallel dispatch), not a stall. Distinguish it from a genuine stall
    // using this beat's `in-flight` plane-check rows: if the choking build hasn't gone stale
    // (all PASS), the queue is working, just serial — don't let the persisted streak read as red.
    const inFlightRows = planeCheckRows?.filter(r => r.check === 'in-flight') ?? [];
    const serializedNotStalled = inFlightRows.length > 0 && inFlightRows.every(r => r.status === 'PASS');
    const status: SloStatus = !hasData ? 'unknown'
      : streak === undefined || streak <= 0 ? 'met'
      : serializedNotStalled ? 'met'
      : streak >= t.queueStallConsecutiveBeats ? 'breached'
      : 'at-risk';
    const value = !hasData ? 'unknown'
      : streak === undefined || streak <= 0 ? 'dispatching'
      : serializedNotStalled ? `${streak} beat(s) serialized on Touches, not stalled (choke build healthy)${dispatchDetail ? ` — ${dispatchDetail}` : ''}`
      : `${streak} consecutive stalled beat(s)${dispatchDetail ? ` — ${dispatchDetail}` : ''}`;
    rows.push({
      key: 'queue-stall',
      label: 'Queue dispatchability',
      value,
      target: `< ${t.queueStallConsecutiveBeats} consecutive stalled beats`,
      status,
      detail: streak !== undefined ? String(streak) : undefined,
      graduation: graduationFor('queue-stall'),
    });
  }

  // ── Tier auto-accept skip streak ─────────────────────────────────────────
  // stepProvisionalAccept silently skips tier accepts whenever the plane-health smoke
  // check isn't all-'met' — without this row that's invisible (only the acceptance
  // backlog inflates, hours later). Same streak shape as queue-stall: classification
  // comes from the persisted streak, never a live re-evaluation in this evaluator.
  {
    const foldData = probes.fold ? probes.fold() : undefined;
    const streak = foldData?.acceptSkipStreak;
    const hasData = foldData !== undefined;
    const status: SloStatus = !hasData ? 'unknown'
      : streak === undefined || streak <= 0 ? 'met'
      : streak >= t.acceptSkipConsecutiveBeats ? 'breached'
      : 'at-risk';
    const value = !hasData ? 'unknown'
      : streak === undefined || streak <= 0 ? 'accepting'
      : `${streak} consecutive skipped beat(s)`;
    rows.push({
      key: 'accept-skip',
      label: 'Tier auto-accept availability',
      value,
      target: `< ${t.acceptSkipConsecutiveBeats} consecutive skipped beats`,
      status,
      detail: streak !== undefined ? String(streak) : undefined,
      graduation: graduationFor('accept-skip'),
    });
  }

  // ── No-commit park rate ───────────────────────────────────────────────────
  // >= threshold no-commit-reason parks in 24h = a systemic worker/allowlist failure,
  // not item-level noise (the plane-check validator's parks check names this class).
  {
    const planeCheckRows = probes.planeCheck ? probes.planeCheck() : undefined;
    const parkDetail = planeCheckRows?.find(r => r.check === 'parks')?.detail;
    const foldData = probes.fold ? probes.fold() : undefined;
    const count = foldData?.noCommitParkCount24h;
    const hasData = foldData !== undefined;
    const status: SloStatus = !hasData || count === undefined ? 'unknown'
      : count >= t.noCommitParkThreshold ? 'breached'
      : count > 0 ? 'at-risk'
      : 'met';
    const value = !hasData || count === undefined ? 'unknown'
      : count === 0 ? 'none'
      : `${count} no-commit park(s) in 24h${parkDetail ? ` — ${parkDetail}` : ''}`;
    rows.push({
      key: 'no-commit-park',
      label: 'No-commit park rate (24h)',
      value,
      target: `< ${t.noCommitParkThreshold} in 24h`,
      status,
      detail: count !== undefined ? String(count) : undefined,
      graduation: graduationFor('no-commit-park'),
    });
  }

  // ── Master/origin divergence ─────────────────────────────────────────────
  // A stuck-merge / failed-push sentinel: local master sustained ahead of origin/master for
  // multiple consecutive beats means pushes are silently failing (or a merge never landed
  // upstream). Same streak shape as queue-stall: classification comes from the persisted
  // streak, never a live git spawn in this evaluator.
  {
    const counts = probes.divergence ? probes.divergence() : undefined;
    const foldData = probes.fold ? probes.fold() : undefined;
    const streak = foldData?.divergenceAheadStreak;
    const hasData = foldData !== undefined;
    const status: SloStatus = !hasData ? 'unknown'
      : streak === undefined || streak <= 0 ? 'met'
      : streak >= t.divergenceAheadConsecutiveBeats ? 'breached'
      : 'at-risk';
    const value = !hasData ? 'unknown'
      : streak === undefined || streak <= 0 ? 'in sync'
      : `${counts?.localAhead ?? '?'} local-ahead · ${streak} consecutive beat(s)`;
    rows.push({
      key: 'divergence',
      label: 'Master/origin divergence',
      value,
      target: `< ${t.divergenceAheadConsecutiveBeats} consecutive beats local-ahead`,
      status,
      detail: streak !== undefined ? String(streak) : undefined,
      graduation: graduationFor('divergence'),
    });
  }

  // ── Daily dispatch spend — only when a budget ceiling is configured ──────
  {
    const ceiling = cfg.dispatchDailyUsdCeiling;
    if (ceiling !== undefined && Number.isFinite(ceiling) && ceiling > 0) {
      const spend = probes.todayDispatchSpendUsd ? probes.todayDispatchSpendUsd() : undefined;
      const status: SloStatus = spend === undefined ? 'unknown'
        : spend >= ceiling ? 'breached'
        : spend >= ceiling * frac ? 'at-risk'
        : 'met';
      const value = spend === undefined ? 'unknown' : `$${spend.toFixed(4)}`;
      rows.push({
        key: 'spend',
        label: 'Dispatch daily spend',
        value,
        target: `< $${ceiling.toFixed(4)}`,
        status,
        detail: spend !== undefined ? String(spend) : undefined,
      });
    }
  }

  // ── CI re-enable date — only when a reenableOn date is configured ───────
  {
    const reenableOn = cfg.ciReenableOn;
    if (reenableOn) {
      const target = Date.parse(`${reenableOn}T00:00:00Z`);
      const status: SloStatus = !Number.isFinite(target) ? 'unknown'
        : now >= target ? 'breached'
        : 'met';
      rows.push({
        key: 'ci-reenable',
        label: 'CI re-enable date',
        value: status === 'breached' ? `reached ${reenableOn}` : `pending ${reenableOn}`,
        target: `< ${reenableOn}`,
        status,
        detail: reenableOn,
        graduation: graduationFor('ci-reenable'),
      });
    }
  }

  // ── Provider health ───────────────────────────────────────────────────────
  // met       = primary provider in the internal chain is healthy
  // at-risk   = primary unhealthy, a fallback is active
  // breached  = no healthy provider remains
  // unknown   = probe absent or errored
  {
    const result = probes.providerHealth ? probes.providerHealth() : undefined;
    let status: SloStatus;
    let value: string;
    let detail: string | undefined;
    if (result === undefined) {
      status = 'unknown';
      value = 'unknown';
    } else {
      switch (result.status) {
        case 'primary-healthy':
          status = 'met';
          value = result.primaryProvider ? `${result.primaryProvider} healthy` : 'healthy';
          break;
        case 'fallback-active':
          status = 'at-risk';
          value = result.activeProvider
            ? `fallback active: ${result.activeProvider}`
            : 'fallback active';
          detail = result.primaryProvider ?? undefined;
          break;
        case 'all-unhealthy':
          status = 'breached';
          value = 'all providers unhealthy';
          break;
        default:
          status = 'unknown';
          value = 'unknown';
      }
    }
    rows.push({
      key: 'provider',
      label: 'LLM provider health',
      value,
      target: 'primary healthy',
      status,
      detail,
      graduation: graduationFor('provider'),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Edge-triggered breach tracking
// ---------------------------------------------------------------------------

/**
 * Derive the last-known status per SLO key from ops ledger events
 * (slo.breach and slo.recovered events on item "system").
 * Returns a map of key → 'breached' | 'ok'.
 */
export function deriveSloState(
  opsEvents: LedgerEvent[],
): Map<string, 'breached' | 'ok'> {
  const state = new Map<string, 'breached' | 'ok'>();
  for (const ev of opsEvents) {
    if (ev.item !== 'system') continue;
    if (ev.type === 'slo.breach') {
      const d = ev.data as { indicator?: string };
      if (d.indicator) state.set(d.indicator, 'breached');
    } else if (ev.type === 'slo.recovered') {
      const d = ev.data as { key?: string };
      if (d.key) state.set(d.key, 'ok');
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Graduation counter — pure function over heal.proposed events
// ---------------------------------------------------------------------------

/**
 * Returns a function that, for a given SLO key, returns its graduation status.
 * "clean day" = a calendar day with >=1 heal.proposed for this key and no
 * heal.escalated for this key (escalation = something went wrong with the
 * proposed action / it was wrong).
 * Eligible = cleanDays >= 14 OR a heal.graduated event exists for the key.
 */
function makeGraduationCounter(
  opsEvents: LedgerEvent[],
): (key: string) => { cleanDays: number; eligible: boolean; shadowDays: number } {
  // Collect days-with-proposal, days-with-escalation, and days-with-shadow-fire per key
  const proposalDays = new Map<string, Set<string>>();
  const escalationDays = new Map<string, Set<string>>();
  const shadowDays = new Map<string, Set<string>>();
  const graduated = new Set<string>();

  for (const ev of opsEvents) {
    if (ev.item !== 'system') continue;
    const day = ev.ts.slice(0, 10); // YYYY-MM-DD

    if (ev.type === 'heal.proposed') {
      const d = ev.data as { key?: string };
      if (d.key) {
        if (!proposalDays.has(d.key)) proposalDays.set(d.key, new Set());
        proposalDays.get(d.key)!.add(day);
      }
    } else if (ev.type === 'heal.escalated') {
      const d = ev.data as { key?: string };
      if (d.key) {
        if (!escalationDays.has(d.key)) escalationDays.set(d.key, new Set());
        escalationDays.get(d.key)!.add(day);
      }
    } else if (ev.type === 'heal.graduated') {
      const d = ev.data as { key?: string };
      if (d.key) graduated.add(d.key);
    } else if (ev.type === 'heal.shadowed') {
      // Shadow-mode fires are tracked SEPARATELY from cleanDays — a shadow rule
      // never emits heal.proposed (it takes no action to propose), so folding it into the
      // same counter would keep shadow-only rules stuck at 0 forever. Kept apart from
      // executed-proposal calibration so the two trends stay independently readable.
      const d = ev.data as { key?: string };
      if (d.key) {
        if (!shadowDays.has(d.key)) shadowDays.set(d.key, new Set());
        shadowDays.get(d.key)!.add(day);
      }
    }
  }

  return (key: string) => {
    const proposals = proposalDays.get(key) ?? new Set<string>();
    const escalations = escalationDays.get(key) ?? new Set<string>();
    // Clean days = proposal days that had no escalation
    let cleanDays = 0;
    for (const day of proposals) {
      if (!escalations.has(day)) cleanDays++;
    }
    const eligible = graduated.has(key) || cleanDays >= 14;
    return { cleanDays, eligible, shadowDays: shadowDays.get(key)?.size ?? 0 };
  };
}

// ---------------------------------------------------------------------------
// OS-level probe implementations (real — not used in tests)
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

/**
 * ONE rule for run-state resolution (no second parser): an explicit `runDir` wins
 * (plane-home mode — run-state lives beside the ledger, outside the driven repo);
 * otherwise fall back to the embedded default under repoRoot. Mirrors resolveRunDir in
 * beats/reactor.ts and beats/dispatch.ts.
 */
function resolveRunDir(repoRoot: string, runDir: string | undefined): string {
  return runDir ?? join(repoRoot, '.ai', 'runs', 'loopkit');
}

/**
 * ONE parser for the beat liveness stamp files (lastrun + heartbeat): a single line of
 * epoch seconds. Shared by the real probes here and by dispatch.ts's cross-beat watchdog —
 * never a second copy.
 */
export function readEpochStampFile(path: string): number | undefined {
  try {
    const s = readFileSync(path, 'utf8').trim();
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  } catch { return undefined; }
}

/**
 * ONE parser for legacy `launchctl list` output ("PID\tStatus\tLabel", header line first).
 * A loaded interval job idle between runs has PID `-` and last exit `0` — that is
 * healthy-idle, so an exit code of 0 must survive the parse as 0 (the old
 * `parseInt(x) || null` collapsed it to null/"unknown").
 */
export function parseLaunchctlList(text: string): LaunchdJob[] {
  const lines = text.split('\n').slice(1); // skip header
  const jobs: LaunchdJob[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const pid = parts[0]!.trim();
    const exitCode = parts[1]!.trim();
    const label = parts[2]!.trim();
    if (!label) continue;
    const parsedExit = Number.parseInt(exitCode, 10);
    jobs.push({
      label,
      loaded: true,
      running: pid !== '-',
      lastExit: exitCode === '-' ? 0 : (Number.isFinite(parsedExit) ? parsedExit : null),
    });
  }
  return jobs;
}

/**
 * Parse a `launchctl print gui/<uid>/<label>` body into a LaunchdJob. Exit-0 from
 * `print` already proves the job is loaded; the body only refines running/lastExit.
 */
export function parseLaunchctlPrint(label: string, text: string): LaunchdJob {
  const pidM = text.match(/\bpid = (\d+)/);
  const exitM = text.match(/last exit code = (-?\d+)/);
  return {
    label,
    loaded: true,
    running: pidM !== null,
    lastExit: exitM ? Number(exitM[1]) : 0,
  };
}

/** Minimal injectable spawn shape for the launchd probe (tests inject a fake). */
export type LaunchdSpawn = (cmd: string, args: string[]) => { status: number | null; stdout: string };

function realLaunchdSpawn(cmd: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 2000 });
  return { status: r.status, stdout: r.stdout?.toString() ?? '' };
}

/**
 * Real launchd probe. Legacy `launchctl list` output is filtered by the CALLER's session
 * context — a job that is genuinely loaded (e.g. an interval beat with no current pid) can
 * be invisible to a `list` run from inside another launchd job, which made the SLO board
 * report loaded beats as "not loaded" and fed the launchd heal runbook a kickstart against
 * live processes. For each expected label missing from the list parse, fall back to the
 * modern per-label domain query `launchctl print gui/<uid>/<label>`: exit 0 = loaded
 * (healthy-idle when it has no current pid). ONE parser pair (parseLaunchctlList /
 * parseLaunchctlPrint) — the audit's service-label detector resolves through this same probe.
 */
export function makeLaunchdProbe(
  expectedLabels: string[] = [],
  spawn: LaunchdSpawn = realLaunchdSpawn,
  uid: number = process.getuid ? process.getuid() : 501,
): LaunchdProbe {
  return () => {
    const r = spawn('launchctl', ['list']);
    if (r.status !== 0) return undefined;
    const jobs = parseLaunchctlList(r.stdout);
    const seen = new Set(jobs.map(j => j.label));
    for (const label of expectedLabels) {
      if (!label || seen.has(label)) continue;
      const p = spawn('launchctl', ['print', `gui/${uid}/${label}`]);
      if (p.status === 0) jobs.push(parseLaunchctlPrint(label, p.stdout));
    }
    return jobs;
  };
}

/**
 * Build real probe implementations from repo root + config.
 * `runDir` is the resolved run-state root (opts.runDir / cli.ts's RUN_DIR) — pass it in
 * plane-home mode so the reactor/dispatch lastrun + lock probes read beside the ledger,
 * not under the driven repo. Omit for the embedded-mode default (back-compat).
 * `expectedLaunchdLabels` (cfg.slo.expectedLaunchdLabels) enables the per-label
 * `launchctl print` fallback in the launchd probe — see makeLaunchdProbe.
 * `probePaths` (cfg.slo.probePaths) opts a fork into the backup/watcher freshness probes by
 * naming their filesystem locations; unset paths disable those rows (see SloProbePaths).
 * Tests inject fakes instead.
 */
export function makeRealProbes(
  repoRoot: string,
  runDir?: string,
  expectedLaunchdLabels?: string[],
  probePaths: SloProbePaths = {},
): SloProbes {
  const resolvedRunDir = resolveRunDir(repoRoot, runDir);

  const reactorLastrun = () => readEpochStampFile(join(dirname(resolvedRunDir), 'reactor', 'lastrun'));
  const dispatchLastrun = () => readEpochStampFile(join(dirname(resolvedRunDir), 'dispatch', 'lastrun'));
  // Mid-beat heartbeat stamps — same dir, same epoch-seconds format (ONE stamp format);
  // the beats refresh them between work items (see beats/dispatch.ts writeBeatHeartbeat).
  const reactorHeartbeat = () => readEpochStampFile(join(dirname(resolvedRunDir), 'reactor', 'heartbeat'));
  const dispatchHeartbeat = () => readEpochStampFile(join(dirname(resolvedRunDir), 'dispatch', 'heartbeat'));

  function lockAgeSec(name: string): number | undefined {
    try {
      const st = statSync(join(resolvedRunDir, name));
      return Math.max(0, (Date.now() - st.mtimeMs) / 1000);
    } catch { return undefined; }
  }
  const reactorLockAgeSec = () => lockAgeSec('reactor.lock');
  const dispatchLockAgeSec = () => lockAgeSec('dispatch.lock');

  const launchd = makeLaunchdProbe(expectedLaunchdLabels ?? []);

  // Optional watcher-report / backup probes. A fork opts in by configuring
  // probePaths; unset paths disable the corresponding SLO row (no guessed layout).
  function backupAge(): number | undefined {
    if (!probePaths.backupLastrunFile) return undefined;
    // Backup lastrun stamp — same epoch-seconds format, same ONE parser.
    const epoch = readEpochStampFile(join(repoRoot, probePaths.backupLastrunFile));
    if (epoch === undefined) return undefined;
    return (Date.now() / 1000 - epoch) / 3600;
  }

  function watchNightly(): number | undefined {
    if (!probePaths.watcherReportDir) return undefined;
    try {
      // Most recent nightly watcher-report mtime.
      const st = statSync(join(repoRoot, probePaths.watcherReportDir));
      return st.mtimeMs;
    } catch { return undefined; }
  }

  function watchHourly(): number | undefined {
    if (!probePaths.watcherLatestReportFile) return undefined;
    try {
      // Stat the latest hourly report file the watcher writes.
      const st = statSync(join(repoRoot, probePaths.watcherLatestReportFile));
      return st.mtimeMs;
    } catch { return undefined; }
  }

  return {
    now: () => Date.now(),
    reactorLastrun,
    dispatchLastrun,
    reactorHeartbeat,
    dispatchHeartbeat,
    reactorLockAgeSec,
    dispatchLockAgeSec,
    launchd,
    backup: backupAge,
    watchNightly,
    watchHourly,
    // deploy, instanceProbe, fold: caller injects these
  };
}

/**
 * Real plane-check probe. Shells out to a configured deterministic plane-state
 * validator script (`--json`) and returns its check rows for diagnostic detail.
 * The script path is injected (relative to repoRoot); unset disables the probe — a
 * fork opts in by pointing at its own validator, no path is guessed.
 * Never throws — a missing script, non-JSON output, or timeout all degrade to undefined,
 * which the board renders as a plain value with no extra detail suffix.
 */
export function makePlaneCheckProbe(repoRoot: string, scriptPath?: string): PlaneCheckProbe {
  if (!scriptPath) return () => undefined;
  return () => {
    try {
      const r = spawnSync(join(repoRoot, scriptPath), ['--json'],
        { stdio: 'pipe', timeout: 20_000, maxBuffer: 1_048_576, cwd: repoRoot });
      const text = r.stdout?.toString();
      if (!text) return undefined;
      const parsed = JSON.parse(text) as { checks?: PlaneCheckRow[] };
      return Array.isArray(parsed.checks) ? parsed.checks : undefined;
    } catch { return undefined; }
  };
}

/**
 * Real deploy-freshness probe. Returns the loopkit DeployStatus shape: counts commits on
 * master not yet in the deploy-target checkout. Target root = LOOPKIT_DEPLOY_ROOT env; unset
 * disables the probe entirely (a fork must opt in — no guessed sibling-directory default).
 * Every failure degrades to undefined (→ unknown row) — never throws.
 */
export function makeDeployProbe(repoRoot: string, env: NodeJS.ProcessEnv = process.env): DeployProbe {
  return () => {
    try {
      const targetRoot = env['LOOPKIT_DEPLOY_ROOT'];
      if (!targetRoot) return undefined;
      const shaR = spawnSync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'],
        { stdio: 'pipe', timeout: 1500, maxBuffer: 65_536 });
      if (shaR.status !== 0) return undefined;
      const sha = shaR.stdout.toString().trim();
      if (!sha) return undefined;
      const countR = spawnSync('git', ['-C', repoRoot, 'rev-list', '--count', `${sha}..master`],
        { stdio: 'pipe', timeout: 1500, maxBuffer: 65_536 });
      if (countR.status !== 0) return undefined;
      const behind = Number(countR.stdout.toString().trim());
      if (!Number.isFinite(behind)) return undefined;
      if (behind === 0) return { behindCount: 0 };
      const logR = spawnSync('git', ['-C', repoRoot, 'log', '--reverse', '--format=%ct', `${sha}..master`],
        { stdio: 'pipe', timeout: 1500, maxBuffer: 262_144 });
      const firstEpoch = Number(logR.stdout.toString().trim().split('\n')[0]);
      return Number.isFinite(firstEpoch)
        ? { behindCount: behind, oldestUndeployedMs: firstEpoch * 1000 }
        : { behindCount: behind };
    } catch { return undefined; }
  };
}

/**
 * Real divergence probe. Shells out to `git rev-list --left-right --count
 * master...origin/master`, which prints "L R" — L = commits on local master not on origin,
 * R = commits on origin not on local. Degrades to undefined on any failure (missing repo,
 * no origin remote, non-numeric output) — never throws, mirrors the other real probes here.
 */
export function makeDivergenceProbe(repoRoot: string): DivergenceProbe {
  return () => {
    try {
      const r = spawnSync(
        'git', ['-C', repoRoot, 'rev-list', '--left-right', '--count', 'master...origin/master'],
        { stdio: 'pipe', timeout: 5000, maxBuffer: 65_536 },
      );
      if (r.status !== 0) return undefined;
      const parts = r.stdout.toString().trim().split(/\s+/);
      if (parts.length !== 2) return undefined;
      const localAhead = Number(parts[0]);
      const originAhead = Number(parts[1]);
      if (!Number.isFinite(localAhead) || !Number.isFinite(originAhead)) return undefined;
      return { localAhead, originAhead };
    } catch { return undefined; }
  };
}

/**
 * Real HTTP instance probe. true = status < 500 (up), false = down/unreachable.
 * Synchronous via curl (spawnSync) so it slots into the sync SloProbes.instanceProbe(url)
 * contract without making the whole board async. 2s timeout per probe.
 */
export function makeInstanceProbe(): HttpProbe {
  return (url: string) => {
    try {
      const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
        '--max-time', '2', url], { stdio: 'pipe', timeout: 3000 });
      if (r.status !== 0) return false;
      const code = Number(r.stdout.toString().trim());
      if (!Number.isFinite(code) || code === 0) return false;
      return code < 500;
    } catch { return undefined; }
  };
}
