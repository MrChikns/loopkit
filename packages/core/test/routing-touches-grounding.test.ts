/**
 * routing-touches-grounding.test.ts — routed Touches are grounded against the TARGET
 * repo's real tree.
 *
 * The router sometimes names path prefixes that don't exist in the target repo, and lane
 * disjointness then rests on fiction. The routing WALL (deterministic post-processing, no
 * prompt change) validates each Touches prefix against the target's top-level tree:
 * fictional prefixes are dropped, real ones kept, and the correction is noted in the reply
 * + step detail. Untargeted items are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, groundTouchesAgainstTree } from '../src/beats/reactor.js';
import { manifestHash, readTargetManifest } from '../src/target.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

// ── Pure wall unit ─────────────────────────────────────────────────────────

test('touches grounding: fictional prefix dropped, real prefix kept', () => {
  const tree = new Set(['src', 'test', 'README.md']);
  const g = groundTouchesAgainstTree('src/beats, tools/embedded/src', tree);
  assert.equal(g.touches, 'src/beats', 'the real prefix survives');
  assert.deepEqual(g.dropped, ['tools/embedded/src'], 'the fictional prefix is dropped');
});

test('touches grounding: wildcard survives; all-fictional collapses to undefined', () => {
  const tree = new Set(['src']);
  assert.equal(groundTouchesAgainstTree('*', tree).touches, '*', 'the wildcard is never dropped');
  const g = groundTouchesAgainstTree('made/up, also/fake', tree);
  assert.equal(g.touches, undefined, 'nothing real left → undefined (wildcard lane, not fiction)');
  assert.deepEqual(g.dropped, ['made/up', 'also/fake']);
});

test('touches grounding: a top-level file prefix counts as real', () => {
  const tree = new Set(['src', 'README.md']);
  const g = groundTouchesAgainstTree('README.md, src/', tree);
  assert.equal(g.touches, 'README.md, src');
  assert.deepEqual(g.dropped, []);
});

// ── Routing-step integration ───────────────────────────────────────────────

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

function makeTargetRepo(root: string, name = 'notes'): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'loopkit.target.json'), JSON.stringify({ name }), 'utf8');
  writeFileSync(join(root, 'src', 'notes.js'), '// notes\n', 'utf8');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init target']);
}

function testConfig(): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
  };
}

function makeRouterProvider(touchesLine: string): LlmProvider {
  const block = [
    'ROUTE: build',
    'SPEC: Do the change.',
    `TOUCHES: ${touchesLine}`,
    'MODEL: sonnet',
    'PRIORITY: medium',
    'REPLY: Queuing it now.',
  ].join('\n');
  return {
    name: 'fake-router',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text: block, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

test('reactor routing: a target item\'s fictional Touches prefix is dropped and the correction noted', async () => {
  const base = mkdtempSync(join(tmpdir(), 'route-ground-'));
  try {
    const repoRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt', 'utf8');
    makeTargetRepo(targetRoot);

    const manifest = readTargetManifest(targetRoot);
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: manifestHash(manifest), defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-201', 'item.captured', { source: 'cli', text: 'fix notes', target: 'notes' }, '2026-01-01T00:01:00Z'),
    ]);

    // Router names one REAL prefix (src/ exists in the target tree) and one FICTIONAL one.
    const result = await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeRouterProvider('src/, tools/embedded/src'),
      config: testConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-201');
    assert.equal(queued.length, 1);
    const touches = (queued[0].data as { touches?: string }).touches;
    assert.equal(touches, 'src', `only the real prefix may survive grounding (got: ${touches})`);

    // Correction noted: in the operator reply and in the routing step detail.
    const routed = events.filter(e => e.type === 'item.routed' && e.item === 'WI-201');
    assert.equal(routed.length, 1);
    const reply = (routed[0].data as { reply: string }).reply;
    assert.ok(reply.includes('dropped tools/embedded/src'),
      `the routed reply must note the dropped prefix (got: ${reply})`);
    const routeStep = result.steps.find(s => s.step === 'route');
    assert.ok(routeStep?.detail?.includes('grounded touches'),
      `the routing step detail must note the correction (got: ${routeStep?.detail})`);
    assert.ok(routeStep?.detail?.includes('tools/embedded/src'),
      `the routing step detail must name the dropped prefix (got: ${routeStep?.detail})`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('reactor routing: an untargeted item\'s Touches pass through ungrounded', async () => {
  const base = mkdtempSync(join(tmpdir(), 'route-ground-legacy-'));
  try {
    const repoRoot = join(base, 'plane');
    const ledgerDir = join(base, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub routing prompt', 'utf8');

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-301', 'item.captured', { source: 'cli', text: 'fix things' }, '2026-01-01T00:01:00Z'),
    ]);

    const result = await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeRouterProvider('anything/at-all, made/up'),
      config: testConfig(),
    });

    const events = await loadAllEvents(ledgerDir);
    const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-301');
    assert.equal(queued.length, 1);
    assert.equal((queued[0].data as { touches?: string }).touches, 'anything/at-all, made/up',
      'untargeted routing must keep the Touches byte-identical (no grounding)');
    const routeStep = result.steps.find(s => s.step === 'route');
    assert.ok(!routeStep?.detail?.includes('grounded touches'),
      'no grounding note may appear for an untargeted item');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
