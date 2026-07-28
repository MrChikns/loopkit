import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSummary, CONFIG_DEFAULTS, fold, makeEvent } from '@loopkit/core';
import type { FoldActiveItem, FoldSummary } from '@loopkit/opsui';
import { buildDeployTargets, buildSystemAxes, type OpsData } from '../src/opsPages.js';

function dataFor(events: ReturnType<typeof makeEvent>[], cfg = CONFIG_DEFAULTS): OpsData {
  const result = fold(events);
  const summary = buildSummary(result, events, { cfg, repoRoot: process.cwd() });
  return {
    events,
    cfg,
    result,
    fold: JSON.parse(JSON.stringify(summary)) as FoldSummary,
  };
}

test('System Flow builder covers every active Missions work group and never reports active work as Idle', () => {
  const states: FoldActiveItem[] = [
    { id: 'captured', state: 'captured' },
    { id: 'routed', state: 'routed' },
    { id: 'queued', state: 'queued' },
    { id: 'building', state: 'building' },
    { id: 'testing', state: 'testing' },
    { id: 'gated', state: 'gated' },
    { id: 'approved', state: 'approved' },
    { id: 'blocked', state: 'blocked' },
    { id: 'dependency', state: 'parked', blockedOn: 'WI-x' },
    { id: 'recovering', state: 'parked', parkKind: 'ops' },
    { id: 'decision', state: 'parked', parkKind: 'decision' },
    { id: 'held', state: 'parked', parkKind: 'hold' },
    { id: 'planning', state: 'parked', parkKind: 'decomposition' },
  ];
  const data = dataFor([]);
  data.fold.active = states;
  const axes = buildSystemAxes(
    data,
    { rollup: { status: 'met', label: 'All clear', breached: 0, atRisk: 0 }, panes: [] },
    true,
  );
  const flow = axes.find((axis) => axis.key === 'flow')!;
  assert.equal(flow.value, 'Blocked');
  assert.notEqual(flow.value, 'Idle');
  assert.match(flow.detail, /4 in progress/);
  assert.match(flow.detail, /3 queued/);
  assert.match(flow.detail, /2 blocked\/waiting/);
  assert.match(flow.detail, /1 recovering/);
  assert.match(flow.detail, /1 needs decision/);
  assert.match(flow.detail, /1 held/);
  assert.match(flow.detail, /1 planning/);
});

test('System deploy liveness keeps an untargeted sole-target-coalesced item in the Plane row', () => {
  const targetRoot = mkdtempSync(join(tmpdir(), 'loopkit-console-target-'));
  try {
    writeFileSync(join(targetRoot, 'loopkit.target.json'), JSON.stringify({
      name: 'sole-target',
      deployCommand: 'true',
      surfaceUrl: 'https://target.example.test/',
    }), 'utf8');
    const events = [
      makeEvent('cli', 'sole-target', 'target.registered', {
        targetId: 'tgt-aaaa2345',
        name: 'sole-target',
        repoPath: targetRoot,
        manifestHash: 'h',
        defaultBranch: 'main',
      }, '2026-07-20T09:00:00.000Z'),
      makeEvent('cli', 'WI-991', 'item.captured', { source: 'test', text: 'plane work' }, '2026-07-20T10:00:00.000Z'),
      makeEvent('dispatch', 'WI-991', 'item.merged', {
        commit: 'abc991',
        deployConfigured: true,
      }, '2026-07-20T10:10:00.000Z'),
      makeEvent('dispatch', 'WI-991', 'deploy.requested', {}, '2026-07-20T10:11:00.000Z'),
    ];
    const cfg = {
      ...CONFIG_DEFAULTS,
      deployCommand: 'true',
      surfaceUrl: 'https://plane.example.test/',
    };
    const rows = buildDeployTargets(dataFor(events, cfg));
    const plane = rows.find((row) => row.target === 'Plane')!;
    const target = rows.find((row) => row.target === 'sole-target')!;
    assert.equal(plane.itemId, 'WI-991');
    assert.equal(plane.status, 'pending');
    assert.equal(plane.surfaceUrl, 'https://plane.example.test/');
    assert.equal(target.itemId, undefined);
    assert.equal(target.status, 'idle');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('System deploy liveness shows current configuration separately from the latest durable receipt', () => {
  const events = [
    makeEvent('cli', 'WI-992', 'item.captured', { source: 'test', text: 'ship' }, '2026-07-20T10:00:00.000Z'),
    makeEvent('dispatch', 'WI-992', 'item.merged', {
      commit: 'abc992',
      deployConfigured: true,
    }, '2026-07-20T10:10:00.000Z'),
    makeEvent('dispatch', 'WI-992', 'deploy.requested', {}, '2026-07-20T10:11:00.000Z'),
    makeEvent('deploy-hook', 'WI-992', 'deploy.succeeded', { commit: 'abc992' }, '2026-07-20T10:12:00.000Z'),
  ];
  const plane = buildDeployTargets(dataFor(events, {
    ...CONFIG_DEFAULTS,
    deployCommand: '',
  }))[0]!;
  assert.equal(plane.configured, false);
  assert.equal(plane.status, 'succeeded');
  assert.equal(plane.itemId, 'WI-992');
});
