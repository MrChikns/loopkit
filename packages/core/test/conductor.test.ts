/**
 * conductor.test.ts — attended session-mode executor:
 *  - Touches clustering (one parser: touchesConflict) — disjoint → separate clusters,
 *    overlapping/bridging → same cluster, touches-less → one serial cluster.
 *  - `conduct --dry-run` prints the plan and appends nothing.
 *  - End-to-end: two claimed items against a temp git target repo, one cluster, ONE gate
 *    run for the whole cluster, both items closed with item.merged (commit + sessionId),
 *    the cluster branch merged into the target's main.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { clusterByTouches, runConduct } from '../src/conductor.js';
import { manifestHash, readTargetManifest } from '../src/target.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

const SES = 'ses-testaaaa';

function testConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return { ...CONFIG_DEFAULTS, promptsDir: '.ai/loops/prompts', notifyHook: '.ai/notify-phone.sh', ...overrides };
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

/** A tiny target repo on `main` with a manifest whose gate logs each run (always green). */
function makeTargetRepo(root: string, gateLog: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'notes.js'), 'export const notes = [];\n', 'utf8');
  writeFileSync(join(root, 'loopkit.target.json'), JSON.stringify({
    name: 'notes',
    defaultBranch: 'main',
    gateCommand: `echo gated >> ${gateLog}`,
  }), 'utf8');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init target']);
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

test('clusterByTouches: disjoint footprints get separate clusters', () => {
  const { parallel, serial } = clusterByTouches([
    { id: 'WI-001', touches: 'packages/a/' },
    { id: 'WI-002', touches: 'packages/b/' },
  ]);
  assert.equal(parallel.length, 2);
  assert.equal(serial.length, 0);
});

test('clusterByTouches: overlapping footprints share a cluster (segment-boundary, one parser)', () => {
  const { parallel } = clusterByTouches([
    { id: 'WI-001', touches: 'packages/a/src' },
    { id: 'WI-002', touches: 'packages/a' },
    // A raw prefix match would wrongly co-cluster this sibling; touchesConflict must not.
    { id: 'WI-003', touches: 'packages/a-sibling' },
  ]);
  assert.equal(parallel.length, 2);
  const together = parallel.find(c => c.length === 2)!;
  assert.deepEqual(together.map(i => i.id).sort(), ['WI-001', 'WI-002']);
});

test('clusterByTouches: a bridging item merges two clusters transitively', () => {
  const { parallel } = clusterByTouches([
    { id: 'WI-001', touches: 'x/' },
    { id: 'WI-002', touches: 'y/' },
    { id: 'WI-003', touches: 'x/,y/' },
  ]);
  assert.equal(parallel.length, 1);
  assert.deepEqual(parallel[0].map(i => i.id).sort(), ['WI-001', 'WI-002', 'WI-003']);
});

test('clusterByTouches: touches-less and wildcard items form the one serial cluster', () => {
  const { parallel, serial } = clusterByTouches([
    { id: 'WI-001', touches: 'src/' },
    { id: 'WI-002' },
    { id: 'WI-003', touches: '*' },
  ]);
  assert.equal(parallel.length, 1);
  assert.deepEqual(serial.map(i => i.id).sort(), ['WI-002', 'WI-003']);
});

// ---------------------------------------------------------------------------
// Dry-run plan
// ---------------------------------------------------------------------------

test('conduct --dry-run: prints the cluster plan and appends nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'conduct-dry-'));
  try {
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    const runDir = join(base, 'runs');
    makeTargetRepo(targetRoot, join(base, 'gate-runs.log'));
    const manifest = readTargetManifest(targetRoot);
    const hash = manifestHash(manifest);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
      }),
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'one', target: 'notes' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'add one', touches: 'src/' }),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'two', target: 'notes' }),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'add two', touches: 'docs/' }),
      makeEvent('cli', SES, 'session.started', { sessionId: SES }),
      makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: SES, ttlMinutes: 60 }),
      makeEvent('cli', 'WI-002', 'item.claimed', { sessionId: SES, ttlMinutes: 60 }),
    ]);
    const before = (await loadAllEvents(ledgerDir)).length;

    const result = await runConduct({
      ledgerDir, runDir, repoRoot: base, sessionId: SES, dryRun: true, config: testConfig(),
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.sessionId, SES);
    assert.equal(result.clusters.length, 2, 'disjoint touches → two planned clusters');
    for (const c of result.clusters) {
      assert.equal(c.outcome, 'dry-run');
      assert.equal(c.target, 'notes');
      assert.match(c.detail ?? '', /main/, 'plan names the merge branch');
    }
    const planned = result.clusters.flatMap(c => c.items).sort();
    assert.deepEqual(planned, ['WI-001', 'WI-002']);

    const after = (await loadAllEvents(ledgerDir)).length;
    assert.equal(after, before, 'dry-run must append no events');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: one cluster, one gate run, both merged
// ---------------------------------------------------------------------------

test('E2E conduct: two claimed items build sequentially in ONE worktree, gate runs once, both merge', async () => {
  const base = mkdtempSync(join(tmpdir(), 'conduct-e2e-'));
  try {
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    const runDir = join(base, 'runs');
    const gateLog = join(base, 'gate-runs.log');
    makeTargetRepo(targetRoot, gateLog);
    const manifest = readTargetManifest(targetRoot);
    const hash = manifestHash(manifest);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
      }),
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'one', target: 'notes' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'add src/one.js', touches: 'src/' }),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'two', target: 'notes' }),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'add src/two.js', touches: 'src/' }),
      makeEvent('cli', SES, 'session.started', { sessionId: SES }),
      makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: SES, ttlMinutes: 60 }),
      makeEvent('cli', 'WI-002', 'item.claimed', { sessionId: SES, ttlMinutes: 60 }),
    ]);

    // Stub provider (same test-provider pattern the beat tests use): writes the file the
    // spec names into the SHARED cluster worktree and commits it.
    const calls: { cwd: string; file: string }[] = [];
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        assert.ok(existsSync(join(cwd, 'src', 'notes.js')), 'worker cwd must be a worktree of the target repo');
        assert.ok(req.tools?.includes('Edit') && req.tools?.includes('Write'),
          'conduct build request must carry the builder tool allowlist');
        const file = req.prompt.includes('one.js') ? 'one.js' : 'two.js';
        calls.push({ cwd, file });
        writeFileSync(join(cwd, 'src', file), `export const marker = '${file}';\n`, 'utf8');
        spawnSync('git', ['add', `src/${file}`], { cwd, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', `feat: add ${file}`], { cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 10, out: 5 } };
      },
    };

    const result = await runConduct({
      ledgerDir, runDir, repoRoot: base, sessionId: SES, provider, config: testConfig(),
    });

    // One cluster (overlapping 'src/' touches), both items in it, merged.
    assert.equal(result.clusters.length, 1, JSON.stringify(result.clusters));
    const cluster = result.clusters[0];
    assert.equal(cluster.outcome, 'merged', cluster.detail ?? 'cluster must merge');
    assert.deepEqual(cluster.items.sort(), ['WI-001', 'WI-002']);
    assert.ok(cluster.mergeCommit, 'merge commit recorded');

    // Sequential in ONE worktree: both provider calls share the same cwd.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].cwd, calls[1].cwd, 'items within a cluster share one worktree');

    // ONE gate run for the whole cluster.
    const gateRuns = readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(gateRuns.length, 1, 'the gate must run once per cluster, not per item');

    // Both items closed with item.merged carrying the SAME commit + the sessionId.
    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')!.state, 'merged');
    assert.equal(folded.items.get('WI-002')!.state, 'merged');
    const mergedEvents = events.filter(e => e.type === 'item.merged');
    assert.equal(mergedEvents.length, 2);
    for (const ev of mergedEvents) {
      const d = ev.data as { commit: string; sessionId?: string };
      assert.equal(d.commit, cluster.mergeCommit);
      assert.equal(d.sessionId, SES, 'item.merged carries the building session');
    }

    // The cluster branch really merged into the TARGET repo main.
    const log = git(targetRoot, ['log', '--oneline', 'main']).stdout.toString();
    assert.match(log, /conduct: WI-001 WI-002/, 'cluster merge commit on target main');
    assert.match(log, /add one\.js/);
    assert.match(log, /add two\.js/);
    const onMain = git(targetRoot, ['show', 'main:src/one.js']);
    assert.equal(onMain.status, 0, 'built file reachable from main');

    // The conduct loop heartbeat between items (dead-man liveness).
    assert.ok(folded.sessions.get(SES)!.lastHeartbeatAt, 'heartbeats appended during conduct');

    // Claims were consumed by the dispatch transitions.
    assert.equal(folded.items.get('WI-001')!.claim, undefined);
    assert.equal(folded.items.get('WI-002')!.claim, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sensitivity(conductor): a PRIVATE claimed cluster fails closed — never routed to the claude provider', async () => {
  // TRUST-HARDENING (FIX 2): the conductor resolves each cluster's provider against the strictest
  // member's sensitivity. With no injected provider, it builds a registry from cfg; a private tier
  // with an empty allowlist must make the cluster error fail-closed (never route to the internal
  // claude chain) and merge nothing.
  const base = mkdtempSync(join(tmpdir(), 'conduct-priv-'));
  try {
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    const runDir = join(base, 'runs');
    const gateLog = join(base, 'gate-runs.log');
    makeTargetRepo(targetRoot, gateLog);
    const manifest = readTargetManifest(targetRoot);
    const hash = manifestHash(manifest);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
      }),
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'secret', target: 'notes', sensitivity: 'private' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'add src/secret.js', touches: 'src/' }),
      makeEvent('cli', SES, 'session.started', { sessionId: SES }),
      makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: SES, ttlMinutes: 60 }),
    ]);

    // No injected provider → the conductor builds a registry from cfg. internal → claude-cli,
    // private → empty (forbidden): the private cluster must resolve to nothing.
    const cfg = testConfig({
      sensitivityAllowlists: { internal: ['claude-cli'], public: ['claude-cli'] },
      chains: { internal: ['claude-cli'], public: ['claude-cli'], private: [] },
    } as Partial<LoopkitConfig>);

    const result = await runConduct({ ledgerDir, runDir, repoRoot: base, sessionId: SES, config: cfg });

    assert.equal(result.clusters.length, 1, JSON.stringify(result.clusters));
    const cluster = result.clusters[0];
    assert.equal(cluster.outcome, 'error', 'the private cluster must fail closed, not build');
    assert.match(cluster.detail ?? '', /sensitivity\(private\)/, 'the failure names the fail-closed sensitivity');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.merged' && e.item === 'WI-001').length, 0,
      'a private item must never merge through a disallowed provider');
    // The target repo main is untouched — nothing was built or merged.
    const log = git(targetRoot, ['log', '--oneline', 'main']).stdout.toString();
    assert.ok(!/secret/.test(log), 'no private build reached the target');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
