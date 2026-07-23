/**
 * checkout-drift.test.ts — Class-9 hardening (docs/hardening-audit.md): several routes read
 * CSS/JS straight off the on-disk checkout at request time (no dist/copy step exists for
 * them), so a checkout whose HEAD has fallen behind its own upstream would silently keep
 * serving stale assets forever, even with the compiled server code fully current. `startConsole`
 * now refuses to boot in that state. All git setup here is local (a bare repo standing in for
 * "origin" plus a second clone standing in for "someone else's push") — no network involved.
 *
 * WI-105: "ahead of origin" (unpushed local commits on top of an up-to-date upstream) is a
 * healthy pre-push state — the on-disk assets are newer than origin, never stale — so it must
 * boot fine, not just the in-sync and behind/diverged cases. `skipCheckoutDriftCheck` is the
 * explicit bypass for tests that want to opt out of the guard entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync as rmSyncFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendEvents } from '@loopkit/core';

import { startConsole } from '../src/server.js';
import { sampleLedger } from './fixtures.js';

function run(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr?.toString()}`);
  }
}

function configUser(root: string): void {
  run(root, 'config', 'user.email', 'test@example.com');
  run(root, 'config', 'user.name', 'test');
}

function initRepo(root: string): void {
  run(root, 'init', '-q', '-b', 'main');
  configUser(root);
}

async function withLedgerAndDirs<T>(
  fn: (ledgerDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-drift-test-'));
  try {
    await appendEvents(dir, sampleLedger());
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('startConsole: boots fine when checkoutDir has no git repo at all', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const checkoutDir = await mkdtemp(join(tmpdir(), 'loopkit-console-drift-nogit-'));
    try {
      const handle = await startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), checkoutDir });
      await handle.close();
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });
});

test('startConsole: boots fine when the checkout has no upstream configured', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const checkoutDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-noupstream-'));
    try {
      initRepo(checkoutDir);
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'root');
      const handle = await startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), checkoutDir });
      await handle.close();
    } finally {
      rmSyncFs(checkoutDir, { recursive: true, force: true });
    }
  });
});

test('startConsole: boots fine when the checkout is in sync with its upstream', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const originDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-origin-'));
    const checkoutDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-insync-'));
    try {
      run(originDir, 'init', '-q', '--bare');

      initRepo(checkoutDir);
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'root');
      run(checkoutDir, 'remote', 'add', 'origin', originDir);
      run(checkoutDir, 'push', '-q', '-u', 'origin', 'main');

      const handle = await startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), checkoutDir });
      await handle.close();
    } finally {
      rmSyncFs(originDir, { recursive: true, force: true });
      rmSyncFs(checkoutDir, { recursive: true, force: true });
    }
  });
});

test('startConsole: refuses to boot when the checkout has fallen behind its upstream', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const originDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-origin-'));
    const checkoutDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-stale-'));
    const otherPusherDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-pusher-'));
    try {
      run(originDir, 'init', '-q', '--bare', '-b', 'main');

      initRepo(checkoutDir);
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'root');
      run(checkoutDir, 'remote', 'add', 'origin', originDir);
      run(checkoutDir, 'push', '-q', '-u', 'origin', 'main');

      // A second clone stands in for "someone else merged to origin" — pushes a new commit
      // that `checkoutDir` never pulls. Cloning an already-pushed-to bare repo checks out
      // `main` (matching its HEAD symref) with tracking already configured.
      rmSyncFs(otherPusherDir, { recursive: true, force: true });
      run(tmpdir(), 'clone', '-q', originDir, otherPusherDir);
      configUser(otherPusherDir);
      run(otherPusherDir, 'commit', '--allow-empty', '-q', '-m', 'a later merge');
      run(otherPusherDir, 'push', '-q', 'origin', 'main');

      // `checkoutDir` fetches (so it *knows* origin moved, the same as any background fetch
      // cadence would produce) but never merges/pulls — HEAD stays behind refs/remotes/origin/main.
      run(checkoutDir, 'fetch', '-q', 'origin');

      await assert.rejects(
        () => startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), checkoutDir }),
        /does not match its upstream/,
      );
    } finally {
      rmSyncFs(originDir, { recursive: true, force: true });
      rmSyncFs(checkoutDir, { recursive: true, force: true });
      rmSyncFs(otherPusherDir, { recursive: true, force: true });
    }
  });
});

test('startConsole: boots fine when the checkout is ahead of its upstream (unpushed local commits)', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const originDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-origin-'));
    const checkoutDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-ahead-'));
    try {
      run(originDir, 'init', '-q', '--bare', '-b', 'main');

      initRepo(checkoutDir);
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'root');
      run(checkoutDir, 'remote', 'add', 'origin', originDir);
      run(checkoutDir, 'push', '-q', '-u', 'origin', 'main');

      // Local commit(s) never pushed — the healthy "mid fast-drain, about to push" state this
      // guard must not block (WI-105 was filed because it did).
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'unpushed local work');
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'more unpushed local work');

      const handle = await startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), checkoutDir });
      await handle.close();
    } finally {
      rmSyncFs(originDir, { recursive: true, force: true });
      rmSyncFs(checkoutDir, { recursive: true, force: true });
    }
  });
});

test('startConsole: refuses to boot when the checkout has diverged from its upstream', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const originDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-origin-'));
    const checkoutDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-diverged-'));
    const otherPusherDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-pusher-'));
    try {
      run(originDir, 'init', '-q', '--bare', '-b', 'main');

      initRepo(checkoutDir);
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'root');
      run(checkoutDir, 'remote', 'add', 'origin', originDir);
      run(checkoutDir, 'push', '-q', '-u', 'origin', 'main');

      // Someone else pushes a commit checkoutDir never sees...
      rmSyncFs(otherPusherDir, { recursive: true, force: true });
      run(tmpdir(), 'clone', '-q', originDir, otherPusherDir);
      configUser(otherPusherDir);
      run(otherPusherDir, 'commit', '--allow-empty', '-q', '-m', 'a later merge');
      run(otherPusherDir, 'push', '-q', 'origin', 'main');

      // ...while checkoutDir ALSO makes its own unpushed local commit — HEAD and the
      // (fetched) upstream ref now share a common ancestor but neither is an ancestor of the
      // other: genuinely diverged, not merely ahead. Must still block.
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'unpushed local work');
      run(checkoutDir, 'fetch', '-q', 'origin');

      await assert.rejects(
        () => startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), checkoutDir }),
        /does not match its upstream/,
      );
    } finally {
      rmSyncFs(originDir, { recursive: true, force: true });
      rmSyncFs(checkoutDir, { recursive: true, force: true });
      rmSyncFs(otherPusherDir, { recursive: true, force: true });
    }
  });
});

test('startConsole: skipCheckoutDriftCheck bypasses the guard even when behind upstream', async () => {
  await withLedgerAndDirs(async (ledgerDir) => {
    const originDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-origin-'));
    const checkoutDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-skip-'));
    const otherPusherDir = mkdtempSync(join(tmpdir(), 'loopkit-console-drift-pusher-'));
    try {
      run(originDir, 'init', '-q', '--bare', '-b', 'main');

      initRepo(checkoutDir);
      run(checkoutDir, 'commit', '--allow-empty', '-q', '-m', 'root');
      run(checkoutDir, 'remote', 'add', 'origin', originDir);
      run(checkoutDir, 'push', '-q', '-u', 'origin', 'main');

      rmSyncFs(otherPusherDir, { recursive: true, force: true });
      run(tmpdir(), 'clone', '-q', originDir, otherPusherDir);
      configUser(otherPusherDir);
      run(otherPusherDir, 'commit', '--allow-empty', '-q', '-m', 'a later merge');
      run(otherPusherDir, 'push', '-q', 'origin', 'main');

      run(checkoutDir, 'fetch', '-q', 'origin'); // behind upstream — would normally block

      const handle = await startConsole({
        ledgerDir,
        port: 0,
        runsDir: join(ledgerDir, 'runs'),
        checkoutDir,
        skipCheckoutDriftCheck: true,
      });
      await handle.close();
    } finally {
      rmSyncFs(originDir, { recursive: true, force: true });
      rmSyncFs(checkoutDir, { recursive: true, force: true });
      rmSyncFs(otherPusherDir, { recursive: true, force: true });
    }
  });
});
