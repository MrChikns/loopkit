/**
 * append.test.ts — Append atomicity + durability tests for the ledger write path.
 *
 * O_APPEND + single-line writes < 4KB are atomic on POSIX; this test verifies
 * that concurrent in-process appends produce no corrupt/interleaved lines and no
 * duplicate ids.
 *
 * It also verifies the durability barrier: every append fsyncs its handle BEFORE closing
 * it. See the honesty note on `traceHandleOps` for exactly how much that proves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, appendEvents } from '../src/ledger.js';
import { makeEvent } from '../src/schema.js';

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
