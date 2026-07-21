/**
 * ledgerCommit.ts — commit ledger residue immediately after a beat
 * appends events. The ledger is working-tree state, not scratch: an uncommitted append is
 * vulnerable to any working-tree restore/checkout discarding it. Committing after every beat
 * shrinks that exposure window from unbounded to at most one beat cycle (<=30s reactor,
 * <=60s dispatch).
 *
 * Scoped to ONLY the ledger directory — never `git add -A` (the plane commits
 * only declared work: a beat's own residue is never blanket-staged).
 * Best-effort throughout: a failed status/add/commit never throws or blocks the beat — the
 * residue simply waits, uncommitted, for the next beat's attempt (which will find and stage it).
 */

import { spawnSync } from 'node:child_process';
import { relative, isAbsolute, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

export interface LedgerCommitResult {
  committed: boolean;
  detail: string;
}

/**
 * Extract the unique `WI-NNN` item ids introduced by ADDED lines in a `git diff` of the ledger
 * (each ledger line is one JSON event carrying `"item":"WI-NNN"`), for a readable commit
 * subject. Pure/testable independent of git.
 */
export function extractItemIds(diffText: string): string[] {
  const ids = new Set<string>();
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const m = line.match(/"item"\s*:\s*"(WI-\d+)"/);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

const MAX_ITEMS_IN_SUBJECT = 8;

/**
 * Walk up from `dir` to the nearest directory containing a `.git` entry — the git repo that
 * owns `dir` — or undefined when no ancestor is a repo. Used to route a plane-home ledger
 * (which lives OUTSIDE the driven repo, e.g. `~/.loopkit/ledger`) to its own repo for the
 * residue commit instead of silently no-oping against the driven repo. Exported for tests.
 */
export function findEnclosingGitRoot(dir: string): string | undefined {
  let candidate = dir;
  for (;;) {
    if (existsSync(join(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

/**
 * Commit any uncommitted residue under `ledgerDir` (scoped, never `git add -A`). `label` is the
 * beat name (e.g. 'reactor', 'dispatch'), matching the commit message template
 * `chore(ledger): [beat name] residue + [item list if material]`.
 *
 * When `ledgerDir` lies OUTSIDE `repoRoot` (plane-home mode — the ledger lives in its own
 * plane-home repo, e.g. `~/.loopkit/ledger`), the commit runs in the ledger's own enclosing
 * git repo instead, so plane-home commit-on-append durability holds without the beats
 * knowing which mode they run in. ensurePlaneHome (config.ts) guarantees that repo exists.
 *
 * No-ops (committed:false) when the ledger is already clean, when the effective repo root
 * isn't a git repo, or when an outside-repoRoot ledger has no enclosing git repo — every
 * failure path is caught, never thrown (best-effort: the next beat retries).
 */
export function commitLedgerResidue(repoRoot: string, ledgerDir: string, label: string): LedgerCommitResult {
  try {
    let effectiveRoot = repoRoot;
    let rel = relative(repoRoot, ledgerDir);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      const planeRoot = findEnclosingGitRoot(ledgerDir);
      if (!planeRoot) {
        return {
          committed: false,
          detail: `ledger dir ${ledgerDir} is outside ${repoRoot} and not inside any git repo — run ensurePlaneHome first`,
        };
      }
      effectiveRoot = planeRoot;
      rel = relative(planeRoot, ledgerDir);
    }
    repoRoot = effectiveRoot;

    const status = spawnSync('git', ['status', '--porcelain', '--', rel], { cwd: repoRoot, stdio: 'pipe' });
    if (status.status !== 0) {
      return { committed: false, detail: `git status failed: ${status.stderr?.toString().trim() || status.error}` };
    }
    if (!status.stdout.toString().trim()) {
      return { committed: false, detail: 'no ledger residue' };
    }

    const add = spawnSync('git', ['add', '--', rel], { cwd: repoRoot, stdio: 'pipe' });
    if (add.status !== 0) {
      return { committed: false, detail: `git add failed: ${add.stderr?.toString().trim()}` };
    }

    const diff = spawnSync('git', ['diff', '--cached', '--', rel], { cwd: repoRoot, stdio: 'pipe' });
    const items = extractItemIds(diff.stdout?.toString() ?? '');
    const shown = items.slice(0, MAX_ITEMS_IN_SUBJECT);
    const suffix = shown.length > 0
      ? ` (${shown.join(', ')}${items.length > shown.length ? ', …' : ''})`
      : '';
    const message = `chore(ledger): ${label} residue${suffix}`;

    const commit = spawnSync('git', ['commit', '-m', message], { cwd: repoRoot, stdio: 'pipe' });
    if (commit.status !== 0) {
      return {
        committed: false,
        detail: `git commit failed: ${commit.stderr?.toString().trim() || commit.stdout?.toString().trim()}`,
      };
    }
    return { committed: true, detail: message };
  } catch (e) {
    return { committed: false, detail: `commitLedgerResidue threw (best-effort, ignored): ${e}` };
  }
}
