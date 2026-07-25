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
 * Safety invariant (the one hard rule): NEVER reap a worktree a live owner holds, and NEVER
 * destroy uncommitted work. A directory is reaped only when EVERY liveness signal reads dead:
 *   - it is a sibling of a registered target repo matching the managed-name convention,
 *   - it is not the primary checkout,
 *   - it is not referenced by any in-flight build in the fold (currentBuild.worktree),
 *   - it is not covered by an active session claim (isClaimActive) on the WI its name embeds
 *     — this is what makes attended-session worktrees (created outside dispatch, never
 *     registered as a `currentBuild`) safe from this sweep,
 *   - it is CLEAN — no modified/staged/untracked files (`git status --porcelain` empty). A
 *     dirty tree is refused (spared + logged), never force-removed: this is the fix for the
 *     defect where `git worktree remove --force` overrode git's own refusal to drop a dirty
 *     tree and silently destroyed an attended builder's in-progress edits. We refuse rather
 *     than salvage-then-remove here — salvage (captureSalvage) exists for the doctor's
 *     fold-attached orphan/stall path, which knows the item id, attempt, and run dir; this
 *     reaper by design runs on worktrees the fold does NOT own, so the safer default is to
 *     leave a dirty leaked worktree in place (costs disk) than to guess wrong on ownership.
 *   - it is older than the grace window, where "older" is measured against the NEWEST mtime
 *     found anywhere under the tree (bounded scan, `.git`/`node_modules` excluded) rather than
 *     the root directory's own mtime — a directory's mtime only changes when its direct
 *     entries change, so edits under nested source dirs never bumped the old root-mtime clock,
 *     making a build look 40-minutes-idle the instant it was created. A just-created worktree
 *     whose build event has not yet landed in the fold also looks ownerless — the grace window
 *     covers that race.
 * When the age signal is unreadable we DEFER (absence of a signal is not evidence of a
 * stall) — the same fail-safe the doctor uses for progress.
 *
 * The porcelain `locked` field is parsed but never trusted as a liveness signal: nothing in
 * loopkit ever runs `git worktree lock`, so a "live-locker" guard keyed on it would be dead
 * code that reads as protection while never firing. Real liveness comes from the fold (active
 * build / active claim) and the dirty-tree check, not from git's advisory lock.
 *
 * Non-destructive by construction: `git worktree remove` deletes only the working
 * directory, never the branch ref, so a reaped worktree's commits remain recoverable. (Dirty,
 * *uncommitted* changes have no ref at all, which is exactly why they get the refuse-not-force
 * treatment above instead.)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { FoldResult, isClaimActive } from './fold.js';

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  path: string;
  /** short branch name, or undefined when detached */
  branch?: string;
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
  /** injectable dir-mtime reader; null when unreadable ⇒ defer (never reap on no signal) */
  mtimeMsOf: (path: string) => number | null;
  /** injectable dirty-tree check; true = uncommitted changes present ⇒ never force-remove */
  isDirty: (path: string) => boolean;
  /** every item currently carrying an ACTIVE session claim (isClaimActive already applied) */
  claimedItemIds: Set<string>;
}

export interface ReapResult {
  reaped: Array<{ path: string; reason: string }>;
  /** managed-but-spared, with the guard that spared each — for the beat log */
  spared: Array<{ path: string; reason: string }>;
}

/**
 * Parse `git worktree list --porcelain`. Blocks are blank-line separated; the lines we
 * read are `worktree <path>` and `branch refs/heads/<name>` (absent ⇒ detached). The
 * porcelain also emits `locked`/`locked <reason>` lines, but we deliberately do not parse or
 * trust them as a liveness signal here — see the module header ("the porcelain `locked`
 * field... dead code").
 */
export function parseWorktreePorcelain(out: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  const flush = (): void => { if (cur) { worktrees.push(cur); cur = null; } };
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length) };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return worktrees;
}

/**
 * Extract the WI item id a managed worktree's name embeds, so we can check the fold for an
 * active session claim on it. Matches the same `-wi-<n>-a<attempt>` segment as
 * isManagedWorktreeName's first alternative; the `-appr-<n>` approval-tree convention carries
 * no item id (it's a merge scratch tree, not a claimable work item) so it returns undefined.
 */
export function extractWorktreeItemId(base: string): string | undefined {
  const m = /-wi-(\d+)-a\d+$/.exec(base);
  return m ? `WI-${m[1]}` : undefined;
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
  // Claim-aware: an attended session that claimed the WI this worktree's name embeds owns it
  // even though dispatch never recorded a `currentBuild` for it (claims are how attended work
  // is safe from the away beats in the first place — see fold.ts isClaimActive).
  const itemId = extractWorktreeItemId(basename(wtPath));
  if (itemId && ctx.claimedItemIds.has(itemId)) {
    return { reap: false, reason: 'claimed' };
  }
  // Dirty-tree guard: never force-remove uncommitted work. Refuse-and-log rather than
  // salvage-then-remove (see module header) — a leaked worktree costs disk, a wrongly
  // destroyed one costs work.
  if (ctx.isDirty(wtPath)) {
    return { reap: false, reason: 'dirty' };
  }
  // Age: defer when unreadable (no signal ≠ dead); spare anything younger than the grace
  // window (covers the race where dispatch has created the dir but not yet emitted the
  // build event that would put it in activeBuildPaths). Measured against the newest mtime
  // ANYWHERE in the tree (see mtimeMsOf's default implementation below), not the root dir's
  // own mtime, so activity in nested source dirs is not invisible to this clock.
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

/** Directory names never descended into by the bounded mtime scan or the dirty check. */
const SCAN_EXCLUDE = new Set(['.git', 'node_modules']);
/** Hard cap on directories visited by the bounded mtime scan — a runaway tree defers, it
 * never hangs the beat. */
const SCAN_DIR_CAP = 20_000;

/**
 * Default staleness clock: the newest mtime found ANYWHERE under `root` (files and dirs),
 * bounded by SCAN_DIR_CAP and never descending into `.git` or `node_modules`. Replaces the
 * old root-directory-mtime-only signal, which never advanced when only nested files changed
 * (a directory's own mtime reflects only its direct entries) — the exact bug that made an
 * actively-edited worktree look 40-minutes-idle from the moment it was created. Returns null
 * (⇒ defer, never reap) when the root itself is unreadable; a mid-scan error on one entry is
 * skipped rather than aborting the whole scan (best-effort, matches the reaper's other
 * defaults).
 */
export function newestMtimeMs(root: string): number | null {
  let newest: number | null = null;
  let visited = 0;
  const consider = (ms: number): void => { if (newest == null || ms > newest) newest = ms; };
  let rootStat;
  try { rootStat = statSync(root); } catch { return null; }
  consider(rootStat.mtimeMs);
  const stack: string[] = [root];
  while (stack.length > 0 && visited < SCAN_DIR_CAP) {
    const dir = stack.pop()!;
    visited++;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (SCAN_EXCLUDE.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try { consider(statSync(full).mtimeMs); } catch { /* skip unreadable entry */ }
      }
    }
  }
  return newest;
}

/**
 * Default dirty-tree check: true iff `git status --porcelain` reports ANY modified, staged,
 * or untracked entry. Untracked files matter most here — a brand-new file the worker just
 * created is pure loss if force-removed, and `git worktree remove --force` would otherwise
 * happily delete it. Fails closed: an unreadable/erroring git call is treated as dirty (spare
 * it) rather than clean (never risk force-removing on an inconclusive check).
 */
function isDirtyGit(wtPath: string): boolean {
  const r = spawnSync('git', ['status', '--porcelain'],
    { cwd: wtPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return true; // unreadable ⇒ fail closed
  return r.stdout.trim().length > 0;
}

export interface ReapDeps {
  now: number;
  graceMs: number;
  /** injectables for tests */
  listWorktrees?: (repoRoot: string) => WorktreeInfo[];
  mtimeMsOf?: (p: string) => number | null;
  isDirty?: (p: string) => boolean;
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
  const removeWorktree = deps.removeWorktree ?? removeWorktreeLocal;
  const listWorktrees = deps.listWorktrees ?? listWorktreesGit;
  const mtimeMsOf = deps.mtimeMsOf ?? newestMtimeMs;
  const isDirty = deps.isDirty ?? isDirtyGit;

  // Any worktree the fold still attaches to a build is the doctor's to reap, never ours.
  const activeBuildPaths = new Set<string>();
  for (const rec of foldResult.items.values()) {
    const wt = rec.currentBuild?.worktree;
    if (wt) { activeBuildPaths.add(wt); activeBuildPaths.add(resolve(wt)); }
  }

  // Every item currently under an ACTIVE session claim (isClaimActive, the fold's one
  // predicate) — this is what spares an attended builder's worktree even though dispatch
  // never recorded a currentBuild for it.
  const claimedItemIds = new Set<string>();
  for (const rec of foldResult.items.values()) {
    if (isClaimActive(rec, foldResult.sessions, deps.now)) {
      claimedItemIds.add(rec.id);
    }
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
      repoRoot, activeBuildPaths, now: deps.now, graceMs: deps.graceMs, mtimeMsOf, isDirty,
      claimedItemIds,
    };
    for (const wt of worktrees) {
      const verdict = classifyWorktree(wt, ctx);
      if (verdict.reap) {
        try { removeWorktree(repoRoot, wt.path); reaped.push({ path: wt.path, reason: verdict.reason }); }
        catch { /* best-effort: a failed removal is retried next sweep */ }
      } else if (verdict.reason === 'active-build' || verdict.reason === 'claimed'
        || verdict.reason === 'dirty' || verdict.reason === 'too-young'
        || verdict.reason === 'age-unknown') {
        // Only surface guards that spared a genuinely-managed worktree (skip the noise of
        // the main checkout, non-siblings, and unrelated dirs).
        spared.push({ path: wt.path, reason: verdict.reason });
      }
    }
  }
  return { reaped, spared };
}
