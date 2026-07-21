/**
 * scout-context.test.ts — Tests for scout context packs.
 *
 * Covers:
 *   schema   — item.briefed accepted; brief required string
 *   fold     — item.briefed stores brief without state change (queued + merged)
 *   dispatch — scout invoked, brief injected in prompt; memoization; failure; disabled
 *   config   — scout block accepted / defaults applied / bad types rejected
 *   parseBrief — BRIEF: marker extraction; full-text fallback; truncation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, validateEvent, isKnownType, LedgerEvent } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { loadAllEvents, appendEvents } from '../src/ledger.js';
import { runDispatch, DispatchOptions, parseBrief } from '../src/beats/dispatch.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi218-${process.pid}-${++testCount}-${Date.now()}`);
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

/** A minimal fake provider (always succeeds). */
function makeFakeProvider(text = 'fake-reply', name = 'fake'): LlmProvider {
  return {
    name,
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

/** Seeded dispatch setup with a real git repo in a temp dir. */
async function makeDispatchEnv(ledgerEvents: LedgerEvent[]): Promise<{
  repoRoot: string;
  ledgerDir: string;
  cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });

  // Minimal git repo
  const { spawnSync } = await import('node:child_process');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  await appendEvents(ledgerDir, ledgerEvents);

  return {
    repoRoot,
    ledgerDir,
    cleanup: () => cleanDir(base),
  };
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

test('schema: item.briefed accepted by validateEvent', () => {
  const ev = makeEvent('dispatch', 'WI-001', 'item.briefed', {
    brief: 'BRIEF:\nFiles: src/foo.ts — must change\nConventions: use fold pattern',
    model: 'haiku',
  });
  // validateEvent should not throw
  const validated = validateEvent(ev);
  assert.equal(validated.type, 'item.briefed');
  assert.equal((validated.data as { brief: string }).brief, ev.data.brief);
});

test('schema: item.briefed is a known event type (isKnownType)', () => {
  assert.equal(isKnownType('item.briefed'), true);
});

// ---------------------------------------------------------------------------
// Fold tests
// ---------------------------------------------------------------------------

test('fold: item.briefed stores brief on a queued item, state unchanged', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'build X', touches: 'src/' }),
    makeEvent('dispatch', 'WI-001', 'item.briefed', {
      brief: 'BRIEF:\nFiles: src/app.ts — entry',
      model: 'haiku',
    }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-001');
  assert.ok(item, 'item must exist');
  assert.equal(item.state, 'queued', 'state must remain queued');
  assert.ok(item.brief, 'brief must be stored');
  assert.equal(item.brief.text, 'BRIEF:\nFiles: src/app.ts — entry');
});

test('fold: item.briefed on merged item stores brief, state stays merged', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-002', 'item.captured', { source: 'cli', text: 'fix Y' }),
    makeEvent('conductor', 'WI-002', 'item.queued', { spec: 'fix Y' }),
    makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 1, pid: 1 }),
    makeEvent('dispatch', 'WI-002', 'item.merged', { commit: 'abc', deployed: false }),
    // brief arrives AFTER merge — must store without regressing state
    makeEvent('dispatch', 'WI-002', 'item.briefed', {
      brief: 'BRIEF:\nFiles: src/fix.ts',
      model: 'haiku',
    }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-002');
  assert.ok(item, 'item must exist');
  assert.equal(item.state, 'merged', 'state must stay merged');
  assert.ok(item.brief, 'brief must be stored even on merged item');
  assert.equal(item.brief.text, 'BRIEF:\nFiles: src/fix.ts');
});

test('fold: later item.briefed overwrites earlier brief (latest wins)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-003', 'item.captured', { source: 'cli', text: 'fix Z' }),
    makeEvent('conductor', 'WI-003', 'item.queued', { spec: 'fix Z' }),
    makeEvent('dispatch', 'WI-003', 'item.briefed', { brief: 'first brief', model: 'haiku' }),
    makeEvent('dispatch', 'WI-003', 'item.briefed', { brief: 'second brief', model: 'haiku' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-003');
  assert.equal(item?.brief?.text, 'second brief', 'latest item.briefed must win');
});

// ---------------------------------------------------------------------------
// parseBrief tests
// ---------------------------------------------------------------------------

test('parseBrief: extracts text after BRIEF: marker', () => {
  const input = 'Some preamble\nBRIEF:\nFiles: foo.ts — change\nConventions: use fold';
  const result = parseBrief(input);
  assert.ok(result.startsWith('BRIEF:'), `expected to start with BRIEF: (got: ${result.slice(0, 30)})`);
  assert.ok(result.includes('foo.ts'), 'must include brief content');
});

test('parseBrief: falls back to full text when no BRIEF: marker', () => {
  const input = 'No marker here\nJust some context about files';
  const result = parseBrief(input);
  assert.equal(result, input.trim());
});

test('parseBrief: hard-truncates to 4000 chars', () => {
  const longText = 'BRIEF:\n' + 'x'.repeat(5000);
  const result = parseBrief(longText);
  assert.equal(result.length, 4000);
});

test('parseBrief: empty text returns empty string', () => {
  assert.equal(parseBrief(''), '');
  assert.equal(parseBrief('  '), '');
});

// ---------------------------------------------------------------------------
// Dispatch tests — scout stage
// ---------------------------------------------------------------------------

test('dispatch: scout invoked for a briefless item; item.briefed + cost.usage{loop:scout} appended', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', {
      spec: 'add feature to src/app.ts',
      touches: 'src/',
    }),
  ]);

  try {
    let scoutCalled = false;

    // Provider: the scout call returns a brief; the build call produces a commit.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        // Distinguish scout (read-only tools) from build (full tools)
        const isScout = (req.tools ?? []).every(t => ['Read', 'Grep', 'Glob'].includes(t));
        if (isScout) {
          scoutCalled = true;
          return {
            ok: true,
            text: 'BRIEF:\nFiles: src/app.ts — must change\nConventions: follow slice pattern',
            usage: { in: 100, out: 50, usd: 0.001 },
          };
        }
        // Build: produce a commit
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'app.ts'), '// built', 'utf8');
        spawnSync('git', ['add', 'src/app.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): add feature'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 200, out: 100, usd: 0.002 } };
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
      touchesDiffFiles: ['src/app.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: true,
    });

    assert.ok(scoutCalled, 'scout provider.run must be called for a briefless item');

    const events = await loadAllEvents(ledgerDir);

    // item.briefed must be in the ledger
    const briefed = events.filter(e => e.type === 'item.briefed' && e.item === 'WI-001');
    assert.equal(briefed.length, 1, 'must emit exactly one item.briefed');
    const briefData = briefed[0].data as { brief: string; model?: string };
    assert.ok(briefData.brief.startsWith('BRIEF:'), 'brief must be stored');
    assert.equal(briefData.model, 'haiku', 'scout model must be recorded');

    // cost.usage with loop:'scout' must be emitted
    const scoutCost = events.filter(e =>
      e.type === 'cost.usage' &&
      e.item === 'WI-001' &&
      (e.data as { loop: string }).loop === 'scout'
    );
    assert.equal(scoutCost.length, 1, 'must emit one cost.usage{loop:scout}');
    const costData = scoutCost[0].data as { loop: string; wi: string; tokens: number };
    assert.equal(costData.loop, 'scout');
    assert.equal(costData.wi, 'WI-001');
    assert.ok(costData.tokens > 0, 'tokens must be recorded');
  } finally {
    cleanup();
  }
});

test('dispatch: build prompt contains CONTEXT PACK section when brief exists', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'build something' }),
    makeEvent('conductor', 'WI-010', 'item.queued', { spec: 'build something', touches: 'src/' }),
  ]);

  try {
    let capturedPrompt: string | undefined;

    const scoutResults = new Map<string, { ok: boolean; text: string; usage: { in: number; out: number; usd: number } }>();
    scoutResults.set('WI-010', {
      ok: true,
      text: 'BRIEF:\nFiles: src/thing.ts — must change',
      usage: { in: 10, out: 5, usd: 0.0001 },
    });

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        // Only capture the build prompt (not the scout call — we inject scoutResults)
        capturedPrompt = req.prompt;
        // Produce a commit
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'thing.ts'), '// built', 'utf8');
        spawnSync('git', ['add', 'src/thing.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-010): build'], { cwd: req.cwd, stdio: 'pipe' });
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
      touchesDiffFiles: ['src/thing.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: true,
      scoutResults: scoutResults as Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } }>,
      judgeEnabled: false,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(
      capturedPrompt.includes('CONTEXT PACK'),
      `build prompt must contain CONTEXT PACK section (got: ${capturedPrompt.slice(0, 200)})`,
    );
    assert.ok(
      capturedPrompt.includes('src/thing.ts'),
      'build prompt must include the brief content',
    );
  } finally {
    cleanup();
  }
});

test('dispatch: item with existing rec.brief skips scout call', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-020', 'item.captured', { source: 'cli', text: 'fix bug' }),
    makeEvent('conductor', 'WI-020', 'item.queued', { spec: 'fix bug', touches: 'src/' }),
    // Pre-existing brief from a previous beat
    makeEvent('dispatch', 'WI-020', 'item.briefed', {
      brief: 'BRIEF:\nFiles: src/bug.ts — pre-existing brief',
      model: 'haiku',
    }),
  ]);

  try {
    let scoutCallCount = 0;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const isScout = (req.tools ?? []).every(t => ['Read', 'Grep', 'Glob'].includes(t));
        if (isScout) {
          scoutCallCount++;
        }
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'bug.ts'), '// fixed', 'utf8');
        spawnSync('git', ['add', 'src/bug.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'fix(WI-020): bug'], { cwd: req.cwd, stdio: 'pipe' });
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
      touchesDiffFiles: ['src/bug.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: true,
      judgeEnabled: false,
    });

    assert.equal(scoutCallCount, 0, 'scout must NOT be called when a brief already exists');
  } finally {
    cleanup();
  }
});

test('dispatch: scout failure proceeds with build cold, no park, build.dispatched emitted', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-030', 'item.captured', { source: 'cli', text: 'add widget' }),
    makeEvent('conductor', 'WI-030', 'item.queued', { spec: 'add widget', touches: 'src/' }),
  ]);

  try {
    // Scout result: failure
    const scoutResults = new Map<string, { ok: boolean; error: string; code: string }>();
    scoutResults.set('WI-030', { ok: false, error: 'timeout', code: 'timeout' });

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        // Build produces a commit
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'widget.ts'), '// widget', 'utf8');
        spawnSync('git', ['add', 'src/widget.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-030): widget'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
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
      touchesDiffFiles: ['src/widget.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: true,
      scoutResults: scoutResults as Map<string, { ok: boolean; text?: string; error?: string; code?: string; usage?: { in: number; out: number; usd?: number } }>,
    });

    const events = await loadAllEvents(ledgerDir);

    // No item.parked from the scout failure
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-030');
    assert.equal(parked.length, 0, 'scout failure must NOT park the item');

    // No item.briefed (scout failed)
    const briefed = events.filter(e => e.type === 'item.briefed' && e.item === 'WI-030');
    assert.equal(briefed.length, 0, 'scout failure must not emit item.briefed');

    // build.dispatched must still be emitted (build went ahead cold)
    const dispatched = events.filter(e => e.type === 'build.dispatched' && e.item === 'WI-030');
    assert.equal(dispatched.length, 1, 'build.dispatched must be emitted even after scout failure');

    // item.merged: build should have succeeded
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-030');
    assert.equal(merged.length, 1, 'item must merge successfully after cold build (scout failure is not a blocker)');
  } finally {
    cleanup();
  }
});

test('dispatch: scout disabled via config → no scout call, build proceeds normally', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-040', 'item.captured', { source: 'cli', text: 'task' }),
    makeEvent('conductor', 'WI-040', 'item.queued', { spec: 'task', touches: 'src/' }),
  ]);

  try {
    let scoutCalled = false;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const isScout = (req.tools ?? []).every(t => ['Read', 'Grep', 'Glob'].includes(t));
        if (isScout) { scoutCalled = true; }
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'task.ts'), '// task', 'utf8');
        spawnSync('git', ['add', 'src/task.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-040): task'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ scout: { enabled: false } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/task.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.equal(scoutCalled, false, 'scout must not run when disabled');

    const events = await loadAllEvents(ledgerDir);
    const briefed = events.filter(e => e.type === 'item.briefed' && e.item === 'WI-040');
    assert.equal(briefed.length, 0, 'no item.briefed when scout is disabled');

    const dispatched = events.filter(e => e.type === 'build.dispatched' && e.item === 'WI-040');
    assert.equal(dispatched.length, 1, 'build.dispatched must still be emitted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

test('config: scout block accepted and defaults applied when absent', () => {
  const repoRoot = makeTempDir();
  try {
    const cfg = loadConfig(repoRoot);   // no loopkit.config.json → all defaults
    assert.equal(cfg.scout?.enabled, true, 'default scout.enabled must be true');
    assert.equal(cfg.scout?.model, 'haiku', 'default scout.model must be haiku');
    assert.equal(cfg.scout?.timeoutMs, 300_000, 'default scout.timeoutMs must be 300000');
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: scout block values from config file override defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ scout: { enabled: false, model: 'sonnet', timeoutMs: 60_000 } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.scout?.enabled, false);
    assert.equal(cfg.scout?.model, 'sonnet');
    assert.equal(cfg.scout?.timeoutMs, 60_000);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: scout.enabled bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ scout: { enabled: 'yes' } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /scout\.enabled must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: scout.model bad type (empty string) throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ scout: { model: '' } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /scout\.model must be a non-empty string/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: scout.timeoutMs bad type (negative) throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ scout: { timeoutMs: -1 } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /scout\.timeoutMs must be a positive finite number/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: scout.timeoutMs zero throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ scout: { timeoutMs: 0 } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /scout\.timeoutMs must be a positive finite number/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: partial scout block merges with defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ scout: { model: 'opus' } }),   // only override model
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.scout?.enabled, true, 'default enabled must still apply');
    assert.equal(cfg.scout?.model, 'opus', 'overridden model must be respected');
    assert.equal(cfg.scout?.timeoutMs, 300_000, 'default timeoutMs must still apply');
  } finally {
    cleanDir(repoRoot);
  }
});
