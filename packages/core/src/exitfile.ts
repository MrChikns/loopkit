/**
 * exitfile.ts — detached-build exit-file protocol.
 *
 * When the dispatch beat spawns a build worker as a DETACHED process group (setsid) and exits
 * without awaiting it, the worker's completion can no longer be observed in-process.
 * Instead, on completion the worker atomically writes an `<WI>-a<N>.exit` sentinel carrying the
 * exit code and a pointer to the teed provider JSON (`<WI>-a<N>.usage.json`). A LATER dispatch
 * beat "collects" the finished build by finding the exit file, then runs the existing terminal
 * path (gate → rebase → merge+push → cost/evidence/salvage).
 *
 * Two invariants this module guarantees, both load-bearing for correctness:
 *
 *   1. ATOMIC WRITE (tmp + rename). A collector beat and the doctor both read the exit file on
 *      their own cadence; a torn/half-written file read mid-write must never be observed. Write
 *      to `<name>.tmp` then rename() onto the final path — rename is atomic within a filesystem,
 *      so a reader sees either the old absence or the complete new file, never a partial one.
 *
 *   2. GRACEFUL READ. readExitFile NEVER throws and returns null on any of: file absent, empty,
 *      or unparseable JSON (a read that raced a write and caught a stray non-atomic byte, or a
 *      truncated write from a killed worker). "Cannot read a complete exit record" is treated as
 *      "not yet collectable", so a mid-write race defers collection one cycle rather than acting
 *      on garbage — the doctor's one-collection-cycle grace (doctor.ts) covers the deferral.
 *
 * Zero runtime dependencies; pure fs. The path shape (`<WI>-a<attempt>.exit`) mirrors the
 * evidence-log naming convention already used across dispatch.ts (`<WI>-attempt-<N>.log`, etc.).
 */

import { join } from 'node:path';
import { writeFileSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';

/** The parsed contents of an `<WI>-a<N>.exit` sentinel. */
export interface ExitRecord {
  /** Process exit code of the detached worker (0 = clean). Null when the worker was signalled. */
  exitCode: number | null;
  /**
   * Absolute (or runDir-relative) path to the teed provider JSON for this attempt
   * (`<WI>-a<N>.usage.json`). The collector reads it to extract usage; absent/unreadable is
   * tolerated (usage attribution is best-effort, never a gate).
   */
  usageJsonPath?: string;
  /**
   * True when the detached worker's terminal outcome was specifically an auth failure (session
   * expired / logged out), as opposed to a generic crash. A detached child that fails for this
   * reason otherwise looks identical to any other non-zero/no-commit failure once collected by a
   * later beat — this flag lets the collector route it through the SAME auth-handling path
   * (mark provider unhealthy, requeue via build.crashed, never park/count toward the breaker)
   * the in-process sync build path already uses for `ProviderResult.code === 'auth'`.
   */
  authFailure?: boolean;
}

/** Base name (no directory) of the exit sentinel for an attempt: `<WI>-a<N>.exit`. */
export function exitFileName(itemId: string, attempt: number): string {
  return `${itemId}-a${attempt}.exit`;
}

/** Base name of the teed provider-usage JSON for an attempt: `<WI>-a<N>.usage.json`. */
export function usageJsonName(itemId: string, attempt: number): string {
  return `${itemId}-a${attempt}.usage.json`;
}

/** Full path to the exit sentinel under a runs directory. */
export function exitFilePath(runDir: string, itemId: string, attempt: number): string {
  return join(runDir, exitFileName(itemId, attempt));
}

/** Full path to the teed provider-usage JSON under a runs directory. */
export function usageJsonPath(runDir: string, itemId: string, attempt: number): string {
  return join(runDir, usageJsonName(itemId, attempt));
}

/**
 * Atomically write the exit sentinel for a finished detached worker (invariant 1: tmp + rename).
 * Best-effort — never throws — because a worker mid-teardown must not crash on a full/RO disk;
 * an unwritten exit file simply looks like a still-running (or, past the grace window, orphaned)
 * build to the collector, which is the safe failure direction.
 */
export function writeExitFile(
  runDir: string,
  itemId: string,
  attempt: number,
  record: ExitRecord,
): void {
  const finalPath = exitFilePath(runDir, itemId, attempt);
  const tmpPath = `${finalPath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    renameSync(tmpPath, finalPath);
  } catch {
    // Best-effort: leave no half-written final file. Attempt to clean the tmp so a later
    // write isn't confused by a stale partial; ignore if that too fails.
    try { unlinkSync(tmpPath); } catch { /* nothing to clean */ }
  }
}

/**
 * Read the exit sentinel for an attempt, or null when it is absent OR cannot be parsed as a
 * complete record (invariant 2: graceful read). NEVER throws. A null result means "not yet
 * collectable" — the caller must defer, not act.
 */
export function readExitFile(
  runDir: string,
  itemId: string,
  attempt: number,
): ExitRecord | null {
  const path = exitFilePath(runDir, itemId, attempt);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // absent (or unreadable) → not collectable
  }
  const trimmed = raw.trim();
  if (!trimmed) return null; // empty file — a rename hasn't completed / an interrupted write
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null; // torn / non-atomic byte caught mid-write → defer one cycle
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  // exitCode must be present and either a number or explicit null (a signalled worker). A
  // missing exitCode key means the record is not the shape we wrote → treat as not collectable.
  if (!('exitCode' in o)) return null;
  const exitCode = typeof o['exitCode'] === 'number' ? (o['exitCode'] as number)
    : o['exitCode'] === null ? null
    : undefined;
  if (exitCode === undefined) return null;
  const usage = typeof o['usageJsonPath'] === 'string' ? (o['usageJsonPath'] as string) : undefined;
  const authFailure = o['authFailure'] === true ? true : undefined;
  return {
    exitCode,
    ...(usage !== undefined ? { usageJsonPath: usage } : {}),
    ...(authFailure !== undefined ? { authFailure } : {}),
  };
}

/** True when a complete, parseable exit sentinel exists for the attempt (uses readExitFile). */
export function exitFileExists(runDir: string, itemId: string, attempt: number): boolean {
  return readExitFile(runDir, itemId, attempt) !== null;
}

/**
 * True when the exit sentinel path exists on disk AT ALL — even if its contents are not yet a
 * complete record. Distinguishes "a worker started writing its exit file" (defer) from "no exit
 * file at all" (candidate orphan) for the doctor's grace logic. Never throws.
 */
export function exitFilePresent(runDir: string, itemId: string, attempt: number): boolean {
  try {
    return existsSync(exitFilePath(runDir, itemId, attempt));
  } catch {
    return false;
  }
}
