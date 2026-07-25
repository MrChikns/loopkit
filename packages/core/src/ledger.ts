/**
 * ledger.ts — Append-only JSONL ledger under a configurable directory.
 *
 * File layout:
 *   <dir>/work-YYYY-MM.jsonl   — work events (item.*, msg.*, build.*, gate.*, review.*)
 *   <dir>/ops-YYYY-MM.jsonl    — ops events (slo.*, cost.*, loop.*)
 *
 * Appends are single-line JSON (< 4KB) via O_APPEND (atomic on POSIX) and are fsync'd
 * before the handle closes, so an acknowledged append survives a crash.
 * A mkdir-based lock serializes multi-event batches and id allocation (it does NOT make a
 * batch atomic — see appendEvents).
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

/**
 * Two INDEPENDENT numbers (WI-197). One constant used to do both jobs, which made the
 * "the holder is alive, respect it" branch near-unreachable: the staleness check is only
 * reached *after* the spin gives up, so with one value a contended lock was always exactly
 * at the threshold and a slow-but-alive holder got reaped by the next beat.
 *
 * SPIN — how long a contender waits before it stops waiting and judges the lock.
 * A real transaction is a fold plus a few fsync'd appends: sub-second in practice, so 10 s is
 * >10x headroom. It is deliberately kept well under the 30 s reactor beat, so a genuinely
 * wedged lane surfaces inside one beat instead of stacking beats behind it.
 */
const LOCK_SPIN_TIMEOUT_MS = 10_000;
/**
 * STALE — how old a lock must be before another writer may assume the holder is DEAD and
 * reclaim it. 2 minutes is 2x the slowest beat interval (60 s dispatch) and 12x the spin
 * deadline, so no live beat's lock is ever reaped merely for being slow; reclaim now only
 * fires for the case it exists for (holder crashed/killed without releasing), while still
 * self-healing a wedged lane within two minutes rather than never.
 *
 * NOTE: mtime is the lock's CREATION time — nothing refreshes it while held — so staleness
 * still means "the holder started a while ago", not "the holder stopped making progress",
 * and the lock still carries no owner/PID token. See docs/limitations.md.
 */
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 50;

async function acquireLock(dir: string): Promise<string> {
  const lockPath = join(dir, '.ledger.lock');
  const deadline = Date.now() + LOCK_SPIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath, { recursive: false });
      return lockPath;
    } catch {
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  // Spin gave up. Is the holder dead (reclaim) or just slow (respect it)?
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
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
 *
 * Durability barrier: the handle is fsync'd BEFORE it is closed. Closing only hands the
 * bytes to the OS page cache — an unflushed page cache is lost on a panic/power cut, so
 * without the sync an append that has already been acknowledged to the caller (and acted
 * on: a build spawned, a lock released) could simply not exist after a crash. Every write
 * path in this module funnels through here, so this is the single barrier for the ledger.
 *
 * A failing sync propagates, exactly like a failing write: an append we cannot make
 * durable is a real failure and the caller must not treat it as written.
 *
 * Honest limit: fsync(2) guarantees the data reached the storage device. On macOS it does
 * NOT flush the device's own volatile write cache (that needs F_FULLFSYNC, which Node does
 * not expose). So this makes an append survive a process crash or an OS panic; a sudden
 * power loss on a drive with a volatile cache is out of reach here.
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
    await fh.sync(); // durability barrier — see above; must happen before close, not after
  } finally {
    await fh.close();
  }
}

/**
 * Append a batch of events under the ledger lock.
 *
 * NOT atomic — the old comment here claimed it was, and that was wrong. What is actually
 * guaranteed:
 *   - the mkdir lock serializes this batch against other appenders and against id
 *     allocation in withLock(), so two batches never interleave their lines;
 *   - each individual line is written O_APPEND and fsync'd (see appendEvent), so every
 *     line that lands on disk is whole and durable.
 *
 * What is NOT guaranteed: all-or-nothing. This is N separate write+sync cycles, so a
 * crash, a kill, or ENOSPC part-way through the loop leaves the first k events durably on
 * disk and the rest missing — a *durably incomplete* state transition, which the reader
 * then folds as if it were the whole truth. Per-line durability is not transition
 * atomicity, and no amount of fsync makes it so.
 *
 * Callers therefore must not rely on rollback (there is none). A multi-event transition
 * should be shaped so that a partial prefix is either harmless or re-derivable on the next
 * beat — i.e. order the batch so the events that commit the transition come last, and keep
 * re-appends idempotent.
 *
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
