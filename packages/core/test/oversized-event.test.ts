// oversized-event.test.ts: an oversized event must NEVER crash the beat. A naive appendEvent
// that throws "Event too large" on any >4096-byte line (a scout brief, a requeue spec, or a
// msg.out remainder list) can abort a beat mid-run, strand a build in state=building with no
// terminal event, and orphan the dispatch lock. The fix degrades instead: clip the longest
// free-text field to fit, keep every structural field, never throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendEvent, appendEvents, shrinkEventToFit, MAX_EVENT_BYTES } from '../src/ledger.js';
import { makeEvent } from '../src/schema.js';

function tempDir(): string {
  const d = join(tmpdir(), `oversized-event-${process.pid}-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test('shrinkEventToFit: clips the longest string field so the line fits, keeps structure', () => {
  const huge = 'x'.repeat(20_000);
  const ev = makeEvent('dispatch', 'WI-999', 'item.queued', {
    spec: huge, touches: 'src/', model: 'sonnet', priority: 'medium',
  });
  const shrunk = shrinkEventToFit(ev, MAX_EVENT_BYTES);

  assert.ok(JSON.stringify(shrunk).length + 1 <= MAX_EVENT_BYTES, 'shrunk line must fit the cap');
  // Structural fields survive untouched — only the big blob is clipped.
  assert.equal(shrunk.id, ev.id);
  assert.equal(shrunk.type, 'item.queued');
  assert.equal((shrunk.data as Record<string, unknown>)['touches'], 'src/');
  assert.equal((shrunk.data as Record<string, unknown>)['model'], 'sonnet');
  const spec = (shrunk.data as Record<string, unknown>)['spec'] as string;
  assert.ok(spec.includes('truncated'), 'clipped field must carry an elision marker');
  assert.ok(spec.length < huge.length, 'spec must actually be shorter');
});

test('shrinkEventToFit: an already-small event is returned unchanged in content', () => {
  const ev = makeEvent('dispatch', 'WI-1', 'gate.passed', { tests: 'green', reason: 'ok' });
  const shrunk = shrinkEventToFit(ev, MAX_EVENT_BYTES);
  assert.deepEqual(shrunk.data, ev.data);
});

test('appendEvent: an oversized event is written (truncated) instead of throwing', async () => {
  const dir = tempDir();
  try {
    const ev = makeEvent('dispatch', 'WI-999', 'item.briefed', { brief: 'B'.repeat(9000), model: 'haiku' });
    await assert.doesNotReject(() => appendEvent(dir, ev), 'appendEvent must not throw on an oversized event');

    // The event is on disk, readable, structurally intact, and within the cap.
    const seg = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
    const lines = readFileSync(join(dir, seg), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.length + 1 <= MAX_EVENT_BYTES, 'written line must fit the cap');
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.id, ev.id);
    assert.equal(parsed.type, 'item.briefed');
    assert.equal(parsed.data.model, 'haiku');
    assert.ok(String(parsed.data.brief).includes('truncated'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendEvents: a batch containing one oversized event still writes all events (no beat-crash)', async () => {
  const dir = tempDir();
  try {
    await appendEvents(dir, [
      makeEvent('dispatch', 'WI-2', 'item.captured', { source: 'test', text: 'small' }),
      makeEvent('dispatch', 'WI-2', 'item.queued', { spec: 'S'.repeat(10_000), touches: 'src/' }),
      makeEvent('dispatch', 'WI-2', 'build.dispatched', { attempt: 1, branch: 'wi-2-a1' }),
    ]);
    const seg = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const all = seg.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n')).filter(Boolean);
    assert.equal(all.length, 3, 'all three events must be persisted');
    for (const l of all) assert.ok(l.length + 1 <= MAX_EVENT_BYTES, 'every written line fits the cap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
