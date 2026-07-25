/**
 * ledger-durability.test.ts — guards against ledger residue loss: a working-tree
 * restore/checkout of dirty `.ai/ledger/*` must never silently discard uncommitted appends,
 * and a truncated/regressed ledger must halt the beat rather than fold over missing history.
 *
 * Covers:
 *   - extractItemIds / commitLedgerResidue (ledgerCommit.ts): scoped commit of ledger residue,
 *     never `git add -A`; no-op when clean or when not inside a git repo.
 *   - checkLedgerRegressionGuard (regressionGuard.ts): halts + notifies (once, deduped) on a
 *     detected truncation; fail-open on a broken probe; watermark persists across calls.
 *   - runReactor / runDispatch wiring: the guard halts the WHOLE beat before any step runs,
 *     and commitResidue is invoked at the end of every non-dry-run beat.
 *   - readLedgerMaxIds (ledger.ts, WI-195): the WATERMARK the guard compares — its running-max
 *     predicate and its segment-filename anchors, both unpinned until the mutation run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { extractItemIds, commitLedgerResidue } from '../src/ledgerCommit.js';
import { checkLedgerRegressionGuard } from '../src/regressionGuard.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, readLedgerMaxIds, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { runDispatch, DispatchOptions } from '../src/beats/dispatch.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-ledger-durability-${process.pid}-${++testCount}-${Date.now()}`);
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

/** A real git repo with `.ai/ledger` INSIDE it, so residue commits are exercisable. */
function initRepoWithLedgerInside(): { repoRoot: string; ledgerDir: string; base: string } {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(repoRoot, '.ai', 'ledger');
  mkdirSync(repoRoot, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  mkdirSync(ledgerDir, { recursive: true });
  return { repoRoot, ledgerDir, base };
}

// ---------------------------------------------------------------------------
// extractItemIds (pure)
// ---------------------------------------------------------------------------

test('extractItemIds: pulls unique WI-NNN ids from added diff lines only', () => {
  const diff = [
    'diff --git a/.ai/ledger/work-2026-07.jsonl b/.ai/ledger/work-2026-07.jsonl',
    '+++ b/.ai/ledger/work-2026-07.jsonl',
    '+{"id":"01J1","item":"WI-100","type":"item.captured"}',
    '+{"id":"01J2","item":"WI-101","type":"item.queued"}',
    '-{"id":"01J0","item":"WI-099","type":"item.captured"}', // removed line — must NOT count
    '+{"id":"01J3","item":"WI-100","type":"item.routed"}', // duplicate — deduped
  ].join('\n');
  assert.deepEqual(extractItemIds(diff), ['WI-100', 'WI-101']);
});

test('extractItemIds: no matches → empty array', () => {
  assert.deepEqual(extractItemIds('+not an event line\n-also not one'), []);
});

// ---------------------------------------------------------------------------
// commitLedgerResidue
// ---------------------------------------------------------------------------

test('commitLedgerResidue: stages and commits ONLY the ledger dir, message lists item ids', () => {
  const { repoRoot, ledgerDir, base } = initRepoWithLedgerInside();
  try {
    // Scratch/residue file elsewhere in the tree — must NEVER be swept in (scoped-commit invariant).
    writeFileSync(join(repoRoot, 'scratch.txt'), 'not ledger', 'utf8');
    writeFileSync(join(ledgerDir, 'work-2026-07.jsonl'),
      '{"id":"01J000000000000000000001","ts":"2026-07-17T00:00:00Z","actor":"test","item":"WI-365","type":"item.captured","data":{}}\n',
      'utf8');

    const result = commitLedgerResidue(repoRoot, ledgerDir, 'reactor');
    assert.equal(result.committed, true);
    assert.match(result.detail, /^chore\(ledger\): reactor residue \(WI-365\)$/);

    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, stdio: 'pipe' });
    const lines = status.stdout.toString().trim().split('\n').filter(Boolean);
    // The ledger file is committed (gone from porcelain); scratch.txt remains untracked.
    assert.ok(lines.every(l => !l.includes('.ai/ledger')), `ledger residue must be committed: ${lines}`);
    assert.ok(lines.some(l => l.includes('scratch.txt')), 'scratch.txt must be left alone (never git add -A)');

    const log = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoRoot, stdio: 'pipe' });
    assert.equal(log.stdout.toString().trim(), 'chore(ledger): reactor residue (WI-365)');
  } finally {
    cleanDir(base);
  }
});

test('commitLedgerResidue: no-ops (committed:false) when the ledger is already clean', () => {
  const { repoRoot, ledgerDir, base } = initRepoWithLedgerInside();
  try {
    const result = commitLedgerResidue(repoRoot, ledgerDir, 'reactor');
    assert.equal(result.committed, false);
    assert.match(result.detail, /no ledger residue/);
  } finally {
    cleanDir(base);
  }
});

test('commitLedgerResidue: second call after a clean commit is also a no-op (no empty commits)', () => {
  const { repoRoot, ledgerDir, base } = initRepoWithLedgerInside();
  try {
    writeFileSync(join(ledgerDir, 'work-2026-07.jsonl'), '{"id":"1"}\n', 'utf8');
    const first = commitLedgerResidue(repoRoot, ledgerDir, 'dispatch');
    assert.equal(first.committed, true);

    const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString().trim();
    const second = commitLedgerResidue(repoRoot, ledgerDir, 'dispatch');
    assert.equal(second.committed, false);
    const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString().trim();
    assert.equal(before, after, 'no second commit should be created');
  } finally {
    cleanDir(base);
  }
});

test('commitLedgerResidue: never throws when repoRoot is not a git repository', () => {
  const base = makeTempDir();
  try {
    const repoRoot = join(base, 'not-a-repo');
    const ledgerDir = join(repoRoot, '.ai', 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'work-2026-07.jsonl'), '{"id":"1"}\n', 'utf8');
    assert.doesNotThrow(() => {
      const result = commitLedgerResidue(repoRoot, ledgerDir, 'reactor');
      assert.equal(result.committed, false);
    });
  } finally {
    cleanDir(base);
  }
});

// ---------------------------------------------------------------------------
// checkLedgerRegressionGuard
// ---------------------------------------------------------------------------

test('checkLedgerRegressionGuard: first observation baselines the watermark, never halts', async () => {
  const base = makeTempDir();
  try {
    const runDir = join(base, 'runs', 'loopkit');
    const result = await checkLedgerRegressionGuard({
      repoRoot: base,
      ledgerDir: join(base, 'ledger'),
      runDir,
      loop: 'reactor',
      readMaxIds: async () => ({ 'work-2026-07.jsonl': '01J000000000000000000010' }),
    });
    assert.equal(result.halted, false);
    const watermarks = JSON.parse(readFileSync(join(runDir, 'doctor-maxids.json'), 'utf8'));
    assert.equal(watermarks['work-2026-07.jsonl'], '01J000000000000000000010');
  } finally {
    cleanDir(base);
  }
});

test('checkLedgerRegressionGuard: a regressed max id halts and notifies exactly once (deduped)', async () => {
  const base = makeTempDir();
  try {
    const runDir = join(base, 'runs', 'loopkit');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'doctor-maxids.json'),
      JSON.stringify({ 'work-2026-07.jsonl': '01J000000000000000000099' }), 'utf8');

    let notifyCalls = 0;
    const guardOpts = {
      repoRoot: base,
      ledgerDir: join(base, 'ledger'),
      runDir,
      loop: 'reactor' as const,
      readMaxIds: async () => ({ 'work-2026-07.jsonl': '01J000000000000000000001' }),
      notify: (_msg: string) => { notifyCalls++; return true; },
    };

    const first = await checkLedgerRegressionGuard(guardOpts);
    assert.equal(first.halted, true);
    assert.match(first.detail, /LEDGER REGRESSION/);
    assert.equal(notifyCalls, 1);

    // Watermark held at the old (higher) value, not silently accepted downward.
    const watermarks = JSON.parse(readFileSync(join(runDir, 'doctor-maxids.json'), 'utf8'));
    assert.equal(watermarks['work-2026-07.jsonl'], '01J000000000000000000099');

    // Second beat, same regression signature — halts again, but does NOT re-notify.
    const second = await checkLedgerRegressionGuard(guardOpts);
    assert.equal(second.halted, true);
    assert.equal(notifyCalls, 1, 'notify must be deduped per regression signature');
  } finally {
    cleanDir(base);
  }
});

test('checkLedgerRegressionGuard: undelivered notify (transport down) is retried next beat', async () => {
  const base = makeTempDir();
  try {
    const runDir = join(base, 'runs', 'loopkit');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'doctor-maxids.json'),
      JSON.stringify({ 'work-2026-07.jsonl': '01J000000000000000000099' }), 'utf8');

    let notifyCalls = 0;
    const guardOpts = {
      repoRoot: base,
      ledgerDir: join(base, 'ledger'),
      runDir,
      loop: 'dispatch' as const,
      readMaxIds: async () => ({ 'work-2026-07.jsonl': '01J000000000000000000001' }),
      notify: (_msg: string) => { notifyCalls++; return false; }, // total transport failure
    };

    await checkLedgerRegressionGuard(guardOpts);
    await checkLedgerRegressionGuard(guardOpts);
    assert.equal(notifyCalls, 2, 'an undelivered notify must retry next beat, not stamp as sent');
  } finally {
    cleanDir(base);
  }
});

test('checkLedgerRegressionGuard: fails open when the max-id probe throws', async () => {
  const base = makeTempDir();
  try {
    const result = await checkLedgerRegressionGuard({
      repoRoot: base,
      ledgerDir: join(base, 'ledger'),
      runDir: join(base, 'runs', 'loopkit'),
      loop: 'reactor',
      readMaxIds: async () => { throw new Error('disk read failure'); },
    });
    assert.equal(result.halted, false);
    assert.match(result.detail, /fail-open/);
  } finally {
    cleanDir(base);
  }
});

// ---------------------------------------------------------------------------
// Beat wiring — runReactor / runDispatch
// ---------------------------------------------------------------------------

test('runReactor: a detected ledger regression halts the ENTIRE beat (zero steps touch the fold)', async () => {
  const base = makeTempDir();
  try {
    const repoRoot = join(base, 'repo');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'runs', 'loopkit', 'doctor-maxids.json'),
      JSON.stringify({ 'work-2026-07.jsonl': '01J000000000000000000099' }), 'utf8');

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'do something' }),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      ledgerMaxIdsProbe: async () => ({ 'work-2026-07.jsonl': '01J000000000000000000001' }),
      commitResidue: () => ({ committed: false, detail: 'not called' }),
    } satisfies ReactorOptions);

    assert.equal(result.totalEventsWritten, 0);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].step, 'ledger-regression-guard');
    assert.equal(result.steps[0].ok, false);
  } finally {
    cleanDir(base);
  }
});

test('runReactor: calls commitResidue exactly once at the end of a normal (non-halted) beat', async () => {
  const base = makeTempDir();
  try {
    const repoRoot = join(base, 'repo');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });

    const calls: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      commitResidue: (_repoRoot, _ledgerDir, label) => { calls.push(label); return { committed: true, detail: 'x' }; },
    } satisfies ReactorOptions);

    assert.deepEqual(calls, ['reactor']);
  } finally {
    cleanDir(base);
  }
});

test('runReactor: dry-run never calls commitResidue or the regression guard', async () => {
  const base = makeTempDir();
  try {
    const repoRoot = join(base, 'repo');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });

    let commitCalls = 0;
    let probeCalls = 0;
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      dryRun: true,
      provider: null,
      config: makeTestConfig(),
      commitResidue: () => { commitCalls++; return { committed: false, detail: 'x' }; },
      ledgerMaxIdsProbe: async () => { probeCalls++; return {}; },
    } satisfies ReactorOptions);

    assert.equal(commitCalls, 0);
    assert.equal(probeCalls, 0);
  } finally {
    cleanDir(base);
  }
});

test('runDispatch: a detected ledger regression halts before any item is picked', async () => {
  const base = makeTempDir();
  try {
    const repoRoot = join(base, 'repo');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'runs', 'loopkit', 'doctor-maxids.json'),
      JSON.stringify({ 'work-2026-07.jsonl': '01J000000000000000000099' }), 'utf8');

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'x' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'x' }),
    ]);

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      ledgerMaxIdsProbe: async () => ({ 'work-2026-07.jsonl': '01J000000000000000000001' }),
      commitResidue: () => ({ committed: false, detail: 'not called' }),
    } satisfies DispatchOptions);

    assert.equal(result.dispatched.length, 0);
    assert.equal(result.totalEventsWritten, 0);
    assert.match(result.detail ?? '', /LEDGER REGRESSION/);
  } finally {
    cleanDir(base);
  }
});

test('runDispatch: calls commitResidue exactly once at the end of a normal (non-halted) beat', async () => {
  const base = makeTempDir();
  try {
    const repoRoot = join(base, 'repo');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });

    const calls: string[] = [];
    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      config: makeTestConfig(),
      commitResidue: (_repoRoot, _ledgerDir, label) => { calls.push(label); return { committed: true, detail: 'x' }; },
    } satisfies DispatchOptions);

    assert.deepEqual(calls, ['dispatch']);
  } finally {
    cleanDir(base);
  }
});

// ---------------------------------------------------------------------------
// readLedgerMaxIds — the truncation watermark itself (WI-195)
//
// The regression guard above is only as good as the watermark it compares. Both halves of
// that watermark were unpinned on the mutation run:
//   - the running max (`ev.id > max`) — all 8 mutants survived, including one computing the
//     MINIMUM, which would make every subsequent append look like a truncation;
//   - the segment-filename regex `/^(work|ops)-\d{4}-\d{2}\.jsonl$/` — both anchors are
//     removable, so backup/renamed neighbours would be folded in as real ledger segments.
// ---------------------------------------------------------------------------

/** A schema-valid event with a caller-chosen id (validateEvent requires the `ev-` prefix). */
function eventWithId(id: string, item: string, ts: string): LedgerEvent {
  return { ...makeEvent('test', item, 'item.queued', { spec: item }, ts), id } as unknown as LedgerEvent;
}

function writeRawSegment(dir: string, name: string, events: LedgerEvent[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

const WM_A = 'ev-00000000000000000000AA';
const WM_B = 'ev-00000000000000000000BB';
const WM_C = 'ev-00000000000000000000CC';

test('readLedgerMaxIds: the watermark is the MAXIMUM id in the segment, whatever order the lines are in', async () => {
  const dir = makeTempDir();
  try {
    // Deliberately out of order in the file — a, c, b — so the maximum is neither the first
    // nor the last line. A union-merged or hand-edited segment really can look like this,
    // which is why the running max must not assume append order. (An earlier draft of this
    // fixture put the max FIRST; the "keep only the first id" mutant survived it, which is the
    // decorative-test failure mode this whole exercise exists to eliminate.)
    writeRawSegment(dir, 'work-2026-07.jsonl', [
      eventWithId(WM_A, 'WI-A', '2026-07-01T00:00:00.000Z'),
      eventWithId(WM_C, 'WI-C', '2026-07-03T00:00:00.000Z'),
      eventWithId(WM_B, 'WI-B', '2026-07-02T00:00:00.000Z'),
    ]);
    const maxIds = await readLedgerMaxIds(dir);
    // kills: `ev.id > max` → `<` (yields the MINIMUM, WM_A — every later fold then reads as a
    //        truncation and halts the beat); dropping the `|| ev.id > max` update entirely
    //        (first line wins → WM_A); and the assignment-deleted mutants.
    assert.equal(maxIds['work-2026-07.jsonl'], WM_C,
      'the watermark must be the highest id present, not the first or last line');
  } finally {
    cleanDir(dir);
  }
});

test('readLedgerMaxIds: only exactly-named segments count — a .bak or prefixed neighbour is not a segment', async () => {
  const dir = makeTempDir();
  try {
    writeRawSegment(dir, 'work-2026-07.jsonl', [eventWithId(WM_A, 'WI-A', '2026-07-01T00:00:00.000Z')]);
    // Same content, names that only match if an anchor is dropped from the segment regex.
    writeRawSegment(dir, 'work-2026-07.jsonl.bak', [eventWithId(WM_C, 'WI-BAK', '2026-07-01T00:00:00.000Z')]);
    writeRawSegment(dir, 'xwork-2026-07.jsonl', [eventWithId(WM_B, 'WI-X', '2026-07-01T00:00:00.000Z')]);

    const maxIds = await readLedgerMaxIds(dir);
    // kills: dropping `$` (picks up `work-2026-07.jsonl.bak`) and dropping `^` (picks up
    //        `xwork-2026-07.jsonl`) from /^(work|ops)-\d{4}-\d{2}\.jsonl$/.
    assert.deepEqual(Object.keys(maxIds), ['work-2026-07.jsonl'],
      'a backup copy or a prefixed lookalike must never be enumerated as a ledger segment');

    // Same boundary through the read path: the non-segment files' events must not be folded.
    const items = (await loadAllEvents(dir)).map(e => e.item);
    assert.deepEqual(items, ['WI-A'], 'events in non-segment files must not reach the fold');
  } finally {
    cleanDir(dir);
  }
});
