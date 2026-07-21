/**
 * append.test.ts — Append atomicity test: concurrent appenders, no interleaved/corrupt lines.
 *
 * O_APPEND + single-line writes < 4KB are atomic on POSIX; this test verifies
 * that concurrent in-process appends produce no corrupt/interleaved lines and no
 * duplicate ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent } from '../src/ledger.js';
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
