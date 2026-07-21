/**
 * target-id.test.ts — TARGET IDENTITY (docs/event-model.md §"Register a target": identity ≠
 * name): opaque targetId minting, deterministic fallback synthesis for legacy ledgers,
 * repoPath-pinned revival (never re-minted on a name change), null-target coalescing to the
 * configured default / sole registered target, and per-target worktree-dir namespacing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mintTargetId, fallbackTargetId, TARGET_ID_RE } from '../src/target.js';
import { fold } from '../src/fold.js';
import { makeEvent } from '../src/schema.js';
import { targetWorktreeDirName } from '../src/beats/dispatch.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { captureIntent } from '../src/verbs.js';

// ---------------------------------------------------------------------------
// Id minting + fallback synthesis
// ---------------------------------------------------------------------------

test('mintTargetId: tgt-<8 lowercase base32> shape, unique across mints', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const id = mintTargetId();
    assert.match(id, TARGET_ID_RE, `minted id must match the shape: ${id}`);
    seen.add(id);
  }
  assert.equal(seen.size, 500, 'minted ids must not collide');
});

test('fallbackTargetId: deterministic per repoPath, distinct across repoPaths', () => {
  const a1 = fallbackTargetId('/repos/notes');
  const a2 = fallbackTargetId('/repos/notes');
  const b = fallbackTargetId('/other/notes');
  assert.equal(a1, a2, 'same repoPath must synthesize the same id on every call');
  assert.notEqual(a1, b, 'different repoPaths must synthesize different ids');
  assert.match(a1, TARGET_ID_RE, 'fallback id shares the minted-id shape');
});

// ---------------------------------------------------------------------------
// Fold: id-keyed targets projection
// ---------------------------------------------------------------------------

test('fold: a stamped registration keys the targets map by targetId, name is display-only', () => {
  const id = 'tgt-abcd2345';
  const result = fold([
    makeEvent('cli', 'notes', 'target.registered', {
      targetId: id, name: 'notes', repoPath: '/repos/notes', manifestHash: 'h1', defaultBranch: 'main',
    }),
  ]);
  const rec = result.targets.byId(id);
  assert.ok(rec, 'targets map must be keyed by targetId');
  assert.equal(rec.targetId, id);
  assert.equal(rec.name, 'notes');
  assert.equal(result.targets.byName('notes')?.targetId, id);
  assert.equal(result.targets.byRepoPath('/repos/notes')?.targetId, id);
  // Transitional name-fallback get keeps name-keyed callers resolving during the cutover.
  assert.equal(result.targets.get('notes')?.targetId, id);
});

test('fold: a legacy registration (no targetId) synthesizes a stable repoPath-derived fallback', () => {
  const legacyReg = makeEvent('cli', 'notes', 'target.registered', {
    name: 'notes', repoPath: '/repos/notes', manifestHash: 'h1', defaultBranch: 'main',
  });
  const first = fold([legacyReg]);
  const second = fold([legacyReg]);
  const expected = fallbackTargetId('/repos/notes');
  assert.equal(first.targets.byName('notes')?.targetId, expected, 'fallback id derives from repoPath');
  assert.equal(second.targets.byName('notes')?.targetId, expected, 'every replay folds the same id');
  assert.equal(first.targets.size, 1);
});

test('fold: re-registration with a matching repoPath REVIVES the original id — never re-minted on a name change', () => {
  const originalId = 'tgt-abcd2345';
  const result = fold([
    makeEvent('cli', 'notes', 'target.registered', {
      targetId: originalId, name: 'notes', repoPath: '/repos/notes', manifestHash: 'h1', defaultBranch: 'main',
    }, '2026-01-01T00:00:00Z'),
    // Renamed + a (wrongly) freshly minted id on the re-registration: repoPath is the
    // stable identity key, so the fold must keep the ORIGINAL id and just update the name.
    makeEvent('cli', 'scratch', 'target.registered', {
      targetId: 'tgt-zzzz2345', name: 'scratch', repoPath: '/repos/notes', manifestHash: 'h2', defaultBranch: 'main',
    }, '2026-01-02T00:00:00Z'),
  ]);
  assert.equal(result.targets.size, 1, 'one repoPath = one identity, never fragmented');
  const rec = result.targets.byId(originalId);
  assert.ok(rec, 'the original id survives the rename');
  assert.equal(rec.name, 'scratch', 'the display name follows the latest registration');
  assert.equal(rec.manifestHash, 'h2');
  assert.equal(result.targets.byId('tgt-zzzz2345'), undefined, 'the re-minted id is discarded');
});

test('fold: legacy re-registration (no ids at all) converges on one fallback id via repoPath', () => {
  const result = fold([
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: '/repos/notes', manifestHash: 'h1', defaultBranch: 'main',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'renamed', 'target.registered', {
      name: 'renamed', repoPath: '/repos/notes', manifestHash: 'h2', defaultBranch: 'main',
    }, '2026-01-02T00:00:00Z'),
  ]);
  assert.equal(result.targets.size, 1);
  assert.equal(result.targets.byName('renamed')?.targetId, fallbackTargetId('/repos/notes'));
});

test('fold: target.manifest-updated resolves by stamped targetId (name may have drifted)', () => {
  const id = 'tgt-abcd2345';
  const result = fold([
    makeEvent('cli', 'notes', 'target.registered', {
      targetId: id, name: 'notes', repoPath: '/repos/notes', manifestHash: 'h1', defaultBranch: 'main',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('dispatch', 'notes', 'target.manifest-updated', {
      targetId: id, name: 'whatever', manifestHash: 'h2',
    }, '2026-01-02T00:00:00Z'),
  ]);
  assert.equal(result.targets.byId(id)?.manifestHash, 'h2');
});

// ---------------------------------------------------------------------------
// Item stamping + null-target coalescing
// ---------------------------------------------------------------------------

const REG_A = () => makeEvent('cli', 'notes', 'target.registered', {
  targetId: 'tgt-aaaa2345', name: 'notes', repoPath: '/repos/notes', manifestHash: 'h', defaultBranch: 'main',
}, '2026-01-01T00:00:00Z');
const REG_B = () => makeEvent('cli', 'docs', 'target.registered', {
  targetId: 'tgt-bbbb2345', name: 'docs', repoPath: '/repos/docs', manifestHash: 'h', defaultBranch: 'main',
}, '2026-01-01T00:00:30Z');

test('fold: an explicit item targetId stamp wins; a name-only capture resolves via the registry', () => {
  const result = fold([
    REG_A(),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'stamped', target: 'notes', targetId: 'tgt-aaaa2345' }, '2026-01-01T00:01:00Z'),
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'name-only legacy', target: 'notes' }, '2026-01-01T00:02:00Z'),
  ]);
  assert.equal(result.items.get('WI-001')?.targetId, 'tgt-aaaa2345');
  assert.equal(result.items.get('WI-002')?.targetId, 'tgt-aaaa2345', 'name-only captures resolve to the registered id');
});

test('fold: unstamped items coalesce to the configured defaultTarget (name resolved to id), routing field untouched', () => {
  const result = fold([
    REG_A(), REG_B(),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'unstamped' }, '2026-01-01T00:01:00Z'),
  ], { defaultTarget: 'notes' });
  const rec = result.items.get('WI-001')!;
  assert.equal(rec.targetId, 'tgt-aaaa2345', 'defaultTarget name resolves to the registered id');
  assert.equal(rec.target, undefined, 'coalescing is identity-only — the routing name field stays unstamped');
});

test('fold: with NO registrations, defaultTarget is used verbatim (legacy-ledger parity path)', () => {
  const result = fold([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'embedded legacy' }),
  ], { defaultTarget: 'plane' });
  assert.equal(result.items.get('WI-001')?.targetId, 'plane');
});

test('fold: sole registered target is inferred for unstamped items when no default is configured', () => {
  const result = fold([
    REG_A(),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'unstamped' }, '2026-01-01T00:01:00Z'),
  ]);
  assert.equal(result.items.get('WI-001')?.targetId, 'tgt-aaaa2345');
  assert.equal(result.items.get('WI-001')?.target, undefined, 'routing field untouched by inference');
});

test('fold: ambiguous multi-target ledger with no default leaves unstamped items unstamped', () => {
  const result = fold([
    REG_A(), REG_B(),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'ambiguous' }, '2026-01-01T00:01:00Z'),
  ]);
  assert.equal(result.items.get('WI-001')?.targetId, undefined);
});

test('fold: a ledger with no targets and no default coalesces nothing (embedded byte-identical)', () => {
  const result = fold([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'legacy' }),
  ]);
  assert.equal(result.items.get('WI-001')?.targetId, undefined);
  assert.equal(result.items.get('WI-001')?.target, undefined);
});

// ---------------------------------------------------------------------------
// Worktree namespacing per target
// ---------------------------------------------------------------------------

test('targetWorktreeDirName: includes the targetId; same-name different-repo targets get distinct paths', () => {
  // Two targets that share a display name, a parent dir shape, and the default prefix —
  // the exact clobber class the id namespacing closes. Registered legacy-style (no stamped
  // ids) to prove the synthesized fallbacks alone keep them apart.
  const result = fold([
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: '/work/a/notes', manifestHash: 'h', defaultBranch: 'main',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'notes', 'target.registered', {
      name: 'notes', repoPath: '/work/b/notes', manifestHash: 'h', defaultBranch: 'main',
    }, '2026-01-01T00:00:30Z'),
  ]);
  assert.equal(result.targets.size, 2, 'same name, different repoPath = two identities');
  const [t1, t2] = [...result.targets.values()];
  const dir1 = targetWorktreeDirName('loop-', t1.targetId, '001', 1);
  const dir2 = targetWorktreeDirName('loop-', t2.targetId, '001', 1);
  assert.ok(dir1.includes(t1.targetId), 'worktree dir carries the targetId');
  assert.notEqual(dir1, dir2, 'sibling same-name targets can never clobber each other');
  assert.match(dir1, /^loop-tgt-[a-z2-7]{8}-wi-001-a1$/);
});

// ---------------------------------------------------------------------------
// captureIntent stamps the identity
// ---------------------------------------------------------------------------

test('captureIntent: stamps targetId alongside the display name on item.captured', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-id-capture-'));
  const ledgerDir = join(base, 'ledger');
  try {
    await appendEvents(ledgerDir, [REG_A()]);
    const res = await captureIntent(ledgerDir, { text: 'add a helper' });
    assert.equal(res.target, 'notes');
    assert.equal(res.targetId, 'tgt-aaaa2345');
    const events = await loadAllEvents(ledgerDir);
    const cap = events.find(e => e.type === 'item.captured')!;
    const d = cap.data as { target?: string; targetId?: string };
    assert.equal(d.target, 'notes', 'name kept alongside for display/back-compat');
    assert.equal(d.targetId, 'tgt-aaaa2345', 'the identity stamp is the id');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('captureIntent: --target accepts the stable id as well as the name', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-id-capture-by-id-'));
  const ledgerDir = join(base, 'ledger');
  try {
    await appendEvents(ledgerDir, [REG_A(), REG_B()]);
    const res = await captureIntent(ledgerDir, { text: 'x', target: 'tgt-bbbb2345' });
    assert.equal(res.target, 'docs');
    assert.equal(res.targetId, 'tgt-bbbb2345');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
