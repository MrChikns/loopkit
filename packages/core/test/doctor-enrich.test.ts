/**
 * doctor-enrich.test.ts — deterministic capture-time diagnosis enrichment.
 *
 * Covers:
 *   getGitLogSinceLastMerge — merge-bounded lookback, fixed-lookback fallback, never-throws
 *   getLedgerContext — windowed cross-item context, stripped fields, bounded size, no-anchor case
 *   enrichCrashOrStallEvent — attaches on build.crashed/build.stalled only, passthrough otherwise
 *   integration — doctor orphan path via runReactor writes an enriched build.crashed event
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { getGitLogSinceLastMerge, getLedgerContext, enrichCrashOrStallEvent } from '../src/doctor-enrich.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-doctor-enrich-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function tempRepo(): { dir: string; g: (args: string[]) => void } {
  const dir = makeTempDir();
  const g = (args: string[]) => { spawnSync('git', args, { cwd: dir, stdio: 'pipe' }); };
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  return { dir, g };
}

function commitFile(g: (a: string[]) => void, dir: string, file: string, content: string, msg: string): void {
  writeFileSync(join(dir, file), content, 'utf8');
  g(['add', file]);
  g(['commit', '-m', msg]);
}

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    salvage: { enabled: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getGitLogSinceLastMerge
// ---------------------------------------------------------------------------

test('getGitLogSinceLastMerge: fixed lookback when master has no merge commit yet', () => {
  const { dir, g } = tempRepo();
  try {
    commitFile(g, dir, 'a.txt', 'a', 'feat: a');
    commitFile(g, dir, 'b.txt', 'b', 'feat: b');
    const log = getGitLogSinceLastMerge(dir);
    assert.equal(log.length, 3, 'init + 2 commits, no merges to bound the range');
    assert.ok(log[0]!.includes('feat: b'), 'newest commit first');
  } finally {
    cleanDir(dir);
  }
});

test('getGitLogSinceLastMerge: bounded by the last merge commit on master', () => {
  const { dir, g } = tempRepo();
  try {
    g(['checkout', '-b', 'feature']);
    commitFile(g, dir, 'feature.txt', 'x', 'feat: pre-merge commit');
    g(['checkout', 'master']);
    g(['merge', '--no-ff', 'feature', '-m', 'Merge feature']);
    commitFile(g, dir, 'post.txt', 'y', 'feat: post-merge commit');

    const log = getGitLogSinceLastMerge(dir);
    assert.equal(log.length, 1, 'only the commit after the last merge is in range');
    assert.ok(log[0]!.includes('feat: post-merge commit'));
  } finally {
    cleanDir(dir);
  }
});

test('getGitLogSinceLastMerge: caps at maxLines', () => {
  const { dir, g } = tempRepo();
  try {
    for (let i = 0; i < 10; i++) commitFile(g, dir, `f${i}.txt`, `${i}`, `feat: commit ${i}`);
    const log = getGitLogSinceLastMerge(dir, 3);
    assert.equal(log.length, 3);
  } finally {
    cleanDir(dir);
  }
});

test('getGitLogSinceLastMerge: never throws — bad repo root returns []', () => {
  const log = getGitLogSinceLastMerge('/nonexistent/path/xyz-doctor-enrich');
  assert.deepEqual(log, []);
});

test('getGitLogSinceLastMerge: maxLines <= 0 returns []', () => {
  const { dir } = tempRepo();
  try {
    assert.deepEqual(getGitLogSinceLastMerge(dir, 0), []);
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// getLedgerContext
// ---------------------------------------------------------------------------

test('getLedgerContext: returns nearby cross-item events within the window, stripped to ts/type/item', () => {
  const events: LedgerEvent[] = [
    makeEvent('a', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00.000Z'),
    makeEvent('a', 'WI-002', 'item.captured', { source: 'cli', text: 'y' }, '2026-01-01T00:05:00.000Z'),
    makeEvent('a', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:06:00.000Z'),
    makeEvent('a', 'WI-002', 'gate.passed', {}, '2026-01-01T00:06:30.000Z'),
    makeEvent('a', 'WI-999', 'item.captured', { source: 'cli', text: 'far' }, '2026-01-02T00:00:00.000Z'),
  ];
  const ctx = getLedgerContext(events, 'WI-001', 15);
  assert.ok(ctx.length >= 3, `expected at least the 3 near-anchor events, got ${ctx.length}`);
  assert.ok(ctx.every(e => Object.keys(e).sort().join(',') === 'item,ts,type'), 'stripped to ts/type/item only');
  assert.ok(!ctx.some(e => e.item === 'WI-999'), 'far-away event must be outside the window');
  const anchor = ctx.find(e => e.type === 'build.dispatched' && e.item === 'WI-001');
  assert.ok(anchor, 'the item\'s own anchor event must be present');
});

test('getLedgerContext: bounds total entries regardless of how busy the window is', () => {
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 30; i++) {
    events.push(makeEvent('a', `WI-${100 + i}`, 'item.captured', { source: 'cli', text: 'x' }, `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`));
  }
  events.push(makeEvent('a', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:15:00.000Z'));
  const ctx = getLedgerContext(events, 'WI-001', 60);
  assert.ok(ctx.length <= 11, `must be bounded (~10), got ${ctx.length}`);
});

test('getLedgerContext: empty when the item has no events at all', () => {
  const events: LedgerEvent[] = [
    makeEvent('a', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }),
  ];
  assert.deepEqual(getLedgerContext(events, 'WI-404'), []);
});

test('getLedgerContext: empty for an empty ledger', () => {
  assert.deepEqual(getLedgerContext([], 'WI-001'), []);
});

// ---------------------------------------------------------------------------
// enrichCrashOrStallEvent
// ---------------------------------------------------------------------------

test('enrichCrashOrStallEvent: attaches gitLogSince + surroundingEvents to build.crashed', () => {
  const { dir, g } = tempRepo();
  try {
    commitFile(g, dir, 'a.txt', 'a', 'feat: a');
    const allEvents: LedgerEvent[] = [
      makeEvent('a', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00.000Z'),
      makeEvent('reactor', 'WI-001', 'build.crashed', { reason: 'orphan-detected' }, '2026-01-01T00:01:00.000Z'),
    ];
    const crashed = allEvents[1]!;
    const enriched = enrichCrashOrStallEvent(crashed, dir, allEvents);
    const data = enriched.data as Record<string, unknown>;
    assert.ok(Array.isArray(data['gitLogSince']) && (data['gitLogSince'] as string[]).length > 0);
    assert.ok(Array.isArray(data['surroundingEvents']) && (data['surroundingEvents'] as unknown[]).length > 0);
    assert.equal(data['reason'], 'orphan-detected', 'existing fields must be preserved');
  } finally {
    cleanDir(dir);
  }
});

test('enrichCrashOrStallEvent: passthrough for non-crash/stall event types', () => {
  const ev = makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'x' });
  const enriched = enrichCrashOrStallEvent(ev, '/nonexistent', [ev]);
  assert.equal(enriched, ev, 'must return the identical event object unmodified');
});

// ---------------------------------------------------------------------------
// Integration: doctor orphan path via runReactor
// ---------------------------------------------------------------------------

test('doctor orphan path (via runReactor): build.crashed carries gitLogSince + surroundingEvents', async () => {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const runDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });

  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  mkdirSync(repoRoot, { recursive: true });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  writeFileSync(join(repoRoot, 'later.txt'), 'later', 'utf8');
  g(['add', 'later.txt']);
  g(['commit', '-m', 'feat: a change that happened before the crash']);

  try {
    const deadPid = 99999997;
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-300', 'item.captured', { source: 'cli', text: 'orphan enrich test' }),
      makeEvent('conductor', 'WI-300', 'item.queued', { spec: 'build it', touches: 'src/' }),
      makeEvent('dispatch', 'WI-300', 'build.dispatched', { attempt: 1, pid: deadPid }),
    ]);

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      dryRun: false,
      pidProbe: (pid: number) => pid !== deadPid,
      provider: null as unknown as import('../src/providers/types.js').LlmProvider,
      config: makeTestConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-300');
    assert.ok(crashed.length >= 1, 'build.crashed must be emitted for the orphan');
    const data = crashed[0]!.data as Record<string, unknown>;
    assert.ok(Array.isArray(data['gitLogSince']) && (data['gitLogSince'] as string[]).length > 0,
      'gitLogSince must be attached');
    assert.ok((data['gitLogSince'] as string[]).some(l => l.includes('a change that happened before the crash')));
    assert.ok(Array.isArray(data['surroundingEvents']) && (data['surroundingEvents'] as unknown[]).length > 0,
      'surroundingEvents must be attached');
  } finally {
    cleanDir(base);
  }
});

test('doctor orphan path: no crash → no orphan build.crashed event to enrich (sanity, no beat error)', async () => {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  try {
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      dryRun: false,
      pidProbe: () => true,
      provider: null as unknown as import('../src/providers/types.js').LlmProvider,
      config: makeTestConfig(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'build.crashed').length, 0);
  } finally {
    cleanDir(base);
  }
});
