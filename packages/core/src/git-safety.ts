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
    .filter(Boolean);
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
