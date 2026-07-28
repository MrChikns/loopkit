/**
 * Real browser fixture for Playwright.
 *
 * This starts the same console server used by the HTTP suite over the shared synthetic
 * ledger fixture. It deliberately adds no test-only route or renderer: Playwright talks to
 * the production GET surface, backed by a real append-only ledger in a disposable directory.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvents, makeEvent } from '@loopkit/core';

import { startConsole } from '../src/server.js';
import { sampleLedger } from './fixtures.js';

const ledgerDir = await mkdtemp(join(tmpdir(), 'loopkit-browser-ledger-'));
const runsDir = join(ledgerDir, 'runs');
const port = Number(process.env.LOOPKIT_BROWSER_PORT ?? 4173);

await appendEvents(ledgerDir, [
  ...sampleLedger(),
  makeEvent(
    'connector',
    'WI-006',
    'item.captured',
    {
      source: 'ext:EXT-42',
      text: 'check the browser gate',
      externalRef: 'EXT-42',
    },
    '2026-07-01T13:00:00.000Z',
  ),
  makeEvent(
    'reactor',
    'WI-006',
    'msg.out',
    { text: 'Browser gate queued.' },
    '2026-07-01T13:01:00.000Z',
  ),
]);

const handle = await startConsole({
  ledgerDir,
  runsDir,
  host: '127.0.0.1',
  port,
  skipCheckoutDriftCheck: true,
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close();
  await rm(ledgerDir, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}

process.once('uncaughtException', (error) => {
  console.error(error);
  void close().finally(() => process.exit(1));
});

process.once('unhandledRejection', (error) => {
  console.error(error);
  void close().finally(() => process.exit(1));
});
