/**
 * run-controls.test.ts — the Missions per-state run-control verb set (console parity gap
 * 2/13): stop / hold / resume / requeue / escalate / dismiss. Mirrors server.test.ts's
 * approve/reject/accept POST tests: a real console bound to an ephemeral port, over a real
 * on-disk ledger seeded with `sampleLedger()` (+ a few extra events per test, for the
 * held/ops-parked states the fixture doesn't already carry).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvents, loadAllEvents, fold, makeEvent } from '@loopkit/core';

import { startConsole, ConsoleHandle } from '../src/server.js';
import { sampleLedger } from './fixtures.js';

async function withLedger<T>(fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-run-controls-'));
  try {
    await appendEvents(dir, sampleLedger());
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withServer<T>(
  ledgerDir: string,
  fn: (base: string, handle: ConsoleHandle) => Promise<T>,
  runsDir: string = join(ledgerDir, 'runs'),
): Promise<T> {
  const handle = await startConsole({ ledgerDir, port: 0, runsDir });
  try {
    return await fn(`http://127.0.0.1:${handle.port}`, handle);
  } finally {
    await handle.close();
  }
}

function sameOriginHeaders(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: base,
    ...extra,
  };
}

// sampleLedger(): WI-001 queued, WI-002 building, WI-003 parked(decision), WI-004 merged,
// WI-005 accepted (terminal) — see fixtures.ts.

test('POST /item/<id>/stop — a building item gets build.cancel-requested and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-002/stop`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/missions');

      const events = await loadAllEvents(ledgerDir);
      const cancelled = events.filter((e) => e.item === 'WI-002' && e.type === 'build.cancel-requested');
      assert.equal(cancelled.length, 1);
      assert.deepEqual(cancelled[0]?.data, { attempt: 1, by: 'operator' });
    }),
  );
});

test('POST /item/<id>/stop — a non-building item gets a 409 error page, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      // WI-001 is queued — stop applies to building items only.
      const res = await fetch(`${base}/item/WI-001/stop`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
      });
      assert.equal(res.status, 409);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(events.filter((e) => e.type === 'build.cancel-requested').length, 0);
    }),
  );
});

test('POST /item/<id>/hold — a queued item is parked (parkKind hold) and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-001/hold`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      const result = fold(events);
      const rec = result.items.get('WI-001');
      assert.equal(rec?.state, 'parked');
      assert.equal(rec?.parkKind, 'hold');
    }),
  );
});

test('POST /item/<id>/hold — a non-queued item gets a 409 error page, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      // WI-002 is building — hold applies to queued items only.
      const res = await fetch(`${base}/item/WI-002/hold`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
      });
      assert.equal(res.status, 409);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(events.filter((e) => e.item === 'WI-002' && e.type === 'item.parked').length, 0);
    }),
  );
});

test('POST /item/<id>/resume — a held item unparks back to queued and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      await appendEvents(ledgerDir, [
        makeEvent('cli', 'WI-001', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }),
      ]);
      const res = await fetch(`${base}/item/WI-001/resume`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(fold(events).items.get('WI-001')?.state, 'queued');
    }),
  );
});

test('POST /item/<id>/resume — an ops-parked item gets a 409 error page (resume applies to held only)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      await appendEvents(ledgerDir, [
        makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }),
      ]);
      const res = await fetch(`${base}/item/WI-001/resume`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
      });
      assert.equal(res.status, 409);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(events.filter((e) => e.type === 'item.unparked').length, 0);
    }),
  );
});

test('POST /item/<id>/requeue — an ops-parked item unparks back to queued and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      await appendEvents(ledgerDir, [
        makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }),
      ]);
      const res = await fetch(`${base}/item/WI-001/requeue`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(fold(events).items.get('WI-001')?.state, 'queued');
    }),
  );
});

test('POST /item/<id>/requeue — a held item gets a 409 error page (requeue applies to ops-parks only)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      await appendEvents(ledgerDir, [
        makeEvent('cli', 'WI-001', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }),
      ]);
      const res = await fetch(`${base}/item/WI-001/requeue`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
      });
      assert.equal(res.status, 409);
    }),
  );
});

test('POST /item/<id>/escalate — a building item is flagged without leaving building, redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-002/escalate`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(events.filter((e) => e.item === 'WI-002' && e.type === 'item.escalated').length, 1);
      const result = fold(events);
      assert.equal(result.items.get('WI-002')?.state, 'building');
      assert.ok(result.items.get('WI-002')?.escalatedAt);
    }),
  );
});

test('POST /item/<id>/escalate — a merged item gets a 409 error page, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-004/escalate`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
      });
      assert.equal(res.status, 409);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(events.filter((e) => e.type === 'item.escalated').length, 0);
    }),
  );
});

test('POST /item/<id>/dismiss — an ops-parked item is rejected (terminal) and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      await appendEvents(ledgerDir, [
        makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }),
      ]);
      const res = await fetch(`${base}/item/WI-001/dismiss`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      const rejected = events.filter((e) => e.item === 'WI-001' && e.type === 'item.rejected');
      assert.equal(rejected.length, 1);
      assert.equal(fold(events).items.get('WI-001')?.state, 'rejected');
    }),
  );
});

test('POST /item/<id>/dismiss — a decision-parked item gets a 409 error page (dismiss applies to ops-parks only)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      // WI-003 is parked with parkKind 'decision' — dismiss/requeue/resume are all ops/held-only.
      const res = await fetch(`${base}/item/WI-003/dismiss`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
      });
      assert.equal(res.status, 409);

      const events = await loadAllEvents(ledgerDir);
      assert.equal(events.filter((e) => e.item === 'WI-003' && e.type === 'item.rejected').length, 0);
    }),
  );
});
