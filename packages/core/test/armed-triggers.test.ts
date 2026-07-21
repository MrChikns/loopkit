/**
 * armed-triggers.test.ts — Tests for the self-arming trigger map.
 *
 * Covers:
 *   evaluator (pure) — fires on true, skips on false/undefined (fail-open), respects
 *     enabled:false, dedups vs alreadyFired (once-ever edge), dedups duplicate ids in
 *     one pass, marks escalation, probe-throw → skip.
 *   real probe — shell exit 0 → true, non-zero → false, blank/unknown-kind → undefined.
 *   reactor integration — a true predicate emits item.captured (+ armedId) then
 *     item.queued (build) or item.parked (escalation); a still-true predicate does NOT
 *     re-fire on the next beat; a false predicate emits nothing; empty armed[] is a no-op.
 *   config — armed[] validation (shape + duplicate-id rejection).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  evaluateArmed,
  makeArmedProbe,
  ArmedItem,
  ArmedProbe,
} from '../src/armed.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-armed-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function armed(overrides: Partial<ArmedItem> = {}): ArmedItem {
  return {
    id: 'a1',
    predicate: { kind: 'shell', command: 'true' },
    capture: { text: 'do the thing', touches: 'packages/engine/' },
    ...overrides,
  };
}

/** A minimal repo + ledger; returns a ReactorOptions with an injected armedProbe. */
async function makeEnv(cfg: LoopkitConfig, probe: ArmedProbe): Promise<{
  opts: ReactorOptions;
  ledgerDir: string;
  cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'runs', 'reactor'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  const opts: ReactorOptions = {
    repoRoot,
    ledgerDir,
    autonomy: 'on',
    // No provider → route step is zero-LLM; we only exercise the armed step here.
    provider: null,
    config: cfg,
    armedProbe: probe,
  };
  return { opts, ledgerDir, cleanup: () => cleanDir(base) };
}

function cfgWith(armedItems: ArmedItem[]): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    armed: armedItems,
  };
}

// ---------------------------------------------------------------------------
// Pure evaluator
// ---------------------------------------------------------------------------

test('evaluateArmed: fires on a true predicate', () => {
  const firings = evaluateArmed([armed()], new Set(), () => true);
  assert.equal(firings.length, 1);
  assert.equal(firings[0]!.armedId, 'a1');
  assert.equal(firings[0]!.escalation, false);
});

test('evaluateArmed: false and undefined (fail-open) do NOT fire', () => {
  assert.equal(evaluateArmed([armed()], new Set(), () => false).length, 0);
  assert.equal(evaluateArmed([armed()], new Set(), () => undefined).length, 0);
});

test('evaluateArmed: a throwing probe is treated as skip (fail-open)', () => {
  const firings = evaluateArmed([armed()], new Set(), () => { throw new Error('boom'); });
  assert.equal(firings.length, 0);
});

test('evaluateArmed: enabled:false is skipped', () => {
  assert.equal(evaluateArmed([armed({ enabled: false })], new Set(), () => true).length, 0);
});

test('evaluateArmed: alreadyFired id is not re-fired (once-ever edge)', () => {
  const firings = evaluateArmed([armed()], new Set(['a1']), () => true);
  assert.equal(firings.length, 0);
});

test('evaluateArmed: duplicate ids in one pass fire only once', () => {
  const firings = evaluateArmed(
    [armed({ id: 'dup' }), armed({ id: 'dup' })],
    new Set(),
    () => true,
  );
  assert.equal(firings.length, 1);
});

test('evaluateArmed: blank id is skipped', () => {
  assert.equal(evaluateArmed([armed({ id: '   ' })], new Set(), () => true).length, 0);
});

test('evaluateArmed: priority escalation marks the firing', () => {
  const firings = evaluateArmed(
    [armed({ capture: { text: 'park me', priority: 'escalation' } })],
    new Set(),
    () => true,
  );
  assert.equal(firings.length, 1);
  assert.equal(firings[0]!.escalation, true);
});

// ---------------------------------------------------------------------------
// Real shell probe
// ---------------------------------------------------------------------------

test('makeArmedProbe: exit 0 → true, non-zero → false', () => {
  const probe = makeArmedProbe(tmpdir());
  assert.equal(probe({ kind: 'shell', command: 'exit 0' }), true);
  assert.equal(probe({ kind: 'shell', command: 'exit 3' }), false);
});

test('makeArmedProbe: blank command and unknown kind → undefined (fail-open)', () => {
  const probe = makeArmedProbe(tmpdir());
  assert.equal(probe({ kind: 'shell', command: '   ' }), undefined);
  // @ts-expect-error — deliberately exercise an unknown kind
  assert.equal(probe({ kind: 'sql', command: 'select 1' }), undefined);
});

// ---------------------------------------------------------------------------
// Reactor integration
// ---------------------------------------------------------------------------

test('reactor: a true build predicate captures + queues, then does NOT re-fire', async () => {
  const cfg = cfgWith([armed()]);
  const { opts, ledgerDir, cleanup } = await makeEnv(cfg, () => true);
  try {
    await runReactor(opts);
    let events = await loadAllEvents(ledgerDir);
    const captured = events.filter(e => e.type === 'item.captured');
    const queued = events.filter(e => e.type === 'item.queued');
    assert.equal(captured.length, 1, 'one capture');
    assert.equal(queued.length, 1, 'one queue');
    assert.equal((captured[0]!.data as { armedId?: string }).armedId, 'a1');
    assert.equal((captured[0]!.data as { source?: string }).source, 'armed:a1');
    const rec = [...fold(events).items.values()][0]!;
    assert.equal(rec.state, 'queued');
    assert.equal(rec.touches, 'packages/engine/');

    // Second beat, predicate still true → no new capture (edge already consumed).
    await runReactor(opts);
    events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.captured').length, 1, 'no re-fire');
  } finally {
    cleanup();
  }
});

test('reactor: an escalation predicate parks (decision) instead of building', async () => {
  const cfg = cfgWith([armed({
    id: 'esc',
    capture: { text: 'flip a costly switch', priority: 'escalation' },
  })]);
  const { opts, ledgerDir, cleanup } = await makeEnv(cfg, () => true);
  try {
    await runReactor(opts);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.captured').length, 1);
    assert.equal(events.filter(e => e.type === 'item.queued').length, 0, 'no build');
    const parked = events.filter(e => e.type === 'item.parked');
    assert.equal(parked.length, 1, 'parked');
    assert.equal((parked[0]!.data as { parkKind?: string }).parkKind, 'decision');
    const rec = [...fold(events).items.values()][0]!;
    assert.equal(rec.state, 'parked');
  } finally {
    cleanup();
  }
});

test('reactor: a false predicate fires nothing', async () => {
  const cfg = cfgWith([armed()]);
  const { opts, ledgerDir, cleanup } = await makeEnv(cfg, () => false);
  try {
    await runReactor(opts);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.captured').length, 0);
  } finally {
    cleanup();
  }
});

test('reactor: two armed edges allocate distinct WI ids', async () => {
  const cfg = cfgWith([
    armed({ id: 'x1', capture: { text: 'first' } }),
    armed({ id: 'x2', capture: { text: 'second' } }),
  ]);
  const { opts, ledgerDir, cleanup } = await makeEnv(cfg, () => true);
  try {
    await runReactor(opts);
    const events = await loadAllEvents(ledgerDir);
    const ids = new Set(events.filter(e => e.type === 'item.captured').map(e => e.item));
    assert.equal(ids.size, 2, 'two distinct WI ids');
  } finally {
    cleanup();
  }
});

test('reactor: empty armed[] is a no-op step', async () => {
  const cfg = cfgWith([]);
  const { opts, ledgerDir, cleanup } = await makeEnv(cfg, () => true);
  try {
    const result = await runReactor(opts);
    const armedStep = result.steps.find(s => s.step === 'armed');
    assert.ok(armedStep, 'armed step ran');
    assert.equal(armedStep!.eventsWritten, 0);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.captured').length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('loadConfig: valid armed[] round-trips; absent → []', () => {
  const base = makeTempDir();
  try {
    // Absent key → []
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({}), 'utf8');
    assert.deepEqual(loadConfig(base).armed, []);

    // Valid entry normalises
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({
      armed: [{
        id: 'g1',
        predicate: { kind: 'shell', command: 'test -f READY' },
        capture: { text: 'build it', touches: 'apps/example/', priority: 'high' },
      }],
    }), 'utf8');
    const cfg = loadConfig(base);
    assert.equal(cfg.armed!.length, 1);
    assert.equal(cfg.armed![0]!.id, 'g1');
    assert.equal(cfg.armed![0]!.capture.priority, 'high');
  } finally {
    cleanDir(base);
  }
});

test('loadConfig: rejects malformed armed entries', () => {
  const base = makeTempDir();
  const write = (armedVal: unknown) =>
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ armed: armedVal }), 'utf8');
  try {
    write('nope');
    assert.throws(() => loadConfig(base), /armed must be an array/);

    write([{ id: '', predicate: { kind: 'shell', command: 'x' }, capture: { text: 't' } }]);
    assert.throws(() => loadConfig(base), /id must be a non-empty string/);

    write([{ id: 'a', predicate: { kind: 'sql', command: 'x' }, capture: { text: 't' } }]);
    assert.throws(() => loadConfig(base), /predicate.kind must be 'shell'/);

    write([{ id: 'a', predicate: { kind: 'shell', command: '' }, capture: { text: 't' } }]);
    assert.throws(() => loadConfig(base), /command must be a non-empty string/);

    write([{ id: 'a', predicate: { kind: 'shell', command: 'x' }, capture: {} }]);
    assert.throws(() => loadConfig(base), /capture.text must be a non-empty string/);

    // Duplicate ids
    write([
      { id: 'dup', predicate: { kind: 'shell', command: 'x' }, capture: { text: 't' } },
      { id: 'dup', predicate: { kind: 'shell', command: 'y' }, capture: { text: 'u' } },
    ]);
    assert.throws(() => loadConfig(base), /duplicate/);
  } finally {
    cleanDir(base);
  }
});
