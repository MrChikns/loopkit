/**
 * beats.test.ts — P3 beat logic tests with injected fakes.
 *
 * Tests:
 *   1. Reactor: LOOPKIT_AUTONOMY=off is a no-op beat
 *   2. Reactor: --dry-run prints planned actions, writes nothing
 *   3. Reactor: doctor requeues a crashed dispatch (attempt < N)
 *   4. Reactor: doctor trips the breaker on the 3rd attempt
 *   5. Reactor: merges an approved item independently of dispatch
 *   6. Dispatch: LOOPKIT_AUTONOMY=off is a no-op beat
 *   7. Dispatch: --dry-run prints planned actions, writes nothing
 *   8. Dispatch: refuses overlapping Touches
 *   9. Sensitivity: private item with no allowed provider → parked, never routed to cloud
 */

import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, mkdtempSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold, ItemRecord, computeAcceptanceDebt, shouldRequeueOpsPark } from '../src/fold.js';
import { runReactor, ReactorOptions, parseRoutingDecision, dispatchKickArgs } from '../src/beats/reactor.js';
import { runDispatch, DispatchOptions, isBatchEligible, normalizeTouches, touchesSegmentMatch, parsePlannerRemaining, buildPlannerPrompt, hasUnconsumedCancelRequest } from '../src/beats/dispatch.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { makeRegistry } from '../src/providers/registry.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { writeExitFile, usageJsonPath } from '../src/exitfile.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-test-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A fake provider that always returns success with a fixed text. */
function makeFakeProvider(text = 'fake-reply', name = 'fake'): LlmProvider {
  return {
    name,
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

/**
 * A fake provider that mimics claudeCli.ts's real detached+exit-file contract — calls
 * `onSpawn` synchronously with a pgid and, when `req.exitFile` is set, writes the exit-file
 * protocol (a raw claude-cli-shaped JSON payload as the usage json + the exit sentinel) exactly
 * as the real provider would, so dispatch.ts's collection path has a real on-disk artifact to
 * read back. Lets tests exercise the pgid + exit-file plumbing without spawning a real `claude`.
 */
function makeDetachedFakeProvider(opts: {
  resultText: string;
  usage?: { in: number; out: number; usd?: number };
  pgid: number;
  name?: string;
}): LlmProvider {
  return {
    name: opts.name ?? 'fake-detached',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      if (req.detached && req.onSpawn) req.onSpawn(opts.pgid);
      if (req.exitFile) {
        const raw = {
          result: opts.resultText,
          total_cost_usd: opts.usage?.usd ?? 0,
          usage: { input_tokens: opts.usage?.in ?? 1, output_tokens: opts.usage?.out ?? 1 },
        };
        const path = usageJsonPath(req.exitFile.runDir, req.exitFile.itemId, req.exitFile.attempt);
        mkdirSync(req.exitFile.runDir, { recursive: true });
        writeFileSync(path, JSON.stringify(raw), 'utf8');
        writeExitFile(req.exitFile.runDir, req.exitFile.itemId, req.exitFile.attempt, {
          exitCode: 0, usageJsonPath: path,
        });
      }
      return { ok: true, text: opts.resultText, usage: opts.usage };
    },
  };
}

/** A fake provider that always returns an error. */
function makeFailingProvider(error = 'provider-error', name = 'failing'): LlmProvider {
  return {
    name,
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: false, error, code: 'unknown' };
    },
  };
}

/** Minimal test config that avoids running real npm test / git ops. */
function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
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

/** Write some initial ledger events to a temp ledger dir. */
async function seedLedger(ledgerDir: string, events: LedgerEvent[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

// ---------------------------------------------------------------------------
// Reactor tests
// ---------------------------------------------------------------------------

test('reactor: LOOPKIT_AUTONOMY=off is a no-op beat', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // Seed a captured item
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'do something' }),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'off',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.equal(result.totalEventsWritten, 0);
    assert.ok(result.steps.length >= 1);
    assert.ok(result.steps[0].detail?.includes('LOOPKIT_AUTONOMY=off'));

    // Ledger should still only have the original event
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-001').length, 1);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: LOOPKIT_AUTONOMY unset → fail-safe OFF (no-op, stderr message)', async () => {
  // When neither opts.autonomy nor the env var is set, the reactor must default
  // to OFF (fail-safe) and emit the pinned warning on stderr.
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  // Temporarily clear the env variable to simulate an unset env (bare/cron/test invocation).
  const saved = process.env['LOOPKIT_AUTONOMY'];
  delete process.env['LOOPKIT_AUTONOMY'];
  let stderrLine = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { stderrLine += s; return true; };
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'do something' }),
    ]);

    // opts.autonomy is NOT passed — relies on env fallback
    const result = await runReactor({
      repoRoot,
      ledgerDir,
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.equal(result.totalEventsWritten, 0, 'unset env must no-op (fail-safe OFF)');
    assert.ok(result.steps[0].detail?.includes('LOOPKIT_AUTONOMY=off'), 'detail must reference the off state');
    assert.ok(stderrLine.includes('[loopkit] LOOPKIT_AUTONOMY unset'), 'must log the fail-safe warning to stderr');
    assert.ok(stderrLine.includes('fail-safe'), 'stderr line must mention fail-safe');
  } finally {
    (process.stderr as unknown as { write: (s: string) => boolean }).write = origWrite;
    if (saved !== undefined) process.env['LOOPKIT_AUTONOMY'] = saved; else delete process.env['LOOPKIT_AUTONOMY'];
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: dry-run writes nothing to ledger', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    const initialEvent = makeEvent('cli', 'WI-001', 'item.captured', {
      source: 'test', text: 'dry run test',
    });
    await seedLedger(ledgerDir, [initialEvent]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.ok(result.dryRun);
    // Ledger should not have grown (no events written in dry-run)
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 1, 'dry-run should not write to ledger');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Routing decision parser — the deterministic wall the conductor prompt feeds
// ---------------------------------------------------------------------------

test('parseRoutingDecision: build block yields structured queue fields', () => {
  const d = parseRoutingDecision([
    'ROUTE: build',
    'SPEC: Add a closed-today banner to the calendar day view.',
    'TOUCHES: apps/example/src/slices/calendar/',
    'MODEL: sonnet',
    'PRIORITY: high',
    'REPLY: On it — queuing the calendar banner slice.',
  ].join('\n'));
  assert.equal(d.route, 'build');
  assert.equal(d.spec, 'Add a closed-today banner to the calendar day view.');
  assert.equal(d.touches, 'apps/example/src/slices/calendar/');
  assert.equal(d.model, 'sonnet');
  assert.equal(d.priority, 'high');
  assert.equal(d.reply, 'On it — queuing the calendar banner slice.');
});

test('parseRoutingDecision: TITLE parses when present, absent when omitted', () => {
  const withTitle = parseRoutingDecision([
    'ROUTE: build',
    'SPEC: Add a closed-today banner to the calendar day view.',
    'TITLE: Calendar closed-today banner',
    'REPLY: On it.',
  ].join('\n'));
  assert.equal(withTitle.title, 'Calendar closed-today banner');

  const noTitle = parseRoutingDecision('ROUTE: answer\nREPLY: all good');
  assert.equal(noTitle.title, undefined);
});

test('parseRoutingDecision: park + answer route to their classes', () => {
  const park = parseRoutingDecision('ROUTE: park\nSPEC: Hosted PG is costly+irreversible.\nREPLY: Parked for your call.');
  assert.equal(park.route, 'park');
  assert.equal(park.spec, 'Hosted PG is costly+irreversible.');
  assert.equal(park.reply, 'Parked for your call.');

  const answer = parseRoutingDecision('ROUTE: answer\nREPLY: The reactor is live and nothing is blocked.');
  assert.equal(answer.route, 'answer');
  assert.equal(answer.reply, 'The reactor is live and nothing is blocked.');
});

test('parseRoutingDecision: sloppy output degrades safely', () => {
  // Unknown route → answer; invalid model/priority dropped (dispatch defaults apply).
  const bad = parseRoutingDecision('ROUTE: maybe\nMODEL: gpt4\nPRIORITY: urgent\nREPLY: hmm');
  assert.equal(bad.route, 'answer');
  assert.equal(bad.model, undefined);
  assert.equal(bad.priority, undefined);
  // A block WITH a garbled ROUTE is routeValid:false (caller retries, never a
  // silent answer that could answer-and-forget a build request).
  assert.equal(bad.routeValid, false, 'garbled ROUTE in a present block is not a valid route');

  // No block at all → deliver the whole text as an answer, never lose the item.
  const prose = parseRoutingDecision('just some free text with no keys');
  assert.equal(prose.route, 'answer');
  assert.equal(prose.reply, 'just some free text with no keys');
  // A plain-text answer (no block) IS a legitimate route — routeValid stays true.
  assert.equal(prose.routeValid, true, 'a bare plain-text answer is a legitimate route, not a garble');
  // A valid explicit route is routeValid:true.
  assert.equal(parseRoutingDecision('ROUTE: build\nSPEC: x').routeValid, true);

  // Multi-line SPEC spans following non-key lines.
  const ml = parseRoutingDecision('ROUTE: build\nSPEC: line one\nline two\nTOUCHES: packages/engine/src/');
  assert.equal(ml.spec, 'line one\nline two');
  assert.equal(ml.touches, 'packages/engine/src/');
});

// The router wall assigns a delivery lane from the LANE: line.
test('parseRoutingDecision: LANE assigns marketing for a marketing-intent routing', () => {
  const marketing = parseRoutingDecision([
    'ROUTE: build',
    'SPEC: Draft the homepage marketing copy in the operator voice.',
    'LANE: marketing',
    'REPLY: On it — drafting the homepage copy.',
  ].join('\n'));
  assert.equal(marketing.lane, 'marketing');
});

test('parseRoutingDecision: LANE defaults engineering for a code routing and drops unknown lanes', () => {
  // An engineering intent with no LANE line → the engineering reference lane.
  const eng = parseRoutingDecision([
    'ROUTE: build',
    'SPEC: Fix the calendar save button and add a migration.',
    'TOUCHES: apps/example/src/slices/calendar/',
    'REPLY: Queuing the calendar fix.',
  ].join('\n'));
  assert.equal(eng.lane, 'engineering');

  // Explicit engineering lane stays engineering; an unrecognized lane degrades to engineering.
  assert.equal(parseRoutingDecision('ROUTE: build\nLANE: engineering\nREPLY: ok').lane, 'engineering');
  assert.equal(parseRoutingDecision('ROUTE: build\nLANE: sales\nREPLY: ok').lane, 'engineering');
  // Even a pure answer carries a resolved lane (never undefined).
  assert.equal(parseRoutingDecision('ROUTE: answer\nREPLY: all good').lane, 'engineering');
});

test('parseRoutingDecision: EFFORT parses valid levels, drops invalid ones', () => {
  // Valid effort levels are accepted
  assert.equal(parseRoutingDecision('ROUTE: build\nEFFORT: high\nREPLY: ok').effort, 'high');
  assert.equal(parseRoutingDecision('ROUTE: build\nEFFORT: max\nREPLY: ok').effort, 'max');
  assert.equal(parseRoutingDecision('ROUTE: build\nEFFORT: low\nREPLY: ok').effort, 'low');

  // Invalid/unknown effort drops to undefined; dispatch uses its default
  assert.equal(parseRoutingDecision('ROUTE: build\nEFFORT: maximum\nREPLY: ok').effort, undefined);
  assert.equal(parseRoutingDecision('ROUTE: build\nEFFORT: invalid\nREPLY: ok').effort, undefined);

  // Absent effort is undefined (no default assigned)
  assert.equal(parseRoutingDecision('ROUTE: build\nREPLY: ok').effort, undefined);
});

test('reactor: route step parses a build reply into item.queued + queued state', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // The route step reads the conductor prompt-of-record from the repo; a stub suffices
    // (the fake provider ignores it and returns a fixed structured block).
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-050', 'item.captured', { source: 'test', text: 'add a banner' }),
    ]);

    const buildBlock = [
      'ROUTE: build',
      'SPEC: Add the banner slice.',
      'TOUCHES: apps/example/src/slices/calendar/',
      'MODEL: sonnet',
      'PRIORITY: medium',
      'REPLY: Queuing it now.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(buildBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-050' && e.actor === 'reactor');
    assert.equal(queued.length, 1, 'route step should emit one item.queued for a build reply');
    const d = queued[0].data as Record<string, unknown>;
    assert.equal(d['spec'], 'Add the banner slice.');
    assert.equal(d['touches'], 'apps/example/src/slices/calendar/');
    assert.equal(d['model'], 'sonnet');
    assert.equal(d['priority'], 'medium');

    const routed = events.filter(e => e.type === 'item.routed' && e.item === 'WI-050');
    assert.equal(routed.length, 1);
    assert.equal((routed[0].data as Record<string, unknown>)['route'], 'build');

    // Fold: item.queued precedes item.routed, so the item rests in 'queued' (dispatchable).
    const item = fold(events).items.get('WI-050');
    assert.equal(item?.state, 'queued', `item should be queued (got ${item?.state})`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: route step carries EFFORT from the conductor block onto item.queued', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-051', 'item.captured', { source: 'test', text: 'a hard refactor' }),
    ]);

    const buildBlock = [
      'ROUTE: build',
      'SPEC: Do the hard refactor.',
      'TOUCHES: apps/example/src/slices/calendar/',
      'MODEL: opus',
      'EFFORT: high',
      'REPLY: Queuing it now.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(buildBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-051' && e.actor === 'reactor');
    assert.equal(queued.length, 1);
    const d = queued[0].data as Record<string, unknown>;
    assert.equal(d['effort'], 'high');

    const item = fold(events).items.get('WI-051');
    assert.equal(item?.effort, 'high');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: a fresh item.queued from stepRoute kicks dispatch immediately', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const savedAutonomy = process.env['LOOPKIT_AUTONOMY'];
  try {
    delete process.env['LOOPKIT_AUTONOMY'];
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-360', 'item.captured', { source: 'test', text: 'add a banner' }),
    ]);

    const buildBlock = [
      'ROUTE: build',
      'SPEC: Add the banner slice.',
      'TOUCHES: apps/example/src/slices/calendar/',
      'REPLY: Queuing it now.',
    ].join('\n');

    const kicks: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(buildBlock),
      config: makeTestConfig({ dispatchKickLabel: 'com.example.dispatch' }),
      kickDispatch: (label: string) => { kicks.push(label); },
    });

    assert.deepEqual(kicks, ['com.example.dispatch'], 'a fresh item.queued must kick dispatch exactly once');
  } finally {
    if (savedAutonomy === undefined) delete process.env['LOOPKIT_AUTONOMY']; else process.env['LOOPKIT_AUTONOMY'] = savedAutonomy;
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: dispatchKickArgs is NON-destructive (kickstart WITHOUT -k, never SIGKILLs a mid-build beat)', () => {
  const args = dispatchKickArgs(501, 'com.example.dispatch');
  assert.deepEqual(args, ['kickstart', 'gui/501/com.example.dispatch']);
  assert.ok(!args.includes('-k'), 'routine dispatch kick must not use -k: it would kill the beat mid-build (the 2026-07-17 churn)');
});

test('reactor: the default kickDispatch no-ops when dispatchKickLabel is unset (test-safe default)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-361', 'item.captured', { source: 'test', text: 'add a banner' }),
    ]);

    const buildBlock = [
      'ROUTE: build',
      'SPEC: Add the banner slice.',
      'TOUCHES: apps/example/src/slices/calendar/',
      'REPLY: Queuing it now.',
    ].join('\n');

    // No kickDispatch injected and no dispatchKickLabel set — the real launchctl path must
    // no-op rather than actually spawn (makeTestConfig leaves dispatchKickLabel at its '' default).
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(buildBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-361');
    assert.equal(queued.length, 1, 'sanity: the item still queues normally');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: re-routes a spec-less queued item (unparked decision-park) into item.queued', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    // An item parked at routing time (decision, never a spec) then unparked by the operator:
    // fold state = 'queued' with NO spec. Before the fix, dispatch skips it forever and no beat
    // re-routes it (the orphan class).
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-290', 'item.captured', { source: 'test', text: 'build a durable retry outbox' }),
      makeEvent('reactor', 'WI-290', 'item.parked', { reason: 'decision: build it now?', parkKind: 'decision' }),
      makeEvent('cli', 'WI-290', 'item.unparked', { by: 'operator' }),
    ]);

    // Pre-condition: the seeded item is spec-less and queued.
    const before = fold(await loadAllEvents(ledgerDir)).items.get('WI-290');
    assert.equal(before?.state, 'queued');
    assert.ok(!before?.spec, 'pre-condition: item must have no spec');

    // Capture the routing prompt so we can assert the approval directive is injected.
    let seenPrompt = '';
    const capturingProvider: LlmProvider = {
      name: 'capturing',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        seenPrompt = req.prompt;
        return {
          ok: true,
          text: ['ROUTE: build', 'SPEC: Build the retry outbox slice.', 'TOUCHES: apps/example/src/public/', 'REPLY: Building it now.'].join('\n'),
          usage: { in: 0, out: 1, usd: 0 },
        };
      },
    };

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: capturingProvider,
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-290' && e.actor === 'reactor');
    assert.equal(queued.length, 1, 'a spec-less queued item must be re-routed into one item.queued');
    assert.equal((queued[0].data as Record<string, unknown>)['spec'], 'Build the retry outbox slice.');

    // Now dispatchable: queued WITH a spec.
    const after = fold(events).items.get('WI-290');
    assert.equal(after?.state, 'queued');
    assert.ok(after?.spec, 'item must now carry a build spec');

    // The approval directive must reach the classifier so it builds (not re-parks).
    assert.ok(seenPrompt.includes('OPERATOR APPROVED'), 'routing prompt must carry the approval directive');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: approved epic re-park is parkKind:decomposition, NOT decision (no operator-desk bounce)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    // An approved (unparked) spec-less item that the classifier judges a multi-slice epic.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-292', 'item.captured', { source: 'test', text: 'close the epic-unblock loop (multi-piece)' }),
      makeEvent('reactor', 'WI-292', 'item.parked', { reason: 'design decision', parkKind: 'decision' }),
      makeEvent('cli', 'WI-292', 'item.unparked', { by: 'operator' }),
    ]);

    const parkBlock = [
      'ROUTE: park',
      'SPEC: needs planner decomposition: this bundles multiple cross-cutting slices.',
      'REPLY: Approved — handing it to the planner, not your desk.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(parkBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    // Assert on the re-route's park (the last one — the first is the seeded pre-approval park).
    const parks = events.filter(e => e.type === 'item.parked' && e.item === 'WI-292');
    const reroutePark = parks[parks.length - 1];
    // The load-bearing assertion: an approved epic must NOT re-park as parkKind:decision (that is
    // the bounce). It must be parkKind:decomposition so the operator-desk filter drops it.
    assert.equal((reroutePark.data as Record<string, unknown>)['parkKind'], 'decomposition',
      'approved epic re-park must be decomposition, not an operator-desk decision');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: a decision-park unparked then FRESHLY reclassified as decomposition by stepRoute queues exactly one planning-lane child', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    // A decision park (NOT decomposition) that the operator approves — the classifier only
    // discovers it's a multi-slice epic THIS beat, inside stepRoute's isDecomp reclassify.
    // Before the fix, this reroute stranded the approval: no planning child was ever queued
    // (stepDecompositionUnpark only fires when the park was ALREADY tagged 'decomposition').
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-271', 'item.captured', { source: 'test', text: 'close the epic-unblock loop (multi-piece)' }),
      makeEvent('reactor', 'WI-271', 'item.parked', { reason: 'design decision', parkKind: 'decision' }),
      makeEvent('cli', 'WI-271', 'item.unparked', { by: 'operator' }),
    ]);

    const parkBlock = [
      'ROUTE: park',
      'SPEC: needs planner decomposition: this bundles multiple cross-cutting slices.',
      'REPLY: Approved — handing it to the planner, not your desk.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(parkBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);

    // Exactly one planning-lane child must be captured — no stranding, no double-queue.
    const captured = events.filter(e => e.type === 'item.captured' && e.actor === 'reactor');
    assert.equal(captured.length, 1, 'exactly one planning-lane child must be captured');
    const childId = captured[0].item;
    assert.equal((captured[0].data as Record<string, unknown>)['source'], 'decompose:WI-271');

    const folded = fold(events);
    const child = folded.items.get(childId);
    assert.equal(child?.lane, 'planning', 'child item must carry lane=planning');
    assert.equal(child?.state, 'queued');
    assert.ok((child?.spec ?? '').startsWith('decompose WI-271:'),
      'child spec must follow the "decompose <epic-id>: <reason>" format');

    // The epic itself rests parked as decomposition — off the operator's desk, tracked by a child.
    const epic = folded.items.get('WI-271');
    assert.equal(epic?.state, 'parked');
    assert.equal(epic?.parkKind, 'decomposition');

    // No child-of-child recursion: the newly captured child must not itself spawn a child.
    const childCaptures = events.filter(e => e.type === 'item.captured' && e.item === childId);
    assert.equal(childCaptures.length, 1);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: unparking a decomposition park deterministically queues a lane=planning item (zero-LLM)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    // A decomposition park that the operator then unparks — this step
    // closes: previously nothing acted on this, the item just orphaned in 'queued'.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-400', 'item.captured', { source: 'test', text: 'a big multi-slice epic' }),
      makeEvent('reactor', 'WI-400', 'item.parked', {
        reason: 'needs planner decomposition: bundles multiple cross-cutting slices.',
        parkKind: 'decomposition',
      }),
      makeEvent('cli', 'WI-400', 'item.unparked', { by: 'operator' }),
    ]);

    let classifierCalled = false;
    const provider: LlmProvider = {
      name: 'should-not-be-called',
      async run(): Promise<ProviderResult> {
        classifierCalled = true;
        return { ok: true, text: 'ROUTE: answer\nREPLY: no.' };
      },
    };

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig() });

    assert.equal(classifierCalled, false,
      'the decomposition-unpark handler must be zero-LLM — it must run before stepRoute and never hand this item to the classifier');

    const events = await loadAllEvents(ledgerDir);
    const captured = events.filter(e => e.type === 'item.captured' && e.actor === 'reactor');
    assert.equal(captured.length, 1, 'exactly one planning-lane child must be captured');
    const childId = captured[0].item;

    const folded = fold(events);
    const child = folded.items.get(childId);
    assert.equal(child?.lane, 'planning', 'child item must carry lane=planning');
    assert.equal(child?.state, 'queued');
    assert.ok((child?.spec ?? '').startsWith('decompose WI-400:'),
      'child spec must follow the "decompose <epic-id>: <reason>" format');

    // The epic itself rests parked again (decomposition) — never re-enters stepRoute this beat.
    const epic = folded.items.get('WI-400');
    assert.equal(epic?.state, 'parked');
    assert.equal(epic?.parkKind, 'decomposition');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: a decomposition park referencing an already-captured child auto-closes (grooming, zombie fix)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    // The epic rests parked (decomposition) referencing its already-spun-off planning child —
    // exactly the state stepDecompositionUnpark leaves behind, and exactly what previously sat
    // forever as a zombie (nothing ever closed the parent once the child existed).
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-500', 'item.captured', { source: 'test', text: 'a big multi-slice epic' }),
      makeEvent('reactor', 'WI-500', 'item.parked', {
        reason: 'queued for planner decomposition as WI-501',
        parkKind: 'decomposition',
      }),
      makeEvent('reactor', 'WI-501', 'item.captured', { source: 'decompose:WI-500', text: 'decompose WI-500: slice 1' }),
      makeEvent('reactor', 'WI-501', 'item.queued', { spec: 'decompose WI-500: slice 1', lane: 'planning' }),
    ]);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: makeFakeProvider(), config: makeTestConfig() });

    const events = await loadAllEvents(ledgerDir);
    const rejects = events.filter(e => e.item === 'WI-500' && e.type === 'item.rejected');
    assert.equal(rejects.length, 1, 'the superseded epic must be closed exactly once');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-500')?.state, 'rejected', 'closed epic reaches a terminal state');
    assert.equal(folded.items.get('WI-501')?.state, 'queued', 'the planning child is untouched');

    // A second beat must not double-close an already-terminal item (idempotent replay).
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: makeFakeProvider(), config: makeTestConfig() });
    const events2 = await loadAllEvents(ledgerDir);
    const rejects2 = events2.filter(e => e.item === 'WI-500' && e.type === 'item.rejected');
    assert.equal(rejects2.length, 1, 'a later beat must not re-close an already-rejected item');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: approved item with a remaining specific choice re-parks as decision (stays on desk)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-300', 'item.captured', { source: 'test', text: 'set up off-host backups' }),
      makeEvent('reactor', 'WI-300', 'item.parked', { reason: 'which destination?', parkKind: 'decision' }),
      makeEvent('cli', 'WI-300', 'item.unparked', { by: 'operator' }),
    ]);

    const parkBlock = [
      'ROUTE: park',
      'SPEC: needs decision: S3, rsync, or iCloud for the off-host copy?',
      'REPLY: One thing left to pick.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(parkBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const parks = events.filter(e => e.type === 'item.parked' && e.item === 'WI-300');
    const reroutePark = parks[parks.length - 1];
    assert.equal((reroutePark.data as Record<string, unknown>)['parkKind'], 'decision',
      'a genuine remaining choice must stay an operator-desk decision');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: a fresh park whose reason names a dependency stores the operator\'s capture text as storedSpec', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-360', 'item.captured', {
        source: 'test',
        text: 'Extend the fold to a 30d horizon (depends on WI-359). Do not start before WI-359 is merged.',
      }),
    ]);

    const parkBlock = [
      'ROUTE: park',
      'SPEC: WI-360 explicitly depends on WI-359, which has not merged yet.',
      'REPLY: Holding this one until WI-359 merges.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(parkBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const park = events.find(e => e.type === 'item.parked' && e.item === 'WI-360');
    assert.ok(park, 'item.parked must be emitted');
    const d = park!.data as Record<string, unknown>;
    assert.equal(d['parkKind'], 'decision');
    assert.equal(d['storedSpec'], 'Extend the fold to a 30d horizon (depends on WI-359). Do not start before WI-359 is merged.',
      'storedSpec must be the operator\'s original capture text, verbatim (transcribe, never invent)');

    const item = fold(events).items.get('WI-360');
    assert.equal(item?.storedSpec, d['storedSpec']);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: a park with no dependency phrasing in the reason never gets a storedSpec', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-301', 'item.captured', { source: 'test', text: 'set up hosted Postgres' }),
    ]);

    const parkBlock = [
      'ROUTE: park',
      'SPEC: needs decision: hosted PG is costly and irreversible.',
      'REPLY: Parked for your call.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(parkBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const park = events.find(e => e.type === 'item.parked' && e.item === 'WI-301');
    assert.ok(park, 'item.parked must be emitted');
    assert.equal((park!.data as Record<string, unknown>)['storedSpec'], undefined,
      'a plain operator-decision park (no named dependency) must never get a storedSpec');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: doctor requeues a crashed orphan (attempt < N)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  // Create the runs/loopkit dir so the lock can be created
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    // Seed an item that is currently "building" with a dead pid
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', {
        source: 'test', text: 'build something',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'build something',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', {
        attempt: 1,
        pid: 999999,  // dead pid (won't exist)
        branch: 'wi-001',
        worktree: '/tmp/wi-001',
        provider: 'claude-cli',
        model: 'sonnet',
      }, '2026-01-01T00:02:00Z'),
    ]);

    // Dead pid probe
    const deadPidProbe = () => false;

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,  // no routing needed
      pidProbe: deadPidProbe,
      config: makeTestConfig({ breakerN: 3 }),
    });

    // Doctor step should have detected the orphan and requeued it
    const doctorStep = result.steps.find(s => s.step === 'doctor');
    assert.ok(doctorStep, 'doctor step should exist');
    assert.ok(doctorStep.ok, `doctor step failed: ${doctorStep.detail}`);
    assert.ok(doctorStep.eventsWritten >= 2, `doctor should write build.crashed + item.queued (got ${doctorStep.eventsWritten})`);

    // Verify ledger has build.crashed and item.queued events
    const events = await loadAllEvents(ledgerDir);
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-001');
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-001' && e.actor === 'reactor');
    assert.equal(crashed.length, 1, 'should have one build.crashed event');
    assert.equal(requeued.length, 1, 'should have one requeue event');

    // Fold should show item back in queued state
    const finalFold = fold(events);
    const item = finalFold.items.get('WI-001');
    assert.ok(item, 'item should exist');
    assert.equal(item.state, 'queued', `item should be queued after requeue (got ${item.state})`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: doctor trips breaker on 3rd attempt', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    // Seed: 2 prior crashes, now on 3rd dispatch with dead pid
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'test', text: 'test' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-002', 'item.queued', { spec: 'test' }, '2026-01-01T00:01:00Z'),
      // Attempt 1
      makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
      makeEvent('doctor', 'WI-002', 'build.crashed', { reason: 'orphan-detected' }, '2026-01-01T00:03:00Z'),
      makeEvent('doctor', 'WI-002', 'item.queued', { spec: 'test' }, '2026-01-01T00:03:01Z'),
      // Attempt 2
      makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 2, pid: 2 }, '2026-01-01T00:04:00Z'),
      makeEvent('doctor', 'WI-002', 'build.crashed', { reason: 'orphan-detected' }, '2026-01-01T00:05:00Z'),
      makeEvent('doctor', 'WI-002', 'item.queued', { spec: 'test' }, '2026-01-01T00:05:01Z'),
      // Attempt 3 — currently "building" with dead pid
      makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 3, pid: 99999 }, '2026-01-01T00:06:00Z'),
    ]);

    const deadPidProbe = () => false;

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      pidProbe: deadPidProbe,
      config: makeTestConfig({ breakerN: 3 }),
    });

    const doctorStep = result.steps.find(s => s.step === 'doctor');
    assert.ok(doctorStep?.ok, `doctor failed: ${doctorStep?.detail}`);
    // Should have written build.crashed + item.parked (breaker trip = 2 events)
    assert.ok(doctorStep.eventsWritten >= 2, `expected >=2 events (got ${doctorStep.eventsWritten})`);

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-002' && e.actor === 'reactor');
    assert.equal(parked.length, 1, 'should have one park event from breaker');

    const parkedReason = (parked[0].data as { reason: string }).reason;
    assert.ok(parkedReason.includes('breaker'), `park reason should mention breaker (got: ${parkedReason})`);

    // Fold should show item in parked state
    const finalFold = fold(events);
    const item = finalFold.items.get('WI-002');
    assert.equal(item?.state, 'parked');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: approved item merges independently (no dispatch needed)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    // Seed: an approved item that has a branch
    // In tests we can't actually do a real git merge, so we test that the
    // apply-verbs step runs, sees the approved item, and either writes events
    // or notes the branch is missing (branch doesn't exist in this temp dir).
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-003', 'item.captured', { source: 'test', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-003', 'item.queued', { spec: 'build X' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-003', 'build.dispatched', {
        attempt: 1, pid: 1, branch: 'wi-003', worktree: '/tmp/wi-003',
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-003', 'gate.parked', { reason: 'spine' }, '2026-01-01T00:03:00Z'),
      makeEvent('dispatch', 'WI-003', 'item.parked', {
        reason: 'needs-decision: touches spine',
      }, '2026-01-01T00:03:01Z'),
      makeEvent('operator', 'WI-003', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      branchProbe: () => 'master', // temp dir is not a git repo; simulate a clean master tree
      config: makeTestConfig(),
    });

    // The apply-verbs step should run and attempt to handle the approved item.
    // Since we're in a temp dir without the branch, it should write gate.failed
    // (branch missing) or item.parked events — but NOT simply skip approved items.
    const verbsStep = result.steps.find(s => s.step === 'apply-verbs');
    assert.ok(verbsStep, 'apply-verbs step must exist');
    // Step should have run (ok is acceptable regardless of branch existence)
    // The key invariant: it processed the approved item (didn't ignore it)
    // We check by looking at events written (either failed + parked, or gate.failed)
    const events = await loadAllEvents(ledgerDir);
    const newEvents = events.filter(e =>
      e.item === 'WI-003' &&
      (e.type === 'gate.failed' || e.type === 'gate.passed' || e.type === 'item.parked' || e.type === 'item.merged')
      && e.actor === 'reactor'
    );
    // At minimum we expect the reactor to have written something about the approved item
    // (gate.failed because branch doesn't exist in the temp dir)
    assert.ok(newEvents.length > 0, `reactor should have processed approved item WI-003; new events: ${newEvents.map(e => e.type).join(',')}`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: approved item with prior merge.transient-fail is re-selected by apply-verbs', async () => {
  // An item that received a merge.transient-fail should stay in state=approved (fold check)
  // and be selected again by stepApplyVerbs on the next beat (integration check).
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-050', 'item.captured', { source: 'test', text: 'fix Y' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-050', 'item.queued', { spec: 'fix Y' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-050', 'build.dispatched', {
        attempt: 1, pid: 1, branch: 'wi-050',
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-050', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-050', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
      // A prior transient failure — item must still be state=approved, not parked
      makeEvent('reactor', 'WI-050', 'merge.transient-fail', {
        reason: 'push to origin failed: rejected (non-fast-forward)',
        transientCount: 1,
      }, '2026-01-01T00:05:00Z'),
    ]);

    // Verify fold state is still approved before the beat runs
    const preFoldEvents = await loadAllEvents(ledgerDir);
    const preFold = fold(preFoldEvents);
    assert.equal(preFold.items.get('WI-050')?.state, 'approved', 'fold: approved after merge.transient-fail');
    assert.equal(preFold.items.get('WI-050')?.transientFailCount, 1);

    // Run the reactor — branch 'wi-050' doesn't exist in the temp dir, so
    // apply-verbs will attempt the branch check and write gate.failed (branch missing),
    // proving the item was selected again (not skipped because it was stuck in parked).
    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
    });

    const verbsStep = result.steps.find(s => s.step === 'apply-verbs');
    assert.ok(verbsStep, 'apply-verbs step must exist');

    const afterEvents = await loadAllEvents(ledgerDir);
    const reactorActivity = afterEvents.filter(e =>
      e.item === 'WI-050' && e.actor === 'reactor'
    );
    assert.ok(reactorActivity.length > 0,
      `reactor must have processed WI-050 again; got events: ${reactorActivity.map(e => e.type).join(',')}`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Gate-timeout transient handling
// ---------------------------------------------------------------------------

test('reactor: gate timeout emits merge.transient-fail, item stays approved (retry)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gate-timeout-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-007']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-007']);
    g(['checkout', 'master']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-007', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-007', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-007', 'build.dispatched', {
        attempt: 1, branch: 'wi-007', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-007', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-007', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner: () => ({ passed: false, timedOut: true, reason: 'gate killed after 600000ms' }),
    });

    const events = await loadAllEvents(ledgerDir);

    // Must emit merge.transient-fail, not gate.failed or item.parked
    const transient = events.filter(e => e.type === 'merge.transient-fail' && e.item === 'WI-007');
    assert.equal(transient.length, 1, 'first timeout must emit merge.transient-fail');
    assert.equal((transient[0].data as { transientCount: number }).transientCount, 1);

    assert.equal(events.filter(e => e.type === 'gate.failed' && e.item === 'WI-007').length, 0,
      'timeout must not emit gate.failed (not test-red)');
    assert.equal(events.filter(e => e.type === 'item.parked' && e.item === 'WI-007').length, 0,
      'item must not be parked on first timeout');

    // Fold: item stays approved, transientFailCount incremented
    const folded = fold(events);
    assert.equal(folded.items.get('WI-007')?.state, 'approved', 'item must stay approved after timeout');
    assert.equal(folded.items.get('WI-007')?.transientFailCount, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: gate timeout 3× parks with timeout-not-red message (retry cap)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gate-timeout-cap-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-008']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-008']);
    g(['checkout', 'master']);

    // Pre-seed 2 prior gate timeouts (transientFailCount = 2; item stays approved)
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-008', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-008', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-008', 'build.dispatched', {
        attempt: 1, branch: 'wi-008', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-008', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-008', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
      makeEvent('reactor', 'WI-008', 'merge.transient-fail', {
        reason: 'gate killed after 600000ms', transientCount: 1,
      }, '2026-01-01T00:05:00Z'),
      makeEvent('reactor', 'WI-008', 'merge.transient-fail', {
        reason: 'gate killed after 600000ms', transientCount: 2,
      }, '2026-01-01T00:06:00Z'),
    ]);

    // Pre-state: 2 prior transient fails, still approved
    const preEvents = await loadAllEvents(ledgerDir);
    assert.equal(fold(preEvents).items.get('WI-008')?.state, 'approved');
    assert.equal(fold(preEvents).items.get('WI-008')?.transientFailCount, 2);
    const preTransientCount = preEvents.filter(e =>
      e.type === 'merge.transient-fail' && e.item === 'WI-008').length;

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner: () => ({ passed: false, timedOut: true, reason: 'gate killed after 600000ms' }),
    });

    const events = await loadAllEvents(ledgerDir);

    // Must park with a clear timeout-not-red message
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-008' && e.actor === 'reactor');
    assert.equal(parked.length, 1, 'must park after 3 timeouts');
    const parkReason = (parked[0].data as { reason: string }).reason;
    assert.ok(parkReason.includes('timed out'), `park reason must mention timeout (got: ${parkReason})`);
    assert.ok(parkReason.includes('not a test failure'), `park reason must clarify not test-red (got: ${parkReason})`);

    // gate.failed must also be present (paired with item.parked)
    const failed = events.filter(e => e.type === 'gate.failed' && e.item === 'WI-008' && e.actor === 'reactor');
    assert.equal(failed.length, 1, 'gate.failed must be emitted alongside item.parked at cap');

    // Must NOT emit another merge.transient-fail (item is being parked, not retried)
    const postTransientCount = events.filter(e =>
      e.type === 'merge.transient-fail' && e.item === 'WI-008').length;
    assert.equal(postTransientCount, preTransientCount, 'must not emit merge.transient-fail when parking at cap');

    // Fold: item must be parked
    assert.equal(fold(events).items.get('WI-008')?.state, 'parked', 'item must be parked after retry cap');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: opts.runDir redirects ALL run-state off repoRoot (plane-home mode)', async () => {
  // Plane-home contract: when the caller passes a resolved runDir, every run-state
  // artifact (regression-guard watermark, lastrun liveness, lock) lands under THAT root
  // and NOTHING is created under <repoRoot>/.ai/runs — mixing the two was the
  // first-live-beat incident (the guard read another plane's watermarks and halted).
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const planeHome = makeTempDir();
  const runDir = join(planeHome, 'runs', 'loopkit');
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-060', 'item.captured', { source: 'test', text: 'add a banner' }),
    ]);

    const buildBlock = [
      'ROUTE: build',
      'SPEC: Add the banner slice.',
      'TOUCHES: apps/example/src/slices/calendar/',
      'MODEL: sonnet',
      'PRIORITY: medium',
      'REPLY: Queuing it now.',
    ].join('\n');

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      runDir,
      autonomy: 'on',
      provider: makeFakeProvider(buildBlock),
      config: makeTestConfig(),
    });

    // The beat really ran (not a lock/guard bail) and routed the item.
    assert.ok(result.totalEventsWritten > 0, 'beat should have run and written events');

    // Run-state under the injected root, subdirectory shapes unchanged:
    assert.ok(existsSync(join(runDir, 'doctor-maxids.json')),
      'regression-guard watermark must live under opts.runDir');
    assert.ok(existsSync(join(planeHome, 'runs', 'reactor', 'lastrun')),
      'reactor lastrun must be a sibling of the loopkit dir under the same runs root');

    // And the driven repo stays untouched: no embedded run dir materializes.
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')),
      'no run-state may land under repoRoot/.ai/runs when opts.runDir is set');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
    cleanDir(planeHome);
  }
});

// ---------------------------------------------------------------------------
// Dispatch tests
// ---------------------------------------------------------------------------

test('dispatch: LOOPKIT_AUTONOMY=off is a no-op beat', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'build X' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'build X' }),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'off',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.equal(result.dispatched.length, 0);
    assert.ok(result.detail?.includes('LOOPKIT_AUTONOMY=off'));
    // Nothing written to ledger
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 2, 'no new events should be written');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: LOOPKIT_AUTONOMY unset → fail-safe OFF (no-op, stderr message)', async () => {
  // Same fail-safe applies to dispatch.
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const saved = process.env['LOOPKIT_AUTONOMY'];
  delete process.env['LOOPKIT_AUTONOMY'];
  let stderrLine = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { stderrLine += s; return true; };
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'build X' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'build X' }),
    ]);

    // opts.autonomy is NOT passed — relies on env fallback
    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.equal(result.dispatched.length, 0, 'unset env must no-op (fail-safe OFF)');
    assert.ok(result.detail?.includes('LOOPKIT_AUTONOMY=off'), 'detail must reference the off state');
    assert.ok(stderrLine.includes('[loopkit] LOOPKIT_AUTONOMY unset'), 'must log the fail-safe warning to stderr');
    assert.ok(stderrLine.includes('fail-safe'), 'stderr line must mention fail-safe');
  } finally {
    (process.stderr as unknown as { write: (s: string) => boolean }).write = origWrite;
    if (saved !== undefined) process.env['LOOPKIT_AUTONOMY'] = saved; else delete process.env['LOOPKIT_AUTONOMY'];
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: dry-run writes nothing', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'build X' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'build X' }),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.ok(result.dryRun);
    // Ledger should not grow
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 2, 'dry-run must not write to ledger');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: opts.runDir redirects ALL run-state off repoRoot (plane-home mode)', async () => {
  // Same plane-home contract as the reactor: an injected runDir owns the regression-guard
  // watermark and the lastrun liveness signal; nothing materializes under
  // <repoRoot>/.ai/runs. A captured-but-unqueued item keeps the beat pick-free
  // (no worktree/git machinery), so what remains is exactly the run-state plumbing.
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const planeHome = makeTempDir();
  const runDir = join(planeHome, 'runs', 'loopkit');
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-061', 'item.captured', { source: 'test', text: 'build X' }),
    ]);

    await runDispatch({
      repoRoot,
      ledgerDir,
      runDir,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    // Run-state under the injected root, subdirectory shapes unchanged:
    assert.ok(existsSync(join(runDir, 'doctor-maxids.json')),
      'regression-guard watermark must live under opts.runDir');
    assert.ok(existsSync(join(planeHome, 'runs', 'dispatch', 'lastrun')),
      'dispatch lastrun must be a sibling of the loopkit dir under the same runs root');

    // And the driven repo stays untouched: no embedded run dir materializes.
    assert.ok(!existsSync(join(repoRoot, '.ai', 'runs')),
      'no run-state may land under repoRoot/.ai/runs when opts.runDir is set');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
    cleanDir(planeHome);
  }
});

test('dispatch: a parked build keeps an attempt-unique branch (wi-NNN-a<attempt>)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi204-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // Provider commits a spine file (index.html) → the build parks for operator review and
    // the branch must be KEPT (only the worktree is removed).
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        writeFileSync(join(cwd, 'index.html'), '<!-- spine -->', 'utf8');
        spawnSync('git', ['add', 'index.html'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: touch spine'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    // The dispatched event carries the attempt-suffixed branch name.
    const dispatched = events.filter(e => e.type === 'build.dispatched' && e.item === 'WI-001');
    assert.equal(dispatched.length, 1);
    assert.equal((dispatched[0].data as { branch: string }).branch, 'wi-001-a1',
      'first attempt branch must be wi-001-a1, not wi-001');
    // The branch is kept after a spine park (operator-reviewable).
    const branches = spawnSync('git', ['branch', '--list', 'wi-001-a1'], {
      cwd: repoRoot, stdio: 'pipe',
    }).stdout.toString();
    assert.ok(branches.includes('wi-001-a1'),
      'the spine-parked attempt branch must survive for operator review');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Normalized, segment-boundary Touches semantics (picker == gate)
// ---------------------------------------------------------------------------

test('normalizeTouches strips trailing slashes, trims, drops empties', () => {
  const cases: Array<[string, string[]]> = [
    ['src/', ['src']],
    ['packages/ui/', ['packages/ui']],
    [' src/a , src/b/ ', ['src/a', 'src/b']],
    ['a//', ['a']],
    ['a,,b', ['a', 'b']],
    ['', []],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeTouches(input), expected, `normalizeTouches(${JSON.stringify(input)})`);
  }
});

test('touchesSegmentMatch respects segment boundaries', () => {
  const cases: Array<[string, string, boolean]> = [
    // [prefix a, path b, a-contains-b]
    ['packages/ui', 'packages/ui', true],
    ['packages/ui', 'packages/ui/index.ts', true],
    ['packages/ui', 'packages/ui-kit', false],       // segment-boundary bug: no false match
    ['packages/ui', 'packages/ui-kit/x.ts', false],
    ['src', 'src/a.ts', true],
    ['src', 'srcfoo/a.ts', false],
    ['a/b', 'a/b/c', true],
    ['a/b', 'a/bc', false],
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(touchesSegmentMatch(a, b), expected, `touchesSegmentMatch(${a}, ${b})`);
  }
});

test('picker does not over-serialize packages/ui vs packages/ui-kit', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    // Sibling prefixes that share a string prefix but NOT a path segment must run in parallel.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'A' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'A', touches: 'packages/ui/' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'test', text: 'B' }, '2026-01-01T00:02:00Z'),
      makeEvent('conductor', 'WI-002', 'item.queued', { spec: 'B', touches: 'packages/ui-kit/' }, '2026-01-01T00:03:00Z'),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    assert.equal(result.dispatched.length, 2,
      'packages/ui and packages/ui-kit are segment-distinct — both should dispatch in parallel');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Worker verification + evidence log
// ---------------------------------------------------------------------------

test('dispatch: residue after a worker commit is swept into a dispatch commit, not parked', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi209-dirty-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // Worker commits one file, then leaves ANOTHER change uncommitted (dirty tree).
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'a.ts'), '// committed', 'utf8');
        spawnSync('git', ['add', 'src/a.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: partial'], { cwd, stdio: 'pipe' });
        // Uncommitted residue — would be silently lost on merge.
        writeFileSync(join(cwd, 'src', 'b.ts'), '// uncommitted', 'utf8');
        return { ok: true, text: 'left work uncommitted\nsorry' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    // Regression coverage: dirty-after-commit residue is now swept into a dispatch
    // follow-up commit and the build proceeds to the gate — it must NOT park as
    // no-commit (the work is complete; losing it on merge was the old risk the
    // sweep eliminates).
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001')
      .filter(e => ((e.data as { reason?: string }).reason ?? '').includes('uncommitted'));
    assert.equal(parked.length, 0, 'residue must be swept, not parked as no-commit');
    const sweeps = events.filter(e => e.type === 'msg.out' && e.item === 'WI-001')
      .filter(e => ((e.data as { text?: string }).text ?? '').includes('committed the worker'));
    assert.equal(sweeps.length, 1, 'the sweep must leave a msg.out trail');
    assert.ok(((sweeps[0].data as { text: string }).text).includes('residue'),
      'the trail must name the residue-after-commit sub-class');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: no-commit park still writes an evidence log', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-nocommit-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // Worker makes NO commit at all.
    const provider: LlmProvider = {
      name: 'fake',
      async run(): Promise<ProviderResult> {
        return { ok: true, text: 'could not figure it out' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.equal(parked.length, 1, 'no-commit must park');
    const reason = (parked[0].data as { reason: string }).reason;
    assert.ok(reason.includes('-attempt-1.log'), `no-commit reason must cite the log (got: ${reason})`);
    const logPath = join(repoRoot, '.ai', 'runs', 'loopkit', 'WI-001-attempt-1.log');
    assert.ok(existsSync(logPath), 'evidence log must be written on the no-commit path');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: wedged-lock recovery threshold derives from buildTimeoutMinutes', async () => {
  const mkLock = (repoRoot: string, ageMinutes: number) => {
    const lockPath = join(repoRoot, '.ai', 'runs', 'loopkit', 'dispatch.lock');
    mkdirSync(lockPath, { recursive: true });
    // A LIVE owner pid: the age threshold is now the pid-REUSE fallback only — a lock with
    // no readable pid is deterministically stale and reclaimed regardless of age.
    writeFileSync(join(lockPath, 'pid'), String(process.pid), 'utf8');
    const t = (Date.now() - ageMinutes * 60 * 1000) / 1000;
    utimesSync(lockPath, t, t);
  };

  // buildTimeoutMinutes=40 → wedge threshold = 45 min. A 50-min lock is wedged (recovered);
  // a 42-min lock is a legitimately-long build (held → beat no-ops).
  const run = async (ageMinutes: number) => {
    const ledgerDir = makeTempDir();
    const repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    try {
      await seedLedger(ledgerDir, [
        makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'x' }),
        makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'x' }),
      ]);
      mkLock(repoRoot, ageMinutes);
      const result = await runDispatch({
        repoRoot, ledgerDir, dryRun: true, autonomy: 'on',
        provider: makeFakeProvider(),
        config: makeTestConfig({ buildTimeoutMinutes: 40 }),
      });
      return result.detail ?? '';
    } finally {
      cleanDir(ledgerDir);
      cleanDir(repoRoot);
    }
  };

  const heldDetail = await run(42);   // < 45 min threshold → still held
  assert.ok(heldDetail.includes('already running'),
    `a 42-min lock (< 45-min derived threshold) must be treated as a live build (got: ${heldDetail})`);

  const recoveredDetail = await run(50);  // > 45 min threshold → wedge recovered, beat proceeds
  assert.ok(!recoveredDetail.includes('already running'),
    `a 50-min lock (> 45-min derived threshold) must be recovered as wedged (got: ${recoveredDetail})`);
});

test('dispatch: a FRESH lock owned by a DEAD pid is reclaimed immediately (no 55min wait)', async () => {
  // Lock with a young mtime (well under the wedge threshold) but a pid file naming a dead process.
  // Age alone would keep it held; the PID probe must reclaim it in the very next beat.
  const run = async (ownerPid: number, alive: boolean) => {
    const ledgerDir = makeTempDir();
    const repoRoot = makeTempDir();
    const lockPath = join(repoRoot, '.ai', 'runs', 'loopkit', 'dispatch.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(ownerPid), 'utf8');
    // Fresh mtime → the age heuristic would treat it as a live build; only the PID probe can free it.
    const t = (Date.now() - 60 * 1000) / 1000; // 1 min old, << 45 min threshold
    utimesSync(lockPath, t, t);
    try {
      await seedLedger(ledgerDir, [
        makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'x' }),
        makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'x' }),
      ]);
      const result = await runDispatch({
        repoRoot, ledgerDir, dryRun: true, autonomy: 'on',
        provider: makeFakeProvider(),
        config: makeTestConfig({ buildTimeoutMinutes: 40 }),
      });
      return result.detail ?? '';
    } finally {
      cleanDir(ledgerDir);
      cleanDir(repoRoot);
    }
  };

  const deadOwner = await run(99999999, false); // pid that cannot exist → dead → reclaim
  assert.ok(!deadOwner.includes('already running'),
    `a fresh lock owned by a DEAD pid must be reclaimed immediately (got: ${deadOwner})`);

  const liveOwner = await run(process.pid, true); // this test process IS alive → lock genuinely held
  assert.ok(liveOwner.includes('already running'),
    `a fresh lock owned by a LIVE pid must be treated as a real in-flight build (got: ${liveOwner})`);
});

test('dispatch: refuses to dispatch overlapping Touches', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    // Two items with overlapping Touches — only the first should be picked
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task A' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'task A', touches: 'apps/example/src/routes',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'test', text: 'task B' }, '2026-01-01T00:02:00Z'),
      makeEvent('conductor', 'WI-002', 'item.queued', {
        spec: 'task B', touches: 'apps/example/src/routes/board.ts',
      }, '2026-01-01T00:03:00Z'),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,   // dry-run so we don't need real git worktrees
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    // Only one of the two items should be in the batch (they conflict)
    assert.equal(result.dispatched.length, 1, `expected 1 dispatched item, got ${result.dispatched.length}`);
    // WI-001 should win (arrived first / lower ID)
    assert.equal(result.dispatched[0].item, 'WI-001');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Dispatch circuit-breaker tests
// ---------------------------------------------------------------------------

test('dispatch: skips item with attempts >= BUILDER_BREAKER_N (no unpark)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    // Build 5 crash cycles so attempts = 5, item lands back in queued state.
    const events: LedgerEvent[] = [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'task', touches: 'apps/example/src',
      }, '2026-01-01T00:01:00Z'),
    ];
    for (let i = 1; i <= 5; i++) {
      const base = `2026-01-01T00:0${i}:00Z`;
      const crash = `2026-01-01T00:0${i}:30Z`;
      events.push(makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: i, pid: i }, base));
      events.push(makeEvent('doctor', 'WI-001', 'build.crashed', { reason: 'orphan-detected' }, crash));
      // Item goes back to queued via build.crashed fold transition
    }
    await seedLedger(ledgerDir, events);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    // Item must be skipped — 5 attempts >= BUILDER_BREAKER_N=5, no unpark
    assert.equal(result.dispatched.length, 0, `breaker should have skipped WI-001 (attempts=5)`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: allows item with attempts >= BUILDER_BREAKER_N after explicit operator unpark', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    // 5 crashes → parked → then operator explicitly unparks
    const events: LedgerEvent[] = [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'task', touches: 'apps/example/src',
      }, '2026-01-01T00:01:00Z'),
    ];
    for (let i = 1; i <= 5; i++) {
      const base = `2026-01-01T00:0${i}:00Z`;
      const crash = `2026-01-01T00:0${i}:30Z`;
      events.push(makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: i, pid: i }, base));
      events.push(makeEvent('doctor', 'WI-001', 'build.crashed', { reason: 'orphan-detected' }, crash));
    }
    // The 5th crash leaves item in queued; now gate fails and parks it, then operator unparks
    events.push(makeEvent('dispatch', 'WI-001', 'gate.failed', { reason: 'red' }, '2026-01-01T00:06:00Z'));
    events.push(makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'red' }, '2026-01-01T00:06:01Z'));
    events.push(makeEvent('operator', 'WI-001', 'item.unparked', { by: 'operator' }, '2026-01-01T00:07:00Z'));
    await seedLedger(ledgerDir, events);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    // Operator explicitly unparked after the last park — breaker must allow this dispatch
    assert.equal(result.dispatched.length, 1, `breaker should allow WI-001 after operator unpark (got ${result.dispatched.length})`);
    assert.equal(result.dispatched[0].item, 'WI-001');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Batch co-location tests
// ---------------------------------------------------------------------------

/** Minimal ItemRecord for the pure eligibility predicate. */
function mkRec(partial: Partial<ItemRecord>): ItemRecord {
  return { id: 'WI-000', state: 'queued', attempts: 0, builds: [], messages: [], ...partial } as ItemRecord;
}

test('isBatchEligible: gates on model, priority, and spec size', () => {
  // Eligible: sonnet, non-blocker priority, bounded spec.
  assert.equal(isBatchEligible(mkRec({ model: 'sonnet', priority: 'high', spec: 'x' })), true);
  assert.equal(isBatchEligible(mkRec({ model: 'sonnet', priority: 'medium', spec: 'x' })), true);
  assert.equal(isBatchEligible(mkRec({ model: 'sonnet', priority: 'low', spec: 'x' })), true);
  // Missing model defaults to sonnet (builder default).
  assert.equal(isBatchEligible(mkRec({ priority: 'medium', spec: 'x' })), true);
  // Ineligible: blocker (must run isolated), opus, oversized spec, empty spec.
  assert.equal(isBatchEligible(mkRec({ model: 'sonnet', priority: 'blocker', spec: 'x' })), false);
  assert.equal(isBatchEligible(mkRec({ model: 'opus', priority: 'medium', spec: 'x' })), false);
  assert.equal(isBatchEligible(mkRec({ model: 'sonnet', priority: 'medium', spec: 'x'.repeat(1500) })), false);
  assert.equal(isBatchEligible(mkRec({ model: 'sonnet', priority: 'medium', spec: '' })), false);
});

test('dispatch: batchMaxItems>1 co-locates overlapping small items into one worktree', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    // Two SMALL items with overlapping Touches — with batching on they share one worker run.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task A' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'task A', touches: 'apps/example/src/routes', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'test', text: 'task B' }, '2026-01-01T00:02:00Z'),
      makeEvent('conductor', 'WI-002', 'item.queued', {
        spec: 'task B', touches: 'apps/example/src/routes/board.ts', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig({ batchMaxItems: 3 }),
    });

    // ONE worktree/group, but BOTH items co-located into it (dry-run reports via detail).
    assert.equal(result.dispatched.length, 1, 'the two overlapping items share one worktree');
    assert.equal(result.dispatched[0].item, 'WI-001', 'carrier is the first (lower-id) item');
    assert.ok(result.dispatched[0].detail?.includes('WI-001+WI-002'),
      `detail should name both batched items (got: ${result.dispatched[0].detail})`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: batched worktree merges per-item commits with per-item attribution', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-batch-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', {
        spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    // Worker makes ONE commit per item, each subject prefixed with the item id.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'a.ts'), '// a', 'utf8');
        spawnSync('git', ['add', 'src/a.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): do A'], { cwd, stdio: 'pipe' });
        writeFileSync(join(cwd, 'src', 'b.ts'), '// b', 'utf8');
        spawnSync('git', ['add', 'src/b.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-002): do B'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
    });

    // One worktree dispatched, both items merged with distinct source commits.
    assert.equal(result.dispatched.length, 1);
    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 merged');
    assert.equal(folded.items.get('WI-002')?.state, 'merged', 'WI-002 merged');
    const merges = events.filter(e => e.type === 'item.merged');
    const shaA = merges.find(e => e.item === 'WI-001')!.data as { commit: string };
    const shaB = merges.find(e => e.item === 'WI-002')!.data as { commit: string };
    assert.ok(shaA.commit && shaB.commit && shaA.commit !== shaB.commit,
      'each item attributes its own source commit');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: terminal path no-ops (build.superseded) when the item merged mid-build — WI-074', async () => {
  // The double-delivery race: dispatch is building WI-001 when an attended session merges it
  // (a stale-claim takeover). Dispatch's terminal path must re-fold under the lock immediately
  // before gate/merge/push, see the item already terminal, and record build.superseded instead
  // of pushing a SECOND merge commit + appending a second item.merged.
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-superseded-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);
    const masterBefore = g(['rev-parse', 'HEAD']).stdout.toString().trim();

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    // The worker commits real work in the worktree, THEN (simulating an attended session that
    // took the item over and shipped it while this build ran) appends item.merged to the ledger.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'a.ts'), '// a', 'utf8');
        spawnSync('git', ['add', 'src/a.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): do A'], { cwd, stdio: 'pipe' });
        await appendEvents(ledgerDir, [
          makeEvent('operator', 'WI-001', 'item.merged', { commit: 'deadbee', deployed: false }),
        ]);
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
      // Isolate the build path: scout/judge would each call the fake provider again (and it
      // appends item.merged on every call), muddying the "did dispatch double-merge?" assertion.
      scoutEnabled: false,
      judgeEnabled: false,
    });

    const events = await loadAllEvents(ledgerDir);
    // Exactly ONE item.merged (the attended one) — dispatch did NOT append a second.
    const merges = events.filter(e => e.type === 'item.merged' && e.item === 'WI-001');
    assert.equal(merges.length, 1, 'dispatch must not append a duplicate item.merged');
    assert.equal((merges[0].data as { commit: string }).commit, 'deadbee', 'the surviving merge is the attended one');
    // A build.superseded records why the finished build did not ship.
    const superseded = events.filter(e => e.type === 'build.superseded' && e.item === 'WI-001');
    assert.equal(superseded.length, 1, 'a build.superseded event is recorded');
    // No second merge commit was pushed to master.
    const masterAfter = g(['rev-parse', 'HEAD']).stdout.toString().trim();
    assert.equal(masterAfter, masterBefore, 'master must not advance — no duplicate merge commit');
    // The branch is salvaged (kept for review), not deleted.
    const branchList = g(['branch', '--list', 'wi-001-a1']).stdout.toString().trim();
    assert.ok(branchList.includes('wi-001-a1'), 'the superseded build branch is kept for review');
    // The step result reflects the no-op supersede.
    assert.ok(result.dispatched.some(d => d.item === 'WI-001' && (d.detail ?? '').includes('superseded')),
      'the dispatch result reports the superseded no-op');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: batched item attributed by Touches even when the commit subject omits its id', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-batch-touches-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    // Two batched items sharing a code area (overlapping Touches) — the real batch case.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'shared/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', {
        spec: 'do B', touches: 'shared/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    // Worker lands the shared change in ONE commit whose subject names ONLY WI-001.
    // Old subject-string attribution parked WI-002 even though its Touched code merged.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'shared'), { recursive: true });
        writeFileSync(join(cwd, 'shared', 'x.ts'), '// shared', 'utf8');
        spawnSync('git', ['add', 'shared/x.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): shared change for both'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
    });

    const folded = fold(await loadAllEvents(ledgerDir));
    assert.equal(folded.items.get('WI-001')?.state, 'merged',
      'WI-001 is named in the subject — merged');
    assert.equal(folded.items.get('WI-002')?.state, 'merged',
      'WI-002 shares the Touched area — must merge despite the subject omitting its id');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: batchMaxItems=1 (default) keeps overlapping items on separate beats', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'A' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'test', text: 'B' }, '2026-01-01T00:02:00Z'),
      makeEvent('conductor', 'WI-002', 'item.queued', {
        spec: 'B', touches: 'src/x.ts', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    const result = await runDispatch({
      repoRoot, ledgerDir, dryRun: true, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),  // batchMaxItems defaults to 1
    });

    // Default: overlapping items do NOT co-locate — only the carrier is picked this beat.
    assert.equal(result.dispatched.length, 1, 'no co-location when batching is off');
    assert.equal(result.dispatched[0].item, 'WI-001', 'only the carrier item is dispatched');
    assert.ok(!result.dispatched[0].detail?.includes('batch'),
      'default beat must not batch (detail should be the single-item form)');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Touches enforcement tests
// ---------------------------------------------------------------------------

test('dispatch: commit outside declared Touches parks item as needs-decision', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-touches-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'build X', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    // Provider commits a file outside the declared touches prefix (src/)
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'other'), { recursive: true });
        writeFileSync(join(cwd, 'other', 'surprise.ts'), '// surprise', 'utf8');
        spawnSync('git', ['add', 'other/surprise.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: touches overstep'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.equal(parked.length, 1, 'item should be parked');
    const reason = (parked[0].data as { reason: string }).reason;
    assert.ok(reason.includes('needs-decision'), `reason should contain needs-decision (got: ${reason})`);
    assert.ok(reason.includes('other/surprise.ts'), `reason should list the offending file (got: ${reason})`);
    assert.equal(fold(events).items.get('WI-001')?.state, 'parked');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: approved overstep is not re-parked on a rebuild touching the same paths', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-touches-approved-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'build X', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
      // Operator previously approved a touches-overstep park that surfaced other/surprise.ts.
      makeEvent('reactor', 'WI-001', 'item.parked', {
        reason: 'needs-decision: files outside declared Touches (src/): other/surprise.ts',
        parkKind: 'decision',
      }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-001', 'item.approved', {
        by: 'operator', approvedTouches: ['other/surprise.ts'],
      }, '2026-01-01T00:03:00Z'),
      // A later repair cycle requeues the item for a fresh build attempt.
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'build X', touches: 'src/',
      }, '2026-01-01T00:04:00Z'),
    ]);

    // Rebuild touches the SAME approved path — must not re-park.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'other'), { recursive: true });
        writeFileSync(join(cwd, 'other', 'surprise.ts'), '// still surprising', 'utf8');
        spawnSync('git', ['add', 'other/surprise.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: same overstep path'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const newParks = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001'
      && (e.data as { reason: string }).reason.includes('other/surprise.ts')
      && e.actor === 'dispatch');
    assert.equal(newParks.length, 0, 'previously-approved overstep path must not re-park');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: approved overstep still parks a genuinely new off-scope path', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-touches-new-path-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'build X', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('reactor', 'WI-001', 'item.parked', {
        reason: 'needs-decision: files outside declared Touches (src/): other/surprise.ts',
        parkKind: 'decision',
      }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-001', 'item.approved', {
        by: 'operator', approvedTouches: ['other/surprise.ts'],
      }, '2026-01-01T00:03:00Z'),
      // A later repair cycle requeues the item for a fresh build attempt.
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'build X', touches: 'src/',
      }, '2026-01-01T00:04:00Z'),
    ]);

    // Rebuild touches the approved path AND a genuinely new, unrelated directory.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'other'), { recursive: true });
        writeFileSync(join(cwd, 'other', 'surprise.ts'), '// still surprising', 'utf8');
        mkdirSync(join(cwd, 'other2'), { recursive: true });
        writeFileSync(join(cwd, 'other2', 'fresh.ts'), '// new territory', 'utf8');
        spawnSync('git', ['add', 'other/surprise.ts', 'other2/fresh.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: same path plus a new one'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const newParks = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001' && e.actor === 'dispatch');
    assert.equal(newParks.length, 1, 'a genuinely new off-scope path should still park');
    const reason = (newParks[0].data as { reason: string }).reason;
    assert.ok(reason.includes('other2/fresh.ts'), `reason should list the NEW offending file (got: ${reason})`);
    assert.ok(!reason.includes('other/surprise.ts'), `previously-approved file should not reappear in the park reason (got: ${reason})`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: trailing-slash touches prefix admits in-touches files (regression)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'touches-slash-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      // trailing slash is the dominant convention in real items (packages/ui/) —
      // the naive `p + '/'` startsWith check double-slashed and false-parked these.
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'build X', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'inside.ts'), '// in touches', 'utf8');
        spawnSync('git', ['add', 'src/inside.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: in touches'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-001')?.state, 'merged',
      'in-touches commit under a trailing-slash prefix must merge, not park');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: no-touches item is not blocked by touches check', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-notouches-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      // no touches declared
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'build X' }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        writeFileSync(join(cwd, 'anywhere.ts'), '// anything', 'utf8');
        spawnSync('git', ['add', 'anywhere.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: no-touches item'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    // No item.parked from the touches check (needs-decision + Touches)
    const touchesParked = events.filter(e =>
      e.type === 'item.parked' &&
      typeof (e.data as { reason?: string }).reason === 'string' &&
      (e.data as { reason: string }).reason.includes('Touches'),
    );
    assert.equal(touchesParked.length, 0, 'no-touches item must not be parked by touches check');
    // Item should have proceeded past touches gate to merged
    assert.equal(fold(events).items.get('WI-001')?.state, 'merged',
      'no-touches item should proceed to merged');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: rec.effort is forwarded onto the provider.run request', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-effort-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'build X', effort: 'high' }, '2026-01-01T00:01:00Z'),
    ]);

    // Scout and judge also call provider.run (without effort — out of scope for this field).
    // The build call is un-detached (detached is now false, same falsy value scout/judge
    // already had), so `detached` truthiness no longer discriminates it — key on
    // `req.exitFile` instead, which only the actual build dispatch call sets.
    let capturedEffort: string | undefined;
    let builderCallSeen = false;
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (!req.exitFile) return { ok: true, text: 'ok' };
        builderCallSeen = true;
        capturedEffort = req.effort;
        const cwd = req.cwd!;
        writeFileSync(join(cwd, 'anywhere.ts'), '// anything', 'utf8');
        spawnSync('git', ['add', 'anywhere.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: effort-forwarded item'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.ok(builderCallSeen, 'the builder provider.run call must have fired');
    assert.equal(capturedEffort, 'high', 'provider.run must receive the item\'s routed effort');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parked-branch safety tests
// ---------------------------------------------------------------------------

test('dispatch: branch names increment per attempt (wi-NNN-aN suffix)', async () => {
  // First dispatch of a fresh item → branch wi-001-a1
  {
    const ledgerDir = makeTempDir();
    const repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    try {
      await seedLedger(ledgerDir, [
        makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }, '2026-01-01T00:00:00Z'),
        makeEvent('conductor', 'WI-001', 'item.queued', {
          spec: 'task', touches: 'src/',
        }, '2026-01-01T00:01:00Z'),
      ]);
      const result = await runDispatch({
        repoRoot, ledgerDir, dryRun: true, autonomy: 'on',
        provider: makeFakeProvider(), config: makeTestConfig(),
      });
      assert.equal(result.dispatched.length, 1);
      assert.equal(result.dispatched[0].branch, 'wi-001-a1',
        'first dispatch of WI-001 should produce branch wi-001-a1');
    } finally { cleanDir(ledgerDir); cleanDir(repoRoot); }
  }

  // After a spine-park+unpark cycle (attempts=1 in fold) → branch wi-001-a2
  {
    const ledgerDir = makeTempDir();
    const repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    try {
      await seedLedger(ledgerDir, [
        makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }, '2026-01-01T00:00:00Z'),
        makeEvent('conductor', 'WI-001', 'item.queued', {
          spec: 'task', touches: 'src/',
        }, '2026-01-01T00:01:00Z'),
        makeEvent('dispatch', 'WI-001', 'build.dispatched', {
          attempt: 1, branch: 'wi-001-a1', worktree: '/tmp/wt', pid: 1,
        }, '2026-01-01T00:02:00Z'),
        makeEvent('dispatch', 'WI-001', 'gate.parked', { reason: 'spine' }, '2026-01-01T00:03:00Z'),
        makeEvent('dispatch', 'WI-001', 'item.parked', {
          reason: 'needs-decision: touches spine',
        }, '2026-01-01T00:03:01Z'),
        makeEvent('operator', 'WI-001', 'item.unparked', { by: 'operator' }, '2026-01-01T00:04:00Z'),
      ]);
      const result = await runDispatch({
        repoRoot, ledgerDir, dryRun: true, autonomy: 'on',
        provider: makeFakeProvider(), config: makeTestConfig(),
      });
      assert.equal(result.dispatched.length, 1);
      assert.equal(result.dispatched[0].branch, 'wi-001-a2',
        're-dispatch after spine-park should produce branch wi-001-a2 (attempt 2)');
    } finally { cleanDir(ledgerDir); cleanDir(repoRoot); }
  }
});

test('dispatch: re-dispatch does not delete a parked review branch', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-redispatch-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    // Simulate a prior parked dispatch: branch wi-001-a1 exists with a commit
    g(['checkout', '-b', 'wi-001-a1']);
    writeFileSync(join(repoRoot, 'spine-change.txt'), 'y', 'utf8');
    g(['add', 'spine-change.txt']);
    g(['commit', '-m', 'feat(WI-001): spine change (parked for review)']);
    g(['checkout', 'master']);

    // Seed: item was dispatched at attempt 1, spine-parked, then operator unparked
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'task', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', {
        attempt: 1, branch: 'wi-001-a1', worktree: '/tmp/wt', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-001', 'gate.parked', { reason: 'spine' }, '2026-01-01T00:03:00Z'),
      makeEvent('dispatch', 'WI-001', 'item.parked', {
        reason: 'needs-decision: touches spine',
      }, '2026-01-01T00:03:01Z'),
      makeEvent('operator', 'WI-001', 'item.unparked', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    // Re-dispatch (attempt 2). Fake provider makes no commits → no-commit gate path fires.
    // Phase 1 cleanup runs before the provider; this is where the guard lives.
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider('no work done'),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    // The parked review branch from attempt 1 must survive
    const branch1 = spawnSync('git', ['branch', '--list', 'wi-001-a1'], {
      cwd: repoRoot, stdio: 'pipe',
    });
    assert.ok(
      branch1.stdout.toString().includes('wi-001-a1'),
      'parked review branch wi-001-a1 must not be deleted by re-dispatch (attempt 2)',
    );

    // Verify attempt 2 used a fresh branch name
    const events = await loadAllEvents(ledgerDir);
    const dispatched = events.filter(e => e.type === 'build.dispatched' && e.item === 'WI-001');
    assert.equal(dispatched.length, 2, 'should have two build.dispatched events');
    assert.equal(
      (dispatched[1].data as { branch: string }).branch,
      'wi-001-a2',
      'second dispatch must use branch wi-001-a2',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: guard is a no-op when no parked event exists (stale branch cleaned up)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-guard-noop-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    // A stale branch with the same name as the upcoming dispatch's attempt-1 branch.
    // With no gate.parked event in the history, the guard must NOT protect it.
    g(['checkout', '-b', 'wi-001-a1']);
    writeFileSync(join(repoRoot, 'stale.txt'), 'stale', 'utf8');
    g(['add', 'stale.txt']);
    g(['commit', '-m', 'stale leftover from a previous run']);
    g(['checkout', 'master']);

    // Fresh item — no prior builds, no parkClass
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }, '2026-01-01T00:00:00Z'),
      makeEvent('conductor', 'WI-001', 'item.queued', {
        spec: 'task', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    // First dispatch: no parkClass → guard condition is false → stale wi-001-a1 is deleted.
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider('no work done'),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    // Stale branch must have been cleaned up (the guard did not intervene)
    const branch1 = spawnSync('git', ['branch', '--list', 'wi-001-a1'], {
      cwd: repoRoot, stdio: 'pipe',
    });
    assert.ok(
      !branch1.stdout.toString().includes('wi-001-a1'),
      'stale wi-001-a1 must be cleaned up when there is no parked-review guard applying',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sensitivity / provider tests
// ---------------------------------------------------------------------------

test('sensitivity: private item with no allowed provider is parked, never routed to cloud', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    // Seed a private item
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', {
        source: 'test',
        text: 'private task',
        sensitivity: 'private',
      }, '2026-01-01T00:00:00Z'),
    ]);

    // Config with no private providers allowed
    const cfg = makeTestConfig({
      sensitivityAllowlists: {
        public: ['claude-cli'],
        internal: ['claude-cli'],
        private: [],   // no provider allowed for private
      },
    });

    // We'll track if the cloud provider was called
    let cloudProviderCalled = false;
    const cloudProvider: LlmProvider = {
      name: 'claude-cli',
      async run(_req): Promise<ProviderResult> {
        cloudProviderCalled = true;
        return { ok: true, text: 'cloud response' };
      },
    };

    // Build a registry — private items should NOT resolve 'claude-cli'
    const registry = makeRegistry({
      providers: { 'claude-cli': { model: 'sonnet' } },
      sensitivityAllowlists: cfg.sensitivityAllowlists,
    });

    const resolved = registry.resolve('claude-cli', 'private');
    assert.equal(resolved, null, 'registry should return null for private + no allowed providers');
    assert.equal(cloudProviderCalled, false, 'cloud provider must never be called for private items');

    // Also verify: routing step with null provider for a private item takes the zero-LLM path
    // (doesn't route it, doesn't error fatally)
    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,   // simulate: no provider resolved for private
      config: cfg,
    });

    const routeStep = result.steps.find(s => s.step === 'route');
    assert.ok(routeStep?.ok, `route step should not hard-fail: ${routeStep?.detail}`);
    // The item should remain in 'captured' state (not routed)
    const events = await loadAllEvents(ledgerDir);
    const foldResult = fold(events);
    const item = foldResult.items.get('WI-001');
    assert.equal(item?.state, 'captured', 'private item with no provider should stay captured');
    assert.equal(cloudProviderCalled, false, 'cloud provider must never be called');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

test('provider registry: resolves allowed provider', () => {
  const registry = makeRegistry({
    providers: { 'claude-cli': { model: 'sonnet' } },
    sensitivityAllowlists: {
      internal: ['claude-cli'],
    },
  });
  const provider = registry.resolve('claude-cli', 'internal');
  assert.ok(provider !== null, 'claude-cli should be resolved for internal sensitivity');
  assert.equal(provider?.name, 'claude-cli');
});

test('provider registry: private with no allowed list returns null', () => {
  const registry = makeRegistry({
    providers: { 'claude-cli': { model: 'sonnet' } },
    sensitivityAllowlists: {
      private: [],  // empty = nothing allowed
    },
  });
  const provider = registry.resolve('claude-cli', 'private');
  assert.equal(provider, null);
});

test('provider registry: ollama resolves for private (P4 live)', () => {
  const registry = makeRegistry({
    providers: { 'ollama': {} },
    sensitivityAllowlists: { private: ['ollama'] },
  });
  const provider = registry.resolve('ollama', 'private');
  assert.ok(provider !== null, 'ollama is live in P4 and must resolve');
  assert.equal(provider?.name, 'ollama');
});

// ---------------------------------------------------------------------------
// Worktree-based approve path — primary tree branch is irrelevant.
// The reactor merges approved items entirely inside a throwaway worktree and
// pushes HEAD:master from there, so the dev's active branch never matters.
// ---------------------------------------------------------------------------

test('reactor: apply-verbs writes gate.failed+parked (not silently defers) when master is unresolvable', async () => {
  // Replaces the old "approved merge deferred when not on master" guard.
  // New invariant: the reactor ALWAYS attempts the merge (worktree approach);
  // on failure it writes gate.failed+item.parked with a clear reason rather
  // than silently leaving the item in approved state.
  const dir = mkdtempSync(join(tmpdir(), 'beat-masterref-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    await appendEvents(ledgerDir, [
      makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }),
      makeEvent('test', 'WI-001', 'item.queued', { spec: 'x' }),
      makeEvent('test', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001', pid: process.pid }),
      makeEvent('test', 'WI-001', 'gate.parked', { reason: 'spine' }),
      makeEvent('test', 'WI-001', 'item.parked', { reason: 'spine' }),
      makeEvent('test', 'WI-001', 'item.approved', { by: 'operator' }),
    ]);

    await runReactor({
      repoRoot: dir,   // not a git repo — git commands will fail
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
    });

    // Reactor must have written a gate.failed event (not silently swallowed the error)
    const allEvents = await loadAllEvents(ledgerDir);
    const gateFailed = allEvents.filter(
      e => e.type === 'gate.failed' && e.item === 'WI-001' && e.actor === 'reactor',
    );
    assert.ok(gateFailed.length > 0,
      'reactor must write gate.failed when git commands fail, not silently defer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reactor: merges approved item in worktree even when primary tree is on a feature branch', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'appr-wt-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const originDir = join(tmpDir, 'origin.git');
    const ledgerDir = join(tmpDir, 'ledger');
    const g = (args: string[], cwd = repoRoot) =>
      spawnSync('git', args, { cwd, stdio: 'pipe' });

    // Set up a bare origin so git push succeeds
    mkdirSync(originDir, { recursive: true });
    spawnSync('git', ['init', '--bare', originDir], { cwd: tmpDir, stdio: 'pipe' });

    // Set up the main repo with master and a feature branch
    mkdirSync(repoRoot, { recursive: true });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    g(['remote', 'add', 'origin', originDir]);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);
    g(['push', '-u', 'origin', 'master']);

    // Create the approved branch
    g(['checkout', '-b', 'wi-999']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-999']);

    // Switch the primary tree to a dev branch — reactor must still merge
    g(['checkout', '-b', 'some-dev-branch']);
    g(['checkout', 'master']);
    g(['checkout', 'some-dev-branch']);

    // Seed ledger: approved item pointing at wi-999
    await seedLedger(ledgerDir, [
      makeEvent('test', 'WI-999', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('test', 'WI-999', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
      makeEvent('test', 'WI-999', 'build.dispatched', {
        attempt: 1, branch: 'wi-999', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('test', 'WI-999', 'gate.parked', { reason: 'spine' }, '2026-01-01T00:03:00Z'),
      makeEvent('test', 'WI-999', 'item.parked', { reason: 'spine' }, '2026-01-01T00:03:01Z'),
      makeEvent('operator', 'WI-999', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(), // gateCommand: 'exit 0'
    });

    const allEvents = await loadAllEvents(ledgerDir);
    const foldResult = fold(allEvents);

    // Item must be merged, not stuck in approved
    assert.equal(foldResult.items.get('WI-999')?.state, 'merged',
      `expected state=merged; apply-verbs detail: ${result.steps.find(s => s.step === 'apply-verbs')?.detail}`);

    // Explicit event checks
    const merged = allEvents.filter(e => e.type === 'item.merged' && e.actor === 'reactor');
    assert.equal(merged.length, 1, 'reactor must write exactly one item.merged event');

    const passed = allEvents.filter(e => e.type === 'gate.passed' && e.actor === 'reactor');
    assert.equal(passed.length, 1, 'reactor must write gate.passed before item.merged');

    // Primary tree must still be on the dev branch — reactor never touched it
    const primaryBranch = spawnSync('git', ['branch', '--show-current'], {
      cwd: repoRoot, stdio: 'pipe',
    }).stdout.toString().trim();
    assert.equal(primaryBranch, 'some-dev-branch',
      'reactor must not switch the primary tree branch');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pre-flight auth probe + truthful park reasons
// ---------------------------------------------------------------------------

test('dispatch: skips beat and writes no item events when auth probe fails', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'build X', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      authProbeResult: { ok: false },  // simulate: builder not logged in
    });

    // Beat must exit early: no items dispatched, no item events written
    assert.equal(result.dispatched.length, 0, 'no items should be dispatched when auth probe fails');
    assert.ok(result.detail?.startsWith('infra:'), `detail should start with 'infra:' (got: ${result.detail})`);

    // The ledger must not have grown — items stay queued, never touched
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 2, 'no events must be written when auth probe fails');

    // Fold: item should still be in queued state
    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-001')?.state, 'queued', 'item must remain queued');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('dispatch: mid-build auth failure emits build.crashed, item resets to queued (not parked)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // Real git repo — dispatch needs worktree plumbing
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']); g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'build X', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // Provider returns auth failure on run (session expired mid-build)
    const authFailProvider: LlmProvider = {
      name: 'auth-fail',
      async run(): Promise<ProviderResult> {
        return { ok: false, error: 'claude auth failure: Not logged in', code: 'auth' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: authFailProvider,
      config: makeTestConfig(),
      authProbeResult: { ok: true },   // probe passes; auth expires between probe and run
      branchProbe: () => 'master',
    });

    const events = await loadAllEvents(ledgerDir);
    // Must have build.dispatched + build.crashed (not gate.failed + item.parked)
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-001');
    assert.equal(crashed.length, 1, 'build.crashed must be written for auth failure');
    const crashReason = (crashed[0].data as { reason: string }).reason;
    assert.ok(crashReason.startsWith('infra:'), `crash reason must start with 'infra:' (got: ${crashReason})`);

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.equal(parked.length, 0, 'item must NOT be parked for auth failure (build.crashed resets to queued)');

    // Fold: build.crashed transitions item back to queued
    const foldResult = fold(events);
    assert.equal(foldResult.items.get('WI-001')?.state, 'queued', 'item must be queued after auth build.crashed');

    // A MID-build logout must raise the same alert flag the pre-flight probe sets,
    // so the console/beat health learns the builder is down without waiting for an empty queue.
    const flagPath = join(repoRoot, '.ai', 'runs', 'loopkit', 'dispatch-auth-failed');
    assert.ok(existsSync(flagPath), 'mid-build auth failure must set the dispatch-auth-failed flag');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('dispatch: build.dispatched carries the beat pid so the doctor sees a live build', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // The dispatch path needs a real repo for worktree/branch/merge plumbing.
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']); g(['commit', '-m', 'init']);
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'README.md' }, '2026-01-01T00:01:00Z'),
    ]);
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: { name: 'fake', run: async () => ({ ok: true, text: 'done' }) } as never,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      config: makeTestConfig(),
    });
    const f = fold(await loadAllEvents(ledgerDir));
    const b = f.items.get('WI-001')?.builds?.[0];
    assert.ok(b, 'a build was recorded');
    assert.equal(typeof b.pid, 'number', 'dispatched event carries pid');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('dispatch: un-detach — worker spawn passes detached:false, records the beat pid (not a pgid), still reads output/usage via the exit-file protocol', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const runsDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  try {
    // The dispatch path needs a real repo for worktree/branch/merge plumbing.
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']); g(['commit', '-m', 'init']);
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'README.md' }, '2026-01-01T00:01:00Z'),
    ]);
    // The real dispatch call site now passes detached:false, so this fake
    // (which only calls onSpawn when req.detached is truthy — the same gate the real
    // claudeCli.ts provider uses) never fires onSpawn. spawnedPgid stays undefined and the
    // beat's own pid is recorded instead — the documented, intended revert of the earlier detach.
    let capturedDetached: boolean | undefined;
    const provider: LlmProvider = {
      name: 'fake-detached',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (req.exitFile) capturedDetached = req.detached; // only the builder call sets exitFile
        return makeDetachedFakeProvider({ resultText: 'exit-file text', usage: { in: 4, out: 2 }, pgid: 424242 }).run(req);
      },
    };
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      config: makeTestConfig(),
    });
    assert.equal(capturedDetached, false, 'the worker spawn must pass detached:false');

    const f = fold(await loadAllEvents(ledgerDir));
    const b = f.items.get('WI-001')?.builds?.[0];
    assert.ok(b, 'a build was recorded');
    assert.equal(b.pgid, undefined, 'no pgid recorded — onSpawn never fires for an attached (detached:false) spawn');
    assert.equal(typeof b.pid, 'number', 'the beat pid is recorded instead (legacy path, doctor dead-pid requeue handles it)');

    // Evidence log content proves dispatch read the EXIT-FILE payload (via parseOutput), not
    // just the in-memory provider result — the one-parser round trip actually ran. The fake
    // still writes the exit-file protocol unconditionally (real providers write it whether or
    // not detached), so this half of the collection path survives the revert.
    const logPath = join(runsDir, 'WI-001-attempt-1.log');
    assert.ok(existsSync(logPath), 'worker log evidence exists');
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'exit-file text');

    // cost.usage derived via extractUsage on the exit-file's usage json (in:4+cache, out:2).
    // Filtered to loop:'dispatch' — the scout stage (a separate provider.run call) emits its
    // own cost.usage{loop:'scout'} first, which is not what this assertion is about.
    const costEvents = (await loadAllEvents(ledgerDir))
      .filter(e => e.type === 'cost.usage' && e.item === 'WI-001' && (e.data as { loop?: string }).loop === 'dispatch');
    assert.equal(costEvents.length, 1, 'one dispatch cost.usage event recorded');
    assert.equal((costEvents[0].data as { tokens: number }).tokens, 6, 'tokens derived from the exit-file usage json (4 in + 2 out)');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reactor: doctor exit-file probe defaults to a REAL probe — a dead pgid with an exit file on disk is collectable, not orphaned', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const runsDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  try {
    mkdirSync(runsDir, { recursive: true });
    // A pgid guaranteed dead in this sandbox — process.kill(deadPgid, 0) throws.
    const deadPgid = 999_999_999;
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1', pgid: deadPgid }, '2026-01-01T00:01:00Z'),
    ]);
    // Real exit-file protocol write — mirrors what claudeCli.ts's run() leaves behind on completion.
    writeExitFile(runsDir, 'WI-001', 1, { exitCode: 0 });

    // No exitFileProbe injected — this exercises the REAL default now wired into stepDoctor
    // (previously only the inert always-false default existed, so this guard was dead code).
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
    });

    const f = fold(await loadAllEvents(ledgerDir));
    assert.equal(f.items.get('WI-001')?.state, 'building', 'a completed-awaiting-collection build is NOT reaped as an orphan');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reactor: doctor exit-file probe — a dead pgid with NO exit file still orphans (guard does not false-positive on a real crash)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    const deadPgid = 999_999_998;
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1', pgid: deadPgid }, '2026-01-01T00:01:00Z'),
    ]);
    // No exit file written — and no `now` injected, so the grace window is skipped
    // (config.now undefined ⇒ the grace check treats the build as "unjudgeable" and defers).
    // Passing `now` far in the future exercises the actual orphan path past the grace window.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      now: Date.parse('2026-01-01T00:01:00Z') + 10 * 60_000,
    });

    const f = fold(await loadAllEvents(ledgerDir));
    assert.equal(f.items.get('WI-001')?.state, 'queued', 'a genuinely dead build with no exit file is still reaped');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── post-collection-limbo reaper: now ACTIVE in the live reactor (real worktreeProbe wired) ──
// The exit-file DEFER probe was already wired; the LIMBO leg was dead code until stepDoctor
// passed a real worktreeProbe. These two exercise that newly-active wiring end-to-end through
// runReactor (the doctor.ts unit logic itself is covered by doctor.test.ts).

test('reactor: post-collection-limbo IS reaped — exit-file present + worktree gone + dispatch stale (real worktreeProbe now wired)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const runsDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  try {
    mkdirSync(runsDir, { recursive: true });
    const deadPgid = 999_999_997;
    const dispatchedAt = '2026-01-01T00:01:00Z';
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      // worktree points at a path that does NOT exist → the collector has nothing left to merge from.
      makeEvent('dispatch', 'WI-001', 'build.dispatched',
        { attempt: 1, branch: 'wi-001-a1', worktree: join(repoRoot, 'gone-worktree'), pgid: deadPgid },
        dispatchedAt),
    ]);
    // Exit file present on disk (build finished) but the ledger never recorded a terminal event.
    writeExitFile(runsDir, 'WI-001', 1, { exitCode: 0 });

    // No worktreeProbe injected — this exercises the REAL default now wired into stepDoctor.
    // `now` is 5h past dispatch, well beyond the 4h default limboMaxMs.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      now: Date.parse(dispatchedAt) + 5 * 60 * 60_000,
    });

    const events = await loadAllEvents(ledgerDir);
    const f = fold(events);
    assert.equal(f.items.get('WI-001')?.state, 'queued',
      'a finished-but-uncollectable build (worktree gone, stale) must be reaped, not sit in building forever');
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-001');
    assert.equal(crashed.length, 1, 'exactly one build.crashed emitted by the limbo reaper');
    assert.match((crashed[0].data as { reason: string }).reason, /post-collection-limbo/,
      'the crash reason names the post-collection-limbo cause');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reactor: exit-file present + worktree STILL present is NOT limbo-reaped even when stale (defers to the collector)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  const runsDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  const liveWorktree = join(repoRoot, 'live-worktree');
  try {
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(liveWorktree, { recursive: true }); // worktree still on disk → still collectable
    const deadPgid = 999_999_996;
    const dispatchedAt = '2026-01-01T00:01:00Z';
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('dispatch', 'WI-001', 'build.dispatched',
        { attempt: 1, branch: 'wi-001-a1', worktree: liveWorktree, pgid: deadPgid },
        dispatchedAt),
    ]);
    writeExitFile(runsDir, 'WI-001', 1, { exitCode: 0 });

    // Stale (5h past dispatch) but the worktree still exists — the limbo reaper must NOT fire;
    // the plain exit-file guard defers it as collectable.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      now: Date.parse(dispatchedAt) + 5 * 60 * 60_000,
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-001')?.state, 'building',
      'a still-collectable build (worktree present) is deferred, never limbo-reaped');
    assert.equal(events.filter(e => e.type === 'build.crashed' && e.item === 'WI-001').length, 0,
      'no build.crashed for a build that is still collectable');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── stall-reap kill target: pid vs. detached pgid ───────────────────────────────────
// The stall-recovery guard must SIGTERM the live worker before salvage reads its worktree.
// A legacy synchronous build records only a `pid`; a detached build (setsid) records only a
// `pgid` and no `pid` — signalling that build's liveness id directly (a bare positive pgid)
// would hit an unrelated/nonexistent process, leaving the real group alive and free to keep
// writing into the worktree while salvage runs. The negative id targets the whole GROUP,
// mirroring the same convention the doctor's own liveness probe already uses.

test('reactor: stall-reap SIGTERMs the recorded pid for a legacy (pid-based) build', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    const dispatchedAt = '2026-01-01T00:01:00Z';
    const livePid = 424242;
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1', pid: livePid }, dispatchedAt),
    ]);

    const killCalls: Array<{ id: number; signal: string }> = [];
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      now: Date.parse(dispatchedAt) + 41 * 60_000, // past the 40m default stalledBuildMinutes
      pidProbe: () => true, // alive → stalled path, not the dead-pid orphan path
      progressProbe: () => Date.parse(dispatchedAt), // no progress since dispatch → idle >= stall threshold
      killFn: (id, signal) => { killCalls.push({ id, signal }); },
    });

    assert.deepEqual(killCalls, [{ id: livePid, signal: 'SIGTERM' }],
      'a legacy build must be SIGTERMed by its plain pid, unchanged from before the pgid fix');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'build.stalled' && e.item === 'WI-001').length, 1,
      'the stall must actually be recorded (proves the stalled path, not the dead-pid orphan path, fired)');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reactor: stall-reap SIGTERMs the process GROUP (negative pgid) for a detached build, never the bare pgid', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    const dispatchedAt = '2026-01-01T00:01:00Z';
    const livePgid = 535353;
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      // Detached build: pgid only, no pid — exactly BuildDispatchedData's detached shape.
      makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1', pgid: livePgid }, dispatchedAt),
    ]);

    const killCalls: Array<{ id: number; signal: string }> = [];
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      now: Date.parse(dispatchedAt) + 41 * 60_000,
      pidProbe: () => true, // alive AS A GROUP → stalled path, not the dead-pgid orphan path
      progressProbe: () => Date.parse(dispatchedAt),
      killFn: (id, signal) => { killCalls.push({ id, signal }); },
    });

    assert.deepEqual(killCalls, [{ id: -livePgid, signal: 'SIGTERM' }],
      'a detached build must be SIGTERMed as a GROUP (negative pgid) — before this fix the guard ' +
      'looked at currentBuild.pid (absent on a detached build) and silently no-oped');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'build.stalled' && e.item === 'WI-001').length, 1,
      'the stall must actually be recorded (proves the stalled path fired for a pgid-only build)');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Post-integration re-gate tests
//
// Invariant: no build reaches master without a gate that covers every commit
// that landed since the branch point (including concurrent parallel merges).
// ---------------------------------------------------------------------------

test('dispatch: post-integration re-gate passes when master advances during build → merged', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-rebase-pass-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-020', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-020', 'item.queued', {
        spec: 'do X', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    // Provider makes a branch commit AND advances master to simulate a concurrent push.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'x.ts'), '// x', 'utf8');
        spawnSync('git', ['add', 'src/x.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-020): x'], { cwd, stdio: 'pipe' });
        // Advance master in the primary repo while the "build" was running.
        writeFileSync(join(repoRoot, 'concurrent.txt'), 'new', 'utf8');
        spawnSync('git', ['add', 'concurrent.txt'], { cwd: repoRoot, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: concurrent'], { cwd: repoRoot, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'initial gate green' },
      postIntegrationGateResult: { passed: true, reason: 're-gate green' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-020')?.state, 'merged',
      'item must be merged when post-integration re-gate passes');
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-020');
    assert.equal(merged.length, 1, 'exactly one item.merged event');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: post-integration re-gate fails when master advances → parked', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-rebase-fail-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-021', 'item.captured', { source: 'cli', text: 'y' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-021', 'item.queued', {
        spec: 'do Y', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'y.ts'), '// y', 'utf8');
        spawnSync('git', ['add', 'src/y.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-021): y'], { cwd, stdio: 'pipe' });
        // Advance master to trigger the post-integration re-gate path.
        writeFileSync(join(repoRoot, 'concurrent2.txt'), 'new', 'utf8');
        spawnSync('git', ['add', 'concurrent2.txt'], { cwd: repoRoot, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: concurrent2'], { cwd: repoRoot, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'initial gate green' },
      postIntegrationGateResult: { passed: false, reason: 'integration broke the build' },
      branchProbe: () => 'master',
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-021')?.state, 'parked',
      'item must be parked when post-integration re-gate fails');
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-021');
    assert.equal(parked.length, 1, 'exactly one item.parked event');
    const reason = (parked[0].data as { reason: string }).reason;
    assert.ok(reason.includes('post-integration'),
      `park reason must mention post-integration (got: ${reason})`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dispatch non-FF push-race recovery
//
// Unlike the reactor lane (which merges in a scratch worktree and can freely rewrite
// its local `master` ref), dispatch merges directly in the shared primary tree, which
// is checked out ON master. So `git fetch origin master:master` is refused there; the
// recovery instead fetches into the `origin/master` remote-tracking ref and resets onto
// it. These tests set up a REAL bare 'origin' remote (unlike the reactor non-FF tests,
// whose fetch/reset target a purely local ref) so the fetch step has something to pull.
// ---------------------------------------------------------------------------

function setUpOriginWithConcurrentPush(repoRoot: string, tmpDir: string): void {
  const g = (args: string[], cwd = repoRoot) => spawnSync('git', args, { cwd, stdio: 'pipe' });
  const originRoot = join(tmpDir, 'origin.git');
  spawnSync('git', ['init', '--bare', '-b', 'master', originRoot], { stdio: 'pipe' });
  g(['remote', 'add', 'origin', originRoot]);
  g(['push', 'origin', 'master']);

  // Simulate master advancing on origin AFTER repoRoot last synced — a concurrent push
  // from a third clone, invisible to repoRoot's local master ref until it fetches.
  const otherClone = join(tmpDir, 'other-clone');
  spawnSync('git', ['clone', originRoot, otherClone], { stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: otherClone, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: otherClone, stdio: 'pipe' });
  writeFileSync(join(otherClone, 'concurrent.txt'), 'new', 'utf8');
  spawnSync('git', ['add', 'concurrent.txt'], { cwd: otherClone, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'feat: concurrent push race'], { cwd: otherClone, stdio: 'pipe' });
  spawnSync('git', ['push', 'origin', 'master'], { cwd: otherClone, stdio: 'pipe' });
}

test('dispatch: non-FF push rejection triggers re-merge+re-gate; on green, item merges', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-nonff-pass-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    setUpOriginWithConcurrentPush(repoRoot, tmpDir);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-024', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-024', 'item.queued', {
        spec: 'do X', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'x.ts'), '// x', 'utf8');
        spawnSync('git', ['add', 'src/x.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-024): x'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    let pushCallCount = 0;
    const pushProbe = () => {
      pushCallCount++;
      if (pushCallCount === 1) {
        return { status: 1 as number | null, stderr: Buffer.from('rejected (non-fast-forward)') };
      }
      return { status: 0 as number | null };
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'initial gate green' },
      branchProbe: () => 'master',
      pushProbe,
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-024')?.state, 'merged',
      'item must be merged after non-FF push race + re-merge + re-gate');
    assert.equal(pushCallCount, 2, 'push must be attempted twice: initial (rejected) + retry');
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-024');
    assert.equal(merged.length, 1, 'exactly one item.merged event');

    const log = spawnSync('git', ['log', '--oneline', 'master'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString();
    assert.ok(log.includes('concurrent push race'),
      'recovered merge must include the commit that raced ahead on origin');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: non-FF push rejection + re-gate fails → item parked (not transient-fail)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-nonff-red-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    setUpOriginWithConcurrentPush(repoRoot, tmpDir);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-025', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-025', 'item.queued', {
        spec: 'do Z', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'z.ts'), '// z', 'utf8');
        spawnSync('git', ['add', 'src/z.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-025): z'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    // First push: non-FF rejection (triggers the recovery path). Second push never reached.
    let pushCallCount = 0;
    const pushProbe = () => {
      pushCallCount++;
      return { status: 1 as number | null, stderr: Buffer.from('rejected (non-fast-forward)') };
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'initial gate green' },
      nonFfGateResult: { passed: false, reason: 'race broke the build' },
      branchProbe: () => 'master',
      pushProbe,
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-025')?.state, 'parked',
      'item must be parked when the post-push-race re-gate fails (not transient-fail)');
    assert.equal(pushCallCount, 1, 'push only attempted once (retry never reached when re-gate is red)');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-025');
    assert.equal(parked.length, 1, 'exactly one item.parked event');
    const reason = (parked[0].data as { reason: string }).reason;
    assert.ok(reason.includes('post-push-race'), `park reason must mention post-push-race (got: ${reason})`);

    const transient = events.filter(e => e.type === 'merge.transient-fail' && e.item === 'WI-025');
    assert.equal(transient.length, 0, 'must not emit merge.transient-fail when re-gate is red');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: non-FF push rejection + retry push also fails → item re-queued, not zombied', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-nonff-retry-fail-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    setUpOriginWithConcurrentPush(repoRoot, tmpDir);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-026', 'item.captured', { source: 'cli', text: 'w' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-026', 'item.queued', {
        spec: 'do W', touches: 'src/',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'w.ts'), '// w', 'utf8');
        spawnSync('git', ['add', 'src/w.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-026): w'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    // Both the initial push and the post-recovery retry are rejected — recovery succeeds
    // (re-merge + re-gate green) but the item still can't reach master this beat.
    let pushCallCount = 0;
    const pushProbe = () => {
      pushCallCount++;
      return { status: 1 as number | null, stderr: Buffer.from('rejected (non-fast-forward)') };
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'initial gate green' },
      nonFfGateResult: { passed: true, reason: 're-gate green' },
      branchProbe: () => 'master',
      pushProbe,
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const finalState = fold(events).items.get('WI-026')?.state;
    assert.equal(finalState, 'queued',
      `item must re-enter the pickable pool (queued), not zombie in 'gated' (got: ${finalState})`);
    assert.equal(pushCallCount, 2, 'push must be attempted twice: initial (rejected) + retry (also rejected)');

    const transient = events.filter(e => e.type === 'merge.transient-fail' && e.item === 'WI-026');
    assert.equal(transient.length, 1, 'exactly one merge.transient-fail event');
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-026');
    assert.ok(queued.length >= 1, 'must emit item.queued so dispatch re-picks it next beat');
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-026');
    assert.equal(merged.length, 0, 'must not merge when the retry push also fails');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: non-FF push rejection triggers rebase+re-gate; on green, item merges', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-nonff-pass-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    // Create the approved branch
    g(['checkout', '-b', 'wi-022']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-022']);
    g(['checkout', 'master']);

    await seedLedger(ledgerDir, [
      makeEvent('test', 'WI-022', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('test', 'WI-022', 'item.queued', { spec: 'x' }, '2026-01-01T00:01:00Z'),
      makeEvent('test', 'WI-022', 'build.dispatched', {
        attempt: 1, branch: 'wi-022', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('operator', 'WI-022', 'item.approved', { by: 'operator' }, '2026-01-01T00:03:00Z'),
    ]);

    // First gate: passes. Second gate (post-rebase): also passes.
    let gateCallCount = 0;
    const gateRunner = () => {
      gateCallCount++;
      return { passed: true, timedOut: false, reason: 'green' };
    };

    // First push: non-FF rejection. Second push (after rebase): success.
    let pushCallCount = 0;
    const pushProbe = () => {
      pushCallCount++;
      if (pushCallCount === 1) {
        return { status: 1 as number | null, stderr: Buffer.from('rejected (non-fast-forward)') };
      }
      return { status: 0 as number | null };
    };

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner,
      pushProbe,
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-022')?.state, 'merged',
      'item must be merged after non-FF push + rebase + re-gate');
    assert.equal(gateCallCount, 2, 'gate must run twice: initial + post-rebase re-gate');
    assert.equal(pushCallCount, 2, 'push must be attempted twice: initial (rejected) + retry');

    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-022');
    assert.equal(merged.length, 1, 'exactly one item.merged event');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: non-FF push rejection + re-gate fails → item parked (not transient-fail)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-nonff-red-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-023']);
    writeFileSync(join(repoRoot, 'z.txt'), 'z', 'utf8');
    g(['add', 'z.txt']);
    g(['commit', '-m', 'feat: WI-023']);
    g(['checkout', 'master']);

    await seedLedger(ledgerDir, [
      makeEvent('test', 'WI-023', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('test', 'WI-023', 'item.queued', { spec: 'z' }, '2026-01-01T00:01:00Z'),
      makeEvent('test', 'WI-023', 'build.dispatched', {
        attempt: 1, branch: 'wi-023', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('operator', 'WI-023', 'item.approved', { by: 'operator' }, '2026-01-01T00:03:00Z'),
    ]);

    // First gate passes; second gate (post-rebase) fails — integration broke the build.
    let gateCallCount = 0;
    const gateRunner = () => {
      gateCallCount++;
      if (gateCallCount === 1) return { passed: true, timedOut: false, reason: 'green' };
      return { passed: false, timedOut: false, reason: 'integration broke tests' };
    };

    // First push: non-FF rejection (triggers rebase path). Second push never reached.
    let pushCallCount = 0;
    const pushProbe = () => {
      pushCallCount++;
      return { status: 1 as number | null, stderr: Buffer.from('rejected (non-fast-forward)') };
    };

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner,
      pushProbe,
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-023')?.state, 'parked',
      'item must be parked when post-rebase re-gate fails (not transient-fail)');
    assert.equal(gateCallCount, 2, 'gate must run twice: initial + post-rebase re-gate');
    assert.equal(pushCallCount, 1, 'push only attempted once (retry never reached if re-gate fails)');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-023');
    assert.equal(parked.length, 1, 'exactly one item.parked event');
    const reason = (parked[0].data as { reason: string }).reason;
    assert.ok(reason.includes('post-rebase'), `park reason must mention post-rebase (got: ${reason})`);

    // Must NOT emit a merge.transient-fail (re-gate red is a real failure, not transient)
    const transient = events.filter(e => e.type === 'merge.transient-fail' && e.item === 'WI-023');
    assert.equal(transient.length, 0, 'must not emit merge.transient-fail when re-gate is red');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Repair-requeue tests
//
// On first merge conflict or first gate-red after approved merge, the reactor
// must emit item.queued (not item.parked) so dispatch can attempt a repair run.
// Only after a repair also fails should the item be parked.
// ---------------------------------------------------------------------------

test('reactor: merge conflict on approved branch emits item.queued with repairContext (first failure)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-conflict-repair-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'conflict.txt'), 'master', 'utf8');
    g(['add', 'conflict.txt']);
    g(['commit', '-m', 'init']);

    // Branch edits conflict.txt — will conflict with master
    g(['checkout', '-b', 'wi-030']);
    writeFileSync(join(repoRoot, 'conflict.txt'), 'branch', 'utf8');
    g(['add', 'conflict.txt']);
    g(['commit', '-m', 'feat: WI-030']);
    g(['checkout', 'master']);

    // Advance master on the same file — creates a conflict
    writeFileSync(join(repoRoot, 'conflict.txt'), 'master-v2', 'utf8');
    g(['add', 'conflict.txt']);
    g(['commit', '-m', 'feat: master advance']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-030', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-030', 'item.queued', { spec: 'fix conflict' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-030', 'build.dispatched', {
        attempt: 1, branch: 'wi-030', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-030', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-030', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);

    // Must emit gate.failed + item.queued (not item.parked) on first failure
    const gateFailed = events.filter(e => e.type === 'gate.failed' && e.item === 'WI-030' && e.actor === 'reactor');
    assert.equal(gateFailed.length, 1, 'gate.failed must be emitted');

    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-030' && e.actor === 'reactor');
    assert.equal(queued.length, 1, 'item.queued (repair) must be emitted on first conflict — not item.parked');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-030' && e.actor === 'reactor');
    assert.equal(parked.length, 0, 'item must NOT be parked on first conflict');

    const queuedData = queued[0].data as Record<string, unknown>;
    assert.ok(typeof queuedData['repairContext'] === 'string' && queuedData['repairContext'].length > 0,
      `item.queued must carry repairContext (got: ${JSON.stringify(queuedData['repairContext'])})`);
    assert.equal(queuedData['spec'], 'fix conflict', 'original spec must be preserved in repair queue');

    // Fold: item must be back in queued state (dispatchable for repair)
    assert.equal(fold(events).items.get('WI-030')?.state, 'queued',
      'item must be queued (not parked) after first merge conflict');
    assert.ok(fold(events).items.get('WI-030')?.repairContext,
      'fold must carry repairContext from the repair item.queued');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: gate red after approved merge emits item.queued with repairContext (first failure)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-gate-red-repair-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-031']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-031']);
    g(['checkout', 'master']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-031', 'item.captured', { source: 'cli', text: 'y' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-031', 'item.queued', { spec: 'fix tests' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-031', 'build.dispatched', {
        attempt: 1, branch: 'wi-031', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-031', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-031', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner: () => ({ passed: false, timedOut: false, reason: 'tests failed: AssertionError at foo.test.ts:42' }),
    });

    const events = await loadAllEvents(ledgerDir);

    // Must emit gate.failed + item.queued (not item.parked) on first failure
    const gateFailed = events.filter(e => e.type === 'gate.failed' && e.item === 'WI-031' && e.actor === 'reactor');
    assert.equal(gateFailed.length, 1, 'gate.failed must be emitted');

    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-031' && e.actor === 'reactor');
    assert.equal(queued.length, 1, 'item.queued (repair) must be emitted on first gate-red — not item.parked');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-031' && e.actor === 'reactor');
    assert.equal(parked.length, 0, 'item must NOT be parked on first gate-red');

    const queuedData = queued[0].data as Record<string, unknown>;
    assert.ok(typeof queuedData['repairContext'] === 'string' && queuedData['repairContext'].includes('Gate red'),
      `repairContext must mention gate red (got: ${JSON.stringify(queuedData['repairContext'])})`);
    assert.ok((queuedData['repairContext'] as string).includes('AssertionError'),
      'repairContext must include the gate stderr so the worker knows what broke');
    assert.equal(queuedData['spec'], 'fix tests', 'original spec must be preserved');

    // Fold: item back in queued, repairContext set
    const folded = fold(events).items.get('WI-031');
    assert.equal(folded?.state, 'queued', 'item must be queued after first gate-red');
    assert.ok(folded?.repairContext, 'fold must carry repairContext');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: gate failing on stdout-only output carries the output tail in reason + log artifact', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-gate-stdout-only-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-032']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-032']);
    g(['checkout', 'master']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-032', 'item.captured', { source: 'cli', text: 'y' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-032', 'item.queued', { spec: 'fix tests' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-032', 'build.dispatched', {
        attempt: 1, branch: 'wi-032', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-032', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-032', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    // No gateRunner injection here — exercise the real runGateOnce path with a gate command
    // that only prints to stdout (like a plain `npm test` failure), so this proves the fix
    // rather than a mocked reason string.
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig({ gateCommand: "echo 'STDOUT_ONLY_FAILURE_MARKER'; exit 1" }),
    });

    const events = await loadAllEvents(ledgerDir);

    const gateFailed = events.filter(e => e.type === 'gate.failed' && e.item === 'WI-032' && e.actor === 'reactor');
    assert.equal(gateFailed.length, 1, 'gate.failed must be emitted');
    const reason = (gateFailed[0].data as Record<string, unknown>)['reason'];
    assert.ok(typeof reason === 'string' && reason.includes('STDOUT_ONLY_FAILURE_MARKER'),
      `reason must carry the stdout-only output tail (got: ${JSON.stringify(reason)})`);

    const logPath = join(repoRoot, '.ai', 'runs', 'loopkit', 'WI-032-mergegate-1.log');
    assert.ok(existsSync(logPath), `mergegate log artifact must be written to ${logPath}`);
    assert.ok(readFileSync(logPath, 'utf8').includes('STDOUT_ONLY_FAILURE_MARKER'),
      'mergegate log must contain the full gate output');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: merge conflict parks item when repairContext already set (second failure)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-conflict-second-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'conflict.txt'), 'master', 'utf8');
    g(['add', 'conflict.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-032']);
    writeFileSync(join(repoRoot, 'conflict.txt'), 'branch', 'utf8');
    g(['add', 'conflict.txt']);
    g(['commit', '-m', 'feat: WI-032']);
    g(['checkout', 'master']);

    // Advance master to create a conflict
    writeFileSync(join(repoRoot, 'conflict.txt'), 'master-v2', 'utf8');
    g(['add', 'conflict.txt']);
    g(['commit', '-m', 'feat: master advance']);

    // Item was already repair-queued once (repairContext set in item.queued)
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-032', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      // Prior repair queue (first conflict already handled):
      makeEvent('cli', 'WI-032', 'item.queued', {
        spec: 'fix conflict', repairContext: 'Merge conflict integrating prior branch into master.',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-032', 'build.dispatched', {
        attempt: 2, branch: 'wi-032', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-032', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-032', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    // Verify fold has repairContext set before the reactor runs
    const preFold = fold(await loadAllEvents(ledgerDir));
    assert.ok(preFold.items.get('WI-032')?.repairContext, 'pre-condition: fold must have repairContext set');
    assert.equal(preFold.items.get('WI-032')?.state, 'approved');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);

    // Second failure: must park (not re-queue again)
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-032' && e.actor === 'reactor');
    assert.equal(parked.length, 1, 'item must be parked on second conflict (repair also failed)');

    const requeuable = events.filter(e => e.type === 'item.queued' && e.item === 'WI-032' && e.actor === 'reactor');
    assert.equal(requeuable.length, 0, 'must NOT emit another item.queued when repairContext already set');

    assert.equal(fold(events).items.get('WI-032')?.state, 'parked',
      'item must be parked after second consecutive conflict');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: gate red parks item as ops when breaker exhausted (attempts >= breakerN)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-gate-red-second-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    g(['checkout', '-b', 'wi-033']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-033']);
    g(['checkout', 'master']);

    // Item was already repair-queued once (repairContext set)
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-033', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-033', 'item.queued', {
        spec: 'fix tests', repairContext: 'Gate red after approved merge: prior test failure',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-033', 'build.dispatched', {
        attempt: 3, branch: 'wi-033', pid: 1,
      }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-033', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-033', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    const preFold = fold(await loadAllEvents(ledgerDir));
    assert.ok(preFold.items.get('WI-033')?.repairContext, 'pre-condition: repairContext must be set in fold');
    assert.equal(preFold.items.get('WI-033')?.state, 'approved');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner: () => ({ passed: false, timedOut: false, reason: 'still failing after repair' }),
    });

    const events = await loadAllEvents(ledgerDir);

    // Breaker exhausted (attempts >= breakerN): must park, and as an ops-park (off the desk).
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-033' && e.actor === 'reactor');
    assert.equal(parked.length, 1, 'item must be parked once the breaker is exhausted');
    assert.equal((parked[0].data as { parkKind?: string }).parkKind, 'ops',
      'breaker-exhausted merge failure is an ops-park, not an operator decision');

    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-033' && e.actor === 'reactor');
    assert.equal(requeued.length, 0, 'must NOT re-queue once the breaker is exhausted');

    assert.equal(fold(events).items.get('WI-033')?.state, 'parked',
      'item must be parked after the breaker is exhausted');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reactor: gate red re-queues (not park) while breaker has room (attempts < breakerN)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactor-gate-red-requeue-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);
    g(['checkout', '-b', 'wi-034']);
    writeFileSync(join(repoRoot, 'y.txt'), 'y', 'utf8');
    g(['add', 'y.txt']);
    g(['commit', '-m', 'feat: WI-034']);
    g(['checkout', 'master']);

    // Second attempt (attempt 2 < breakerN=3): a fresh gate-red must re-queue, not park.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-034', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-034', 'item.queued', { spec: 'fix tests' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-034', 'build.dispatched', { attempt: 2, branch: 'wi-034', pid: 1 }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-034', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-034', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      gateRunner: () => ({ passed: false, timedOut: false, reason: 'still failing' }),
    });

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-034' && e.actor === 'reactor');
    assert.equal(parked.length, 0, 'must NOT park while the breaker still has room');
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-034' && e.actor === 'reactor');
    assert.equal(requeued.length, 1, 'must re-queue with repair context under the breaker');
    assert.ok((requeued[0].data as { repairContext?: string }).repairContext,
      're-queue must carry repair context');
    assert.equal(fold(events).items.get('WI-034')?.state, 'queued', 'item must be back in the queue');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bounded auto-requeue of no-commit ops-parks
// ---------------------------------------------------------------------------

test('shouldRequeueOpsPark: matches the transient ops-park classes (no-commit + merge conflict) under the breaker', () => {
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'ops', parkReason: 'no-commit: agent produced no commit', attempts: 1 }, 3),
    true, 'a fresh no-commit ops-park under the breaker must requeue',
  );
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'ops', parkReason: 'no-commit: agent produced no commit', attempts: 3 }, 3),
    false, 'breaker-exhausted no-commit park must NOT requeue',
  );
  // WI-046-class: the built branch couldn't fast-merge because main moved during the build. A
  // fresh rebuild off the settled main clears it — it used to sit parked forever (no requeue path).
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'ops', parkReason: "target merge conflict on 'main'", attempts: 1 }, 3),
    true, 'a fresh merge-conflict ops-park under the breaker must requeue',
  );
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'ops', parkReason: "target merge conflict on 'main'", attempts: 3 }, 3),
    false, 'breaker-exhausted merge-conflict park must NOT loop',
  );
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'ops', parkReason: 'breaker: 3 attempts exhausted', attempts: 1 }, 3),
    false, 'a breaker-exhaustion ops-park is already terminal — must not re-enter this predicate',
  );
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'ops', parkReason: 'merge gate timed out 2×: not a test failure', attempts: 1 }, 3),
    false, 'a merge-gate-timeout ops-park has its own requeue path — must not double-requeue here',
  );
  assert.equal(
    shouldRequeueOpsPark({ state: 'parked', parkKind: 'decision', parkReason: 'no-commit: agent produced no commit', attempts: 1 }, 3),
    false, 'a decision park must never auto-requeue regardless of reason text',
  );
  assert.equal(
    shouldRequeueOpsPark({ state: 'queued', parkKind: 'ops', parkReason: 'no-commit: agent produced no commit', attempts: 1 }, 3),
    false, 'only a currently-parked item is eligible',
  );
});

test('reactor: bounded auto-requeue re-queues a no-commit ops-park while the breaker has room', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-366', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-366', 'item.queued', { spec: 'fix thing', touches: 'src/' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-366', 'build.dispatched', { attempt: 1, branch: 'wi-366', pid: 1 }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-366', 'gate.failed', { reason: 'no-commit: agent produced no commit' }, '2026-01-01T00:03:00Z'),
      makeEvent('dispatch', 'WI-366', 'item.parked', { reason: 'no-commit: agent produced no commit', parkKind: 'ops' }, '2026-01-01T00:03:00Z'),
    ]);

    const preFold = fold(await loadAllEvents(ledgerDir));
    assert.equal(preFold.items.get('WI-366')?.state, 'parked', 'pre-condition: item must be parked');

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-366' && e.actor === 'reactor');
    assert.equal(requeued.length, 1, 'must re-queue the no-commit ops-park under the breaker');
    assert.ok((requeued[0].data as { repairContext?: string }).repairContext?.includes('no-commit'),
      're-queue must carry a repair note referencing the no-commit park');
    assert.equal((requeued[0].data as { touches?: string }).touches, 'src/', 're-queue must carry the item\'s Touches forward');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-366' && e.actor === 'reactor');
    assert.equal(parked.length, 0, 'must not re-park in the same beat it requeues');
    assert.equal(fold(events).items.get('WI-366')?.state, 'queued', 'item must be back in the queue');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: bounded auto-requeue leaves a no-commit ops-park parked once the breaker is exhausted', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-367', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-367', 'item.queued', { spec: 'fix thing' }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-367', 'build.dispatched', { attempt: 3, branch: 'wi-367', pid: 1 }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-367', 'gate.failed', { reason: 'no-commit: agent produced no commit' }, '2026-01-01T00:03:00Z'),
      makeEvent('dispatch', 'WI-367', 'item.parked', { reason: 'no-commit: agent produced no commit', parkKind: 'ops' }, '2026-01-01T00:03:00Z'),
    ]);

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-367' && e.actor === 'reactor');
    assert.equal(requeued.length, 0, 'must NOT re-queue once the breaker is exhausted (attempts >= breakerN)');
    assert.equal(fold(events).items.get('WI-367')?.state, 'parked', 'item must remain parked, off the operator desk');
    assert.equal(fold(events).items.get('WI-367')?.parkKind, 'ops', 'must stay an ops-park, never escalate to a decision park');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Conductor park emits parkKind:'decision', decisionCount excludes 'hold' parks
// ---------------------------------------------------------------------------

test('conductor park route emits item.parked with parkKind:decision', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-090', 'item.captured', { source: 'test', text: 'switch to hosted postgres' }),
    ]);

    const parkBlock = [
      'ROUTE: park',
      'SPEC: Costly and irreversible — needs an operator call.',
      'REPLY: Parked for your decision.',
    ].join('\n');

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(parkBlock),
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-090');
    assert.equal(parked.length, 1, 'one item.parked event');
    const d = parked[0].data as { reason: string; parkKind?: string };
    assert.equal(d.parkKind, 'decision', 'conductor park must carry parkKind:decision');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('SLO decisionCount counts parkKind:decision, excludes parkKind:hold', async () => {
  // A parked item with parkKind:'decision' must be counted in decisionCount;
  // one with no parkKind and a reason that doesn't contain 'decision' must not be.
  const dir = mkdtempSync(join(tmpdir(), 'wi215-count-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });
    const nowMs = Date.now();

    // Seed two parked items:
    //   WI-301: parkKind:'decision' — must be counted
    //   WI-302: no parkKind, reason doesn't contain 'decision' — must NOT be counted
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-301', 'item.captured', { source: 'test', text: 'deploy to prod' }),
      makeEvent('cli', 'WI-301', 'item.parked', { reason: 'costly step', parkKind: 'decision' as const }),
      makeEvent('cli', 'WI-302', 'item.captured', { source: 'test', text: 'build X' }),
      makeEvent('cli', 'WI-302', 'item.parked', { reason: 'approved merge: rebuild needed' }),
    ]);

    // Run reactor and check the loop.beat result
    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      sloProbes: {
        now: () => nowMs,
        reactorLastrun: () => Math.floor(nowMs / 1000) - 10,
        dispatchLastrun: () => Math.floor(nowMs / 1000) - 10,
        backup: () => 2,
        watchNightly: () => nowMs - 1000,
        watchHourly: () => nowMs - 1000,
        deploy: () => ({ behindCount: 0 }),
        // fold is intentionally NOT injected so reactor builds it from allEvents
      },
    });

    // Verify the WI-301 parked event carries parkKind:decision.
    const events = await loadAllEvents(ledgerDir);
    const wi301Parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-301');
    const pk = (wi301Parked[0].data as { parkKind?: string }).parkKind;
    assert.equal(pk, 'decision', 'WI-301 parked event carries parkKind:decision');

    // The fold should see 2 parked items (both WI-301 and WI-302 are parked).
    const beatEvents = events.filter(e => e.type === 'loop.beat' && e.actor === 'reactor');
    assert.ok(beatEvents.length >= 1, 'loop.beat must be written');
    const beatResult = JSON.parse((beatEvents[beatEvents.length - 1].data as { result: string }).result) as { parked: number };
    assert.equal(beatResult.parked, 2, 'fold must see 2 parked items');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parked-decision phone push — once per item+park-event, durable dedupe
// ---------------------------------------------------------------------------

test('decision park fires notify once, stamp dedupes on second run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi211-notify-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    // Seed one decision-parked item.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-400', 'item.captured', { source: 'test', text: 'switch to hosted postgres' }),
      makeEvent('cli', 'WI-400', 'item.parked', { reason: 'costly decision needed', parkKind: 'decision' as const }),
    ]);

    const notifications: string[] = [];
    const runOnce = () => runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    // First run: decision park has no stamp → notify is called once.
    await runOnce();
    assert.equal(notifications.length, 1, 'notify must fire exactly once on first run');
    assert.ok(notifications[0].includes('WI-400'), 'notification must include the item id');

    // Second run: stamp exists → notify must NOT be called again.
    const countBeforeSecond = notifications.length;
    await runOnce();
    assert.equal(notifications.length, countBeforeSecond, 'notify must NOT fire again (stamp dedupe)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HOLD park (non-decision reason) does not trigger notify', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi211-hold-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    // Seed a parked item with a non-decision reason (merge-failure).
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-401', 'item.captured', { source: 'test', text: 'build X' }),
      makeEvent('cli', 'WI-401', 'item.parked', { reason: 'approved merge: rebuild needed' }),
    ]);

    const notifications: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    assert.equal(notifications.length, 0, 'HOLD park must not fire notify');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merged item (was parked, now merged) is not notified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi211-merged-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    // Item was parked (decision), then approved and merged → state = merged.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-402', 'item.captured', { source: 'test', text: 'build Y' }),
      makeEvent('cli', 'WI-402', 'item.parked', { reason: 'needs decision', parkKind: 'decision' as const }),
      makeEvent('cli', 'WI-402', 'item.approved', { by: 'operator' }),
      makeEvent('cli', 'WI-402', 'item.merged', { commit: 'abc123' }),
    ]);

    const notifications: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    assert.equal(notifications.length, 0, 'merged item must not be notified even if its park was a decision park');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new park on same item (after unpark+re-park) fires notify again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi211-repark-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    const events = [
      makeEvent('cli', 'WI-403', 'item.captured', { source: 'test', text: 'build Z' }),
      makeEvent('cli', 'WI-403', 'item.parked', { reason: 'original decision needed', parkKind: 'decision' as const }),
    ];
    await seedLedger(ledgerDir, events);

    const notifications: string[] = [];
    const run = () => runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    // First run: fires for the first park event.
    await run();
    assert.equal(notifications.length, 1, 'first park fires notify');

    // Item is unparked and re-parked with a NEW park event.
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-403', 'item.unparked', { by: 'operator' }),
      makeEvent('cli', 'WI-403', 'item.parked', { reason: 'second decision needed', parkKind: 'decision' as const }),
    ]);

    // Second run: new park event → fires again (different stamp file).
    await run();
    assert.equal(notifications.length, 2, 'second (new) park event fires notify again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Needs-test phone push — once per merged item landing in a review/must
// acceptance tier, durable dedupe
// ---------------------------------------------------------------------------

test('needs-test notify: merged item touching a risk path (must tier) fires exactly once across two beats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-test-notify-must-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-500', 'item.captured', { source: 'test', text: 'touch billing code' }),
      makeEvent('conductor', 'WI-500', 'item.queued', { spec: 'touch billing code', touches: 'apps/example/src/billing/plan.ts' }),
      makeEvent('dispatch', 'WI-500', 'item.merged', { commit: 'abc500', deployed: false }),
    ]);

    const notifications: string[] = [];
    const runOnce = () => runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    // First beat: must-tier merged item → fires exactly once.
    await runOnce();
    assert.equal(notifications.length, 1, 'must-tier merged item fires notify exactly once');
    assert.ok(notifications[0].includes('WI-500'), 'notification must include the item id');
    assert.ok(notifications[0].includes('must'), 'notification must include the tier');

    // Second beat: item is still 'merged' (not yet accepted) → stamp dedupes, no re-fire.
    const countBeforeSecond = notifications.length;
    await runOnce();
    assert.equal(notifications.length, countBeforeSecond, 'needs-test notify must NOT fire again once delivered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needs-test notify: merged item with only plane files (auto tier) does not fire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-test-notify-auto-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-501', 'item.captured', { source: 'test', text: 'tidy plane script' }),
      makeEvent('conductor', 'WI-501', 'item.queued', { spec: 'tidy plane script', touches: '.loopkit/scripts/tidy.ts' }),
      makeEvent('dispatch', 'WI-501', 'item.merged', { commit: 'abc501', deployed: false }),
    ]);

    const notifications: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    assert.equal(notifications.length, 0, 'auto-tier merged item must not trigger a needs-test push');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needs-test notify: merged item with non-surface, non-plane files (optional tier) does not fire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-test-notify-optional-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-502', 'item.captured', { source: 'test', text: 'refactor a helper' }),
      makeEvent('conductor', 'WI-502', 'item.queued', { spec: 'refactor a helper', touches: 'apps/example/src/lib/helper.ts' }),
      makeEvent('dispatch', 'WI-502', 'item.merged', { commit: 'abc502', deployed: false }),
    ]);

    const notifications: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: (msg) => { notifications.push(msg); },
    });

    assert.equal(notifications.length, 0, 'optional-tier merged item must not trigger a needs-test push');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needs-test notify: merged item touching a declared surface (review tier) fires once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-test-notify-review-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-503', 'item.captured', { source: 'test', text: 'new screen' }),
      makeEvent('conductor', 'WI-503', 'item.queued', { spec: 'new screen', touches: 'apps/example/src/public/board.ts' }),
      makeEvent('dispatch', 'WI-503', 'item.merged', { commit: 'abc503', deployed: false }),
    ]);

    const notifications: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig({
        acceptance: {
          ...CONFIG_DEFAULTS.acceptance!,
          tiers: {
            ...CONFIG_DEFAULTS.acceptance!.tiers!,
            surfacePrefixes: ['apps/example/src/public/'],
          },
        },
      }),
      notify: (msg) => { notifications.push(msg); },
    });

    assert.equal(notifications.length, 1, 'review-tier merged item fires notify exactly once');
    assert.ok(notifications[0].includes('WI-503'), 'notification must include the item id');
    assert.ok(notifications[0].includes('review'), 'notification must include the tier');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needs-test notify: empty notifyHook is a no-op (no hook file, no injected notify)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-test-notify-nohook-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-504', 'item.captured', { source: 'test', text: 'touch billing code' }),
      makeEvent('conductor', 'WI-504', 'item.queued', { spec: 'touch billing code', touches: 'apps/example/src/billing/plan.ts' }),
      makeEvent('dispatch', 'WI-504', 'item.merged', { commit: 'abc504', deployed: false }),
    ]);

    // No `notify` override and no notify-hook file on disk at cfg.notifyHook — the default
    // notifyFn must see the missing hook, return false, and the beat must still complete ok.
    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
    });

    const step = result.steps.find(s => s.step === 'notify-needs-test');
    assert.ok(step, 'notify-needs-test step must run');
    assert.equal(step!.ok, true, 'missing notify hook must not fail the beat');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needs-test notify: a throwing notify hook does not fail the beat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-test-notify-throws-'));
  try {
    const repoRoot = dir;
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-505', 'item.captured', { source: 'test', text: 'touch billing code' }),
      makeEvent('conductor', 'WI-505', 'item.queued', { spec: 'touch billing code', touches: 'apps/example/src/billing/plan.ts' }),
      makeEvent('dispatch', 'WI-505', 'item.merged', { commit: 'abc505', deployed: false }),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      notify: () => { throw new Error('transport exploded'); },
    });

    const step = result.steps.find(s => s.step === 'notify-needs-test');
    assert.ok(step, 'notify-needs-test step must run');
    assert.equal(step!.ok, true, 'a throwing notify hook must not fail the beat');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveAttachmentPaths + attachment prompt wiring
// ---------------------------------------------------------------------------

import { resolveAttachmentPaths } from '../src/schema.js';

test('resolveAttachmentPaths parses attachment markers into absolute paths', () => {
  const text = [
    'Please review this design.',
    'attachment: EXT-12/mockup.png (102400 bytes)',
    'attachment: EXT-12/spec.pdf (20480 bytes)',
    'Some other text.',
  ].join('\n');

  const paths = resolveAttachmentPaths(text, { LOOPKIT_UPLOADS_ROOT: '/uploads', HOME: '/home/user' });
  assert.deepEqual(paths, [
    '/uploads/EXT-12/mockup.png',
    '/uploads/EXT-12/spec.pdf',
  ]);
});

test('resolveAttachmentPaths falls back to <HOME>/.loopkit/uploads when env unset', () => {
  const text = 'attachment: EXT-5/doc.txt (1000 bytes)';
  const paths = resolveAttachmentPaths(text, { HOME: '/home/operator' });
  assert.deepEqual(paths, ['/home/operator/.loopkit/uploads/EXT-5/doc.txt']);
});

test('resolveAttachmentPaths returns [] for text with no markers', () => {
  assert.deepEqual(resolveAttachmentPaths('Just a plain request.', {}), []);
});

test('resolveAttachmentPaths returns [] for undefined input', () => {
  assert.deepEqual(resolveAttachmentPaths(undefined, {}), []);
});

test('stepRoute includes attachment paths in the routing prompt', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    // Item with an attachment marker in its sourceText.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-500', 'item.captured', {
        source: 'test',
        text: 'Review this design.\nattachment: EXT-77/design.png (5000 bytes)',
      }),
    ]);

    let capturedPrompt = '';
    const capturingProvider: LlmProvider = {
      name: 'capturer',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        return { ok: true, text: 'ROUTE: answer\nREPLY: Got it.' };
      },
    };

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: capturingProvider,
      config: makeTestConfig(),
    });

    assert.ok(capturedPrompt.includes('ATTACHMENTS'), `prompt must include ATTACHMENTS section (got: ${capturedPrompt.slice(0, 300)})`);
    assert.ok(capturedPrompt.includes('EXT-77/design.png'), 'prompt must include the attachment path');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Acceptance SLO probe numbers
// ---------------------------------------------------------------------------

test('computeAcceptanceDebt: N merged-not-accepted items in last 7d → acceptanceCount=N, oldestAcceptanceHours defined', () => {
  const nowMs = new Date('2026-07-11T12:00:00Z').getTime();
  // Two merged items within the window, neither accepted
  const mergedAt1 = '2026-07-09T12:00:00Z'; // 48h ago
  const mergedAt2 = '2026-07-10T12:00:00Z'; // 24h ago
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-010', 'item.merged', { commit: 'aaa' }, mergedAt1),
    makeEvent('reactor', 'WI-011', 'item.merged', { commit: 'bbb' }, mergedAt2),
  ];
  const result = fold(events);
  const debt = computeAcceptanceDebt(result, nowMs);
  assert.equal(debt.acceptanceCount, 2, 'both merged items should count as acceptance debt');
  assert.ok(debt.oldestAcceptanceHours !== undefined, 'oldestAcceptanceHours must be defined');
  // The oldest is ~48h; newest is ~24h. The helper returns the MAX.
  assert.ok(debt.oldestAcceptanceHours > 24, `expected oldestAcceptanceHours > 24, got ${debt.oldestAcceptanceHours}`);
});

// ---------------------------------------------------------------------------
// Dispatch cost metering + daily budget ceiling
// ---------------------------------------------------------------------------

test('dispatch: completed build emits cost.usage with loop=dispatch and wi field', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cost-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // Provider returns real usage figures.
    const provider: LlmProvider = {
      name: 'claude-cli',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'a.ts'), '// done', 'utf8');
        spawnSync('git', ['add', 'src/a.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat: impl'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 1200, out: 300, usd: 0.0045 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
      scoutEnabled: false,  // isolate dispatch cost.usage from scout cost.usage
    });

    const events = await loadAllEvents(ledgerDir);
    const costEvents = events.filter(e => e.type === 'cost.usage');
    assert.equal(costEvents.length, 1, 'exactly one cost.usage event must be emitted');
    const d = costEvents[0].data as { provider: string; loop: string; tokens: number; usd?: number; wi?: string };
    assert.equal(d.loop, 'dispatch', 'loop must be dispatch');
    assert.equal(d.provider, 'claude-cli');
    assert.equal(d.tokens, 1500, 'tokens = in + out (1200 + 300)');
    assert.ok(Math.abs((d.usd ?? 0) - 0.0045) < 1e-9, `usd should be 0.0045 (got ${d.usd})`);
    assert.equal(d.wi, 'WI-001', 'wi must carry the work-item id');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: batch build carries comma-joined wi field', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cost-batch-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'a', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'b', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'claude-cli',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'a.ts'), '// a', 'utf8');
        spawnSync('git', ['add', 'src/a.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): a'], { cwd, stdio: 'pipe' });
        writeFileSync(join(cwd, 'src', 'b.ts'), '// b', 'utf8');
        spawnSync('git', ['add', 'src/b.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-002): b'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 500, out: 200, usd: 0.002 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'fake' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
      scoutEnabled: false,  // isolate dispatch cost.usage from scout cost.usage
    });

    const events = await loadAllEvents(ledgerDir);
    const costEvents = events.filter(e => e.type === 'cost.usage');
    // One build = one cost event for the batch group
    assert.equal(costEvents.length, 1, 'one cost.usage per batch group, not per item');
    const d = costEvents[0].data as { wi?: string; tokens: number };
    // wi must contain both item ids
    assert.ok(d.wi?.includes('WI-001') && d.wi?.includes('WI-002'),
      `wi must contain both batched item ids (got: ${d.wi})`);
    assert.equal(d.tokens, 700, 'tokens = 500 + 200');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: budget ceiling reached skips picks (watchdog still runs)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    // Pre-seed a cost event that exceeds the ceiling for today
    const today = new Date().toISOString().slice(0, 10);
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }),
      // Already spent 0.05 today
      makeEvent('dispatch', 'system', 'cost.usage', {
        provider: 'claude-cli', loop: 'dispatch', tokens: 5000, usd: 0.05,
      }, `${today}T08:00:00.000Z`),
    ]);

    let watchdogCalled = false;

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig({ budget: { dispatchDailyUsd: 0.03 } }),
      // Reactor lastrun is stale → watchdog would fire if not for the label being empty
      // (reactorLabel is '' by default, which skips the kickstart). We inject a probe to
      // verify watchdog code ran (i.e. it was not short-circuited before the watchdog check).
      reactorLastrunProbe: () => Math.floor(Date.now() / 1000) - 400, // stale
      watchdogSpawn: (cmd, args) => {
        watchdogCalled = true;
        return { ok: true, output: 'kicked' };
      },
      authProbeResult: { ok: true },
    });

    // No items dispatched — budget was reached
    assert.equal(result.dispatched.length, 0, 'budget ceiling must prevent dispatching');
    assert.ok(result.detail?.includes('daily budget reached'), `detail must mention budget (got: ${result.detail})`);

    // Ledger must not have grown with any build.dispatched event
    const events = await loadAllEvents(ledgerDir);
    const dispatched = events.filter(e => e.type === 'build.dispatched');
    assert.equal(dispatched.length, 0, 'no build.dispatched events when budget is reached');

    // Item must stay queued (not building)
    assert.equal(fold(events).items.get('WI-001')?.state, 'queued');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: no budget config = no ceiling (default behaviour unchanged)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }),
    ]);

    // No budget in config — dispatch proceeds normally (dry-run to avoid real git ops)
    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),   // budget absent
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 1, 'no budget config must not block dispatch');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: quota pressure at/above threshold skips picks (reactor unaffected)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }),
      makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'five_hour', usedPct: 85 }),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig({ quotaPressure: { thresholdPct: 80 } }),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 0, 'quota pressure must prevent dispatching');
    assert.ok(result.detail?.includes('quota pressure'), `detail must mention quota pressure (got: ${result.detail})`);
    assert.ok(result.detail?.includes('claude:five_hour=85.0%'), `detail must name the breaching window (got: ${result.detail})`);

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'build.dispatched').length, 0, 'no build.dispatched events under quota pressure');
    assert.equal(fold(events).items.get('WI-001')?.state, 'queued', 'item stays queued, never picked');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: quota pressure below threshold dispatches normally', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }),
      makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'five_hour', usedPct: 40 }),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig({ quotaPressure: { thresholdPct: 80 } }),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 1, 'quota below threshold must not block dispatch');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: window reset (high stale reading, low latest reading) must not false-trigger', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }),
      makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'seven_day', usedPct: 95 }, '2026-07-18T09:00:00.000Z'),
      makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'seven_day', usedPct: 10 }, '2026-07-19T09:00:00.000Z'),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      dryRun: true,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig({ quotaPressure: { thresholdPct: 80 } }),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 1, 'a window reset (latest reading low) must not false-trigger degraded mode');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: quotaPressureProbe injection simulates degraded mode without quota.snapshot events', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'task' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'task', touches: 'src/' }),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: makeFakeProvider(),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
      quotaPressureProbe: () => true,
    });

    assert.equal(result.dispatched.length, 0, 'injected probe must gate dispatch without real quota.snapshot events');
    assert.ok(result.detail?.includes('quota pressure'));
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Delivery-lane gate selection
//
// The item's `lane` picks its definition-of-done gate: engineering keeps running the
// real shell gate (npm test), a non-code lane runs the claim-audit rubric instead.
// Both fold to the identical gate.passed/gate.failed shape. Neither test injects
// `gateResult` — the real lane-aware gate runs, so these prove the selection itself,
// not just that the injected value passes through.
// ---------------------------------------------------------------------------

test('dispatch: engineering lane (default, no lane on the item) still runs the npm-test gate unchanged', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-lane-engineering-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-300', 'item.captured', { source: 'cli', text: 'ship a slice' }, '2026-01-01T00:00:00Z'),
      // No `lane` field — must default to 'engineering' via the fold.
      makeEvent('cli', 'WI-300', 'item.queued', { spec: 'ship a slice', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'x.ts'), '// x', 'utf8');
        spawnSync('git', ['add', 'src/x.ts'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-300): x'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    // gateResult NOT injected — the real gate runs. gateCommand 'exit 0' (makeTestConfig
    // default) so the shell gate passes if and only if it actually ran.
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-300')?.state, 'merged', 'engineering item must merge on a green shell gate');
    const passed = events.filter(e => e.type === 'gate.passed' && e.item === 'WI-300');
    assert.equal(passed.length, 1, 'exactly one gate.passed');
    assert.equal((passed[0].data as { tests?: string }).tests, 'green', 'engineering lane reports the shell-gate shape unchanged');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: non-code lane runs the claim-audit gate instead of npm test, and folds to the same events', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-lane-marketing-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-301', 'item.captured', { source: 'cli', text: 'draft homepage copy' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-301', 'item.queued', {
        spec: 'draft homepage copy', touches: 'content/marketing/', lane: 'marketing',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        mkdirSync(join(cwd, 'content', 'marketing'), { recursive: true });
        writeFileSync(join(cwd, 'content', 'marketing', 'copy.md'), '# copy', 'utf8');
        spawnSync('git', ['add', 'content/marketing/copy.md'], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-301): copy'], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    // gateCommand is deliberately always-red — if the marketing item ran the shell
    // gate it would fail. Only a real claim-audit selection lets this merge.
    const cfg = makeTestConfig({
      gateCommand: 'exit 1',
      lanes: {
        engineering: { description: 'Engineering', gate: 'npm test', delivery: 'merge', publishGated: false },
        marketing: { description: 'Marketing', gate: 'claim-audit', delivery: 'merge', publishGated: true },
      },
    });

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: cfg,
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-301')?.state, 'merged',
      'marketing item must merge on a claim-audit pass even though the shell gate would have failed');
    const passed = events.filter(e => e.type === 'gate.passed' && e.item === 'WI-301');
    assert.equal(passed.length, 1, 'exactly one gate.passed');
    assert.match((passed[0].data as { reason?: string }).reason ?? '', /^claim-audit passed:/,
      'the claim-audit gate ran, not the shell gate');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Planning lane
// ---------------------------------------------------------------------------

test('parsePlannerRemaining: extracts bullet lines after REMAINING:, ignores everything else', () => {
  const text = [
    'QUEUED: build the first slice',
    'REMAINING:',
    '- build the second slice',
    '- build the third slice',
  ].join('\n');
  assert.deepEqual(parsePlannerRemaining(text), ['build the second slice', 'build the third slice']);
});

test('parsePlannerRemaining: no REMAINING marker → empty (fail-open, not an error)', () => {
  assert.deepEqual(parsePlannerRemaining('QUEUED: build the only slice'), []);
});

test('buildPlannerPrompt: injects item id and spec after the prompt-of-record content', () => {
  const p = buildPlannerPrompt('PROMPT BODY', 'WI-400', 'decompose WI-399: too big');
  assert.match(p, /^PROMPT BODY/);
  assert.match(p, /ID: WI-400/);
  assert.match(p, /SPEC: decompose WI-399: too big/);
});

test('dispatch: planning lane queues a child via loopctl new, merges with no source commit, no worktree needed', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'planner.md'), 'stub planner prompt');
  try {
    await seedLedger(ledgerDir, [
      makeEvent('reactor', 'WI-400', 'item.captured', { source: 'decompose:WI-399', text: 'decompose WI-399: too big' }),
      makeEvent('reactor', 'WI-400', 'item.queued', { spec: 'decompose WI-399: too big', lane: 'planning' }),
    ]);

    // Simulates the planner's `loopctl new` tool call: it appends an item.captured event
    // to the SAME ledger (no worktree/git — the whole point of the planning lane) and
    // reports one queued child plus one still-to-decompose child in the trail block.
    const provider: LlmProvider = {
      name: 'fake-planner',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        assert.equal(req.cwd, repoRoot, 'planner must run against the primary tree, not a worktree');
        assert.ok(req.tools?.includes('Read') && req.tools?.includes('Grep') && req.tools?.includes('Glob'),
          'planner must get read-only repo tools');
        assert.ok(!req.tools?.some(t => t.startsWith('Bash(git') || t === 'Edit' || t === 'Write'),
          'planner must never be granted git/Edit/Write tools');
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-401', 'item.captured', { source: 'cli', text: 'first buildable child slice' }),
        ]);
        return {
          ok: true,
          text: 'QUEUED: first buildable child slice\nREMAINING:\n- second child slice',
        };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(), authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.find(d => d.item === 'WI-400')?.gateOutcome, 'passed');

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-400')?.state, 'merged', 'the planning item resolves to merged (A2 non-code DOD)');
    const merged = events.find(e => e.type === 'item.merged' && e.item === 'WI-400');
    assert.equal((merged?.data as { commit?: string }).commit, 'none (planning lane — no source changes)');
    assert.equal((merged?.data as { deployed?: boolean }).deployed, false, 'a planning merge must never trigger a real deploy');

    assert.equal(folded.items.get('WI-401')?.state, 'captured', 'the queued child landed in the real (non-worktree) ledger');

    const trail = events.find(e => e.type === 'msg.out' && e.item === 'WI-400');
    assert.ok(trail, 'a trail note must record the still-remaining children');
    assert.match((trail?.data as { text?: string }).text ?? '', /second child slice/);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: planning lane — no child queued is gate.failed and requeues under the breaker', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'planner.md'), 'stub planner prompt');
  try {
    await seedLedger(ledgerDir, [
      makeEvent('reactor', 'WI-410', 'item.captured', { source: 'decompose:WI-409', text: 'decompose WI-409: unclear' }),
      makeEvent('reactor', 'WI-410', 'item.queued', { spec: 'decompose WI-409: unclear', lane: 'planning' }),
    ]);

    // Never calls loopctl new — no child appears in the ledger.
    const provider = makeFakeProvider('QUEUED: (nothing — could not decompose)');

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(), authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-410')?.state, 'queued', 'attempt 1 of 3 requeues, not parks');
    assert.equal(events.filter(e => e.type === 'gate.failed' && e.item === 'WI-410').length, 1);
    assert.equal(events.filter(e => e.type === 'item.parked' && e.item === 'WI-410').length, 0);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: planning lane — missing planner.md prompt parks (ops) instead of silently dropping the item', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  // Deliberately no .ai/loops/prompts/planner.md written.
  try {
    await seedLedger(ledgerDir, [
      makeEvent('reactor', 'WI-420', 'item.captured', { source: 'decompose:WI-419', text: 'decompose WI-419: x' }),
      makeEvent('reactor', 'WI-420', 'item.queued', { spec: 'decompose WI-419: x', lane: 'planning' }),
    ]);

    let called = false;
    const provider: LlmProvider = {
      name: 'should-not-run',
      async run(): Promise<ProviderResult> { called = true; return { ok: true, text: '' }; },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(), authProbeResult: { ok: true },
    });

    assert.equal(called, false, 'never spend a provider call when there is no prompt-of-record to send');
    const events = await loadAllEvents(ledgerDir);
    const park = events.find(e => e.type === 'item.parked' && e.item === 'WI-420');
    assert.equal((park?.data as { parkKind?: string }).parkKind, 'ops', 'infra failure parks as ops, never on the operator desk');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('dispatch: planning lane runs independently of a conflicting in-flight engineering build (no wildcard block)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'planner.md'), 'stub planner prompt');
  try {
    await seedLedger(ledgerDir, [
      // An engineering item already 'building' with NO declared touches (wildcard footprint).
      makeEvent('cli', 'WI-430', 'item.captured', { source: 'cli', text: 'a' }),
      makeEvent('cli', 'WI-430', 'item.queued', { spec: 'do A' }),
      makeEvent('dispatch', 'WI-430', 'build.dispatched', { attempt: 1, worktree: '/tmp/x', branch: 'wi-430-a1' }),
      // A planning item queued alongside it.
      makeEvent('reactor', 'WI-431', 'item.captured', { source: 'decompose:WI-429', text: 'decompose WI-429: y' }),
      makeEvent('reactor', 'WI-431', 'item.queued', { spec: 'decompose WI-429: y', lane: 'planning' }),
    ]);

    const provider: LlmProvider = {
      name: 'fake-planner',
      async run(): Promise<ProviderResult> {
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-432', 'item.captured', { source: 'cli', text: 'child' }),
        ]);
        return { ok: true, text: 'QUEUED: child' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(), authProbeResult: { ok: true },
    });

    const folded = fold(await loadAllEvents(ledgerDir));
    assert.equal(folded.items.get('WI-431')?.state, 'merged',
      'a wildcard-footprint in-flight ENGINEERING build must never block the planning lane');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Run-controls hard-stop
// ---------------------------------------------------------------------------

test('hasUnconsumedCancelRequest: attempt matching — pending for the named attempt only', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:01:00Z'),
  ];
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-001', 1), true, 'a fresh cancel-requested for attempt 1 is pending');
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-001', 2), false, 'a cancel-requested for attempt 1 must never apply to attempt 2');
});

test('hasUnconsumedCancelRequest: superseded by a later build.dispatched for a different attempt', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.crashed', { reason: 'infra: x' }, '2026-01-01T00:02:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 2, branch: 'wi-001-a2' }, '2026-01-01T00:03:00Z'),
  ];
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-001', 1), false, 'attempt 1 request must be consumed once attempt 2 dispatches');
});

test('hasUnconsumedCancelRequest: consumed by a matching build.cancelled', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.cancelled', { attempt: 1, by: 'operator' }, '2026-01-01T00:02:00Z'),
  ];
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-001', 1), false, 'a matching build.cancelled consumes the request');
});

test('hasUnconsumedCancelRequest: consumed by item.merged (the item shipped despite the request)', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:01:00Z'),
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc' }, '2026-01-01T00:02:00Z'),
  ];
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-001', 1), false, 'a merge after the cancel request settles it — no lingering pending state');
});

test('hasUnconsumedCancelRequest: never crosses item ids', () => {
  const events = [
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:00:00Z'),
  ];
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-002', 1), false);
});

test('hasUnconsumedCancelRequest: no cancel-requested at all is never pending', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001-a1' }, '2026-01-01T00:00:00Z'),
  ];
  assert.equal(hasUnconsumedCancelRequest(events, 'WI-001', 1), false);
});

test('dispatch: pre-dispatch check parks a queued item carrying an unconsumed cancel-requested (cheap path, no worktree)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cancel-predispatch-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'src/' }, '2026-01-01T00:01:00Z'),
      // A cancel-requested for the attempt this beat is about to dispatch (attempt 1 — the item
      // has never built before, so its next attempt IS 1). Simulates an operator Stop click that
      // raced a crash/requeue cycle: the request landed but no build was in flight to kill.
      makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:02:00Z'),
    ]);

    let providerCalled = false;
    const provider: LlmProvider = {
      name: 'should-not-run',
      async run(): Promise<ProviderResult> {
        providerCalled = true;
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(),
      branchProbe: () => 'master', authProbeResult: { ok: true },
    });

    assert.equal(providerCalled, false, 'a pre-dispatch cancelled item must never spawn a worktree or call the provider');

    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.equal(parked.length, 1);
    assert.equal((parked[0].data as Record<string, unknown>)['parkKind'], 'hold');
    assert.equal((parked[0].data as Record<string, unknown>)['reason'], 'stopped by operator');

    const item = fold(events).items.get('WI-001')!;
    assert.equal(item.state, 'parked');
    assert.equal(item.parkKind, 'hold');

    // No worktree was ever created.
    const branches = spawnSync('git', ['branch', '--list', 'wi-001-a1'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString();
    assert.ok(!branches.includes('wi-001-a1'), 'the cheap pre-dispatch path must never create a worktree/branch');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: in-beat cancel poll kills the live build via the provider — target parks hold, no auto-requeue', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cancel-inbeat-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'x', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // A fake provider that calls cancelCheck itself (simulating the real claudeCli poll loop)
    // and resolves as cancelled once cancelCheck reports true — proving dispatch wires
    // cancelCheck through to provider.run and correctly interprets a cancelled result.
    const provider: LlmProvider = {
      name: 'fake-cancel-aware',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        // Simulate the ledger tail gaining a cancel-requested mid-build: append it now, then
        // poll — exactly what claudeCli's real interval poll would observe on its next tick.
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:02:00Z'),
        ]);
        const shouldCancel = req.cancelCheck ? await req.cancelCheck() : false;
        if (shouldCancel) {
          return { ok: false, error: 'cancelled', code: 'cancelled' };
        }
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(),
      branchProbe: () => 'master', authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const cancelled = events.filter(e => e.type === 'build.cancelled' && e.item === 'WI-001');
    assert.equal(cancelled.length, 1, 'the target must get exactly one build.cancelled');
    assert.equal((cancelled[0].data as Record<string, unknown>)['attempt'], 1);

    const item = fold(events).items.get('WI-001')!;
    assert.equal(item.state, 'parked');
    assert.equal(item.parkKind, 'hold', 'a deliberately stopped build parks hold, never auto-requeues');

    // The branch is discarded (not kept for operator review, unlike a spine park).
    const branches = spawnSync('git', ['branch', '--list', 'wi-001-a1'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString();
    assert.ok(!branches.includes('wi-001-a1'), 'a hard-stopped build must not keep its branch around');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: batch cancel — the target parks hold, innocent co-located siblings requeue via build.crashed cancelled-sibling', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cancel-batch-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    // Two co-located items sharing one worktree (batch eligible: sonnet, medium priority, small spec).
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', {
        spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    // The carrier is WI-001 (group[0], the item that named the worktree/branch) — a cancel
    // targets the carrier's attempt (dispatch keys the poll on the carrier, per the contract's
    // batch design: terminal fan-out already routes co-located siblings separately).
    const provider: LlmProvider = {
      name: 'fake-cancel-aware-batch',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (!req.cancelCheck) return { ok: true, text: 'done' }; // scout calls carry no cancelCheck
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:04:00Z'),
        ]);
        const shouldCancel = await req.cancelCheck();
        return shouldCancel
          ? { ok: false, error: 'cancelled', code: 'cancelled' }
          : { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ batchMaxItems: 3 }),
      branchProbe: () => 'master', authProbeResult: { ok: true },
      cancelPollIntervalMs: 10,
    });

    const events = await loadAllEvents(ledgerDir);
    // WI-001 is the carrier (group[0]) — it gets the target's build.cancelled + park hold.
    const cancelledEvents = events.filter(e => e.type === 'build.cancelled');
    assert.equal(cancelledEvents.length, 1, 'exactly one item is the cancel TARGET');
    assert.equal(cancelledEvents[0].item, 'WI-001');

    // WI-002, the innocent co-located sibling, goes down the EXISTING crashed path with the
    // 'cancelled-sibling' reason — never a build.cancelled of its own, never parked hold.
    const siblingCrash = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-002');
    assert.equal(siblingCrash.length, 1);
    assert.equal((siblingCrash[0].data as Record<string, unknown>)['reason'], 'cancelled-sibling');

    const folded = fold(events);
    const target = folded.items.get('WI-001')!;
    const sibling = folded.items.get('WI-002')!;
    assert.equal(target.state, 'parked');
    assert.equal(target.parkKind, 'hold', 'the target parks hold — deliberate, no auto-requeue');
    assert.equal(sibling.state, 'queued', 'the innocent sibling must requeue via the normal crash path, never park hold itself');
    assert.notEqual(sibling.parkKind, 'hold');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: batch cancel — Stop pressed on a NON-carrier sibling (recs[1]) is observed, kills the build, and parks THAT sibling hold (not the carrier)', async () => {
  // Repro for the review defect: the console renders a Stop button on every building item,
  // including co-located siblings. A poll keyed only on the carrier would silently never
  // observe a sibling's cancel-requested — the build runs on with no kill, no event, no
  // feedback. This proves the fix: cancelCheck scans the WHOLE group, and the terminal path
  // attributes build.cancelled to whichever item was ACTUALLY requested.
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cancel-sibling-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', {
        spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake-cancel-sibling',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (!req.cancelCheck) return { ok: true, text: 'done' }; // scout calls carry no cancelCheck
        // The operator presses Stop on WI-002 — the SIBLING, not the carrier WI-001.
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-002', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:04:00Z'),
        ]);
        const shouldCancel = await req.cancelCheck();
        return shouldCancel
          ? { ok: false, error: 'cancelled', code: 'cancelled' }
          : { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ batchMaxItems: 3 }),
      branchProbe: () => 'master', authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);

    // The poll DID observe the sibling's request — the build was actually killed (not a
    // silent no-op): the provider returned code:'cancelled', which only happens when
    // cancelCheck() resolved true.
    const cancelled = events.filter(e => e.type === 'build.cancelled');
    assert.equal(cancelled.length, 1, 'exactly one item is the cancel TARGET');
    assert.equal(cancelled[0].item, 'WI-002', 'the item that was ACTUALLY requested (the sibling) must be the one attributed the cancellation, not the carrier');

    // The carrier WI-001, which never asked to stop, goes down the existing crashed/requeue path.
    const carrierCrash = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-001');
    assert.equal(carrierCrash.length, 1);
    assert.equal((carrierCrash[0].data as Record<string, unknown>)['reason'], 'cancelled-sibling');

    const folded = fold(events);
    const requested = folded.items.get('WI-002')!;
    const carrier = folded.items.get('WI-001')!;
    assert.equal(requested.state, 'parked');
    assert.equal(requested.parkKind, 'hold', 'the ACTUALLY-requested item parks hold, regardless of carrier/sibling role');
    assert.equal(carrier.state, 'queued', 'the carrier, which never asked to stop, requeues normally');
    assert.notEqual(carrier.parkKind, 'hold');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: batch cancel — Stop pressed on BOTH batch members parks BOTH hold, no cancelled-sibling event', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cancel-both-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', {
        spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake-cancel-both',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (!req.cancelCheck) return { ok: true, text: 'done' };
        // BOTH the carrier and the sibling were requested (e.g. two operator taps, or a
        // double-click race on the confirm dialog).
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:04:00Z'),
          makeEvent('cli', 'WI-002', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:04:01Z'),
        ]);
        const shouldCancel = await req.cancelCheck();
        return shouldCancel
          ? { ok: false, error: 'cancelled', code: 'cancelled' }
          : { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ batchMaxItems: 3 }),
      branchProbe: () => 'master', authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);

    // Both items were requested → both get build.cancelled, NEITHER gets cancelled-sibling.
    const cancelled = events.filter(e => e.type === 'build.cancelled');
    assert.equal(cancelled.length, 2, 'both requested items must be attributed a build.cancelled');
    assert.deepEqual(new Set(cancelled.map(e => e.item)), new Set(['WI-001', 'WI-002']));

    const siblingCrash = events.filter(e => e.type === 'build.crashed' && e.data && (e.data as Record<string, unknown>)['reason'] === 'cancelled-sibling');
    assert.equal(siblingCrash.length, 0, 'no item requeues as an innocent sibling when every group member was actually requested');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')!.state, 'parked');
    assert.equal(folded.items.get('WI-001')!.parkKind, 'hold');
    assert.equal(folded.items.get('WI-002')!.state, 'parked');
    assert.equal(folded.items.get('WI-002')!.parkKind, 'hold');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatch: salvage capture fires exactly once per cancelled worktree, not once per batched item', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-cancel-salvage-once-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', {
        spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:03:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake-cancel-salvage',
      async run(): Promise<ProviderResult> {
        return { ok: false, error: 'cancelled', code: 'cancelled' };
      },
    };

    let salvageCallCount = 0;
    const capturedFor: string[] = [];
    const salvageStub: typeof import('../src/salvage.js').captureSalvage = (
      _wtPath, itemId, _attempt, _artifactDir, _reason, _cfg, _logPath,
    ) => {
      salvageCallCount += 1;
      capturedFor.push(itemId);
      return { ok: true, trailMessage: '' };
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ batchMaxItems: 3 }),
      branchProbe: () => 'master', authProbeResult: { ok: true },
      salvageCapture: salvageStub,
    });

    assert.equal(salvageCallCount, 1, 'salvage must capture the shared worktree exactly once, not once per batched item');
    assert.deepEqual(capturedFor, ['WI-001'], 'the single salvage call is attributed to the carrier');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
