/**
 * engagement-routing.test.ts — Tests for reactor engagement routing on item threads.
 *
 * Covers:
 *   parser   — parseEngagementOutcome: answer/steer/verdict/unpark/sibling round-trips + the
 *              unparseable fallbacks (missing OUTCOME/REPLY, steer/sibling without SPEC, verdict
 *              without VERDICT).
 *   projection — projectEngagement: baseline gate (dormant/pre-baseline legacy), unanswered
 *              detection, inReplyTo dedupe, and the causation hold (clear / re-arm on newer
 *              reply / hold on pending proposal).
 *   fold      — item.respec amends the spec.
 *   reactor   — stepEngageReplies via runReactor: answer emits msg.out{inReplyTo} + dedupe on the
 *              next beat; verdict is a PROPOSAL (msg.out proposal:true, no item.accepted/rejected);
 *              steer respec+requeues a pre-build item; steer on a finished item downgrades to a
 *              sibling; unparseable parks ops; a provider failure leaves the reply unanswered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold, projectEngagement } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions, parseEngagementOutcome } from '../src/beats/reactor.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { SloRow } from '../src/slo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-engagement-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

/** Provider that returns a fixed engagement block for every call. */
function makeEngageProvider(text: string, name = 'fake-engage'): LlmProvider {
  return {
    name,
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}
function makeFailingProvider(name = 'failing'): LlmProvider {
  return {
    name,
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: false, error: 'boom', code: 'unknown' };
    },
  };
}

function makeHealthyBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10s ago', target: '≤ 5m', status: 'met' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}

/** Minimal git repo + ledger + engagement.md prompt; returns dirs + cleanup. */
async function makeEnv(ledgerEvents: LedgerEvent[]): Promise<{
  repoRoot: string; ledgerDir: string; cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'runs', 'reactor'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'engagement.md'), 'ENGAGEMENT PROMPT (test stub).', 'utf8');

  const { spawnSync } = await import('node:child_process');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  await appendEvents(ledgerDir, ledgerEvents);
  return { repoRoot, ledgerDir, cleanup: () => cleanDir(base) };
}

/** Run one reactor beat with the given provider; return the full ledger. */
async function runBeat(
  repoRoot: string, ledgerDir: string, provider: LlmProvider | null,
  opts: Partial<ReactorOptions> = {},
): Promise<LedgerEvent[]> {
  await runReactor({
    repoRoot, ledgerDir, autonomy: 'on', provider,
    pidProbe: () => true,
    config: makeTestConfig(),
    provisionalSloBoard: makeHealthyBoard(),
    ...opts,
  });
  return loadAllEvents(ledgerDir);
}

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const BASELINE_TS = iso(NOW - 1_000_000);
const AFTER = (n = 1) => iso(NOW - 1_000_000 + n);

// ---------------------------------------------------------------------------
// parseEngagementOutcome
// ---------------------------------------------------------------------------

test('parse: answer round-trip', () => {
  const o = parseEngagementOutcome('OUTCOME: answer\nREPLY: Here is the answer.');
  assert.equal(o.kind, 'answer');
  assert.equal(o.reply, 'Here is the answer.');
});

test('parse: steer carries a multi-line SPEC', () => {
  const o = parseEngagementOutcome('OUTCOME: steer\nREPLY: ok\nSPEC: line one\nline two');
  assert.equal(o.kind, 'steer');
  assert.equal(o.spec, 'line one\nline two');
});

test('parse: verdict is a proposal carrying the verb', () => {
  const o = parseEngagementOutcome('OUTCOME: verdict\nREPLY: looks good\nVERDICT: accept');
  assert.equal(o.kind, 'verdict');
  assert.equal(o.verdict, 'accept');
});

test('parse: sibling round-trip', () => {
  const o = parseEngagementOutcome('OUTCOME: sibling\nREPLY: good idea\nSPEC: build the new thing');
  assert.equal(o.kind, 'sibling');
  assert.equal(o.spec, 'build the new thing');
});

test('parse: unknown/absent OUTCOME → unparseable', () => {
  assert.equal(parseEngagementOutcome('just some prose, no block').kind, 'unparseable');
  assert.equal(parseEngagementOutcome('OUTCOME: frobnicate\nREPLY: x').kind, 'unparseable');
});

test('parse: steer/sibling without SPEC, verdict without VERDICT → unparseable', () => {
  assert.equal(parseEngagementOutcome('OUTCOME: steer\nREPLY: ok').kind, 'unparseable');
  assert.equal(parseEngagementOutcome('OUTCOME: sibling\nREPLY: ok').kind, 'unparseable');
  assert.equal(parseEngagementOutcome('OUTCOME: verdict\nREPLY: ok').kind, 'unparseable');
});

test('parse: missing REPLY → unparseable', () => {
  assert.equal(parseEngagementOutcome('OUTCOME: answer').kind, 'unparseable');
});

// ---------------------------------------------------------------------------
// projectEngagement
// ---------------------------------------------------------------------------

test('projection: no baseline → dormant (nothing engaged, nothing held)', () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'hi' }, AFTER());
  const p = projectEngagement([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'x', text: 'x' }, iso(NOW - 2_000_000)),
    reply,
  ]);
  assert.equal(p.baselineTs, undefined);
  assert.equal(p.unanswered.length, 0);
  assert.equal(p.heldItems.size, 0);
});

test('projection: post-baseline unanswered reply is engaged; pre-baseline is legacy', () => {
  const preReply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'old' }, iso(NOW - 2_000_000));
  const postReply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'new' }, AFTER(5));
  const p = projectEngagement([
    preReply,
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    postReply,
  ]);
  assert.equal(p.unanswered.length, 1);
  assert.equal(p.unanswered[0]!.evId, postReply.id);
  assert.equal(p.unanswered[0]!.item, 'WI-001');
  assert.ok(p.heldItems.has('WI-001'));
});

test('projection: an answered reply (inReplyTo) is deduped and clears the hold', () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'q' }, AFTER(5));
  const p = projectEngagement([
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    reply,
    makeEvent('reactor', 'WI-001', 'msg.out', { text: 'a', inReplyTo: reply.id }, AFTER(10)),
  ]);
  assert.equal(p.unanswered.length, 0, 'answered reply is deduped');
  assert.ok(!p.heldItems.has('WI-001'), 'answered reply clears the hold');
});

test('projection: a newer reply re-arms the hold after a prior answer', () => {
  const reply1 = makeEvent('operator', 'WI-001', 'msg.in', { text: 'q1' }, AFTER(5));
  const reply2 = makeEvent('operator', 'WI-001', 'msg.in', { text: 'q2' }, AFTER(20));
  const p = projectEngagement([
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    reply1,
    makeEvent('reactor', 'WI-001', 'msg.out', { text: 'a1', inReplyTo: reply1.id }, AFTER(10)),
    reply2,
  ]);
  assert.equal(p.unanswered.length, 1);
  assert.equal(p.unanswered[0]!.evId, reply2.id);
  assert.ok(p.heldItems.has('WI-001'), 'newer unanswered reply re-arms the hold');
});

test('projection: a pending verdict proposal holds until a confirming verb', () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'is it good?' }, AFTER(5));
  const events: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    reply,
    // The proposal ANSWERS the reply (inReplyTo) but marks a pending confirm (proposal:true).
    makeEvent('reactor', 'WI-001', 'msg.out', { text: 'propose accept', inReplyTo: reply.id, proposal: true }, AFTER(10)),
  ];
  const held = projectEngagement(events);
  assert.equal(held.unanswered.length, 0, 'the reply is answered by the proposal');
  assert.ok(held.heldItems.has('WI-001'), 'a pending proposal still holds the item');

  // A confirming verb after the proposal clears the hold.
  const cleared = projectEngagement([
    ...events,
    makeEvent('operator', 'WI-001', 'item.accepted', { by: 'operator' }, AFTER(20)),
  ]);
  assert.ok(!cleared.heldItems.has('WI-001'), 'the confirm clears the proposal hold');
});

// ---------------------------------------------------------------------------
// fold: item.respec
// ---------------------------------------------------------------------------

test('fold: item.respec amends the spec', () => {
  const { items } = fold([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'x', text: 'x' }, iso(NOW - 3000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'old spec' }, iso(NOW - 2000)),
    makeEvent('reactor', 'WI-001', 'item.respec', { spec: 'new spec', reason: 'steer' }, iso(NOW - 1000)),
  ]);
  assert.equal(items.get('WI-001')!.spec, 'new spec');
});

// ---------------------------------------------------------------------------
// reactor: stepEngageReplies
// ---------------------------------------------------------------------------

test('reactor: answer emits one msg.out{inReplyTo}, then dedupes on the next beat', async () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'why?' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 2_000_000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 1_900_000)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const provider = makeEngageProvider('OUTCOME: answer\nREPLY: Because reasons.');
    const afterBeat1 = await runBeat(repoRoot, ledgerDir, provider);
    const answers = afterBeat1.filter(e => e.type === 'msg.out' && e.item === 'WI-001'
      && (e.data as { inReplyTo?: string }).inReplyTo === reply.id);
    assert.equal(answers.length, 1, 'exactly one answer emitted');
    assert.ok((answers[0]!.data as { text: string }).text.includes('Because reasons.'));

    const afterBeat2 = await runBeat(repoRoot, ledgerDir, provider);
    const answers2 = afterBeat2.filter(e => e.type === 'msg.out' && e.item === 'WI-001'
      && (e.data as { inReplyTo?: string }).inReplyTo === reply.id);
    assert.equal(answers2.length, 1, 'no re-engagement on the second beat (deduped by inReplyTo)');
  } finally {
    cleanup();
  }
});

test('reactor: verdict is a proposal — msg.out proposal:true, NO item.accepted/rejected', async () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'ship it?' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 3000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 2500)),
    // Merged very recently → provisional-accept window not due (removes accept ambiguity).
    makeEvent('dispatch', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, iso(NOW - 2000)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const provider = makeEngageProvider('OUTCOME: verdict\nREPLY: Looks correct.\nVERDICT: accept');
    const all = await runBeat(repoRoot, ledgerDir, provider);
    const proposals = all.filter(e => e.type === 'msg.out' && e.item === 'WI-001'
      && (e.data as { proposal?: boolean }).proposal === true
      && (e.data as { inReplyTo?: string }).inReplyTo === reply.id);
    assert.equal(proposals.length, 1, 'one proposal msg.out');
    assert.ok((proposals[0]!.data as { text: string }).text.includes('✅ accept WI-001'), 'names the exact confirm pattern');
    const verbs = all.filter(e => (e.type === 'item.accepted' || e.type === 'item.rejected') && e.item === 'WI-001');
    assert.equal(verbs.length, 0, 'the LLM never emits a destructive verb');
  } finally {
    cleanup();
  }
});

test('reactor: steer respec+requeues a pre-build (queued) item', async () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'actually do Y' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 3000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 2500)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const provider = makeEngageProvider('OUTCOME: steer\nREPLY: Updated.\nSPEC: do Y instead');
    const all = await runBeat(repoRoot, ledgerDir, provider);
    const respec = all.filter(e => e.type === 'item.respec' && e.item === 'WI-001');
    assert.equal(respec.length, 1, 'one item.respec');
    assert.equal((respec[0]!.data as { spec: string }).spec, 'do Y instead');
    assert.equal((respec[0]!.data as { inReplyTo?: string }).inReplyTo, reply.id);
    // A requeue with the new spec followed it.
    const requeues = all.filter(e => e.type === 'item.queued' && e.item === 'WI-001'
      && (e.data as { spec?: string }).spec === 'do Y instead');
    assert.equal(requeues.length, 1, 'requeued with the amended spec');
    assert.equal(fold(all).items.get('WI-001')!.spec, 'do Y instead');
  } finally {
    cleanup();
  }
});

test('reactor: steer on a MERGED item downgrades to a sibling (never regresses it)', async () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'also handle Z' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 3000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 2500)),
    makeEvent('dispatch', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, iso(NOW - 2000)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const provider = makeEngageProvider('OUTCOME: steer\nREPLY: Spinning that off.\nSPEC: handle Z');
    const all = await runBeat(repoRoot, ledgerDir, provider);
    assert.equal(all.filter(e => e.type === 'item.respec').length, 0, 'no respec on the merged item');
    const sibling = all.filter(e => e.type === 'item.captured'
      && (e.data as { parentItem?: string }).parentItem === 'WI-001');
    assert.equal(sibling.length, 1, 'a sibling item was captured');
    assert.equal((sibling[0]!.data as { inReplyTo?: string }).inReplyTo, reply.id);
    assert.equal((sibling[0]!.data as { text?: string }).text, 'handle Z');
  } finally {
    cleanup();
  }
});

test('reactor: unparseable engagement parks ops, never a guessed verb', async () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: '???' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 3000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 2500)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const provider = makeEngageProvider('I have no idea what to do here, sorry.');
    const all = await runBeat(repoRoot, ledgerDir, provider);
    const parks = all.filter(e => e.type === 'item.parked' && e.item === 'WI-001'
      && (e.data as { parkKind?: string }).parkKind === 'ops');
    assert.equal(parks.length, 1, 'parked as ops');
    assert.ok((parks[0]!.data as { reason: string }).reason.includes('engagement-parser'));
    // The reply is still marked answered (dedupe) via a msg.out{inReplyTo}.
    const dedupe = all.filter(e => e.type === 'msg.out' && (e.data as { inReplyTo?: string }).inReplyTo === reply.id);
    assert.equal(dedupe.length, 1, 'msg.out{inReplyTo} dedupes the reply so it is not re-engaged');
  } finally {
    cleanup();
  }
});

test('reactor: a provider failure leaves the reply UNANSWERED (re-picked next beat)', async () => {
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'why?' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 3000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 2500)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const all = await runBeat(repoRoot, ledgerDir, makeFailingProvider());
    const answered = all.filter(e => (e.data as { inReplyTo?: string }).inReplyTo === reply.id);
    assert.equal(answered.length, 0, 'no outcome emitted on provider failure');
    assert.equal(projectEngagement(all).unanswered.length, 1, 'reply stays unanswered for the next beat');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// reactor: causation hold integration (provider=null so engagement does not fire)
// ---------------------------------------------------------------------------

test('reactor causation hold: an unanswered post-baseline reply holds a due review-tier merge', async () => {
  const oldMerge = iso(NOW - 200 * 3_600_000);  // 200h ago — past the 168h review window
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, iso(NOW - 199 * 3_600_000)),
    makeEvent('operator', 'WI-050', 'item.captured', { source: 'x', text: 'x' }, iso(NOW - 201 * 3_600_000)),
    makeEvent('reactor', 'WI-050', 'item.queued', { spec: 'x', touches: 'apps/example/src/features/board/screen.ts' }, iso(NOW - 200.5 * 3_600_000)),
    makeEvent('dispatch', 'WI-050', 'item.merged', { commit: 'def', deployed: false }, oldMerge),
    // The unanswered reply must be RECENT (within the 72h holdMaxHours) — a reply
    // older than the hold window now EXPIRES the hold (the item resumes normal tier acceptance).
    makeEvent('operator', 'WI-050', 'msg.in', { text: 'this looks off' }, iso(NOW - 1 * 3_600_000)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    // provider=null → stepEngageReplies is a no-op, so the reply stays unanswered and holds.
    const all = await runBeat(repoRoot, ledgerDir, null);
    assert.equal(all.filter(e => e.type === 'item.accepted' && e.item === 'WI-050').length, 0,
      'a review-tier merge with an unanswered reply is held from auto-accept');
  } finally {
    cleanup();
  }
});

test('reactor causation hold: once the reply is answered, the review-tier merge auto-accepts', async () => {
  const oldMerge = iso(NOW - 200 * 3_600_000);
  const reply = makeEvent('operator', 'WI-051', 'msg.in', { text: 'this looks off' }, iso(NOW - 100 * 3_600_000));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, iso(NOW - 199 * 3_600_000)),
    makeEvent('operator', 'WI-051', 'item.captured', { source: 'x', text: 'x' }, iso(NOW - 201 * 3_600_000)),
    makeEvent('reactor', 'WI-051', 'item.queued', { spec: 'x', touches: 'apps/example/src/features/board/screen.ts' }, iso(NOW - 200.5 * 3_600_000)),
    makeEvent('dispatch', 'WI-051', 'item.merged', { commit: 'def', deployed: false }, oldMerge),
    reply,
    // A prior beat answered it (no pending proposal) → hold clears.
    makeEvent('reactor', 'WI-051', 'msg.out', { text: 'addressed', inReplyTo: reply.id }, iso(NOW - 99 * 3_600_000)),
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    const all = await runBeat(repoRoot, ledgerDir, null);
    assert.equal(all.filter(e => e.type === 'item.accepted' && e.item === 'WI-051').length, 1,
      'an answered reply clears the hold → the due review-tier merge auto-accepts');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// TRUST-HARDENING (FIX 2): engage lane per-item fail-closed provider resolution.
// A PRIVATE item's operator reply carries the item's spec + thread; it must never be
// engaged through the beat-global (claude/internal) provider.
// ---------------------------------------------------------------------------

test('reactor(engage): a PRIVATE item reply is left UNANSWERED fail-closed — never routed to internal', async () => {
  const reply = makeEvent('operator', 'WI-080', 'msg.in', { text: 'why?' }, AFTER(5));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, BASELINE_TS),
    makeEvent('operator', 'WI-080', 'item.captured', { source: 'x', text: 'secret work', sensitivity: 'private' }, iso(NOW - 2_000_000)),
    makeEvent('reactor', 'WI-080', 'item.queued', { spec: 'do secret', touches: 'packages/engine/' }, iso(NOW - 1_900_000)),
    reply,
  ];
  const { repoRoot, ledgerDir, cleanup } = await makeEnv(seed);
  try {
    // NO injected provider → the registry is built from cfg. internal → claude-cli, private → empty.
    // The engage step's per-item resolver must return null and leave the reply unanswered rather
    // than route the private item through the internal claude provider.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      pidProbe: () => true,
      provisionalSloBoard: makeHealthyBoard(),
      config: makeTestConfig({
        sensitivityAllowlists: { internal: ['claude-cli'], public: ['claude-cli'] },
        chains: { internal: ['claude-cli'], public: ['claude-cli'], private: [] },
      } as Partial<LoopkitConfig>),
    });

    const all = await loadAllEvents(ledgerDir);
    // No engagement answer was emitted for the private item's reply — it stays unanswered.
    const answers = all.filter(e => e.type === 'msg.out' && e.item === 'WI-080'
      && (e.data as { inReplyTo?: string }).inReplyTo === reply.id);
    assert.equal(answers.length, 0, 'a private reply must NOT be answered through a disallowed provider');
    // And the reply is still projected as unanswered (fail-closed leaves it for a later beat).
    const p = projectEngagement(all);
    assert.ok(p.unanswered.some(u => u.item === 'WI-080'), 'the private reply remains unanswered fail-closed');
  } finally {
    cleanup();
  }
});
