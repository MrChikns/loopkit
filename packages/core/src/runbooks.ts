/**
 * runbooks.ts — Runbook table for the self-heal reactor step.
 *
 * Each runbook is a small deterministic function returning a HealAction.
 * Execution is via injected spawn (no direct OS calls here).
 * Zero LLM. Allowlisted actions only. Every action has a revert path.
 *
 * Tiers:
 *   auto-heal — execute (if OPS_AUTONOMY=heal) or propose
 *   nudge     — push notification (once per item, deduped via ledger)
 *   escalate  — push notification + heal.escalated event
 *
 * Day-1 exemption: loop-reactor and loop-dispatch watchdog runbooks execute
 * even in propose mode (the cross-beat watchdog). Both are flagged
 * `day1Exempt: true` in the table.
 *
 * The `deploy` runbook exists but ships as propose-only regardless of graduation
 * (the deploy ritual is not yet scripted in this slice — noted as a deferral).
 */

export type HealTier = 'auto-heal' | 'nudge' | 'escalate';

export interface HealAction {
  /** One-line description of the action */
  action: string;
  /** How to undo it if it goes wrong */
  revert: string;
  /** Which tier handles this — drives propose-vs-execute decision */
  tier: HealTier;
  /** Day-1 exempt: executes even in propose mode (cross-beat watchdog) */
  day1Exempt?: boolean;
  /**
   * Execute the action using the injected spawn.
   * Returns evidence string (stdout/status summary) or throws on failure.
   */
  execute?: (ctx: RunbookContext) => Promise<string>;
}

import { statSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { beatLockOwnerAlive } from './beats/dispatch.js';

/**
 * ONE rule for run-state resolution (no second parser): an explicit `ctx.runDir` wins
 * (plane-home mode — run-state lives beside the ledger, outside the driven repo);
 * otherwise fall back to the embedded default under repoRoot. Mirrors resolveRunDir in
 * beats/reactor.ts and beats/dispatch.ts.
 */
function resolveRunDir(ctx: Pick<RunbookContext, 'runDir' | 'repoRoot'>): string {
  return ctx.runDir ?? joinPath(ctx.repoRoot, '.ai', 'runs', 'loopkit');
}

export interface RunbookContext {
  /** Injected spawn (real or fake). Returns { ok, output }. */
  spawn: (cmd: string, args: string[]) => { ok: boolean; output: string };
  /** Repo root for script paths */
  repoRoot: string;
  /**
   * Resolved run-state root (watchdog lock files live here) — mirrors the beats'
   * opts.runDir (docs: reactor/dispatch ReactorOptions/DispatchOptions.runDir). In
   * plane-home mode the caller passes the run dir that lives beside the ledger; when
   * absent, defaults to the embedded location under repoRoot (<repoRoot>/.ai/runs/loopkit)
   * for back-compat.
   */
  runDir?: string;
  /** The SLO key being healed */
  key: string;
  /** Optional extra detail from the SLO row */
  detail?: string;
  /** launchd (or equivalent) service label for the reactor beat (cfg.loops.reactorLabel). */
  reactorLabel?: string;
  /** launchd (or equivalent) service label for the dispatch beat (cfg.loops.dispatchLabel). */
  dispatchLabel?: string;
  /**
   * Reactor lock age (ms) past which a held lock counts as wedged for the
   * loop-reactor runbook's lock-clear. Default: 20 min (mirrors the SLO board).
   */
  reactorWedgeMs?: number;
  /**
   * Dispatch lock age (ms) past which a held lock counts as wedged. The reactor's heal
   * step injects the work-shaped value stepSloEvaluate computed (slo.ts
   * dispatchWedgeSecFor: items the beat may drain × build timeout + headroom) so the
   * runbook clears locks on the SAME threshold the board classified with. Default: 55 min.
   */
  dispatchWedgeMs?: number;
}

/**
 * Liveness gate shared by every lock-clear/kickstart heal action (loop-reactor,
 * loop-dispatch, and the launchd runbook when aimed at a beat label): before touching a
 * beat's lock or `kickstart -k`-ing its service, verify the lock's owner pid is actually
 * DEAD. A wedge-age threshold alone once killed a LIVE multi-item beat (thresholds were
 * tuned for crash-orphaned locks). Reuses beatLockOwnerAlive — the SAME predicate the
 * lock-reclaim acquire path uses, never a second parser. Returns an in-flight report
 * string when the owner is provably alive (the caller must return it verbatim and take NO
 * action), or null when healing may proceed (owner dead, unreadable, or no lock at all).
 */
function beatInFlightReport(lockPath: string, beatName: string): string | null {
  if (beatLockOwnerAlive(lockPath) === true) {
    return `liveness gate: ${beatName} lock owner pid is alive — beat in flight, no heal action taken`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runbook table
// ---------------------------------------------------------------------------

const RUNBOOKS: Record<string, HealAction> = {
  /**
   * loop-reactor: dispatch-side watchdog kickstarts the reactor.
   * Day-1 exempt: executes even in propose mode.
   * Label comes from ctx.reactorLabel (cfg.loops.reactorLabel) — unset disables execution
   * (propose-only), since there is nothing to kickstart without a configured service label.
   */
  'loop-reactor': {
    action: 'kickstart the reactor beat via launchctl (label from cfg.loops.reactorLabel)',
    revert: 'launchctl bootout gui/$(id -u) <reactorLabel> (stops the job; launchd will not restart it)',
    tier: 'auto-heal',
    day1Exempt: true,
    execute: async (ctx) => {
      const label = ctx.reactorLabel;
      if (!label) throw new Error('cfg.loops.reactorLabel not set — cannot heal loop-reactor without a target label');
      const lockPath = joinPath(resolveRunDir(ctx), 'reactor.lock');
      // Liveness gate BEFORE any lock-clear/kickstart: a live owner pid = the beat is in
      // flight — never heal, report instead (see beatInFlightReport).
      const inFlight = beatInFlightReport(lockPath, 'reactor');
      if (inFlight) return inFlight;
      // A SIGKILL'd beat leaves its mkdir lock behind; kickstart alone then spins no-op beats
      // forever. Clear a WEDGED lock (older than the beat could legitimately run) before
      // restarting — never a fresh one.
      let cleared = '';
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > (ctx.reactorWedgeMs ?? 20 * 60 * 1000)) {
          rmSync(lockPath, { recursive: true, force: true });
          cleared = ' (wedged lock cleared)';
        }
      } catch { /* no lock — fine */ }
      const uid = process.getuid ? process.getuid() : 501;
      const r = ctx.spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
      if (!r.ok) throw new Error(`launchctl kickstart failed: ${r.output}`);
      return `kickstarted ${label}${cleared}: ${r.output.trim()}`;
    },
  },

  /**
   * loop-dispatch: reactor-side watchdog kickstarts dispatch.
   * Day-1 exempt: executes even in propose mode.
   * Label comes from ctx.dispatchLabel (cfg.loops.dispatchLabel) — unset disables execution
   * (propose-only), since there is nothing to kickstart without a configured service label.
   */
  'loop-dispatch': {
    action: 'kickstart the dispatch beat via launchctl (label from cfg.loops.dispatchLabel)',
    revert: 'launchctl bootout gui/$(id -u) <dispatchLabel>',
    tier: 'auto-heal',
    day1Exempt: true,
    execute: async (ctx) => {
      const label = ctx.dispatchLabel;
      if (!label) throw new Error('cfg.loops.dispatchLabel not set — cannot heal loop-dispatch without a target label');
      const lockPath = joinPath(resolveRunDir(ctx), 'dispatch.lock');
      // Liveness gate BEFORE any lock-clear/kickstart: a live owner pid = a multi-item
      // build beat legitimately in flight — never heal, report instead. This is the exact
      // incident class the gate exists for (a wedge-age threshold alone once
      // kickstart-killed a live sync beat mid-build).
      const inFlight = beatInFlightReport(lockPath, 'dispatch');
      if (inFlight) return inFlight;
      // A SIGKILL'd beat leaves its mkdir lock behind; kickstart alone then spins no-op beats
      // forever. Clear a WEDGED lock (older than the beat could legitimately run — the
      // work-shaped threshold from ctx.dispatchWedgeMs) before restarting — never a fresh one.
      let cleared = '';
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > (ctx.dispatchWedgeMs ?? 55 * 60 * 1000)) {
          rmSync(lockPath, { recursive: true, force: true });
          cleared = ' (wedged lock cleared)';
        }
      } catch { /* no lock — fine */ }
      const uid = process.getuid ? process.getuid() : 501;
      const r = ctx.spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
      if (!r.ok) throw new Error(`launchctl kickstart failed: ${r.output}`);
      return `kickstarted ${label}${cleared}: ${r.output.trim()}`;
    },
  },

  /**
   * deploy: run the deploy ritual (build + restart + smoke).
   * Framework ships this propose-only — the deploy ritual itself is project-specific and not
   * scripted here. A fork can wire `execute` in its own config/extension point.
   */
  'deploy': {
    action: 'run the deploy ritual — PROPOSE ONLY: project-specific ritual not wired by the framework',
    revert: 'git revert HEAD + deploy the revert commit',
    tier: 'auto-heal',
    day1Exempt: false,
    // execute intentionally absent — propose-only; a fork wires its own deploy ritual
  },

  /**
   * launchd: handle a missing or dead launchd (or equivalent) job by label.
   * Sub-cases resolved at execution time from SLO detail (the label to heal). Generic —
   * assumes a `build/ops/<label>.plist` bootstrap path convention; a fork may need a different
   * bootstrap path for its own service manager.
   */
  'launchd': {
    action: 'bootstrap missing plist or kickstart dead launchd job',
    revert: 'launchctl bootout gui/$(id -u) <label>',
    tier: 'auto-heal',
    execute: async (ctx) => {
      const uid = process.getuid ? process.getuid() : 501;
      // detail is the label(s) that are missing/dead from the SLO row
      const label = ctx.detail ?? '';
      if (!label) throw new Error('no label in detail — cannot heal launchd SLO without a target label');

      // Liveness gate when the label is one of the plane's own beats: `kickstart -k`
      // KILLS the running process, and a false "not loaded" probe reading once aimed this
      // runbook at live beats. Same predicate as the lock-reclaim path (beatLockOwnerAlive
      // via beatInFlightReport) — a live beat is never kickstarted from here.
      const beatLock = label === ctx.reactorLabel ? 'reactor.lock'
        : label === ctx.dispatchLabel ? 'dispatch.lock'
        : null;
      if (beatLock) {
        const inFlight = beatInFlightReport(joinPath(resolveRunDir(ctx), beatLock), label);
        if (inFlight) return inFlight;
      }

      // Try kickstart first (works if loaded); if not loaded, bootstrap from repo plist
      const kickR = ctx.spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
      if (kickR.ok) return `kickstarted ${label}: ${kickR.output.trim()}`;

      // Not loaded — try bootstrap
      const plistPath = `${ctx.repoRoot}/build/ops/${label}.plist`;
      const bootR = ctx.spawn('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
      if (!bootR.ok) {
        throw new Error(`${label} not loaded; bootstrap from ${plistPath} failed: ${bootR.output}`);
      }
      return `bootstrapped + kickstarted ${label}`;
    },
  },

  /**
   * unrouted / routing: a healthy loop that can't route = human problem.
   */
  'unrouted': {
    action: 'notify operator: unrouted backlog while loop is healthy — provider/logic failure',
    revert: 'n/a — notification only',
    tier: 'escalate',
  },

  'routing': {
    action: 'notify operator: routing latency breach — check provider health',
    revert: 'n/a — notification only',
    tier: 'escalate',
  },

  /**
   * acceptance: nudge operator via push notification with an acceptance-desk link.
   */
  'acceptance': {
    action: 'push notification: items pending acceptance — test at the acceptance desk',
    revert: 'n/a — notification only',
    tier: 'nudge',
  },

  /**
   * decisions: push once per item; a reversible-default SLA auto-fire already resolves
   * decisions that don't need a human answer, so this nudge only reaches genuine ones.
   */
  'decisions': {
    action: 'push notification: operator decisions waiting > 72h',
    revert: 'n/a — notification only',
    tier: 'nudge',
  },

  /**
   * spend: daily dispatch budget reached — notify only.
   * No auto-heal action for budget: the operator decides whether to raise the ceiling,
   * wait until the next UTC day, or manually unblock via config. Escalate tier = notify-only.
   */
  'spend': {
    action: 'notify operator: daily dispatch spend at or above configured ceiling',
    revert: 'n/a — notification only; dispatch resumes automatically next UTC day',
    tier: 'escalate',
  },

  /**
   * queue-stall: the queue is non-empty but Touches-serialized for N consecutive dispatch
   * beats. This is a structural/config problem (narrow Touches, or accept serial
   * dispatch) — not something a kickstart or requeue can fix mechanically. Notify with the
   * plane-check diagnosis attached (threaded into row.value → heal.proposed.detail) so the
   * operator sees WHY, not just that the queue looks stuck.
   * DEFERRED: auto-requeue / auto-park-a-decision-item execution needs RunbookContext
   * extended with item-level ledger-append access (currently system-row-only) — not yet built.
   */
  'queue-stall': {
    action: 'notify operator: queue Touches-serialized for consecutive beats — narrow Touches or accept serial dispatch',
    revert: 'n/a — notification only; recovers automatically once a dispatchable item appears',
    tier: 'escalate',
  },

  /**
   * no-commit-park: >= threshold no-commit-reason parks in the trailing 24h —
   * the plane-check validator's systemic-worker-failure class. Notify with the diagnosis
   * attached rather than sitting silent.
   * DEFERRED: auto-requeue once the worker-prompt/allowlist fix is confirmed live needs the
   * same RunbookContext extension as queue-stall (item-level ledger append) plus a
   * fix-confirmation guard — not yet built.
   */
  'no-commit-park': {
    action: 'notify operator: no-commit park rate breached — see plane-check diagnosis for the failing class',
    revert: 'n/a — notification only; recovers automatically once the rate drops below threshold',
    tier: 'escalate',
  },

  /**
   * accept-skip: stepProvisionalAccept has skipped tier auto-accepts for
   * N consecutive reactor beats because the plane-health smoke check (loop-reactor,
   * loop-dispatch, instances) wasn't all 'met'. Without this row it's invisible — the only
   * symptom is the acceptance backlog quietly inflating for hours. Notify with the smoke-check
   * state so the operator can see WHICH health row is stuck, not just that accepts stopped.
   */
  'accept-skip': {
    action: 'notify operator: tier auto-accept skipped for consecutive beats — check the SLO board for the unhealthy row',
    revert: 'n/a — notification only; recovers automatically once loop-reactor/loop-dispatch/instances are all met',
    tier: 'escalate',
  },

  /**
   * provider: LLM provider health breach.
   * The dispatch beat already self-recovers (clears the unhealthy marker when the
   * provider is healthy again on the next pre-flight ping). This runbook is notify-only
   * so the operator knows the plane is degraded or frozen without action from SRE.
   * A conserved/manual-consult provider is never auto-healed here — only pinged for status.
   */
  'provider': {
    action: 'notify operator: LLM provider health degraded — check /login or provider status',
    revert: 'n/a — notification only; plane self-recovers when provider is reachable',
    tier: 'escalate',
  },

  /**
   * ci-reenable: a free-tier CI pause. Once the SLO row breaches (today >=
   * config.ci.reenableOn), re-enable the disabled_manually workflows and clear the
   * config field so the row — and this runbook — never re-fires. Idempotent (a workflow
   * already enabled is simply skipped) and reversible (`gh workflow disable` + restore
   * the config field). day1Exempt so it fires without needing OPS_AUTONOMY=heal, matching
   * the other watchdog-style safe auto-heals in this table.
   */
  'ci-reenable': {
    action: 're-enable paused cloud CI workflows (gh workflow enable) and clear config.ci.reenableOn',
    revert: 'gh workflow disable <file> to re-pause; restore ci.reenableOn in loopkit.config.json',
    tier: 'auto-heal',
    day1Exempt: true,
    execute: async (ctx) => {
      const listR = ctx.spawn('gh', ['workflow', 'list', '--all', '--json', 'name,path,state']);
      if (!listR.ok) throw new Error(`gh workflow list failed: ${listR.output}`);

      let workflows: Array<{ name: string; path: string; state: string }>;
      try {
        workflows = JSON.parse(listR.output);
      } catch {
        throw new Error(`gh workflow list returned non-JSON output: ${listR.output}`);
      }

      const targets = workflows.filter(w => /\/(ci|nightly)\.yml$/.test(w.path) && w.state === 'disabled_manually');
      const enabled: string[] = [];
      for (const w of targets) {
        const r = ctx.spawn('gh', ['workflow', 'enable', w.path]);
        if (r.ok) enabled.push(w.path);
      }

      // Clear ci.reenableOn so the SLO row never re-breaches (config-driven heal).
      const configPath = joinPath(ctx.repoRoot, 'loopkit.config.json');
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf8'));
        if (raw.ci && 'reenableOn' in raw.ci) {
          delete raw.ci.reenableOn;
          if (Object.keys(raw.ci).length === 0) delete raw.ci;
          writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
        }
      } catch (e) {
        throw new Error(`failed to clear ci.reenableOn in loopkit.config.json: ${e}`);
      }

      // Best-effort phone nudge — idempotence must not depend on this succeeding.
      try {
        ctx.spawn(joinPath(ctx.repoRoot, '.ai', 'notify-phone.sh'), ['cloud CI re-enabled — quota renewed']);
      } catch { /* best-effort */ }

      return enabled.length > 0
        ? `enabled: ${enabled.join(', ')}`
        : 'no disabled_manually workflows found (already enabled) — cleared ci.reenableOn';
    },
  },
};

export function getRunbook(key: string): HealAction | undefined {
  return RUNBOOKS[key];
}

export function allRunbookKeys(): string[] {
  return Object.keys(RUNBOOKS);
}

// ---------------------------------------------------------------------------
// Shadow mode — per-rule mode gate ahead of the propose/execute ladder
// ---------------------------------------------------------------------------

export type HealMode = 'shadow' | 'armed';

/** Per-rule config row read from loopkit.config.json's `healRules` block. */
export interface HealRuleConfig {
  mode?: HealMode;
}

/**
 * Resolve a rule's self-heal mode. The config's per-rule `mode` field is the ONLY
 * signal (no inline hardcoded strings, no per-runbook overrides) — a rule absent from
 * `healRules`, or present with `mode` omitted, resolves to 'armed' (preserves existing
 * behavior for every rule that shipped before shadow mode existed). A rule newly added
 * to RUNBOOKS should ship with an explicit `mode: 'shadow'` entry in the config; live
 * per-rule, so it is re-read every call rather than cached on any long-lived record.
 * Promotion to 'armed' is a manual config edit after an operator burn-in review of
 * the shadow-mode false-positive rate — never automatic.
 */
export function resolveHealMode(key: string, healRules: Record<string, HealRuleConfig> | undefined): HealMode {
  return healRules?.[key]?.mode === 'shadow' ? 'shadow' : 'armed';
}
