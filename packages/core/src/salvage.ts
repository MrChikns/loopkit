/**
 * salvage.ts — Worker checkpoint/resume.
 *
 * Captures uncommitted partial work from an interrupted (crashed or timed-out) worker
 * as a patch file for potential re-application on the next attempt.
 *
 * Key design decisions:
 *   - Only UNCOMMITTED state is captured here. Committed work lives on the branch and
 *     is already accessible to the next attempt.
 *   - We use `git add -N` (intent-to-add) on untracked non-plumbing files so that a
 *     single `git diff HEAD` covers both tracked changes AND untracked source files.
 *   - plumbing (node_modules) and dist/ and *.log files are excluded from salvage.
 *   - Best-effort: any error → one stderr line, never affects the requeue/park flow.
 *   - Size cap: `salvage.maxPatchKb` (default 256 KB). Over-cap → write a note only.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDependencyPlumbing } from './beats/dispatch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SalvageConfig {
  enabled?: boolean;
  maxPatchKb?: number;
}

export interface SalvageResult {
  /** Path to the .salvage.patch file, or undefined when too large or disabled. */
  patchPath?: string;
  /** Path to the .salvage.note file when patch was over cap. */
  notePath?: string;
  /** Path to the .salvage.md summary file. */
  mdPath?: string;
  /** Message suitable for a msg.out ledger trail. */
  trailMessage: string;
  /** Whether salvage ran without error (not about whether it found anything). */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// File-level filters
// ---------------------------------------------------------------------------

/**
 * Should this untracked file be excluded from salvage?
 * Excludes: dependency plumbing, dist/ directories, *.log files.
 * Accepts the raw porcelain line (e.g. "?? src/foo.ts").
 */
function isSalvageExcluded(porcelainLine: string): boolean {
  if (isDependencyPlumbing(porcelainLine)) return true;
  const p = porcelainLine.slice(3).trim();
  // Exclude dist/ directories
  if (p === 'dist/' || p.startsWith('dist/') || p.endsWith('/dist/') || p.includes('/dist/')) return true;
  // Exclude *.log files
  if (p.endsWith('.log')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main capture function
// ---------------------------------------------------------------------------

/**
 * Capture the uncommitted partial work from a worktree as a salvage patch.
 *
 * @param wtPath       - absolute path to the worktree
 * @param itemId       - WI-NNN
 * @param attempt      - the attempt number that was interrupted
 * @param runDir       - .ai/runs/loopkit directory for artifact storage
 * @param reason       - 'timeout' | 'crash' | 'orphan' (for the .salvage.md)
 * @param cfg          - salvage config block (enabled, maxPatchKb)
 * @param workerLogPath - optional path to the worker log file (for last 2000 chars)
 */
export function captureSalvage(
  wtPath: string,
  itemId: string,
  attempt: number,
  runDir: string,
  reason: 'timeout' | 'crash' | 'orphan' | 'stalled',
  cfg: SalvageConfig = {},
  workerLogPath?: string,
): SalvageResult {
  const enabled = cfg.enabled !== false; // default true
  if (!enabled) {
    return { trailMessage: 'salvage disabled', ok: true };
  }

  const maxPatchKb = typeof cfg.maxPatchKb === 'number' && cfg.maxPatchKb > 0
    ? cfg.maxPatchKb
    : 256;
  const maxPatchBytes = maxPatchKb * 1024;

  const prefix = `${itemId}-attempt-${attempt}`;
  const patchPath = join(runDir, `${prefix}.salvage.patch`);
  const notePath  = join(runDir, `${prefix}.salvage.note`);
  const mdPath    = join(runDir, `${prefix}.salvage.md`);

  try {
    // Ensure runDir exists
    mkdirSync(runDir, { recursive: true });

    // ── Enumerate untracked non-plumbing files via git status --porcelain ──
    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: wtPath, stdio: 'pipe',
    });
    if (statusResult.status !== 0 || !statusResult.stdout) {
      // Can't read worktree status — fail-soft
      process.stderr.write(`[salvage] ${itemId} attempt ${attempt}: git status failed in ${wtPath}\n`);
      return { trailMessage: 'salvage: git status failed', ok: false };
    }

    const porcelainLines = statusResult.stdout.toString().trim().split('\n').filter(Boolean);
    const untrackedNonPlumbing = porcelainLines
      .filter(l => l.startsWith('??'))
      .filter(l => !isSalvageExcluded(l))
      .map(l => l.slice(3).trim());

    // ── Stage untracked files with --intent-to-add ──
    // This lets a single `git diff HEAD` capture them alongside tracked changes.
    // We must un-stage them after (git reset HEAD <files>) to leave the tree clean.
    let intendedFiles: string[] = [];
    if (untrackedNonPlumbing.length > 0) {
      const addResult = spawnSync('git', ['add', '-N', '--', ...untrackedNonPlumbing], {
        cwd: wtPath, stdio: 'pipe',
      });
      if (addResult.status === 0) {
        intendedFiles = untrackedNonPlumbing;
      }
      // If add -N fails for some files, diff will still capture tracked changes
    }

    // ── Capture git diff HEAD ──
    const diffResult = spawnSync('git', ['diff', 'HEAD'], {
      cwd: wtPath,
      stdio: 'pipe',
      maxBuffer: (maxPatchBytes + 64 * 1024), // a bit extra to detect over-cap
    });

    // Unstage the intent-to-add files regardless of outcome
    if (intendedFiles.length > 0) {
      spawnSync('git', ['reset', 'HEAD', '--', ...intendedFiles], {
        cwd: wtPath, stdio: 'pipe',
      });
    }

    const patchContent = diffResult.status === 0
      ? (diffResult.stdout?.toString() ?? '')
      : '';

    // ── stat summary via git diff HEAD --stat ──
    const statResult = spawnSync('git', ['diff', 'HEAD', '--stat'], {
      cwd: wtPath, stdio: 'pipe',
    });
    const statSummary = statResult.stdout?.toString().trim() ?? '';

    // Count touched files for the trail message
    const touchedFileCount = (patchContent.match(/^diff --git /gm) ?? []).length;

    // ── Worker log tail ──
    let logTail = '';
    if (workerLogPath) {
      try {
        if (existsSync(workerLogPath)) {
          const logContent = readFileSync(workerLogPath, 'utf8');
          logTail = logContent.length > 2000 ? logContent.slice(-2000) : logContent;
        }
      } catch { /* best-effort */ }
    }

    // ── Write .salvage.md (summary — always written, even when patch is over-cap) ──
    const interruptedAt = new Date().toISOString();
    const mdContent = [
      `# Salvage summary — ${itemId} attempt ${attempt}`,
      '',
      `Interrupted-at: ${interruptedAt}`,
      `Reason: ${reason}`,
      `Worktree: ${wtPath}`,
      '',
      '## Files touched (uncommitted)',
      statSummary || '(no uncommitted changes detected)',
      '',
      ...(logTail ? ['## Worker log tail (last ~2000 chars)', '```', logTail, '```', ''] : []),
    ].join('\n');

    try {
      writeFileSync(mdPath, mdContent, 'utf8');
    } catch (e) {
      process.stderr.write(`[salvage] ${itemId} attempt ${attempt}: failed to write .salvage.md: ${e}\n`);
    }

    // ── Size check ──
    const patchBytes = Buffer.byteLength(patchContent, 'utf8');
    if (patchBytes === 0) {
      // No uncommitted changes — nothing to salvage
      const msg = `attempt ${attempt} interrupted (${reason}) — no uncommitted changes to salvage`;
      return { mdPath, trailMessage: msg, ok: true };
    }

    if (patchBytes > maxPatchBytes) {
      // Over cap — write note only
      const noteContent = `partial work too large (${Math.round(patchBytes / 1024)} KB) — not salvaged\ninterrupted-at: ${interruptedAt}\nreason: ${reason}\n`;
      try {
        writeFileSync(notePath, noteContent, 'utf8');
      } catch (e) {
        process.stderr.write(`[salvage] ${itemId} attempt ${attempt}: failed to write .salvage.note: ${e}\n`);
      }
      const msg = `attempt ${attempt} interrupted (${reason}) — partial work too large (${Math.round(patchBytes / 1024)} KB > ${maxPatchKb} KB cap), not salvaged`;
      return { notePath, mdPath, trailMessage: msg, ok: true };
    }

    // ── Write .salvage.patch ──
    try {
      writeFileSync(patchPath, patchContent, 'utf8');
    } catch (e) {
      process.stderr.write(`[salvage] ${itemId} attempt ${attempt}: failed to write .salvage.patch: ${e}\n`);
      const msg = `attempt ${attempt} interrupted (${reason}) — salvage write failed`;
      return { mdPath, trailMessage: msg, ok: false };
    }

    const patchKb = Math.round(patchBytes / 1024 * 10) / 10;
    const msg = `attempt ${attempt} interrupted (${reason}) — salvaged ${touchedFileCount} file(s) / ${patchKb} KB to ${basename(patchPath)}`;
    return { patchPath, mdPath, trailMessage: msg, ok: true };

  } catch (e) {
    process.stderr.write(`[salvage] ${itemId} attempt ${attempt}: unexpected error: ${e}\n`);
    return { trailMessage: `attempt ${attempt} interrupted (${reason}) — salvage error: ${e}`, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Resume helper
// ---------------------------------------------------------------------------

/**
 * Check whether the highest prior attempt for `itemId` left a salvage patch.
 * Walks from `currentAttempt - 1` down to 1. Fail-soft: returns undefined on
 * any error or when no patch exists.
 *
 * @param runDir         - .ai/runs/loopkit directory
 * @param itemId         - WI-NNN
 * @param currentAttempt - the attempt about to be dispatched (N+1)
 * @returns the patch path and the corresponding .salvage.md path, or undefined
 */
export function findSalvagePatch(
  runDir: string,
  itemId: string,
  currentAttempt: number,
): { patchPath: string; mdPath: string; attempt: number } | undefined {
  for (let n = currentAttempt - 1; n >= 1; n--) {
    const patchPath = join(runDir, `${itemId}-attempt-${n}.salvage.patch`);
    const mdPath    = join(runDir, `${itemId}-attempt-${n}.salvage.md`);
    try {
      if (existsSync(patchPath)) {
        return { patchPath, mdPath, attempt: n };
      }
    } catch { /* best-effort */ }
  }
  return undefined;
}

/**
 * Try to apply a salvage patch to the current worktree.
 *
 * Uses --check first, then applies with --3way only if check passes. This means
 * a failed check leaves the tree completely clean (nothing half-applied).
 *
 * @param wtPath    - worktree path
 * @param patchPath - absolute path to the .salvage.patch
 * @returns true if the patch applied successfully, false otherwise
 */
export function applySalvagePatch(wtPath: string, patchPath: string): boolean {
  try {
    // Dry-run check first — if this fails, nothing is applied
    const check = spawnSync('git', ['apply', '--check', patchPath], {
      cwd: wtPath, stdio: 'pipe',
    });
    if (check.status !== 0) return false;

    // Check passed — apply for real
    const apply = spawnSync('git', ['apply', '--3way', patchPath], {
      cwd: wtPath, stdio: 'pipe',
    });
    return apply.status === 0;
  } catch {
    return false;
  }
}

/**
 * Build the RESUME NOTE section to inject into the build prompt when a salvage
 * patch was found and applied (or found but not applicable).
 *
 * @param applied   - true when the patch was pre-applied to the worktree
 * @param mdContent - content of the .salvage.md summary (NOT the full patch)
 * @param patchPath - path to the patch file (for reference when not applied)
 * @param reason    - interruption reason from the .salvage.md
 * @param interruptedAt - ISO timestamp from the .salvage.md summary
 */
export function buildResumeNote(
  applied: boolean,
  mdContent: string,
  patchPath: string,
): string {
  if (applied) {
    return `RESUME NOTE — A prior attempt was interrupted. Its uncommitted partial work has been PRE-APPLIED to this worktree. Treat it as a suspect draft, not finished work: review each pre-applied change critically before building on it; revert anything that does not serve the spec.

Prior attempt summary:
${mdContent}`;
  } else {
    return `RESUME NOTE — A prior attempt was interrupted and left a salvage patch at ${patchPath}, but it did not apply cleanly to the current base — reimplement from the spec; consult the patch only as reference.

Prior attempt summary:
${mdContent}`;
  }
}
