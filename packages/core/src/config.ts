/**
 * config.ts — Load and validate loopkit.config.json from the repo root.
 *
 * The config file lives at <repoRoot>/loopkit.config.json and is the single
 * place for project-specific tuning of the framework.
 *
 * All fields have defaults so an empty {} config is valid.
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RoutingConfig, ROUTING_CONFIG_DEFAULTS, mergeRoutingConfig } from './routing.js';
import { ArmedItem } from './armed.js';
import { HealRuleConfig } from './runbooks.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface LoopsConfig {
  /** Reactor beat cadence in seconds (matches launchd StartInterval) */
  reactorIntervalSec?: number;
  /** Dispatch beat cadence in seconds */
  dispatchIntervalSec?: number;
  /**
   * launchd (or equivalent) service label for the reactor beat — used by the dispatch
   * cross-beat watchdog and the loop-reactor self-heal runbook.
   * Set to '' to disable watchdog kickstart (default). Project-specific; must live in
   * loopkit.config.json, not hardcoded in the framework source.
   */
  reactorLabel?: string;
  /**
   * launchd (or equivalent) service label for the dispatch beat — used by the loop-dispatch
   * self-heal runbook. Set to '' to disable watchdog kickstart (default). Project-specific;
   * must live in loopkit.config.json, not hardcoded in the framework source.
   */
  dispatchLabel?: string;
}

export interface ProviderEntry {
  /** Provider type: 'claude-cli' | 'codex-cli' | 'ollama' */
  type: string;
  /** Model alias for this provider */
  model?: string;
  /** Reasoning effort level for this provider (claude-cli only: 'low' | 'medium' | 'high' | 'xhigh' | 'max') */
  effort?: string;
}

export interface SensitivityAllowlists {
  public?: string[];
  internal?: string[];
  private?: string[];
}

/**
 * Ordered fallback chains per sensitivity tier.
 * Each value is an ordered list of provider names. The registry walks the chain,
 * skipping unhealthy or incompatible providers, and returns the first suitable one.
 *
 * Default chains (a conserved consulting-lane provider is NOT included by default):
 *   internal: ['claude-cli']
 *   public:   ['claude-cli']
 *   private:  ['ollama']
 *
 * To add ollama as a degraded-routing fallback for internal:
 *   { internal: ['claude-cli', 'ollama'] }
 *
 * To add a conserved consulting-lane provider (operator must opt in):
 *   { internal: ['claude-cli', 'codex-cli'] }  — WARNING: quota is shared.
 */
export interface FallbackChains {
  internal?: string[];
  public?: string[];
  private?: string[];
}

/** Opt-in probe filesystem locations (mirrors SloProbePaths from slo.ts) */
export interface SloProbePathsBlock {
  watcherReportDir?: string;
  watcherLatestReportFile?: string;
  backupLastrunFile?: string;
  planeCheckScript?: string;
}

/** SLO targets and probe config (mirrors SloConfig from slo.ts) */
export interface SloConfigBlock {
  reactorFreshSec?: number;
  dispatchFreshSec?: number;
  deployBehindHours?: number;
  backupMaxHours?: number;
  watchNightlyMaxHours?: number;
  watchHourlyMaxHours?: number;
  acceptanceMaxHours?: number;
  decisionMaxHours?: number;
  unroutedMaxMin?: number;
  routingWorstMin?: number;
  atRiskFraction?: number;
  /** Consecutive stalled dispatch beats before queue-stall breaches. Default: 3. */
  queueStallConsecutiveBeats?: number;
  /** No-commit-reason parks in the trailing 24h before no-commit-park breaches. Default: 3. */
  noCommitParkThreshold?: number;
  /** Min local-ahead commit count for a beat to count toward the divergence streak. Default: 1. */
  divergenceAheadThreshold?: number;
  /** Consecutive local-ahead beats before the divergence SLO breaches. Default: 3. */
  divergenceAheadConsecutiveBeats?: number;
  expectedLaunchdLabels?: string[];
  instanceProbes?: Record<string, string>;
  /**
   * Opt-in filesystem locations (relative to repo root) for the deployment-specific freshness
   * probes. Every field is optional — an unset path disables its SLO row rather than guessing a
   * layout. Framework-neutral: a fork wires only the probes its own plane emits.
   */
  probePaths?: SloProbePathsBlock;
  /** Daily dispatch budget ceiling for the spend SLO row. Mirrors budget.dispatchDailyUsd. */
  dispatchDailyUsdCeiling?: number;
  /** Target trailing-median captured→merged cycle time, in hours, for the daily brief. Default: 24. */
  cycleTimeMedianHours?: number;
  /** Floor for the trailing 7-day first-pass (attempt=1 merge) rate, 0–1, for the daily brief. Default: 0.5. */
  firstPassRate7dFloor?: number;
  /** Optional daily token-spend ceiling for the brief's 80%-of-budget alert. Absent = no alert. */
  dailyTokenBudget?: number;
  /**
   * Mirrors LoopkitConfig.ci.reenableOn, injected into evaluateSloBoard's cfg by the reactor
   * beat (same pattern as dispatchDailyUsdCeiling from cfg.budget). Not meant to be set directly
   * in loopkit.config.json's slo block — set ci.reenableOn instead.
   */
  ciReenableOn?: string;
}

export interface LoopkitConfig {
  /** Loop cadence settings */
  loops: LoopsConfig;

  /**
   * Shell command (run with `sh -c`) used as the deterministic gate.
   * Default: "npm test" run in appWorkdir from the repo root.
   */
  gateCommand: string;
  /**
   * Working directory for the gate command (relative to repo root or absolute).
   * Project-specific — set in loopkit.config.json.
   */
  gateWorkdir: string;

  /**
   * Directory (relative to repo root) whose installed `node_modules` the beats
   * symlink into each build/merge worktree, so the gate has deps without a fresh
   * install. A project fact independent of `gateWorkdir` (a fork may run the gate
   * from the repo root via a custom script yet keep deps in a subdirectory).
   * Project-specific — set in loopkit.config.json.
   */
  appWorkdir: string;

  /**
   * Directories (relative to repo root) whose `node_modules` get symlinked into every
   * beat worktree. The gate may run suites in multiple packages; each needs its deps.
   * Optional — defaults to `[appWorkdir]` at the call sites when unset.
   */
  depsWorkdirs?: string[];

  /**
   * Prefix for the sibling worktree directories the beats create next to the
   * repo root: dispatch builds in `<repoRoot>/../<worktreePrefix>wi-<n>`, the
   * reactor's approval gate in `<repoRoot>/../<worktreePrefix>appr-<n>`.
   * Default: "loop-". A fork may override to match its own checkout-layout
   * convention; config, not a source literal.
   */
  worktreePrefix: string;

  /**
   * Regex pattern for the "durable spine": files matching this pattern trigger a
   * gate.parked {reason: 'spine'} instead of auto-merge.
   */
  spineRegex: string;

  /**
   * Delegated approval boundary. The reactor's auto-approve step turns a park into a silent
   * approve when the whole park is a "same-origin extension" of the declared scope. These
   * three lists tune that classifier; see approval.ts.
   */
  autoApprove: {
    /**
     * When ON, the reactor auto-approves the delegated park classes below with a
     * msg.out note instead of leaving them on the needs-you board.
     */
    enabled: boolean;
    /**
     * Plane path prefixes. A `spine`-class park is auto-approved only when EVERY spine
     * file matches one of these (plane-only spine — auto-merges on green like any non-spine
     * build). Anything outside these prefixes is PRODUCT spine and keeps parking.
     */
    planePrefixes: string[];
    /**
     * Standard companion path segments (projection-pattern). A `touches-overstep` park is
     * auto-approved when every overstepping file is EITHER under a top-level dir already in
     * the declared Touches OR under one of these companion segments beside declared scope.
     */
    companionSegments: string[];
    /**
     * The hard escalation list: any park whose files match one of these ALWAYS parks for the
     * operator (costly-and-irreversible), regardless of the same-origin test. Substring match
     * against the parked file paths.
     */
    escalationPatterns: string[];
    /**
     * Narrative-doc allowlist. A `touches-overstep` park auto-approves as a companion
     * merge when EVERY overstep file matches one of these patterns (and none is operative
     * markdown, config, or an escalation hit — see approval.ts). Fail-safe allowlist: an
     * unrecognized path never matches and keeps parking.
     */
    docCompanionGlobs: string[];
    /**
     * Operator-declared operative markdown — exact repo-relative paths that ALWAYS surface
     * for the operator (never auto-approve as a doc companion), on top of the framework
     * built-ins (`.ai/**`, `CLAUDE.md`, `AGENTS.md`). Empty by default: a fork whose decision
     * log / gate registry lives outside `.ai/**` lists those paths here.
     */
    operativeDocs: string[];
    /**
     * Governance-critical classifiers. A park whose file list includes one of these
     * paths (substring match) NEVER auto-approves — the operator-interrupt classifiers govern
     * the auto-approve boundary itself, so a change to one must not self-approve. Checked at
     * the top of classifyParkForAutoApprove, before the delegated-class rules. The operator's
     * explicit approve verb still merges (that path does not route through the classifier).
     */
    governanceCriticalPaths: string[];
  };

  /**
   * Touches conflict rules: comma-separated patterns per item.
   * Currently structural; the beat logic enforces the invariant.
   */
  touches: {
    /** 'prefix' means two patterns conflict when one is a string prefix of the other */
    conflictMode: 'prefix';
  };

  /** Named provider configs */
  providers: Record<string, ProviderEntry>;

  /** Sensitivity → allowed provider names */
  sensitivityAllowlists: SensitivityAllowlists;

  /**
   * Ordered fallback chains per sensitivity tier.
   * See FallbackChains for defaults and rationale.
   */
  chains: FallbackChains;

  /**
   * Cooldown in milliseconds after an auth failure before retrying a provider (half-open).
   * Default: 600000 (10 minutes).
   */
  providerCooldownMs: number;

  /** Default model aliases per loop role */
  models: {
    conductor: string;
    builderDefault: string;
  };

  /**
   * Number of consecutive orphan-crash+requeues before parking (breaker).
   * Default: 3
   */
  breakerN: number;

  /**
   * Max number of SMALL, Touches-overlapping items dispatch may co-locate into ONE
   * worker run (one worktree, one prompt, one gate, one merge) to cut per-merge suite
   * overhead for operator-feedback bursts. Only sonnet items with priority no more urgent
   * than 'high' and a spec under 1500 chars are eligible; per-item ledger events are
   * derived from the worker's per-item commits. Default: 1 (off — one item per worktree).
   */
  batchMaxItems: number;
  /** Max minutes a single build agent may run before the provider times out. */
  buildTimeoutMinutes: number;
  /**
   * Minutes an alive worker may make no progress (no new worktree commit, worker log, or
   * stderr write) before the doctor reaps it as stalled — kills the pid, salvages, and
   * requeues (breaker-bounded). Default: buildTimeoutMinutes. Set 0 to disable stall reaping.
   */
  stalledBuildMinutes: number;

  /** Directory containing prompt files (conductor.md, etc.) relative to repo root */
  promptsDir: string;

  /** Path to the phone notification hook script relative to repo root */
  notifyHook: string;

  /**
   * Command spawned DETACHED after every successful merge (deploy-on-merge).
   * Empty string = off. Runs with cwd=repoRoot; must be self-locking (bursts coalesce).
   */
  deployCommand: string;

  /**
   * launchd label kickstarted right after the reactor appends a fresh item.queued — shortcuts
   * dispatch's up-to-60s StartInterval wait. Empty string = off (the default — tests and
   * non-host environments must never invoke a real `launchctl`; a deployment supplies its real
   * dispatch launchd label in loopkit.config.json). Best-effort; dispatch's StartInterval
   * remains the liveness fallback either way.
   */
  dispatchKickLabel: string;

  /**
   * Timeout in milliseconds for the merge-gate command (reactor apply-verbs path only).
   * Default: 10 min. Raise when dispatch builds + LLM routing run concurrently and
   * saturate CPU/IO on the same machine.
   * NOTE: A 7s suite timing out at 5 min strongly suggests beat-load contention —
   * investigate concurrent dispatch worker CPU/IO as the root cause rather than just
   * raising this ceiling.
   */
  mergeGateTimeoutMs: number;

  /** SLO targets and probe config */
  slo: SloConfigBlock;

  /**
   * Scout context-pack stage config.
   * The scout is a read-only pre-build step that prepares a context pack for each
   * build worker. Fail-open: a scout failure never blocks, parks, or retries a build.
   */
  scout?: {
    /**
     * Enable the scout pre-build stage.
     * Default: true.
     */
    enabled?: boolean;
    /**
     * Model alias for the scout run (read-only, cheap).
     * Default: 'haiku'.
     */
    model?: string;
    /**
     * Wall-clock timeout for a single scout run in milliseconds.
     * Default: 300000 (5 min).
     */
    timeoutMs?: number;
  };

  /**
   * LLM-as-judge merge review config.
   * Advisory-only: the judge NEVER blocks, parks, or reorders merges.
   * Power (gating mode) is a future step gated on calibration.
   */
  judge?: {
    /**
     * Enable the judge stage. Default: true.
     * Set to false to skip the judge entirely.
     */
    enabled?: boolean;
    /**
     * Judge mode. ONLY 'advisory' is accepted — any other value is a config error.
     * Gating mode is not yet earned; calibration comes first (see `loopctl verdicts`).
     */
    mode?: 'advisory';
    /**
     * Model alias for the judge run.
     * Default: 'sonnet'.
     */
    model?: string;
    /**
     * Wall-clock timeout for a single judge call in milliseconds.
     * Default: 240000 (4 min).
     */
    timeoutMs?: number;
    /**
     * Maximum diff characters to send to the judge (stat + patch combined).
     * Diffs larger than this are truncated before sending.
     * Default: 20000.
     */
    maxDiffChars?: number;
  };

  /**
   * WI-084 — the park pathologist. On every FAILURE park (gate-red/crash/infra, never
   * parkKind:'decision'), the reactor spawns one bounded read-only diagnosis pass and acts on
   * the verdict (bounded auto-requeue / auto-captured repair WI + block / requeue-once-then-
   * park-for-review). Fail-open: provider absent/erroring/unparseable leaves the park exactly
   * as it would stand without this feature.
   */
  pathology?: {
    /** Enable the pathologist stage. Default: true. */
    enabled?: boolean;
    /** Model alias for the pathologist run. Default: 'opus' (architect tier). */
    model?: string;
    /** Wall-clock timeout for a single pathologist call in milliseconds. Default: 180000 (3 min). */
    timeoutMs?: number;
    /** Maximum event-trail events to send. Default: 15. */
    maxTrailEvents?: number;
    /** Maximum diff characters to send (stat + patch combined). Default: 12000. */
    maxDiffChars?: number;
    /**
     * WI-099 — blocked-victim wait-timeout. A victim parked on `blockedOn` (see
     * ItemRecord.blockedOn) is normally released the moment its repair WI merges; if the
     * repair is instead rejected or parked itself, the victim would otherwise sit blocked
     * forever with no signal. When a victim has been parked longer than this many hours AND
     * its blocker has not merged, the reactor re-parks it as parkKind:'decision' carrying the
     * original diagnosis (which WI it was blocked on + why), so it reaches the operator desk
     * instead of staying silently off it. Default: 24.
     */
    blockedWaitTimeoutHours?: number;
  };

  /**
   * Provisional acceptance.
   * The reactor auto-accepts plane-only slices after a quiet-window when the
   * evidence ladder passes (judge pass + SLO green + no operator msg.in after merge).
   */
  acceptance?: {
    provisional?: {
      /**
       * Enable provisional self-acceptance.
       * Default: true.
       */
      enabled?: boolean;
      /**
       * Minimum hours between the item.merged event and a provisional accept.
       * Gives the operator time to engage first; after this silence the reactor acts.
       * Default: 48.
       */
      afterHours?: number;
      /**
       * Require a judge 'pass' verdict before provisionally accepting.
       * When true (default) and no judge verdict exists (or it is fail/unparseable),
       * the item is skipped — absence of evidence withholds autonomy conservatively.
       */
      requireJudgePass?: boolean;
    };
    /**
     * Acceptance tiering. Generalizes the provisional-accept step into four attention tiers
     * (auto/optional/review/must — see acceptance.ts) so a large backlog doesn't force the
     * operator to be a manual-QA bottleneck. When enabled, this block SUPERSEDES `provisional`
     * as the reactor's driving config; `provisional` stays merged for back-compat but is unused
     * while tiers.enabled is true.
     */
    tiers?: {
      /** Enable tier-driven auto-acceptance. Default: true. */
      enabled?: boolean;
      /**
       * User-facing product surface path prefixes — items touching one classify as
       * 'review' tier (surfaced for operator test). This is the TEST-VISIBILITY axis and
       * is ORTHOGONAL to autoApprove.planePrefixes (the MERGE-TRUST axis): a path may be in
       * both, meaning "auto-merge it, but still show it to me to test" — surface wins over
       * plane for tiering. Reuses the same startsWith/includes idiom.
       * Default: [] — the framework declares no surfaces of its own; a fork lists its
       * own product/UI surface prefixes here.
       */
      surfacePrefixes?: string[];
      /** Auto-accept window in hours for 'auto' tier items. Default: 2. */
      autoAfterHours?: number;
      /** Auto-accept window in hours for 'optional' tier items. Default: 48. */
      optionalAfterHours?: number;
      /** Auto-accept window in hours for 'review' tier items (7 days). Default: 168. */
      reviewAfterHours?: number;
      /** Max acceptances per beat, across all tiers — drains the backlog over a few beats. Default: 25. */
      perBeatCap?: number;
      /**
       * Max hours the operator-silence hold pins a non-auto item before it expires back into
       * normal tier windows. A never-answered reply otherwise pins an item forever, and a
       * review-tier item then falls out of the needs-you window. Default: 72.
       */
      holdMaxHours?: number;
      /**
       * Overseer gate: judge-confidence floor. A gate-green, auto-mergeable slice whose judge
       * confidence is below this — or which the judge flags for test-theatre, major scope-creep,
       * or unsatisfied spec — is ratcheted up to at least the 'review' tier so it still
       * merges+deploys but never silently auto-accepts. Default: 0.7. Set 0 to disable the
       * confidence check (the quality-flag ratchets still apply).
       */
      confidenceFloor?: number;
      /**
       * Verdict-history calibration: self-tune the 'optional' and 'review' windows from the
       * operator's actual accept/problem verdicts. Never mutates this config file — see
       * tier.recalibrated in schema.ts.
       */
      calibration?: {
        /** Enable self-tuning. Default: true. */
        enabled?: boolean;
        /** Consecutive clean accepts (no problems) since the last tune that trigger a shrink. Default: 5. */
        demoteAfterCleanAccepts?: number;
        /** Window *= this on demote (shrink). Default: 0.5. */
        demoteFactor?: number;
        /** Window *= this on promote (grow) — triggered by any problem report. Default: 2.0. */
        promoteFactor?: number;
        /** Minimum window, in hours. Default: 1. */
        windowFloorHours?: number;
        /** Maximum window, in hours. Default: 336 (14 days). */
        windowCeilingHours?: number;
      };
    };
  };

  /**
   * Spend budget controls.
   * All limits are optional — absent = no ceiling enforced.
   */
  budget?: {
    /**
     * Maximum USD the dispatch beat may spend in a single calendar day (UTC).
     * When today's accumulated cost.usage spend reaches or exceeds this value,
     * dispatch skips picks for the rest of the day and logs a clear message.
     * The reactor (routing, merges) is unaffected — only worker spawning is gated.
     * Set in loopkit.config.json; absent = no ceiling.
     */
    dispatchDailyUsd?: number;
  };

  /**
   * Ledger hygiene config.
   */
  ledger?: {
    /**
     * Number of recent months of ops segments to retain (current + previous calendar months).
     * Segments older than this window are archived by `loopctl compact`.
     * Work segments are NEVER compacted regardless of this setting.
     * Default: 2
     */
    opsRetentionMonths?: number;
  };

  /**
   * Eval-driven model routing config.
   * Routes build dispatches by measured first-pass merge rate per model × spec-size bucket.
   * Default mode is 'advisory' — reads incumbent but records what 'active' would pick.
   * See routing.ts for the full policy description and graduation path.
   */
  routing?: RoutingConfig;

  /**
   * Playbook feedback loop.
   * A curated file of recurring lessons injected into every build worker prompt.
   * Manually maintained; a watcher appends `# candidate:` lines for ratification.
   */
  playbook?: {
    /**
     * Enable playbook injection into worker prompts.
     * Default: true.
     */
    enabled?: boolean;
    /**
     * Path to the playbook file relative to repo root.
     * Default: '.ai/loops/playbook.md'.
     */
    path?: string;
    /**
     * Maximum ratified lines to inject (comment lines excluded).
     * Default: 40.
     */
    maxLines?: number;
  };

  /**
   * Self-arming trigger map. Each armed item is a machine-checkable predicate paired with a
   * pre-written capture payload; the reactor evaluates every predicate each beat and emits
   * item.captured on a false→true edge (dedupe by the stable id — fires once per arming).
   * Escalation-class payloads (capture.priority === 'escalation') park for the operator
   * instead of auto-building. Default: [] (nothing armed).
   * See src/armed.ts and the README "Armed items" section.
   */
  armed?: ArmedItem[];

  /**
   * Worker salvage/resume config.
   * Captures uncommitted partial work from interrupted builds as patch files
   * for re-application on the next attempt.
   */
  salvage?: {
    /**
     * Enable salvage capture on worker interruption.
     * Default: true.
     */
    enabled?: boolean;
    /**
     * Maximum size of the salvage patch in kilobytes.
     * Over-cap: write a .salvage.note only (no patch file).
     * Default: 256.
     */
    maxPatchKb?: number;
  };

  /**
   * Delivery lanes. A lane is a workflow config — {worker, definition-of-done gate, delivery
   * mode, publish boundary} — over the ONE ledger; NOT a role or identity. Only the 'engineering'
   * reference lane is populated by default (unchanged behavior); dispatch/gate/delivery still
   * hardcode engineering. Additional lanes read these facets to generalize the pipeline.
   * Absent → engineering-only.
   */
  lanes?: Record<string, LaneConfig>;

  /**
   * Free-tier CI pause. When `reenableOn` (an ISO date, YYYY-MM-DD) is set, the reactor's
   * `ci-reenable` SLO row breaches once today >= that date and the `ci-reenable` heal runbook
   * re-enables the paused CI workflows via `gh workflow enable`, then clears this field so the
   * breach never re-fires. Absent/no `reenableOn` = no probe, no action.
   */
  ci?: {
    reenableOn?: string;
  };

  /**
   * Quota-pressure degraded-mode gate. Read-only projection over `quota.snapshot`
   * history (see quota-pressure.ts) consumed by the dispatch beat's spawn-decision gate: when
   * any provider:window's latest reading is at/above `thresholdPct`, dispatch stops picking new
   * items for that beat. The reactor (routing, merges, doctor, report) is unaffected — this
   * gates spawn only, never the reactor's own work.
   */
  quotaPressure?: {
    /**
     * Percent (0–100] at which quota pressure trips degraded mode.
     * Default: 80.
     */
    thresholdPct?: number;
  };

  /**
   * Per-rule self-heal mode. Key = a runbook key (see runbooks.ts RUNBOOKS,
   * e.g. 'backup', 'launchd', 'instances') or an SLO board key that maps to one. A rule
   * with `mode: 'shadow'` records what it WOULD have done (heal.shadowed) instead of
   * proposing/executing/nudging — pure telemetry, zero side effects. A rule absent from
   * this map, or present with `mode` omitted, is 'armed' (the existing propose/execute
   * ladder, unchanged) — this preserves current behavior for every rule shipped before
   * shadow mode existed. Any brand-new runbook should ship with an explicit
   * `mode: 'shadow'` entry here; promotion to 'armed' is a manual config edit after an
   * operator burn-in review of the shadow-mode false-positive rate — never automatic.
   */
  healRules?: Record<string, HealRuleConfig>;

  /**
   * Target (id or name) that events with no target stamp coalesce to in the fold —
   * the migration/parity path for ledgers written before multi-target existed.
   * Callers that hold a config pass it via `fold(events, { defaultTarget })`; the fold
   * itself never reads config. Unset: sole-registered-target inference still applies.
   */
  defaultTarget?: string;

  /**
   * Console knowledge page (/knowledge). Operator-declared markdown sources —
   * decision logs, gate/stage registries, active plan docs — read server-side by the console
   * and rendered as anchor-linked cards, so documents cited by work items are one click away.
   * `paths` resolve against the plane repo root; `targets` keys a per-registered-target
   * (by display name or target id) list resolving against that target's registered repoPath.
   * Entries are literal relative paths or globs (`*` within a segment, `**` across segments).
   * Absent → the page renders an instructive empty state, never an error.
   */
  knowledge?: KnowledgeConfig;

  /**
   * Dispatch execution mode (ADR-008 phase A). SPAWN-side only — governs how the dispatch
   * beat spawns NEW workers; the cross-beat collection pass (dispatch.ts) is unconditional
   * regardless of this flag. Default `detachedDispatch: false` is byte-for-byte today's
   * synchronous await-in-beat behaviour.
   */
  execution?: {
    /**
     * When true, an eligible build (single-item engineering group, Claude-CLI provider)
     * spawns detached and the beat returns without awaiting it; a later beat's collection
     * pass drains it via its exit file. Default: false.
     */
    detachedDispatch?: boolean;
  };

  /**
   * Cross-target pattern promotion (WI-098's stepPortabilityPromotion in reactor.ts) — a
   * staged flag per method.md's "the rollback is written before the flip" discipline. Multi-
   * target portability isn't yet exercised (see README's "Honest scope"), so this ships
   * dormant: default `enabled: false` is byte-for-byte "the step never runs" — rollback is
   * simply leaving the flag off. A merged item's certification naming other registered
   * targets otherwise queues/parks a sibling item there every beat regardless of whether
   * multi-target promotion has been proven for this plane.
   */
  portabilityPromotion?: {
    /** Enable cross-target pattern promotion + its advisory nudge. Default: false. */
    enabled?: boolean;
  };
}

/**
 * One explicitly-declared knowledge source (an alternative to a bare path/glob string).
 * A source object names a file (or, for a relative glob path, a set of files sharing one
 * `kind`/`label`) and how to render it. Back-compat: a bare string keeps today's glob
 * semantics (one or more markdown files, each a card); a source object may declare its
 * `kind` (a decision log parses into decision cards) — most commonly used for a
 * one-decision-per-file ADR-style directory via a glob `path` (WI-058, see docs/knowledge.md).
 */
export interface KnowledgeSource {
  /** Human label for the card/region. Defaults to the file basename when omitted (a glob
   *  `path` labels each matched file by its own basename regardless). */
  label?: string;
  /** File path — absolute, or resolved against the scope's root (plane repo root for
   *  `paths`, the target's `repoPath` for `targets`). A RELATIVE path containing `*` is a
   *  glob, expanded into one record per matched file (WI-058); an absolute path is always
   *  literal — a single file — even if it contains `*`. */
  path: string;
  /** How the console renders the file(s). 'markdown' (default) → a knowledge card;
   *  'decision-log' → parsed into decision cards (PREFIX-NNN ids). */
  kind?: 'markdown' | 'decision-log';
}

/** One knowledge entry: a bare path/glob string (today's semantics) or a source object. */
export type KnowledgeEntry = string | KnowledgeSource;

/** The `knowledge` config block — see LoopkitConfig.knowledge. */
export interface KnowledgeConfig {
  /** Markdown paths/globs (or source objects) resolved against the plane repo root
   *  (single-repo mode). */
  paths?: KnowledgeEntry[];
  /** Per registered target (display name or target id) → markdown paths/globs (or source
   *  objects) resolved against that target's registered repoPath. */
  targets?: Record<string, KnowledgeEntry[]>;
}

/**
 * One delivery-lane config row. Descriptive only — no consumer reads `gate`/`delivery`/
 * `publishBoundary` yet. Kept an open shape so a new lane is a config row, never a code change.
 */
export interface LaneConfig {
  /** Human label for the lane. */
  description?: string;
  /** Definition-of-done gate: 'npm test' (code) or a lane-specific check name. */
  gate?: string;
  /** Delivery mode: 'merge' (code) | 'park-artifact' | 'publish'. */
  delivery?: string;
  /** True when any outbound step in this lane is costly-and-irreversible (must park). */
  publishGated?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: LoopkitConfig = {
  loops: {
    reactorIntervalSec: 30,
    dispatchIntervalSec: 60,
    reactorLabel: '',   // empty = watchdog kickstart disabled until configured
    dispatchLabel: '',  // empty = watchdog kickstart disabled until configured
  },
  gateCommand: 'npm test',
  gateWorkdir: '.',   // repo root — a target names its own app dir in loopkit.config.json
  appWorkdir: '.',
  worktreePrefix: 'loop-',
  // Framework ships with no spine surfaces of its own — a fork names its own high-blast-radius
  // files (contracts, auth, migrations, schema, etc) in loopkit.config.json.
  spineRegex: '',
  autoApprove: {
    enabled: true,
    // Framework-only default: the plane's own config/ledger dir. A fork adds its own
    // plane/app-adjacent prefixes (e.g. a projections/seed segment) in loopkit.config.json.
    planePrefixes: ['.loopkit/'],
    companionSegments: ['projections/', 'components/', 'styles/', 'test/', 'tests/', '__tests__/'],
    escalationPatterns: [
      'eventContracts', 'contracts/', 'authorization', '/migrations/',
      'billing', 'payment', 'paddle', 'money', 'publish', 'external',
    ],
    docCompanionGlobs: ['README.md', '**/README.md', 'CHANGELOG.md', 'docs/**'],
    operativeDocs: [],
    governanceCriticalPaths: ['src/approval.ts', 'src/acceptance.ts', 'src/armed.ts'],
  },
  touches: {
    conflictMode: 'prefix',
  },
  providers: {
    'claude-cli': { type: 'claude-cli', model: 'sonnet' },
    'codex-cli': { type: 'codex-cli' },
    'ollama': { type: 'ollama' },
  },
  sensitivityAllowlists: {
    public: ['claude-cli', 'codex-cli', 'ollama'],
    internal: ['claude-cli', 'codex-cli'],
    private: ['ollama'],
  },
  // Default chains: the conserved consulting-lane provider is NOT included.
  // Add 'ollama' to internal chain for degraded-routing fallback when claude-cli is down.
  chains: {
    internal: ['claude-cli'],
    public:   ['claude-cli'],
    private:  ['ollama'],
  },
  providerCooldownMs: 10 * 60 * 1000,   // 10 minutes half-open cooldown
  models: {
    conductor: 'sonnet',
    builderDefault: 'sonnet',
  },
  breakerN: 3,
  stalledBuildMinutes: 40,  // = buildTimeoutMinutes; reap alive-but-no-progress workers
  batchMaxItems: 1,  // 1 = co-location off (one item per worktree)
  buildTimeoutMinutes: 40,
  promptsDir: '.ai/loops/prompts',
  notifyHook: '.ai/notify-phone.sh',
  deployCommand: '',  // off by default; a deployment sets its own deploy-on-merge script
  dispatchKickLabel: '',  // off by default; a deployment sets the dispatch launchd label in loopkit.config.json
  mergeGateTimeoutMs: 10 * 60 * 1000,  // 10 min; raise if beat-load contention causes timeouts
  acceptance: {
    provisional: {
      enabled: true,
      afterHours: 48,
      requireJudgePass: true,
    },
    tiers: {
      enabled: true,
      // Framework default: no product UI surfaces of its own. A fork names its own
      // review-tier surface prefixes in loopkit.config.json.
      surfacePrefixes: [],
      autoAfterHours: 2,
      optionalAfterHours: 48,
      reviewAfterHours: 168,
      perBeatCap: 25,
      confidenceFloor: 0.7,
      calibration: {
        enabled: true,
        demoteAfterCleanAccepts: 5,
        demoteFactor: 0.5,
        promoteFactor: 2.0,
        windowFloorHours: 1,
        windowCeilingHours: 336,
      },
    },
  },
  scout: {
    enabled: true,
    model: 'haiku',
    timeoutMs: 300_000,
  },
  judge: {
    enabled: true,
    mode: 'advisory',
    model: 'sonnet',
    timeoutMs: 240_000,
    maxDiffChars: 20_000,
  },
  pathology: {
    enabled: true,
    model: 'opus',
    timeoutMs: 180_000,
    maxTrailEvents: 15,
    maxDiffChars: 12_000,
    blockedWaitTimeoutHours: 24,
  },
  playbook: {
    enabled: true,
    path: '.ai/loops/playbook.md',
    maxLines: 40,
  },
  salvage: {
    enabled: true,
    maxPatchKb: 256,
  },
  armed: [],
  quotaPressure: {
    thresholdPct: 80,
  },
  routing: { ...ROUTING_CONFIG_DEFAULTS },
  // Only the engineering reference lane by default. Additional lanes are added in loopkit.config.json.
  lanes: {
    engineering: { description: 'Engineering (reference lane)', gate: 'npm test', delivery: 'merge', publishGated: false },
  },
  slo: {
    reactorFreshSec: 300,
    dispatchFreshSec: 600,
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
    expectedLaunchdLabels: [],
    instanceProbes: {},
    cycleTimeMedianHours: 24,
    firstPassRate7dFloor: 0.5,
  },
  execution: {
    detachedDispatch: false,
  },
  portabilityPromotion: {
    enabled: false,
  },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the plane config. With LOOPKIT_HOME explicitly set, the plane-home config
 * (`$LOOPKIT_HOME/config/loopkit.json`) is the source; otherwise the repo-root
 * `loopkit.config.json` (embedded mode). Deliberately EXPLICIT-ONLY: the resolver's
 * ~/.loopkit auto-detection governs where the ledger lives, but config never switches
 * on ambient filesystem state — a machine-level ~/.loopkit must not silently change
 * what an embedded repo's beats do (and tests without the env var stay hermetic).
 * Missing or partially-set keys fall back to defaults.
 * Throws if the file exists but is not valid JSON.
 */
export function loadConfig(repoRoot: string): LoopkitConfig {
  const planeHome = process.env['LOOPKIT_HOME'];
  const configPath = planeHome
    ? join(planeHome, 'config', 'loopkit.json')
    : join(repoRoot, 'loopkit.config.json');
  let raw: Partial<LoopkitConfig> = {};
  try {
    const text = readFileSync(configPath, 'utf8');
    raw = JSON.parse(text) as Partial<LoopkitConfig>;
  } catch (e: unknown) {
    // File absent → use defaults entirely
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`loopkit.config.json parse error at ${configPath}: ${e}`);
    }
    // ENOENT is fine — use all defaults
  }

  // Deep merge (one level deep per key)
  return {
    loops: { ...DEFAULTS.loops, ...(raw.loops ?? {}) },
    gateCommand: raw.gateCommand ?? DEFAULTS.gateCommand,
    gateWorkdir: raw.gateWorkdir ?? DEFAULTS.gateWorkdir,
    appWorkdir: raw.appWorkdir ?? DEFAULTS.appWorkdir,
    depsWorkdirs: raw.depsWorkdirs ?? DEFAULTS.depsWorkdirs,
    worktreePrefix: raw.worktreePrefix ?? DEFAULTS.worktreePrefix,
    spineRegex: raw.spineRegex ?? DEFAULTS.spineRegex,
    autoApprove: { ...DEFAULTS.autoApprove, ...(raw.autoApprove ?? {}) },
    touches: { ...DEFAULTS.touches, ...(raw.touches ?? {}) },
    providers: { ...DEFAULTS.providers, ...(raw.providers ?? {}) },
    sensitivityAllowlists: {
      ...DEFAULTS.sensitivityAllowlists,
      ...(raw.sensitivityAllowlists ?? {}),
    },
    chains: mergeChains((raw as Partial<LoopkitConfig>).chains, DEFAULTS.chains),
    providerCooldownMs: (raw as Partial<LoopkitConfig>).providerCooldownMs ?? DEFAULTS.providerCooldownMs,
    models: { ...DEFAULTS.models, ...(raw.models ?? {}) },
    breakerN: raw.breakerN ?? DEFAULTS.breakerN,
    batchMaxItems: raw.batchMaxItems ?? DEFAULTS.batchMaxItems,
    buildTimeoutMinutes: raw.buildTimeoutMinutes ?? DEFAULTS.buildTimeoutMinutes,
    stalledBuildMinutes: raw.stalledBuildMinutes ?? DEFAULTS.stalledBuildMinutes,
    promptsDir: raw.promptsDir ?? DEFAULTS.promptsDir,
    notifyHook: raw.notifyHook ?? DEFAULTS.notifyHook,
    deployCommand: raw.deployCommand ?? DEFAULTS.deployCommand,
    dispatchKickLabel: raw.dispatchKickLabel ?? DEFAULTS.dispatchKickLabel,
    mergeGateTimeoutMs: raw.mergeGateTimeoutMs ?? DEFAULTS.mergeGateTimeoutMs,
    slo: { ...DEFAULTS.slo, ...((raw as Partial<LoopkitConfig>).slo ?? {}) },
    budget: (raw as Partial<LoopkitConfig>).budget,
    acceptance: mergeAcceptance((raw as Partial<LoopkitConfig>).acceptance, DEFAULTS.acceptance as NonNullable<LoopkitConfig['acceptance']>),
    scout: mergeScout(raw.scout, DEFAULTS.scout as Required<NonNullable<LoopkitConfig['scout']>>),
    judge: mergeJudge(raw.judge, DEFAULTS.judge as Required<NonNullable<LoopkitConfig['judge']>>),
    // WI-084: plain spread merge (no strict validator) — matches the contract's explicit
    // simplicity instruction; the pathologist is advisory/fail-open, so a malformed override
    // degrades to a default rather than needing a hard config-load error.
    pathology: { ...(DEFAULTS.pathology as Required<NonNullable<LoopkitConfig['pathology']>>), ...(raw.pathology ?? {}) },
    ledger: mergeLedger((raw as Partial<LoopkitConfig>).ledger),
    playbook: mergePlaybook((raw as Partial<LoopkitConfig>).playbook, DEFAULTS.playbook as Required<NonNullable<LoopkitConfig['playbook']>>),
    salvage: mergeSalvage((raw as Partial<LoopkitConfig>).salvage, DEFAULTS.salvage as Required<NonNullable<LoopkitConfig['salvage']>>),
    armed: mergeArmed((raw as Partial<LoopkitConfig>).armed),
    quotaPressure: mergeQuotaPressure(
      (raw as Partial<LoopkitConfig>).quotaPressure,
      DEFAULTS.quotaPressure as Required<NonNullable<LoopkitConfig['quotaPressure']>>,
    ),
    routing: mergeRoutingConfig((raw as Partial<LoopkitConfig>).routing, ROUTING_CONFIG_DEFAULTS),
    // lanes are config rows; the file's map (if any) wins over the engineering default.
    lanes: (raw as Partial<LoopkitConfig>).lanes ?? DEFAULTS.lanes,
    ci: mergeCi((raw as Partial<LoopkitConfig>).ci),
    healRules: mergeHealRules((raw as Partial<LoopkitConfig>).healRules),
    defaultTarget: typeof (raw as Partial<LoopkitConfig>).defaultTarget === 'string'
      ? (raw as Partial<LoopkitConfig>).defaultTarget
      : undefined,
    knowledge: mergeKnowledge((raw as Partial<LoopkitConfig>).knowledge),
    execution: mergeExecution((raw as Partial<LoopkitConfig>).execution, DEFAULTS.execution as Required<NonNullable<LoopkitConfig['execution']>>),
    portabilityPromotion: mergePortabilityPromotion(
      (raw as Partial<LoopkitConfig>).portabilityPromotion,
      DEFAULTS.portabilityPromotion as Required<NonNullable<LoopkitConfig['portabilityPromotion']>>,
    ),
  };
}

// ---------------------------------------------------------------------------
// Knowledge config validation + merge
// ---------------------------------------------------------------------------

/** Assert+normalize one knowledge entry: a non-empty string (glob/path) OR a source object
 *  ({ path: string; label?: string; kind?: 'markdown' | 'decision-log' }). Bad shapes throw
 *  so the operator catches misconfiguration early. */
function assertKnowledgeEntry(value: unknown, where: string): KnowledgeEntry {
  if (typeof value === 'string') {
    if (value.trim() === '') {
      throw new Error(`loopkit.config.json: ${where} must be a non-empty string or source object (got ${JSON.stringify(value)})`);
    }
    return value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`loopkit.config.json: ${where} must be a non-empty string or source object (got ${JSON.stringify(value)})`);
  }
  const r = value as Record<string, unknown>;
  const path = r['path'];
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`loopkit.config.json: ${where}.path must be a non-empty string (got ${JSON.stringify(path)})`);
  }
  const out: KnowledgeSource = { path };
  if ('label' in r && r['label'] !== undefined) {
    if (typeof r['label'] !== 'string') {
      throw new Error(`loopkit.config.json: ${where}.label must be a string (got ${JSON.stringify(r['label'])})`);
    }
    out.label = r['label'];
  }
  if ('kind' in r && r['kind'] !== undefined) {
    if (r['kind'] !== 'markdown' && r['kind'] !== 'decision-log') {
      throw new Error(`loopkit.config.json: ${where}.kind must be 'markdown' or 'decision-log' (got ${JSON.stringify(r['kind'])})`);
    }
    out.kind = r['kind'];
  }
  return out;
}

/** Assert one knowledge entry list is an array of non-empty strings or source objects. */
function assertKnowledgeEntryList(value: unknown, where: string): KnowledgeEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`loopkit.config.json: ${where} must be an array of strings or source objects (got ${JSON.stringify(value)})`);
  }
  return value.map((entry, i) => assertKnowledgeEntry(entry, `${where}[${i}]`));
}

/**
 * Resolve and validate the knowledge block. `paths` is an array of strings/source objects;
 * `targets` a map of such arrays keyed by target name/id. Bad shapes throw so the operator
 * catches misconfiguration early (same contract as mergeCi/mergeHealRules). Absent →
 * undefined — the console renders its instructive empty state, never an error.
 */
function mergeKnowledge(raw: unknown): KnowledgeConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`loopkit.config.json: knowledge must be an object (got ${JSON.stringify(raw)})`);
  }
  const r = raw as Record<string, unknown>;
  const out: KnowledgeConfig = {};
  if ('paths' in r && r['paths'] !== undefined) {
    out.paths = assertKnowledgeEntryList(r['paths'], 'knowledge.paths');
  }
  if ('targets' in r && r['targets'] !== undefined) {
    const t = r['targets'];
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      throw new Error(`loopkit.config.json: knowledge.targets must be an object (got ${JSON.stringify(t)})`);
    }
    const targets: Record<string, KnowledgeEntry[]> = {};
    for (const [name, list] of Object.entries(t as Record<string, unknown>)) {
      targets[name] = assertKnowledgeEntryList(list, `knowledge.targets.${name}`);
    }
    out.targets = targets;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quota-pressure config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the quotaPressure block. Unknown fields silently dropped; a bad
 * thresholdPct throws so the operator catches misconfiguration early (same contract as
 * mergeScout / mergeJudge).
 */
function mergeQuotaPressure(
  raw: LoopkitConfig['quotaPressure'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['quotaPressure']>>,
): LoopkitConfig['quotaPressure'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('thresholdPct' in r) {
    const v = r['thresholdPct'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) {
      throw new Error(`loopkit.config.json: quotaPressure.thresholdPct must be a number in (0, 100] (got ${JSON.stringify(v)})`);
    }
  }
  return {
    thresholdPct: typeof r['thresholdPct'] === 'number' && Number.isFinite(r['thresholdPct']) && (r['thresholdPct'] as number) > 0 && (r['thresholdPct'] as number) <= 100
      ? r['thresholdPct'] as number
      : defaults.thresholdPct,
  };
}

// ---------------------------------------------------------------------------
// Per-rule self-heal mode validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the healRules block. Each key's `mode`, if present, must be
 * exactly 'shadow' or 'armed' — bad shapes throw so the operator catches misconfiguration
 * early (same contract as mergeCi/mergeArmed). Absent rules default per BEAT_TOUCHING_HEAL_DEFAULTS:
 * rules whose action can kill the plane's own beats ship SHADOW by factory default (an adopter's
 * first long build must never be kickstarted mid-flight by an armed staleness heal); arming one
 * is an explicit operator config act. All other rules stay 'armed' when absent.
 */
/** Heal rules that act on the plane's OWN beats — shadow unless explicitly armed. */
export const BEAT_TOUCHING_HEAL_DEFAULTS: Record<string, HealRuleConfig> = {
  'loop-dispatch': { mode: 'shadow' },
  'loop-reactor': { mode: 'shadow' },
  'launchd': { mode: 'shadow' },
};

function mergeHealRules(raw: unknown): Record<string, HealRuleConfig> | undefined {
  if (raw === undefined) return { ...BEAT_TOUCHING_HEAL_DEFAULTS };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`loopkit.config.json: healRules must be an object (got ${JSON.stringify(raw)})`);
  }
  const out: Record<string, HealRuleConfig> = { ...BEAT_TOUCHING_HEAL_DEFAULTS };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`loopkit.config.json: healRules.${key} must be an object (got ${JSON.stringify(value)})`);
    }
    const mode = (value as Record<string, unknown>)['mode'];
    if (mode !== undefined && mode !== 'shadow' && mode !== 'armed') {
      throw new Error(`loopkit.config.json: healRules.${key}.mode must be 'shadow' or 'armed' (got ${JSON.stringify(mode)})`);
    }
    out[key] = { mode: mode as HealRuleConfig['mode'] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// CI re-enable config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the ci block. Unknown fields silently dropped; a non-string
 * reenableOn throws so the operator catches misconfiguration early.
 */
function mergeCi(raw: LoopkitConfig['ci'] | undefined): LoopkitConfig['ci'] {
  if (!raw) return undefined;
  const r = raw as Record<string, unknown>;
  if ('reenableOn' in r && typeof r['reenableOn'] !== 'string') {
    throw new Error(`loopkit.config.json: ci.reenableOn must be a string (got ${JSON.stringify(r['reenableOn'])})`);
  }
  return {
    reenableOn: typeof r['reenableOn'] === 'string' ? r['reenableOn'] as string : undefined,
  };
}

// ---------------------------------------------------------------------------
// Armed trigger-map validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the armed[] block. Each entry must have a non-empty string `id`,
 * a `predicate` of kind 'shell' with a non-empty `command`, and a `capture` with non-empty
 * `text`; optional `touches`/`priority` must be strings, optional `enabled` a boolean.
 * Duplicate ids across entries throw (the id is the dedup key — a collision would make one
 * predicate mask the other). Bad shapes throw so the operator catches misconfiguration
 * early (same contract as the other merge* validators). Absent → [].
 */
function mergeArmed(raw: unknown): ArmedItem[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`loopkit.config.json: armed must be an array (got ${JSON.stringify(raw)})`);
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`loopkit.config.json: armed[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const id = e['id'];
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(`loopkit.config.json: armed[${i}].id must be a non-empty string`);
    }
    if (seen.has(id.trim())) {
      throw new Error(`loopkit.config.json: armed[${i}].id '${id}' is a duplicate — armed ids must be unique (dedup key)`);
    }
    seen.add(id.trim());

    const pred = e['predicate'] as Record<string, unknown> | undefined;
    if (!pred || typeof pred !== 'object' || Array.isArray(pred)) {
      throw new Error(`loopkit.config.json: armed[${i}].predicate must be an object`);
    }
    if (pred['kind'] !== 'shell') {
      throw new Error(`loopkit.config.json: armed[${i}].predicate.kind must be 'shell' (got ${JSON.stringify(pred['kind'])})`);
    }
    if (typeof pred['command'] !== 'string' || !(pred['command'] as string).trim()) {
      throw new Error(`loopkit.config.json: armed[${i}].predicate.command must be a non-empty string`);
    }
    if ('timeoutMs' in pred) {
      const t = pred['timeoutMs'];
      if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
        throw new Error(`loopkit.config.json: armed[${i}].predicate.timeoutMs must be a positive finite number (got ${JSON.stringify(t)})`);
      }
    }

    const cap = e['capture'] as Record<string, unknown> | undefined;
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) {
      throw new Error(`loopkit.config.json: armed[${i}].capture must be an object`);
    }
    if (typeof cap['text'] !== 'string' || !(cap['text'] as string).trim()) {
      throw new Error(`loopkit.config.json: armed[${i}].capture.text must be a non-empty string`);
    }
    for (const k of ['touches', 'priority'] as const) {
      if (k in cap && typeof cap[k] !== 'string') {
        throw new Error(`loopkit.config.json: armed[${i}].capture.${k} must be a string (got ${JSON.stringify(cap[k])})`);
      }
    }
    if ('enabled' in e && typeof e['enabled'] !== 'boolean') {
      throw new Error(`loopkit.config.json: armed[${i}].enabled must be a boolean (got ${JSON.stringify(e['enabled'])})`);
    }

    const item: ArmedItem = {
      id: id.trim(),
      predicate: {
        kind: 'shell',
        command: (pred['command'] as string),
        ...(typeof pred['timeoutMs'] === 'number' ? { timeoutMs: pred['timeoutMs'] as number } : {}),
      },
      capture: {
        text: cap['text'] as string,
        ...(typeof cap['touches'] === 'string' ? { touches: cap['touches'] as string } : {}),
        ...(typeof cap['priority'] === 'string' ? { priority: cap['priority'] as string } : {}),
      },
      ...(typeof e['enabled'] === 'boolean' ? { enabled: e['enabled'] as boolean } : {}),
    };
    return item;
  });
}

// ---------------------------------------------------------------------------
// Chain config validation + merge
// ---------------------------------------------------------------------------

const KNOWN_PROVIDER_NAMES = new Set(['claude-cli', 'codex-cli', 'ollama']);

/**
 * Validate and merge the chains block. Unknown provider names in a chain throw
 * (misconfiguration caught early). Unknown fields are silently dropped.
 */
function mergeChains(
  raw: FallbackChains | undefined,
  defaults: FallbackChains,
): FallbackChains {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;

  function validateChain(key: string, value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new Error(`loopkit.config.json: chains.${key} must be an array of provider names (got ${JSON.stringify(value)})`);
    }
    for (const item of value) {
      if (typeof item !== 'string' || !KNOWN_PROVIDER_NAMES.has(item)) {
        throw new Error(`loopkit.config.json: chains.${key} contains unknown provider '${item}' — valid names: ${[...KNOWN_PROVIDER_NAMES].join(', ')}`);
      }
    }
    return value as string[];
  }

  return {
    internal: 'internal' in r ? validateChain('internal', r['internal']) : defaults.internal,
    public:   'public'   in r ? validateChain('public',   r['public'])   : defaults.public,
    private:  'private'  in r ? validateChain('private',  r['private'])  : defaults.private,
  };
}

// ---------------------------------------------------------------------------
// Acceptance config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the acceptance.provisional and acceptance.tiers blocks. Unknown
 * fields silently dropped; bad types for known fields throw so the operator catches
 * misconfiguration early (same contract as mergeScout / mergeJudge).
 */
function mergeAcceptance(
  raw: LoopkitConfig['acceptance'] | undefined,
  defaults: NonNullable<LoopkitConfig['acceptance']>,
): LoopkitConfig['acceptance'] {
  const dp = defaults.provisional ?? { enabled: true, afterHours: 48, requireJudgePass: true };
  const rawDc = defaults.tiers?.calibration;
  const dc: ResolvedTierCalibration = {
    enabled: rawDc?.enabled ?? true,
    demoteAfterCleanAccepts: rawDc?.demoteAfterCleanAccepts ?? 5,
    demoteFactor: rawDc?.demoteFactor ?? 0.5,
    promoteFactor: rawDc?.promoteFactor ?? 2.0,
    windowFloorHours: rawDc?.windowFloorHours ?? 1,
    windowCeilingHours: rawDc?.windowCeilingHours ?? 336,
  };
  const dt = defaults.tiers ?? {
    enabled: true,
    surfacePrefixes: [],
    autoAfterHours: 2,
    optionalAfterHours: 48,
    reviewAfterHours: 168,
    perBeatCap: 25,
    calibration: dc,
  };

  if (!raw) {
    return {
      provisional: { ...dp },
      tiers: { ...dt, surfacePrefixes: [...dt.surfacePrefixes!], calibration: { ...dc } },
    };
  }

  const rp = (raw as Record<string, unknown>)['provisional'] as Record<string, unknown> | undefined;
  const rt = (raw as Record<string, unknown>)['tiers'] as Record<string, unknown> | undefined;

  let provisional = { ...dp };
  if (rp) {
    if ('enabled' in rp && typeof rp['enabled'] !== 'boolean') {
      throw new Error(`loopkit.config.json: acceptance.provisional.enabled must be a boolean (got ${JSON.stringify(rp['enabled'])})`);
    }
    if ('afterHours' in rp) {
      const v = rp['afterHours'];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`loopkit.config.json: acceptance.provisional.afterHours must be a non-negative finite number (got ${JSON.stringify(v)})`);
      }
    }
    if ('requireJudgePass' in rp && typeof rp['requireJudgePass'] !== 'boolean') {
      throw new Error(`loopkit.config.json: acceptance.provisional.requireJudgePass must be a boolean (got ${JSON.stringify(rp['requireJudgePass'])})`);
    }
    provisional = {
      enabled: typeof rp['enabled'] === 'boolean' ? rp['enabled'] : dp.enabled,
      afterHours: typeof rp['afterHours'] === 'number' && Number.isFinite(rp['afterHours'] as number) && (rp['afterHours'] as number) >= 0
        ? rp['afterHours'] as number
        : dp.afterHours,
      requireJudgePass: typeof rp['requireJudgePass'] === 'boolean' ? rp['requireJudgePass'] : dp.requireJudgePass,
    };
  }

  let tiers = { ...dt, surfacePrefixes: [...dt.surfacePrefixes!], calibration: { ...dc } };
  if (rt) {
    if ('enabled' in rt && typeof rt['enabled'] !== 'boolean') {
      throw new Error(`loopkit.config.json: acceptance.tiers.enabled must be a boolean (got ${JSON.stringify(rt['enabled'])})`);
    }
    if ('surfacePrefixes' in rt) {
      const v = rt['surfacePrefixes'];
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        throw new Error(`loopkit.config.json: acceptance.tiers.surfacePrefixes must be an array of strings (got ${JSON.stringify(v)})`);
      }
    }
    for (const key of ['autoAfterHours', 'optionalAfterHours', 'reviewAfterHours'] as const) {
      if (key in rt) {
        const v = rt[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw new Error(`loopkit.config.json: acceptance.tiers.${key} must be a non-negative finite number (got ${JSON.stringify(v)})`);
        }
      }
    }
    if ('perBeatCap' in rt) {
      const v = rt['perBeatCap'];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
        throw new Error(`loopkit.config.json: acceptance.tiers.perBeatCap must be a positive integer (got ${JSON.stringify(v)})`);
      }
    }
    if ('confidenceFloor' in rt) {
      const v = rt['confidenceFloor'];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`loopkit.config.json: acceptance.tiers.confidenceFloor must be a number in [0, 1] (got ${JSON.stringify(v)})`);
      }
    }
    const calibration = mergeCalibration(rt['calibration'], dc);
    tiers = {
      enabled: typeof rt['enabled'] === 'boolean' ? rt['enabled'] : dt.enabled,
      surfacePrefixes: Array.isArray(rt['surfacePrefixes']) ? rt['surfacePrefixes'] as string[] : dt.surfacePrefixes!,
      autoAfterHours: typeof rt['autoAfterHours'] === 'number' ? rt['autoAfterHours'] as number : dt.autoAfterHours,
      optionalAfterHours: typeof rt['optionalAfterHours'] === 'number' ? rt['optionalAfterHours'] as number : dt.optionalAfterHours,
      reviewAfterHours: typeof rt['reviewAfterHours'] === 'number' ? rt['reviewAfterHours'] as number : dt.reviewAfterHours,
      perBeatCap: typeof rt['perBeatCap'] === 'number' ? rt['perBeatCap'] as number : dt.perBeatCap,
      confidenceFloor: typeof rt['confidenceFloor'] === 'number' ? rt['confidenceFloor'] as number : dt.confidenceFloor,
      calibration,
    };
  }

  return { provisional, tiers };
}

/** Fully-resolved (all-required) shape of acceptance.tiers.calibration after defaulting. */
interface ResolvedTierCalibration {
  enabled: boolean;
  demoteAfterCleanAccepts: number;
  demoteFactor: number;
  promoteFactor: number;
  windowFloorHours: number;
  windowCeilingHours: number;
}

/**
 * Resolve and validate the acceptance.tiers.calibration sub-block (verdict-history
 * self-tuning). Unknown fields silently dropped; bad types for known
 * fields throw, same contract as the sibling tier fields above.
 */
function mergeCalibration(
  raw: unknown,
  defaults: ResolvedTierCalibration,
): ResolvedTierCalibration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };
  const rc = raw as Record<string, unknown>;

  if ('enabled' in rc && typeof rc['enabled'] !== 'boolean') {
    throw new Error(`loopkit.config.json: acceptance.tiers.calibration.enabled must be a boolean (got ${JSON.stringify(rc['enabled'])})`);
  }
  if ('demoteAfterCleanAccepts' in rc) {
    const v = rc['demoteAfterCleanAccepts'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
      throw new Error(`loopkit.config.json: acceptance.tiers.calibration.demoteAfterCleanAccepts must be a positive integer (got ${JSON.stringify(v)})`);
    }
  }
  for (const key of ['demoteFactor', 'promoteFactor'] as const) {
    if (key in rc) {
      const v = rc[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new Error(`loopkit.config.json: acceptance.tiers.calibration.${key} must be a positive finite number (got ${JSON.stringify(v)})`);
      }
    }
  }
  for (const key of ['windowFloorHours', 'windowCeilingHours'] as const) {
    if (key in rc) {
      const v = rc[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`loopkit.config.json: acceptance.tiers.calibration.${key} must be a non-negative finite number (got ${JSON.stringify(v)})`);
      }
    }
  }

  return {
    enabled: typeof rc['enabled'] === 'boolean' ? rc['enabled'] : defaults.enabled,
    demoteAfterCleanAccepts: typeof rc['demoteAfterCleanAccepts'] === 'number' ? rc['demoteAfterCleanAccepts'] as number : defaults.demoteAfterCleanAccepts,
    demoteFactor: typeof rc['demoteFactor'] === 'number' ? rc['demoteFactor'] as number : defaults.demoteFactor,
    promoteFactor: typeof rc['promoteFactor'] === 'number' ? rc['promoteFactor'] as number : defaults.promoteFactor,
    windowFloorHours: typeof rc['windowFloorHours'] === 'number' ? rc['windowFloorHours'] as number : defaults.windowFloorHours,
    windowCeilingHours: typeof rc['windowCeilingHours'] === 'number' ? rc['windowCeilingHours'] as number : defaults.windowCeilingHours,
  };
}

// ---------------------------------------------------------------------------
// Scout config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the scout block. Unknown fields are silently dropped; bad
 * types for known fields throw so the operator knows early (not silently wrong).
 */
function mergeScout(
  raw: LoopkitConfig['scout'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['scout']>>,
): LoopkitConfig['scout'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('enabled' in r && typeof r['enabled'] !== 'boolean') {
    throw new Error(`loopkit.config.json: scout.enabled must be a boolean (got ${JSON.stringify(r['enabled'])})`);
  }
  if ('model' in r && (typeof r['model'] !== 'string' || !(r['model'] as string).trim())) {
    throw new Error(`loopkit.config.json: scout.model must be a non-empty string (got ${JSON.stringify(r['model'])})`);
  }
  if ('timeoutMs' in r) {
    const t = r['timeoutMs'];
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
      throw new Error(`loopkit.config.json: scout.timeoutMs must be a positive finite number (got ${JSON.stringify(t)})`);
    }
  }
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : defaults.enabled,
    model: typeof r['model'] === 'string' && (r['model'] as string).trim()
      ? r['model'] as string
      : defaults.model,
    timeoutMs: typeof r['timeoutMs'] === 'number' && Number.isFinite(r['timeoutMs']) && (r['timeoutMs'] as number) > 0
      ? r['timeoutMs'] as number
      : defaults.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Judge config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the judge block. The mode field accepts ONLY 'advisory' —
 * any other value is a config error (gating mode is not yet earned; calibration
 * comes first via `loopctl verdicts`). Unknown fields are silently dropped; bad
 * types for known fields throw.
 */
function mergeJudge(
  raw: LoopkitConfig['judge'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['judge']>>,
): LoopkitConfig['judge'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('enabled' in r && typeof r['enabled'] !== 'boolean') {
    throw new Error(`loopkit.config.json: judge.enabled must be a boolean (got ${JSON.stringify(r['enabled'])})`);
  }
  if ('mode' in r) {
    if (r['mode'] !== 'advisory') {
      throw new Error(
        `loopkit.config.json: judge.mode '${r['mode']}' is not valid — only 'advisory' is accepted. ` +
        `Gating mode is not yet earned; calibration via 'loopctl verdicts' comes first.`,
      );
    }
  }
  if ('model' in r && (typeof r['model'] !== 'string' || !(r['model'] as string).trim())) {
    throw new Error(`loopkit.config.json: judge.model must be a non-empty string (got ${JSON.stringify(r['model'])})`);
  }
  if ('timeoutMs' in r) {
    const t = r['timeoutMs'];
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
      throw new Error(`loopkit.config.json: judge.timeoutMs must be a positive finite number (got ${JSON.stringify(t)})`);
    }
  }
  if ('maxDiffChars' in r) {
    const m = r['maxDiffChars'];
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
      throw new Error(`loopkit.config.json: judge.maxDiffChars must be a positive finite number (got ${JSON.stringify(m)})`);
    }
  }
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : defaults.enabled,
    mode: 'advisory',
    model: typeof r['model'] === 'string' && (r['model'] as string).trim()
      ? r['model'] as string
      : defaults.model,
    timeoutMs: typeof r['timeoutMs'] === 'number' && Number.isFinite(r['timeoutMs']) && (r['timeoutMs'] as number) > 0
      ? r['timeoutMs'] as number
      : defaults.timeoutMs,
    maxDiffChars: typeof r['maxDiffChars'] === 'number' && Number.isFinite(r['maxDiffChars']) && (r['maxDiffChars'] as number) > 0
      ? r['maxDiffChars'] as number
      : defaults.maxDiffChars,
  };
}

// ---------------------------------------------------------------------------
// Ledger config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the ledger block. Unknown fields silently dropped;
 * bad types for known fields throw.
 */
function mergeLedger(
  raw: LoopkitConfig['ledger'] | undefined,
): LoopkitConfig['ledger'] {
  if (!raw) return undefined;
  const r = raw as Record<string, unknown>;
  if ('opsRetentionMonths' in r) {
    const v = r['opsRetentionMonths'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
      throw new Error(
        `loopkit.config.json: ledger.opsRetentionMonths must be a positive integer (got ${JSON.stringify(v)})`,
      );
    }
  }
  return {
    opsRetentionMonths: typeof r['opsRetentionMonths'] === 'number' ? r['opsRetentionMonths'] as number : undefined,
  };
}

// ---------------------------------------------------------------------------
// Playbook config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the playbook block. Unknown fields silently dropped;
 * bad types for known fields throw so the operator catches misconfiguration early.
 */
function mergePlaybook(
  raw: LoopkitConfig['playbook'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['playbook']>>,
): LoopkitConfig['playbook'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('enabled' in r && typeof r['enabled'] !== 'boolean') {
    throw new Error(`loopkit.config.json: playbook.enabled must be a boolean (got ${JSON.stringify(r['enabled'])})`);
  }
  if ('path' in r && (typeof r['path'] !== 'string' || !(r['path'] as string).trim())) {
    throw new Error(`loopkit.config.json: playbook.path must be a non-empty string (got ${JSON.stringify(r['path'])})`);
  }
  if ('maxLines' in r) {
    const v = r['maxLines'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
      throw new Error(`loopkit.config.json: playbook.maxLines must be a positive integer (got ${JSON.stringify(v)})`);
    }
  }
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : defaults.enabled,
    path: typeof r['path'] === 'string' && (r['path'] as string).trim() ? r['path'] as string : defaults.path,
    maxLines: typeof r['maxLines'] === 'number' && Number.isFinite(r['maxLines']) && (r['maxLines'] as number) >= 1
      ? r['maxLines'] as number
      : defaults.maxLines,
  };
}

// ---------------------------------------------------------------------------
// Salvage config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the salvage block. Unknown fields are silently dropped;
 * bad types for known fields throw so the operator catches misconfiguration early.
 */
function mergeSalvage(
  raw: LoopkitConfig['salvage'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['salvage']>>,
): LoopkitConfig['salvage'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('enabled' in r && typeof r['enabled'] !== 'boolean') {
    throw new Error(`loopkit.config.json: salvage.enabled must be a boolean (got ${JSON.stringify(r['enabled'])})`);
  }
  if ('maxPatchKb' in r) {
    const v = r['maxPatchKb'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`loopkit.config.json: salvage.maxPatchKb must be a positive finite number (got ${JSON.stringify(v)})`);
    }
  }
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : defaults.enabled,
    maxPatchKb: typeof r['maxPatchKb'] === 'number' && Number.isFinite(r['maxPatchKb']) && (r['maxPatchKb'] as number) > 0
      ? r['maxPatchKb'] as number
      : defaults.maxPatchKb,
  };
}

// ---------------------------------------------------------------------------
// Execution (ADR-008 phase A) config validation + merge
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the execution block. Unknown fields are silently dropped; a bad
 * type for the known `detachedDispatch` field throws so the operator catches
 * misconfiguration early (same contract as mergeSalvage/mergeQuotaPressure). Absent block
 * or absent/bad-typed field → the default (false) — an unset flag must be byte-for-byte
 * today's synchronous behaviour (ADR-008).
 */
function mergeExecution(
  raw: LoopkitConfig['execution'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['execution']>>,
): LoopkitConfig['execution'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('detachedDispatch' in r && typeof r['detachedDispatch'] !== 'boolean') {
    throw new Error(`loopkit.config.json: execution.detachedDispatch must be a boolean (got ${JSON.stringify(r['detachedDispatch'])})`);
  }
  return {
    detachedDispatch: typeof r['detachedDispatch'] === 'boolean' ? r['detachedDispatch'] : defaults.detachedDispatch,
  };
}

function mergePortabilityPromotion(
  raw: LoopkitConfig['portabilityPromotion'] | undefined,
  defaults: Required<NonNullable<LoopkitConfig['portabilityPromotion']>>,
): LoopkitConfig['portabilityPromotion'] {
  if (!raw) return { ...defaults };
  const r = raw as Record<string, unknown>;
  if ('enabled' in r && typeof r['enabled'] !== 'boolean') {
    throw new Error(`loopkit.config.json: portabilityPromotion.enabled must be a boolean (got ${JSON.stringify(r['enabled'])})`);
  }
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : defaults.enabled,
  };
}

// ---------------------------------------------------------------------------
// Plane-home resolution (LOOPKIT_HOME)
// ---------------------------------------------------------------------------

/**
 * Where the plane's own state lives (docs/event-model.md §"The two repos").
 *
 * - `plane-home` mode: a dedicated, git-initialized root (default `~/.loopkit/`) holding
 *   `ledger/`, `config/loopkit.json`, `targets/`, and `runs/`.
 * - `embedded` mode: the legacy in-repo layout — the ledger lives at `<repoRoot>/.ai/ledger`
 *   inside the driven repo itself, config at `<repoRoot>/loopkit.config.json`.
 */
export interface PlaneHomePaths {
  mode: 'plane-home' | 'embedded';
  /** Plane-home root in plane-home mode; the driven repo root in embedded mode. */
  root: string;
  /** The ONE ledger directory (monthly JSONL segments). */
  ledgerDir: string;
  /** Plane-level config file (`<root>/config/loopkit.json` or `<repoRoot>/loopkit.config.json`). */
  configPath: string;
  /** Target registration records (projection convenience; the ledger is truth). */
  targetsDir: string;
  /** Worker logs, exit files, scratch — namespaced per target. */
  runsDir: string;
  /** True when the deprecated LOOPKIT_LEDGER override redirected the ledger dir. */
  ledgerOverridden: boolean;
}

export interface ResolvePlaneHomeOptions {
  /** The driven repo root (used for the embedded-mode fallback). Default: process.cwd(). */
  repoRoot?: string;
  /** Environment map. Default: process.env. Injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Home directory used for the `~/.loopkit` default. Default: os.homedir(). */
  homeDir?: string;
  /** Deprecation-warning sink. Default: one line to stderr. */
  warn?: (message: string) => void;
}

/** True when `dir` contains at least one non-empty ledger segment (work-/ops-YYYY-MM.jsonl). */
function ledgerHasEvents(dir: string): boolean {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return false;
  }
  return files.some(f => {
    if (!/^(work|ops)-\d{4}-\d{2}\.jsonl$/.test(f)) return false;
    try {
      return statSync(join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });
}

function planeHomeAt(root: string, ledgerDir: string, ledgerOverridden: boolean): PlaneHomePaths {
  return {
    mode: 'plane-home',
    root,
    ledgerDir,
    configPath: join(root, 'config', 'loopkit.json'),
    targetsDir: join(root, 'targets'),
    runsDir: join(root, 'runs'),
    ledgerOverridden,
  };
}

function embeddedAt(repoRoot: string, ledgerDir: string, ledgerOverridden: boolean): PlaneHomePaths {
  return {
    mode: 'embedded',
    root: repoRoot,
    ledgerDir,
    configPath: join(repoRoot, 'loopkit.config.json'),
    targetsDir: join(repoRoot, '.ai', 'targets'),
    runsDir: join(repoRoot, '.ai', 'runs'),
    ledgerOverridden,
  };
}

/**
 * Resolve where the plane's state lives — the ONE source of truth for the
 * ledger/config/targets/runs paths. Precedence, first match wins:
 *
 *  1. `LOOPKIT_HOME` set → plane-home mode at that path. If `LOOPKIT_LEDGER` is ALSO set,
 *     it wins for the ledger dir ONLY (deprecated; a one-line stderr warning is emitted) —
 *     config/targets/runs stay under `LOOPKIT_HOME`.
 *  2. `LOOPKIT_LEDGER` set (without `LOOPKIT_HOME`) → legacy embedded mode pinned entirely:
 *     the ledger dir is exactly that path, no plane-home is created or git-inited, and the
 *     deprecation warning is emitted. This keeps every pre-plane-home deployment and test
 *     harness byte-for-byte on its old behavior.
 *  3. `~/.loopkit` exists → plane-home mode there (the machine has adopted the plane-home
 *     layout; docs/event-model.md pins the plane as machine-level infrastructure).
 *  4. `<repoRoot>/.ai/ledger` holds at least one non-empty segment → embedded mode (an
 *     existing in-repo plane keeps working untouched — never strand an existing setup).
 *  5. Fresh machine, nothing anywhere → plane-home mode at the `~/.loopkit` default.
 *
 * Pure resolution — no filesystem writes. Pair with {@link ensurePlaneHome} before the
 * first ledger append so commit-on-append durability never silently no-ops.
 */
export function resolvePlaneHome(opts: ResolvePlaneHomeOptions = {}): PlaneHomePaths {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  const defaultHome = join(home, '.loopkit');

  const envHome = env['LOOPKIT_HOME']?.trim();
  const envLedger = env['LOOPKIT_LEDGER']?.trim();

  // 1. Explicit plane-home.
  if (envHome) {
    const root = resolve(envHome);
    if (envLedger) {
      const ledgerDir = resolve(envLedger);
      warn(`[loopkit] LOOPKIT_LEDGER is deprecated — it overrides the ledger dir only (${ledgerDir}); the rest of the plane-home stays under LOOPKIT_HOME (${root})`);
      return planeHomeAt(root, ledgerDir, true);
    }
    return planeHomeAt(root, join(root, 'ledger'), false);
  }

  // 2. Legacy explicit ledger override — pins the old embedded behavior entirely.
  if (envLedger) {
    const ledgerDir = resolve(envLedger);
    warn(`[loopkit] LOOPKIT_LEDGER is deprecated — using legacy ledger dir ${ledgerDir}; set LOOPKIT_HOME to adopt the plane-home layout`);
    return embeddedAt(repoRoot, ledgerDir, true);
  }

  // 3. The machine has a plane-home already.
  if (existsSync(defaultHome)) {
    return planeHomeAt(defaultHome, join(defaultHome, 'ledger'), false);
  }

  // 4. Existing embedded in-repo plane.
  const inRepoLedger = join(repoRoot, '.ai', 'ledger');
  if (ledgerHasEvents(inRepoLedger)) {
    return embeddedAt(repoRoot, inRepoLedger, false);
  }

  // 5. Fresh default.
  return planeHomeAt(defaultHome, join(defaultHome, 'ledger'), false);
}

/** Injectable git runner for {@link ensurePlaneHome} (tests exercise the failure path). */
export type PlaneHomeGitRunner = (args: string[]) => { status: number | null; stderr: string };

function defaultGitRunner(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('git', args, { stdio: 'pipe', encoding: 'utf8' });
  return { status: r.error ? -1 : r.status, stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

/**
 * Mirrors the union-merge rule the embedded layout carries in the driven repo's root
 * `.gitattributes` for its `.ai/ledger/*.jsonl`, re-rooted to the plane-home layout.
 */
const PLANE_HOME_GITATTRIBUTES = `# The ledger is append-only JSONL — two branches that both append lines are never a
# real conflict, but the default 3-way merge can still resolve the file to only one side's
# committed tree. git's built-in \`union\` driver instead takes lines from both sides;
# id-dedupe-on-read in the ledger reader covers a union merge echoing one line into both hunks.
ledger/*.jsonl merge=union
`;

const PLANE_HOME_GITIGNORE = `# Worker logs, exit files, scratch — runtime residue, not durable plane state.
runs/
# Transient coordination files (mkdir lock + watch pulse), never plane history.
ledger/.ledger.lock/
ledger/.pulse
`;

/**
 * Enforce-or-init the plane-home before the first ledger append. Embedded mode is a no-op
 * (the driven repo is already a git repo with its own `.gitattributes` rule).
 *
 * In plane-home mode: creates the pinned layout (`ledger/`, `config/`, `targets/`, `runs/`),
 * writes the union-merge `.gitattributes` if missing, and — when the root is not yet a git
 * repository — `git init`s it with a `.gitignore` and an initial commit, so commit-on-append
 * durability applies to plane state from the very first event. A failed `git init`/commit
 * THROWS loudly: a plane-home that silently isn't a repo would make every ledger-residue
 * commit a silent no-op, which is exactly the failure mode this guard exists to kill.
 *
 * Idempotent — re-running against an initialized plane-home changes nothing.
 */
export function ensurePlaneHome(home: PlaneHomePaths, runGit: PlaneHomeGitRunner = defaultGitRunner): void {
  if (home.mode !== 'plane-home') return;

  mkdirSync(home.root, { recursive: true });
  mkdirSync(home.ledgerDir, { recursive: true });
  mkdirSync(home.targetsDir, { recursive: true });
  mkdirSync(home.runsDir, { recursive: true });
  mkdirSync(dirname(home.configPath), { recursive: true });

  const gitattributesPath = join(home.root, '.gitattributes');
  if (!existsSync(gitattributesPath)) {
    writeFileSync(gitattributesPath, PLANE_HOME_GITATTRIBUTES, 'utf8');
  }

  if (existsSync(join(home.root, '.git'))) return;

  const init = runGit(['-C', home.root, 'init', '--quiet']);
  if (init.status !== 0) {
    throw new Error(
      `[loopkit] plane-home git init FAILED at ${home.root}: ${init.stderr.trim() || `exit ${init.status}`} — ` +
      `commit-on-append durability requires the plane-home to be a git repository; refusing to run without it`,
    );
  }

  // A fresh machine may have no git identity configured; without one every commit
  // (including ledger-residue commits) fails. Pin a local identity only when none resolves.
  const identity = runGit(['-C', home.root, 'config', 'user.email']);
  if (identity.status !== 0) {
    runGit(['-C', home.root, 'config', 'user.name', 'loopkit']);
    runGit(['-C', home.root, 'config', 'user.email', 'loopkit@localhost']);
  }

  const gitignorePath = join(home.root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, PLANE_HOME_GITIGNORE, 'utf8');
  }

  const add = runGit(['-C', home.root, 'add', '--', '.gitignore', '.gitattributes']);
  if (add.status !== 0) {
    throw new Error(`[loopkit] plane-home initial git add FAILED at ${home.root}: ${add.stderr.trim() || `exit ${add.status}`}`);
  }
  const commit = runGit(['-C', home.root, 'commit', '--quiet', '-m', 'chore: initialize plane-home']);
  if (commit.status !== 0) {
    throw new Error(
      `[loopkit] plane-home initial commit FAILED at ${home.root}: ${commit.stderr.trim() || `exit ${commit.status}`} — ` +
      `refusing to run with a half-initialized plane-home`,
    );
  }
}

export { DEFAULTS as CONFIG_DEFAULTS };
