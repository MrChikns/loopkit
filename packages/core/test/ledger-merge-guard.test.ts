/**
 * ledger-merge-guard.test.ts — root-cause fix for the ledger-merge regression class where a
 * reactor approve-merge discarded minutes of live in-flight reactor ops appends that were
 * never part of the commit the merge operated on (masterSha is a git ref, it can never see
 * repoRoot's uncommitted working-tree tail).
 *
 * Covers:
 *   - diffMissingEvents (ledger.ts): pure id-set diff, the comparison primitive.
 *   - loadAllEvents id-dedupe (ledger.ts): a repeated id (e.g. a heal re-appending an event
 *     that a later beat also recovers) folds to one event, not two.
 *   - `.gitattributes` declares `merge=union` for `.ai/ledger/*.jsonl` (defense in depth for
 *     any committed-vs-committed divergence a merge needs to reconcile).
 *   - runReactor end-to-end (real git worktree + real merge + real bare origin): live
 *     uncommitted ledger events that predate the merge — and are absent from both masterSha
 *     and the approved branch — survive the beat (re-appended, then swept into the residue
 *     commit), instead of silently vanishing once repoRoot's master ref catches up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { diffMissingEvents, loadAllEvents, appendEvents } from '../src/ledger.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-merge-guard-${process.pid}-${++testCount}-${Date.now()}`);
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
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// diffMissingEvents (pure)
// ---------------------------------------------------------------------------

test('diffMissingEvents: returns before-only events, in original order', () => {
  const e1 = makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'a' }, '2026-01-01T00:00:00Z');
  const e2 = makeEvent('reactor', 'WI-2', 'item.captured', { source: 'test', text: 'b' }, '2026-01-01T00:00:01Z');
  const e3 = makeEvent('reactor', 'WI-3', 'item.captured', { source: 'test', text: 'c' }, '2026-01-01T00:00:02Z');
  assert.deepEqual(diffMissingEvents([e1, e2, e3], [e1, e3]), [e2]);
});

test('diffMissingEvents: identical sets → empty', () => {
  const e1 = makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'a' }, '2026-01-01T00:00:00Z');
  assert.deepEqual(diffMissingEvents([e1], [e1]), []);
});

test('diffMissingEvents: empty before → empty', () => {
  const e1 = makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'a' }, '2026-01-01T00:00:00Z');
  assert.deepEqual(diffMissingEvents([], [e1]), []);
});

// ---------------------------------------------------------------------------
// loadAllEvents id-dedupe
// ---------------------------------------------------------------------------

test('loadAllEvents: a repeated id (e.g. a re-appended heal) folds to one event', async () => {
  const dir = makeTempDir();
  try {
    const ev = makeEvent('reactor', 'WI-1', 'item.captured', { source: 'test', text: 'a' }, '2026-01-01T00:00:00Z');
    await appendEvents(dir, [ev]);
    // Simulate the same event id landing twice (a union-merge echo, or a heal running twice
    // across beats before the first re-append is committed).
    await appendEvents(dir, [ev]);

    const events = await loadAllEvents(dir);
    assert.equal(events.length, 1, 'duplicate id must fold to a single event');
    assert.equal(events[0].id, ev.id);
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// .gitattributes declares the union driver
// ---------------------------------------------------------------------------

test('.gitattributes: .ai/ledger/*.jsonl carries merge=union', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..', '..');
  const content = readFileSync(join(repoRoot, '.gitattributes'), 'utf8');
  assert.match(content, /\.ai\/ledger\/\*\.jsonl\s+merge=union/);
});

// ---------------------------------------------------------------------------
// runReactor end-to-end: live pre-merge residue survives a real approve-merge
// ---------------------------------------------------------------------------

test('ledger-merge guard: live ledger events present before the merge, but absent from masterSha and the ' +
  'approved branch, survive the beat instead of being silently dropped', async () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(repoRoot, '.ai', 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);

    // Real .gitattributes union driver, exactly as shipped at the repo root.
    writeFileSync(join(repoRoot, '.gitattributes'), '.ai/ledger/*.jsonl merge=union\n', 'utf8');
    mkdirSync(ledgerDir, { recursive: true });
    const baseEvent = makeEvent('test', 'WI-000', 'item.captured', { source: 'test', text: 'base' }, '2026-07-01T00:00:00Z');
    writeFileSync(join(ledgerDir, 'work-2026-07.jsonl'), JSON.stringify(baseEvent) + '\n', 'utf8');
    g(['add', '.gitattributes', '.ai/ledger']);
    g(['commit', '-m', 'init']);

    // A real bare origin so the reactor's real push + fetch resolve.
    const originDir = join(tmpDir, 'origin.git');
    spawnSync('git', ['init', '--bare', '-b', 'master', originDir], { stdio: 'pipe' });
    g(['remote', 'add', 'origin', originDir]);
    g(['push', '-u', 'origin', 'master']);

    // The approved branch — a trivial, unrelated source change. It forks from the SAME base
    // as masterSha will be, and never touches .ai/ledger.
    g(['checkout', '-b', 'wi-100']);
    writeFileSync(join(repoRoot, 'src.txt'), 'wi-100 change', 'utf8');
    g(['add', 'src.txt']);
    g(['commit', '-m', 'feat(WI-100): trivial change']);
    g(['checkout', 'master']);

    // Live, UNCOMMITTED ledger state — the reactor's own approval-flow bookkeeping for
    // WI-100, plus a distinct "in-flight ops append" event (the incident class this guard
    // exists for). None of this is part of any commit masterSha can resolve to.
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-100', 'item.captured', { source: 'cli', text: 'do x' }, '2026-07-01T00:01:00Z'),
      makeEvent('conductor', 'WI-100', 'item.queued', { spec: 'do x' }, '2026-07-01T00:01:01Z'),
      makeEvent('dispatch', 'WI-100', 'build.dispatched', {
        attempt: 1, pid: 1, branch: 'wi-100',
      }, '2026-07-01T00:01:02Z'),
      makeEvent('dispatch', 'WI-100', 'build.finished', { commit: 'abc' }, '2026-07-01T00:01:03Z'),
      makeEvent('operator', 'WI-100', 'item.approved', { by: 'operator' }, '2026-07-01T00:01:04Z'),
    ]);
    const residueEvent = makeEvent('reactor', 'WI-999', 'cost.usage', {
      provider: 'anthropic', loop: 'route', tokens: 42,
    }, '2026-07-01T00:01:05Z');
    await appendEvents(ledgerDir, [residueEvent]);

    // Precondition: repoRoot really is dirty relative to its own HEAD (nothing above was
    // committed) — this is what makes the live residue invisible to masterSha.
    const dirtyBefore = g(['status', '--porcelain', '--', '.ai/ledger']).stdout.toString().trim();
    assert.ok(dirtyBefore.length > 0, 'ledger dir must be dirty (uncommitted) before the beat runs');

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
    } satisfies ReactorOptions);

    const verbsStep = result.steps.find(s => s.step === 'apply-verbs');
    assert.ok(verbsStep?.ok, `apply-verbs must succeed: ${verbsStep?.detail}`);

    // WI-100 must have actually merged (proves this is a REAL merge, not a stub).
    const eventsAfter = await loadAllEvents(ledgerDir);
    const folded = fold(eventsAfter);
    assert.equal(folded.items.get('WI-100')?.state, 'merged', 'WI-100 reached merged state');

    // The decisive assertion: the residue event — live before the merge, and never part of
    // any commit the merge could see — is still present in repoRoot's ledger after the beat.
    assert.ok(
      eventsAfter.some(e => e.id === residueEvent.id),
      'live pre-merge residue event must survive the approve-merge beat',
    );

    // And it must have made it into a real git commit by the end of the beat (the reactor's
    // own commitLedgerResidue sweep in `finally`), not just sit uncommitted by luck.
    const committedContent = spawnSync(
      'git', ['show', 'HEAD:.ai/ledger/ops-2026-07.jsonl'],
      { cwd: repoRoot, stdio: 'pipe' },
    ).stdout.toString();
    assert.ok(
      committedContent.includes(residueEvent.id),
      'residue event must be durably committed on repoRoot, not left uncommitted residue only',
    );
  } finally {
    cleanDir(tmpDir);
  }
});
