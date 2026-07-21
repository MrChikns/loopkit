/**
 * brief.test.ts — deterministic daily ops brief (packages/engine/src/brief.ts): folds ledger
 * events, SLO rows, cost usage, and judge verdicts into a single pulse/quality/spend/attention
 * summary with pass/breach thresholds.
 *
 * Covers:
 *   - green fixture: all SLO met, first-pass above floor, cycle time under target, no alerts
 *   - breach fixture: SLO breach/at-risk, first-pass under floor, cycle time over target,
 *     attention rows over SLA, judge disagreement + breaker trip counted, budget alert fires
 *   - Monday-only routing section: present + rendered when supplied on a Monday `now`,
 *     absent and not rendered on a non-Monday `now` with no routing input
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { foldCosts } from '../src/costs.js';
import { projectVerdicts } from '../src/verdicts.js';
import { SloRow } from '../src/slo.js';
import { computeBrief, renderBriefMarkdown, BriefConfig, RoutingSection } from '../src/brief.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function greenSloRows(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '5s ago', target: '<= 5m', status: 'met' },
    { key: 'deploy', label: 'Deploy freshness', value: 'in sync', target: '<= 1h behind', status: 'met' },
  ];
}

function breachSloRows(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '5s ago', target: '<= 5m', status: 'met' },
    { key: 'unrouted', label: 'Unrouted backlog', value: '3 unrouted', target: 'none > 15m', status: 'breached' },
    { key: 'acceptance', label: 'Acceptance backlog', value: '2 pending', target: 'none > 48h', status: 'at-risk' },
  ];
}

const BASE_CFG: BriefConfig = {
  cycleTimeMedianHours: 24,
  firstPassRate7dFloor: 0.5,
};

const SLA = { decisionMaxHours: 72, acceptanceMaxHours: 48 };

// ---------------------------------------------------------------------------
// Green case
// ---------------------------------------------------------------------------

describe('computeBrief — green fixture', () => {
  // A Wednesday so the Monday-only section never appears.
  const NOW = new Date('2026-07-15T09:00:00.000Z');
  const nowMs = NOW.getTime();

  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-500', 'item.captured', { source: 'cli', text: 'small green fix' }, iso(nowMs, -6 * HOUR)),
    makeEvent('cli', 'WI-500', 'build.dispatched', { attempt: 1 }, iso(nowMs, -5 * HOUR)),
    makeEvent('cli', 'WI-500', 'gate.passed', { tests: 'green' }, iso(nowMs, -2 * HOUR)),
    makeEvent('cli', 'WI-500', 'item.merged', { commit: 'abc123' }, iso(nowMs, -1 * HOUR)),
  ];

  const fr = fold(events);
  const costSummary = foldCosts(events);
  const verdicts = projectVerdicts(events);

  const brief = computeBrief({
    fold: fr,
    events,
    sloRows: greenSloRows(),
    costSummary,
    verdicts,
    cfg: { ...BASE_CFG, dailyTokenBudget: 1_000_000 },
    sla: SLA,
    now: NOW,
  });

  it('classifies cycle time as met (well under the 24h target)', () => {
    assert.equal(brief.pulse.cycleTimeStatus, 'met');
    assert.equal(brief.pulse.cycleTimeSamples, 1);
    assert.ok(brief.pulse.cycleTimeMedianHours! < 24);
  });

  it('counts the 24h pulse (shipped/captured)', () => {
    assert.equal(brief.pulse.shipped, 1);
    assert.equal(brief.pulse.captured, 1);
  });

  it('classifies first-pass rate as met (1/1, above the 0.5 floor)', () => {
    assert.equal(brief.quality.firstPassStatus, 'met');
    assert.equal(brief.quality.firstPassRate, 1);
    assert.equal(brief.quality.repairAttempts, 0);
  });

  it('collapses all-green SLO rows (no breaches)', () => {
    assert.equal(brief.slo.breaches.length, 0);
    assert.equal(brief.slo.greenCount, 2);
  });

  it('does not fire the budget alert', () => {
    assert.equal(brief.spend.budgetAlert, false);
  });

  it('lists the fresh merge as to-accept but not SLA-breached', () => {
    const row = brief.attention.find(a => a.id === 'WI-500');
    assert.ok(row);
    assert.equal(row!.kind, 'to-accept');
    assert.equal(row!.breached, false);
  });

  it('omits the Monday routing section on a Wednesday with no routing input', () => {
    assert.equal(brief.routing, undefined);
    assert.ok(!renderBriefMarkdown(brief).includes('Monday routing calibration'));
  });
});

// ---------------------------------------------------------------------------
// Breach case
// ---------------------------------------------------------------------------

describe('computeBrief — breach fixture', () => {
  const NOW = new Date('2026-07-16T09:00:00.000Z');
  const nowMs = NOW.getTime();

  const events: LedgerEvent[] = [
    // A repaired (attempt=2) merge with a long cycle time — drags first-pass rate and cycle time into breach.
    makeEvent('cli', 'WI-501', 'item.captured', { source: 'cli', text: 'slow repaired slice' }, iso(nowMs, -5 * DAY)),
    makeEvent('cli', 'WI-501', 'build.dispatched', { attempt: 1 }, iso(nowMs, -4 * DAY)),
    makeEvent('cli', 'WI-501', 'gate.failed', { reason: 'tests red' }, iso(nowMs, -3 * DAY)),
    makeEvent('cli', 'WI-501', 'build.dispatched', { attempt: 2 }, iso(nowMs, -2 * DAY)),
    makeEvent('cli', 'WI-501', 'gate.passed', { tests: 'green' }, iso(nowMs, -1 * DAY)),
    makeEvent('cli', 'WI-501', 'item.merged', { commit: 'def456' }, iso(nowMs, -12 * HOUR)),

    // A judge-fail that was accepted anyway → judge disagreement (false alarm), inside the 7d window.
    makeEvent('cli', 'WI-502', 'item.captured', { source: 'cli', text: 'judged fail but accepted' }, iso(nowMs, -3 * DAY)),
    makeEvent('cli', 'WI-502', 'review.verdict', {
      verdict: 'fail', confidence: 0.9, specSatisfied: 'no', scopeCreep: 'major', testTheatre: 'none',
      reasons: ['scope creep'], model: 'sonnet', judge: 'merge-review',
    }, iso(nowMs, -2 * DAY)),
    // No item.merged here deliberately — projectVerdicts' outcome classification only needs
    // item.accepted, and keeping WI-502 out of `fold`'s mergedAt bookkeeping avoids contaminating
    // the 7d first-pass-rate sample (see WI-501, the only merge in this fixture's window).
    makeEvent('cli', 'WI-502', 'item.accepted', { by: 'operator' }, iso(nowMs, -1 * DAY)),

    // A breaker trip (3 attempts exhausted) inside the 7d window.
    makeEvent('cli', 'WI-503', 'item.captured', { source: 'cli', text: 'breaker tripped' }, iso(nowMs, -2 * DAY)),
    makeEvent('cli', 'WI-503', 'item.parked', { reason: 'breaker: 3 attempts exhausted', parkKind: 'ops' }, iso(nowMs, -1 * DAY)),

    // An operator decision park well past the 72h SLA.
    makeEvent('cli', 'WI-504', 'item.captured', { source: 'cli', text: 'needs an operator decision' }, iso(nowMs, -6 * DAY)),
    makeEvent('cli', 'WI-504', 'item.parked', { reason: 'spine touch', parkKind: 'decision' }, iso(nowMs, -5 * DAY)),

    // A merged-but-unaccepted item well past the 48h acceptance SLA — merged outside the 7d
    // quality window (deliberately) so it doesn't contaminate the first-pass-rate sample above.
    makeEvent('cli', 'WI-505', 'item.captured', { source: 'cli', text: 'waiting on acceptance' }, iso(nowMs, -10 * DAY)),
    makeEvent('cli', 'WI-505', 'item.merged', { commit: 'jkl012' }, iso(nowMs, -8 * DAY)),

    // Today's cost.usage spend, deliberately over 80% of a small daily budget.
    makeEvent('cli', 'WI-501', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 900, usd: 0.05 }, iso(nowMs, -1 * HOUR)),
  ];

  const fr = fold(events);
  const costSummary = foldCosts(events);
  const verdicts = projectVerdicts(events);

  const brief = computeBrief({
    fold: fr,
    events,
    sloRows: breachSloRows(),
    costSummary,
    verdicts,
    cfg: { ...BASE_CFG, dailyTokenBudget: 1000 },
    sla: SLA,
    now: NOW,
  });

  it('classifies cycle time as breached (WI-501 spans 5 days, target 24h)', () => {
    assert.equal(brief.pulse.cycleTimeStatus, 'breached');
  });

  it('classifies first-pass rate as breached (0/1 attempt-1 merges within 7d, floor 0.5)', () => {
    assert.equal(brief.quality.firstPassStatus, 'breached');
    assert.equal(brief.quality.firstPassRate, 0);
    assert.equal(brief.quality.repairAttempts, 1);
  });

  it('surfaces breached/at-risk SLO rows only, green collapsed to a count', () => {
    assert.equal(brief.slo.breaches.length, 2);
    assert.ok(brief.slo.breaches.some(r => r.key === 'unrouted' && r.status === 'breached'));
    assert.ok(brief.slo.breaches.some(r => r.key === 'acceptance' && r.status === 'at-risk'));
    assert.equal(brief.slo.greenCount, 1);
  });

  it('counts the judge disagreement and breaker trip in the 7d quality window', () => {
    assert.equal(brief.quality.judgeDisagreements, 1);
    assert.equal(brief.quality.breakerTrips, 1);
  });

  it('flags the operator-decision park and the stale to-accept item as over SLA', () => {
    const parked = brief.attention.find(a => a.id === 'WI-504');
    const toAccept = brief.attention.find(a => a.id === 'WI-505');
    assert.ok(parked);
    assert.equal(parked!.kind, 'parked');
    assert.equal(parked!.breached, true);
    assert.ok(toAccept);
    assert.equal(toAccept!.kind, 'to-accept');
    assert.equal(toAccept!.breached, true);
  });

  it('excludes ops-kind parks from attention (only decision parks reach the desk)', () => {
    assert.ok(!brief.attention.some(a => a.id === 'WI-503'));
  });

  it('fires the 80%-of-daily-budget spend alert', () => {
    assert.equal(brief.spend.budgetAlert, true);
    assert.ok(brief.spend.todayTokens >= 800);
  });

  it('renders the breach markers in markdown', () => {
    const md = renderBriefMarkdown(brief);
    assert.match(md, /Needs you/);
    assert.match(md, /OVER SLA/);
    assert.match(md, /\[XX\] unrouted/);
  });
});

// ---------------------------------------------------------------------------
// Monday-only routing section
// ---------------------------------------------------------------------------

describe('computeBrief — Monday routing section', () => {
  const MONDAY = new Date('2026-07-13T08:00:00.000Z'); // a Monday (UTC)
  const routing: RoutingSection = {
    windowDays: 30,
    table: {
      small: { sonnet: { samples: 12, firstPassRate: 0.75, avgUsd: 0.12 } },
      medium: {},
      large: {},
    },
  };

  const emptyFold = fold([]);
  const emptyCosts = foldCosts([]);
  const emptyVerdicts = projectVerdicts([]);

  it('includes the routing section when supplied on a Monday', () => {
    const brief = computeBrief({
      fold: emptyFold,
      events: [],
      sloRows: greenSloRows(),
      costSummary: emptyCosts,
      verdicts: emptyVerdicts,
      cfg: BASE_CFG,
      sla: SLA,
      now: MONDAY,
      routing,
    });
    assert.equal(brief.isMonday, true);
    assert.ok(brief.routing);
    assert.equal(brief.routing!.table.small['sonnet']?.samples, 12);
    const md = renderBriefMarkdown(brief);
    assert.match(md, /Monday routing calibration/);
    assert.match(md, /small\/sonnet/);
  });

  it('is a no-op on a non-Monday with no routing input', () => {
    const WEDNESDAY = new Date('2026-07-15T08:00:00.000Z');
    const brief = computeBrief({
      fold: emptyFold,
      events: [],
      sloRows: greenSloRows(),
      costSummary: emptyCosts,
      verdicts: emptyVerdicts,
      cfg: BASE_CFG,
      sla: SLA,
      now: WEDNESDAY,
    });
    assert.equal(brief.isMonday, false);
    assert.equal(brief.routing, undefined);
    assert.ok(!renderBriefMarkdown(brief).includes('Monday routing calibration'));
  });
});
