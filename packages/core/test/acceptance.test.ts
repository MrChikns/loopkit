/**
 * acceptance.test.ts — acceptance tiering (classifyAcceptanceTier, splitTouches): classifies a
 * finished build into auto/optional/review/must based on which declared surface/plane/risk
 * prefixes its touched files fall under, a judge verdict, and an overseer confidence overlay
 * that can only ever hold or escalate a tier, never downgrade one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAcceptanceTier,
  splitTouches,
  overseerFloor,
  runClaimAuditGate,
  DEFAULT_CONFIDENCE_FLOOR,
  AcceptanceTierClassifyConfig,
} from '../src/acceptance.js';

const CFG: AcceptanceTierClassifyConfig = {
  surfacePrefixes: ['apps/example/src/public/', 'apps/example/src/features/'],
  planePrefixes: ['packages/engine/', '.ai/', 'apps/example/src/seed/', 'packages/ui/'],
  riskPatterns: [
    'eventContracts', 'contracts/', 'authorization', '/migrations/',
    'billing', 'payment', 'paddle', 'money', 'publish', 'external',
  ],
};

// ---------------------------------------------------------------------------
// splitTouches
// ---------------------------------------------------------------------------

test('splitTouches: comma-joined with spaces and trailing comma', () => {
  assert.deepEqual(splitTouches('a,b, c ,'), ['a', 'b', 'c']);
});

test('splitTouches: empty string → []', () => {
  assert.deepEqual(splitTouches(''), []);
});

test('splitTouches: undefined → []', () => {
  assert.deepEqual(splitTouches(undefined), []);
});

// ---------------------------------------------------------------------------
// classifyAcceptanceTier
// ---------------------------------------------------------------------------

test('classifyAcceptanceTier: judge fail → must, even for plane files', () => {
  const result = classifyAcceptanceTier(
    ['packages/engine/src/foo.ts'],
    { verdict: 'fail' },
    CFG,
  );
  assert.equal(result.tier, 'must');
  assert.match(result.reason, /judge verdict = fail/);
});

test('classifyAcceptanceTier: no files (question/feedback) → auto', () => {
  const result = classifyAcceptanceTier([], { verdict: 'pass' }, CFG);
  assert.equal(result.tier, 'auto');
  assert.match(result.reason, /no code changed/);
});

test('classifyAcceptanceTier: no files, no judge verdict → auto', () => {
  const result = classifyAcceptanceTier([], undefined, CFG);
  assert.equal(result.tier, 'auto');
});

test('classifyAcceptanceTier: risk file (authorization) → must', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/features/access/authorization.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'must');
  assert.match(result.reason, /risk-flagged/);
});

test('classifyAcceptanceTier: risk file (/migrations/) → must', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/db/migrations/0099_add_col.sql'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'must');
});

test('classifyAcceptanceTier: risk file (billing) → must', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/features/billing/plan.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'must');
});

test('classifyAcceptanceTier: user-facing slice screen.ts → review', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/features/board/screen.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'review');
  assert.match(result.reason, /user-facing surface/);
});

test('classifyAcceptanceTier: public/boot.js → review', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/public/boot.js'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'review');
});

test('classifyAcceptanceTier: plane-only files (engine + .ai + ui) → auto', () => {
  const result = classifyAcceptanceTier(
    ['packages/engine/src/x.ts', '.ai/foo.md', 'packages/ui/src/y.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'auto');
  assert.match(result.reason, /ops-plane internals/);
});

test('classifyAcceptanceTier: non-surface, non-plane product file (app.ts) → optional', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/app.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'optional');
  assert.match(result.reason, /non-surface change/);
});

test('classifyAcceptanceTier: mixed plane + surface → review (surface wins)', () => {
  const result = classifyAcceptanceTier(
    ['packages/engine/src/foo.ts', 'apps/example/src/features/board/screen.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'review');
});

test('classifyAcceptanceTier: path in BOTH plane and surface → review (surface wins over merge-trust)', () => {
  // Orthogonal axes: a path may be plane-trusted (auto-merge) AND a declared surface (surface for
  // test) at once — e.g. an ops console a fork actively develops. Surface must win for tiering.
  const cfg: AcceptanceTierClassifyConfig = {
    ...CFG,
    surfacePrefixes: [...CFG.surfacePrefixes, 'packages/ui/'],
  };
  const result = classifyAcceptanceTier(['packages/ui/src/projections/glance.ts'], { verdict: 'pass' }, cfg);
  assert.equal(result.tier, 'review');
  assert.match(result.reason, /user-facing surface/);
});

test('classifyAcceptanceTier: mixed plane + optional-product → optional (no surface hit)', () => {
  const result = classifyAcceptanceTier(
    ['packages/engine/src/foo.ts', 'apps/example/src/app.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'optional');
});

test('classifyAcceptanceTier: risk pattern wins over surface (risk checked first)', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/features/board/screen.ts', 'apps/example/src/features/billing/plan.ts'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'must');
});

test('classifyAcceptanceTier: no judgeVerdict at all (absent) does not force must', () => {
  const result = classifyAcceptanceTier(
    ['packages/engine/src/foo.ts'],
    undefined,
    CFG,
  );
  assert.equal(result.tier, 'auto');
});

test('classifyAcceptanceTier: judge pass with surface file → review (judge pass does not downgrade)', () => {
  const result = classifyAcceptanceTier(
    ['apps/example/src/public/boot.js'],
    { verdict: 'pass' },
    CFG,
  );
  assert.equal(result.tier, 'review');
});

test('classifyAcceptanceTier: judge unparseable + plane file → not forced to must (only fail is)', () => {
  const result = classifyAcceptanceTier(
    ['packages/engine/src/foo.ts'],
    { verdict: 'unparseable' },
    CFG,
  );
  assert.equal(result.tier, 'auto');
});

// ---------------------------------------------------------------------------
// overseer confidence gate (overseerFloor + classifyAcceptanceTier overlay)
// ---------------------------------------------------------------------------

const PLANE_FILE = ['packages/engine/src/foo.ts']; // base tier = 'auto'

test('overseer: plane file + low judge confidence → held at review (would be auto)', () => {
  const r = classifyAcceptanceTier(PLANE_FILE, { verdict: 'pass', confidence: 0.5 }, CFG);
  assert.equal(r.tier, 'review');
  assert.match(r.reason, /overseer held above 'auto'/);
  assert.match(r.reason, /confidence 0\.50 < floor 0\.7/);
});

test('overseer: plane file + high confidence, no flags → stays auto (no false hold)', () => {
  const r = classifyAcceptanceTier(PLANE_FILE, { verdict: 'pass', confidence: 0.95 }, CFG);
  assert.equal(r.tier, 'auto');
});

test('overseer: test-theatre suspected → held at review even at full confidence', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 1.0, testTheatre: 'suspected' },
    CFG,
  );
  assert.equal(r.tier, 'review');
  assert.match(r.reason, /test-theatre/);
});

test('overseer: major scope creep → held at review', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 1.0, scopeCreep: 'major' },
    CFG,
  );
  assert.equal(r.tier, 'review');
  assert.match(r.reason, /scope creep/);
});

test('overseer: spec not satisfied → escalated all the way to must', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 1.0, specSatisfied: 'no' },
    CFG,
  );
  assert.equal(r.tier, 'must');
  assert.match(r.reason, /spec not satisfied/);
});

test('overseer: spec partial → held at review', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 1.0, specSatisfied: 'partial' },
    CFG,
  );
  assert.equal(r.tier, 'review');
});

test('overseer: minor scope creep is NOT a hold (only major)', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 0.95, scopeCreep: 'minor' },
    CFG,
  );
  assert.equal(r.tier, 'auto');
});

test('overseer: upgrade-only — a flag never LOWERS a risk-file must', () => {
  // authorization file → base 'must'; a mere low confidence must not drop it to 'review'.
  const r = classifyAcceptanceTier(
    ['apps/example/src/authorization.ts'],
    { verdict: 'pass', confidence: 0.1 },
    CFG,
  );
  assert.equal(r.tier, 'must');
});

test('overseer: does not fire on no-code items (empty files stay auto)', () => {
  const r = classifyAcceptanceTier([], { verdict: 'pass', confidence: 0.0 }, CFG);
  assert.equal(r.tier, 'auto');
});

test('overseer: does not fire without a judge verdict (un-judged plane file stays auto)', () => {
  const r = classifyAcceptanceTier(PLANE_FILE, undefined, CFG);
  assert.equal(r.tier, 'auto');
});

test('overseer: surface file (base review) + spec:no is upgraded to must', () => {
  const r = classifyAcceptanceTier(
    ['apps/example/src/public/boot.js'],
    { verdict: 'pass', confidence: 1.0, specSatisfied: 'no' },
    CFG,
  );
  assert.equal(r.tier, 'must');
});

test('overseer: confidenceFloor override to 0 disables the confidence check', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 0.1 },
    { ...CFG, confidenceFloor: 0 },
  );
  assert.equal(r.tier, 'auto');
});

test('overseer: confidenceFloor override still lets quality flags hold', () => {
  const r = classifyAcceptanceTier(
    PLANE_FILE,
    { verdict: 'pass', confidence: 1.0, testTheatre: 'suspected' },
    { ...CFG, confidenceFloor: 0 },
  );
  assert.equal(r.tier, 'review');
});

test('overseerFloor: direct — null when no flags trip', () => {
  assert.equal(overseerFloor(PLANE_FILE, { verdict: 'pass', confidence: 0.9 }, DEFAULT_CONFIDENCE_FLOOR), null);
});

// ---------------------------------------------------------------------------
// runClaimAuditGate (the non-code lane's definition-of-done gate)
// ---------------------------------------------------------------------------

test('runClaimAuditGate: non-risk, non-surface files → passed, same shape as the shell gate', () => {
  const r = runClaimAuditGate(['docs/marketing/copy.md'], CFG);
  assert.equal(r.passed, true);
  assert.match(r.reason, /^claim-audit passed:/);
  assert.equal(r.output, '');
});

test('runClaimAuditGate: risk-flagged path → failed', () => {
  const r = runClaimAuditGate(['packages/engine/src/eventContracts.ts'], CFG);
  assert.equal(r.passed, false);
  assert.match(r.reason, /^claim-audit failed:/);
});

test('runClaimAuditGate: no files → passed (nothing to audit)', () => {
  const r = runClaimAuditGate([], CFG);
  assert.equal(r.passed, true);
});
