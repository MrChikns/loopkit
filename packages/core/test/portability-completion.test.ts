/**
 * portability-completion.test.ts — ADR-009: the portability-nudge completion path
 * (docs/decisions/ADR-009-portability-completion.md). Pins:
 *   - schema: parsePortabilityTargets as the single strict validating parser
 *     ({targets, none, errors}) per the ADR grammar.
 *   - verbs: amendPortability — the verb-appends-an-event pattern that closes the loop.
 *   - fold: item.certification-amended folds onto rec.mergeCertification.portability
 *     (pure annotation, fail-soft, last-writer-wins).
 *   - reactor e2e: nudge → amend → next beat promotes a sibling on a registered target,
 *     and the amendment silences the nudge.
 *
 * Fixtures use a generic placeholder target name (acme-web), never a private name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  makeEvent, LedgerEvent, ItemCertificationAmendedData, parsePortabilityTargets,
  MAX_PORTABILITY_BODY_LEN, MAX_PORTABILITY_TARGETS,
} from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { amendPortability, VerbError } from '../src/verbs.js';
import { runReactor } from '../src/beats/reactor.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { fallbackTargetId } from '../src/target.js';

function withTempLedger<T>(fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), 'loopkit-adr009-'));
  const ledgerDir = join(base, 'ledger');
  return (async () => {
    try {
      return await fn(ledgerDir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();
}

// ---------------------------------------------------------------------------
// parser — parsePortabilityTargets (schema.ts)
// ---------------------------------------------------------------------------

test('parsePortabilityTargets: happy path with the "applies to:" marker present', () => {
  const r = parsePortabilityTargets('applies to: acme-web, acme-api');
  assert.deepEqual(r, { targets: ['acme-web', 'acme-api'], none: false, errors: [] });
});

test('parsePortabilityTargets: happy path with the marker absent (bare comma list)', () => {
  const r = parsePortabilityTargets('acme-web, acme-api');
  assert.deepEqual(r, { targets: ['acme-web', 'acme-api'], none: false, errors: [] });
});

test('parsePortabilityTargets: case-folds and trims target names', () => {
  const r = parsePortabilityTargets('  Applies To:  ACME-Web ,  Acme.Api-2  ');
  assert.deepEqual(r, { targets: ['acme-web', 'acme.api-2'], none: false, errors: [] });
});

test('parsePortabilityTargets: "none" in either case, with or without the marker', () => {
  assert.deepEqual(parsePortabilityTargets('none'), { targets: [], none: true, errors: [] });
  assert.deepEqual(parsePortabilityTargets('NONE'), { targets: [], none: true, errors: [] });
  assert.deepEqual(parsePortabilityTargets('applies to: none'), { targets: [], none: true, errors: [] });
  assert.deepEqual(parsePortabilityTargets('Applies To: None'), { targets: [], none: true, errors: [] });
});

test('parsePortabilityTargets: empty body is always an error, never silently none', () => {
  assert.deepEqual(parsePortabilityTargets(''), { targets: [], none: false, errors: ['empty body'] });
  assert.deepEqual(parsePortabilityTargets('   '), { targets: [], none: false, errors: ['empty body'] });
  assert.deepEqual(parsePortabilityTargets('applies to:'), { targets: [], none: false, errors: ['empty body'] });
  assert.deepEqual(parsePortabilityTargets('applies to:   '), { targets: [], none: false, errors: ['empty body'] });
  // Absent (undefined) is distinct from a user-submitted empty string — no note at all is not an error.
  assert.deepEqual(parsePortabilityTargets(undefined), { targets: [], none: false, errors: [] });
});

test('parsePortabilityTargets: malformed names (space/slash/overlong) are salvaged around', () => {
  const withSpace = parsePortabilityTargets('acme-web, bad name, acme-api');
  assert.deepEqual(withSpace.targets, ['acme-web', 'acme-api']);
  assert.equal(withSpace.errors.length, 1);
  assert.match(withSpace.errors[0]!, /malformed target name/);

  const withSlash = parsePortabilityTargets('acme-web, acme/api');
  assert.deepEqual(withSlash.targets, ['acme-web']);
  assert.equal(withSlash.errors.length, 1);

  const overlong = 'a'.repeat(65);
  const withOverlong = parsePortabilityTargets(`acme-web, ${overlong}`);
  assert.deepEqual(withOverlong.targets, ['acme-web']);
  assert.equal(withOverlong.errors.length, 1);

  // A single, entirely malformed body salvages to nothing but still records the error (never throws).
  const allBad = parsePortabilityTargets('bad name only');
  assert.deepEqual(allBad.targets, []);
  assert.equal(allBad.errors.length, 1);
});

test('parsePortabilityTargets: duplicates are de-duplicated silently (no error)', () => {
  const r = parsePortabilityTargets('acme-web, ACME-WEB, acme-web, acme-api');
  assert.deepEqual(r.targets, ['acme-web', 'acme-api']);
  assert.deepEqual(r.errors, []);
});

test('parsePortabilityTargets: an oversized body is rejected before any splitting/looping', () => {
  const oversized = 'a'.repeat(MAX_PORTABILITY_BODY_LEN + 1);
  const r = parsePortabilityTargets(oversized);
  assert.deepEqual(r.targets, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /body too long/);
});

test('parsePortabilityTargets: more than MAX_PORTABILITY_TARGETS entries is rejected as an error', () => {
  const many = Array.from({ length: MAX_PORTABILITY_TARGETS + 1 }, (_, i) => `t${i}`).join(', ');
  const r = parsePortabilityTargets(many);
  assert.deepEqual(r.targets, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /too many targets/);
});

test('parsePortabilityTargets: back-compat — pre-ADR-009 merge-time lenient notes still parse cleanly', () => {
  // This is the exact shape existing item.merged.certification.portability fixtures use
  // (see portability-promotion.test.ts) — the rewrite must not regress the reactor's tolerant read.
  const r = parsePortabilityTargets('applies to: acme-web, acme-mobile');
  assert.deepEqual(r.targets, ['acme-web', 'acme-mobile']);
  assert.deepEqual(r.errors, []);
});

// ---------------------------------------------------------------------------
// verb — amendPortability (verbs.ts)
// ---------------------------------------------------------------------------

function targetRegistered(name: string, ts?: string): LedgerEvent {
  return makeEvent('cli', name, 'target.registered', {
    name, repoPath: `/tmp/${name}`, manifestHash: 'h', defaultBranch: 'main',
  }, ts);
}

test('amendPortability: happy path appends [amended, msg.in] linked via inReplyTo, visible in the fold', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-100', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-100', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-100', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const res = await amendPortability(ledgerDir, 'WI-100', 'applies to: acme-web');
    assert.equal(res.outcome, 'amended');
    assert.equal(res.portability, 'applies to: acme-web');
    assert.deepEqual(res.targets, ['acme-web']);

    const events = await loadAllEvents(ledgerDir);
    const amended = events.find(e => e.type === 'item.certification-amended');
    const msgIn = events.find(e => e.type === 'msg.in' && e.item === 'WI-100');
    assert.ok(amended, 'amendment event appended');
    assert.ok(msgIn, 'msg.in trail appended');
    assert.equal((amended!.data as { inReplyTo?: string }).inReplyTo, msgIn!.id);
    assert.equal((amended!.data as { by?: string }).by, 'operator');

    const rec = fold(events).items.get('WI-100')!;
    assert.equal(rec.mergeCertification?.portability, 'applies to: acme-web');
  }));

test('amendPortability: unknown target rejects the whole amendment — no amendment event, only msg.out', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-101', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-101', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-101', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const res = await amendPortability(ledgerDir, 'WI-101', 'applies to: acme-web, never-registered');
    assert.equal(res.outcome, 'rejected');
    assert.match(res.message, /never-registered/);

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.certification-amended').length, 0);
    assert.equal(events.filter(e => e.type === 'msg.in' && e.item === 'WI-101').length, 0);
    const msgOut = events.find(e => e.type === 'msg.out' && e.item === 'WI-101');
    assert.ok(msgOut, 'operator-facing msg.out error appended');
    assert.match((msgOut!.data as { text?: string }).text ?? '', /acme-web/, 'lists the registered names');

    const rec = fold(events).items.get('WI-101')!;
    assert.equal(rec.mergeCertification?.portability, undefined, 'no partial amendment leaked onto the record');
  }));

test('amendPortability: target-name resolution is case-insensitive (ADR-009)', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      // Registered under a mixed-case display name.
      makeEvent('cli', 'Acme-Web', 'target.registered', {
        name: 'Acme-Web', repoPath: '/tmp/Acme-Web', manifestHash: 'h', defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-106', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-106', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-106', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    // parsePortabilityTargets always lower-cases; the registered name is mixed-case — byName
    // must fold case on both sides or every note naming this target gets rejected as "unknown".
    const res = await amendPortability(ledgerDir, 'WI-106', 'applies to: acme-web');
    assert.equal(res.outcome, 'amended');
    assert.deepEqual(res.targets, ['acme-web']);
  }));

test('amendPortability: persists the resolved targetId alongside each target name', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-107', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-107', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-107', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    await amendPortability(ledgerDir, 'WI-107', 'applies to: acme-web');
    const events = await loadAllEvents(ledgerDir);
    const amended = events.find(e => e.type === 'item.certification-amended')!;
    const expectedId = fallbackTargetId('/tmp/acme-web');
    assert.deepEqual((amended.data as unknown as ItemCertificationAmendedData).targetIds, [expectedId]);

    const rec = fold(events).items.get('WI-107')!;
    assert.deepEqual(rec.mergeCertification?.targetIds, [expectedId]);
  }));

test('amendPortability: an oversized reply body is rejected — no amendment event appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-108', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-108', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-108', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const res = await amendPortability(ledgerDir, 'WI-108', 'a'.repeat(MAX_PORTABILITY_BODY_LEN + 1));
    assert.equal(res.outcome, 'rejected');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.certification-amended').length, 0);
    for (const e of events) assert.ok(JSON.stringify(e).length < 4096, 'no event line approaches the ledger cap');
  }));

test('amendPortability: a retry with the same commandId no-ops instead of appending a duplicate amendment', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-109', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-109', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-109', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const res1 = await amendPortability(ledgerDir, 'WI-109', 'applies to: acme-web', { commandId: 'cmd-1' });
    assert.equal(res1.outcome, 'amended');

    // Retry with the SAME commandId but a different body — the replay short-circuits before
    // parsing, so the original amendment's own result comes back, not a re-parse of the retry.
    const res2 = await amendPortability(ledgerDir, 'WI-109', 'none', { commandId: 'cmd-1' });
    assert.equal(res2.outcome, 'amended');
    assert.equal(res2.replay, true);
    assert.equal(res2.portability, 'applies to: acme-web');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.certification-amended').length, 1, 'exactly one amendment event');
    assert.equal(events.filter(e => e.type === 'msg.in' && e.item === 'WI-109').length, 1, 'exactly one msg.in trail');
  }));

test('amendPortability: a malformed reply rejects — no amendment event, only msg.out', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-102', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-102', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-102', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const res = await amendPortability(ledgerDir, 'WI-102', '');
    assert.equal(res.outcome, 'rejected');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.certification-amended').length, 0);
    assert.ok(events.find(e => e.type === 'msg.out' && e.item === 'WI-102'));
  }));

test('amendPortability: "none" is a valid amendment with targets:[]', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-103', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-103', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-103', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const res = await amendPortability(ledgerDir, 'WI-103', 'none');
    assert.equal(res.outcome, 'amended');
    assert.equal(res.portability, 'applies to: none');
    assert.deepEqual(res.targets, []);

    const rec = fold(await loadAllEvents(ledgerDir)).items.get('WI-103')!;
    assert.equal(rec.mergeCertification?.portability, 'applies to: none');
  }));

test('amendPortability: precondition no-op on a non-shipped (queued) item — nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-104', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-104', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
    ]);

    const res = await amendPortability(ledgerDir, 'WI-104', 'applies to: none');
    assert.equal(res.outcome, 'no-op');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 2, 'nothing appended for a non-shipped item');
  }));

test('amendPortability: re-amendment is idempotent/replay-deterministic (last-writer-wins)', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-105', 'item.captured', { source: 'cli', text: 'implement ADR-042' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-105', 'item.queued', { spec: 'implement ADR-042' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-105', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    await amendPortability(ledgerDir, 'WI-105', 'applies to: acme-web');
    const res2 = await amendPortability(ledgerDir, 'WI-105', 'none');
    assert.equal(res2.outcome, 'amended');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.certification-amended').length, 2);
    const rec = fold(events).items.get('WI-105')!;
    assert.equal(rec.mergeCertification?.portability, 'applies to: none', 'the later amendment wins');

    // Replay-determinism: folding the same events twice yields the same result.
    const foldedAgain = fold([...events]);
    assert.deepEqual(foldedAgain.items.get('WI-105')?.mergeCertification, rec.mergeCertification);
  }));

test('amendPortability: an unknown id throws VerbError, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }),
    ]);
    await assert.rejects(() => amendPortability(ledgerDir, 'not-a-wi-id', 'none'), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 1);
  }));

// ---------------------------------------------------------------------------
// fold — item.certification-amended (fold.ts)
// ---------------------------------------------------------------------------

test('fold: item.certification-amended synthesizes a minimal certification when none existed', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-200', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-200', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
    makeEvent('reactor', 'WI-200', 'item.merged', { commit: 'abc' }, '2026-01-01T00:02:00Z'),
    makeEvent('cli', 'WI-200', 'item.certification-amended', {
      field: 'portability', portability: 'applies to: acme-web', targets: ['acme-web'], by: 'operator',
    }, '2026-01-01T00:03:00Z'),
  ];
  const rec = fold(events).items.get('WI-200')!;
  assert.deepEqual(rec.mergeCertification, { portability: 'applies to: acme-web' });
});

test('fold: item.certification-amended is fail-soft — unknown field / non-string portability are ignored, never throws', () => {
  const base: LedgerEvent[] = [
    makeEvent('cli', 'WI-201', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-201', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
    makeEvent('reactor', 'WI-201', 'item.merged', {
      commit: 'abc', certification: { couldBreak: 'a', detection: 'b', rollback: 'c' },
    }, '2026-01-01T00:02:00Z'),
  ];

  const unknownField: LedgerEvent = makeEvent('cli', 'WI-201', 'item.certification-amended', {
    field: 'bogus', portability: 'applies to: acme-web', targets: ['acme-web'], by: 'operator',
  } as unknown as ItemCertificationAmendedData, '2026-01-01T00:03:00Z');
  const badShape: LedgerEvent = makeEvent('cli', 'WI-201', 'item.certification-amended', {
    field: 'portability', portability: 123, targets: [], by: 'operator',
  } as unknown as ItemCertificationAmendedData, '2026-01-01T00:04:00Z');

  assert.doesNotThrow(() => fold([...base, unknownField, badShape]));
  const rec = fold([...base, unknownField, badShape]).items.get('WI-201')!;
  assert.deepEqual(rec.mergeCertification, { couldBreak: 'a', detection: 'b', rollback: 'c' }, 'malformed amendments never mutate the record');
});

test('fold: item.certification-amended never calls transition() — item state is untouched', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-202', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-202', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
    makeEvent('reactor', 'WI-202', 'item.merged', { commit: 'abc' }, '2026-01-01T00:02:00Z'),
    makeEvent('reactor', 'WI-202', 'item.accepted', { by: 'operator' }, '2026-01-01T00:03:00Z'),
    makeEvent('cli', 'WI-202', 'item.certification-amended', {
      field: 'portability', portability: 'applies to: none', targets: [], by: 'operator',
    }, '2026-01-01T00:04:00Z'),
  ];
  const rec = fold(events).items.get('WI-202')!;
  assert.equal(rec.state, 'accepted', 'amendment on an accepted item leaves its state alone');
});

// ---------------------------------------------------------------------------
// reactor e2e — nudge → amend → next beat promotes; amendment silences the nudge
// ---------------------------------------------------------------------------

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    portabilityPromotion: { enabled: true },
    ...overrides,
  };
}

function makeReactorEnv(): { repoRoot: string; ledgerDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'adr009-reactor-'));
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  spawnSync('bash', ['-c', 'echo base > base.txt'], { cwd: repoRoot });
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  return { repoRoot, ledgerDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('reactor e2e (ADR-009): nudge fires on a merge missing the note, amendPortability silences it, next beat promotes the sibling', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeReactorEnv();
  try {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-300', 'item.captured', { source: 'cli', text: 'implement ADR-042 tooling fix', lane: 'engineering' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-300', 'item.queued', { spec: 'implement ADR-042 tooling fix', lane: 'engineering' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-300', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' }, // no portability, but owed
      }, '2026-01-01T00:03:00Z'),
    ]);

    // Beat 1: the merge is owed a portability note and has none — one advisory nudge fires.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    let events = await loadAllEvents(ledgerDir);
    const nudges = events.filter(e => e.item === 'WI-300' && e.type === 'msg.out'
      && String((e.data as { text?: string }).text ?? '').startsWith('portability-nudge:'));
    assert.equal(nudges.length, 1, 'exactly one nudge fires');

    // The operator confirms the reply through the verb — this is what closes the loop.
    const amendRes = await amendPortability(ledgerDir, 'WI-300', 'applies to: acme-web');
    assert.equal(amendRes.outcome, 'amended');

    // Beat 2: the certification now carries the note — the sibling promotes, and no second nudge fires.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    const acmeWebTargetId = fallbackTargetId('/tmp/acme-web');
    const sibling = [...folded.items.values()].find(r => r.source === `portability:WI-300:${acmeWebTargetId}`);
    assert.ok(sibling, 'a sibling item was captured for the named target once the amendment landed');
    assert.equal(sibling!.target, 'acme-web');

    const nudgesAfter = events.filter(e => e.item === 'WI-300' && e.type === 'msg.out'
      && String((e.data as { text?: string }).text ?? '').startsWith('portability-nudge:'));
    assert.equal(nudgesAfter.length, 1, 'the amendment silences further nudges — still exactly one from beat 1');
  } finally {
    cleanup();
  }
});

test('reactor e2e (ADR-009): a target rename followed by a re-amendment does not mint a duplicate sibling promotion', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeReactorEnv();
  try {
    await appendEvents(ledgerDir, [
      targetRegistered('acme-web', '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-310', 'item.captured', { source: 'cli', text: 'tooling dedup guard', lane: 'engineering' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-310', 'item.queued', { spec: 'tooling dedup guard', lane: 'engineering' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-310', 'item.merged', {
        commit: 'abc', certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    await amendPortability(ledgerDir, 'WI-310', 'applies to: acme-web');
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });

    const expectedId = fallbackTargetId('/tmp/acme-web');
    let folded = fold(await loadAllEvents(ledgerDir));
    let siblings = [...folded.items.values()].filter(r => (r.source ?? '').startsWith('portability:WI-310:'));
    assert.equal(siblings.length, 1, 'one sibling promoted under the original name');
    assert.equal(siblings[0]!.source, `portability:WI-310:${expectedId}`);

    // Rename: re-register the SAME repoPath under a NEW display name. fold.ts's identity pin
    // (byRepoPath revival) keeps the ORIGINAL targetId — it never mints a second target record.
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'acme-site', 'target.registered', {
        name: 'acme-site', repoPath: '/tmp/acme-web', manifestHash: 'h', defaultBranch: 'main',
      }, '2026-01-02T00:00:00Z'),
    ]);

    // Re-amend under the NEW name — this is the retry a rename forces on the operator.
    const res2 = await amendPortability(ledgerDir, 'WI-310', 'applies to: acme-site');
    assert.equal(res2.outcome, 'amended');

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    folded = fold(await loadAllEvents(ledgerDir));
    siblings = [...folded.items.values()].filter(r => (r.source ?? '').startsWith('portability:WI-310:'));
    assert.equal(siblings.length, 1, 'still exactly one sibling — the rename + re-amendment must not mint a duplicate');
    assert.equal(siblings[0]!.source, `portability:WI-310:${expectedId}`, 'keyed on the immutable target id, unaffected by the rename');
  } finally {
    cleanup();
  }
});
