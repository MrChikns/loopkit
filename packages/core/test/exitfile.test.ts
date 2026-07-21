/**
 * exitfile.test.ts — the detached-build exit-file protocol.
 *
 * Covers the two load-bearing invariants: atomic tmp+rename write (no torn file ever observed)
 * and graceful read (never throws; null on absent/empty/partial/malformed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeExitFile, readExitFile, exitFileExists, exitFilePresent,
  exitFilePath, exitFileName, usageJsonName,
} from '../src/exitfile.js';

let n = 0;
function freshDir(): string {
  const dir = join(tmpdir(), `loopkit-exitfile-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('exitfile: path shape is <WI>-a<N>.exit / <WI>-a<N>.usage.json', () => {
  assert.equal(exitFileName('WI-318', 2), 'WI-318-a2.exit');
  assert.equal(usageJsonName('WI-318', 2), 'WI-318-a2.usage.json');
});

test('exitfile: write then read round-trips the record', () => {
  const dir = freshDir();
  try {
    writeExitFile(dir, 'WI-318', 1, { exitCode: 0, usageJsonPath: '/x/WI-318-a1.usage.json' });
    const rec = readExitFile(dir, 'WI-318', 1);
    assert.ok(rec);
    assert.equal(rec!.exitCode, 0);
    assert.equal(rec!.usageJsonPath, '/x/WI-318-a1.usage.json');
    assert.equal(exitFileExists(dir, 'WI-318', 1), true);
    assert.equal(exitFilePresent(dir, 'WI-318', 1), true);
  } finally { cleanup(dir); }
});

test('exitfile: authFailure round-trips true when set, and is absent (not false) when unset', () => {
  const dir = freshDir();
  try {
    writeExitFile(dir, 'WI-320', 1, { exitCode: 0, authFailure: true });
    const rec = readExitFile(dir, 'WI-320', 1);
    assert.ok(rec);
    assert.equal(rec!.authFailure, true);

    writeExitFile(dir, 'WI-321', 1, { exitCode: 1 });
    const rec2 = readExitFile(dir, 'WI-321', 1);
    assert.ok(rec2);
    assert.equal(rec2!.authFailure, undefined, 'a generic (non-auth) failure must not carry authFailure at all');
  } finally { cleanup(dir); }
});

test('exitfile: a non-true authFailure value in the raw JSON is ignored, not coerced', () => {
  const dir = freshDir();
  try {
    writeFileSync(exitFilePath(dir, 'WI-322', 1), JSON.stringify({ exitCode: 1, authFailure: 'yes' }), 'utf8');
    const rec = readExitFile(dir, 'WI-322', 1);
    assert.ok(rec);
    assert.equal(rec!.authFailure, undefined, 'only a literal boolean true is honored');
  } finally { cleanup(dir); }
});

test('exitfile: a signalled worker (exitCode null) round-trips as null, not missing', () => {
  const dir = freshDir();
  try {
    writeExitFile(dir, 'WI-1', 3, { exitCode: null });
    const rec = readExitFile(dir, 'WI-1', 3);
    assert.ok(rec);
    assert.equal(rec!.exitCode, null);
    assert.equal(rec!.usageJsonPath, undefined);
  } finally { cleanup(dir); }
});

test('exitfile: read of an absent file is null and never throws', () => {
  const dir = freshDir();
  try {
    assert.equal(readExitFile(dir, 'WI-999', 1), null);
    assert.equal(exitFileExists(dir, 'WI-999', 1), false);
    assert.equal(exitFilePresent(dir, 'WI-999', 1), false);
  } finally { cleanup(dir); }
});

test('exitfile: a partial/torn write (raw byte caught mid-rename) reads as null, not a crash', () => {
  const dir = freshDir();
  try {
    // Simulate a reader catching the file mid-write: a truncated JSON prefix on the FINAL path.
    writeFileSync(exitFilePath(dir, 'WI-2', 1), '{"exitCode":0,"usageJ', 'utf8');
    // Graceful: parse fails → null (defer one cycle), the doctor's grace covers it.
    assert.equal(readExitFile(dir, 'WI-2', 1), null);
    // But the path DOES exist — exitFilePresent distinguishes "started writing" from "absent".
    assert.equal(exitFilePresent(dir, 'WI-2', 1), true);
    assert.equal(exitFileExists(dir, 'WI-2', 1), false); // not a complete record yet
  } finally { cleanup(dir); }
});

test('exitfile: empty file reads as null (rename not yet landed)', () => {
  const dir = freshDir();
  try {
    writeFileSync(exitFilePath(dir, 'WI-3', 1), '', 'utf8');
    assert.equal(readExitFile(dir, 'WI-3', 1), null);
  } finally { cleanup(dir); }
});

test('exitfile: an object missing exitCode is treated as not-collectable', () => {
  const dir = freshDir();
  try {
    writeFileSync(exitFilePath(dir, 'WI-4', 1), JSON.stringify({ usageJsonPath: '/x' }), 'utf8');
    assert.equal(readExitFile(dir, 'WI-4', 1), null);
  } finally { cleanup(dir); }
});

test('exitfile: a non-object payload (array / string) reads as null', () => {
  const dir = freshDir();
  try {
    writeFileSync(exitFilePath(dir, 'WI-5', 1), JSON.stringify([1, 2, 3]), 'utf8');
    assert.equal(readExitFile(dir, 'WI-5', 1), null);
    writeFileSync(exitFilePath(dir, 'WI-6', 1), JSON.stringify('nope'), 'utf8');
    assert.equal(readExitFile(dir, 'WI-6', 1), null);
  } finally { cleanup(dir); }
});

test('exitfile: atomic write leaves no lingering .tmp sidecar on success', () => {
  const dir = freshDir();
  try {
    writeExitFile(dir, 'WI-7', 1, { exitCode: 0 });
    const leftovers = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, 'tmp file must be renamed away, never left behind');
    assert.ok(existsSync(exitFilePath(dir, 'WI-7', 1)));
  } finally { cleanup(dir); }
});

test('exitfile: writing to an unwritable dir is best-effort (never throws)', () => {
  // A non-existent runs dir (RO / vanished) must not crash a worker mid-teardown; the missing
  // exit file simply looks like a still-running build to the collector (safe failure direction).
  const missing = join(tmpdir(), `loopkit-exitfile-nope-${process.pid}-${Date.now()}`, 'sub');
  assert.doesNotThrow(() => writeExitFile(missing, 'WI-8', 1, { exitCode: 0 }));
  assert.equal(readExitFile(missing, 'WI-8', 1), null);
});
