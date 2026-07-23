/**
 * portability-promotion.test.ts — WI-098: cross-target pattern promotion in the certification flow
 * ("harvest portable patterns at boundaries — never leave them in chat").
 *
 * Pins:
 *   - schema helpers: isPortabilityRequired (ADR-bearing / incident-fix detection) and
 *     parsePortabilityTargets (lenient "applies to: <targets> | none" extraction).
 *   - parseManifest + fold: the optional portability note rides the worker manifest onto
 *     item.merged.certification and folds onto rec.mergeCertification (additive, all-or-nothing
 *     alongside the three required certification fields).
 *   - reactor stepPortabilityPromotion (via runReactor): a merged item whose certification names
 *     another registered target captures a sibling item there — PARKED as decision when
 *     product-shaped, QUEUED when mechanical; skips unregistered names + the item's own target;
 *     idempotent per (source, target); advisory-nudges an ADR/incident merge missing the note.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  makeEvent, LedgerEvent, isPortabilityRequired, parsePortabilityTargets,
} from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { parseManifest } from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { runReactor } from '../src/beats/reactor.js';
import { LoopkitConfig, CONFIG_DEFAULTS, loadConfig } from '../src/config.js';

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    // Off by default (staged flag — see config.ts); these tests exercise the step itself,
    // so opt in explicitly. A dedicated test below pins the default-disabled no-op.
    portabilityPromotion: { enabled: true },
    ...overrides,
  };
}

/** A temp git repo + ledger dir wired the way the reactor tests expect. */
function makeEnv(): { repoRoot: string; ledgerDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'wi098-'));
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

// ---------------------------------------------------------------------------
// schema helpers
// ---------------------------------------------------------------------------

test('isPortabilityRequired: ADR-bearing (decision-id / ADR-NNN) and incident-fix items owe a note', () => {
  // Covers the D-<digits> branch of the shipped decision-id detector regex in schema.ts
  // (some target repos use a D-prefixed id scheme; loopkit's own is ADR-NNN). Assembled
  // at runtime with an obviously-fake number so the id stays a synthetic example.
  const decisionId = ['D', '000'].join('-'); // leak-scan:allow-decision-id
  assert.equal(isPortabilityRequired({ spec: `implement ${decisionId} example decision` }), true);
  assert.equal(isPortabilityRequired({ text: 'per ADR-007 fast-drain' }), true);
  assert.equal(isPortabilityRequired({ spec: 'fix', repairContext: 'gate red on merged tree' }), true);
  assert.equal(isPortabilityRequired({ spec: 'fix', lane: 'repair' }), true);
  assert.equal(isPortabilityRequired({ text: 'hotfix the regression from the incident' }), true);
  // Ordinary feature work owes nothing.
  assert.equal(isPortabilityRequired({ spec: 'add a due-date banner', lane: 'engineering' }), false);
});

test('parsePortabilityTargets: extracts named targets, treats none/blank/absent as empty', () => {
  assert.deepEqual(parsePortabilityTargets('applies to: acme-web, acme-mobile'), ['acme-web', 'acme-mobile']);
  assert.deepEqual(parsePortabilityTargets('applies to: acme-web'), ['acme-web']);
  assert.deepEqual(parsePortabilityTargets('applies to: none'), []);
  assert.deepEqual(parsePortabilityTargets('none'), []);
  assert.deepEqual(parsePortabilityTargets(''), []);
  assert.deepEqual(parsePortabilityTargets(undefined), []);
  // Tolerates a bare comma list without the marker.
  assert.deepEqual(parsePortabilityTargets('acme-web , acme-ops'), ['acme-web', 'acme-ops']);
});

// ---------------------------------------------------------------------------
// manifest + fold carry the note
// ---------------------------------------------------------------------------

test('parseManifest: portability rides the certification block (additive, optional)', () => {
  const m = parseManifest(JSON.stringify({
    wi: 'WI-001', filesTouched: ['a.ts'], testsAdded: [], confidence: 0.9, notes: 'x',
    certification: { couldBreak: 'x', detection: 'y', rollback: 'z', portability: 'applies to: acme-web' },
  }));
  assert.ok(m);
  assert.equal(m!.certification?.portability, 'applies to: acme-web');

  // A certification without portability is still valid (field simply absent).
  const m2 = parseManifest(JSON.stringify({
    wi: 'WI-002', filesTouched: [], testsAdded: [], confidence: 1, notes: '',
    certification: { couldBreak: 'x', detection: 'y', rollback: 'z' },
  }));
  assert.ok(m2!.certification);
  assert.equal('portability' in m2!.certification!, false);
});

test('fold: item.merged.certification.portability folds onto rec.mergeCertification', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-003', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-003', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
    makeEvent('reactor', 'WI-003', 'item.merged', {
      commit: 'abc',
      certification: { couldBreak: 'x', detection: 'y', rollback: 'z', portability: 'applies to: acme-web' },
    }, '2026-01-01T00:02:00Z'),
  ];
  const rec = fold(events).items.get('WI-003')!;
  assert.equal(rec.mergeCertification?.portability, 'applies to: acme-web');
});

// ---------------------------------------------------------------------------
// portabilityPromotion config block (staged flag — default off)
// ---------------------------------------------------------------------------

/** Load a repo-root loopkit.config.json without any ambient plane-home (LOOPKIT_HOME) interfering. */
function loadConfigIsolated(repoRoot: string): LoopkitConfig {
  const saved = process.env['LOOPKIT_HOME'];
  delete process.env['LOOPKIT_HOME'];
  try {
    return loadConfig(repoRoot);
  } finally {
    if (saved === undefined) delete process.env['LOOPKIT_HOME']; else process.env['LOOPKIT_HOME'] = saved;
  }
}

test('portabilityPromotion: config default is enabled:false (loadConfig with no file)', () => {
  const base = mkdtempSync(join(tmpdir(), 'wi098-cfg-'));
  try {
    const cfg = loadConfigIsolated(base);
    assert.equal(cfg.portabilityPromotion?.enabled, false, 'default must be false — the step ships dormant');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('config: portabilityPromotion.enabled must be a boolean', () => {
  const base = mkdtempSync(join(tmpdir(), 'wi098-cfg-'));
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ portabilityPromotion: { enabled: 'yes' } }), 'utf8');
    assert.throws(
      () => loadConfigIsolated(base),
      /portabilityPromotion\.enabled must be a boolean/,
      'must throw on non-boolean portabilityPromotion.enabled',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('config: portabilityPromotion.enabled:true loads and flows through to the reactor step', () => {
  const base = mkdtempSync(join(tmpdir(), 'wi098-cfg-'));
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ portabilityPromotion: { enabled: true } }), 'utf8');
    const cfg = loadConfigIsolated(base);
    assert.equal(cfg.portabilityPromotion?.enabled, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reactor promotion step (via runReactor)
// ---------------------------------------------------------------------------

test('reactor (WI-098): a mechanical merged item with a portability note QUEUES a sibling on the named target', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'acme-web', 'target.registered', {
        name: 'acme-web', repoPath: '/tmp/acme-web', manifestHash: 'h', defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'add a dedup guard to the tooling', lane: 'engineering' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-010', 'item.queued', { spec: 'add a dedup guard to the tooling', lane: 'engineering' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-010', 'item.merged', {
        commit: 'abc',
        certification: { couldBreak: 'x', detection: 'y', rollback: 'z', portability: 'applies to: acme-web' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    const sibling = [...folded.items.values()].find(r => r.source === 'portability:WI-010:acme-web');
    assert.ok(sibling, 'a sibling item was captured for the named target');
    assert.equal(sibling!.target, 'acme-web', 'sibling is stamped against the named target');
    assert.equal(sibling!.state, 'queued', 'mechanical source ⇒ the sibling is queued to build');

    // Idempotent: a second beat must not capture a second sibling for the same (source, target).
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const events2 = await loadAllEvents(ledgerDir);
    const siblings2 = [...fold(events2).items.values()].filter(r => r.source === 'portability:WI-010:acme-web');
    assert.equal(siblings2.length, 1, 'exactly one sibling across two beats (idempotent)');
  } finally {
    cleanup();
  }
});

test('reactor (WI-098): a product-shaped merged item PARKS the sibling as a decision', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'acme-web', 'target.registered', {
        name: 'acme-web', repoPath: '/tmp/acme-web', manifestHash: 'h', defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-011', 'item.captured', { source: 'cli', text: 'new pricing packaging surface', lane: 'product' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-011', 'item.queued', { spec: 'new pricing packaging surface', lane: 'product' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-011', 'item.merged', {
        commit: 'abc',
        certification: { couldBreak: 'x', detection: 'y', rollback: 'z', portability: 'applies to: acme-web' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });

    const folded = fold(await loadAllEvents(ledgerDir));
    const sibling = [...folded.items.values()].find(r => r.source === 'portability:WI-011:acme-web');
    assert.ok(sibling, 'sibling captured');
    assert.equal(sibling!.state, 'parked', 'product-shaped source ⇒ the sibling parks');
    assert.equal(sibling!.parkKind, 'decision', 'parked as a decision (operator must ratify)');
  } finally {
    cleanup();
  }
});

test('reactor (WI-098): portabilityPromotion.enabled defaults false — the step is a no-op even with a portable merge', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'acme-web', 'target.registered', {
        name: 'acme-web', repoPath: '/tmp/acme-web', manifestHash: 'h', defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-020', 'item.captured', { source: 'cli', text: 'add a dedup guard to the tooling', lane: 'engineering' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-020', 'item.queued', { spec: 'add a dedup guard to the tooling', lane: 'engineering' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-020', 'item.merged', {
        commit: 'abc',
        certification: { couldBreak: 'x', detection: 'y', rollback: 'z', portability: 'applies to: acme-web' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    // Override the file's opt-in back to the real CONFIG_DEFAULTS shape (enabled: false).
    const result = await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig({ portabilityPromotion: { enabled: false } }) });
    const step = result.steps.find(s => s.step === 'portability-promotion');
    assert.ok(step, 'step still runs (and reports) even when disabled');
    assert.equal(step!.eventsWritten, 0, 'disabled step writes nothing');

    const folded = fold(await loadAllEvents(ledgerDir));
    const sibling = [...folded.items.values()].find(r => r.source === 'portability:WI-020:acme-web');
    assert.equal(sibling, undefined, 'no sibling captured while the flag is off');
  } finally {
    cleanup();
  }
});

test('reactor (WI-098): an unregistered target name promotes nothing (skipped, no phantom item)', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-012', 'item.captured', { source: 'cli', text: 'tooling change', lane: 'engineering' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-012', 'item.queued', { spec: 'tooling change', lane: 'engineering' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-012', 'item.merged', {
        commit: 'abc',
        certification: { couldBreak: 'x', detection: 'y', rollback: 'z', portability: 'applies to: never-registered' },
      }, '2026-01-01T00:03:00Z'),
    ]);

    const before = fold(await loadAllEvents(ledgerDir)).items.size;
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const folded = fold(await loadAllEvents(ledgerDir));
    const promoted = [...folded.items.values()].filter(r => (r.source ?? '').startsWith('portability:'));
    assert.equal(promoted.length, 0, 'no sibling captured for an unregistered target');
    assert.equal(folded.items.size, before, 'no phantom item materialized');
  } finally {
    cleanup();
  }
});

test('reactor (WI-098): an ADR-bearing merge missing a portability note gets one advisory nudge (bounded)', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-013', 'item.captured', { source: 'cli', text: 'implement ADR-042 plane model', lane: 'engineering' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-013', 'item.queued', { spec: 'implement ADR-042 plane model', lane: 'engineering' }, '2026-01-01T00:02:00Z'),
      makeEvent('reactor', 'WI-013', 'item.merged', {
        commit: 'abc',
        certification: { couldBreak: 'x', detection: 'y', rollback: 'z' }, // no portability, but owed (ADR-bearing)
      }, '2026-01-01T00:03:00Z'),
    ]);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    let events = await loadAllEvents(ledgerDir);
    const nudges1 = events.filter(e => e.item === 'WI-013' && e.type === 'msg.out'
      && String((e.data as { text?: string }).text ?? '').startsWith('portability-nudge:'));
    assert.equal(nudges1.length, 1, 'exactly one nudge for the missing owed portability note');

    // Bounded — a second beat must not re-nudge.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    events = await loadAllEvents(ledgerDir);
    const nudges2 = events.filter(e => e.item === 'WI-013' && e.type === 'msg.out'
      && String((e.data as { text?: string }).text ?? '').startsWith('portability-nudge:'));
    assert.equal(nudges2.length, 1, 'nudge is bounded — not repeated every beat');
  } finally {
    cleanup();
  }
});
