/**
 * interactive-usage.test.ts — the interactive-session cost collector.
 *
 * Covers:
 *   parseInteractiveTurn — accepts cli assistant turns, rejects sdk-cli/headless,
 *                          non-assistant lines, malformed JSON, missing usage
 *   pricingTierFor / estimateUsd — model alias -> tier, cache-tier-aware pricing
 *   collectInteractiveUsage — end-to-end: project-dir filter, dedup, watermark resume
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseInteractiveTurn,
  pricingTierFor,
  estimateUsd,
  collectInteractiveUsage,
} from '../src/collectors/interactive-usage.js';

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-interactive-usage-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function assistantLine(opts: {
  entrypoint: string;
  model?: string;
  requestId?: string;
  messageId?: string;
  timestamp?: string;
  usage?: Record<string, number>;
}): string {
  return JSON.stringify({
    type: 'assistant',
    entrypoint: opts.entrypoint,
    requestId: opts.requestId ?? 'req_1',
    timestamp: opts.timestamp ?? '2026-07-16T10:00:00.000Z',
    message: {
      id: opts.messageId ?? 'msg_1',
      model: opts.model ?? 'claude-sonnet-5',
      usage: opts.usage ?? { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

// ---------------------------------------------------------------------------
// parseInteractiveTurn
// ---------------------------------------------------------------------------

test('parseInteractiveTurn: accepts a genuine interactive (cli) assistant turn', () => {
  const turn = parseInteractiveTurn(assistantLine({ entrypoint: 'cli' }));
  assert.ok(turn);
  assert.equal(turn!.key, 'msg_1:req_1');
  assert.equal(turn!.model, 'claude-sonnet-5');
  assert.equal(turn!.tokens, 150);
});

test('parseInteractiveTurn: rejects sdk-cli (headless/loopkit-spawned) turns', () => {
  assert.equal(parseInteractiveTurn(assistantLine({ entrypoint: 'sdk-cli' })), null);
});

test('parseInteractiveTurn: rejects non-assistant lines', () => {
  const line = JSON.stringify({ type: 'user', entrypoint: 'cli', message: { usage: { input_tokens: 1 } } });
  assert.equal(parseInteractiveTurn(line), null);
});

test('parseInteractiveTurn: rejects malformed JSON without throwing', () => {
  assert.equal(parseInteractiveTurn('{not json'), null);
});

test('parseInteractiveTurn: rejects lines with no usage field (fast-path skip)', () => {
  assert.equal(parseInteractiveTurn(JSON.stringify({ type: 'assistant', entrypoint: 'cli' })), null);
});

test('parseInteractiveTurn: rejects missing model or invalid timestamp', () => {
  const noModel = JSON.stringify({
    type: 'assistant', entrypoint: 'cli', timestamp: '2026-07-16T10:00:00.000Z',
    message: { id: 'm', usage: { input_tokens: 1 } },
  });
  assert.equal(parseInteractiveTurn(noModel), null);
  const badTs = assistantLine({ entrypoint: 'cli', timestamp: 'not-a-date' });
  assert.equal(parseInteractiveTurn(badTs), null);
});

// ---------------------------------------------------------------------------
// pricing
// ---------------------------------------------------------------------------

test('pricingTierFor: maps known aliases, falls back to sonnet for unknown', () => {
  assert.equal(pricingTierFor('claude-opus-4-8'), 'opus');
  assert.equal(pricingTierFor('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(pricingTierFor('claude-sonnet-5'), 'sonnet');
  assert.equal(pricingTierFor('claude-fable-5'), 'sonnet');
});

test('estimateUsd: prices each usage field at its own tier, no double counting', () => {
  const usd = estimateUsd('claude-sonnet-5', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  // sonnet tier: 3 + 15 + 0.30 + 3.75 = 22.05
  assert.ok(Math.abs(usd - 22.05) < 1e-9, `expected ~22.05, got ${usd}`);
});

test('estimateUsd: zero usage yields zero cost', () => {
  assert.equal(estimateUsd('claude-sonnet-5', {}), 0);
});

// ---------------------------------------------------------------------------
// collectInteractiveUsage (fs orchestration)
// ---------------------------------------------------------------------------

test('collectInteractiveUsage: only scans filtered project dirs, only counts cli turns', async () => {
  const root = makeTempDir();
  try {
    const filteredDir = join(root, 'projects', '-Users-x-Projects-my-app');
    const otherDir = join(root, 'projects', '-Users-x-Projects-some-other-app');
    mkdirSync(filteredDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });

    writeFileSync(join(filteredDir, 'session-a.jsonl'), [
      assistantLine({ entrypoint: 'cli', requestId: 'r1', messageId: 'm1' }),
      assistantLine({ entrypoint: 'sdk-cli', requestId: 'r2', messageId: 'm2' }), // beat-spawned — excluded
    ].join('\n') + '\n');
    writeFileSync(join(otherDir, 'session-b.jsonl'), [
      assistantLine({ entrypoint: 'cli', requestId: 'r3', messageId: 'm3' }),
    ].join('\n') + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const { events, filesScanned } = await collectInteractiveUsage({
      claudeProjectsDir: join(root, 'projects'),
      projectFilter: 'my-app',
      watermarkPath,
    });

    assert.equal(filesScanned, 1, 'only the filtered project dir is scanned');
    assert.equal(events.length, 1, 'only the cli-entrypoint turn is counted');
    assert.equal(events[0]!.data['loop'], 'interactive');
    assert.equal(events[0]!.item, 'interactive');
  } finally {
    cleanDir(root);
  }
});

test('collectInteractiveUsage: default projectFilter (unset) matches every project dir', async () => {
  const root = makeTempDir();
  try {
    const dirA = join(root, 'projects', '-Users-x-Projects-app-a');
    const dirB = join(root, 'projects', '-Users-x-Projects-app-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    writeFileSync(join(dirA, 'session-a.jsonl'), assistantLine({ entrypoint: 'cli', requestId: 'r1', messageId: 'm1' }) + '\n');
    writeFileSync(join(dirB, 'session-b.jsonl'), assistantLine({ entrypoint: 'cli', requestId: 'r2', messageId: 'm2' }) + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const { events, filesScanned } = await collectInteractiveUsage({
      claudeProjectsDir: join(root, 'projects'),
      watermarkPath,
    });

    assert.equal(filesScanned, 2, 'default filter (\'\') matches every project dir');
    assert.equal(events.length, 2);
  } finally {
    cleanDir(root);
  }
});

test('collectInteractiveUsage: watermark resume skips already-processed bytes, dedups within a run', async () => {
  const root = makeTempDir();
  try {
    const projDir = join(root, 'projects', '-Users-x-Projects-my-app');
    mkdirSync(projDir, { recursive: true });
    const filePath = join(projDir, 'session.jsonl');
    writeFileSync(filePath, assistantLine({ entrypoint: 'cli', requestId: 'r1', messageId: 'm1' }) + '\n');

    const watermarkPath = join(root, 'watermark.json');
    const first = await collectInteractiveUsage({ claudeProjectsDir: join(root, 'projects'), watermarkPath });
    assert.equal(first.events.length, 1);

    // Re-run with no new bytes: watermark must prevent a re-count.
    const second = await collectInteractiveUsage({ claudeProjectsDir: join(root, 'projects'), watermarkPath });
    assert.equal(second.events.length, 0);

    // Append a genuinely new turn — only the new line should be picked up.
    appendFileSync(filePath, assistantLine({ entrypoint: 'cli', requestId: 'r2', messageId: 'm2' }) + '\n');
    const third = await collectInteractiveUsage({ claudeProjectsDir: join(root, 'projects'), watermarkPath });
    assert.equal(third.events.length, 1);
  } finally {
    cleanDir(root);
  }
});

test('collectInteractiveUsage: a trailing partial (unflushed) line is not processed or counted', async () => {
  const root = makeTempDir();
  try {
    const projDir = join(root, 'projects', '-Users-x-Projects-my-app');
    mkdirSync(projDir, { recursive: true });
    const filePath = join(projDir, 'session.jsonl');
    // No trailing newline — simulates a write in progress.
    writeFileSync(filePath, assistantLine({ entrypoint: 'cli' }).slice(0, -5));

    const watermarkPath = join(root, 'watermark.json');
    const result = await collectInteractiveUsage({ claudeProjectsDir: join(root, 'projects'), watermarkPath });
    assert.equal(result.events.length, 0);
  } finally {
    cleanDir(root);
  }
});
