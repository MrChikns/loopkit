/**
 * wi-id-race.test.ts — WI-134: next-WI-NNN assignment must be atomic with the locked ledger
 * append, not computed from a stale pre-lock fold snapshot.
 *
 * Regression: stepEngageReplies (reactor.ts, sibling-capture path) used to fold the ledger
 * BEFORE the (possibly slow) per-reply provider call, then mint the sibling's WI id from that
 * stale snapshot at append time. A concurrent writer through a DIFFERENT path — here,
 * `captureIntent` (the same verb `loopctl new`/cmdNew uses) — that appended in the meantime
 * could be assigned the identical WI number, and the loser's item silently vanished from the
 * fold (last-write-wins on id, first item orphaned). This is the same fix class as a
 * recompute-the-id-at-write-time id allocator.
 *
 * This test races captureIntent (cli `new` writer path) against the reactor's engagement
 * sibling-spawn (a different writer path) on the SAME ledger, with the reactor's provider
 * artificially slow — so several captureIntent calls complete and append WHILE the reactor step
 * is still "mid-flight" between its initial fold and its final append. Before the WI-134 fix,
 * the reactor step would mint its sibling id from the pre-provider-call snapshot and collide
 * with one of the ids captureIntent already claimed. After the fix, every id is distinct.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { captureIntent } from '../src/verbs.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { SloRow } from '../src/slo.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi-race-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTestConfig(): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
  };
}

function makeHealthyBoard(): SloRow[] {
  return [
    { key: 'loop-reactor', label: 'reactor', value: '10s ago', target: '≤ 5m', status: 'met' },
    { key: 'loop-dispatch', label: 'dispatch', value: '30s ago', target: '≤ 10m', status: 'met' },
    { key: 'instances', label: 'instances', value: 'up', target: 'all up', status: 'met' },
  ];
}

/** Provider that waits `delayMs` (simulating a slow LLM round-trip) before replying. */
function makeDelayedEngageProvider(text: string, delayMs: number): LlmProvider {
  return {
    name: 'fake-delayed-engage',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

test('WI-134: captureIntent racing the reactor engagement sibling-spawn never collides on a WI id', async () => {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'runs', 'reactor'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'engagement.md'), 'ENGAGEMENT PROMPT (test stub).', 'utf8');

  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  const NOW = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const reply = makeEvent('operator', 'WI-001', 'msg.in', { text: 'spin this off separately' }, iso(NOW - 5_000));
  const seed: LedgerEvent[] = [
    makeEvent('system', 'system', 'engagement.baseline', {}, iso(NOW - 1_000_000)),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'x', text: 'do X' }, iso(NOW - 900_000)),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'do X', touches: 'packages/engine/' }, iso(NOW - 800_000)),
    reply,
  ];
  await appendEvents(ledgerDir, seed);

  try {
    // Reactor engagement step: slow provider (150ms) so its final append races against several
    // fast captureIntent calls that start (and finish) after the reactor's initial fold.
    const provider = makeDelayedEngageProvider('OUTCOME: sibling\nREPLY: ok.\nSPEC: spun-off work', 150);
    const reactorOpts: ReactorOptions = {
      repoRoot, ledgerDir, autonomy: 'on', provider,
      pidProbe: () => true,
      config: makeTestConfig(),
      provisionalSloBoard: makeHealthyBoard(),
    };

    const CAPTURES = 5;
    await Promise.all([
      runReactor(reactorOpts),
      ...Array.from({ length: CAPTURES }, (_, i) =>
        captureIntent(ledgerDir, { text: `racing capture ${i}`, source: 'cli' })),
    ]);

    const all = await loadAllEvents(ledgerDir);
    const capturedIds = all.filter((e) => e.type === 'item.captured').map((e) => e.item);

    // 1 seeded (WI-001) + CAPTURES from captureIntent + 1 sibling from engagement.
    assert.equal(capturedIds.length, 1 + CAPTURES + 1, 'every captured item made it into the ledger (none silently dropped by an id collision)');
    assert.equal(new Set(capturedIds).size, capturedIds.length, `no duplicate WI ids: ${JSON.stringify(capturedIds)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
