/**
 * playbook.test.ts — Tests for the playbook feedback loop.
 *
 * Covers:
 *   buildPrompt   — REPO PLAYBOOK section injected before CONTEXT PACK when playbookContent given
 *   buildPrompt   — no REPO PLAYBOOK section when playbookContent absent
 *   buildBatchPrompt — REPO PLAYBOOK section injected when playbookContent given
 *   config        — playbook block defaults applied; bad types rejected
 *   dispatch      — build prompt includes REPO PLAYBOOK when playbook file exists on disk
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildPrompt, buildBatchPrompt, runDispatch, DispatchOptions } from '../src/beats/dispatch.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents } from '../src/ledger.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-playbook-${process.pid}-${++testCount}-${Date.now()}`);
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
// buildPrompt tests
// ---------------------------------------------------------------------------

test('buildPrompt: REPO PLAYBOOK section appears before CONTEXT PACK when playbookContent given', () => {
  const prompt = buildPrompt(
    'add feature',
    undefined,
    undefined,
    'BRIEF:\nFiles: src/app.ts',
    undefined,
    undefined,
    'Lesson one\nLesson two',
  );
  assert.ok(prompt.includes('REPO PLAYBOOK'), 'must include REPO PLAYBOOK header');
  assert.ok(prompt.includes('Lesson one'), 'must include playbook lessons');
  assert.ok(prompt.includes('CONTEXT PACK'), 'must still include CONTEXT PACK');
  // REPO PLAYBOOK must precede CONTEXT PACK
  const playbookIdx = prompt.indexOf('REPO PLAYBOOK');
  const briefIdx = prompt.indexOf('CONTEXT PACK');
  assert.ok(playbookIdx < briefIdx, 'REPO PLAYBOOK must appear before CONTEXT PACK');
});

test('buildPrompt: no REPO PLAYBOOK section when playbookContent is absent', () => {
  const prompt = buildPrompt('add feature');
  assert.ok(!prompt.includes('REPO PLAYBOOK'), 'must not include REPO PLAYBOOK when no content');
});

test('buildPrompt: no REPO PLAYBOOK section when playbookContent is empty string', () => {
  const prompt = buildPrompt('add feature', undefined, undefined, undefined, undefined, undefined, '');
  assert.ok(!prompt.includes('REPO PLAYBOOK'), 'must not include REPO PLAYBOOK for empty string');
});

test('buildPrompt: REPO PLAYBOOK present with repair evidence (section order preserved)', () => {
  const prompt = buildPrompt(
    'fix bug',
    undefined,
    undefined,
    'BRIEF:\nsome context',
    'REPAIR EVIDENCE — ...',
    undefined,
    'Lesson one',
  );
  const playbookIdx = prompt.indexOf('REPO PLAYBOOK');
  const briefIdx = prompt.indexOf('CONTEXT PACK');
  const repairIdx = prompt.indexOf('REPAIR EVIDENCE');
  const requestIdx = prompt.indexOf('REQUEST:');
  assert.ok(playbookIdx < briefIdx, 'REPO PLAYBOOK before CONTEXT PACK');
  assert.ok(briefIdx < repairIdx, 'CONTEXT PACK before REPAIR EVIDENCE');
  assert.ok(repairIdx < requestIdx, 'REPAIR EVIDENCE before REQUEST');
});

test('buildPrompt: REPO PLAYBOOK present with resume note (section order preserved)', () => {
  const prompt = buildPrompt(
    'fix bug',
    undefined,
    undefined,
    'BRIEF:\nsome context',
    undefined,
    'RESUME NOTE — prior salvage patch applied.',
    'Lesson one',
  );
  const playbookIdx = prompt.indexOf('REPO PLAYBOOK');
  const briefIdx = prompt.indexOf('CONTEXT PACK');
  const resumeIdx = prompt.indexOf('RESUME NOTE');
  assert.ok(playbookIdx < briefIdx, 'REPO PLAYBOOK before CONTEXT PACK');
  assert.ok(briefIdx < resumeIdx, 'CONTEXT PACK before RESUME NOTE');
});

// ---------------------------------------------------------------------------
// buildBatchPrompt tests
// ---------------------------------------------------------------------------

test('buildBatchPrompt: REPO PLAYBOOK section injected when playbookContent given', () => {
  const prompt = buildBatchPrompt(
    [
      { id: 'WI-001', spec: 'build X', brief: 'BRIEF:\nFiles: src/x.ts' },
      { id: 'WI-002', spec: 'build Y' },
    ],
    'Lesson one\nLesson two',
  );
  assert.ok(prompt.includes('REPO PLAYBOOK'), 'must include REPO PLAYBOOK');
  assert.ok(prompt.includes('Lesson one'), 'must include lessons');
  // REPO PLAYBOOK should appear once, before the items list
  const playbookIdx = prompt.indexOf('REPO PLAYBOOK');
  const item1Idx = prompt.indexOf('### ITEM 1');
  assert.ok(playbookIdx < item1Idx, 'REPO PLAYBOOK must precede items list');
});

test('buildBatchPrompt: no REPO PLAYBOOK section when playbookContent absent', () => {
  const prompt = buildBatchPrompt([{ id: 'WI-001', spec: 'build X' }]);
  assert.ok(!prompt.includes('REPO PLAYBOOK'), 'must not include REPO PLAYBOOK when absent');
});

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

test('config: playbook block defaults applied when absent', () => {
  const repoRoot = makeTempDir();
  try {
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.playbook?.enabled, true, 'default playbook.enabled must be true');
    assert.equal(cfg.playbook?.path, '.ai/loops/playbook.md', 'default playbook.path');
    assert.equal(cfg.playbook?.maxLines, 40, 'default playbook.maxLines must be 40');
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: playbook block values from config file override defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ playbook: { enabled: false, path: '.ai/custom.md', maxLines: 20 } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.playbook?.enabled, false);
    assert.equal(cfg.playbook?.path, '.ai/custom.md');
    assert.equal(cfg.playbook?.maxLines, 20);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: partial playbook block merges with defaults', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ playbook: { maxLines: 10 } }),
      'utf8',
    );
    const cfg = loadConfig(repoRoot);
    assert.equal(cfg.playbook?.enabled, true, 'default enabled must still apply');
    assert.equal(cfg.playbook?.path, '.ai/loops/playbook.md', 'default path must still apply');
    assert.equal(cfg.playbook?.maxLines, 10, 'overridden maxLines must be respected');
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: playbook.enabled bad type throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ playbook: { enabled: 'yes' } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /playbook\.enabled must be a boolean/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: playbook.path empty string throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ playbook: { path: '' } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /playbook\.path must be a non-empty string/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: playbook.maxLines zero throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ playbook: { maxLines: 0 } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /playbook\.maxLines must be a positive integer/);
  } finally {
    cleanDir(repoRoot);
  }
});

test('config: playbook.maxLines non-integer throws', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(
      join(repoRoot, 'loopkit.config.json'),
      JSON.stringify({ playbook: { maxLines: 1.5 } }),
      'utf8',
    );
    assert.throws(() => loadConfig(repoRoot), /playbook\.maxLines must be a positive integer/);
  } finally {
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Dispatch integration test — playbook file read and injected
// ---------------------------------------------------------------------------

test('dispatch: build prompt includes REPO PLAYBOOK when playbook file exists', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-001', 'item.queued', {
      spec: 'add feature to src/app.ts',
      touches: 'src/',
    }),
  ]);

  try {
    // Write a playbook file at the default path
    const playbookDir = join(repoRoot, '.ai', 'loops');
    mkdirSync(playbookDir, { recursive: true });
    writeFileSync(
      join(playbookDir, 'playbook.md'),
      '# This is a comment — excluded\nLesson one from playbook\nLesson two from playbook\n',
      'utf8',
    );

    let capturedPrompt: string | undefined;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'app.ts'), '// built', 'utf8');
        spawnSync('git', ['add', 'src/app.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-001): add feature'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ playbook: { enabled: true, path: '.ai/loops/playbook.md', maxLines: 40 } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/app.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(
      capturedPrompt.includes('REPO PLAYBOOK'),
      `build prompt must contain REPO PLAYBOOK section (got: ${capturedPrompt.slice(0, 300)})`,
    );
    assert.ok(
      capturedPrompt.includes('Lesson one from playbook'),
      'build prompt must include lesson text',
    );
    // Comment lines must be excluded
    assert.ok(
      !capturedPrompt.includes('This is a comment'),
      'comment lines must be excluded from injected content',
    );
  } finally {
    cleanup();
  }
});

test('dispatch: build prompt has no REPO PLAYBOOK when playbook disabled in config', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-002', 'item.queued', {
      spec: 'add feature to src/app.ts',
      touches: 'src/',
    }),
  ]);

  try {
    // Write a playbook file — should be ignored when disabled
    const playbookDir = join(repoRoot, '.ai', 'loops');
    mkdirSync(playbookDir, { recursive: true });
    writeFileSync(join(playbookDir, 'playbook.md'), 'Lesson one from playbook\n', 'utf8');

    let capturedPrompt: string | undefined;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'app.ts'), '// built', 'utf8');
        spawnSync('git', ['add', 'src/app.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-002): add feature'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ playbook: { enabled: false } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/app.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(
      !capturedPrompt.includes('REPO PLAYBOOK'),
      'must not include REPO PLAYBOOK when playbook disabled',
    );
  } finally {
    cleanup();
  }
});

test('dispatch: build proceeds cold when playbook file is absent (fail-open)', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-003', 'item.captured', { source: 'cli', text: 'build feature' }),
    makeEvent('conductor', 'WI-003', 'item.queued', {
      spec: 'add feature to src/feature.ts',
      touches: 'src/',
    }),
  ]);

  try {
    // No playbook file written — build must proceed cold without parking.
    // Use src/feature.ts (not src/app.ts) to avoid triggering the spine regex.
    let capturedPrompt: string | undefined;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        const { spawnSync } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'feature.ts'), '// built', 'utf8');
        spawnSync('git', ['add', 'src/feature.ts'], { cwd: req.cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'feat(WI-003): add feature'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ playbook: { enabled: true } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/feature.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });

    assert.ok(capturedPrompt, 'build must have proceeded despite missing playbook file');
    assert.ok(!capturedPrompt.includes('REPO PLAYBOOK'), 'no REPO PLAYBOOK when file absent (cold build)');
    assert.equal(result.dispatched.length, 1, 'item must have been dispatched');
    assert.equal(result.dispatched[0].gateOutcome, 'passed', 'gate must pass (not parked by missing playbook)');
  } finally {
    cleanup();
  }
});
