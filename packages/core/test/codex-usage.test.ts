/**
 * codex-usage.test.ts — Codex CLI session cost collector.
 *
 * Covers:
 *   parseCodexTokenCount — accepts token_count event_msg lines, uses last_token_usage (not
 *                          cumulative total_token_usage), rejects non-token_count/malformed lines
 *   parseSessionCwd / classifyLoop — session_meta cwd extraction -> consult vs interactive-manual
 *   collectCodexUsage — end-to-end: recursive discovery, loop classification, dedup, watermark resume
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseCodexTokenCount,
  parseSessionCwd,
  classifyLoop,
  collectCodexUsage,
} from '../src/collectors/codex-usage.js';

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-codex-usage-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function sessionMetaLine(cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-07-16T09:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'sess_1', cwd, originator: 'codex_cli_rs' },
  });
}

function tokenCountLine(opts: {
  timestamp?: string;
  lastUsage?: Record<string, number>;
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string | number;
  planType?: string;
}): string {
  const hasRateLimits = opts.usedPercent !== undefined || opts.windowMinutes !== undefined || opts.resetsAt !== undefined;
  return JSON.stringify({
    timestamp: opts.timestamp ?? '2026-07-16T09:01:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 999_999, output_tokens: 999_999 }, // cumulative — must be ignored
        last_token_usage: opts.lastUsage ?? {
          input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10,
        },
      },
      ...(hasRateLimits || opts.planType !== undefined
        ? {
            rate_limits: {
              ...(hasRateLimits ? {
                primary: {
                  ...(opts.usedPercent !== undefined ? { used_percent: opts.usedPercent } : {}),
                  ...(opts.windowMinutes !== undefined ? { window_minutes: opts.windowMinutes } : {}),
                  ...(opts.resetsAt !== undefined ? { resets_at: opts.resetsAt } : {}),
                },
              } : {}),
              ...(opts.planType !== undefined ? { plan_type: opts.planType } : {}),
            },
          }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// parseCodexTokenCount
// ---------------------------------------------------------------------------

test('parseCodexTokenCount: accepts a token_count event_msg, sums last_token_usage (not cumulative total)', () => {
  const usage = parseCodexTokenCount(tokenCountLine({ usedPercent: 6.4 }));
  assert.ok(usage);
  assert.equal(usage!.tokens, 180); // 100+20+50+10 — NOT the 999_999+999_999 cumulative total
  assert.equal(usage!.inputTokens, 100);
  assert.equal(usage!.cachedInputTokens, 20);
  assert.equal(usage!.outputTokens, 50);
  assert.equal(usage!.reasoningTokens, 10);
  assert.equal(usage!.quotaPercent, 6.4);
});

test('parseCodexTokenCount: quotaPercent absent when rate_limits missing', () => {
  const usage = parseCodexTokenCount(tokenCountLine({}));
  assert.ok(usage);
  assert.equal(usage!.quotaPercent, undefined);
});

test('parseCodexTokenCount: extracts windowMinutes, resetsAt, planType when the payload carries rate_limits metadata', () => {
  const usage = parseCodexTokenCount(tokenCountLine({
    usedPercent: 20,
    windowMinutes: 10_080,
    resetsAt: '2026-07-23T00:00:00.000Z',
    planType: 'plus',
  }));
  assert.ok(usage);
  assert.equal(usage!.windowMinutes, 10_080);
  assert.equal(usage!.resetsAt, '2026-07-23T00:00:00.000Z');
  assert.equal(usage!.planType, 'plus');
});

test('parseCodexTokenCount: windowMinutes/resetsAt/planType absent when the payload never carries rate_limits metadata (never assume the "primary" window structure)', () => {
  const usage = parseCodexTokenCount(tokenCountLine({}));
  assert.ok(usage);
  assert.equal(usage!.windowMinutes, undefined);
  assert.equal(usage!.resetsAt, undefined);
  assert.equal(usage!.planType, undefined);
});

test('parseCodexTokenCount: a malformed resets_at (not parseable as a date) is dropped, not passed through', () => {
  const usage = parseCodexTokenCount(tokenCountLine({ usedPercent: 5, resetsAt: 'not-a-date' }));
  assert.ok(usage);
  assert.equal(usage!.resetsAt, undefined);
});

test('parseCodexTokenCount: resets_at as Unix epoch SECONDS (the real Codex rollout shape) is normalized to ISO8601', () => {
  // Confirmed against a live ~/.codex/sessions rollout — the CLI ships resets_at as a raw
  // number, not an ISO string, so a naive implementation would silently drop it for every
  // real Codex reading despite fixture-only test coverage passing.
  const usage = parseCodexTokenCount(tokenCountLine({ usedPercent: 6, resetsAt: 1_784_794_263 }));
  assert.ok(usage);
  assert.equal(usage!.resetsAt, new Date(1_784_794_263 * 1000).toISOString());
});

test('parseCodexTokenCount: window is "primary" alongside a quotaPercent reading, absent when there is no reading', () => {
  const withReading = parseCodexTokenCount(tokenCountLine({ usedPercent: 6 }));
  assert.equal(withReading!.window, 'primary');
  const withoutReading = parseCodexTokenCount(tokenCountLine({}));
  assert.equal(withoutReading!.window, undefined);
});

test('parseCodexTokenCount: rejects non-token_count event_msg lines', () => {
  const line = JSON.stringify({ timestamp: '2026-07-16T09:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message' } });
  assert.equal(parseCodexTokenCount(line), null);
});

test('parseCodexTokenCount: rejects session_meta lines', () => {
  assert.equal(parseCodexTokenCount(sessionMetaLine('/Users/x/example-project')), null);
});

test('parseCodexTokenCount: rejects malformed JSON without throwing', () => {
  assert.equal(parseCodexTokenCount('{not json'), null);
});

test('parseCodexTokenCount: rejects a token_count line with no last_token_usage or bad timestamp', () => {
  const noUsage = JSON.stringify({
    timestamp: '2026-07-16T09:01:00.000Z', type: 'event_msg',
    payload: { type: 'token_count', info: {} },
  });
  assert.equal(parseCodexTokenCount(noUsage), null);
  const badTs = tokenCountLine({ timestamp: 'not-a-date' });
  assert.equal(parseCodexTokenCount(badTs), null);
});

// ---------------------------------------------------------------------------
// parseSessionCwd / classifyLoop
// ---------------------------------------------------------------------------

test('parseSessionCwd: extracts cwd from a session_meta line', () => {
  assert.equal(parseSessionCwd(sessionMetaLine('/workspace/example-project-task-1')), '/workspace/example-project-task-1');
});

test('parseSessionCwd: undefined for a non-session_meta or malformed line', () => {
  assert.equal(parseSessionCwd(tokenCountLine({})), undefined);
  assert.equal(parseSessionCwd('{not json'), undefined);
});

test('classifyLoop: cwd containing the project filter is consult, else interactive-manual', () => {
  assert.equal(classifyLoop('/workspace/example-project-task-1', 'example-project'), 'consult');
  assert.equal(classifyLoop('/Users/x/Projects/some-other-app', 'example-project'), 'interactive-manual');
  assert.equal(classifyLoop(undefined, 'example-project'), 'interactive-manual');
});

// ---------------------------------------------------------------------------
// collectCodexUsage (fs orchestration)
// ---------------------------------------------------------------------------

test('collectCodexUsage: classifies loop from session_meta cwd, walks nested date dirs', async () => {
  const root = makeTempDir();
  try {
    const consultDir = join(root, 'sessions', '2026', '07', '16');
    const manualDir = join(root, 'sessions', '2026', '07', '15');
    mkdirSync(consultDir, { recursive: true });
    mkdirSync(manualDir, { recursive: true });

    writeFileSync(join(consultDir, 'rollout-a.jsonl'), [
      sessionMetaLine('/workspace/example-project-task-1'),
      tokenCountLine({ usedPercent: 6 }),
    ].join('\n') + '\n');
    writeFileSync(join(manualDir, 'rollout-b.jsonl'), [
      sessionMetaLine('/Users/x/Projects/some-personal-thing'),
      tokenCountLine({}),
    ].join('\n') + '\n');
    // Non-rollout file in the tree must be ignored.
    writeFileSync(join(manualDir, 'notes.jsonl'), tokenCountLine({}) + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const { events, filesScanned } = await collectCodexUsage({
      codexSessionsDir: join(root, 'sessions'),
      projectFilter: 'example-project',
      watermarkPath,
    });

    assert.equal(filesScanned, 2, 'only rollout-*.jsonl files are scanned');
    // 2 cost.usage rows + 1 quota.snapshot (only the consult session carried usedPercent).
    assert.equal(events.length, 3);
    const costUsage = events.filter((e) => e.type === 'cost.usage');
    assert.equal(costUsage.length, 2);
    const byLoop = Object.fromEntries(costUsage.map((e) => [e.data['loop'], e]));
    assert.equal(byLoop['consult']!.data['tokens'], 180);
    assert.equal(byLoop['interactive-manual']!.data['tokens'], 180);
    assert.equal(costUsage[0]!.data['provider'], 'codex');
    assert.equal(costUsage[0]!.item, 'codex');

    const quotaSnapshots = events.filter((e) => e.type === 'quota.snapshot');
    assert.equal(quotaSnapshots.length, 1, 'only the consult session reported a rate_limits reading');
    assert.deepEqual(quotaSnapshots[0]!.data, { provider: 'codex', window: 'primary', usedPct: 6, source: 'codex-rollout' });
  } finally {
    cleanDir(root);
  }
});

test('collectCodexUsage: quota.snapshot carries windowMinutes/resetsAt/planType when the rollout reports them', async () => {
  const root = makeTempDir();
  try {
    const sessDir = join(root, 'sessions', '2026', '07', '16');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'rollout-a.jsonl'), [
      sessionMetaLine('/workspace/example-project-task-1'),
      tokenCountLine({ usedPercent: 20, windowMinutes: 10_080, resetsAt: '2026-07-23T00:00:00.000Z', planType: 'plus' }),
    ].join('\n') + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const { events } = await collectCodexUsage({ codexSessionsDir: join(root, 'sessions'), watermarkPath });

    const quota = events.find((e) => e.type === 'quota.snapshot');
    assert.ok(quota);
    assert.deepEqual(quota!.data, {
      provider: 'codex', window: 'primary', usedPct: 20, source: 'codex-rollout',
      windowMinutes: 10_080, resetsAt: '2026-07-23T00:00:00.000Z', planType: 'plus',
    });
  } finally {
    cleanDir(root);
  }
});

test('collectCodexUsage: watermark resume skips already-processed bytes, caches loop classification', async () => {
  const root = makeTempDir();
  try {
    const sessDir = join(root, 'sessions', '2026', '07', '16');
    mkdirSync(sessDir, { recursive: true });
    const filePath = join(sessDir, 'rollout-a.jsonl');
    writeFileSync(filePath, [
      sessionMetaLine('/workspace/example-project-task-1'),
      tokenCountLine({ timestamp: '2026-07-16T09:01:00.000Z' }),
    ].join('\n') + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const first = await collectCodexUsage({ codexSessionsDir: join(root, 'sessions'), watermarkPath });
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]!.data['loop'], 'consult');

    const second = await collectCodexUsage({ codexSessionsDir: join(root, 'sessions'), watermarkPath });
    assert.equal(second.events.length, 0, 'no new bytes since last watermark');

    appendFileSync(filePath, tokenCountLine({ timestamp: '2026-07-16T09:02:00.000Z', usedPercent: 12 }) + '\n');
    const third = await collectCodexUsage({ codexSessionsDir: join(root, 'sessions'), watermarkPath });
    // The newly appended turn carries a rate_limits reading, so it produces BOTH a
    // cost.usage row and a quota.snapshot row.
    assert.equal(third.events.length, 2, 'only the newly appended turn is picked up');
    const [usage, quota] = [third.events.find((e) => e.type === 'cost.usage'), third.events.find((e) => e.type === 'quota.snapshot')];
    assert.equal(usage!.data['quotaPercent'], 12);
    assert.equal(usage!.data['loop'], 'consult', 'loop classification is reused from the cached watermark');
    assert.deepEqual(quota!.data, { provider: 'codex', window: 'primary', usedPct: 12, source: 'codex-rollout' });
  } finally {
    cleanDir(root);
  }
});

test('collectCodexUsage: a trailing partial (unflushed) line is not processed or counted', async () => {
  const root = makeTempDir();
  try {
    const sessDir = join(root, 'sessions', '2026', '07', '16');
    mkdirSync(sessDir, { recursive: true });
    const filePath = join(sessDir, 'rollout-a.jsonl');
    writeFileSync(filePath, sessionMetaLine('/workspace/example-project-task-1') + '\n' + tokenCountLine({}).slice(0, -5));

    const watermarkPath = join(root, 'watermark.json');
    const result = await collectCodexUsage({ codexSessionsDir: join(root, 'sessions'), watermarkPath });
    assert.equal(result.events.length, 0);
  } finally {
    cleanDir(root);
  }
});
