/**
 * provenance.test.ts — WI-232 mechanical governance: verify a commit range against the
 * operator's real ledger.
 *
 * Follows the conventions of audit.test.ts: pure-function fixtures fabricated directly
 * (verifyProvenance never touches fs/git/ledger), plus extraction helpers over hand-built
 * event arrays. node:test + strict assert.
 *
 * Fixture data deliberately mixes 7-char and 40-char shas (the real measured shape: 73 of 185
 * real item.merged receipts are 7 chars, 80 are 40, 3 are 8, and 29 carry no commit at all) — a
 * fixture using only 40-char shas would have hidden the real defect this item fixes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MIN_SHA_MATCH,
  shaMatches,
  extractMergeReceipts,
  extractBreakGlassGrants,
  grantCoversCommit,
  openGrants,
  verifyProvenance,
  gatherProvenanceInput,
  ProvenanceInput,
  MergeReceipt,
  BreakGlassGrant,
  RangeCommit,
} from '../src/provenance.js';
import { LedgerEvent, makeEvent } from '../src/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // 40 chars
const FULL_SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1'; // 40 chars
const SHORT_SHA_A = FULL_SHA_A.slice(0, 7); // 'a1b2c3d'
const SHORT_SHA_B = FULL_SHA_B.slice(0, 7); // 'b2c3d4e'

const BASELINE_SHA = '0000000000000000000000000000000000000a';

function commit(sha: string, committedAt: string, subject = 'a commit'): RangeCommit {
  return { sha, subject, committedAt };
}

function receipt(over: Partial<MergeReceipt> & { item: string }): MergeReceipt {
  return { ts: '2026-07-01T00:00:00Z', hasGate: false, ...over };
}

function grant(over: Partial<BreakGlassGrant> & { item: string; targetId: string }): BreakGlassGrant {
  return {
    fromSha: BASELINE_SHA,
    reason: 'reactor wedged, hand-recovered',
    grantedAt: '2026-07-01T00:00:00Z',
    expiresAt: '2026-07-02T00:00:00Z',
    ...over,
  };
}

/** A fully-satisfied input (baseline resolved, range resolved, linear ancestry, ledger readable,
 *  target registered) with no commits and no receipts/grants — tests override only what they need. */
function baseInput(over: Partial<ProvenanceInput> = {}): ProvenanceInput {
  return {
    targetName: 'demo',
    targetId: 'tgt-abc12345',
    ledgerReadable: true,
    baseline: { commit: BASELINE_SHA, reason: 'pre-plane history', certifiedBy: ['WI-001'] },
    baselineResolved: BASELINE_SHA,
    baselineIsAncestor: true,
    rangeResolved: true,
    ancestryLinear: true,
    commits: [],
    receipts: [],
    grants: [],
    now: '2026-07-01T12:00:00Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// shaMatches
// ---------------------------------------------------------------------------

test('shaMatches: a 7-char prefix matches a full sha', () => {
  assert.equal(shaMatches(SHORT_SHA_A, FULL_SHA_A), true);
});

test('shaMatches: a 40-char sha matches itself exactly', () => {
  assert.equal(shaMatches(FULL_SHA_A, FULL_SHA_A), true);
});

test('shaMatches: case-insensitive', () => {
  assert.equal(shaMatches(SHORT_SHA_A.toUpperCase(), FULL_SHA_A), true);
  assert.equal(shaMatches(SHORT_SHA_A, FULL_SHA_A.toUpperCase()), true);
});

test('shaMatches: a 6-char receipt sha does NOT match (below MIN_SHA_MATCH)', () => {
  assert.equal(MIN_SHA_MATCH, 7);
  assert.equal(shaMatches(SHORT_SHA_A.slice(0, 6), FULL_SHA_A), false);
});

test('shaMatches: undefined receipt sha matches nothing', () => {
  assert.equal(shaMatches(undefined, FULL_SHA_A), false);
});

test('shaMatches: a prefix that does not match returns false', () => {
  assert.equal(shaMatches(SHORT_SHA_A, FULL_SHA_B), false);
});

// ---------------------------------------------------------------------------
// One test per IndeterminateCause — each asserts BOTH status AND the exact cause
// ---------------------------------------------------------------------------

test('verifyProvenance: ledger unreadable -> indeterminate/ledger-unreadable', () => {
  const r = verifyProvenance(baseInput({ ledgerReadable: false }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'ledger-unreadable');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: target not registered -> indeterminate/target-not-registered', () => {
  const r = verifyProvenance(baseInput({ targetId: null }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'target-not-registered');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: no baseline declared -> indeterminate/no-baseline', () => {
  const r = verifyProvenance(baseInput({ baseline: null }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'no-baseline');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: baseline does not resolve in this repo -> indeterminate/baseline-unresolvable', () => {
  const r = verifyProvenance(baseInput({ baselineResolved: null }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'baseline-unresolvable');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: baseline not an ancestor of the range end -> indeterminate/baseline-not-ancestor', () => {
  const r = verifyProvenance(baseInput({ baselineIsAncestor: false }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'baseline-not-ancestor');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: range unresolvable -> indeterminate/range-unresolvable', () => {
  const r = verifyProvenance(baseInput({ rangeResolved: false }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'range-unresolvable');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: non-linear ancestry (force-push/divergent) -> indeterminate/non-linear-ancestry', () => {
  const r = verifyProvenance(baseInput({ ancestryLinear: false }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'non-linear-ancestry');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: two simultaneously open break-glass grants -> indeterminate/break-glass-multiple', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    grants: [
      grant({ item: 'WI-500', targetId: 'tgt-abc12345', expiresAt: '2026-07-05T00:00:00Z' }),
      grant({ item: 'WI-501', targetId: 'tgt-abc12345', expiresAt: '2026-07-06T00:00:00Z' }),
    ],
  }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'break-glass-multiple');
  assert.equal(r.exitCode, 2);
});

test('verifyProvenance: empty range -> indeterminate/empty-range, NEVER verified', () => {
  const r = verifyProvenance(baseInput({ commits: [] }));
  assert.equal(r.status, 'indeterminate');
  assert.equal(r.cause, 'empty-range');
  assert.equal(r.exitCode, 2);
  assert.notEqual(r.status, 'verified');
});

// ---------------------------------------------------------------------------
// Gate evidence: each of the three shapes yields 'verified'
// ---------------------------------------------------------------------------

test('verifyProvenance: gate.passed event on the same item -> verified (beat-built merge)', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    receipts: [receipt({ item: 'WI-100', commit: SHORT_SHA_A, hasGate: true, gateDetail: 'gate.passed event' })],
  }));
  assert.equal(r.status, 'verified');
  assert.equal(r.exitCode, 0);
  assert.equal(r.commits[0]!.status, 'verified');
});

test('verifyProvenance: gateCommand string -> verified', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    receipts: [receipt({ item: 'WI-100', commit: SHORT_SHA_A, hasGate: true, gateDetail: 'gateCommand: npm test' })],
  }));
  assert.equal(r.status, 'verified');
  assert.equal(r.exitCode, 0);
});

test('verifyProvenance: free-text gate/gateResult -> verified (attended-coordinator merge)', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    receipts: [receipt({ item: 'WI-100', commit: SHORT_SHA_A, hasGate: true, gateDetail: 'gate: tests green' })],
  }));
  assert.equal(r.status, 'verified');
  assert.equal(r.exitCode, 0);
});

test('verifyProvenance: matching commit but NO gate evidence of any shape -> receipt-without-gate, range uncovered exitCode 1', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    receipts: [receipt({ item: 'WI-100', commit: SHORT_SHA_A, hasGate: false })],
  }));
  assert.equal(r.commits[0]!.status, 'receipt-without-gate');
  assert.equal(r.status, 'uncovered');
  assert.equal(r.exitCode, 1);
});

// ---------------------------------------------------------------------------
// No receipt at all
// ---------------------------------------------------------------------------

test('verifyProvenance: a commit with no receipt -> uncovered, exitCode 1', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    receipts: [],
  }));
  assert.equal(r.commits[0]!.status, 'uncovered');
  assert.equal(r.status, 'uncovered');
  assert.equal(r.exitCode, 1);
});

// ---------------------------------------------------------------------------
// Break-glass
// ---------------------------------------------------------------------------

test('verifyProvenance: an in-window commit covered by an open grant -> break-glass, range break-glass-open exitCode 3', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T12:00:00Z')],
    grants: [grant({ item: 'WI-500', targetId: 'tgt-abc12345', grantedAt: '2026-07-01T00:00:00Z', expiresAt: '2026-07-02T00:00:00Z' })],
  }));
  assert.equal(r.commits[0]!.status, 'break-glass');
  assert.equal(r.status, 'break-glass-open');
  assert.equal(r.exitCode, 3);
});

test('verifyProvenance: a commit OUTSIDE the grant window -> uncovered', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-10T12:00:00Z')], // after expiresAt
    grants: [grant({ item: 'WI-500', targetId: 'tgt-abc12345', grantedAt: '2026-07-01T00:00:00Z', expiresAt: '2026-07-02T00:00:00Z' })],
  }));
  assert.equal(r.commits[0]!.status, 'uncovered');
  assert.equal(r.status, 'uncovered');
  assert.equal(r.exitCode, 1);
});

test('grantCoversCommit: an EXPIRED grant (now past expiresAt) covers nothing', () => {
  const g = grant({ item: 'WI-500', targetId: 'tgt-abc12345', grantedAt: '2026-07-01T00:00:00Z', expiresAt: '2026-07-02T00:00:00Z' });
  const c = commit(FULL_SHA_A, '2026-07-01T12:00:00Z'); // inside the window
  assert.equal(grantCoversCommit(g, c, '2026-07-01T18:00:00Z'), true); // now still before expiry
  assert.equal(grantCoversCommit(g, c, '2026-07-03T00:00:00Z'), false); // now is past expiry -> covers nothing
});

test('verifyProvenance: an expired grant (now past expiresAt) -> uncovered even for an in-window commit', () => {
  const r = verifyProvenance(baseInput({
    now: '2026-07-05T00:00:00Z', // well past the grant's expiresAt
    commits: [commit(FULL_SHA_A, '2026-07-01T12:00:00Z')],
    grants: [grant({ item: 'WI-500', targetId: 'tgt-abc12345', grantedAt: '2026-07-01T00:00:00Z', expiresAt: '2026-07-02T00:00:00Z' })],
  }));
  assert.equal(r.commits[0]!.status, 'uncovered');
  assert.equal(r.status, 'uncovered');
});

test('grantCoversCommit: a grant for a DIFFERENT targetId covers nothing', () => {
  const r = verifyProvenance(baseInput({
    targetId: 'tgt-abc12345',
    commits: [commit(FULL_SHA_A, '2026-07-01T12:00:00Z')],
    grants: [grant({ item: 'WI-500', targetId: 'tgt-other0000', grantedAt: '2026-07-01T00:00:00Z', expiresAt: '2026-07-02T00:00:00Z' })],
  }));
  assert.equal(r.commits[0]!.status, 'uncovered');
});

test('openGrants: filters by targetId and unexpired-as-of-now', () => {
  const grants = [
    grant({ item: 'WI-1', targetId: 'tgt-a', expiresAt: '2026-07-02T00:00:00Z' }),
    grant({ item: 'WI-2', targetId: 'tgt-b', expiresAt: '2026-07-02T00:00:00Z' }),
    grant({ item: 'WI-3', targetId: 'tgt-a', expiresAt: '2026-06-01T00:00:00Z' }), // expired
  ];
  const open = openGrants(grants, 'tgt-a', '2026-07-01T12:00:00Z');
  assert.deepEqual(open.map(g => g.item), ['WI-1']);
});

// ---------------------------------------------------------------------------
// A fully verified range
// ---------------------------------------------------------------------------

test('verifyProvenance: a fully verified range -> verified, exitCode 0', () => {
  const r = verifyProvenance(baseInput({
    commits: [
      commit(FULL_SHA_A, '2026-07-01T06:00:00Z', 'merge WI-100'),
      commit(FULL_SHA_B, '2026-07-01T08:00:00Z', 'merge WI-101'),
    ],
    receipts: [
      receipt({ item: 'WI-100', commit: SHORT_SHA_A, hasGate: true }), // short (7-char) receipt
      receipt({ item: 'WI-101', commit: FULL_SHA_B, hasGate: true }),  // full (40-char) receipt
    ],
  }));
  assert.equal(r.status, 'verified');
  assert.equal(r.exitCode, 0);
  assert.equal(r.counts.verified, 2);
  assert.equal(r.counts.uncovered, 0);
  assert.equal(r.counts['receipt-without-gate'], 0);
  assert.equal(r.counts['break-glass'], 0);
});

test('verifyProvenance: a no-code receipt (no commit) matches nothing — planning-lane merges never vouch for code', () => {
  const r = verifyProvenance(baseInput({
    commits: [commit(FULL_SHA_A, '2026-07-01T06:00:00Z')],
    receipts: [receipt({ item: 'WI-200', hasGate: true })], // no `commit` field at all
  }));
  assert.equal(r.commits[0]!.status, 'uncovered');
});

test('verifyProvenance: mixed range — verified + uncovered rolls up to uncovered, exitCode 1', () => {
  const r = verifyProvenance(baseInput({
    commits: [
      commit(FULL_SHA_A, '2026-07-01T06:00:00Z'),
      commit(FULL_SHA_B, '2026-07-01T08:00:00Z'),
    ],
    receipts: [
      receipt({ item: 'WI-100', commit: SHORT_SHA_A, hasGate: true }),
      // no receipt for FULL_SHA_B
    ],
  }));
  assert.equal(r.counts.verified, 1);
  assert.equal(r.counts.uncovered, 1);
  assert.equal(r.status, 'uncovered');
  assert.equal(r.exitCode, 1);
});

// ---------------------------------------------------------------------------
// extractMergeReceipts / extractBreakGlassGrants over a small hand-built event array
// ---------------------------------------------------------------------------

test('extractMergeReceipts: reads commit + the three gate-evidence shapes, and a no-code merge carries no commit', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-1', 'item.merged', { commit: SHORT_SHA_A }),
    makeEvent('dispatch', 'WI-1', 'gate.passed', { tests: 'green' }), // same item -> WI-1 gets gate.passed evidence
    makeEvent('dispatch', 'WI-2', 'item.merged', { commit: FULL_SHA_B, gateCommand: 'npm test' }),
    makeEvent('coordinator', 'WI-3', 'item.merged', { commit: 'c3d4e5f', gate: 'tests green (attended)' } as any),
    makeEvent('coordinator', 'WI-4', 'item.merged', {} as any), // no-code merge: no commit field at all
  ];
  const receipts = extractMergeReceipts(events);
  assert.equal(receipts.length, 4);

  const wi1 = receipts.find(r => r.item === 'WI-1')!;
  assert.equal(wi1.commit, SHORT_SHA_A);
  assert.equal(wi1.hasGate, true);

  const wi2 = receipts.find(r => r.item === 'WI-2')!;
  assert.equal(wi2.commit, FULL_SHA_B);
  assert.equal(wi2.hasGate, true);

  const wi3 = receipts.find(r => r.item === 'WI-3')!;
  assert.equal(wi3.commit, 'c3d4e5f');
  assert.equal(wi3.hasGate, true);

  const wi4 = receipts.find(r => r.item === 'WI-4')!;
  assert.equal(wi4.commit, undefined);
  assert.equal(wi4.hasGate, false);
});

test('extractMergeReceipts: a merge with a commit but none of the three gate shapes has hasGate=false', () => {
  const events: LedgerEvent[] = [
    makeEvent('coordinator', 'WI-9', 'item.merged', { commit: SHORT_SHA_A }),
  ];
  const receipts = extractMergeReceipts(events);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.hasGate, false);
});

// ---------------------------------------------------------------------------
// gatherProvenanceInput: ledger readability probe (the WI-232 fail-closed gap)
//
// loadAllEventsWithQuarantine fails SOFT on a missing/empty ledger dir (returns [] rather than
// throwing), so `ledgerReadable` must be probed explicitly rather than derived from a try/catch
// around the loader alone — otherwise a wiped or misconfigured plane-home reads as a real,
// receipt-free ledger and every commit misclassifies as 'uncovered' instead of the true
// 'ledger-unreadable'.
// ---------------------------------------------------------------------------

test('gatherProvenanceInput: a NONEXISTENT ledger dir -> ledgerReadable false, and verifyProvenance refuses as ledger-unreadable (not uncovered)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'provenance-ledger-missing-'));
  try {
    const missingLedgerDir = join(base, 'does-not-exist');
    const input = await gatherProvenanceInput({
      repoPath: base,
      ledgerDir: missingLedgerDir,
      targetId: 'tgt-abc12345',
    });
    assert.equal(input.ledgerReadable, false);

    const r = verifyProvenance(input);
    assert.equal(r.status, 'indeterminate');
    assert.equal(r.cause, 'ledger-unreadable');
    assert.notEqual(r.status, 'uncovered');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('gatherProvenanceInput: an EXISTING but EMPTY ledger dir (no .jsonl segments) -> ledgerReadable false, and verifyProvenance refuses as ledger-unreadable (not uncovered)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'provenance-ledger-empty-'));
  try {
    const emptyLedgerDir = join(base, 'ledger');
    mkdirSync(emptyLedgerDir, { recursive: true });
    // an unrelated, non-.jsonl file must not count as ledger content
    writeFileSync(join(emptyLedgerDir, 'quarantine.json'), '[]', 'utf8');

    const input = await gatherProvenanceInput({
      repoPath: base,
      ledgerDir: emptyLedgerDir,
      targetId: 'tgt-abc12345',
    });
    assert.equal(input.ledgerReadable, false);

    const r = verifyProvenance(input);
    assert.equal(r.status, 'indeterminate');
    assert.equal(r.cause, 'ledger-unreadable');
    assert.notEqual(r.status, 'uncovered');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('gatherProvenanceInput: a ledger dir with at least one valid .jsonl segment -> ledgerReadable true', async () => {
  const base = mkdtempSync(join(tmpdir(), 'provenance-ledger-valid-'));
  try {
    const ledgerDir = join(base, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const line = JSON.stringify(makeEvent('operator', 'WI-1', 'item.captured', { source: 'cli', text: 'x' }));
    writeFileSync(join(ledgerDir, 'work-2026-07.jsonl'), line + '\n', 'utf8');

    const input = await gatherProvenanceInput({
      repoPath: base,
      ledgerDir,
      targetId: 'tgt-abc12345',
    });
    assert.equal(input.ledgerReadable, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('gatherProvenanceInput: targetName override is used when supplied, else falls back to repoPath', async () => {
  const base = mkdtempSync(join(tmpdir(), 'provenance-target-name-'));
  try {
    const ledgerDir = join(base, 'ledger'); // deliberately missing — irrelevant to this assertion
    const withOverride = await gatherProvenanceInput({
      repoPath: base,
      ledgerDir,
      targetId: 'tgt-abc12345',
      targetName: 'acme-web',
    });
    assert.equal(withOverride.targetName, 'acme-web');

    const withoutOverride = await gatherProvenanceInput({
      repoPath: base,
      ledgerDir,
      targetId: 'tgt-abc12345',
    });
    assert.equal(withoutOverride.targetName, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('extractBreakGlassGrants: reads a well-formed provenance.break-glass event and skips a malformed one', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-50', 'provenance.break-glass', {
      targetId: 'tgt-abc12345',
      fromSha: BASELINE_SHA,
      reason: 'reactor wedged, hand-recovered locally',
      expiresAt: '2026-08-01T00:00:00Z',
      retroItem: 'WI-51',
    }),
    // malformed: missing reason — extractBreakGlassGrants skips rather than throwing
    makeEvent('operator', 'WI-52', 'provenance.break-glass', {
      targetId: 'tgt-abc12345',
      fromSha: BASELINE_SHA,
      expiresAt: '2026-08-01T00:00:00Z',
    } as any),
  ];
  const grants = extractBreakGlassGrants(events);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.item, 'WI-50');
  assert.equal(grants[0]!.targetId, 'tgt-abc12345');
  assert.equal(grants[0]!.retroItem, 'WI-51');
});
