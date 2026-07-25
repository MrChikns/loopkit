/**
 * append.test.ts — Append atomicity + durability tests for the ledger write path.
 *
 * O_APPEND + single-line writes < 4KB are atomic on POSIX; this test verifies
 * that concurrent in-process appends produce no corrupt/interleaved lines and no
 * duplicate ids.
 *
 * It also verifies the durability barrier: every append fsyncs its handle BEFORE closing
 * it. See the honesty note on `traceHandleOps` for exactly how much that proves.
 *
 * WI-195 additions — two PREDICATE boundaries in the same module that a mutation run proved
 * were only ever crossed incidentally, never asserted:
 *   - `acquireLock`'s stale-lock reclaim age test (every mutant on it survived)
 *   - `loadAllEvents`' ts/id ordering tiebreak (a real event-sourcing invariant)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, appendEvents, withLock, loadAllEvents } from '../src/ledger.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';

const WORK_DIR = join(tmpdir(), `loopkit-append-test-${process.pid}`);

test('append: sequential appends produce valid JSONL', async () => {
  const dir = join(WORK_DIR, 'seq');
  mkdirSync(dir, { recursive: true });
  try {
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      const ev = makeEvent('test', `WI-${String(i + 1).padStart(3, '0')}`, 'item.captured', {
        source: 'test',
        text: `event ${i}`,
      }, `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`);
      await appendEvent(dir, ev);
    }
    const content = readFileSync(join(dir, 'work-2026-01.jsonl'), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, COUNT);
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws on corrupt line
      assert.ok(parsed.id);
      assert.ok(parsed.ts);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: concurrent in-process appends produce no corrupt lines and no duplicate ids', async () => {
  const dir = join(WORK_DIR, 'concurrent');
  mkdirSync(dir, { recursive: true });
  try {
    const CONCURRENT = 50;
    // All events go to the same segment (same month)
    const tasks = Array.from({ length: CONCURRENT }, (_, i) => {
      const ev = makeEvent(
        `worker${i % 5}`,
        `WI-${String(i + 1).padStart(3, '0')}`,
        'item.captured',
        { source: 'concurrent-test', text: 'x'.repeat(100) },
        // Spread across same month so they all hit the same segment file
        `2026-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      );
      return appendEvent(dir, ev);
    });

    // Launch all concurrently
    await Promise.all(tasks);

    // Read back and validate
    const content = readFileSync(join(dir, 'work-2026-03.jsonl'), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, CONCURRENT, `Expected ${CONCURRENT} lines, got ${lines.length}`);

    const ids = new Set<string>();
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        assert.fail(`Corrupt JSONL line (parse error: ${e}): ${line.slice(0, 120)}`);
      }
      assert.ok(typeof parsed['id'] === 'string', `Missing id in line: ${line.slice(0, 80)}`);
      assert.ok(typeof parsed['ts'] === 'string', `Missing ts in line: ${line.slice(0, 80)}`);
      // No duplicate ids
      assert.ok(!ids.has(parsed['id'] as string), `Duplicate id: ${parsed['id']}`);
      ids.add(parsed['id'] as string);
    }
    assert.equal(ids.size, CONCURRENT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: makeEvent stamps v:1 and it round-trips through the ledger line', async () => {
  const dir = join(WORK_DIR, 'schema-version');
  mkdirSync(dir, { recursive: true });
  try {
    const ev = makeEvent('test', 'WI-900', 'item.captured', {
      source: 'test',
      text: 'schema version check',
    }, '2026-02-01T00:00:00Z');
    assert.equal(ev.v, 1);
    await appendEvent(dir, ev);
    const content = readFileSync(join(dir, 'work-2026-02.jsonl'), 'utf8');
    const line = content.trim().split('\n').filter(Boolean)[0]!;
    const parsed = JSON.parse(line);
    assert.equal(parsed.v, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Durability barrier — fsync before close
// ---------------------------------------------------------------------------

type HandleOp = { op: 'write' | 'sync' | 'close'; handle: number; fdAtCall: number };

interface PatchableHandle { fd: number; close: () => Promise<void> }

/**
 * Run `fn` with FileHandle write/sync/close instrumented, returning the ordered call trace
 * tagged by HANDLE IDENTITY (not fd — the OS recycles the same fd number for sequential
 * handles, so an fd-keyed trace silently merges three appends into one).
 *
 * WHAT A TRACE-BASED TEST PROVES, HONESTLY:
 *   - It proves the code path calls fsync(2) on the SAME handle it wrote to, and that the
 *     call is ordered write → sync → close rather than after the close (where it would be
 *     a no-op) or on some other handle. That is the actual bug class being fixed here, and
 *     it is a property of our code, so a test is the right instrument for it.
 *   - It does NOT prove durability. It cannot. Whether the bytes truly survive a power cut
 *     is a property of the kernel, the filesystem and the drive's write cache, not of this
 *     process — and on macOS fsync(2) notably does NOT flush the device cache (that needs
 *     F_FULLFSYNC, unavailable from Node). Proving real durability needs a machine you can
 *     cut power to mid-append, which no unit test is.
 *   - It is also, by construction, coupled to the implementation calling `fh.sync()`. A
 *     future rewrite that achieved durability another way (O_DSYNC, a batched sync) would
 *     fail this test while being correct. That is accepted: this pins a deliberate choice,
 *     and a rewrite should have to state its own barrier explicitly.
 */
async function traceHandleOps<T>(fn: () => Promise<T>): Promise<{ result: T; calls: HandleOp[] }> {
  const scratch = join(WORK_DIR, `proto-probe-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const probeFile = join(scratch, 'probe.txt');
  const probe = await open(probeFile, 'a');
  // FileHandle is not exported; reach its prototype through a real handle. It is shared by
  // every handle in the process, so patching it intercepts the ledger's own calls.
  const proto = Object.getPrototypeOf(probe) as Record<string, unknown>;
  await probe.close();

  const calls: HandleOp[] = [];
  const ids = new Map<object, number>();
  const idOf = (h: object): number => {
    let id = ids.get(h);
    if (id === undefined) { id = ids.size; ids.set(h, id); }
    return id;
  };
  const closeWrapped = new WeakSet<object>();

  const orig = { write: proto['write'], sync: proto['sync'] };
  const wrap = (op: 'write' | 'sync', fnOrig: unknown) =>
    function (this: PatchableHandle, ...args: unknown[]) {
      const id = idOf(this);
      // Read fd BEFORE delegating — a closed handle reports -1.
      calls.push({ op, handle: id, fdAtCall: this.fd });
      // `close` is an OWN bound property on each FileHandle, NOT a prototype method, so it
      // cannot be intercepted on the prototype. Wrap this instance's own close the first
      // time we see the handle; every handle we care about is written to before it closes.
      if (!closeWrapped.has(this)) {
        closeWrapped.add(this);
        const ownClose = this.close.bind(this);
        this.close = () => {
          calls.push({ op: 'close', handle: id, fdAtCall: this.fd });
          return ownClose();
        };
      }
      return (fnOrig as (...a: unknown[]) => unknown).apply(this, args);
    };
  proto['write'] = wrap('write', orig.write);
  proto['sync'] = wrap('sync', orig.sync);
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    proto['write'] = orig.write;
    proto['sync'] = orig.sync;
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Per-handle op sequences, keeping only handles that were actually written to. */
function writtenHandleSequences(calls: HandleOp[]): HandleOp['op'][][] {
  const byHandle = new Map<number, HandleOp['op'][]>();
  for (const c of calls) {
    if (!byHandle.has(c.handle)) byHandle.set(c.handle, []);
    byHandle.get(c.handle)!.push(c.op);
  }
  return [...byHandle.values()].filter(seq => seq.includes('write'));
}

test('append: a single append fsyncs the handle it wrote to, before closing it', async () => {
  const dir = join(WORK_DIR, 'fsync-single');
  mkdirSync(dir, { recursive: true });
  try {
    const ev = makeEvent('test', 'WI-500', 'item.captured', {
      source: 'test',
      text: 'durability',
    }, '2026-04-01T00:00:00Z');

    const { calls } = await traceHandleOps(() => appendEvent(dir, ev));

    const sequences = writtenHandleSequences(calls);
    assert.equal(sequences.length, 1, 'exactly one handle should be written to');
    assert.deepEqual(
      sequences[0],
      ['write', 'sync', 'close'],
      'the append must sync BEFORE close — a sync after close is a no-op, and no sync at all ' +
      'leaves an acknowledged append living only in the OS page cache',
    );

    // Independent of call order: the handle was still OPEN when sync ran. A sync issued
    // after close would see fd -1 (and would reject with EBADF rather than flush anything).
    const syncCall = calls.find(c => c.op === 'sync');
    assert.ok(syncCall && syncCall.fdAtCall >= 0, 'sync must run on a still-open handle');

    // The bytes are also actually there (the barrier did not replace the write).
    const line = readFileSync(join(dir, 'work-2026-04.jsonl'), 'utf8').trim();
    assert.equal(JSON.parse(line).id, ev.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: appendEvents syncs every event in the batch (one sync per line, no unsynced tail)', async () => {
  const dir = join(WORK_DIR, 'fsync-batch');
  mkdirSync(dir, { recursive: true });
  try {
    const events = [0, 1, 2].map(i =>
      makeEvent('test', `WI-6${i}0`, 'item.captured', { source: 'test', text: `batch ${i}` },
        '2026-05-01T00:00:00Z'));

    const { calls } = await traceHandleOps(() => appendEvents(dir, events));

    const sequences = writtenHandleSequences(calls);
    // Pins the deliberate per-event (not per-batch) barrier: appendEvents funnels through
    // appendEvent, so each event gets its own open/write/sync/close cycle. If this is ever
    // changed to one held handle + one sync per segment, this expectation must change WITH
    // it — consciously, not by accident.
    assert.equal(sequences.length, events.length, 'one handle per event in the batch');
    for (const seq of sequences) {
      assert.deepEqual(seq, ['write', 'sync', 'close']);
    }
    assert.equal(
      calls.filter(c => c.op === 'sync').length,
      events.length,
      'no event in a batch may land unsynced',
    );

    const lines = readFileSync(join(dir, 'work-2026-05.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, events.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: large concurrent batch (stress) — no data loss', async () => {
  const dir = join(WORK_DIR, 'stress');
  mkdirSync(dir, { recursive: true });
  try {
    const COUNT = 100;
    const tasks = Array.from({ length: COUNT }, (_, i) => {
      const ev = makeEvent('stress', `WI-${String(i + 1).padStart(3, '0')}`, 'item.queued', {
        spec: `spec-${i}`,
      }, `2026-06-${String((i % 30) + 1).padStart(2, '0')}T00:00:00Z`);
      return appendEvent(dir, ev);
    });
    await Promise.all(tasks);
    const content = readFileSync(join(dir, 'work-2026-06.jsonl'), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, COUNT);
    // All parseable
    for (const line of lines) {
      JSON.parse(line); // throws if corrupt
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// acquireLock: the stale-lock reclaim AGE predicate (WI-195)
//
// `Date.now() - st.mtimeMs > LOCK_TIMEOUT_MS` decides whether a contended lock is stolen or
// respected. Every mutant on it survived the mutation run (forced true, forced false, `<=`,
// `-`→`+`, whole body deleted) — a forced-true version steals a LIVE holder's lock, which is
// exactly the concurrent-append corruption the lock exists to prevent.
// ---------------------------------------------------------------------------

/**
 * `LOCK_TIMEOUT_MS` in ledger.ts is module-private; mirrored here. It is BOTH the acquire spin
 * deadline AND the staleness threshold — which is why these tests stub the clock instead of
 * sleeping: a real contended acquire spins for 30 s before the reclaim branch is even reached.
 */
const LEDGER_LOCK_TIMEOUT_MS = 30_000;

/**
 * Run `fn` with Date.now() returning `first` on its first call and `rest` on every call after.
 * acquireLock calls it three times on the contended path (deadline · loop condition · staleness
 * check), so returning a past-the-deadline value from call 2 onward collapses the spin to zero
 * while leaving the staleness arithmetic fully under the test's control.
 */
async function withStubbedNow<T>(first: number, rest: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => (++calls === 1 ? first : rest);
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Pre-create a held `.ledger.lock` with a pinned mtime; returns the mtime the OS actually stored. */
function heldLockMtimeMs(dir: string): number {
  const lockPath = join(dir, '.ledger.lock');
  mkdirSync(lockPath, { recursive: true });
  const pinned = new Date(1_800_000_000_000);
  utimesSync(lockPath, pinned, pinned);
  return statSync(lockPath).mtimeMs;
}

test('ledger lock: a lock exactly LOCK_TIMEOUT_MS old is NOT stale — acquire fails rather than stealing it', async () => {
  const dir = join(WORK_DIR, 'lock-not-stale');
  mkdirSync(dir, { recursive: true });
  try {
    const mtimeMs = heldLockMtimeMs(dir);
    const checkNow = mtimeMs + LEDGER_LOCK_TIMEOUT_MS; // age === threshold; the test is STRICTLY `>`
    let ran = false;
    await assert.rejects(
      withStubbedNow(checkNow - LEDGER_LOCK_TIMEOUT_MS, checkNow,
        () => withLock(dir, async () => { ran = true; })),
      /Could not acquire ledger lock/,
      'a lock that has not yet outlived the timeout must never be reclaimed',
    );
    assert.equal(ran, false, 'the transaction body must not run without the lock');
    assert.ok(existsSync(join(dir, '.ledger.lock')), "the holder's lock dir must be left in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger lock: a lock older than LOCK_TIMEOUT_MS IS reclaimed and the transaction proceeds', async () => {
  const dir = join(WORK_DIR, 'lock-stale');
  mkdirSync(dir, { recursive: true });
  try {
    const mtimeMs = heldLockMtimeMs(dir);
    const checkNow = mtimeMs + LEDGER_LOCK_TIMEOUT_MS + 1; // one ms past the threshold
    let ran = false;
    const result = await withStubbedNow(checkNow - LEDGER_LOCK_TIMEOUT_MS, checkNow,
      () => withLock(dir, async () => { ran = true; return 'reclaimed'; }));
    assert.equal(result, 'reclaimed', 'a stale lock must be reclaimed, not wedge the lane forever');
    assert.equal(ran, true);
    assert.equal(existsSync(join(dir, '.ledger.lock')), false, 'the reclaimed lock is released on exit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadAllEvents ordering: ts first, event id as the deterministic tiebreak (WI-195)
//
// `t !== 0 ? t : a.id.localeCompare(b.id)` forced to `false` (always compare ids) survived.
// Fold order is the kernel's replay order, so this is a load-bearing event-sourcing invariant,
// not a cosmetic one.
// ---------------------------------------------------------------------------

/** A schema-valid event with a caller-chosen id (ids must start with `ev-`) and timestamp. */
function eventWithId(id: string, ts: string, item: string): LedgerEvent {
  return { ...makeEvent('test', item, 'item.queued', { spec: item }, ts), id } as unknown as LedgerEvent;
}

function writeSegment(dir: string, name: string, events: LedgerEvent[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

const ID_AA = 'ev-00000000000000000000AA';
const ID_ZZ = 'ev-00000000000000000000ZZ';

test('loadAllEvents: same-timestamp events tiebreak on event id, NOT on file position', async () => {
  const dir = join(WORK_DIR, 'order-tiebreak');
  const SAME_TS = '2026-07-01T00:00:00.000Z';
  // Written in DESCENDING id order, so "insertion order" and "id order" disagree.
  writeSegment(dir, 'work-2026-07.jsonl', [
    eventWithId(ID_ZZ, SAME_TS, 'WI-ZZ'),
    eventWithId(ID_AA, SAME_TS, 'WI-AA'),
  ]);
  try {
    const events = await loadAllEvents(dir);
    // kills: `t !== 0 ? t : …` forced TRUE / `t !== 0` → `t === 0` (both fall back to the
    //        comparator returning 0, i.e. file order, for a same-ms pair).
    assert.deepEqual(events.map(e => e.item), ['WI-AA', 'WI-ZZ'],
      'two events sharing a millisecond must replay in monotonic id order');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAllEvents: timestamp wins over id — the id tiebreak applies ONLY when ts is equal', async () => {
  const dir = join(WORK_DIR, 'order-ts-wins');
  // ids deliberately contradict ts order: the LATER event carries the LOWER id.
  writeSegment(dir, 'work-2026-07.jsonl', [
    eventWithId(ID_AA, '2026-07-01T00:00:02.000Z', 'WI-LATE'),
    eventWithId(ID_ZZ, '2026-07-01T00:00:01.000Z', 'WI-EARLY'),
  ]);
  try {
    const events = await loadAllEvents(dir);
    // kills: `t !== 0 ? t : …` forced FALSE (id compare would always win → ['WI-LATE','WI-EARLY']).
    assert.deepEqual(events.map(e => e.item), ['WI-EARLY', 'WI-LATE'],
      'timestamp ordering must not be replaced by id ordering');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
