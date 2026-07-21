/**
 * ledger.ts — Append-only JSONL ledger under a configurable directory.
 *
 * File layout:
 *   <dir>/work-YYYY-MM.jsonl   — work events (item.*, msg.*, build.*, gate.*, review.*)
 *   <dir>/ops-YYYY-MM.jsonl    — ops events (slo.*, cost.*, loop.*)
 *
 * Appends are single-line JSON (< 4KB) via O_APPEND (atomic on POSIX).
 * A mkdir-based lock guards multi-event transactions and id allocation.
 * Reader streams all segments in chronological order.
 */

import { createReadStream, mkdirSync, writeFileSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { LedgerEvent, validateEvent } from './schema.js';
import { loadQuarantine } from './hygiene.js';

// ---------------------------------------------------------------------------
// Segment routing
// ---------------------------------------------------------------------------

const OPS_TYPES = new Set([
  'slo.breach', 'slo.recovered',
  'cost.usage', 'loop.beat',
  'heal.proposed', 'heal.executed', 'heal.verified', 'heal.escalated', 'heal.graduated', 'heal.shadowed',
]);

function segmentFile(dir: string, type: string, date: Date): string {
  const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const prefix = OPS_TYPES.has(type) ? 'ops' : 'work';
  return join(dir, `${prefix}-${ym}.jsonl`);
}

// ---------------------------------------------------------------------------
// Lock (mkdir-based, POSIX-safe for single-host)
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 50;

async function acquireLock(dir: string): Promise<string> {
  const lockPath = join(dir, '.ledger.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath, { recursive: false });
      return lockPath;
    } catch {
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  // Stale lock? Check mtime
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_TIMEOUT_MS) {
      rmdirSync(lockPath);
      await mkdir(lockPath, { recursive: false });
      return lockPath;
    }
  } catch { /* ignore */ }
  throw new Error(`Could not acquire ledger lock at ${lockPath}`);
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Append (single event, no lock needed — O_APPEND is atomic for lines < PIPE_BUF)
// ---------------------------------------------------------------------------

export const MAX_EVENT_BYTES = 4096;

/**
 * Shrink an oversized event to fit the atomic-append cap WITHOUT throwing. A thrown
 * appendEvent aborts the whole beat mid-run — it strands the build in state=building with no
 * terminal event, and on the beat's SIGTERM/return leaves the dispatch lock orphaned. The
 * oversize is always ONE big free-text blob in event.data (a scout
 * `brief`, a requeue `spec`, a msg.out remainder list, or a gate `reason`); every structural
 * field (id/ts/type/attempt/branch/…) is tiny. So we iteratively truncate the LONGEST string
 * field, leaving an elision marker with the original length, until the serialized line fits.
 * State stays correct — only the blob is clipped. Pure + exported for direct testing.
 */
export function shrinkEventToFit(event: LedgerEvent, maxBytes: number = MAX_EVENT_BYTES): LedgerEvent {
  const data: Record<string, unknown> = { ...((event.data as Record<string, unknown>) ?? {}) };
  const clone: LedgerEvent = { ...event, data };
  const lineLen = (e: LedgerEvent): number => JSON.stringify(e).length + 1; // + '\n'
  // Each pass clips the current longest string field; recomputing lineLen guarantees convergence
  // (JSON escaping can shift lengths). Bounded so a pathological input can never spin.
  for (let guard = 0; guard < 64 && lineLen(clone) > maxBytes; guard++) {
    let key: string | null = null;
    let longest = 0;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.length > longest) { key = k; longest = v.length; }
    }
    if (key == null || longest === 0) break; // no string blob left to clip — accept (never throw)
    const over = lineLen(clone) - maxBytes;
    const marker = ` …[+${longest} bytes truncated]`;
    const keep = Math.max(0, longest - over - marker.length);
    data[key] = (data[key] as string).slice(0, keep) + marker;
  }
  return clone;
}

/**
 * Append a single event to the appropriate segment file.
 * O_APPEND + write of a single line <= MAX_EVENT_BYTES is atomic on POSIX.
 */
export async function appendEvent(dir: string, event: LedgerEvent): Promise<void> {
  mkdirSync(dir, { recursive: true });
  let toWrite = event;
  let line = JSON.stringify(toWrite) + '\n';
  if (line.length > MAX_EVENT_BYTES) {
    // NEVER throw: degrade by clipping the oversized blob, then warn. Throwing here
    // used to crash the beat and strand the build (see shrinkEventToFit).
    toWrite = shrinkEventToFit(event, MAX_EVENT_BYTES);
    line = JSON.stringify(toWrite) + '\n';
    process.stderr.write(
      `[loopkit] oversized event ${event.type} (${event.id}) was ${JSON.stringify(event).length + 1} bytes — truncated a free-text field to fit the ${MAX_EVENT_BYTES}-byte ledger cap\n`,
    );
  }
  const file = segmentFile(dir, toWrite.type, new Date(toWrite.ts));
  const fh = await open(file, 'a');
  try {
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

/**
 * Append multiple events atomically (holds the mkdir lock).
 * Events must already have unique ids.
 */
export async function appendEvents(dir: string, events: LedgerEvent[]): Promise<void> {
  if (events.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const lockPath = await acquireLock(dir);
  try {
    for (const ev of events) {
      await appendEvent(dir, ev);
    }
  } finally {
    await releaseLock(lockPath);
  }
  // Pulse: launchd WatchPaths on a DIRECTORY only fires on entry add/remove — an
  // append inside a segment file is invisible to it. Touching this file (a watched PATH)
  // is what makes the beats event-driven. Best-effort; the interval heartbeat covers a miss.
  try { writeFileSync(join(dir, '.pulse'), events[events.length - 1]!.id, 'utf8'); } catch { /* heartbeat covers */ }
}

// ---------------------------------------------------------------------------
// Read: stream all segments in chronological order
// ---------------------------------------------------------------------------

/** List all segment files for a given prefix, sorted by year-month. */
function listSegments(dir: string, prefix: 'work' | 'ops' | 'all'): string[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter(f => {
      if (prefix === 'all') return f.match(/^(work|ops)-\d{4}-\d{2}\.jsonl$/);
      return f.match(new RegExp(`^${prefix}-\\d{4}-\\d{2}\\.jsonl$`));
    })
    .sort()
    .map(f => join(dir, f));
}

/**
 * Read all events from the ledger directory, yielding them in segment order
 * (work segments are alphabetically ordered, so oldest-first within a prefix).
 * Ops events are interleaved by segment month, not by precise timestamp.
 *
 * For fold purposes, work and ops are read together, sorted by ts at fold time.
 *
 * `quarantine` — optional set of event ids whose invalid-event warnings are
 * suppressed (the events are still skipped, as before; only the log noise is
 * reduced).  Pass the result of loadQuarantine() to activate.
 */
export async function* readAllEvents(
  dir: string,
  quarantine?: Set<string>,
): AsyncGenerator<LedgerEvent> {
  const segments = listSegments(dir, 'all');
  for (const seg of segments) {
    yield* readSegment(seg, quarantine);
  }
}

async function* readSegment(
  filePath: string,
  quarantine?: Set<string>,
): AsyncGenerator<LedgerEvent> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: 'utf8' });
  } catch {
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      // Corrupt line — skip with a warning to stderr
      process.stderr.write(`[loopkit] corrupt ledger line in ${filePath}: ${e}\n`);
      continue;
    }
    // Check if this raw object's id is in the quarantine list BEFORE validation —
    // legacy events may have UUID ids that fail validateEvent, so we suppress
    // the warning for known-quarantined ids and just skip them silently.
    if (quarantine) {
      const rawId = (raw as Record<string, unknown>)['id'];
      if (typeof rawId === 'string' && quarantine.has(rawId)) {
        // Known-invalid event: skip silently (still excluded from fold, no warning).
        continue;
      }
    }
    try {
      yield validateEvent(raw);
    } catch (e) {
      process.stderr.write(`[loopkit] invalid event in ${filePath}: ${e}\n`);
      continue;
    }
  }
}

/**
 * Read all events into an array (for fold — small enough for in-memory use).
 *
 * `quarantine` — optional set of event ids to suppress invalid warnings for.
 * When omitted, the default quarantine file path is used (best-effort: no error
 * if absent).
 */
export async function loadAllEvents(
  dir: string,
  quarantine?: Set<string>,
): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  // `.gitattributes` gives `.ai/ledger/*.jsonl` a `merge=union` driver so a branch
  // merge unions two divergent append-only tails instead of a plain 3-way merge picking one
  // side's committed tree over the other's live working-tree residue. Ids are ULIDs assigned
  // once at append time, so a repeat id is always the same event (never a real conflict) —
  // dedupe on read is the read-side half of that fix, covering the rare case where a union
  // merge's hunk boundaries echo one line into both sides of the merge.
  const seenIds = new Set<string>();
  for await (const ev of readAllEvents(dir, quarantine)) {
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    events.push(ev);
  }
  // Sort by ts for consistent fold across out-of-order segment reads. Same-ms events tiebreak
  // on the monotonic event id (ULIDs are lexicographically monotonic), so fold order is
  // deterministic even when two events share a millisecond.
  events.sort((a, b) => {
    const t = a.ts.localeCompare(b.ts);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
  return events;
}

/**
 * Load all events with the project quarantine list automatically applied.
 * Reads `.ai/ledger/quarantine.json` relative to `ledgerDir`'s parent (.ai/).
 * Fail-open: if the quarantine file is absent, behaves as loadAllEvents(dir).
 * This is the preferred call site for CLI commands and beats.
 */
export async function loadAllEventsWithQuarantine(dir: string): Promise<LedgerEvent[]> {
  const quarantinePath = join(dir, 'quarantine.json');
  const quarantine = loadQuarantine(quarantinePath);
  return loadAllEvents(dir, quarantine);
}

/**
 * Events present in `before` (by id) but absent from `after`. Pure/testable — the
 * reactor's approve-merge step uses this to compare a pre-merge snapshot of the live ledger
 * against the merged result, so anything a branch merge dropped can be re-appended rather
 * than silently lost. Ids are ULIDs assigned once at append time, so id-membership is a
 * sound proxy for "is this event still present" without needing a content comparison.
 */
export function diffMissingEvents(before: LedgerEvent[], after: LedgerEvent[]): LedgerEvent[] {
  const afterIds = new Set(after.map(e => e.id));
  return before.filter(e => !afterIds.has(e.id));
}

/**
 * The max event id currently present in each ledger segment file,
 * keyed by basename (e.g. `work-2026-07.jsonl`). IDs are ULID-like and lexicographically
 * monotonic (schema.ts newId), so the running max across a file's lines is a valid ordering
 * check even when a segment is read out of append order. Used by the regression guard to
 * detect TRUNCATION: a file whose current max id is lower than a previously-seen watermark
 * has lost history, which a plain re-fold cannot
 * distinguish from "nothing new happened yet".
 */
export async function readLedgerMaxIds(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const segPath of listSegments(dir, 'all')) {
    let max: string | undefined;
    for await (const ev of readSegment(segPath)) {
      if (max === undefined || ev.id > max) max = ev.id;
    }
    if (max !== undefined) result[basename(segPath)] = max;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lock-guarded transaction helper (used by cli.ts for id allocation)
// ---------------------------------------------------------------------------

export interface LedgerTransaction {
  /** Append events under the open lock */
  append(events: LedgerEvent[]): Promise<void>;
}

/**
 * Run a callback with the ledger lock held.
 * The callback receives a transaction object and may read all events
 * (id allocation) then append new events atomically.
 */
export async function withLock<T>(
  dir: string,
  fn: (tx: LedgerTransaction & { loadAll(): Promise<LedgerEvent[]> }) => Promise<T>,
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lockPath = await acquireLock(dir);
  try {
    return await fn({
      loadAll: () => loadAllEventsWithQuarantine(dir),
      async append(events: LedgerEvent[]) {
        for (const ev of events) {
          await appendEvent(dir, ev);
        }
      },
    });
  } finally {
    await releaseLock(lockPath);
  }
}
