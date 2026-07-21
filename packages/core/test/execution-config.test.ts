/**
 * execution-config.test.ts — Tests for projectExecutionConfig (execution-config-by-model
 * aggregation, consumed by a console's "Execution config" region).
 *
 * Covers:
 *   - accept rate, first-pass gate rate, cost-per-accept, retries-per-accept computation
 *   - n (sample size) always present
 *   - insufficient-data path (n < minSamples still returns raw counts, no fabricated ratios)
 *   - items with no model attribution are excluded entirely
 *   - empty ledger → empty cells, valid structure
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { projectExecutionConfig } from '../src/executionConfig.js';

const NOW = '2026-07-16T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const HOUR_MS = 60 * 60 * 1000;

function ts(hoursAgo: number): string {
  return new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString();
}

/** Build a full item lifecycle: dispatched(attempt 1, model) → gate.passed → item.merged
 *  → optionally item.accepted, with an optional cost.usage event. */
function mergedItem(opts: {
  wi: string;
  model: string;
  hoursAgo: number;
  accepted?: boolean;
  usd?: number;
  extraAttempts?: number; // additional dispatched attempts before the final merge (retries)
}): LedgerEvent[] {
  const { wi, model, hoursAgo, accepted, usd, extraAttempts = 0 } = opts;
  const events: LedgerEvent[] = [];
  let t = hoursAgo;

  // Repair attempts (crash then re-dispatch) before the eventual success, if any.
  for (let i = 0; i < extraAttempts; i++) {
    events.push(makeEvent('dispatch', wi, 'build.dispatched', { attempt: i + 1, model }, ts(t)));
    t -= 0.1;
    events.push(makeEvent('dispatch', wi, 'build.crashed', { reason: 'boom' }, ts(t)));
    t -= 0.1;
  }

  const finalAttempt = extraAttempts + 1;
  events.push(makeEvent('dispatch', wi, 'build.dispatched', { attempt: finalAttempt, model }, ts(t)));
  t -= 0.1;
  if (usd !== undefined) {
    events.push(makeEvent('dispatch', wi, 'cost.usage', { provider: 'anthropic', loop: 'dispatch', tokens: 1000, usd, wi }, ts(t)));
  }
  events.push(makeEvent('dispatch', wi, 'gate.passed', { tests: 'green' }, ts(t)));
  t -= 0.1;
  events.push(makeEvent('reactor', wi, 'item.merged', { commit: 'abc123' }, ts(t)));
  t -= 0.1;
  if (accepted) {
    events.push(makeEvent('cli', wi, 'item.accepted', { by: 'operator' }, ts(t)));
  }
  return events;
}

/** A single attempt-1 dispatch that ends in gate.failed (not merged, still reached the gate). */
function gateFailedItem(wi: string, model: string, hoursAgo: number): LedgerEvent[] {
  return [
    makeEvent('dispatch', wi, 'build.dispatched', { attempt: 1, model }, ts(hoursAgo)),
    makeEvent('dispatch', wi, 'gate.failed', { reason: 'tests red' }, ts(hoursAgo - 0.1)),
  ];
}

describe('projectExecutionConfig — empty ledger', () => {
  it('returns valid empty structure', () => {
    const result = projectExecutionConfig([], { now: NOW });
    assert.deepEqual(result.cells, []);
    assert.equal(result.minSamples, 5);
  });
});

describe('projectExecutionConfig — model with enough accepts (n >= minSamples)', () => {
  it('computes accept rate, first-pass gate rate, cost-per-accept, retries-per-accept', () => {
    const events: LedgerEvent[] = [];
    // 5 items on 'sonnet': 4 accepted first-pass, 1 merged-but-not-accepted, 1 gate-failed (not merged).
    for (let i = 0; i < 4; i++) {
      events.push(...mergedItem({ wi: `WI-10${i}`, model: 'sonnet', hoursAgo: 10, accepted: true, usd: 0.5 }));
    }
    events.push(...mergedItem({ wi: 'WI-105', model: 'sonnet', hoursAgo: 10, accepted: false, usd: 0.4 }));
    events.push(...gateFailedItem('WI-106', 'sonnet', 10));

    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    const cell = result.cells.find((c) => c.model === 'sonnet');
    assert.ok(cell, 'sonnet cell present');
    assert.equal(cell!.n, 6); // 6 distinct items attributed to sonnet
    assert.equal(cell!.merged, 5);
    assert.equal(cell!.accepted, 4);
    assert.equal(cell!.gated, 6); // all 6 reached a gate (5 merged + 1 gate-failed)
    assert.equal(cell!.gatedFirstPass, 5); // all 5 merges were first-pass (attempt 1)
    assert.ok(Math.abs(cell!.acceptRate! - 4 / 5) < 1e-9);
    assert.ok(Math.abs(cell!.firstPassGateRate! - 5 / 6) < 1e-9);
    // cost-per-accept: total usd across ALL 6 items' builds / 4 accepted
    // 4*0.5 + 0.4 + 0 (gate-failed has no cost.usage) = 2.4 / 4 = 0.6
    assert.ok(Math.abs(cell!.costPerAcceptedUsd! - 0.6) < 1e-9);
    // retries-per-accept: all items are single-attempt (0 retries each) / 4 accepted = 0
    assert.equal(cell!.retriesPerAccept, 0);
  });

  it('counts retries (attempts - 1) correctly for repaired items', () => {
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(...mergedItem({ wi: `WI-20${i}`, model: 'opus', hoursAgo: 5, accepted: true, extraAttempts: 1 }));
    }
    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    const cell = result.cells.find((c) => c.model === 'opus');
    assert.ok(cell);
    assert.equal(cell!.n, 5);
    assert.equal(cell!.accepted, 5);
    // Each item had 2 attempts (1 crash + 1 success) → 1 retry each → 5 total / 5 accepted = 1
    assert.equal(cell!.retriesPerAccept, 1);
    // First-pass gate rate: attempt-1 for each item crashed (never reached the gate on
    // attempt 1), but the item DID eventually reach the gate on attempt 2 — attempt1
    // outcome is 'crashed', so gatedFirstPass stays 0 while gated counts the eventual merge.
    assert.equal(cell!.gated, 5);
    assert.equal(cell!.gatedFirstPass, 0);
    assert.equal(cell!.firstPassGateRate, 0);
  });
});

describe('projectExecutionConfig — insufficient data (n < minSamples)', () => {
  it('still returns raw counts and computed ratios, but n signals the caller to gate on it', () => {
    const events = [
      ...mergedItem({ wi: 'WI-300', model: 'haiku', hoursAgo: 5, accepted: true, usd: 0.1 }),
      ...mergedItem({ wi: 'WI-301', model: 'haiku', hoursAgo: 5, accepted: false, usd: 0.1 }),
    ];
    const result = projectExecutionConfig(events, { now: NOW, days: 30, minSamples: 5 });
    const cell = result.cells.find((c) => c.model === 'haiku');
    assert.ok(cell);
    assert.equal(cell!.n, 2);
    assert.ok(cell!.n < result.minSamples, 'below the configured floor — caller must render insufficient-data');
    // The module itself does NOT suppress the ratio (that is a rendering decision) —
    // it always reports the raw counts so the consumer can decide; but the ratio must
    // still be mathematically honest (not NaN/fabricated).
    assert.ok(Math.abs(cell!.acceptRate! - 0.5) < 1e-9);
  });
});

describe('projectExecutionConfig — model attribution', () => {
  it('excludes items whose attempt-1 has no model field', () => {
    const events: LedgerEvent[] = [
      makeEvent('dispatch', 'WI-400', 'build.dispatched', { attempt: 1 }, ts(5)), // no model
      makeEvent('dispatch', 'WI-400', 'gate.passed', { tests: 'green' }, ts(4.9)),
      makeEvent('reactor', 'WI-400', 'item.merged', { commit: 'x' }, ts(4.8)),
    ];
    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    assert.equal(result.cells.length, 0);
  });

  it('attributes the whole item to the attempt-1 model even if a repair attempt used a different model', () => {
    const events: LedgerEvent[] = [
      makeEvent('dispatch', 'WI-401', 'build.dispatched', { attempt: 1, model: 'haiku' }, ts(5)),
      makeEvent('dispatch', 'WI-401', 'build.crashed', { reason: 'boom' }, ts(4.9)),
      makeEvent('dispatch', 'WI-401', 'build.dispatched', { attempt: 2, model: 'sonnet' }, ts(4.8)),
      makeEvent('dispatch', 'WI-401', 'gate.passed', { tests: 'green' }, ts(4.7)),
      makeEvent('reactor', 'WI-401', 'item.merged', { commit: 'x' }, ts(4.6)),
    ];
    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    assert.equal(result.cells.length, 1);
    assert.equal(result.cells[0]!.model, 'haiku');
    assert.equal(result.cells[0]!.n, 1);
  });

  it('separates cells per model and sorts by n desc then model asc', () => {
    const events: LedgerEvent[] = [
      ...mergedItem({ wi: 'WI-500', model: 'zzz-model', hoursAgo: 3, accepted: true }),
      ...mergedItem({ wi: 'WI-501', model: 'aaa-model', hoursAgo: 3, accepted: true }),
      ...mergedItem({ wi: 'WI-502', model: 'aaa-model', hoursAgo: 3, accepted: true }),
    ];
    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    assert.equal(result.cells.length, 2);
    assert.equal(result.cells[0]!.model, 'aaa-model'); // n=2, higher n first
    assert.equal(result.cells[0]!.n, 2);
    assert.equal(result.cells[1]!.model, 'zzz-model');
    assert.equal(result.cells[1]!.n, 1);
  });
});

describe('projectExecutionConfig — undefined ratios when denominator is 0', () => {
  it('acceptRate undefined when merged=0 (never reached merge)', () => {
    const events = gateFailedItem('WI-600', 'sonnet', 3);
    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    const cell = result.cells.find((c) => c.model === 'sonnet');
    assert.ok(cell);
    assert.equal(cell!.merged, 0);
    assert.equal(cell!.acceptRate, undefined);
    assert.equal(cell!.gated, 1);
    assert.ok(cell!.firstPassGateRate !== undefined); // gated>0 so this IS computed (0, since gate failed)
    assert.equal(cell!.firstPassGateRate, 0);
  });

  it('costPerAcceptedUsd and retriesPerAccept undefined when accepted=0', () => {
    const events = mergedItem({ wi: 'WI-601', model: 'sonnet', hoursAgo: 3, accepted: false, usd: 1.0 });
    const result = projectExecutionConfig(events, { now: NOW, days: 30 });
    const cell = result.cells.find((c) => c.model === 'sonnet');
    assert.ok(cell);
    assert.equal(cell!.accepted, 0);
    assert.equal(cell!.costPerAcceptedUsd, undefined);
    assert.equal(cell!.retriesPerAccept, undefined);
  });
});
