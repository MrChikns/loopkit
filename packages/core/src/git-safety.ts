import { spawnSync } from 'node:child_process';

const STATUS_EVIDENCE_LIMIT = 20;
const STATUS_MAX_BUFFER = 4 * 1024 * 1024;

export type CleanCheckoutResult =
  | { ok: true }
  | { ok: false; reason: string; evidence: string[] };

/**
 * Fail-closed precondition for git operations that can move or rewrite an
 * operator-owned checkout.
 *
 * Deliberately omits `--branch`: ahead/behind commit history is not uncommitted
 * state and must not block an integration. Porcelain output contains only status
 * codes and paths, so the caller can persist exact evidence without recording
 * file contents.
 */
export function requireCleanCheckout(repoRoot: string): CleanCheckoutResult {
  const status = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repoRoot, stdio: 'pipe', maxBuffer: STATUS_MAX_BUFFER },
  );

  if (status.status !== 0 || status.error) {
    const detail = status.stderr?.toString().trim() || status.error?.message || 'unknown git status failure';
    return {
      ok: false,
      reason: `cannot verify destination checkout is clean; refusing git operation to preserve operator state: ${detail}`,
      evidence: [],
    };
  }

  const evidence = status.stdout.toString()
    .split('\n')
    .filter(Boolean)
    .filter(line => !isPlaneArtifact(line));
  if (evidence.length === 0) return { ok: true };

  const shown = evidence.slice(0, STATUS_EVIDENCE_LIMIT);
  const omitted = evidence.length - shown.length;
  const suffix = omitted > 0 ? `; … ${omitted} more path(s)` : '';
  return {
    ok: false,
    reason: `destination checkout is not clean; refusing git operation to preserve operator state: ${shown.join('; ')}${suffix}`,
    evidence,
  };
}

/**
 * Dependency plumbing is never work product. setupWorktreeDeps provisions node_modules
 * as SYMLINKS, and gitignore's dir-only `node_modules/` pattern does not match symlinks —
 * so they surface as `??` in porcelain and would otherwise wrongly park a green committed
 * build. Moved here (from beats/dispatch.ts, WI-222) so the lower-level
 * `requireCleanCheckout` precondition can share the same predicate instead of forking a
 * second copy — dispatch.ts re-exports it for existing callers/tests.
 */
export function isDependencyPlumbing(porcelainLine: string): boolean {
  const p = porcelainLine.slice(3).trim();
  return p === 'node_modules' || p === 'node_modules/' ||
    p.endsWith('/node_modules') || p.endsWith('/node_modules/') ||
    p.startsWith('node_modules/') || p.includes('/node_modules/');
}

/**
 * Worker manifests are left at the worktree root by the worker and must
 * not trigger the dirty-tree gate. They are never committed (excluded by root .gitignore),
 * so fixture repos that lack the root gitignore need this exemption as defence-in-depth.
 * Moved here (from beats/dispatch.ts, WI-222) — see {@link isDependencyPlumbing}.
 */
export function isWorkerManifest(porcelainLine: string): boolean {
  const p = porcelainLine.slice(3).trim();
  return /^MANIFEST-WI-[A-Za-z0-9-]+\.json$/.test(p);
}

/**
 * The plane's own runtime evidence (gate logs, diffs, watermarks, heartbeats, locks) lives
 * under `.ai/runs/` at the repo root (dispatch.ts / reactor.ts `resolveRunDir`'s embedded
 * default) and is written on every build — a target repo that doesn't gitignore it must not
 * have its own artifacts refuse `requireCleanCheckout` (WI-222 D22): that produced an
 * infinite park loop on push-race recovery, refusing on the beat's own evidence files.
 * Matches the directory at any depth (a nested target repo, or `.ai/runs` itself as a
 * literal untracked dir) — never a same-named file/dir that merely contains the string
 * elsewhere in its path.
 */
export function isPlaneRuntimeEvidence(porcelainLine: string): boolean {
  const p = porcelainLine.slice(3).trim();
  return p === '.ai/runs' || p === '.ai/runs/' ||
    p.startsWith('.ai/runs/') ||
    p.endsWith('/.ai/runs') || p.endsWith('/.ai/runs/') ||
    p.includes('/.ai/runs/');
}

/** Any of the plane's own artifact classes — never real operator/work-product dirt. */
export function isPlaneArtifact(porcelainLine: string): boolean {
  return isDependencyPlumbing(porcelainLine) ||
    isWorkerManifest(porcelainLine) ||
    isPlaneRuntimeEvidence(porcelainLine);
}
