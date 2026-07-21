/**
 * escalation-doctrine.test.ts — WI-056: leader-leader "escalate with intent, never a bare
 * question" (intent-based leadership). Pins:
 *   - fold back-compat: an item.parked event with no `escalation` field folds exactly as
 *     before (no crash, `escalation` stays undefined).
 *   - fold: a well-formed escalation payload folds onto the record and archives to
 *     `lastEscalation` on exit-from-parked, same lifecycle as parkReason/parkKind.
 *   - fold: a malformed/partial escalation payload (missing a field) folds to `undefined`
 *     rather than a half-populated block.
 *   - reactor grooming bounce: a parkKind:'decision' park with no escalation payload and a
 *     bare-question-shaped reason gets bounced with ONE msg.out, and never bounced twice for
 *     the same standing park.
 *   - reactor grooming bounce: a decision park that already carries a well-formed escalation
 *     payload is never bounced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { fold } from '../src/fold.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

let n = 0;
function tmp(): string {
  const d = join(tmpdir(), `loopkit-escalation-doctrine-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function clean(d: string): void { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

function cfg(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

function initRepo(repoRoot: string): void {
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt', 'utf8');
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'engagement.md'), 'stub engagement prompt', 'utf8');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
  g(['add', 'x.txt']);
  g(['commit', '-m', 'init']);
}

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const ESCALATION = {
  intent: 'I intend to add a KMS drop-in behind the existing secrets port.',
  evidence: 'The port already abstracts key storage; only one adapter exists today.',
  risk: 'A migration bug could strand secrets mid-cutover.',
  recommendation: 'Approve — the adapter ships behind a flag, rollback is a config flip.',
};

// ---------------------------------------------------------------------------
// fold back-compat + payload folding
// ---------------------------------------------------------------------------

test('fold back-compat: item.parked with no escalation field folds exactly as before', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-500', 'item.captured', { source: 'cli', text: 'old-shape park' }),
    makeEvent('conductor', 'WI-500', 'item.queued', { spec: 'spec' }),
    makeEvent('reactor', 'WI-500', 'item.parked', { reason: 'needs decision: hosting', parkKind: 'decision' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-500');
  assert.ok(item);
  assert.equal(item.state, 'parked');
  assert.equal(item.parkReason, 'needs decision: hosting');
  assert.equal(item.escalation, undefined, 'no escalation payload on a pre-existing-shape park');
});

test('fold: a well-formed escalation payload folds onto the record', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-501', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-501', 'item.queued', { spec: 'spec' }),
    makeEvent('reactor', 'WI-501', 'item.parked', {
      reason: 'needs decision: hosting',
      parkKind: 'decision',
      escalation: ESCALATION,
    }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-501');
  assert.ok(item);
  assert.deepEqual(item.escalation, ESCALATION);
});

test('fold: a malformed (partial) escalation payload folds to undefined, never half-populated', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-502', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-502', 'item.queued', { spec: 'spec' }),
    makeEvent('reactor', 'WI-502', 'item.parked', {
      reason: 'needs decision: hosting',
      parkKind: 'decision',
      // Missing 'risk' and 'recommendation' — the whole payload must be dropped, not
      // partially rendered. Cast past the type since this deliberately exercises a
      // malformed wire payload (an old/misbehaving emitter), not a valid EscalationPayload.
      escalation: { intent: ESCALATION.intent, evidence: ESCALATION.evidence } as unknown as typeof ESCALATION,
    }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-502');
  assert.ok(item);
  assert.equal(item.escalation, undefined);
});

test('fold: escalation archives to lastEscalation and clears on exit-from-parked (same lifecycle as parkReason)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-503', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-503', 'item.queued', { spec: 'spec' }),
    makeEvent('reactor', 'WI-503', 'item.parked', {
      reason: 'needs decision: hosting',
      parkKind: 'decision',
      escalation: ESCALATION,
    }),
    makeEvent('operator', 'WI-503', 'item.unparked', {}),
  ];
  const result = fold(events);
  const item = result.items.get('WI-503');
  assert.ok(item);
  assert.equal(item.state, 'queued');
  assert.equal(item.escalation, undefined, 'live escalation cleared on exit-from-parked');
  assert.deepEqual(item.lastEscalation, ESCALATION, 'archived to lastEscalation for forensics');
});

// ---------------------------------------------------------------------------
// reactor grooming bounce
// ---------------------------------------------------------------------------

test('escalation grooming: a bare-question decision park with no escalation payload is bounced once', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-600', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-600', 'item.parked', { reason: 'Should we use provider X?', parkKind: 'decision' }, iso(NOW - 4000)),
  ]);
  try {
    const opts = { repoRoot, ledgerDir, autonomy: 'on' as const, provider: null, pidProbe: () => true, config: cfg(), notify: () => true };
    await runReactor(opts);
    let events = await import('../src/ledger.js').then(m => m.loadAllEvents(ledgerDir));
    let bounces = events.filter(e => e.item === 'WI-600' && e.type === 'msg.out' && String((e.data as { text?: string }).text ?? '').startsWith('escalation-bounce:'));
    assert.equal(bounces.length, 1, 'exactly one bounce message fires');

    // A second beat over the SAME standing park must not bounce again.
    await runReactor(opts);
    events = await import('../src/ledger.js').then(m => m.loadAllEvents(ledgerDir));
    bounces = events.filter(e => e.item === 'WI-600' && e.type === 'msg.out' && String((e.data as { text?: string }).text ?? '').startsWith('escalation-bounce:'));
    assert.equal(bounces.length, 1, 'the SAME standing park is never bounced twice');
  } finally { clean(base); }
});

test('escalation grooming: a decision park WITH a well-formed escalation payload is never bounced', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-601', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-601', 'item.parked', {
      reason: 'needs decision: hosting provider',
      parkKind: 'decision',
      escalation: ESCALATION,
    }, iso(NOW - 4000)),
  ]);
  try {
    const opts = { repoRoot, ledgerDir, autonomy: 'on' as const, provider: null, pidProbe: () => true, config: cfg(), notify: () => true };
    await runReactor(opts);
    const events = await import('../src/ledger.js').then(m => m.loadAllEvents(ledgerDir));
    const bounces = events.filter(e => e.item === 'WI-601' && e.type === 'msg.out' && String((e.data as { text?: string }).text ?? '').startsWith('escalation-bounce:'));
    assert.equal(bounces.length, 0, 'a well-formed escalation payload is never bounced');
  } finally { clean(base); }
});

test('escalation grooming: a well-formed non-question reason (states intent/recommend) is not bounced even without a structured payload', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-602', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-602', 'item.parked', {
      reason: 'I intend to migrate the KMS adapter; recommend approve.',
      parkKind: 'decision',
    }, iso(NOW - 4000)),
  ]);
  try {
    const opts = { repoRoot, ledgerDir, autonomy: 'on' as const, provider: null, pidProbe: () => true, config: cfg(), notify: () => true };
    await runReactor(opts);
    const events = await import('../src/ledger.js').then(m => m.loadAllEvents(ledgerDir));
    const bounces = events.filter(e => e.item === 'WI-602' && e.type === 'msg.out' && String((e.data as { text?: string }).text ?? '').startsWith('escalation-bounce:'));
    assert.equal(bounces.length, 0, 'a reason that already states intent/recommendation prose is not bounced');
  } finally { clean(base); }
});

test('escalation grooming: an ops-kind park (not a decision park) is never bounced', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-603', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('dispatch', 'WI-603', 'item.parked', { reason: 'no-commit: worker left nothing', parkKind: 'ops' }, iso(NOW - 4000)),
  ]);
  try {
    const opts = { repoRoot, ledgerDir, autonomy: 'on' as const, provider: null, pidProbe: () => true, config: cfg(), notify: () => true };
    await runReactor(opts);
    const events = await import('../src/ledger.js').then(m => m.loadAllEvents(ledgerDir));
    const bounces = events.filter(e => e.item === 'WI-603' && e.type === 'msg.out' && String((e.data as { text?: string }).text ?? '').startsWith('escalation-bounce:'));
    assert.equal(bounces.length, 0, 'ops parks are plane-owned — never bounced onto the operator');
  } finally { clean(base); }
});
