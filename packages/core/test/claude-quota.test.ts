/**
 * claude-quota.test.ts — the statusline.py drop-file collector.
 *
 * Covers:
 *   parseClaudeQuotaLine — one drop-file line -> one quota.snapshot data point per window
 *   collectClaudeQuota — end-to-end: byte-offset watermark resume, missing file no-ops
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseClaudeQuotaLine, collectClaudeQuota } from '../src/collectors/claude-quota.js';

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-claude-quota-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function dropLine(opts: { ts?: string; planType?: string; windows: Array<{ window: string; usedPct: number; resetsAt?: string }> }): string {
  return JSON.stringify({
    ts: opts.ts ?? '2026-07-16T09:00:00.000Z',
    provider: 'claude',
    ...(opts.planType !== undefined ? { planType: opts.planType } : {}),
    windows: opts.windows,
  });
}

// ---------------------------------------------------------------------------
// parseClaudeQuotaLine
// ---------------------------------------------------------------------------

test('parseClaudeQuotaLine: one point per window entry', () => {
  const points = parseClaudeQuotaLine(dropLine({
    planType: 'max20x',
    windows: [
      { window: 'five_hour', usedPct: 12.3 },
      { window: 'seven_day', usedPct: 45.6, resetsAt: '2026-07-20T00:00:00.000Z' },
    ],
  }));
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], { window: 'five_hour', usedPct: 12.3, ts: '2026-07-16T09:00:00.000Z', planType: 'max20x' });
  assert.deepEqual(points[1], {
    window: 'seven_day', usedPct: 45.6, ts: '2026-07-16T09:00:00.000Z',
    resetsAt: '2026-07-20T00:00:00.000Z', planType: 'max20x',
  });
});

test('parseClaudeQuotaLine: rejects malformed JSON, missing ts, or non-array windows without throwing', () => {
  assert.deepEqual(parseClaudeQuotaLine('{not json'), []);
  assert.deepEqual(parseClaudeQuotaLine(JSON.stringify({ provider: 'claude', windows: [] })), []);
  assert.deepEqual(parseClaudeQuotaLine(JSON.stringify({ ts: '2026-07-16T09:00:00.000Z', provider: 'claude' })), []);
  assert.deepEqual(parseClaudeQuotaLine(''), []);
});

test('parseClaudeQuotaLine: skips malformed window entries but keeps the well-formed ones', () => {
  const points = parseClaudeQuotaLine(dropLine({
    windows: [
      { window: 'five_hour', usedPct: 10 },
      // @ts-expect-error — deliberately malformed for the test
      { window: 'seven_day' },
    ],
  }));
  assert.equal(points.length, 1);
  assert.equal(points[0]!.window, 'five_hour');
});

// ---------------------------------------------------------------------------
// collectClaudeQuota (fs orchestration)
// ---------------------------------------------------------------------------

test('collectClaudeQuota: missing drop file no-ops (a machine that has not run statusline.py yet)', async () => {
  const root = makeTempDir();
  try {
    const result = await collectClaudeQuota({
      dropFilePath: join(root, 'claude-quota.jsonl'),
      watermarkPath: join(root, 'watermark.json'),
    });
    assert.deepEqual(result.events, []);
  } finally {
    cleanDir(root);
  }
});

test('collectClaudeQuota: reads new lines into quota.snapshot events, one per window', async () => {
  const root = makeTempDir();
  try {
    const dropFilePath = join(root, 'claude-quota.jsonl');
    writeFileSync(dropFilePath, dropLine({
      windows: [{ window: 'five_hour', usedPct: 12 }, { window: 'seven_day', usedPct: 30 }],
    }) + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const { events } = await collectClaudeQuota({ dropFilePath, watermarkPath });
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'quota.snapshot');
    assert.equal(events[0]!.item, 'claude');
    assert.deepEqual(events[0]!.data, { provider: 'claude', window: 'five_hour', usedPct: 12, source: 'statusline' });
    assert.deepEqual(events[1]!.data, { provider: 'claude', window: 'seven_day', usedPct: 30, source: 'statusline' });
  } finally {
    cleanDir(root);
  }
});

test('collectClaudeQuota: watermark resume skips already-processed bytes', async () => {
  const root = makeTempDir();
  try {
    const dropFilePath = join(root, 'claude-quota.jsonl');
    writeFileSync(dropFilePath, dropLine({ windows: [{ window: 'five_hour', usedPct: 10 }] }) + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const first = await collectClaudeQuota({ dropFilePath, watermarkPath });
    assert.equal(first.events.length, 1);

    const second = await collectClaudeQuota({ dropFilePath, watermarkPath });
    assert.equal(second.events.length, 0, 'no new bytes since last watermark');

    appendFileSync(dropFilePath, dropLine({ ts: '2026-07-16T10:00:00.000Z', windows: [{ window: 'five_hour', usedPct: 15 }] }) + '\n');
    const third = await collectClaudeQuota({ dropFilePath, watermarkPath });
    assert.equal(third.events.length, 1, 'only the newly appended line is picked up');
    assert.equal(third.events[0]!.data['usedPct'], 15);
  } finally {
    cleanDir(root);
  }
});

test('collectClaudeQuota: a trailing partial (unflushed) line is not processed or counted', async () => {
  const root = makeTempDir();
  try {
    const dropFilePath = join(root, 'claude-quota.jsonl');
    writeFileSync(dropFilePath, dropLine({ windows: [{ window: 'five_hour', usedPct: 10 }] }).slice(0, -5));

    const watermarkPath = join(root, 'watermark.json');
    const result = await collectClaudeQuota({ dropFilePath, watermarkPath });
    assert.deepEqual(result.events, []);
  } finally {
    cleanDir(root);
  }
});
