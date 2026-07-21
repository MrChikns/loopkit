// reality-check.test.ts: git reality-check helpers. alreadyShippedCommit must recognise a merged
// feature commit tagged `(WI-NNN)` while IGNORING ledger-residue commits that also mention the
// WI, so an already-shipped item is retired instead of being requeued forever.
// branchCommitsAheadOfMaster detects the died-post-commit class (committed locally, never merged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { alreadyShippedCommit, branchCommitsAheadOfMaster } from '../src/reality-check.js';

function tempRepo(): { dir: string; g: (args: string[]) => void } {
  const dir = join(tmpdir(), `reality-check-${process.pid}-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  const g = (args: string[]) => { spawnSync('git', args, { cwd: dir, stdio: 'pipe' }); };
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  return { dir, g };
}

function commitFile(g: (a: string[]) => void, dir: string, file: string, content: string, msg: string): void {
  const full = join(dir, file);
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  g(['add', file]);
  g(['commit', '-m', msg]);
}

test('alreadyShippedCommit: finds a merged feature commit tagged (WI-NNN)', () => {
  const { dir, g } = tempRepo();
  try {
    commitFile(g, dir, 'src/feature.ts', 'export const x = 1;', 'feat(ui): the thing (WI-355)');
    const sha = alreadyShippedCommit(dir, 'WI-355');
    assert.ok(sha && sha.length >= 7, `expected a shipping commit SHA, got ${sha}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alreadyShippedCommit: IGNORES a ledger-residue commit that mentions the WI', () => {
  const { dir, g } = tempRepo();
  try {
    // Only a ledger-residue commit references WI-999 — no feature ever shipped.
    commitFile(g, dir, '.ai/ledger/work.jsonl', '{"id":"ev-1"}', 'chore(ledger): reactor residue (WI-999)');
    const sha = alreadyShippedCommit(dir, 'WI-999');
    assert.equal(sha, null, 'a ledger-only residue commit must NOT count as shipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alreadyShippedCommit: prefers the feature commit even when residue also references the WI', () => {
  const { dir, g } = tempRepo();
  try {
    commitFile(g, dir, 'src/f.ts', 'export const y = 2;', 'fix(app): real work (WI-360)');
    commitFile(g, dir, '.ai/ledger/work.jsonl', '{"id":"ev-2"}', 'chore(ledger): dispatch residue (WI-360)');
    const sha = alreadyShippedCommit(dir, 'WI-360');
    assert.ok(sha && sha.length >= 7, 'must return the feature commit, not treat the item as unshipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alreadyShippedCommit: null for an unshipped WI and for a malformed id', () => {
  const { dir } = tempRepo();
  try {
    assert.equal(alreadyShippedCommit(dir, 'WI-404'), null);
    assert.equal(alreadyShippedCommit(dir, 'not-a-wi'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branchCommitsAheadOfMaster: counts commits a build branch holds ahead of master (died-post-commit)', () => {
  const { dir, g } = tempRepo();
  try {
    g(['checkout', '-b', 'wi-361-a1']);
    commitFile(g, dir, 'src/done.ts', 'export const done = true;', 'feat: committed but never merged (WI-361)');
    assert.equal(branchCommitsAheadOfMaster(dir, 'wi-361-a1'), 1);
    assert.equal(branchCommitsAheadOfMaster(dir, 'master'), 0);
    assert.equal(branchCommitsAheadOfMaster(dir, 'no-such-branch'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
