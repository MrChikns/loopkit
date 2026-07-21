/**
 * audit/index.ts — `loopctl audit <target>`: a zero-LLM, deterministic target-readiness
 * hygiene checker for the one-plane/many-targets model.
 *
 * The plane-home split (a LOOPKIT_HOME-style resolver, minted targetId, per-target runtime
 * state under the plane home — see docs/event-model.md §"The two repos") is not yet
 * implemented as a filesystem layout — today, a loopkit-enabled repo is keyed by its own
 * `<target>/.ai/ledger` and `<target>/loopkit.config.json`, the same convention every other
 * CLI command already uses via `loadConfig(repoRoot)`. This audit runs against that current
 * shape; re-point it at the plane home's per-target directory once the plane-home resolver
 * lands.
 *
 * All I/O (fs, git, ledger) is gathered here, once, into a plain AuditProbeData snapshot;
 * checks.ts/score.ts are pure functions over that snapshot (same split as slo.ts's
 * evaluateSloBoard / makeRealProbes).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAllEventsWithQuarantine } from '../ledger.js';
import { loadConfig } from '../config.js';
import { makeLaunchdProbe } from '../slo.js';
import { readTargetManifest, TARGET_MANIFEST_FILENAME } from '../target.js';
import { AuditCheckResult, AuditProbeData, findPlaneEnvExtras, runChecks } from './checks.js';
import { AutonomyScore, scoreAutonomyTier } from './score.js';

export * from './checks.js';
export * from './score.js';

export interface AuditConfig {
  /** Window for the recent-commits check, in days. Default: 7. */
  recentCommitDays?: number;
  /** Window for the recent-events check, in days. Default: 30. */
  recentEventDays?: number;
  /** Injected wall clock (epoch ms), for testability. Default: Date.now(). */
  now?: number;
  /**
   * Injected installed-service probe (for tests): returns the labels among the given
   * configured labels that are installed, or undefined when the platform can't be probed.
   * Default: launchctl via slo.ts's makeLaunchdProbe on darwin, undefined elsewhere.
   */
  serviceLabelsProbe?: (configuredLabels: string[]) => string[] | undefined;
  /** Injected environment for the gate-env preflight (for tests). Default: process.env. */
  env?: Record<string, string | undefined>;
}

export interface AuditResult {
  target: string;
  checks: AuditCheckResult[];
  score: AutonomyScore;
}

function probeConfig(targetPath: string): {
  configPresent: boolean;
  gateCommand?: string;
  budgetUsd?: number;
  reactorLabel?: string;
  dispatchLabel?: string;
} {
  const configPath = join(targetPath, 'loopkit.config.json');
  if (!existsSync(configPath)) return { configPresent: false };
  try {
    const cfg = loadConfig(targetPath);
    return {
      configPresent: true,
      gateCommand: cfg.gateCommand,
      budgetUsd: cfg.budget?.dispatchDailyUsd,
      reactorLabel: cfg.loops?.reactorLabel,
      dispatchLabel: cfg.loops?.dispatchLabel,
    };
  } catch {
    // Present but unparsable — treat as unconfigured rather than crash the audit.
    return { configPresent: false };
  }
}

/**
 * Real installed-service probe: launchctl on darwin (through slo.ts's ONE launchd probe,
 * incl. its per-label `launchctl print` fallback for jobs the legacy session-filtered
 * `list` hides); undefined elsewhere so the check skips gracefully — never fails on a
 * platform without launchd.
 */
function probeInstalledServiceLabels(configuredLabels: string[]): string[] | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const jobs = makeLaunchdProbe(configuredLabels)();
    if (jobs === undefined) return undefined;
    return jobs.filter(j => j.loaded).map(j => j.label);
  } catch {
    return undefined;
  }
}

/** Manifest preflight probe: presence + fully-defaulted depsWorkdirs (undefined = unreadable). */
function probeManifest(targetPath: string): { manifestPresent: boolean; manifestDepsWorkdirs?: string[] } {
  if (!existsSync(join(targetPath, TARGET_MANIFEST_FILENAME))) return { manifestPresent: false };
  try {
    const manifest = readTargetManifest(targetPath);
    return { manifestPresent: true, manifestDepsWorkdirs: manifest.depsWorkdirs };
  } catch {
    return { manifestPresent: true }; // present but unreadable — the check names the fix
  }
}

function probeRecentCommits(targetPath: string, days: number, now: number): number | undefined {
  try {
    const sinceIso = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const r = spawnSync('git', ['-C', targetPath, 'rev-list', '--count', `--since=${sinceIso}`, 'HEAD'],
      { stdio: 'pipe', timeout: 5000, maxBuffer: 65_536 });
    if (r.status !== 0) return undefined;
    const n = Number(r.stdout.toString().trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the audit against a target repo's tree. Never throws — every probe degrades to
 * `undefined`/failed on missing data, same fail-soft contract as slo.ts's real probes.
 */
export async function runAudit(targetPath: string, config: AuditConfig = {}): Promise<AuditResult> {
  const now = config.now ?? Date.now();
  const recentCommitDays = config.recentCommitDays ?? 7;
  const recentEventDays = config.recentEventDays ?? 30;

  const ledgerDir = join(targetPath, '.ai', 'ledger');
  let ledgerSegments: string[] | undefined;
  try {
    const files = readdirSync(ledgerDir).filter(f => f.endsWith('.jsonl'));
    ledgerSegments = files.length > 0 ? files : undefined;
  } catch {
    ledgerSegments = undefined;
  }

  let ledgerReadable: boolean | undefined;
  let recentEventCount: number | undefined;
  if (ledgerSegments) {
    try {
      const events = await loadAllEventsWithQuarantine(ledgerDir);
      ledgerReadable = true;
      const windowMs = recentEventDays * 24 * 60 * 60 * 1000;
      recentEventCount = events.filter(ev => {
        const t = Date.parse(ev.ts);
        return Number.isFinite(t) && now - t >= 0 && now - t < windowMs;
      }).length;
    } catch {
      ledgerReadable = false;
    }
  }

  const { configPresent, gateCommand, budgetUsd, reactorLabel, dispatchLabel } = probeConfig(targetPath);
  const recentCommitCount = probeRecentCommits(targetPath, recentCommitDays, now);

  // Onboarding preflight probes (service labels · manifest depsWorkdirs · gate env)
  const configuredLabels = [reactorLabel, dispatchLabel].filter((l): l is string => !!l && l.trim().length > 0);
  const serviceProbe = config.serviceLabelsProbe ?? probeInstalledServiceLabels;
  const installedServiceLabels = configuredLabels.length > 0 ? serviceProbe(configuredLabels) : undefined;
  const packageJsonPresent = existsSync(join(targetPath, 'package.json'));
  const { manifestPresent, manifestDepsWorkdirs } = probeManifest(targetPath);
  const planeEnvExtras = findPlaneEnvExtras(config.env ?? process.env);

  const data: AuditProbeData = {
    ...(ledgerSegments ? { ledgerSegments } : {}),
    ...(ledgerReadable !== undefined ? { ledgerReadable } : {}),
    configPresent,
    ...(gateCommand !== undefined ? { gateCommand } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(recentCommitCount !== undefined ? { recentCommitCount } : {}),
    recentCommitDays,
    ...(recentEventCount !== undefined ? { recentEventCount } : {}),
    recentEventDays,
    ...(reactorLabel !== undefined ? { reactorLabel } : {}),
    ...(dispatchLabel !== undefined ? { dispatchLabel } : {}),
    ...(installedServiceLabels !== undefined ? { installedServiceLabels } : {}),
    packageJsonPresent,
    manifestPresent,
    ...(manifestDepsWorkdirs !== undefined ? { manifestDepsWorkdirs } : {}),
    planeEnvExtras,
  };

  const checks = runChecks(data);
  const score = scoreAutonomyTier(checks);
  return { target: targetPath, checks, score };
}
