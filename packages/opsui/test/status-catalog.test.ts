// WI-086/WI-087 enforcement tests — status-catalog.ts is the ONE source of truth for what
// a work item's lifecycle status means; deriveItemStatus is the ONE deriver every adapter
// calls instead of re-deriving its own label. These tests pin three properties:
//
//   1. Exhaustiveness — every StatusId has a catalog entry, and every raw fold state this
//      codebase actually produces resolves to SOME entry (never a silent fall-through).
//   2. Cross-projection identity — the SAME fold fixture renders the IDENTICAL badge
//      tone+label on Command, Missions, and the item hub for the SAME item. This is the
//      literal regression test for the reported bug: 'queued — routing…' on Missions vs
//      bare 'queued' on Command for the same item at the same moment.
//   3. A guard against new hardcoded status-label strings creeping back into a projection
//      source file, greping for the vocabulary the catalog now owns.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { STATUS_CATALOG, STATUS_IDS, deriveItemStatus, emphasisForTone, statusBadgeProps } from '../src/states/status-catalog.ts';
import type { StatusId } from '../src/states/status-catalog.ts';
import { OPERATIONAL_STATES } from '../src/states/operational-state.ts';
import { commandProjectionFromFold } from '../src/projections/fold-adapter.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';
import { workProjectionFromFold } from '../src/projections/work-adapter.ts';
import { itemHubProjectionFromInput } from '../src/projections/item-hub-adapter.ts';
import { acceptanceProjectionFromFold } from '../src/projections/acceptance-adapter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 1. Exhaustiveness ─────────────────────────────────────────────────────────

test('every StatusId in the union has exactly one catalog entry, in STATUS_IDS', () => {
  const idsInCatalog = Object.keys(STATUS_CATALOG).sort();
  const idsInList = [...STATUS_IDS].sort();
  assert.deepEqual(idsInList, idsInCatalog, 'STATUS_IDS must list exactly the STATUS_CATALOG keys, no more, no fewer');
  for (const id of STATUS_IDS) {
    const entry = STATUS_CATALOG[id];
    assert.equal(entry.id, id, `catalog entry for '${id}' must self-report the same id`);
    assert.ok(entry.label.length > 0, `'${id}' must have a non-empty label`);
    assert.ok(OPERATIONAL_STATES.includes(entry.tone), `'${id}' tone must be one of the six canonical OperationalState values`);
    assert.ok(['dot', 'diamond', 'star'].includes(entry.icon), `'${id}' icon must be a known marker shape`);
    assert.ok(entry.meaning.length > 0, `'${id}' must have a one-line meaning`);
  }
});

test('every catalog icon agrees with the tone-derived emphasis marker (never drifts apart)', () => {
  const markerForEmphasis: Record<'default' | 'blocking' | 'recommended', 'dot' | 'diamond' | 'star'> = {
    default: 'dot',
    blocking: 'diamond',
    recommended: 'star',
  };
  for (const id of STATUS_IDS) {
    const entry = STATUS_CATALOG[id];
    const expectedIcon = markerForEmphasis[emphasisForTone(entry.tone)];
    assert.equal(entry.icon, expectedIcon, `'${id}' icon (${entry.icon}) must match the marker its tone (${entry.tone}) derives (${expectedIcon})`);
  }
});

// Every raw fold state this codebase is known to produce (core ItemState, plus the
// projection-local synthetic states already in use: testing/blocked/superseded/answered/
// done) must resolve to a real catalog entry, never fall through silently to 'unknown'.
const KNOWN_FOLD_STATES = [
  'captured', 'routed', 'queued', 'building', 'testing', 'gated', 'approved',
  'blocked', 'merged', 'accepted', 'rejected', 'superseded', 'answered', 'done',
];

test('every known raw fold state resolves to a catalog entry other than unknown', () => {
  for (const state of KNOWN_FOLD_STATES) {
    const status = deriveItemStatus({ state, breakerTripped: false, interimApproved: false });
    assert.notEqual(status.id, 'unknown', `raw fold state '${state}' must not fall through to 'unknown'`);
  }
});

test('a parked item resolves by parkKind: decision/hold/decomposition/ops all map to distinct entries', () => {
  assert.equal(deriveItemStatus({ state: 'parked', parkKind: 'decision' }).id, 'parked-decision');
  assert.equal(deriveItemStatus({ state: 'parked', parkKind: 'hold' }).id, 'parked-hold');
  assert.equal(deriveItemStatus({ state: 'parked', parkKind: 'decomposition' }).id, 'parked-decomposition');
  assert.equal(deriveItemStatus({ state: 'parked', parkKind: 'ops', breakerTripped: true }).id, 'parked-ops');
  assert.equal(deriveItemStatus({ state: 'parked', parkKind: 'ops', breakerTripped: false }).id, 'awaiting-retry');
});

test('an unrecognized state resolves to the explicit unknown entry, never a fabricated label', () => {
  const status = deriveItemStatus({ state: 'some-future-state-nobody-wrote-yet' });
  assert.equal(status.id, 'unknown');
  assert.equal(status.label, 'Unknown');
});

// ─── 2. Cross-projection identity ──────────────────────────────────────────────
//
// The literal regression test for the reported bug: build ONE fold fixture, feed it to
// Command, Missions (work), and the item hub, and assert the SAME item renders the
// IDENTICAL badge tone+label on every surface. Timestamps are computed relative to
// Date.now() at test-run time (not a fixed past ISO string) because buildRecentIntents'
// 24h-window filter reads the real wall clock, not the fixture's `generatedAt` — a fixed
// past date silently ages out of the window as real time passes (a pre-existing,
// out-of-scope flake in recent-intents.test.ts; this test avoids inheriting it).

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

function fixtureFold(): FoldSummary {
  return {
    counts: {},
    active: [
      {
        id: 'WI-950',
        state: 'queued',
        spec: 'Interim-approved item awaiting the reactor follow-up',
        lastUnparkedAt: minutesAgo(1),
        parkedAt: minutesAgo(30),
        queuedAt: minutesAgo(1),
      },
    ],
    recentMerged: [],
    generatedAt: new Date().toISOString(),
  };
}

test('an interim-approved queued item (WI-362) renders the IDENTICAL badge on Command and Missions', () => {
  const fold = fixtureFold();

  const commandEnv = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const commandRow = commandEnv.data.recentIntents.find((r) => r.id === 'WI-950');
  assert.ok(commandRow, 'the item must appear on the Command recent-intents strip');

  const workEnv = workProjectionFromFold(fold, { ledgerSequence: 1 });
  const workRow = workEnv.data.active.find((i) => i.id === 'WI-950');
  assert.ok(workRow, 'the item must appear on the Missions board');

  // This is the exact bug report: the same item at the same moment must never read
  // 'queued — routing…' on one surface and bare 'queued' on the other.
  assert.equal(commandRow!.statusLabel, workRow!.stateLabel, 'Command and Missions must render the identical status label for the same item');
  assert.equal(commandRow!.opState, workRow!.operationalState, 'Command and Missions must render the identical tone for the same item');
  assert.equal(workRow!.stateLabel, STATUS_CATALOG['awaiting-dispatch'].label, 'a fresh unpark ahead of parkedAt must resolve to the awaiting-dispatch catalog entry');
});

test('a plain queued item (no interim signal) renders the IDENTICAL badge on Command and Missions', () => {
  const fold: FoldSummary = {
    counts: {},
    active: [{ id: 'WI-951', state: 'queued', spec: 'A plain queued item', queuedAt: minutesAgo(5) }],
    recentMerged: [],
    generatedAt: new Date().toISOString(),
  };

  const commandRow = commandProjectionFromFold(fold, { ledgerSequence: 1 }).data.recentIntents.find((r) => r.id === 'WI-951');
  const workRow = workProjectionFromFold(fold, { ledgerSequence: 1 }).data.active.find((i) => i.id === 'WI-951');
  assert.ok(commandRow && workRow);
  assert.equal(commandRow!.statusLabel, workRow!.stateLabel);
  assert.equal(commandRow!.statusLabel, STATUS_CATALOG.queued.label);
});

test('a decision-parked item renders the IDENTICAL badge tone on Missions and the item hub', () => {
  const fold: FoldSummary = {
    counts: {},
    active: [
      {
        id: 'WI-952',
        state: 'parked',
        parkKind: 'decision',
        parkReason: 'conductor: needs an operator decision on the boundary',
        spec: 'A decision-parked item',
      },
    ],
    recentMerged: [],
    generatedAt: new Date().toISOString(),
  };

  const workRow = workProjectionFromFold(fold, { ledgerSequence: 1 }).data.active.find((i) => i.id === 'WI-952');
  assert.ok(workRow);

  const hubEnv = itemHubProjectionFromInput(fold, {
    itemId: 'WI-952',
    timeline: [],
    artifacts: [],
    artifactsTruncated: false,
    nextPath: '/work',
  }, { ledgerSequence: 1 });

  assert.equal(hubEnv.data.header.operationalState, workRow!.operationalState, 'the item hub and Missions must render the identical tone for the same parked item');
  assert.equal(hubEnv.data.header.stateLabel, STATUS_CATALOG['parked-decision'].label);
  assert.equal(workRow!.operationalState, STATUS_CATALOG['parked-decision'].tone);
});

// A merged item pending acceptance carries a SECOND badge axis — acceptance tier, not
// lifecycle state (every row in this fixture is 'merged') — rendered on both Command's
// delivery stream and the acceptance desk's queue. Before mergedItemBadge (fold-adapter.ts),
// each surface hand-rolled its own tier→label mapping and disagreed for the SAME item at the
// SAME moment (delivery stream: "Delivered — needs your test"; acceptance desk: "Needs your
// test") — the identical drift class WI-086/WI-087 closed for lifecycle-state badges, this
// time on the tier axis. This is the literal regression test for that.
test('a merged review-tier item renders the IDENTICAL badge tone+label on Command and the acceptance desk', () => {
  const fold: FoldSummary = {
    counts: {},
    active: [],
    recentMerged: [
      {
        id: 'WI-953',
        spec: 'A review-tier merged item awaiting a founder verdict',
        tier: 'review',
        accepted: false,
        mergedAt: minutesAgo(10),
      },
    ],
    tierWindows: { optional: 48, review: 168 },
    generatedAt: new Date().toISOString(),
  };

  const commandRow = commandProjectionFromFold(fold, { ledgerSequence: 1 }).data.deliveryStream.find((e) =>
    e.evidence?.href === '/item/WI-953',
  );
  assert.ok(commandRow, 'the item must appear on the Command delivery stream');

  const acceptanceRow = acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }).data.queue.find((i) => i.id === 'WI-953');
  assert.ok(acceptanceRow, 'the item must appear on the acceptance desk queue');

  assert.equal(commandRow!.badge?.label, acceptanceRow!.badge.label, 'Command and the acceptance desk must render the identical badge label for the same merged item');
  assert.equal(commandRow!.badge?.state, acceptanceRow!.badge.state, 'Command and the acceptance desk must render the identical badge tone for the same merged item');
  assert.equal(acceptanceRow!.badge.label, 'Review — auto-accepts in 7d');
});

// ─── 3. Hardcoded-label guard ───────────────────────────────────────────────────
//
// Greps every projection/adapter source for the specific literal strings this catalog now
// owns — a new adapter hand-rolling 'approved' → 'merging', or a bespoke 'X — routing…'
// suffix, is exactly the WI-086 drift class. This is a source-text guard, not a runtime
// behavior test: it fails the build the moment someone reintroduces one of these literals
// outside status-catalog.ts itself.

const PROJECTIONS_DIR = join(__dirname, '..', 'src', 'projections');
const BANNED_LITERALS: RegExp[] = [
  /['"`]\s*—\s*routing…['"`]/u,        // a bespoke "<state> — routing…" suffix built ad hoc
  /['"`]merging['"`]/u,                 // the old approved/gated -> 'merging' hand-roll
  /const\s+\w*FOLD_STATE\w*\s*:/u,      // a reintroduced local lifecycle->tone table, any name
  // (doc comments mentioning a retired name for historical context are fine — only a fresh
  // `const ...FOLD_STATE...` declaration is the actual drift class this guards against. The
  // pattern matches on the FOLD_STATE fragment rather than one exact identifier — thread-
  // detail-projection.ts once slipped past an identifier-exact check by naming its copy
  // `FOLD_STATE_TO_OP` instead of `FOLD_STATE_TO_OPERATIONAL`.)
];

test('no projection/adapter source hand-rolls a status label the catalog now owns', () => {
  const files = readdirSync(PROJECTIONS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(PROJECTIONS_DIR, file), 'utf8');
    for (const pattern of BANNED_LITERALS) {
      if (pattern.test(text)) offenders.push(`${file}: matched ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded status-label literals found outside status-catalog.ts:\n${offenders.join('\n')}`);
});

// ─── statusBadgeProps / emphasisForTone ─────────────────────────────────────────

test('statusBadgeProps derives StatusBadge props from a catalog entry, never a free label', () => {
  const entry = STATUS_CATALOG['parked-decision'];
  const props = statusBadgeProps(entry, { size: 'sm' });
  assert.equal(props.state, entry.tone);
  assert.equal(props.label, entry.label);
  assert.equal(props.emphasis, 'blocking');
  assert.equal(props.size, 'sm');
});

test('emphasisForTone matches the existing never-colour-alone marker rule', () => {
  assert.equal(emphasisForTone('critical'), 'blocking');
  assert.equal(emphasisForTone('warning'), 'recommended');
  for (const tone of ['success', 'progress', 'info', 'neutral'] as const) {
    assert.equal(emphasisForTone(tone), 'default');
  }
});
