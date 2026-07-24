/**
 * worktree-reaper.ts — reap leaked build worktrees the beats' own cleanup missed.
 *
 * The dispatch and reactor beats each remove their build worktree when a build finishes
 * (dispatch.removeWorktree, on every terminal path). But a worker process KILLED
 * mid-cleanup — reboot, crash, orphan-churn, a `kickstart -k` mid-build — never reaches
 * that removal call, so the directory is orphaned next to its target repo. Over weeks
 * these accumulate (the leaked-worktree class).
 *
 * runDoctor() cannot clean these: it only knows worktrees still attached to a `building`
 * fold item via `rec.currentBuild.worktree`. Once an item ships/retires, the fold clears
 * its `currentBuild`, so the leftover directory has no fold owner and the doctor never
 * sees it again. This module works from FILESYSTEM TRUTH instead — for every registered
 * target it reads `git worktree list --porcelain` (which returns ONLY worktrees actually
 * registered to that target's .git) and reaps the plane-managed ones no live owner holds.
 *
 * Scoping is target-aware and manifest-free. The plane is multi-target: each target owns
 * its own repo, and its build worktrees are SIBLINGS of that repo named by the plane's own
 * convention — `<...>-wi-<n>-a<m>` (dispatch.targetWorktreeDirName / local build branch) or
 * `<...>-appr-<n>` (the reactor's approval-merge tree). `worktreePrefix` lives only in each
 * target's on-disk manifest, not in the fold, so we do NOT key on it — the name convention
 * plus "must be a real registered worktree of the target repo" is a tighter, dependency-free
 * scope. A human's manually `git worktree add`-ed sibling is spared (it won't match the
 * convention), and an unrelated directory never appears at all (it isn't a registered
 * worktree).
 *
 * Safety invariant (the one hard rule): NEVER reap a worktree a live owner holds.
 * A directory is reaped only when EVERY liveness signal reads dead:
 *   - it is a sibling of a registered target repo matching the managed-name convention,
 *   - it is not the primary checkout,
 *   - it is not referenced by any in-flight build in the fold (currentBuild.worktree),
 *   - it is not git-locked by a live pid,
 *   - it is older than the grace window (a just-created worktree whose build event has not
 *     yet landed in the fold looks ownerless — the grace window covers that race).
 * When the age signal is unreadable we DEFER (absence of a signal is not evidence of a
 * stall) — the same fail-safe the doctor uses for progress.
 *
 * Non-destructive by construction: `git worktree remove` deletes only the working
 * directory, never the branch ref, so a reaped worktree's commits remain recoverable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { FoldResult } from './fold.js';
import { PidProbe, defaultPidProbe } from './doctor.js';

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  path: string;
  /** short branch name, or undefined when detached */
  branch?: string;
  locked: boolean;
  /** pid parsed from the lock reason when it contains "pid <N>" (git agent locks embed it) */
  lockPid?: number;
}

export type ReapVerdict =
  | { reap: false; reason: string }
  | { reap: true; reason: 'leaked' };

/**
 * Does this basename match a plane-created worktree? Kept as the single predicate for the
 * naming convention shared by dispatch.targetWorktreeDirName (`…-wi-N-aM`), the local build
 * branch (`<prefix>wi-N-aM`), and the reactor's approval tree (`<prefix>appr-N`).
 */
export function isManagedWorktreeName(base: string): boolean {
  return /-wi-\d+-a\d+$/.test(base) || /-appr-\d+$/.test(base);
}

export interface ReapContext {
  /** the target repo root whose siblings we are classifying (the primary worktree) */
  repoRoot: string;
  /** worktree paths a live build owns (from the fold's currentBuild records), global */
  activeBuildPaths: Set<string>;
  now: number;
  graceMs: number;
  pidProbe: PidProbe;
  /** injectable dir-mtime reader; null when unreadable ⇒ defer (never reap on no signal) */
  mtimeMsOf: (path: string) => number | null;
}

export interface ReapResult {
  reaped: Array<{ path: string; reason: string }>;
  /** managed-but-spared, with the guard that spared each — for the beat log */
  spared: Array<{ path: string; reason: string }>;
}

/**
 * Parse `git worktree list --porcelain`. Blocks are blank-line separated; the lines we
 * read are `worktree <path>`, `branch refs/heads/<name>` (absent ⇒ detached), and
 * `locked` / `locked <reason>`. A lock reason of the form "...pid <N>..." yields lockPid.
 */
export function parseWorktreePorcelain(out: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  const flush = (): void => { if (cur) { worktrees.push(cur); cur = null; } };
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length), locked: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
      const m = /pid (\d+)/.exec(line);
      if (m) cur.lockPid = parseInt(m[1]!, 10);
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return worktrees;
}

/**
 * Pure verdict for one worktree relative to a target repo root. See the module header for
 * the safety invariant — every `reap: false` branch names the guard that spared it (all
 * scope/liveness guards run before any reap can be returned).
 */
export function classifyWorktree(wt: WorktreeInfo, ctx: ReapContext): ReapVerdict {
  const wtPath = resolve(wt.path);
  const root = resolve(ctx.repoRoot);
  // Scope: a sibling of the repo root (dispatch builds at `<repoRoot>/../<name>`) whose name
  // matches the plane's worktree convention. Excludes the primary checkout (identity), the
  // harness's own `.claude/worktrees/*` (they live UNDER the root, not beside it), and any
  // human-added sibling worktree that doesn't follow the convention.
  if (wtPath === root) return { reap: false, reason: 'main-worktree' };
  if (dirname(wtPath) !== dirname(root)) return { reap: false, reason: 'not-sibling' };
  if (!isManagedWorktreeName(basename(wtPath))) return { reap: false, reason: 'not-managed' };
  // Liveness guards — never reap a worktree a live owner holds.
  if (ctx.activeBuildPaths.has(wt.path) || ctx.activeBuildPaths.has(wtPath)) {
    return { reap: false, reason: 'active-build' };
  }
  if (wt.locked && wt.lockPid != null && ctx.pidProbe(wt.lockPid)) {
    return { reap: false, reason: 'live-locker' };
  }
  // Age: defer when unreadable (no signal ≠ dead); spare anything younger than the grace
  // window (covers the race where dispatch has created the dir but not yet emitted the
  // build event that would put it in activeBuildPaths).
  const mtime = ctx.mtimeMsOf(wtPath);
  if (mtime == null) return { reap: false, reason: 'age-unknown' };
  if (ctx.now - mtime < ctx.graceMs) return { reap: false, reason: 'too-young' };
  return { reap: true, reason: 'leaked' };
}

/**
 * Best-effort worktree removal — mirrors dispatch.removeWorktree: try
 * `git worktree remove --force`, fall back to `rm -rf` + `git worktree prune` when git
 * refuses (e.g. a stale lock). Never throws. Kept local so the reaper carries no
 * dependency on the dispatch module graph.
 */
function removeWorktreeLocal(repoRoot: string, wtPath: string): void {
  const removed = spawnSync('git', ['worktree', 'remove', wtPath, '--force'],
    { cwd: repoRoot, stdio: 'pipe' });
  if (removed.status !== 0) {
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  }
}

function listWorktreesGit(repoRoot: string): WorktreeInfo[] {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return parseWorktreePorcelain(r.stdout);
}

export interface ReapDeps {
  now: number;
  graceMs: number;
  pidProbe?: PidProbe;
  /** injectables for tests */
  listWorktrees?: (repoRoot: string) => WorktreeInfo[];
  mtimeMsOf?: (p: string) => number | null;
  removeWorktree?: (repoRoot: string, wtPath: string) => void;
}

/**
 * Sweep leaked build worktrees across the primary repo and every registered target. For
 * each target repo it reads that repo's own registered worktrees (worktrees are registered
 * to the target's .git, so a single global list would miss them), classifies each, and
 * removes the leaked ones. Best-effort and side-effect-isolated: a failure on one worktree
 * or one target never aborts the sweep, and the function never throws.
 */
export function reapLeakedWorktrees(
  primaryRepoRoot: string,
  foldResult: FoldResult,
  deps: ReapDeps,
): ReapResult {
  const pidProbe = deps.pidProbe ?? defaultPidProbe;
  const removeWorktree = deps.removeWorktree ?? removeWorktreeLocal;
  const listWorktrees = deps.listWorktrees ?? listWorktreesGit;
  const mtimeMsOf = deps.mtimeMsOf ?? ((p: string): number | null => {
    try { return existsSync(p) ? statSync(p).mtimeMs : null; } catch { return null; }
  });

  // Any worktree the fold still attaches to a build is the doctor's to reap, never ours.
  const activeBuildPaths = new Set<string>();
  for (const rec of foldResult.items.values()) {
    const wt = rec.currentBuild?.worktree;
    if (wt) { activeBuildPaths.add(wt); activeBuildPaths.add(resolve(wt)); }
  }

  // The repos to sweep: the primary repoRoot plus every registered target, deduped by
  // resolved path (the primary is frequently also a registered target).
  const repoRoots: string[] = [];
  const seen = new Set<string>();
  for (const rr of [primaryRepoRoot, ...[...foldResult.targets.values()].map(t => t.repoPath)]) {
    if (!rr) continue;
    const key = resolve(rr);
    if (seen.has(key)) continue;
    seen.add(key);
    repoRoots.push(rr);
  }

  const reaped: ReapResult['reaped'] = [];
  const spared: ReapResult['spared'] = [];
  for (const repoRoot of repoRoots) {
    let worktrees: WorktreeInfo[];
    try { worktrees = listWorktrees(repoRoot); } catch { continue; }
    const ctx: ReapContext = {
      repoRoot, activeBuildPaths, now: deps.now, graceMs: deps.graceMs, pidProbe, mtimeMsOf,
    };
    for (const wt of worktrees) {
      const verdict = classifyWorktree(wt, ctx);
      if (verdict.reap) {
        try { removeWorktree(repoRoot, wt.path); reaped.push({ path: wt.path, reason: verdict.reason }); }
        catch { /* best-effort: a failed removal is retried next sweep */ }
      } else if (verdict.reason === 'active-build' || verdict.reason === 'live-locker'
        || verdict.reason === 'too-young' || verdict.reason === 'age-unknown') {
        // Only surface guards that spared a genuinely-managed worktree (skip the noise of
        // the main checkout, non-siblings, and unrelated dirs).
        spared.push({ path: wt.path, reason: verdict.reason });
      }
    }
  }
  return { reaped, spared };
}
