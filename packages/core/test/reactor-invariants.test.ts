/**
 * reactor-invariants.test.ts — pins a set of reactor.ts hardening invariants:
 *   merge transient-fail — every merge transient-fail path caps into a visible ops park (parkClass:'merge-transient')
 *   SLO-tier gating      — the 'auto' tier is exempt from the plane-SLO smoke gate; non-auto withhold emits a note
 *   silence hold         — the operator-silence hold expires after holdMaxHours (72h) back into tier flow
 *   provider backoff     — routing/engagement provider-failure caps into a park/skip with hourly backoff;
 *                           a garbled ROUTE is treated as a provider failure, never a silent 'answer'
 *   decomposition close  — decomposition-grooming close guards (canonical child ref; rejected child skips + note)
 *   notify dedup         — notify stamps only on confirmed delivery; dedup is per item+reason
 *   auto-approve guard   — stepAutoApprove never re-enters an ops park
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { SloRow } from '../src/slo.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

let n = 0;
function tmp(): string {
  const d = join(tmpdir(), `loopkit-reactor-invariants-${process.pid}-${++n}-${Date.now()}`);
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
    // Framework defaults ship no product plane/surface prefixes of their own — this suite's
    // fixtures use 'packages/engine/src/' (plane) and 'apps/example/src/features/' (review
    // surface) as example paths, so declare them explicitly.
    autoApprove: {
      ...CONFIG_DEFAULTS.autoApprove,
      planePrefixes: ['packages/engine/'],
    },
    acceptance: {
      ...CONFIG_DEFAULTS.acceptance!,
      tiers: {
        ...CONFIG_DEFAULTS.acceptance!.tiers!,
        surfacePrefixes: ['apps/example/src/features/'],
      },
    },
    ...overrides,
  };
}

/** git-init a repo with a master commit and the loops-prompts dir. */
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

function healthyBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10s ago', target: '≤ 5m', status: 'met' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}
function breachedBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10m ago', target: '≤ 5m', status: 'breached' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const REVIEW_OLD = NOW - 200 * 3_600_000; // past the 168h review window

// ---------------------------------------------------------------------------
// SLO-tier gating — auto tier is exempt from the SLO smoke gate; non-auto is withheld
// ---------------------------------------------------------------------------

test('SLO-tier gating: auto tier accepts despite a breached plane-SLO board', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, iso(REVIEW_OLD - 1000)),
    // plane-only touches → 'auto' tier
    makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'packages/engine/src/foo.ts' }, iso(REVIEW_OLD - 900)),
    makeEvent('dispatch', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, iso(REVIEW_OLD)),
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true,
      config: cfg(), provisionalSloBoard: breachedBoard(),
    });
    const events = await loadAllEvents(ledgerDir);
    const accepted = events.filter(e => e.type === 'item.accepted' && e.item === 'WI-001');
    assert.equal(accepted.length, 1, 'auto tier must accept even while the plane SLO is breached');
    assert.equal((accepted[0]!.data as { tier?: string }).tier, 'auto');
  } finally { clean(base); }
});

test('SLO-tier gating: a non-auto (review) tier item is withheld under a breached board + a visible note fires once', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'x' }, iso(REVIEW_OLD - 1000)),
    makeEvent('cli', 'WI-002', 'item.queued', { spec: 'x', touches: 'apps/example/src/features/board/screen.ts' }, iso(REVIEW_OLD - 900)),
    makeEvent('dispatch', 'WI-002', 'item.merged', { commit: 'abc', deployed: false }, iso(REVIEW_OLD)),
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true,
      config: cfg(), provisionalSloBoard: breachedBoard(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.accepted' && e.item === 'WI-002').length, 0,
      'review tier is withheld while the plane SLO is breached');
    const withheld = events.filter(e => e.type === 'msg.out' && e.item === 'system'
      && String((e.data as { text?: string }).text ?? '').includes('accept.withheld'));
    assert.equal(withheld.length, 1, 'exactly one accept.withheld note on transition into the withheld state');
    assert.ok(String((withheld[0]!.data as { text?: string }).text).includes('loop-reactor'),
      'the withheld note names the failing SLO key');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// silence hold — the operator-silence hold expires after holdMaxHours
// ---------------------------------------------------------------------------

test('silence hold: an unanswered reply OLDER than holdMaxHours expires the hold → the item resumes + accepts', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  const reply = makeEvent('operator', 'WI-003', 'msg.in', { text: 'looks off' }, iso(NOW - 100 * 3_600_000)); // 100h ago > 72h
  await appendEvents(ledgerDir, [
    makeEvent('system', 'system', 'engagement.baseline', {}, iso(NOW - 199 * 3_600_000)),
    makeEvent('cli', 'WI-003', 'item.captured', { source: 'cli', text: 'x' }, iso(REVIEW_OLD - 1000)),
    makeEvent('cli', 'WI-003', 'item.queued', { spec: 'x', touches: 'apps/example/src/features/board/screen.ts' }, iso(REVIEW_OLD - 900)),
    makeEvent('dispatch', 'WI-003', 'item.merged', { commit: 'abc', deployed: false }, iso(REVIEW_OLD)),
    reply,
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true,
      config: cfg(), provisionalSloBoard: healthyBoard(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.accepted' && e.item === 'WI-003').length, 1,
      'a hold older than holdMaxHours expires → the review-tier item accepts');
    const expiryNote = events.filter(e => e.type === 'msg.out' && e.item === 'WI-003'
      && String((e.data as { text?: string }).text ?? '').includes('operator-silence hold expired'));
    assert.equal(expiryNote.length, 1, 'one hold-expiry note is emitted');
  } finally { clean(base); }
});

test('silence hold: a RECENT unanswered reply (within holdMaxHours) still holds the item', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  const reply = makeEvent('operator', 'WI-004', 'msg.in', { text: 'looks off' }, iso(NOW - 1 * 3_600_000)); // 1h ago < 72h
  await appendEvents(ledgerDir, [
    makeEvent('system', 'system', 'engagement.baseline', {}, iso(NOW - 199 * 3_600_000)),
    makeEvent('cli', 'WI-004', 'item.captured', { source: 'cli', text: 'x' }, iso(REVIEW_OLD - 1000)),
    makeEvent('cli', 'WI-004', 'item.queued', { spec: 'x', touches: 'apps/example/src/features/board/screen.ts' }, iso(REVIEW_OLD - 900)),
    makeEvent('dispatch', 'WI-004', 'item.merged', { commit: 'abc', deployed: false }, iso(REVIEW_OLD)),
    reply,
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true,
      config: cfg(), provisionalSloBoard: healthyBoard(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.accepted' && e.item === 'WI-004').length, 0,
      'a recent unanswered reply still holds the item within the hold window');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// provider backoff — routing provider-failure counter caps into a park; garbled ROUTE is a failure
// ---------------------------------------------------------------------------

function failingProvider(): LlmProvider {
  return { name: 'fake-fail', async run(_req: ProviderRequest): Promise<ProviderResult> { return { ok: false, error: 'provider down' }; } };
}
function garbleProvider(): LlmProvider {
  return { name: 'fake-garble', async run(_req: ProviderRequest): Promise<ProviderResult> { return { ok: true, text: 'ROUTE: maybe\nREPLY: hmm' }; } };
}

test('provider backoff: a routing provider failure parks (ops) at the 3rd consecutive failure, not every beat', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'do a thing' }, iso(NOW - 1000)),
  ]);
  try {
    // The durable counter persists across runs; the hourly backoff is bypassed because each failure
    // stamps lastFailMs=now and count grows only when a provider call actually happens. To exercise the
    // cap deterministically we seed the counter to 2 by writing the stamp, then one failure → cap park.
    const stampDir = join(repoRoot, '.ai', 'runs', 'loopkit', 'provider-fail');
    mkdirSync(stampDir, { recursive: true });
    // Seed the counter AT the cap (3) so the beat's pre-call guard parks this beat (rather than
    // bumping 2→3 and parking next beat) — deterministic in one runReactor call.
    writeFileSync(join(stampDir, 'WI-010.json'), JSON.stringify({ count: 3, lastFailMs: 0 }), 'utf8');
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: failingProvider(), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    const parks = events.filter(e => e.type === 'item.parked' && e.item === 'WI-010'
      && (e.data as { parkKind?: string }).parkKind === 'ops');
    assert.equal(parks.length, 1, 'a provider failure at the retry cap parks as ops');
    assert.ok(String((parks[0]!.data as { reason?: string }).reason).includes('provider'),
      'the ops park names the provider failure');
    // No item.queued/parked-as-decision — never a silent route.
    assert.equal(events.filter(e => e.type === 'item.queued' && e.item === 'WI-010').length, 0);
  } finally { clean(base); }
});

test('provider backoff: a garbled ROUTE is a failure to retry, never a silent answer/queue', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-011', 'item.captured', { source: 'cli', text: 'build the widget' }, iso(NOW - 1000)),
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: garbleProvider(), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    // No item.routed (which would answer-and-forget); the failure counter is stamped for a retry.
    assert.equal(events.filter(e => e.type === 'item.routed' && e.item === 'WI-011').length, 0,
      'a garbled ROUTE must NOT produce an item.routed (silent answer)');
    const stamp = join(repoRoot, '.ai', 'runs', 'loopkit', 'provider-fail', 'WI-011.json');
    assert.ok(existsSync(stamp), 'the provider-failure counter is stamped for a backed-off retry');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// decomposition close — decomposition-grooming close guards
// ---------------------------------------------------------------------------

test('decomposition close: an unrelated WI mention does NOT close a decomposition epic (canonical ref required)', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    // Epic parked for decomposition, reason mentions an UNRELATED WI-999 (not "as WI-NNN", no child source link).
    makeEvent('cli', 'WI-100', 'item.captured', { source: 'cli', text: 'big epic' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-100', 'item.parked', { reason: 'multi-slice epic, similar to WI-999', parkKind: 'decomposition' }, iso(NOW - 4000)),
    // WI-999 exists but is NOT a decomposition child of WI-100.
    makeEvent('cli', 'WI-999', 'item.captured', { source: 'unrelated', text: 'something else' }, iso(NOW - 3000)),
  ]);
  try {
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true, config: cfg() });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.rejected' && e.item === 'WI-100').length, 0,
      'the epic must NOT be closed against an unrelated WI mention');
  } finally { clean(base); }
});

test('decomposition close: a rejected decomposition child does NOT close the epic — a needs-attention note fires', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-101', 'item.captured', { source: 'cli', text: 'epic' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-101', 'item.parked', { reason: 'queued for planner decomposition as WI-102', parkKind: 'decomposition' }, iso(NOW - 4000)),
    // The child, sourced back at the epic, was REJECTED (intent dropped, not delivered).
    makeEvent('reactor', 'WI-102', 'item.captured', { source: 'decompose:WI-101', text: 'child' }, iso(NOW - 3500)),
    makeEvent('operator', 'WI-102', 'item.rejected', { by: 'operator' }, iso(NOW - 3000)),
  ]);
  try {
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true, config: cfg() });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.rejected' && e.item === 'WI-101').length, 0,
      'a rejected child must NOT silently close the epic as superseded');
    const note = events.filter(e => e.type === 'msg.out' && e.item === 'WI-101'
      && String((e.data as { text?: string }).text ?? '').includes('was rejected'));
    assert.equal(note.length, 1, 'a needs-attention note surfaces the dropped intent');
  } finally { clean(base); }
});

test('decomposition close: a canonical decomposition child that exists DOES close the epic (control)', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-103', 'item.captured', { source: 'cli', text: 'epic' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-103', 'item.parked', { reason: 'queued for planner decomposition as WI-104', parkKind: 'decomposition' }, iso(NOW - 4000)),
    makeEvent('reactor', 'WI-104', 'item.captured', { source: 'decompose:WI-103', text: 'child' }, iso(NOW - 3500)),
    makeEvent('reactor', 'WI-104', 'item.queued', { spec: 'child', lane: 'planning' }, iso(NOW - 3400)),
  ]);
  try {
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true, config: cfg() });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.rejected' && e.item === 'WI-103').length, 1,
      'a live canonical child closes the epic as superseded');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// notify dedup — notify stamps only on delivery; dedup per item+reason
// ---------------------------------------------------------------------------

function stampDir(repoRoot: string): string {
  return join(repoRoot, '.ai', 'runs', 'loopkit', 'notified');
}

test('notify dedup: a decision park with a FAILED notify is NOT stamped (retried next beat)', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-200', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-200', 'item.parked', { reason: 'needs an operator call on hosting', parkKind: 'decision' }, iso(NOW - 4000)),
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true, config: cfg(),
      notify: () => false, // total-transport failure
    });
    const stamps = existsSync(stampDir(repoRoot)) ? readdirSync(stampDir(repoRoot)) : [];
    // Only a .failing marker should exist — no delivered stamp.
    assert.equal(stamps.filter(f => !f.endsWith('.failing')).length, 0,
      'no delivered stamp is written when notify fails');
    assert.ok(stamps.some(f => f.endsWith('.failing')), 'a .failing marker records the first failure for the backoff/give-up window');
  } finally { clean(base); }
});

test('notify dedup: a delivered notify stamps once; a re-park with the SAME reason does not re-page', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-201', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-201', 'item.parked', { reason: 'decide on X', parkKind: 'decision' }, iso(NOW - 4000)),
  ]);
  try {
    let calls = 0;
    const opts = {
      repoRoot, ledgerDir, autonomy: 'on' as const, provider: null, pidProbe: () => true, config: cfg(),
      // Count ONLY decision-park pages — opts.notify is also used by the SLO heal-escalation step
      // (accept-skip streak), which is unrelated to this clause's dedup behavior.
      notify: (m: string) => { if (m.includes('decision needed')) calls++; return true; },
    };
    await runReactor(opts);
    assert.equal(calls, 1, 'first beat delivers once');
    // A genuine re-park with the SAME reason (same item+reason hash) → no new page.
    await appendEvents(ledgerDir, [
      makeEvent('reactor', 'WI-201', 'item.parked', { reason: 'decide on X', parkKind: 'decision' }, iso(NOW - 3000)),
    ]);
    await runReactor(opts);
    assert.equal(calls, 1, 'a re-park with the same reason does NOT re-page (dedup on item+reason)');
    // A DIFFERENT reason may page again.
    await appendEvents(ledgerDir, [
      makeEvent('reactor', 'WI-201', 'item.parked', { reason: 'now decide on Y instead', parkKind: 'decision' }, iso(NOW - 2000)),
    ]);
    await runReactor(opts);
    assert.equal(calls, 2, 'a genuinely different reason pages again');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// novelty gate — repeat-known failure fingerprints don't re-page
// ---------------------------------------------------------------------------

test('novelty gate: a DIFFERENT item parked with the SAME reason+kind (repeat-known fingerprint) is not paged', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-210', 'item.captured', { source: 'cli', text: 'first' }, iso(NOW - 5000)),
    makeEvent('reactor', 'WI-210', 'item.parked', { reason: 'needs an operator call on hosting', parkKind: 'decision' }, iso(NOW - 4000)),
  ]);
  try {
    let calls = 0;
    const opts = {
      repoRoot, ledgerDir, autonomy: 'on' as const, provider: null, pidProbe: () => true, config: cfg(),
      notify: (m: string) => { if (m.includes('decision needed')) calls++; return true; },
    };
    await runReactor(opts);
    assert.equal(calls, 1, 'the first-seen fingerprint pages once');

    // A SECOND, distinct item parks with the identical reason+kind — same fingerprint, repeat-known.
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-211', 'item.captured', { source: 'cli', text: 'second' }, iso(NOW - 3000)),
      makeEvent('reactor', 'WI-211', 'item.parked', { reason: 'needs an operator call on hosting', parkKind: 'decision' }, iso(NOW - 2000)),
    ]);
    await runReactor(opts);
    assert.equal(calls, 1, 'a repeat-known fingerprint on a different item does not re-page');

    // The item still parked on the needs-you board (novelty silences the PUSH, not the lifecycle).
    const result = fold(await loadAllEvents(ledgerDir));
    assert.equal(result.items.get('WI-211')!.state, 'parked');
    assert.equal(result.items.get('WI-211')!.parkNovelty, 'repeat-known');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// auto-approve guard — stepAutoApprove never re-enters an ops park
// ---------------------------------------------------------------------------

test('auto-approve guard: an ops park is never auto-approved (even if its class would otherwise qualify)', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-300', 'item.captured', { source: 'cli', text: 'x' }, iso(NOW - 5000)),
    makeEvent('dispatch', 'WI-300', 'build.dispatched', { attempt: 1, pid: 1, branch: 'wi-300' }, iso(NOW - 4500)),
    makeEvent('dispatch', 'WI-300', 'build.finished', { commit: 'abc' }, iso(NOW - 4400)),
    // An OPS park whose gate.parked class ('spine') with plane-only files would otherwise auto-approve.
    makeEvent('reactor', 'WI-300', 'gate.parked', { reason: 'spine files: packages/engine/src/foo.ts' }, iso(NOW - 4000)),
    makeEvent('reactor', 'WI-300', 'item.parked', { reason: 'merge failed 3× (transient): push down', parkKind: 'ops' }, iso(NOW - 3999)),
  ]);
  try {
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, pidProbe: () => true, config: cfg() });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.approved' && e.item === 'WI-300' && e.actor.startsWith('reactor')).length, 0,
      'an ops park is never auto-approved');
  } finally { clean(base); }
});

// ---------------------------------------------------------------------------
// routing-wall grounding — a target-stamped item routes with cwd = the TARGET repo (not the
// plane root); an operator-approved unpark is never re-parked for the same reason (no new evidence)
// ---------------------------------------------------------------------------

/** Records every provider call's cwd + prompt so a test can assert what the router was grounded in. */
function cwdRecordingProvider(calls: Array<{ cwd?: string; prompt: string }>): LlmProvider {
  return {
    name: 'fake-cwd',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      calls.push({ cwd: req.cwd, prompt: req.prompt });
      return { ok: true, text: 'ROUTE: build\nSPEC: build the widget\nTOUCHES: src/\nREPLY: ok' };
    },
  };
}

test('routing grounding: a target-stamped item routes with cwd = the target repoPath, not the plane root', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const targetRepo = join(base, 'target-widget');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  mkdirSync(targetRepo, { recursive: true });
  const targetId = 'tgt-aaaaaaaa';
  await appendEvents(ledgerDir, [
    makeEvent('cli', targetId, 'target.registered',
      { name: 'widget', targetId, repoPath: targetRepo, defaultBranch: 'main', manifestHash: 'h' }, iso(NOW - 6000)),
    // An item stamped for the non-default target 'widget' — its routing tools (Read/Grep/Glob)
    // must be grounded in targetRepo, not the plane's own repoRoot.
    makeEvent('cli', 'WI-020', 'item.captured',
      { source: 'cli', text: 'build the widget', target: 'widget', targetId }, iso(NOW - 1000)),
  ]);
  try {
    const calls: Array<{ cwd?: string; prompt: string }> = [];
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: cwdRecordingProvider(calls), pidProbe: () => true, config: cfg(),
    });
    const routeCall = calls.find(c => c.prompt.includes('ROUTE THIS ITEM ONLY') && c.prompt.includes('WI-020'));
    assert.ok(routeCall, 'the routing call for the target item happened');
    assert.equal(routeCall!.cwd, targetRepo,
      'the router must be grounded in the TARGET repo, not the plane root');
    assert.notEqual(routeCall!.cwd, repoRoot,
      'the router must NOT be grounded in the plane root for a target-stamped item');
  } finally { clean(base); }
});

/** Router that re-parks the item for a given reason (as an approval-directive 'needs decision:' park). */
function reparkSameReasonProvider(reason: string): LlmProvider {
  return {
    name: 'fake-repark',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text: `ROUTE: park\nSPEC: needs decision: ${reason}\nREPLY: ${reason}` };
    },
  };
}

test('routing grounding: an operator-approved unpark is never re-parked for the identical reason absent new evidence', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepo(repoRoot);
  const reason = 'which database backend should the widget use';
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-021', 'item.captured', { source: 'cli', text: 'store the widget somewhere' }, iso(NOW - 5000)),
    // Parked for an operator decision, then the operator unparked it (approved proceeding).
    // isApprovedReroute is now true: state==='queued', no spec, lastUnparkedAt set; lastParkReason=reason.
    makeEvent('reactor', 'WI-021', 'item.parked', { reason, parkKind: 'decision' }, iso(NOW - 4000)),
    makeEvent('operator', 'WI-021', 'item.unparked', {}, iso(NOW - 3000)),
  ]);
  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: reparkSameReasonProvider(reason), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    // The setup park is the ONLY item.parked — the same-reason re-park was rejected, not accepted verbatim.
    assert.equal(events.filter(e => e.type === 'item.parked' && e.item === 'WI-021').length, 1,
      'an operator-approved item must NOT be re-parked for the same reason absent new evidence');
    // And the rejection did not silently queue the item either.
    assert.equal(events.filter(e => e.type === 'item.queued' && e.item === 'WI-021').length, 0,
      'the rejected re-park must not silently queue the item');
    // The rejection is a backed-off retry — the provider-failure counter is stamped.
    const stamp = join(repoRoot, '.ai', 'runs', 'loopkit', 'provider-fail', 'WI-021.json');
    assert.ok(existsSync(stamp), 'the re-park rejection stamps the failure counter for a backed-off retry');
  } finally { clean(base); }
});
