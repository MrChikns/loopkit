/**
 * target.test.ts — TARGET EXTERNALIZATION: manifest read/validate/defaults/hash, the fold's
 * target projection (registered + targeted items + a legacy mix), and legacy-mode regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readTargetManifest,
  parseTargetManifest,
  manifestHash,
  TARGET_MANIFEST_FILENAME,
} from '../src/target.js';
import { fold } from '../src/fold.js';
import { makeEvent } from '../src/schema.js';

// ---------------------------------------------------------------------------
// Manifest parse / defaults / validation
// ---------------------------------------------------------------------------

test('parseTargetManifest: a minimal { name } manifest fills all defaults', () => {
  const m = parseTargetManifest({ name: 'notes' });
  assert.equal(m.name, 'notes');
  assert.equal(m.defaultBranch, 'main');
  assert.equal(m.gateCommand, 'npm test');
  assert.equal(m.gateWorkdir, '.');
  assert.equal(m.deployCommand, '');
  assert.equal(m.worktreePrefix, 'loop-');
  assert.equal(m.touches.conflictMode, 'prefix');
  assert.deepEqual(m.boundaries, { planePrefixes: [], surfacePrefixes: [], escalationPatterns: [] });
  assert.equal(m.buildTimeoutMinutes, 45);
});

test('parseTargetManifest: explicit fields override defaults', () => {
  const m = parseTargetManifest({
    name: 'app',
    defaultBranch: 'master',
    gateCommand: 'make test',
    gateWorkdir: 'sub',
    deployCommand: './deploy.sh',
    worktreePrefix: 'wt-',
    boundaries: { planePrefixes: ['ops/'], surfacePrefixes: ['ui/'], escalationPatterns: ['auth'] },
    buildTimeoutMinutes: 20,
  });
  assert.equal(m.defaultBranch, 'master');
  assert.equal(m.gateCommand, 'make test');
  assert.equal(m.gateWorkdir, 'sub');
  assert.equal(m.deployCommand, './deploy.sh');
  assert.equal(m.worktreePrefix, 'wt-');
  assert.deepEqual(m.boundaries.planePrefixes, ['ops/']);
  assert.deepEqual(m.boundaries.surfacePrefixes, ['ui/']);
  assert.deepEqual(m.boundaries.escalationPatterns, ['auth']);
  assert.equal(m.buildTimeoutMinutes, 20);
});

test('parseTargetManifest: rejects a missing/empty name', () => {
  assert.throws(() => parseTargetManifest({}), /name must be a non-empty string/);
  assert.throws(() => parseTargetManifest({ name: '' }), /name must be a non-empty string/);
});

test('parseTargetManifest: rejects a non-object', () => {
  assert.throws(() => parseTargetManifest([]), /must be a JSON object/);
  assert.throws(() => parseTargetManifest('nope'), /must be a JSON object/);
});

test('parseTargetManifest: rejects a bad boundaries array', () => {
  assert.throws(
    () => parseTargetManifest({ name: 'x', boundaries: { planePrefixes: [1, 2] } }),
    /boundaries.planePrefixes must be an array of strings/,
  );
});

test('parseTargetManifest: rejects an unsupported conflictMode', () => {
  assert.throws(
    () => parseTargetManifest({ name: 'x', touches: { conflictMode: 'exact' } }),
    /touches.conflictMode must be 'prefix'/,
  );
});

test('parseTargetManifest: accepts acceptance.tiers overrides', () => {
  const m = parseTargetManifest({ name: 'x', acceptance: { tiers: { reviewAfterHours: 24 } } });
  assert.equal(m.acceptance?.tiers?.reviewAfterHours, 24);
});

// ---------------------------------------------------------------------------
// readTargetManifest (from disk)
// ---------------------------------------------------------------------------

test('readTargetManifest: reads + validates a manifest from a repo path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-read-'));
  try {
    writeFileSync(join(dir, TARGET_MANIFEST_FILENAME), JSON.stringify({ name: 'notes', gateCommand: 'npm test' }));
    const m = readTargetManifest(dir);
    assert.equal(m.name, 'notes');
    assert.equal(m.gateCommand, 'npm test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTargetManifest: a missing manifest throws a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-missing-'));
  try {
    assert.throws(() => readTargetManifest(dir), new RegExp(`No ${TARGET_MANIFEST_FILENAME} found`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTargetManifest: malformed JSON throws a parse error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-bad-'));
  try {
    writeFileSync(join(dir, TARGET_MANIFEST_FILENAME), '{ not json');
    assert.throws(() => readTargetManifest(dir), /parse error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// manifestHash: stable, content-driven, order-independent
// ---------------------------------------------------------------------------

test('manifestHash: identical effective manifests hash equal regardless of key order/omitted defaults', () => {
  const a = parseTargetManifest({ name: 'n', gateCommand: 'npm test', defaultBranch: 'main' });
  const b = parseTargetManifest({ defaultBranch: 'main', name: 'n' }); // gateCommand omitted = default 'npm test'
  assert.equal(manifestHash(a), manifestHash(b));
});

test('manifestHash: a changed field changes the hash', () => {
  const a = parseTargetManifest({ name: 'n', gateCommand: 'npm test' });
  const b = parseTargetManifest({ name: 'n', gateCommand: 'make test' });
  assert.notEqual(manifestHash(a), manifestHash(b));
});

// ---------------------------------------------------------------------------
// Fold: target projection + targeted items + legacy mix
// ---------------------------------------------------------------------------

test('fold: target.registered populates the targets projection', () => {
  const events = [
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: '/repos/notes', manifestHash: 'abc123', defaultBranch: 'main',
    }),
  ];
  const result = fold(events);
  const rec = result.targets.get('notes');
  assert.ok(rec, 'targets map must contain notes');
  assert.equal(rec.repoPath, '/repos/notes');
  assert.equal(rec.defaultBranch, 'main');
  assert.equal(rec.manifestHash, 'abc123');
});

test('fold: target.manifest-updated updates the hash append-only, keeps repoPath', () => {
  const events = [
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: '/repos/notes', manifestHash: 'v1', defaultBranch: 'main',
    }),
    makeEvent('cli', 'notes', 'target.manifest-updated', {
      name: 'notes', manifestHash: 'v2', defaultBranch: 'trunk',
    }),
  ];
  const result = fold(events);
  const rec = result.targets.get('notes')!;
  assert.equal(rec.manifestHash, 'v2');
  assert.equal(rec.defaultBranch, 'trunk');
  assert.equal(rec.repoPath, '/repos/notes', 'repoPath is immutable across updates');
  assert.ok(rec.updatedAt, 'updatedAt is stamped');
});

test('fold: a targeted item carries its target; a legacy item does not (mixed ledger)', () => {
  const events = [
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: '/repos/notes', manifestHash: 'h', defaultBranch: 'main',
    }),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'targeted', target: 'notes' }),
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'legacy' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-001')?.target, 'notes');
  assert.equal(result.items.get('WI-002')?.target, undefined, 'legacy item has no target');
});

test('fold: a ledger with NO target events yields an empty targets map (legacy regression)', () => {
  const events = [
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'legacy build' }),
    makeEvent('cli', 'WI-001', 'item.queued', { spec: 'do it', touches: 'src/' }),
  ];
  const result = fold(events);
  assert.equal(result.targets.size, 0);
  assert.equal(result.items.get('WI-001')?.target, undefined);
  // Legacy shape preserved: the item still folds to 'queued' exactly as before.
  assert.equal(result.items.get('WI-001')?.state, 'queued');
});
