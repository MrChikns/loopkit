/**
 * approval.test.ts — delegated approval boundary classifier: decides whether a build that
 * parked (touches-overstep or spine) can be auto-approved and merged without waiting on the
 * operator, or must stay parked for a human decision.
 *
 * Covers:
 *   - touches-overstep, same-origin (companion + same-top-dir) → auto-approve
 *   - touches-overstep, off-origin file → parks
 *   - spine, plane-only → auto-approve
 *   - spine, product spine file → parks
 *   - escalation list (contracts / money) → ALWAYS parks, both classes
 *   - disabled config → never auto-approves
 *   - unparseable / non-delegated class → parks
 *   - governance-critical classifier files → never auto-approve
 *   - plane-owned docs → auto-approve; dependency-wait stored-spec approval
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyParkForAutoApprove,
  parseOverstepReason,
  parseSpineReason,
  isPlaneOwnedDoc,
  AutoApproveConfig,
  parseDependencyReason,
  checkDependencyState,
  resolveStoredSpecApproval,
} from '../src/approval.js';

const CFG: AutoApproveConfig = {
  enabled: true,
  planePrefixes: ['packages/engine/', '.ai/', 'apps/example/src/seed/', 'packages/ui/'],
  companionSegments: ['projections/', 'components/', 'styles/', 'test/', 'tests/', '__tests__/', 'apps/example/src/seed/'],
  escalationPatterns: [
    'eventContracts', 'contracts/', 'authorization', '/migrations/',
    'billing', 'payment', 'paddle', 'money', 'publish', 'external',
  ],
  docCompanionGlobs: ['README.md', '**/README.md', 'CHANGELOG.md', 'docs/**'],
  operativeDocs: ['docs/decisions/decision_log.md'],
  governanceCriticalPaths: ['packages/engine/src/approval.ts', 'packages/engine/src/acceptance.ts', 'packages/engine/src/armed.ts'],
};

// Reason strings exactly as beats/dispatch.ts emits them.
const overstep = (declared: string, files: string[]) =>
  `needs-decision: files outside declared Touches (${declared}): ${files.join(', ')}`;
const spine = (files: string[]) =>
  `needs-decision: touches spine (${files.join(', ')}) — approve to merge`;

// --- parsers -------------------------------------------------------------

test('parseOverstepReason: extracts declared + files', () => {
  const r = parseOverstepReason(overstep('packages/ui/src/', ['packages/ui/src/foo.ts', 'packages/ui/test/foo.test.ts']));
  assert.ok(r);
  assert.deepEqual(r!.declared, ['packages/ui/src/']);
  assert.deepEqual(r!.files, ['packages/ui/src/foo.ts', 'packages/ui/test/foo.test.ts']);
});

test('parseSpineReason: extracts files', () => {
  const r = parseSpineReason(spine(['packages/engine/src/fold.ts']));
  assert.ok(r);
  assert.deepEqual(r!.files, ['packages/engine/src/fold.ts']);
});

test('parseOverstepReason: returns null on non-matching string', () => {
  assert.equal(parseOverstepReason('tests-red: something'), null);
});

// --- touches-overstep ----------------------------------------------------

test('touches-overstep: same top-level dir as declared → auto-approve', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/ui/src/', ['packages/ui/src/projections/board.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.equal(d.parkClass, 'touches-overstep');
});

test('touches-overstep: companion segment beside declared scope → auto-approve', () => {
  const item = {
    parkClass: 'touches-overstep',
    // declared a slice src dir; the write added a sibling test/ + components/ file
    parkReason: overstep('apps/example/src/features/board/', [
      'apps/example/src/features/board/components/DayCell.ts',
      'apps/example/test/board.test.ts',
    ]),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
});

test('touches-overstep: ui projection change overstepping into its seed caller → auto-approve', () => {
  // The command projection lives in packages/ui/; deleting a prop from it necessarily
  // updates the caller in apps/example/src/seed/console.ts. That coupled edit repeatedly
  // parked for a human decision before apps/example/src/seed/ became a companion segment.
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/ui/src/', ['apps/example/src/seed/console.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.equal(d.parkClass, 'touches-overstep');
});

test('touches-overstep: an off-origin file → parks', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/ui/src/', [
      'packages/ui/src/projections/board.ts',
      'apps/example/src/platform/kernel.ts', // different top dir, no companion segment
    ]),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

// --- Narrative-doc companion waiver (touches-overstep) --------------------

test('touches-overstep: doc-only overstep (README + roadmap, off-origin) → auto-approve with waived-files trail', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', 'docs/roadmap.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.equal(d.parkClass, 'touches-overstep');
  assert.match(d.reason, /narrative-doc companion/);
  assert.match(d.reason, /README\.md/);
  assert.match(d.reason, /docs\/roadmap\.md/);
});

test('touches-overstep: doc + config in the same overstep → parks (conjunction, no partial waiver)', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', 'loopkit.config.json']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: operative markdown (.ai/**) among otherwise-doc files → parks', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', '.ai/notes.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: config-only overstep → parks (not a doc companion)', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['loopkit.config.json']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: escalation-pattern file among doc files → parks (escalation still wins)', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', 'docs/product/billing.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /escalation/);
});

// --- spine ---------------------------------------------------------------

test('spine: all plane files → auto-approve', () => {
  const item = {
    parkClass: 'spine',
    parkReason: spine(['packages/engine/src/fold.ts', '.ai/loops/config.env']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.equal(d.parkClass, 'spine');
});

test('spine: a product spine file among plane files → parks', () => {
  const item = {
    parkClass: 'spine',
    parkReason: spine(['packages/engine/src/fold.ts', 'apps/example/src/app.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /product spine/);
});

// --- escalation list (always parks) --------------------------------------

test('escalation: a contracts file in an otherwise same-origin overstep → parks', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('apps/example/src/features/board/', [
      'apps/example/src/features/board/contracts/boardEvents.ts',
    ]),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /escalation/);
});

test('escalation: a money/billing file in a plane-only-looking spine → parks', () => {
  const item = {
    parkClass: 'spine',
    parkReason: spine(['packages/engine/src/billing.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /escalation/);
});

// --- guards --------------------------------------------------------------

test('disabled config: never auto-approves', () => {
  const item = { parkClass: 'spine', parkReason: spine(['packages/engine/src/fold.ts']) };
  const d = classifyParkForAutoApprove(item, { ...CFG, enabled: false });
  assert.equal(d.autoApprove, false);
});

test('non-delegated park class → parks', () => {
  const item = { parkClass: 'tests-red', parkReason: 'tests-red: boom' };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
});

test('unparseable reason for a delegated class → parks', () => {
  const item = { parkClass: 'spine', parkReason: 'garbage with no file list' };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
});

// --- governance-critical classifiers (never auto-approve) -----------------

test('governance: a change to approval.ts spine-parks and is NOT auto-approved', () => {
  // approval.ts is now in spineRegex, so a change to it produces a spine park. Even though
  // packages/engine/ is a planePrefix (would normally plane-only-auto-approve), the governance
  // guard runs first and keeps it for the operator.
  const item = {
    parkClass: 'spine',
    parkReason: spine(['packages/engine/src/approval.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /governance/);
});

test('governance regression: a normal plane spine file (schema.ts) still auto-approves', () => {
  const item = {
    parkClass: 'spine',
    parkReason: spine(['packages/engine/src/schema.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.equal(d.parkClass, 'spine');
});

test('governance: guard is class-independent — an acceptance.ts overstep also parks', () => {
  // The guard runs before the per-class rules, so a governance-critical file blocks auto-
  // approval whether it arrives as a spine or a touches-overstep park. The operator's explicit
  // approve verb still merges it: that routes through stepApplyVerbs on state === 'approved',
  // which never calls classifyParkForAutoApprove (verified in beats/reactor.ts).
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['packages/engine/src/acceptance.ts']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /governance/);
});

// --- Plane-owned doc (.ai/loops/**) auto-approve --------------------------

test('isPlaneOwnedDoc: true for .ai/loops/** paths, false for other .ai/** and docs/decisions/**', () => {
  assert.equal(isPlaneOwnedDoc('.ai/loops/prompts/conductor.md'), true);
  assert.equal(isPlaneOwnedDoc('.ai/loops/config.env'), true);
  assert.equal(isPlaneOwnedDoc('some/prefix/.ai/loops/config.env'), true);
  assert.equal(isPlaneOwnedDoc('.ai/notes.md'), false);
  assert.equal(isPlaneOwnedDoc('docs/decisions/decision_log.md'), false);
});

test('touches-overstep: .ai/loops/** prompt/config overstep → auto-approves with the plane-owned trail', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['.ai/loops/prompts/conductor.md', '.ai/loops/config.env']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.equal(d.parkClass, 'touches-overstep');
  assert.match(d.reason, /plane-owned prompt\/config/);
  assert.match(d.reason, /plane-owned/);
  assert.match(d.reason, /\.ai\/loops\/prompts\/conductor\.md/);
});

test('touches-overstep: .ai/loops/** mixed with a non-plane-owned doc → still auto-approves via the narrative-doc reason (not the plane-owned one)', () => {
  // README.md is a doc companion and .ai/loops/config.env is plane-owned — both are doc
  // companions, so the conjunction still auto-approves, but since not EVERY file is
  // plane-owned, it falls through to the shared narrative-doc reason rather than the plane-owned one.
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', '.ai/loops/config.env']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, true);
  assert.match(d.reason, /narrative-doc companion/);
});

test('touches-overstep: an operativeDocs path among overstep files → still parks (operator-decision surface), even though it matches a docs/** companion glob', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', 'docs/decisions/decision_log.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: CLAUDE.md among overstep files → still parks', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', 'CLAUDE.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: AGENTS.md among overstep files → still parks', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', 'AGENTS.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: non-loops .ai/** file (.ai/notes.md) among overstep files → still parks', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['README.md', '.ai/notes.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /off-origin/);
});

test('touches-overstep: escalation-pattern file among .ai/loops/** files → parks (escalation still wins)', () => {
  const item = {
    parkClass: 'touches-overstep',
    parkReason: overstep('packages/engine/src/', ['.ai/loops/config.env', 'docs/product/billing.md']),
  };
  const d = classifyParkForAutoApprove(item, CFG);
  assert.equal(d.autoApprove, false);
  assert.match(d.reason, /escalation/);
});

// ---------------------------------------------------------------------------
// dependency-wait stored-spec approval
// ---------------------------------------------------------------------------

test('parseDependencyReason: extracts a "depends on WI-NNN" reference', () => {
  const d = parseDependencyReason('WI-360 explicitly depends on WI-359, which has not merged yet.');
  assert.deepEqual(d, { depId: 'WI-359' });
});

test('parseDependencyReason: extracts "blocked on"/"blocking on" phrasing, case-insensitively', () => {
  assert.deepEqual(parseDependencyReason('blocked on wi-100 finishing first'), { depId: 'WI-100' });
  assert.deepEqual(parseDependencyReason('This item is BLOCKING ON WI-7 merging.'), { depId: 'WI-7' });
});

test('parseDependencyReason: no dependency phrasing → null (never guesses)', () => {
  assert.equal(parseDependencyReason('needs decision: hosted PG is costly and irreversible'), null);
});

test('checkDependencyState: merged/accepted/done → resolved; other states → unresolved; missing → unknown', () => {
  const items = new Map([
    ['WI-359', { state: 'merged' }],
    ['WI-358', { state: 'accepted' }],
    ['WI-357', { state: 'done' }],
    ['WI-356', { state: 'building' }],
  ]);
  assert.equal(checkDependencyState('WI-359', items), 'resolved');
  assert.equal(checkDependencyState('WI-358', items), 'resolved');
  assert.equal(checkDependencyState('WI-357', items), 'resolved');
  assert.equal(checkDependencyState('WI-356', items), 'unresolved');
  assert.equal(checkDependencyState('WI-999', items), 'unknown');
});

test('resolveStoredSpecApproval: no storedSpec → no-stored-spec (fall back to LLM routing)', () => {
  const item = { parkReason: 'needs decision: pick an approach', storedSpec: undefined };
  const r = resolveStoredSpecApproval(item, new Map());
  assert.deepEqual(r, { kind: 'no-stored-spec' });
});

test('resolveStoredSpecApproval: storedSpec present but reason names no dependency → unparseable-dependency', () => {
  const item = { parkReason: 'needs decision: pick an approach', storedSpec: 'Build the thing.' };
  const r = resolveStoredSpecApproval(item, new Map());
  assert.deepEqual(r, { kind: 'unparseable-dependency' });
});

test('resolveStoredSpecApproval: dependency not yet merged → unresolved (never build ahead of it)', () => {
  const item = {
    parkReason: 'WI-360 explicitly depends on WI-359, which has not merged yet.',
    storedSpec: 'Extend the fold to a 30d horizon.',
  };
  const items = new Map([['WI-359', { state: 'building' }]]);
  const r = resolveStoredSpecApproval(item, items);
  assert.deepEqual(r, { kind: 'unresolved', depId: 'WI-359' });
});

test('resolveStoredSpecApproval: dependency merged → resolved, carries the stored spec verbatim', () => {
  const item = {
    parkReason: 'WI-360 explicitly depends on WI-359, which has not merged yet.',
    storedSpec: 'Extend the fold to a 30d horizon.',
  };
  const items = new Map([['WI-359', { state: 'merged' }]]);
  const r = resolveStoredSpecApproval(item, items);
  assert.deepEqual(r, { kind: 'resolved', depId: 'WI-359', spec: 'Extend the fold to a 30d horizon.' });
});
