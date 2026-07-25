/**
 * router-rename-compat.test.ts — the compatibility half of the conductor→router rename.
 *
 * The routing wall (the reactor's classify prompt + the model alias it runs on) used to be
 * called `conductor`, which read like a leftover of the lane ADR-013 deleted. It is now
 * `router`. Both of its operator-settable surfaces are *configuration a deployment already
 * has on disk*, so the rename must never revert someone's setting in silence:
 *
 *   - `models.conductor` → honoured as `models.router`, announced on stderr.
 *   - `prompts/conductor.md` → still loaded when `router.md` is absent, announced on stderr.
 *
 * These tests pin the "announced, not silent" half. Deleting them re-opens the exact
 * failure mode the compatibility shim exists to prevent: a configured routing model
 * quietly falling back to the default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mergeModels, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

let n = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-router-compat-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// models.conductor → models.router
// ---------------------------------------------------------------------------

test('mergeModels: a legacy models.conductor is honoured as models.router, with a warning', () => {
  const warnings: string[] = [];
  const models = mergeModels(
    { conductor: 'opus' } as unknown as Partial<LoopkitConfig['models']>,
    CONFIG_DEFAULTS.models,
    (m) => warnings.push(m),
  );

  assert.equal(models.router, 'opus', 'a configured conductor model must not silently revert to the default');
  assert.equal(models.builderDefault, CONFIG_DEFAULTS.models.builderDefault);
  assert.equal((models as unknown as Record<string, unknown>)['conductor'], undefined, 'the dead key is not carried forward');
  assert.equal(warnings.length, 1, 'the deprecation must be visible, not silent');
  assert.match(warnings[0], /models\.conductor is deprecated/);
  assert.match(warnings[0], /models\.router/);
});

test('mergeModels: models.router wins when both keys are set, and says so', () => {
  const warnings: string[] = [];
  const models = mergeModels(
    { conductor: 'opus', router: 'haiku' } as unknown as Partial<LoopkitConfig['models']>,
    CONFIG_DEFAULTS.models,
    (m) => warnings.push(m),
  );

  assert.equal(models.router, 'haiku');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /IGNORED/);
});

test('mergeModels: no legacy key → defaults, and no warning noise', () => {
  const warnings: string[] = [];
  assert.equal(
    mergeModels(undefined, CONFIG_DEFAULTS.models, (m) => warnings.push(m)).router,
    CONFIG_DEFAULTS.models.router,
  );
  assert.equal(
    mergeModels({ router: 'haiku' }, CONFIG_DEFAULTS.models, (m) => warnings.push(m)).router,
    'haiku',
  );
  assert.equal(warnings.length, 0, 'a config with no deprecated key must warn about nothing');
});

// ---------------------------------------------------------------------------
// prompts/conductor.md → prompts/router.md
// ---------------------------------------------------------------------------

function fakeProvider(text: string): LlmProvider {
  return {
    name: 'fake',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

const ANSWER_BLOCK = ['ROUTE: answer', 'REPLY: all good'].join('\n');

test('reactor: a target still shipping prompts/conductor.md keeps routing', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // Only the OLD filename exists — the shape of a deployment that has not migrated.
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt');

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-901', 'item.captured', { source: 'test', text: 'is everything ok?' }),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: fakeProvider(ANSWER_BLOCK),
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.', promptsDir: '.ai/loops/prompts' },
    });
    assert.ok(result, 'reactor ran');

    const routed = (await loadAllEvents(ledgerDir)).filter(e => e.type === 'item.routed' && e.item === 'WI-901');
    assert.equal(routed.length, 1, 'the legacy prompt filename must not wedge the queue');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: neither router.md nor conductor.md → a loud failure naming router.md', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-902', 'item.captured', { source: 'test', text: 'is everything ok?' }),
    ]);

    const result = await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: fakeProvider(ANSWER_BLOCK),
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.', promptsDir: '.ai/loops/prompts' },
    });

    const routeStep = result.steps.find(s => s.step === 'route');
    assert.ok(routeStep, 'the route step reports');
    assert.equal(routeStep.ok, false, 'a missing prompt is a failed step, never a silent skip');
    assert.match(String(routeStep.detail), /router prompt missing/);
    assert.match(String(routeStep.detail), /router\.md/, 'the message names the CURRENT filename to create');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});
