// Git reality-checks used to decide "retire vs requeue vs redo" instead of trusting
// attempt-local signals. Without this, a work item that has already merged but whose dispatch
// attempt correctly produced no new commit gets read by the gate as failure → parked → the
// reactor's bounded auto-requeue re-dispatches it → forever, burning cost on already-shipped work.
// The plane should check GIT TRUTH before requeuing: is this work already in master?
import { execFileSync } from 'node:child_process';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Return the SHA of a commit ALREADY on master that SHIPPED this work item, or null.
 *
 * Matches the repo's commit-subject convention `… (WI-NNN)`, but IGNORES ledger-residue commits
 * (`chore(ledger): … (WI-NNN)`) — those reference the WI yet touch only `.ai/ledger/**` and ship
 * no feature, so counting them would falsely retire a genuinely-unbuilt item. A commit qualifies
 * only if it touched at least one file outside `.ai/ledger/`. Pure read; never throws.
 */
export function alreadyShippedCommit(repoRoot: string, wiId: string): string | null {
  if (!/^WI-\d+$/.test(wiId)) return null;
  try {
    const shas = git(repoRoot, ['log', 'master', '--grep', `(${wiId})`, '--fixed-strings', '--format=%H'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    for (const sha of shas) {
      const files = git(repoRoot, ['show', '--name-only', '--format=', sha])
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (files.some((f) => !f.startsWith('.ai/ledger/'))) return sha;
    }
    return null;
  } catch {
    return null; // no git / detached / unknown ref — fail safe: "not known-shipped", caller requeues
  }
}

/**
 * Count of commits a build branch holds AHEAD of master, or 0 (incl. on any error). A non-zero
 * count on a build that is about to be reaped/requeued means the worker committed before it died
 * (a died-post-commit class of failure) — that work should be gated+merged, not rebuilt from
 * scratch. Pure read; never throws.
 */
export function branchCommitsAheadOfMaster(repoRoot: string, branch: string): number {
  if (!branch) return 0;
  try {
    const out = git(repoRoot, ['rev-list', '--count', `master..${branch}`]);
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
