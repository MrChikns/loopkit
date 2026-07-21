/**
 * checks.ts — Pure hygiene checks for `loopctl audit <target>` (target-readiness).
 *
 * Every check is a pure function over an AuditProbeData snapshot: all filesystem/git/ledger
 * I/O happens once in index.ts's real-probe gathering (impure), and these functions only
 * classify the result — same split as doctor.ts's injected probes / slo.ts's evaluateSloBoard.
 * No LLM, no side effects — file/artifact presence and timestamp math only.
 */

export interface AuditCheckResult {
  id: string;
  passed: boolean;
  message: string;
  detail?: unknown;
}

/**
 * Deterministic snapshot of everything the checks need. Gathered once by index.ts's real
 * probes (or fabricated directly by tests) — checks.ts never touches fs/git/ledger itself.
 */
export interface AuditProbeData {
  /** `.jsonl` segment basenames under `<target>/.ai/ledger`; undefined = dir missing/unreadable. */
  ledgerSegments?: string[];
  /** Ledger parsed without throwing (loadAllEventsWithQuarantine); undefined = not probed (no segments). */
  ledgerReadable?: boolean;
  /** `<target>/loopkit.config.json` exists and parsed. */
  configPresent: boolean;
  /** Gate command resolved from config (falls back to the framework default when configPresent is false). */
  gateCommand?: string;
  /** `config.budget.dispatchDailyUsd`, if set. */
  budgetUsd?: number;
  /** Commits in the target repo within recentCommitDays; undefined = not a git repo / probe failed. */
  recentCommitCount?: number;
  recentCommitDays: number;
  /** Ledger events within recentEventDays; undefined = ledger unreadable. */
  recentEventCount?: number;
  recentEventDays: number;

  // ── Onboarding preflight (setup-trouble detectors learned from real cutover incidents;
  //    each finding names the FIX, not just the problem) ──────────────────────────────
  /** Plane config loop labels (loops.reactorLabel / loops.dispatchLabel); ''/absent = unconfigured. */
  reactorLabel?: string;
  dispatchLabel?: string;
  /**
   * Labels of the configured loop services that ARE installed in the service manager
   * (launchctl on darwin, via the ONE launchd probe in slo.ts — incl. its per-label
   * `launchctl print` fallback). undefined = probe unavailable (non-darwin platform or
   * launchctl failed) → the service-label check skips gracefully, never fails.
   */
  installedServiceLabels?: string[];
  /** `<target>/package.json` exists — the repo has a node toolchain the gates will need. */
  packageJsonPresent?: boolean;
  /** `<target>/loopkit.target.json` exists (registered-target manifest). */
  manifestPresent?: boolean;
  /** Manifest depsWorkdirs (fully defaulted); undefined = manifest present but unreadable. */
  manifestDepsWorkdirs?: string[];
  /** LOOPKIT_* env vars in the gate-spawning shell BEYOND the shim's own export. */
  planeEnvExtras?: string[];
}

/**
 * The ONLY plane identity vars a gate-spawning shell should carry: the beat shim exports
 * exactly these. Anything else matching LOOPKIT_* (e.g. LOOPKIT_LEDGER, LOOPKIT_REPO)
 * silently re-points builds/gates at another plane — a real cutover incident class.
 */
export const GATE_ENV_ALLOWLIST = ['LOOPKIT_HOME', 'LOOPKIT_AUTONOMY'];

/** Pure filter: LOOPKIT_* keys in `env` beyond the shim allowlist. */
export function findPlaneEnvExtras(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter(k => /^LOOPKIT_/.test(k) && !GATE_ENV_ALLOWLIST.includes(k))
    .sort();
}

export function checkLedgerPresent(data: AuditProbeData): AuditCheckResult {
  const passed = (data.ledgerSegments?.length ?? 0) > 0;
  return {
    id: 'ledger-present',
    passed,
    message: passed
      ? `${data.ledgerSegments!.length} ledger segment(s) found`
      : 'no .ai/ledger/*.jsonl segments found',
    detail: data.ledgerSegments,
  };
}

export function checkLedgerReadable(data: AuditProbeData): AuditCheckResult {
  const passed = data.ledgerReadable === true;
  return {
    id: 'ledger-readable',
    passed,
    message: passed
      ? 'ledger parses cleanly'
      : data.ledgerReadable === false
        ? 'ledger present but failed to parse'
        : 'ledger not probed (no segments)',
  };
}

export function checkGatesConfigured(data: AuditProbeData): AuditCheckResult {
  const passed = data.configPresent && !!data.gateCommand && data.gateCommand.trim().length > 0;
  return {
    id: 'gates-configured',
    passed,
    message: passed
      ? `gate command: ${data.gateCommand}`
      : data.configPresent
        ? 'loopkit.config.json present but gateCommand is empty'
        : 'no loopkit.config.json — gate is unconfigured for this target',
  };
}

export function checkBudgetDefined(data: AuditProbeData): AuditCheckResult {
  const passed = typeof data.budgetUsd === 'number' && Number.isFinite(data.budgetUsd) && data.budgetUsd > 0;
  return {
    id: 'budget-defined',
    passed,
    message: passed
      ? `dispatch daily ceiling: $${data.budgetUsd!.toFixed(2)}`
      : 'no budget.dispatchDailyUsd ceiling set',
  };
}

export function checkRecentCommits(data: AuditProbeData): AuditCheckResult {
  const passed = (data.recentCommitCount ?? 0) > 0;
  return {
    id: 'recent-commits',
    passed,
    message: data.recentCommitCount === undefined
      ? 'not a git repo (or git probe failed)'
      : passed
        ? `${data.recentCommitCount} commit(s) in the last ${data.recentCommitDays}d`
        : `no commits in the last ${data.recentCommitDays}d`,
    detail: data.recentCommitCount,
  };
}

export function checkRecentEvents(data: AuditProbeData): AuditCheckResult {
  const passed = (data.recentEventCount ?? 0) > 0;
  return {
    id: 'recent-events',
    passed,
    message: data.recentEventCount === undefined
      ? 'ledger unreadable — activity not measurable'
      : passed
        ? `${data.recentEventCount} ledger event(s) in the last ${data.recentEventDays}d`
        : `no ledger events in the last ${data.recentEventDays}d`,
    detail: data.recentEventCount,
  };
}

/**
 * Preflight (a): every configured loop label must match an installed service, or the
 * launchd/watchdog runbooks kickstart ghosts while the real beats never run. Skips
 * gracefully (passes with a note) when labels are unconfigured or the service manager
 * can't be probed (non-darwin).
 */
export function checkServiceLabels(data: AuditProbeData): AuditCheckResult {
  const id = 'service-labels';
  const configured = [data.reactorLabel, data.dispatchLabel].filter((l): l is string => !!l && l.trim().length > 0);
  if (configured.length === 0) {
    return {
      id, passed: true,
      message: 'no loop service labels configured (loops.reactorLabel/dispatchLabel) — watchdog kickstarts stay disabled until set',
    };
  }
  if (data.installedServiceLabels === undefined) {
    return { id, passed: true, message: 'service-manager probe unavailable on this platform — label check skipped' };
  }
  const installed = new Set(data.installedServiceLabels);
  const missing = configured.filter(l => !installed.has(l));
  if (missing.length > 0) {
    return {
      id, passed: false,
      message: `config loop label(s) match no installed service: ${missing.join(', ')} — fix: install the service (launchctl bootstrap gui/$(id -u) <path-to-plist>) or correct loops.reactorLabel/dispatchLabel in loopkit.config.json to a label \`launchctl list\` shows`,
      detail: missing,
    };
  }
  return { id, passed: true, message: `loop labels installed: ${configured.join(', ')}` };
}

/**
 * Preflight (b): a target repo with a package.json but a manifest declaring no
 * depsWorkdirs gets NO node_modules provisioned into build worktrees — every gate needing
 * a local toolchain (tsc et al.) exits 127. The finding carries the exact manifest
 * snippet to add.
 */
export function checkDepsWorkdirs(data: AuditProbeData): AuditCheckResult {
  const id = 'deps-workdirs';
  if (data.manifestPresent !== true) {
    return { id, passed: true, message: 'no loopkit.target.json — depsWorkdirs check applies only to registered-target repos' };
  }
  if (data.manifestDepsWorkdirs === undefined) {
    return {
      id, passed: false,
      message: 'loopkit.target.json present but unreadable — fix: repair the manifest JSON, then re-run the audit',
    };
  }
  if (data.packageJsonPresent !== true) {
    return { id, passed: true, message: 'no package.json — no worktree toolchain provisioning needed' };
  }
  if (data.manifestDepsWorkdirs.length === 0) {
    return {
      id, passed: false,
      message: 'package.json present but the manifest declares no depsWorkdirs — build-worktree gates will fail 127 on missing toolchains; fix: add to loopkit.target.json: "depsWorkdirs": ["."] (list every workdir whose node_modules the gate needs)',
    };
  }
  return { id, passed: true, message: `depsWorkdirs: ${data.manifestDepsWorkdirs.join(', ')}` };
}

/**
 * Preflight (c): the shell that will spawn gates must not carry plane identity vars
 * beyond the shim's own export (GATE_ENV_ALLOWLIST) — a stray LOOPKIT_LEDGER/LOOPKIT_REPO
 * silently re-points builds at another plane.
 */
export function checkGateEnv(data: AuditProbeData): AuditCheckResult {
  const id = 'gate-env';
  const extras = data.planeEnvExtras ?? [];
  if (extras.length > 0) {
    return {
      id, passed: false,
      message: `gate-spawning env carries plane identity var(s) beyond the shim's export: ${extras.join(', ')} — fix: unset ${extras.join(' ')} (the beat shim exports only ${GATE_ENV_ALLOWLIST.join('/')})`,
      detail: extras,
    };
  }
  return { id, passed: true, message: `no stray plane identity vars (allowed: ${GATE_ENV_ALLOWLIST.join(', ')})` };
}

export function runChecks(data: AuditProbeData): AuditCheckResult[] {
  return [
    checkLedgerPresent(data),
    checkLedgerReadable(data),
    checkGatesConfigured(data),
    checkBudgetDefined(data),
    checkRecentCommits(data),
    checkRecentEvents(data),
    checkServiceLabels(data),
    checkDepsWorkdirs(data),
    checkGateEnv(data),
  ];
}
