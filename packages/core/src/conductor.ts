/**
 * conductor.ts — attended session-mode executor over the claim-lease kernel
 * (`loopctl conduct`).
 *
 * Given the session's ACTIVE claims (fold.ts isClaimActive — the one predicate), the
 * conductor clusters the items into file-ownership groups with the SAME Touches conflict
 * logic every beat uses (touches.ts touchesConflict — one parser, no second implementation),
 * runs each cluster in ONE worktree of its resolved repo (target.ts resolveRegisteredTarget —
 * the one registration-lookup rule), builds the cluster's items SEQUENTIALLY through the
 * provider, runs the manifest's gate ONCE per cluster, and merges on green immediately,
 * closing every item with `item.merged` (commit + sessionId). Clusters run CONCURRENTLY;
 * merges into any single repo are serialized behind a per-repo mutex.
 *
 * Events are identical in shape to beat-built items (build.dispatched → gate.* →
 * build.finished → item.merged), so console/history/audit stay mode-agnostic.
 *
 * MVP degradations (deliberate, noted for the integrator):
 *  - Where the beat path would park a DECISION (spine/overstep/judge gates), the conductor
 *    applies none of those boundary gates yet: a red cluster gate parks `hold` and other
 *    clusters continue; interactive inline prompting is a later slice.
 *  - (resolved, ADR-010 step 3) The provider invocation + gate/log helpers are the SAME
 *    `runGate`/`persistWorkerLog` the dispatch beat uses (both now exported from
 *    beats/dispatch.ts) — the local forks (`runClusterGate`/`persistConductLog`) are deleted.
 *  - (resolved) Worktree dependency provisioning is applied per cluster from the manifest; a target whose
 *    gate needs installed node_modules should gate via a command that installs, until the
 *    beat's worktree-deps helper is shared.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { appendEvents, loadAllEventsWithQuarantine } from './ledger.js';
import { fold, FoldResult, ItemRecord, isClaimActive } from './fold.js';
import { makeEvent, resolveAttachmentPaths } from './schema.js';
import { touchesConflict } from './touches.js';
import { resolveRegisteredTarget } from './target.js';
import { LoopkitConfig, loadConfig } from './config.js';
import { LlmProvider } from './providers/types.js';
import { makeRegistry, makeFileHealthFns } from './providers/registry.js';
import {
  buildPrompt,
  CommitMode,
  loadApprovedTouches,
  mergeEvidence,
  openBuildWorktree,
  persistWorkerLog,
  removeWorktree,
  runPostBuildGuards,
  judgeVerdictEvents,
  groupSensitivity,
  resolveProviderForSensitivity,
  toolsForCommitMode,
} from './beats/dispatch.js';
import {
  activeSessionClaims,
  heartbeatSession,
  claimItems,
  readCurrentSession,
  startSession,
  writeCurrentSession,
} from './session.js';

// ---------------------------------------------------------------------------
// Touches clustering (pure — reuses the ONE conflict predicate)
// ---------------------------------------------------------------------------

export interface TouchesClusterInput {
  id: string;
  touches?: string;
}

export interface TouchesClusters<T extends TouchesClusterInput> {
  /** Touches-disjoint clusters that may run concurrently (each shares a footprint internally). */
  parallel: T[][];
  /** Touches-less / wildcard items: one SERIAL cluster (missing = wildcard conflicts with all). */
  serial: T[];
}

/**
 * Cluster items by Touches footprint via touchesConflict (touches.ts — the one parser).
 * Items whose Touches overlap land in the same cluster (transitively: an item bridging two
 * clusters merges them). Items with NO touches (or the '*' wildcard) would conflict with
 * everything, so they form one dedicated serial cluster instead of gluing the world together.
 */
export function clusterByTouches<T extends TouchesClusterInput>(items: T[]): TouchesClusters<T> {
  const serial: T[] = [];
  const scoped: T[] = [];
  for (const it of items) {
    if (!it.touches || it.touches.trim() === '' || it.touches.trim() === '*') serial.push(it);
    else scoped.push(it);
  }
  const clusters: T[][] = [];
  for (const it of scoped) {
    const matching = clusters.filter(c => c.some(m => touchesConflict(it.touches, m.touches)));
    if (matching.length === 0) {
      clusters.push([it]);
    } else {
      // Merge every matching cluster into the first, then add the bridging item.
      const host = matching[0]!;
      for (const other of matching.slice(1)) {
        host.push(...other);
        clusters.splice(clusters.indexOf(other), 1);
      }
      host.push(it);
    }
  }
  return { parallel: clusters, serial };
}

// ---------------------------------------------------------------------------
// Cluster planning (target resolution per cluster)
// ---------------------------------------------------------------------------

export interface ConductClusterPlan {
  index: number;
  /** True for the touches-less cluster (its items run in one worktree, strictly in order). */
  serial: boolean;
  /** Registered-target handle; absent = the plane's own repo. */
  target?: { targetId: string; name: string };
  repoPath: string;
  defaultBranch: string;
  gateCommand: string;
  gateWorkdir: string;
  worktreePrefix: string;
  buildTimeoutMinutes: number;
  /** node_modules provisioning roots from the target manifest (plane config's list for the plane repo). */
  depsWorkdirs: string[];
  items: ItemRecord[];
  /** Set when the cluster's target could not be resolved — the cluster is skipped. */
  error?: string;
}

/** Current branch of a repo (merge destination for the plane's own repo). */
function currentBranch(repoPath: string): string {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, stdio: 'pipe' });
  const name = r.status === 0 ? r.stdout.toString().trim() : '';
  return name && name !== 'HEAD' ? name : 'master';
}

/**
 * Plan the session's clusters: group claimed items by target identity, resolve each
 * target's repo + manifest ONCE (resolveRegisteredTarget — the one rule), then cluster each
 * group by Touches. Pure planning — no worktree, no append; `conduct --dry-run` prints this.
 */
export function planClusters(
  claimed: ItemRecord[],
  foldResult: FoldResult,
  opts: { repoRoot: string; cfg: LoopkitConfig },
): ConductClusterPlan[] {
  // Group by target identity ('' = the plane's own repo).
  const groups = new Map<string, ItemRecord[]>();
  for (const rec of claimed) {
    const key = rec.targetId ?? rec.target ?? '';
    const g = groups.get(key);
    if (g) g.push(rec);
    else groups.set(key, [rec]);
  }

  const plans: ConductClusterPlan[] = [];
  let index = 0;
  for (const [key, recs] of groups) {
    let base: Omit<ConductClusterPlan, 'index' | 'serial' | 'items' | 'error'>;
    let targetRef: { targetId: string; name: string } | undefined;
    if (key === '') {
      const cfg = opts.cfg;
      base = {
        repoPath: opts.repoRoot,
        defaultBranch: currentBranch(opts.repoRoot),
        gateCommand: cfg.gateCommand,
        gateWorkdir: cfg.gateWorkdir,
        worktreePrefix: cfg.worktreePrefix,
        buildTimeoutMinutes: cfg.buildTimeoutMinutes,
        depsWorkdirs: cfg.depsWorkdirs ?? [],
      };
    } else {
      const first = recs[0]!;
      const resolved = resolveRegisteredTarget(foldResult.targets, {
        ...(first.target !== undefined ? { target: first.target } : {}),
        ...(first.targetId !== undefined ? { targetId: first.targetId } : {}),
      });
      if (!resolved.ok) {
        plans.push({
          index: index++, serial: false, items: recs, error: resolved.error,
          repoPath: '', defaultBranch: '', gateCommand: '', gateWorkdir: '.',
          worktreePrefix: 'loop-', buildTimeoutMinutes: 45, depsWorkdirs: [],
        });
        continue;
      }
      targetRef = { targetId: resolved.reg.targetId, name: resolved.reg.name };
      base = {
        repoPath: resolved.reg.repoPath,
        defaultBranch: resolved.manifest.defaultBranch,
        gateCommand: resolved.manifest.gateCommand,
        gateWorkdir: resolved.manifest.gateWorkdir,
        worktreePrefix: resolved.manifest.worktreePrefix,
        buildTimeoutMinutes: resolved.manifest.buildTimeoutMinutes,
        depsWorkdirs: resolved.manifest.depsWorkdirs,
      };
    }
    const { parallel, serial } = clusterByTouches(recs);
    for (const cluster of parallel) {
      plans.push({
        index: index++, serial: false, ...(targetRef ? { target: targetRef } : {}), ...base,
        items: cluster,
      });
    }
    if (serial.length > 0) {
      plans.push({
        index: index++, serial: true, ...(targetRef ? { target: targetRef } : {}), ...base,
        items: serial,
      });
    }
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Commit contract (ADR-010): a human is present in this lane, so workers commit their own
// output (multi-commit slices stay possible) — the shared prompt clause and the granted
// toolset both derive from this ONE value via toolsForCommitMode, so they cannot drift apart.
// ---------------------------------------------------------------------------

const CONDUCT_COMMIT_MODE: CommitMode = 'worker';

/** Serialize merges into one repo across concurrently running clusters. */
class RepoMutex {
  private chains = new Map<string, Promise<unknown>>();
  async run<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(repo) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(repo, next.catch(() => undefined));
    return next;
  }
}

// ---------------------------------------------------------------------------
// Conduct
// ---------------------------------------------------------------------------

export interface ConductOptions {
  ledgerDir: string;
  runDir: string;
  /** The plane's own repo root (build destination for untargeted items; config home). */
  repoRoot: string;
  /** Claim every queued unclaimed item into this session before planning. */
  claimAllQueued?: boolean;
  /** Print the cluster plan and exit without building. */
  dryRun?: boolean;
  /** Explicit session; default: the run dir's current session, else a fresh one is started. */
  sessionId?: string;
  ttlMinutes?: number;
  /** Injected provider (tests). Default: registry-resolved, health-aware, tool-capable. */
  provider?: LlmProvider;
  /** Injected config (tests). Default: loadConfig(repoRoot). */
  config?: LoopkitConfig;
  /** Injected clock (tests). */
  nowMs?: () => number;
}

export interface ConductClusterOutcome {
  index: number;
  items: string[];
  target?: string;
  serial: boolean;
  outcome: 'merged' | 'gate-red' | 'dry-run' | 'skipped' | 'error';
  mergeCommit?: string;
  detail?: string;
}

export interface ConductResult {
  sessionId: string;
  dryRun: boolean;
  clusters: ConductClusterOutcome[];
  detail?: string;
}

function makeConductRegistry(cfg: LoopkitConfig, runDir: string): ReturnType<typeof makeRegistry> {
  return makeRegistry({
    providers: Object.fromEntries(
      Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }]),
    ),
    sensitivityAllowlists: cfg.sensitivityAllowlists,
    chains: cfg.chains,
    cooldownMs: cfg.providerCooldownMs,
  }, makeFileHealthFns(runDir));
}

export async function runConduct(opts: ConductOptions): Promise<ConductResult> {
  const cfg = opts.config ?? loadConfig(opts.repoRoot);
  const now = opts.nowMs ?? (() => Date.now());
  const dryRun = opts.dryRun ?? false;

  // ── Session resolution: explicit → current pointer → fresh (never in dry-run) ──────────
  let events = await loadAllEventsWithQuarantine(opts.ledgerDir);
  let result = fold(events);
  let sessionId = opts.sessionId ?? readCurrentSession(opts.runDir);
  const active = sessionId !== undefined
    && result.sessions.has(sessionId)
    && result.sessions.get(sessionId)!.endedAt === undefined;
  if (!active) {
    if (dryRun) {
      sessionId = sessionId ?? '(dry-run: new session)';
    } else {
      const started = await startSession(opts.ledgerDir, { source: 'conduct' });
      sessionId = started.sessionId;
      writeCurrentSession(opts.runDir, sessionId);
    }
  }

  // ── Claim-all-queued (real run appends; dry-run simulates) ─────────────────────────────
  if (opts.claimAllQueued && !dryRun) {
    await claimItems(opts.ledgerDir, {
      sessionId: sessionId!,
      allQueued: true,
      ...(opts.ttlMinutes !== undefined ? { ttlMinutes: opts.ttlMinutes } : {}),
      nowMs: now(),
    });
  }
  events = await loadAllEventsWithQuarantine(opts.ledgerDir);
  result = fold(events);

  let claimed = active || !dryRun ? activeSessionClaims(result, sessionId!, now()) : [];
  if (dryRun && opts.claimAllQueued) {
    // Simulate what --claim-all-queued would add: queued items not actively claimed elsewhere.
    const have = new Set(claimed.map(r => r.id));
    for (const rec of result.items.values()) {
      if (rec.state !== 'queued' || have.has(rec.id)) continue;
      if (isClaimActive(rec, result.sessions, now()) && rec.claim?.sessionId !== sessionId) continue;
      claimed.push(rec);
    }
    claimed = [...claimed].sort((a, b) => a.id.localeCompare(b.id));
  }

  if (claimed.length === 0) {
    return { sessionId: sessionId!, dryRun, clusters: [], detail: 'no claimed items for this session' };
  }

  const plans = planClusters(claimed, result, { repoRoot: opts.repoRoot, cfg });

  if (dryRun) {
    return {
      sessionId: sessionId!,
      dryRun: true,
      clusters: plans.map(p => ({
        index: p.index,
        items: p.items.map(i => i.id),
        ...(p.target ? { target: p.target.name } : {}),
        serial: p.serial,
        outcome: 'dry-run' as const,
        detail: p.error
          ? p.error
          : `${p.repoPath} → ${p.defaultBranch} · gate: ${p.gateCommand} · touches: ${p.items.map(i => i.touches ?? '(none)').join(' | ')}`,
      })),
    };
  }

  // TRUST-HARDENING (defect: sensitivity bypass): a cluster shares ONE worktree + one prompt-per-
  // item, so it must resolve its provider against the STRICTEST member's sensitivity, fail-closed —
  // resolving a single beat-global `internal` provider once and reusing it for every cluster would
  // send a private-only cluster's spec + worktree contents to whatever the internal chain returns.
  // With a registry (production) each cluster re-resolves per-tier in runCluster; the injected-
  // provider test path (opts.provider) carries no registry and uses that single provider unchanged.
  const registry = opts.provider ? null : makeConductRegistry(cfg, opts.runDir);
  const provider = opts.provider ?? null;
  // Preflight: if there is no injected provider AND the registry can't resolve even the internal
  // tier, no cluster can build — surface the same "no provider" error as before rather than
  // per-cluster failing an already-doomed run.
  if (!provider && registry && !registry.resolveWithHealth('internal', { requireTools: true })
      && !plans.every(p => registry.resolveWithHealth(groupSensitivity(p.items), { requireTools: true }))) {
    return {
      sessionId: sessionId!, dryRun: false,
      clusters: plans.map(p => ({
        index: p.index, items: p.items.map(i => i.id), serial: p.serial,
        outcome: 'error' as const, detail: 'no tool-capable provider available',
      })),
      detail: 'no tool-capable provider available',
    };
  }

  const mutex = new RepoMutex();
  const outcomes = await Promise.all(
    plans.map(p => runCluster(p, { ...opts, sessionId: sessionId!, cfg, provider, registry, mutex })),
  );
  return { sessionId: sessionId!, dryRun: false, clusters: outcomes };
}

interface ClusterCtx extends Omit<ConductOptions, 'provider'> {
  sessionId: string;
  cfg: LoopkitConfig;
  /** Injected single provider (test path) or null when a registry resolves per-cluster. */
  provider: LlmProvider | null;
  /** Provider registry (production) or null on the injected-provider test path. */
  registry: ReturnType<typeof makeRegistry> | null;
  mutex: RepoMutex;
}

async function runCluster(plan: ConductClusterPlan, ctx: ClusterCtx): Promise<ConductClusterOutcome> {
  const ids = plan.items.map(i => i.id);
  const base: ConductClusterOutcome = {
    index: plan.index, items: ids, serial: plan.serial,
    ...(plan.target ? { target: plan.target.name } : {}),
    outcome: 'skipped',
  };
  if (plan.error) return { ...base, outcome: 'skipped', detail: plan.error };

  // TRUST-HARDENING (defect: sensitivity bypass): resolve THIS cluster's provider against its
  // strictest member's sensitivity, fail-closed. No allowed+healthy provider for that tier ⇒ error
  // out the cluster (other clusters continue) rather than route it through a disallowed provider.
  const clusterSensitivity = groupSensitivity(plan.items);
  const clusterProvider = resolveProviderForSensitivity(ctx.registry, ctx.provider, clusterSensitivity, { requireTools: true });
  if (!clusterProvider) {
    return {
      ...base,
      outcome: 'error',
      detail: `sensitivity(${clusterSensitivity}): no allowed+healthy provider — fail-closed (never routed to a disallowed provider)`,
    };
  }

  const sesSuffix = ctx.sessionId.replace(/^ses-/, '');
  const dirName = `${plan.worktreePrefix}conduct-${sesSuffix}-c${plan.index}`;
  const branch = dirName;
  const wtPath = join(plan.repoPath, '..', dirName);

  // One worktree per cluster, branched from the repo's current HEAD (WI-172: shared git
  // sequence with the dispatch beat's own worktree-creation call sites — node_modules
  // provisioning uses the same rule as the dispatch target lane: without it, any gate needing
  // a local toolchain exits 127 in a fresh worktree; a failed file: dep build is a real red).
  const opened = openBuildWorktree(plan.repoPath, wtPath, branch, plan.depsWorkdirs);
  if (!opened.ok) {
    const detail = opened.stage === 'worktree-add'
      ? `worktree add failed: ${opened.reason}`
      : `deps provisioning failed: ${opened.reason}`;
    return { ...base, outcome: 'error', detail };
  }
  const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath, stdio: 'pipe' })
    .stdout?.toString().trim();

  // ── Build the cluster's items SEQUENTIALLY in the shared worktree ──────────────────────
  const built: ItemRecord[] = [];
  const failures: string[] = [];
  for (const rec of plan.items) {
    const attempt = (rec.attempts ?? 0) + 1;
    const model = rec.model ?? ctx.cfg.models.builderDefault;
    await appendEvents(ctx.ledgerDir, [makeEvent('conduct', rec.id, 'build.dispatched', {
      attempt, worktree: wtPath, branch, pid: process.pid, provider: clusterProvider.name, model,
    })]);
    const spec = rec.spec ?? rec.sourceText ?? '';
    // ADR-010: the attended conductor lane keeps commitMode 'worker' — a human is present, and
    // multi-commit slices are wanted here (unlike the unattended dispatch-side-commit lanes).
    // Prompt clause and toolset both derive from CONDUCT_COMMIT_MODE via toolsForCommitMode, so
    // they cannot drift apart the way they did pre-ADR-010 (this lane hard-parked on every
    // build: BUILDER_TOOLS was granted but the shared prompt still said "you do NOT hold a
    // git-commit tool", so the worker never committed and the cluster always hit "no commit").
    const res = await clusterProvider.run({
      prompt: buildPrompt(spec, rec.repairContext, resolveAttachmentPaths(rec.sourceText), undefined, undefined, undefined, undefined, undefined, undefined, CONDUCT_COMMIT_MODE),
      model,
      cwd: wtPath,
      tools: toolsForCommitMode(CONDUCT_COMMIT_MODE),
      timeoutMs: plan.buildTimeoutMinutes * 60 * 1000,
    });
    persistWorkerLog(ctx.runDir, rec.id, attempt, res.ok ? res.text : (res.error ?? ''));
    if (res.ok && res.usage) {
      await appendEvents(ctx.ledgerDir, [makeEvent('conduct', rec.id, 'cost.usage', {
        provider: clusterProvider.name, loop: 'conduct',
        tokens: (res.usage.in ?? 0) + (res.usage.out ?? 0), usd: res.usage.usd, wi: rec.id,
      })]);
    }
    if (!res.ok) {
      const reason = `session build failed: ${res.error}`;
      await appendEvents(ctx.ledgerDir, [makeEvent('conduct', rec.id, 'build.crashed', { reason })]);
      failures.push(`${rec.id}: ${reason}`);
    } else {
      built.push(rec);
    }
    // Dead-man liveness: the conduct loop heartbeats between items.
    await heartbeatSession(ctx.ledgerDir, ctx.sessionId);
  }

  if (built.length === 0) {
    removeWorktree(plan.repoPath, wtPath);
    spawnSync('git', ['branch', '-D', branch], { cwd: plan.repoPath, stdio: 'pipe' });
    return { ...base, outcome: 'error', detail: `no item built: ${failures.join('; ')}` };
  }

  // ── Post-build guard pipeline (ADR-010 point 2) ────────────────────────────────────────
  // commitMode stays 'worker' (a human is present — CONDUCT_COMMIT_MODE above). Touches-overstep
  // and judge are NEWLY APPLIED (this file's top-of-file comment used to call their absence out
  // as an MVP degradation — no longer true). Spine is scoped to clusters on the PLANE's OWN repo
  // (`!plan.target`) — a target cluster's changed files live in a foreign repo with no spine
  // concept of its own (same reasoning as finalizeTargetBuild). Touches-overstep uses the UNION
  // of the cluster's declared prefixes, same rule the batch beat lane applies to a co-located group.
  const clusterTouches = plan.items.map(r => r.touches).filter((t): t is string => !!t).join(',') || undefined;
  const clusterEvents = await loadAllEventsWithQuarantine(ctx.ledgerDir);
  const approvedTouches = plan.items.flatMap(r => loadApprovedTouches(clusterEvents, r.id));
  const guardOutcome = await runPostBuildGuards({
    wtPath, branch, baseSha: baseSha ?? '',
    touches: clusterTouches,
    manifestIds: plan.items.map(r => r.id),
    subjectId: plan.items[0]!.id,
    spineRegex: plan.target ? '' : ctx.cfg.spineRegex,
    gateCommand: plan.gateCommand,
    gateWorkdir: plan.gateWorkdir,
    gateTimeoutMs: plan.buildTimeoutMinutes * 60 * 1000,
    approvedTouches,
    judge: {
      provider: clusterProvider,
      model: ctx.cfg.judge?.model ?? 'sonnet',
      timeoutMs: ctx.cfg.judge?.timeoutMs ?? 240_000,
      itemId: plan.items[0]!.id,
      spec: plan.items[0]!.spec ?? plan.items[0]!.sourceText ?? '',
      itemTouches: clusterTouches,
    },
  }, {
    commitMode: CONDUCT_COMMIT_MODE,
    touchesOverstep: true,
    spineCheck: !plan.target,
    judge: ctx.cfg.judge?.enabled ?? true,
    gateWrapper: 'runGate',
  });

  if (guardOutcome.kind === 'no-commit' || guardOutcome.kind === 'dirty-worktree') {
    const reason = guardOutcome.kind === 'no-commit' ? 'cluster produced no commit' : guardOutcome.reason;
    await appendEvents(ctx.ledgerDir, built.flatMap(rec => [
      makeEvent('conduct', rec.id, 'gate.failed', { reason }),
      makeEvent('conduct', rec.id, 'item.parked', { reason, parkKind: 'hold' as const }),
    ]));
    return { ...base, outcome: 'gate-red', detail: reason };
  }
  if (guardOutcome.kind === 'touches-overstep' || guardOutcome.kind === 'spine') {
    // Attended mode: a human is present, so a boundary overstep parks `hold` (same desk as any
    // other conductor park) rather than the beat's `decision` kind — the operator running this
    // session sees it immediately, not via a separate needs-you queue.
    await appendEvents(ctx.ledgerDir, built.flatMap(rec => [
      makeEvent('conduct', rec.id, 'gate.failed', { reason: guardOutcome.reason }),
      makeEvent('conduct', rec.id, 'item.parked', { reason: guardOutcome.reason, parkKind: 'hold' as const }),
    ]));
    return { ...base, outcome: 'gate-red', detail: `${guardOutcome.reason} (worktree kept: ${wtPath})` };
  }
  if (guardOutcome.kind === 'gate-red') {
    // Keep the worktree for inspection; park the cluster's items and let other clusters run.
    await appendEvents(ctx.ledgerDir, built.flatMap(rec => [
      makeEvent('conduct', rec.id, 'gate.failed', { reason: guardOutcome.reason }),
      makeEvent('conduct', rec.id, 'item.parked', {
        reason: `cluster gate red: ${guardOutcome.reason}`, parkKind: 'hold' as const,
      }),
    ]));
    return { ...base, outcome: 'gate-red', detail: `${guardOutcome.reason} (worktree kept: ${wtPath})` };
  }

  // ── Judge verdict (advisory) — persisted here (ADR-010 stage-2 fix), same shared shape the
  // dispatch beat's target/batch lanes use. One judge call covers the whole cluster (the pipeline
  // judges once per invocation, keyed to plan.items[0]), so its verdict is recorded against EVERY
  // built member — matching how gate.passed/item.merged already apply to the whole cluster below.
  const judgeEvents = built.flatMap(rec => judgeVerdictEvents(rec.id, 'conduct', guardOutcome.judgeVerdict));
  if (judgeEvents.length > 0) await appendEvents(ctx.ledgerDir, judgeEvents);

  // ── Merge the cluster branch (per-repo mutex: concurrent clusters never race a checkout) ─
  const changedFiles = guardOutcome.changedFiles;
  const mergeResult = await ctx.mutex.run(plan.repoPath, async () => {
    const co = spawnSync('git', ['checkout', plan.defaultBranch], { cwd: plan.repoPath, stdio: 'pipe' });
    if (co.status !== 0) {
      return { ok: false as const, reason: `cannot checkout '${plan.defaultBranch}': ${co.stderr?.toString().trim()}` };
    }
    const merge = spawnSync('git', [
      'merge', '--no-ff', '-m', `conduct: ${ids.join(' ')} (${ctx.sessionId})`, branch,
    ], { cwd: plan.repoPath, stdio: 'pipe' });
    if (merge.status !== 0) {
      spawnSync('git', ['merge', '--abort'], { cwd: plan.repoPath, stdio: 'pipe' });
      return { ok: false as const, reason: `merge conflict on '${plan.defaultBranch}'` };
    }
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: plan.repoPath, stdio: 'pipe' })
      .stdout?.toString().trim() ?? '';
    return { ok: true as const, commit };
  });

  if (!mergeResult.ok) {
    await appendEvents(ctx.ledgerDir, built.flatMap(rec => [
      makeEvent('conduct', rec.id, 'gate.failed', { reason: mergeResult.reason }),
      makeEvent('conduct', rec.id, 'item.parked', {
        reason: `cluster merge failed: ${mergeResult.reason}`, parkKind: 'hold' as const,
      }),
    ]));
    return { ...base, outcome: 'gate-red', detail: `${mergeResult.reason} (worktree kept: ${wtPath})` };
  }

  // Cleanup, then close every built item with the SAME event shape the beats emit.
  removeWorktree(plan.repoPath, wtPath);
  spawnSync('git', ['branch', '-D', branch], { cwd: plan.repoPath, stdio: 'pipe' });
  const evidence = mergeEvidence(baseSha, mergeResult.commit, changedFiles, plan.gateCommand);
  await appendEvents(ctx.ledgerDir, built.flatMap(rec => [
    makeEvent('conduct', rec.id, 'gate.passed', { tests: 'cluster gate green' }),
    makeEvent('conduct', rec.id, 'build.finished', { commit: mergeResult.commit }),
    makeEvent('conduct', rec.id, 'item.merged', {
      commit: mergeResult.commit, sessionId: ctx.sessionId, ...evidence,
    }),
  ]));
  return {
    ...base,
    outcome: 'merged',
    mergeCommit: mergeResult.commit,
    ...(failures.length > 0 ? { detail: `partial: ${failures.join('; ')}` } : {}),
  };
}
