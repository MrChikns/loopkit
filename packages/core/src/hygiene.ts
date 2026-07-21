/**
 * hygiene.ts — Ops-ledger hygiene: edge-triggered heartbeat files, retention
 * compaction, and invalid-event quarantine list.
 *
 * ## Edge-triggered heartbeats
 * Every beat writes `.ai/runs/<loop>/lastbeat.json` with the full result payload.
 * A `loop.beat` LEDGER event is appended ONLY when the counts object materially
 * changes vs the previous lastbeat.json content, or on the first beat after boot.
 * Idle ticks stop accumulating in the ledger; activity transitions stay permanent.
 *
 * ## Retention / archival (loopctl compact)
 * Ops segments (ops-YYYY-MM.jsonl) older than the retention window are gzipped into
 * `.ai/ledger/archive/` and the originals removed.  Work segments are NEVER compacted —
 * they are the business record.  The default retention is 2 months (current + previous).
 *
 * ## Quarantine list (.ai/ledger/quarantine.json)
 * An array of event ids whose per-event invalid warnings are suppressed (still skipped
 * by the fold, as today).  NEW unknown-id events keep warning.  The file is committed
 * with any legacy UUID-id events (pre-dating the current id format) as seed entries.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  existsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { rename as renameAsync } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// Edge-triggered heartbeat file
// ---------------------------------------------------------------------------

export interface LastbeatPayload {
  ts: string;
  loop: string;
  counts: Record<string, unknown>;
}

/**
 * Read the previous lastbeat.json for `loop` from `runsDir`.
 * Returns undefined when the file is absent or unparseable (first boot).
 */
export function readLastbeat(runsDir: string, loop: string): LastbeatPayload | undefined {
  const filePath = join(runsDir, loop, 'lastbeat.json');
  try {
    const text = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text) as LastbeatPayload;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write `lastbeat.json` atomically (tmp + rename) for `loop` under `runsDir`.
 * `counts` must be a plain object of serialisable values.
 */
export function writeLastbeat(
  runsDir: string,
  loop: string,
  counts: Record<string, unknown>,
  ts?: string,
): void {
  const loopDir = join(runsDir, loop);
  mkdirSync(loopDir, { recursive: true });
  const payload: LastbeatPayload = {
    ts: ts ?? new Date().toISOString(),
    loop,
    counts,
  };
  const target = join(loopDir, 'lastbeat.json');
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);  // atomic on POSIX
}

/**
 * Compare two counts objects for material change.
 * Returns true when they differ (serialise-compare, stable key ordering irrelevant
 * since we compare sorted keys).
 */
export function countsChanged(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): boolean {
  if (prev === undefined) return true;  // first boot
  const prevKeys = Object.keys(prev).sort();
  const nextKeys = Object.keys(next).sort();
  if (prevKeys.length !== nextKeys.length) return true;
  if (prevKeys.some((k, i) => k !== nextKeys[i])) return true;
  return prevKeys.some(k => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

// ---------------------------------------------------------------------------
// Quarantine list
// ---------------------------------------------------------------------------

export interface QuarantineFile {
  /** Event ids whose validation warnings are suppressed. */
  ids: string[];
  /** Human-readable note explaining the entries (for tooling/debugging). */
  _note?: string;
}

/**
 * Load the quarantine list from `quarantinePath`.
 * Returns an empty set when the file is absent or unreadable (fail-open).
 */
export function loadQuarantine(quarantinePath: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(quarantinePath, 'utf8')) as QuarantineFile;
    return new Set(Array.isArray(raw.ids) ? raw.ids : []);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Compact: ops-segment archival
// ---------------------------------------------------------------------------

export interface CompactOptions {
  /** Ledger directory (contains ops-YYYY-MM.jsonl files). */
  ledgerDir: string;
  /**
   * Number of recent months to KEEP (current + previous).
   * Segments older than this window are archived.
   * Default: 2
   */
  opsRetentionMonths?: number;
  /** When true, print what would happen but make no changes. */
  dryRun?: boolean;
  /**
   * Reference date for retention window calculation.
   * Defaults to now. Injectable for deterministic tests.
   */
  referenceDate?: Date;
}

export interface CompactResult {
  kept: string[];
  archived: { file: string; sizeBytes: number; gzPath: string }[];
  skipped: { file: string; reason: string }[];
  dryRun: boolean;
}

/**
 * Parse "YYYY-MM" from a segment filename like "ops-2026-07.jsonl".
 * Returns null if the name doesn't match.
 */
export function parseSegmentYearMonth(filename: string): { year: number; month: number } | null {
  const m = /^ops-(\d{4})-(\d{2})\.jsonl$/.exec(basename(filename));
  if (!m) return null;
  return { year: parseInt(m[1]!, 10), month: parseInt(m[2]!, 10) };
}

/**
 * Determine which ops segment month-indices are within the retention window.
 * `retentionMonths` = 2 means current + previous month are kept.
 * `referenceDate` defaults to now (injectable for tests).
 *
 * Returns true if the given year/month should be KEPT.
 */
export function isWithinRetention(
  year: number,
  month: number,  // 1-12
  retentionMonths: number,
  referenceDate?: Date,
): boolean {
  const ref = referenceDate ?? new Date();
  // Current month in UTC
  const refYear = ref.getUTCFullYear();
  const refMonth = ref.getUTCMonth() + 1;  // 1-12

  // Convert to month-index for subtraction
  const refIdx = refYear * 12 + refMonth;
  const segIdx = year * 12 + month;

  // Keep segments whose index >= (refIdx - retentionMonths + 1)
  return segIdx >= refIdx - retentionMonths + 1;
}

/**
 * Gzip `src` to `dst`.  Uses node:zlib + node:stream/promises (no extra deps).
 */
async function gzipFile(src: string, dst: string): Promise<void> {
  const readStream = createReadStream(src);
  const writeStream = createWriteStream(dst);
  const gzip = createGzip();
  await pipeline(readStream, gzip, writeStream);
}

/**
 * Run the compact operation.
 *
 * Safe guards:
 * - Work segments are NEVER touched (enforced + logged in skipped list).
 * - The archive directory is created if needed.
 * - If a gz file already exists at the target, the segment is still removed
 *   (idempotent: a previous partial compact may have written the gz).
 * - dryRun === true: no file system changes.
 */
export async function compact(opts: CompactOptions): Promise<CompactResult> {
  const retention = opts.opsRetentionMonths ?? 2;
  const { ledgerDir, dryRun = false, referenceDate } = opts;
  const archiveDir = join(ledgerDir, 'archive');

  const result: CompactResult = {
    kept: [],
    archived: [],
    skipped: [],
    dryRun,
  };

  let files: string[];
  try {
    files = readdirSync(ledgerDir);
  } catch {
    return result;
  }

  for (const filename of files.sort()) {
    const filePath = join(ledgerDir, filename);

    // Guard: never touch work segments
    if (filename.match(/^work-\d{4}-\d{2}\.jsonl$/)) {
      result.skipped.push({ file: filePath, reason: 'work segment — never compacted' });
      continue;
    }

    // Only process ops segments
    const ym = parseSegmentYearMonth(filename);
    if (!ym) continue;  // not an ops segment (skip archive/ dir entries etc.)

    const { year, month } = ym;

    if (isWithinRetention(year, month, retention, referenceDate)) {
      result.kept.push(filePath);
      continue;
    }

    // Needs archival
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      result.skipped.push({ file: filePath, reason: 'stat failed' });
      continue;
    }

    const gzPath = join(archiveDir, `${filename}.gz`);

    if (dryRun) {
      result.archived.push({ file: filePath, sizeBytes, gzPath });
      continue;
    }

    // Real run: create archive dir, gzip, remove original
    try {
      mkdirSync(archiveDir, { recursive: true });
      await gzipFile(filePath, gzPath);
      unlinkSync(filePath);
      result.archived.push({ file: filePath, sizeBytes, gzPath });
    } catch (e) {
      result.skipped.push({ file: filePath, reason: `archival failed: ${e}` });
    }
  }

  return result;
}

/**
 * Format a compact result for CLI display.
 */
export function formatCompactResult(r: CompactResult): string {
  const lines: string[] = [];
  if (r.dryRun) lines.push('[dry-run] No changes made.');
  if (r.kept.length > 0) {
    lines.push(`Kept (within retention): ${r.kept.length} segment(s)`);
    for (const f of r.kept) lines.push(`  keep  ${basename(f)}`);
  }
  if (r.archived.length > 0) {
    lines.push(`Archived: ${r.archived.length} segment(s)`);
    for (const a of r.archived) {
      const kb = (a.sizeBytes / 1024).toFixed(1);
      lines.push(`  ${r.dryRun ? 'would-archive' : 'archived'}  ${basename(a.file)} (${kb} KB) → ${basename(a.gzPath)}`);
    }
  }
  if (r.skipped.length > 0) {
    lines.push(`Skipped: ${r.skipped.length} file(s)`);
    for (const s of r.skipped) lines.push(`  skip  ${basename(s.file)}: ${s.reason}`);
  }
  if (r.kept.length === 0 && r.archived.length === 0 && r.skipped.filter(s => !s.reason.startsWith('work')).length === 0) {
    lines.push('Nothing to compact.');
  }
  return lines.join('\n');
}
