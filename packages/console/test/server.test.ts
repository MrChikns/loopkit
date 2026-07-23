/**
 * server.test.ts — end-to-end HTTP tests: the server starts on an ephemeral port, serves
 * each of the six views against a real on-disk ledger (written via core's appendEvents),
 * serves its static + design-system CSS assets, redirects the two retired routes, and 404s an
 * unknown route. Also proves the reshell's cross-cutting invariants (sidebar+topbar render on
 * every route, zero inline `<script>` anywhere, every verb POST works with no client JS).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { request as httpRequest } from 'node:http';

import { appendEvents, loadAllEvents, fold, makeEvent } from '@loopkit/core';

import { startConsole, ConsoleHandle } from '../src/server.js';
import { sampleLedger, tieredMergeLedger, recentGlanceLedger } from './fixtures.js';

async function withLedger<T>(fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-test-'));
  try {
    await appendEvents(dir, sampleLedger());
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Raw POST with full header control — fetch (undici) silently overrides the `host` header
 * with the connection host, so Host-spoofing tests (rebinding, reverse-proxy) must use
 * node:http directly.
 */
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * `runsDir` defaults to a sibling of `ledgerDir` (a fresh mkdtemp per test, never created
 * unless a test writes to it) rather than letting startConsole fall back to
 * `resolvePlaneHome`'s real `~/.loopkit` — otherwise every test in this file would read
 * whatever's in the machine's actual plane-home runs directory. Pass `runsDir` explicitly to
 * exercise the build-artifact browser against fixture files.
 */
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

test('startConsole: binds to an ephemeral port when port is 0', async () => {
  await withLedger(async (ledgerDir) => {
    await withServer(ledgerDir, async (_base, handle) => {
      assert.ok(handle.port > 0);
    });
  });
});

test('GET / — redirects to /command', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/command');
    }),
  );
});

test('GET /command — renders 200 with the Command marker', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Command/);
      assert.match(body, /WI-003/); // decision park on the decision desk
    }),
  );
});

// Recent work items strip (opsui shell) — WI-053 phase-3: a standalone-plane capture
// (loopctl new / console intent) never carries an `externalRef` (that's a legacy
// externally-captured source ref), so the strip must render from ALL threads, not just
// ext-sourced ones, or it's permanently empty off-origin. The strip windows to the last
// 24h, so the fixture events are timestamped minutes-ago (render-time relative), same
// pattern as recentGlanceLedger.
test('GET /command — the opsui Recent work items strip renders threads without an externalRef', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
      // No externalRef anywhere; a plain msg.out reply is enough to make WI-902 a thread
      // (core's isThread = outs.length > 0 || externalRef) with no EXT in sight.
      await appendEvents(ledgerDir, [
        makeEvent('cli', 'WI-902', 'item.captured', { source: 'cli', text: 'an externalRef-less capture' }, ago(10)),
        makeEvent('reactor', 'WI-902', 'msg.out', { text: 'on it' }, ago(9)),
      ]);
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /opsui-intent-strip/);
      assert.match(body, /Recent work items/);
      assert.match(body, /opsui-intent-strip__item/);
      assert.match(body, /WI-902/);
    }),
  );
});

test('GET /command — the opsui Recent work items strip still shows the EXT chip + thread link when an externalRef is carried', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
      await appendEvents(ledgerDir, [
        makeEvent('cli', 'WI-903', 'item.captured', { source: 'ext:EXT-77', text: 'an ext-sourced capture', externalRef: 'EXT-77' }, ago(10)),
        makeEvent('reactor', 'WI-903', 'msg.out', { text: 'on it' }, ago(9)),
      ]);
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /opsui-intent-strip/);
      assert.match(body, /EXT-77/);
      assert.match(body, /href="\/threads\/EXT-77"/);
    }),
  );
});

test('GET /work — renders 200 with the Missions marker', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/work`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Missions/);
      assert.match(body, /WI-001/);
    }),
  );
});

// The four renamed console paths 301 to their canonical opsui routes so old bookmarks keep
// working — checked with redirect:'manual' so a passing test can never be a silent follow.
for (const [from, to] of [
  ['/missions', '/work'],
  ['/system', '/health'],
  ['/knowledge', '/company'],
  ['/analytics', '/observability'],
] as const) {
  test(`GET ${from} — 301s to ${to} (renamed route)`, async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}${from}`, { redirect: 'manual' });
        assert.equal(res.status, 301);
        assert.equal(res.headers.get('location'), to);
      }),
    );
  });
}

test('GET /item/<id> — item timeline renders 200 with the event trail', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-002`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /WI-002/);
      assert.match(body, /build\.dispatched/);
    }),
  );
});

test('GET /item/<unknown> — still 200, the item hub renders its empty (no-events) state', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-999`);
      assert.equal(res.status, 200);
      const body = await res.text();
      // The item hub renders the id with an empty ledger history rather than a
      // dedicated "no such item" page — a 200 that never 500s on an unknown id.
      assert.match(body, /WI-999/);
      assert.match(body, /no events/i);
    }),
  );
});

// ---------------------------------------------------------------------------
// Live tail (SSE) — /item/<id>/live
// ---------------------------------------------------------------------------

/** Read chunks off an SSE response body until `buffer` contains `marker`, or fail after
 *  `timeoutMs`. Returns the accumulated buffer so callers can assert on the payload. */
async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!buffer.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(marker)}; got: ${buffer}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${JSON.stringify(marker)}; got: ${buffer}`);
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

test('GET /item/<id>/live — SSE headers + connect comment, then forwards a new msg.out and closes', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const controller = new AbortController();
      const res = await fetch(`${base}/item/WI-002/live`, { signal: controller.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.ok(res.body);
      const reader = res.body!.getReader();

      await readSseUntil(reader, ': connected', 2000);

      // The plane's reply lands as a plain ledger append — reactor/dispatch never go through a
      // console verb, so the tail must pick up any actor's msg.out, not just console-authored
      // events.
      const before = await loadAllEvents(ledgerDir);
      await appendEvents(ledgerDir, [makeEvent('reactor', 'WI-002', 'msg.out', { text: 'on it' })]);

      const buffer = await readSseUntil(reader, 'event: reply', 3000);
      assert.match(buffer, /"text":"on it"/);

      // Read-only: the tail itself never appends to the ledger.
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length + 1);

      // Bounded: the server closes the connection right after forwarding the one reply, rather
      // than staying open for the full ~2min cap.
      const closed = await Promise.race([
        reader.read().then((r) => r.done === true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      assert.ok(closed, 'expected the SSE connection to close after forwarding the reply');

      controller.abort();
    }),
  );
});

test('GET /item/<id>/live — an id with no matching item still connects and stays open (bounded, never 500s)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const controller = new AbortController();
      const res = await fetch(`${base}/item/WI-999/live`, { signal: controller.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      const reader = res.body!.getReader();
      await readSseUntil(reader, ': connected', 2000);
      controller.abort();
    }),
  );
});

test('HEAD /item/<id>/live — not a route (SSE is GET-only)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-002/live`, { method: 'HEAD' });
      assert.equal(res.status, 404);
    }),
  );
});

test('GET /console-live.js — served with a JS content-type, references EventSource + captured', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/console-live.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
      const body = await res.text();
      assert.match(body, /EventSource/);
      assert.match(body, /captured/);
    }),
  );
});

test('GET /ui/live.js — served with a JS content-type, opens the item SSE tail on the captured banner', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/ui/live.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^application\/javascript/);
      const body = await res.text();
      // The live-reply client opens the server's SSE tail and hands off to the shell's
      // existing opsui:live-reply handler; it must reference all three to actually wire up.
      assert.match(body, /EventSource/);
      assert.match(body, /\/item\//);
      assert.match(body, /opsui:live-reply/);
      // Reads the captured item id off the standalone confirmation banner, not a bespoke marker.
      assert.match(body, /opsui-composer__captured/);
    }),
  );
});

test('GET /command — links the live-reply client so a fresh capture can upgrade to a live reply', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /<script src="\/ui\/live\.js" defer><\/script>/);
    }),
  );
});

// ---------------------------------------------------------------------------
// WI-053 — multi-target intent capture: the composer must offer a target
// selector when >1 target is registered (core captureIntent throws otherwise), and stamp
// the sole target unchanged when only one is registered.
// ---------------------------------------------------------------------------

/** sampleLedger + `n` registered targets (generic names — this is a public repo). */
function ledgerWithTargets(names: string[]): ReturnType<typeof sampleLedger> {
  return [
    ...sampleLedger(),
    ...names.map((name, i) =>
      makeEvent('cli', name, 'target.registered', {
        name,
        repoPath: `/repo/${name}`,
        manifestHash: String.fromCharCode(97 + i).repeat(40),
        defaultBranch: 'main',
      }, `2026-07-02T00:00:0${i}.000Z`),
    ),
  ];
}

async function withTargetLedger<T>(names: string[], fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-targets-'));
  try {
    await appendEvents(dir, ledgerWithTargets(names));
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('GET /command with >1 registered target — renders a required target <select> with every target name', async () => {
  await withTargetLedger(['acme-web', 'acme-api'], (ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /<select class="opsui-composer__target" name="target"[^>]*required>/);
      assert.match(body, /<option value="acme-web">acme-web<\/option>/);
      assert.match(body, /<option value="acme-api">acme-api<\/option>/);
      assert.match(body, /<option value="" disabled selected>choose a target…<\/option>/);
    }),
  );
});

test('GET /command with exactly one registered target — no target selector (server stamps the sole target)', async () => {
  await withTargetLedger(['acme-web'], (ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes('name="target"'), 'a single-target plane must not render a target selector');
    }),
  );
});

test('POST /intent with a chosen target — captures against that target, stamping name + targetId', async () => {
  await withTargetLedger(['acme-web', 'acme-api'], (ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ intent: 'targeted capture', target: 'acme-api', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const events = await loadAllEvents(ledgerDir);
      const captured = events.find((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'targeted capture');
      assert.ok(captured, 'the capture event was appended');
      assert.equal((captured!.data as { target?: string }).target, 'acme-api');
      assert.ok((captured!.data as { targetId?: string }).targetId, 'the stable targetId is stamped alongside the display name');
    }),
  );
});

test('POST /intent on a single-target plane with no target field — stamps the sole target unchanged', async () => {
  await withTargetLedger(['acme-web'], (ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ intent: 'sole-target capture', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const events = await loadAllEvents(ledgerDir);
      const captured = events.find((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'sole-target capture');
      assert.ok(captured, 'the capture event was appended');
      assert.equal((captured!.data as { target?: string }).target, 'acme-web');
    }),
  );
});

test('POST /intent with >1 target and no target field — surfaces the core "pass a target" error page', async () => {
  await withTargetLedger(['acme-web', 'acme-api'], (ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ intent: 'untargeted capture', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /pass a target to select one/);
      const events = await loadAllEvents(ledgerDir);
      assert.ok(!events.some((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'untargeted capture'));
    }),
  );
});

test('GET /needs-you — redirects to /command (retired route)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/needs-you`, { redirect: 'manual' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/command');
    }),
  );
});

test('GET /system — 301s to /health (renamed route; old bookmarks keep working)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/system`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/health');
    }),
  );
});

test('GET /health — renders 200 with the System marker (the SLO/health board)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = await res.text();
      // "System" survives as the sidebar destination label for the health board.
      assert.match(body, /System/);
    }),
  );
});

test('GET /activity — renders 200 with the newest ledger events across every item', async () => {
  // Phase-1 dual-shell note: /activity still renders through the OLD console shell
  // (renderActivity/views.ts) — the opsui cross-item view is /timeline (linked from /work).
  // The System→activity cross-link was dropped in the shell adoption; /activity is reached directly.
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/activity`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Activity/);
      assert.match(body, /item\.merged/);
      assert.match(body, /<a class="opsui-eventrow__metaitem opsui-eventrow__metaitem--link" href="\/item\/WI-004">WI-004<\/a>/);
    }),
  );
});

// ---------------------------------------------------------------------------
// Build-artifact browser: /system's "Recent artifacts", the item page's Evidence card,
// and the strictly path-validated /artifact download route.
// ---------------------------------------------------------------------------

/** Seeds a fixture runs directory with an untargeted-lane file and a target-namespaced one,
 *  plus a couple of non-artifact entries (a lock dir, a stray file) that must never surface. */
async function seedArtifacts(runsDir: string): Promise<void> {
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, 'WI-002-attempt-1.log'), 'build log for WI-002 attempt 1', 'utf8');
  const targetDir = join(runsDir, 'tgt-abcd2345');
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'WI-003-attempt-1.gate.log'), 'gate log for WI-003 attempt 1', 'utf8');
  // Never-artifact entries: a dispatch lock dir and a stray non-matching file, both must be
  // silently skipped by the scan rather than crashing it or leaking through.
  await mkdir(join(runsDir, 'dispatch.lock'), { recursive: true });
  await writeFile(join(runsDir, 'dispatch-auth-failed'), 'flag', 'utf8');
}

test('GET /health — the Recent artifacts region lists on-disk attempts as rows', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await seedArtifacts(runsDir);
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = await res.text();
      // The opsui markup's "Recent artifacts" card carries the count in a status
      // badge ("2 artifacts") and one compact eventrow per file. The inline `download` anchor
      // was dropped in the shell adoption — the strictly path-validated /artifact/<...> download
      // route (covered separately below) is the artifact-fetch contract, not this listing.
      assert.match(body, /Recent artifacts/);
      assert.match(body, /2 artifacts/);
      assert.match(body, /WI-002-attempt-1\.log/);
      assert.match(body, /WI-003-attempt-1\.gate\.log/);
    }, runsDir);
  });
});

test('GET /item/<id> — the Evidence card lists only that item\'s artifacts', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await seedArtifacts(runsDir);
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-002`);
      const body = await res.text();
      assert.match(body, /Evidence/);
      assert.match(body, /WI-002-attempt-1\.log/);
      assert.ok(!body.includes('WI-003-attempt-1.gate.log'));
    }, runsDir);
  });
});

test('GET /artifact/_/<file> — serves an untargeted-lane artifact as text/plain', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await seedArtifacts(runsDir);
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/artifact/_/WI-002-attempt-1.log`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(await res.text(), 'build log for WI-002 attempt 1');
    }, runsDir);
  });
});

test('GET /artifact/<targetId>/<file> — serves a target-namespaced artifact', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await seedArtifacts(runsDir);
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/artifact/tgt-abcd2345/WI-003-attempt-1.gate.log`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'gate log for WI-003 attempt 1');
    }, runsDir);
  });
});

test('GET /artifact — 404s a filename that does not match the WI-NNN-attempt-N.* convention', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await seedArtifacts(runsDir);
    await writeFile(join(runsDir, 'not-an-artifact.txt'), 'nope', 'utf8');
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/artifact/_/not-an-artifact.txt`);
      assert.equal(res.status, 404);
    }, runsDir);
  });
});

test('GET /artifact — 404s a malformed target segment, never reads outside the runs dir', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await seedArtifacts(runsDir);
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/artifact/not-a-target/WI-002-attempt-1.log`);
      assert.equal(res.status, 404);
    }, runsDir);
  });
});

test('GET /artifact — 404s a well-formed name that does not exist on disk', async () => {
  await withLedger(async (ledgerDir) => {
    const runsDir = join(ledgerDir, 'runs');
    await withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/artifact/_/WI-999-attempt-9.diff`);
      assert.equal(res.status, 404);
    }, runsDir);
  });
});

// ---------------------------------------------------------------------------
// Legacy-format attachment download: GET /attachment?id=<sourceId>&name=<file> (WI-055 item 2).
// Files live under LOOPKIT_UPLOADS_ROOT/<sourceId>/<file> — the same root+shape
// schema.ts's resolveAttachmentPaths reads for a build agent's prompt.
// ---------------------------------------------------------------------------

/** Runs `fn` with LOOPKIT_UPLOADS_ROOT pointed at a fresh temp dir seeded with one file under
 *  `<sourceId>/<name>`, restoring the env var afterward so this test can never leak into a
 *  sibling test or a real operator's `~/.loopkit/uploads`. */
async function withUploadsRoot<T>(
  sourceId: string,
  name: string,
  content: string,
  fn: (uploadsRoot: string) => Promise<T>,
): Promise<T> {
  const uploadsRoot = await mkdtemp(join(tmpdir(), 'loopkit-uploads-'));
  const saved = process.env['LOOPKIT_UPLOADS_ROOT'];
  process.env['LOOPKIT_UPLOADS_ROOT'] = uploadsRoot;
  try {
    await mkdir(join(uploadsRoot, sourceId), { recursive: true });
    await writeFile(join(uploadsRoot, sourceId, name), content);
    return await fn(uploadsRoot);
  } finally {
    if (saved !== undefined) process.env['LOOPKIT_UPLOADS_ROOT'] = saved;
    else delete process.env['LOOPKIT_UPLOADS_ROOT'];
    await rm(uploadsRoot, { recursive: true, force: true });
  }
}

test('GET /attachment — serves a legacy-format attachment from LOOPKIT_UPLOADS_ROOT/<id>/<name>', async () => {
  await withUploadsRoot('EXT-42', 'notes.txt', 'legacy attachment body', async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?id=EXT-42&name=notes.txt`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'legacy attachment body');
      }),
    );
  });
});

test('GET /attachment — infers content-type from the file extension (image/png)', async () => {
  await withUploadsRoot('EXT-42', 'screenshot.png', 'PNG-BYTES-HERE', async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?id=EXT-42&name=screenshot.png`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^image\/png/);
      }),
    );
  });
});

test('GET /attachment — an unrecognized extension serves as application/octet-stream', async () => {
  await withUploadsRoot('EXT-42', 'archive.bin', 'binary blob', async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?id=EXT-42&name=archive.bin`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^application\/octet-stream/);
      }),
    );
  });
});

test('GET /attachment — 404s when the file does not exist under the resolved source dir', async () => {
  await withUploadsRoot('EXT-42', 'notes.txt', 'body', async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?id=EXT-42&name=missing.txt`);
        assert.equal(res.status, 404);
      }),
    );
  });
});

test('GET /attachment — missing id or name 404s rather than throwing', async () => {
  await withUploadsRoot('EXT-42', 'notes.txt', 'body', async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const noId = await fetch(`${base}/attachment?name=notes.txt`);
        assert.equal(noId.status, 404);
        const noName = await fetch(`${base}/attachment?id=EXT-42`);
        assert.equal(noName.status, 404);
        const neither = await fetch(`${base}/attachment`);
        assert.equal(neither.status, 404);
      }),
    );
  });
});

test('GET /attachment — path traversal in `name` is refused, never escapes the source dir', async () => {
  await withUploadsRoot('EXT-42', 'notes.txt', 'body', async (uploadsRoot) => {
    // A secret file one level above the sourceId dir the route would otherwise resolve into.
    await writeFile(join(uploadsRoot, 'secret.txt'), 'do not serve me');
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?${new URLSearchParams({ id: 'EXT-42', name: '../secret.txt' }).toString()}`);
        assert.equal(res.status, 404);
      }),
    );
  });
});

test('GET /attachment — path traversal in `id` is refused, never escapes the uploads root', async () => {
  await withUploadsRoot('EXT-42', 'notes.txt', 'body', async (uploadsRoot) => {
    // A secret file one level above the uploads root the route would otherwise resolve into.
    await writeFile(join(dirname(uploadsRoot), 'secret.txt'), 'do not serve me');
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?${new URLSearchParams({ id: '../', name: 'secret.txt' }).toString()}`);
        assert.equal(res.status, 404);
      }),
    );
    await rm(join(dirname(uploadsRoot), 'secret.txt'), { force: true });
  });
});

test('GET /attachment — a bare "." id/name (blocked by the leading-dot guard) 404s, not a directory listing', async () => {
  await withUploadsRoot('EXT-42', 'notes.txt', 'body', async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}/attachment?${new URLSearchParams({ id: 'EXT-42', name: '.' }).toString()}`);
        assert.equal(res.status, 404);
      }),
    );
  });
});

test('GET /observability — renders 200 with the Analytics marker', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/observability`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Analytics/);
      // The observability board renders even on a fresh empty ledger — every widget
      // degrades to an intentional empty state rather than crashing.
      assert.match(body, /Quota utilization/);
      assert.match(body, /No quota snapshots yet/);
      assert.match(body, /Salvage activity/);
    }),
  );
});

test('GET /acceptance — renders 200 with tiered merged items, no config file needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-test-'));
  try {
    await appendEvents(dir, tieredMergeLedger());
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/acceptance`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Acceptance/);
      assert.match(body, /WI-101/);
      assert.match(body, /WI-104/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /item/<id>/accept from the acceptance desk — appends item.accepted and redirects to /acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-test-'));
  try {
    await appendEvents(dir, tieredMergeLedger());
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/item/WI-101/accept`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/acceptance' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/acceptance');

      const events = await loadAllEvents(dir);
      const accepted = events.filter((e) => e.item === 'WI-101' && e.type === 'item.accepted');
      assert.equal(accepted.length, 1);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /console.css — serves the static stylesheet', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/console.css`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/);
      const body = await res.text();
      assert.match(body, /opsui-page-title/);
    }),
  );
});

test('GET /ui-tokens.css — serves the generated design-token stylesheet', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/ui-tokens.css`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/);
      const body = await res.text();
      assert.match(body, /--bg/);
    }),
  );
});

test('GET /ui-components.css — serves the design system\'s component stylesheet', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/ui-components.css`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/);
      const body = await res.text();
      assert.match(body, /\.opsui-shell/);
    }),
  );
});

test('GET /ui-fonts.css — serves the self-hosted Inter @font-face rule', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/ui-fonts.css`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/);
      const body = await res.text();
      assert.match(body, /@font-face/);
      assert.match(body, /font-weight:\s*100 900/);
      assert.match(body, /\/ui-fonts\/InterVariable\.woff2/);
    }),
  );
});

test('GET /ui-fonts/InterVariable.woff2 — serves the self-hosted variable font as binary', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/ui-fonts/InterVariable.woff2`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'font/woff2');
      const buf = Buffer.from(await res.arrayBuffer());
      // Binary sanity: a text/UTF-8 read-and-resend of a woff2 corrupts multi-byte sequences,
      // which would either throw decoding it or change the byte length on the way back out —
      // asserting size alone would miss that class of corruption, so also pin the format's
      // magic signature (ASCII "wOF2") at the very start of the file.
      assert.ok(buf.length > 300_000, `expected a font file well over 300KB, got ${buf.length}`);
      assert.equal(buf.subarray(0, 4).toString('ascii'), 'wOF2');
    }),
  );
});

test('GET / (page shell) — links the fonts stylesheet before the token/component stylesheets', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      const body = await res.text();
      // The opsui shell serves its stylesheets under /ui/*.css; /ui-fonts.css keeps
      // its own path (the self-hosted Inter @font-face) and must still register first.
      const fontsIdx = body.indexOf('/ui-fonts.css');
      const tokensIdx = body.indexOf('/ui/tokens.css');
      const componentsIdx = body.indexOf('/ui/components.css');
      assert.ok(fontsIdx !== -1, 'expected a <link> to /ui-fonts.css in <head>');
      assert.ok(tokensIdx !== -1 && componentsIdx !== -1, 'expected the opsui /ui/*.css stylesheets in <head>');
      assert.ok(fontsIdx < tokensIdx && fontsIdx < componentsIdx,
        'the font face must register before the stylesheets that rely on it');
    }),
  );
});

test('GET /nope — unknown route 404s', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/nope`);
      assert.equal(res.status, 404);
      const body = await res.text();
      assert.match(body, /404/);
    }),
  );
});

test('GET /nope.png — unknown static asset 404s', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/nope.png`);
      assert.equal(res.status, 404);
    }),
  );
});

// ---------------------------------------------------------------------------
// Write verbs (POST) — capture / approve / reject / accept
// ---------------------------------------------------------------------------

/** A same-origin form POST: Origin/Referer host matches the request Host. */
function sameOriginHeaders(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: base,
    ...extra,
  };
}

test('POST /intent — appends item.captured and 303-redirects to returnTo, with ?captured=<id> (PRG)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'ship the health check', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const location = res.headers.get('location') ?? '';
      assert.match(location, /^\/command\?captured=WI-\d+$/);

      const events = await loadAllEvents(ledgerDir);
      const captured = events.filter((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'ship the health check');
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.data && (captured[0].data as { source?: string }).source, 'ext:console');
    }),
  );
});

test('POST /intent — blank text redirects without appending anything', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: '   ', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/approve — appends item.approved and redirects to returnTo', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      // WI-003 is parked (decision) with a dispatched build carrying no `branch` field, so
      // neither the parked-unbuilt nor branch-gone special case fires — a plain item.approved.
      const res = await fetch(`${base}/item/WI-003/approve`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/needs-you' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/needs-you');

      const events = await loadAllEvents(ledgerDir);
      const approved = events.filter((e) => e.item === 'WI-003' && e.type === 'item.approved');
      assert.equal(approved.length, 1);
      assert.equal((approved[0]?.data as { by?: string }).by, 'operator');
    }),
  );
});

test('POST /item/<id>/reject — appends item.rejected and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-003/reject`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/needs-you' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      const rejected = events.filter((e) => e.item === 'WI-003' && e.type === 'item.rejected');
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]?.data as { by?: string }).by, 'operator');
    }),
  );
});

test('POST /item/<id>/accept — appends item.accepted for a merged item and redirects', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-004/accept`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/needs-you' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);

      const events = await loadAllEvents(ledgerDir);
      const accepted = events.filter((e) => e.item === 'WI-004' && e.type === 'item.accepted');
      assert.equal(accepted.length, 1);

      const result = fold(events);
      assert.equal(result.items.get('WI-004')?.state, 'accepted');
    }),
  );
});

test('POST /item/<id>/reply — appends msg.in and redirects to returnTo', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-003/reply`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'go ahead, rename it', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/command');

      const events = await loadAllEvents(ledgerDir);
      const replies = events.filter((e) => e.item === 'WI-003' && e.type === 'msg.in');
      assert.equal(replies.length, 1);
      assert.equal((replies[0]?.data as { text?: string }).text, 'go ahead, rename it');
      assert.equal(replies[0]?.actor, 'operator');

      const result = fold(events);
      // A reply is a message, never a state transition — WI-003 stays exactly where it was.
      assert.equal(result.items.get('WI-003')?.state, 'parked');
    }),
  );
});

test('POST /item/<id>/reply — blank text redirects without appending anything', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/item/WI-003/reply`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: '   ', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/reply — an id absent from the ledger gets a 400 error page with a link back, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/item/WI-999/reply`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'hello', returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /No such item: WI-999/);
      assert.match(body, /<a href="\/missions">/);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/reply — replying to a terminal (accepted) item still appends, no state change', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-005/reply`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'thanks!', returnTo: '/item/WI-005' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const events = await loadAllEvents(ledgerDir);
      const result = fold(events);
      assert.equal(result.items.get('WI-005')?.state, 'accepted');
      assert.deepEqual(result.items.get('WI-005')?.messages.map((m) => m.text), ['thanks!']);
    }),
  );
});

test('POST /item/<id>/reply — mismatched Origin is refused with 403, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/item/WI-003/reply`, {
        method: 'POST',
        headers: sameOriginHeaders(base, { Origin: 'http://evil.example' }),
        body: new URLSearchParams({ text: 'hi', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 403);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/feedback — appends item.feedback and opens a linked follow-up item, redirects to returnTo', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-004/feedback`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'the docs still reference the old command', returnTo: '/acceptance' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/acceptance');

      const events = await loadAllEvents(ledgerDir);
      const feedbackEvs = events.filter((e) => e.item === 'WI-004' && e.type === 'item.feedback');
      assert.equal(feedbackEvs.length, 1);
      assert.equal((feedbackEvs[0]?.data as { text?: string }).text, 'the docs still reference the old command');

      const result = fold(events);
      assert.equal(result.items.get('WI-004')?.state, 'merged', 'feedback must never move the item off merged');
      const captured = events.filter(
        (e) => e.type === 'item.captured' && (e.data as { source?: string }).source === 'feedback:WI-004',
      );
      assert.equal(captured.length, 1, 'a linked follow-up item must be captured');
      assert.match((captured[0]?.data as { text?: string }).text ?? '', /WI-004/);
    }),
  );
});

test('POST /item/<id>/feedback — blank text redirects without appending anything', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/item/WI-004/feedback`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: '   ', returnTo: '/acceptance' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/feedback — a non-merged item is rejected with a 400 error page, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      // WI-001 is queued, not merged — feedback only applies once a slice has shipped.
      const res = await fetch(`${base}/item/WI-001/feedback`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'wrong', returnTo: '/acceptance' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /not awaiting acceptance/);
      assert.match(body, /<a href="\/acceptance">/);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/feedback — mismatched Origin is refused with 403, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/item/WI-004/feedback`, {
        method: 'POST',
        headers: sameOriginHeaders(base, { Origin: 'http://evil.example' }),
        body: new URLSearchParams({ text: 'hi', returnTo: '/acceptance' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 403);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/accept — a non-merged item gets a 409 error page with a link back, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      // WI-001 is queued, not merged — the console refuses the stale form outright.
      const res = await fetch(`${base}/item/WI-001/accept`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/missions' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 409);
      const body = await res.text();
      assert.match(body, /not awaiting acceptance/);
      assert.match(body, /state: queued/);
      assert.match(body, /<a href="\/missions">/); // the way back
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/approve — a non-parked item gets a 409 error page with a link back, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      // WI-004 is merged — an approve form for it could only exist in a stale tab.
      const res = await fetch(`${base}/item/WI-004/approve`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 409);
      const body = await res.text();
      assert.match(body, /not parked/);
      assert.match(body, /<a href="\/command">/);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/reject — a non-parked (building) item is refused the same way, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      // WI-002 is building — reject applies to parked items only.
      const res = await fetch(`${base}/item/WI-002/reject`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 409);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /item/<id>/approve — an id absent from the ledger gets a 404 error page, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      // Matches the route's URL shape (alphanumeric+hyphens) but names nothing in the fold —
      // refused before the verb ever runs.
      const res = await fetch(`${base}/item/not-an-id/approve`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ returnTo: '/' }).toString(),
      });
      assert.equal(res.status, 404);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST with a rebound (non-loopback) Host — 403s even when Origin matches Host', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      // DNS rebinding shape: evil.example resolves to 127.0.0.1, so the browser sends
      // Host: evil.example with a MATCHING Origin. The loopback-Host requirement rejects it.
      const port = Number(new URL(base).port);
      const status = await rawPost(
        port,
        '/intent',
        { host: 'evil.example', origin: 'http://evil.example' },
        new URLSearchParams({ text: 'rebound', returnTo: '/' }).toString(),
      );
      assert.equal(status, 403);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST via a trustedHosts reverse-proxy hostname — allowed; unlisted host still 403', async () => {
  await withLedger(async (ledgerDir) => {
    const handle = await startConsole({ ledgerDir, port: 0, trustedHosts: ['ops.proxy.example'], runsDir: join(ledgerDir, 'runs') });
    try {
      // The proxy preserves its public hostname in Host; Origin matches it (same-origin form).
      const ok = await rawPost(
        handle.port,
        '/intent',
        { host: 'ops.proxy.example:8445', origin: 'https://ops.proxy.example:8445' },
        new URLSearchParams({ text: 'via proxy', returnTo: '/' }).toString(),
      );
      assert.equal(ok, 303);
      const events = await loadAllEvents(ledgerDir);
      assert.ok(events.some((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'via proxy'));

      // A hostname NOT in the list keeps the rebinding rejection.
      const bad = await rawPost(
        handle.port,
        '/intent',
        { host: 'evil.example', origin: 'http://evil.example' },
        new URLSearchParams({ text: 'still rebound', returnTo: '/' }).toString(),
      );
      assert.equal(bad, 403);
    } finally {
      await handle.close();
    }
  });
});

test('POST unknown path — 404s, no mutation', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/nope`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: '',
      });
      assert.equal(res.status, 404);
    }),
  );
});

test('GET requests never mutate — a GET to /intent is not a route (404), no append', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/intent`);
      assert.equal(res.status, 404);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

// ---------------------------------------------------------------------------
// CSRF / origin guard
// ---------------------------------------------------------------------------

test('POST /intent — mismatched Origin is refused with 403, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'http://evil.example',
        },
        body: new URLSearchParams({ text: 'attacker capture', returnTo: '/' }).toString(),
      });
      assert.equal(res.status, 403);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

test('POST /intent — no Origin and no Referer is refused with 403 (fail closed)', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ text: 'no origin at all', returnTo: '/' }).toString(),
      });
      assert.equal(res.status, 403);
    }),
  );
});

test('POST /intent — a same-host Referer (no Origin) is accepted', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${base}/`,
        },
        body: new URLSearchParams({ text: 'referer-only capture', returnTo: '/' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
    }),
  );
});

// ---------------------------------------------------------------------------
// Body size cap
// ---------------------------------------------------------------------------

test('POST /intent — an oversized body 413s, appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const oversized = 'text=' + 'a'.repeat(70 * 1024);
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: oversized,
      });
      assert.equal(res.status, 413);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
    }),
  );
});

// ---------------------------------------------------------------------------
// Theme toggle — zero-JS, cookie-based (POST /theme)
// ---------------------------------------------------------------------------

test('POST /theme — sets a theme cookie and redirects to returnTo', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/theme`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ theme: 'light', returnTo: '/system' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/system');
      const setCookie = res.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /theme=light/);
    }),
  );
});

test('POST /theme — an invalid theme value falls back to dark, does not crash', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/theme`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ theme: 'not-a-theme', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const setCookie = res.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /theme=dark/);
    }),
  );
});

test('GET /system with a light theme cookie — renders <html data-theme="light">', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/system`, { headers: { Cookie: 'theme=light' } });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /<html lang="en" data-theme="light">/);
    }),
  );
});

// ---------------------------------------------------------------------------
// Knowledge page (/knowledge) — operator-configured markdown sources
// ---------------------------------------------------------------------------

/**
 * Run `fn` against a server whose repoRoot is a fresh temp dir seeded with the given
 * loopkit.config.json content and markdown files. LOOPKIT_HOME is cleared for the duration —
 * loadConfig prefers it over repoRoot, so an ambient operator plane-home must never leak into
 * these tests — and restored after.
 */
async function withKnowledgeRepo<T>(
  configJson: unknown | undefined,
  files: Record<string, string>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'loopkit-knowledge-repo-'));
  const savedHome = process.env['LOOPKIT_HOME'];
  delete process.env['LOOPKIT_HOME'];
  try {
    if (configJson !== undefined) {
      await writeFile(join(repoRoot, 'loopkit.config.json'), JSON.stringify(configJson));
    }
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(repoRoot, dirname(rel)), { recursive: true });
      await writeFile(join(repoRoot, rel), content);
    }
    return await withLedger(async (ledgerDir) => {
      const handle = await startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), repoRoot });
      try {
        return await fn(`http://127.0.0.1:${handle.port}`);
      } finally {
        await handle.close();
      }
    });
  } finally {
    if (savedHome !== undefined) process.env['LOOPKIT_HOME'] = savedHome;
    else delete process.env['LOOPKIT_HOME'];
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// WI-053 phase-3 / WI-054: with no `knowledge` config the standalone plane has no sources
// wired, so /company renders its honest empty state. The context bar must say so — a bare
// "—" chip read as broken, not empty.
test('GET /company — no knowledge config renders an honest context-bar label, not a bare "—"', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/company`);
      assert.equal(res.status, 200);
      const body = await res.text();
      const contextBar = body.slice(body.indexOf('opsui-contextbar'), body.indexOf('opsui-contextbar__freshness'));
      assert.match(contextBar, /opsui-status__label">no sources configured</);
      assert.ok(!/opsui-status__label">—</.test(contextBar), 'context bar must not render a bare "—" label');
    }),
  );
});

// Phase-1 committed the /knowledge → 301 /company rename. WI-054 then RETIRED the
// legacy operator-configured markdown page (renderKnowledge) and rehomed its role onto the
// /company page, which now renders knowledge sources (markdown cards + parsed
// decision logs) over the `knowledge` config, upgraded to source objects. These tests pin
// the committed redirect; the knowledge-source rendering is covered by the /company cases below.
test('GET /knowledge — 301s to /company (renamed route), regardless of knowledge config', async () => {
  await withKnowledgeRepo(undefined, {}, async (base) => {
    const res = await fetch(`${base}/knowledge`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/company');
  });
});

test('GET /knowledge — the redirect is unconditional even when a knowledge config is present', async () => {
  const config = { knowledge: { paths: ['docs/decisions.md'] } };
  const files = { 'docs/decisions.md': '# Decision log\n\nADR-001 chose an append-only ledger.' };
  await withKnowledgeRepo(config, files, async (base) => {
    const res = await fetch(`${base}/knowledge`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/company');
  });
});

// ---------------------------------------------------------------------------
// WI-054 — the /company page renders operator-configured knowledge sources
// (markdown cards + parsed decision logs), with a target switcher. Fixtures live in
// synthetic tmp dirs; leak-wall clean (acme-web, /tmp/alpha-shaped paths only).
// ---------------------------------------------------------------------------

/**
 * Start the console over a synthetic plane repo: writes `loopkit.config.json` + `files`, and
 * (optionally) registers each named target with `repoPath = <repoRoot>/<target-subdir>` so
 * `knowledge.targets` entries resolve. `targetFiles` are written under each target's subdir.
 */
async function withCompanyRepo<T>(
  configJson: unknown | undefined,
  files: Record<string, string>,
  targets: Record<string, Record<string, string>>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'loopkit-company-repo-'));
  const savedHome = process.env['LOOPKIT_HOME'];
  delete process.env['LOOPKIT_HOME'];
  try {
    if (configJson !== undefined) {
      await writeFile(join(repoRoot, 'loopkit.config.json'), JSON.stringify(configJson));
    }
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(repoRoot, dirname(rel)), { recursive: true });
      await writeFile(join(repoRoot, rel), content);
    }
    const targetEvents: ReturnType<typeof makeEvent>[] = [];
    let i = 0;
    for (const [name, tfiles] of Object.entries(targets)) {
      const sub = name.replace(/[^a-z0-9-]/gi, '-');
      const trepo = join(repoRoot, sub);
      await mkdir(trepo, { recursive: true });
      for (const [rel, content] of Object.entries(tfiles)) {
        await mkdir(join(trepo, dirname(rel)), { recursive: true });
        await writeFile(join(trepo, rel), content);
      }
      targetEvents.push(
        makeEvent('cli', name, 'target.registered', {
          name,
          repoPath: trepo,
          manifestHash: String.fromCharCode(97 + i).repeat(40),
          defaultBranch: 'main',
        }, `2026-07-02T00:00:0${i}.000Z`),
      );
      i += 1;
    }
    return await withLedger(async (ledgerDir) => {
      if (targetEvents.length) await appendEvents(ledgerDir, targetEvents);
      const handle = await startConsole({ ledgerDir, port: 0, runsDir: join(ledgerDir, 'runs'), repoRoot });
      try {
        return await fn(`http://127.0.0.1:${handle.port}`);
      } finally {
        await handle.close();
      }
    });
  } finally {
    if (savedHome !== undefined) process.env['LOOPKIT_HOME'] = savedHome;
    else delete process.env['LOOPKIT_HOME'];
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test('GET /company — a bare-string glob source still renders a markdown card (config back-compat)', async () => {
  const config = { knowledge: { paths: ['docs/*.md'] } };
  const files = { 'docs/architecture.md': '# Architecture\n\nThe kernel is an append-only ledger.' };
  await withCompanyRepo(config, files, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    assert.equal(res.status, 200);
    const body = await res.text();
    // Card title = basename (no label configured for a bare string); body carries the content.
    assert.match(body, /architecture\.md/);
    assert.match(body, /append-only ledger/);
    assert.match(body, /opsui-company__knowledge/);
  });
});

test('GET /company — a source object renders a card with its configured label', async () => {
  const config = { knowledge: { paths: [{ path: 'docs/vision.md', label: 'Product vision' }] } };
  const files = { 'docs/vision.md': '# Vision\n\nShip vertical slices fast.' };
  await withCompanyRepo(config, files, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    assert.match(body, /Product vision/);
    assert.match(body, /Ship vertical slices fast/);
  });
});

test('GET /company — a decision-log source feeds the Decisions region with the right Active count', async () => {
  const log = [
    '# Decisions',
    '',
    '## D-001 — Adopt event sourcing',
    'Status: Active',
    'Date: 2026-01-05',
    'We store commands as events.',
    '',
    '## D-002 — Use a single fold',
    'Status: Superseded',
    'Date: 2026-02-10',
    'One fold, many projections.',
    '',
    '## D-003 — Ledger is truth',
    'Status: Active',
    '2026-03-01',
    'The ledger wins on drift.',
  ].join('\n');
  const config = { knowledge: { paths: [{ path: 'docs/decisions.md', kind: 'decision-log', label: 'Decision log' }] } };
  await withCompanyRepo(config, { 'docs/decisions.md': log }, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    // All three parsed decisions render in the Decisions region.
    assert.match(body, /D-001 — Adopt event sourcing/);
    assert.match(body, /D-002 — Use a single fold/);
    assert.match(body, /D-003 — Ledger is truth/);
    // Newest-first: the log is oldest-first (append-only), so D-003 (last in the file) renders
    // before D-001 (first in the file), matching the fold's document ordering.
    const iD001 = body.indexOf('D-001 — Adopt event sourcing');
    const iD002 = body.indexOf('D-002 — Use a single fold');
    const iD003 = body.indexOf('D-003 — Ledger is truth');
    assert.ok(iD003 < iD002 && iD002 < iD001, 'decisions render newest-first (D-003, D-002, D-001)');
    // Two Active → the region's "N active" badge + glance metric.
    assert.match(body, /2 active/);
    // Context-bar state label reflects the active count.
    const contextBar = body.slice(body.indexOf('opsui-contextbar'), body.indexOf('opsui-contextbar__freshness'));
    assert.match(contextBar, /opsui-status__label">2 active decisions</);
  });
});

test('GET /company — a date-headed decision log (metadata-line ID/Status) feeds the Decisions region', async () => {
  const log = [
    '# Decisions',
    '',
    '### 2025-01-05 — Adopt message bus',
    '**ID:** D-007 · **Status:** Active',
    '- **Decision:** Route service events through a shared bus.',
    '- **Why:** Decouples producers from consumers.',
    '',
    '### 2025-02-11 — Retire the legacy queue',
    '**ID:** D-008 · **Status:** Superseded',
    '- **Decision:** Drop the old point-to-point queue in favor of the bus.',
  ].join('\n');
  const config = { knowledge: { paths: [{ path: 'docs/decisions.md', kind: 'decision-log', label: 'Decision log' }] } };
  await withCompanyRepo(config, { 'docs/decisions.md': log }, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    assert.match(body, /D-007 — Adopt message bus/);
    assert.match(body, /D-008 — Retire the legacy queue/);
    // Newest-first: D-008 (later in the file) renders before D-007 (earlier in the file).
    assert.ok(
      body.indexOf('D-008 — Retire the legacy queue') < body.indexOf('D-007 — Adopt message bus'),
      'decisions render newest-first (D-008 before D-007)',
    );
    // One Active (D-007), D-008 is Superseded → excluded from the count.
    assert.match(body, /1 active/);
    const contextBar = body.slice(body.indexOf('opsui-contextbar'), body.indexOf('opsui-contextbar__freshness'));
    assert.match(contextBar, /opsui-status__label">1 active decision</);
  });
});

test('GET /company — a date-headed entry with Status on its own line (not the ID line) still parses', async () => {
  const log = [
    '### 2025-03-01 — Freeze the public schema',
    '**ID:** D-009',
    '**Status:** Active',
    '- **Decision:** No breaking changes to the public event schema without a major version.',
  ].join('\n');
  const config = { knowledge: { paths: [{ path: 'docs/decisions.md', kind: 'decision-log', label: 'Decision log' }] } };
  await withCompanyRepo(config, { 'docs/decisions.md': log }, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    assert.match(body, /D-009 — Freeze the public schema/);
    assert.match(body, /1 active/);
  });
});

test('GET /company — a mixed-format log (id-in-heading + date-headed) parses both shapes, newest-first', async () => {
  const log = [
    '## D-001 — Adopt event sourcing',
    'Status: Active',
    'Date: 2026-01-05',
    'We store commands as events.',
    '',
    '### 2026-02-10 — Use a single fold',
    '**ID:** D-002 · **Status:** Superseded',
    'One fold, many projections.',
  ].join('\n');
  const config = { knowledge: { paths: [{ path: 'docs/decisions.md', kind: 'decision-log', label: 'Decision log' }] } };
  await withCompanyRepo(config, { 'docs/decisions.md': log }, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    assert.match(body, /D-001 — Adopt event sourcing/);
    assert.match(body, /D-002 — Use a single fold/);
    // Newest-first: D-002 is the later entry in the file (date-headed shape) and must render
    // before D-001 (earlier entry, id-in-heading shape) — the reversal covers both shapes.
    assert.ok(
      body.indexOf('D-002 — Use a single fold') < body.indexOf('D-001 — Adopt event sourcing'),
      'decisions render newest-first across mixed heading shapes (D-002 before D-001)',
    );
    assert.match(body, /1 active/);
  });
});

test('GET /company — same-day entries still render newest-first (document order, not a date sort)', async () => {
  // Three entries sharing one calendar date — a date-string sort can't disambiguate these; only
  // a document-order reversal preserves the correct (append) order.
  const log = [
    '## D-010 — Morning decision',
    'Status: Active',
    '2026-05-01',
    'First of the day.',
    '',
    '## D-011 — Midday decision',
    'Status: Active',
    '2026-05-01',
    'Second of the day.',
    '',
    '## D-012 — Evening decision',
    'Status: Active',
    '2026-05-01',
    'Third of the day.',
  ].join('\n');
  const config = { knowledge: { paths: [{ path: 'docs/decisions.md', kind: 'decision-log', label: 'Decision log' }] } };
  await withCompanyRepo(config, { 'docs/decisions.md': log }, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    const iD010 = body.indexOf('D-010 — Morning decision');
    const iD011 = body.indexOf('D-011 — Midday decision');
    const iD012 = body.indexOf('D-012 — Evening decision');
    assert.ok(
      iD012 < iD011 && iD011 < iD010,
      'same-date entries still render newest-first by document order (D-012, D-011, D-010)',
    );
  });
});

// WI-058 — generic PREFIX-NNN ids (ADR-style, not just D-NNN) and glob decision-log source
// objects (one-decision-per-file directories, e.g. this repo's own docs/decisions/ADR-NNN.md).
// ---------------------------------------------------------------------------

test('GET /company — an id-in-heading log with a generic ADR-NNN prefix parses like D-NNN', async () => {
  const log = [
    '## ADR-001 — Adopt event sourcing',
    'Status: Active',
    'Date: 2026-01-05',
    'We store commands as events.',
    '',
    '## ADR-002 — Use a single fold',
    'Status: Superseded',
    'One fold, many projections.',
  ].join('\n');
  const config = { knowledge: { paths: [{ path: 'docs/decisions.md', kind: 'decision-log', label: 'Decision log' }] } };
  await withCompanyRepo(config, { 'docs/decisions.md': log }, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    assert.match(body, /ADR-001 — Adopt event sourcing/);
    assert.match(body, /ADR-002 — Use a single fold/);
    // Newest-first, same as D-NNN fixtures.
    assert.ok(
      body.indexOf('ADR-002 — Use a single fold') < body.indexOf('ADR-001 — Adopt event sourcing'),
      'generic-prefix decisions still render newest-first',
    );
    assert.match(body, /1 active/);
  });
});

test('GET /company — a glob decision-log source object expands to one card per matched ADR file', async () => {
  const files = {
    'docs/decisions/ADR-001-one-plane.md': [
      '# ADR-001 — One default plane per machine',
      '',
      '**Status:** active',
      '',
      'A machine runs ONE default plane.',
    ].join('\n'),
    'docs/decisions/ADR-002-plane-home.md': [
      '# ADR-002 — Plane-home layout',
      '',
      '**Status:** superseded by ADR-004',
      '',
      'Config switches only on explicit env.',
    ].join('\n'),
    // A non-decision doc in the same directory must not be swept up by the decision-log kind
    // (it's still a valid .md match for the glob, but carries no PREFIX-NNN heading — parses
    // to nothing and falls back to a markdown card per the existing "unparseable" contract).
    'docs/decisions/README.md': '# Decision log\n\nSee the individual ADR files.',
  };
  const config = {
    knowledge: { paths: [{ path: 'docs/decisions/*.md', kind: 'decision-log', label: 'Decision log' }] },
  };
  await withCompanyRepo(config, files, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /ADR-001 — One default plane per machine/);
    assert.match(body, /ADR-002 — Plane-home layout/);
    // Status normalized from lowercase 'active' → 'Active' (exact-case match downstream).
    assert.match(body, /1 active/);
    // The README.md sibling (no PREFIX-NNN heading) falls back to a markdown card, not a
    // decision card — its content still renders somewhere on the page.
    assert.match(body, /See the individual ADR files/);
  });
});

// WI-066 — the founder-reported bug: glob-sourced (one-decision-per-file, WI-058) records
// rendered oldest-first with no date, unlike the single-file source's newest-first + dated
// cards. `expandKnowledgePattern` sorts matched filenames alphabetically before parsing, so
// without a final cross-file sort the concatenated cards stayed in that file-name order.
// ---------------------------------------------------------------------------

test('GET /company — glob-sourced decision records render newest-first by numeric id, not file-name order', async () => {
  const files = {
    // Deliberately a two-digit id whose file name still sorts alphabetically BEFORE the
    // single-digit ids (ADR-10 < ADR-2 < ADR-9 as strings) — a lexical sort of the concatenated
    // cards would misorder these; only a numeric-id sort gets ADR-010 to render first.
    'docs/decisions/ADR-002-second.md': ['# ADR-002 — Second decision', '', '**Status:** active'].join('\n'),
    'docs/decisions/ADR-009-ninth.md': ['# ADR-009 — Ninth decision', '', '**Status:** active'].join('\n'),
    'docs/decisions/ADR-010-tenth.md': ['# ADR-010 — Tenth decision', '', '**Status:** active'].join('\n'),
  };
  const config = {
    knowledge: { paths: [{ path: 'docs/decisions/*.md', kind: 'decision-log', label: 'Decision log' }] },
  };
  await withCompanyRepo(config, files, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    const i002 = body.indexOf('ADR-002 — Second decision');
    const i009 = body.indexOf('ADR-009 — Ninth decision');
    const i010 = body.indexOf('ADR-010 — Tenth decision');
    assert.ok(i010 < i009 && i009 < i002, 'glob-sourced records render newest-first by numeric id (ADR-010, ADR-009, ADR-002)');
  });
});

test('GET /company — a glob-sourced ADR file with a parseable date renders it; one with none renders without a fabricated date', async () => {
  const files = {
    // Carries a real date in its body (mirrors the single-file `Date:` convention) — must render.
    'docs/decisions/ADR-001-dated.md': [
      '# ADR-001 — Dated decision',
      '',
      '**Status:** active',
      '',
      'Date: 2026-03-14',
      '',
      'Decided on a specific day.',
    ].join('\n'),
    // No date anywhere in the file (this repo's real ADR-style convention today) — must render
    // with no date rather than a fabricated one (e.g. file mtime).
    'docs/decisions/ADR-002-undated.md': [
      '# ADR-002 — Undated decision',
      '',
      '**Status:** active',
      '',
      'No date anywhere in this file.',
    ].join('\n'),
  };
  const config = {
    knowledge: { paths: [{ path: 'docs/decisions/*.md', kind: 'decision-log', label: 'Decision log' }] },
  };
  await withCompanyRepo(config, files, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    // The dated card renders its extracted date wherever single-file-sourced decisions show
    // theirs (the same opsui-eventrow__metaitem chip the D-NNN tests above rely on) — the
    // metadata div directly follows each row's title/badge head, so a window from the title to
    // the next row's `<article` open comfortably spans it.
    const datedRowStart = body.indexOf('ADR-001 — Dated decision');
    const datedRowEnd = body.indexOf('<article', datedRowStart + 1);
    const datedRow = body.slice(datedRowStart, datedRowEnd === -1 ? undefined : datedRowEnd);
    assert.match(datedRow, /2026-03-14/);
    // The undated card's row carries no date string at all.
    const undatedRowStart = body.indexOf('ADR-002 — Undated decision');
    const undatedRowEnd = body.indexOf('<article', undatedRowStart + 1);
    const undatedRow = body.slice(undatedRowStart, undatedRowEnd === -1 ? undefined : undatedRowEnd);
    assert.doesNotMatch(undatedRow, /\d{4}-\d{2}-\d{2}/);
  });
});

test('GET /company — a glob decision-log source that matches nothing yields a visible error record', async () => {
  const config = {
    knowledge: { paths: [{ path: 'docs/decisions/*.md', kind: 'decision-log', label: 'Decision log' }] },
  };
  await withCompanyRepo(config, {}, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Decision log/);
    assert.match(body, /no files matched/);
  });
});

test('GET /company — a bare-string glob entry is unaffected by the object-glob change', async () => {
  const config = { knowledge: { paths: ['docs/*.md'] } };
  const files = { 'docs/notes.md': '# Notes\n\nplain markdown, unchanged behavior.' };
  await withCompanyRepo(config, files, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    const body = await res.text();
    assert.match(body, /notes\.md/);
    assert.match(body, /plain markdown, unchanged behavior/);
  });
});

test('GET /company — an unreadable source renders a warning card, never a 500', async () => {
  const config = { knowledge: { paths: [{ path: 'docs/missing.md', label: 'Gone doc' }] } };
  await withCompanyRepo(config, {}, {}, async (base) => {
    const res = await fetch(`${base}/company`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Gone doc/);
    assert.match(body, /source unreadable/);
  });
});

test('GET /company — target chips render, and ?target= filters to that target', async () => {
  const config = {
    knowledge: {
      targets: {
        'acme-web': [{ path: 'docs/notes.md', label: 'Acme notes' }],
        'acme-api': [{ path: 'docs/notes.md', label: 'Api notes' }],
      },
    },
  };
  await withCompanyRepo(
    config,
    {},
    {
      'acme-web': { 'docs/notes.md': '# Web\n\nweb-only content' },
      'acme-api': { 'docs/notes.md': '# Api\n\napi-only content' },
    },
    async (base) => {
      // All view: both targets' cards present, chips for All + each target.
      const all = await (await fetch(`${base}/company`)).text();
      assert.match(all, /Target/);
      assert.match(all, /acme-web/);
      assert.match(all, /acme-api/);
      assert.match(all, /web-only content/);
      assert.match(all, /api-only content/);
      // Filtered view: only the selected target's content shows.
      const web = await (await fetch(`${base}/company?target=acme-web`)).text();
      assert.match(web, /web-only content/);
      assert.ok(!/api-only content/.test(web), '?target=acme-web must hide the other target');
      assert.match(web, /aria-current="true"/);
    },
  );
});

// ---------------------------------------------------------------------------
// Intent composer attachments — multipart POST /intent
// ---------------------------------------------------------------------------

const MULTIPART_BOUNDARY = 'loopkit-test-boundary-7f3a';

/** Assemble a multipart/form-data body from text fields + optional file parts. */
function multipartBody(
  fields: Record<string, string>,
  files: { name: string; filename: string; contentType: string; data: string }[] = [],
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  for (const f of files) {
    parts.push(
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
        `Content-Type: ${f.contentType}\r\n\r\n${f.data}\r\n`,
    );
  }
  return `${parts.join('')}--${MULTIPART_BOUNDARY}--\r\n`;
}

function multipartHeaders(base: string): Record<string, string> {
  return sameOriginHeaders(base, { 'Content-Type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` });
}

test('POST /intent (multipart) — captures the intent text and stores the attachment under runs/attachments', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const body = multipartBody(
        { intent: 'the composer drops screenshots now', returnTo: '/command' },
        [{ name: 'attachment', filename: 'screen shot!.png', contentType: 'image/png', data: 'PNG-BYTES-HERE' }],
      );
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.match(res.headers.get('location') ?? '', /^\/command\?captured=WI-\d+$/);

      const events = await loadAllEvents(ledgerDir);
      const captured = events.filter(
        (e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'the composer drops screenshots now',
      );
      assert.equal(captured.length, 1);

      // The file landed under the plane's runs/attachments dir, sanitized but recognizable.
      const stored = await readdir(join(ledgerDir, 'runs', 'attachments'));
      assert.equal(stored.length, 1);
      assert.match(stored[0]!, /screen-shot-\.png$/);
      const content = await readFile(join(ledgerDir, 'runs', 'attachments', stored[0]!), 'utf8');
      assert.equal(content, 'PNG-BYTES-HERE');
    }),
  );
});

test('POST /intent (multipart) — the composer\'s `intent` field captures with no attachment too', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const body = multipartBody({ intent: 'plain multipart capture', returnTo: '/command' });
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const events = await loadAllEvents(ledgerDir);
      assert.equal(
        events.filter((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'plain multipart capture').length,
        1,
      );
    }),
  );
});

test('POST /intent (multipart) — a body over the multipart cap is refused with 413', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      // Just over the 8 MiB multipart cap — the residue past the server's read-abort stays
      // small enough to sit in socket buffers, so the 413 always arrives cleanly.
      const body = multipartBody(
        { intent: 'huge upload', returnTo: '/command' },
        [{ name: 'attachment', filename: 'big.bin', contentType: 'application/octet-stream', data: 'x'.repeat(8 * 1024 * 1024 + 64 * 1024) }],
      );
      const res = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 413);
    }),
  );
});

// ---------------------------------------------------------------------------
// Thread reply attachments — multipart POST /item/<id>/reply
// ---------------------------------------------------------------------------

test('POST /item/<id>/reply (multipart) — appends msg.in with text and stores the attachment under runs/attachments', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const body = multipartBody(
        { text: 'here is a screenshot of the failure', returnTo: '/command' },
        [{ name: 'attachment', filename: 'failure.png', contentType: 'image/png', data: 'PNG-BYTES-HERE' }],
      );
      const res = await fetch(`${base}/item/WI-003/reply`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/command');

      const events = await loadAllEvents(ledgerDir);
      const replies = events.filter((e) => e.item === 'WI-003' && e.type === 'msg.in');
      assert.equal(replies.length, 1);
      const data = replies[0]?.data as { text?: string; attachments?: string[] };
      assert.equal(data.text, 'here is a screenshot of the failure');
      assert.equal(data.attachments?.length, 1);
      assert.match(data.attachments![0]!, /^attachments\/.+failure\.png$/);

      const stored = await readdir(join(ledgerDir, 'runs', 'attachments'));
      assert.equal(stored.length, 1);
      const content = await readFile(join(ledgerDir, 'runs', 'attachments', stored[0]!), 'utf8');
      assert.equal(content, 'PNG-BYTES-HERE');
    }),
  );
});

test('POST /item/<id>/reply (multipart) — blank text stores no attachment and appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const body = multipartBody(
        { text: '   ', returnTo: '/command' },
        [{ name: 'attachment', filename: 'orphan.png', contentType: 'image/png', data: 'bytes' }],
      );
      const res = await fetch(`${base}/item/WI-003/reply`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
      await assert.rejects(() => readdir(join(ledgerDir, 'runs', 'attachments')));
    }),
  );
});

// ---------------------------------------------------------------------------
// Feedback attachments — multipart POST /item/<id>/feedback
// ---------------------------------------------------------------------------

test('POST /item/<id>/feedback (multipart) — appends item.feedback with text and stores the attachment under runs/attachments', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const body = multipartBody(
        { text: 'the docs still reference the old command', returnTo: '/acceptance' },
        [{ name: 'attachment', filename: 'wrong-colour.png', contentType: 'image/png', data: 'PNG-BYTES-HERE' }],
      );
      const res = await fetch(`${base}/item/WI-004/feedback`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/acceptance');

      const events = await loadAllEvents(ledgerDir);
      const feedbackEvs = events.filter((e) => e.item === 'WI-004' && e.type === 'item.feedback');
      assert.equal(feedbackEvs.length, 1);
      const data = feedbackEvs[0]?.data as { text?: string; attachments?: string[] };
      assert.equal(data.text, 'the docs still reference the old command');
      assert.equal(data.attachments?.length, 1);
      assert.match(data.attachments![0]!, /^attachments\/.+wrong-colour\.png$/);

      const stored = await readdir(join(ledgerDir, 'runs', 'attachments'));
      assert.equal(stored.length, 1);
      const content = await readFile(join(ledgerDir, 'runs', 'attachments', stored[0]!), 'utf8');
      assert.equal(content, 'PNG-BYTES-HERE');
    }),
  );
});

test('POST /item/<id>/feedback (multipart) — blank text stores no attachment and appends nothing', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const before = await loadAllEvents(ledgerDir);
      const body = multipartBody(
        { text: '   ', returnTo: '/acceptance' },
        [{ name: 'attachment', filename: 'orphan.png', contentType: 'image/png', data: 'bytes' }],
      );
      const res = await fetch(`${base}/item/WI-004/feedback`, {
        method: 'POST',
        headers: multipartHeaders(base),
        body,
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const after = await loadAllEvents(ledgerDir);
      assert.equal(after.length, before.length);
      await assert.rejects(() => readdir(join(ledgerDir, 'runs', 'attachments')));
    }),
  );
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants — every route renders the shell; zero inline script BODIES
// ---------------------------------------------------------------------------

// WI-053 dual-shell reality (a transitional Phase-1 artifact) converged further under WI-055:
// /activity now renders through the the @loopkit/opsui shell too (renderActivityPage in
// opsPages.ts), same as every canonical page. Legacy non-WI item pages (renderItemTimeline, e.g.
// CONV-N ids) are the one surface still rendering through the OLD console shell/views.ts — out of
// scope for WI-055, tracked separately. The cross-cutting invariants below are therefore still
// shell-aware for that one remaining legacy route: the sidebar/topbar/no-inline-script contract
// holds on BOTH shells, but each shell emits a different (still self-hosted, allowlisted) script
// set, and only the old shell carries the no-JS TopBar fallback twins.
const OPSUI_ROUTES = ['/command', '/work', '/acceptance', '/health', '/observability', '/company', '/timeline', '/item/WI-001', '/activity'];
const LEGACY_SHELL_ROUTES: string[] = [];
const ALL_ROUTES = [...OPSUI_ROUTES, ...LEGACY_SHELL_ROUTES];

// The allowlist of external script sources a page may reference. Both shells' enhancement
// layers are self-hosted and served with a JS content-type (the "asset served with the right
// content-type" tests cover that side of the contract): the opsui shell's `/ui/*.js` and the
// legacy console shell's `/console-*.js`. Anything outside this set — including an inline body —
// fails the CSP `script-src 'self'` shape the same way a raw inline script would.
const ALLOWED_SCRIPT_SRCS = new Set([
  // opsui shell
  '/ui/shell.js',
  '/ui/palette.js',
  '/ui/composer.js',
  '/ui/confirm.js',
  '/ui/live.js',
  // legacy console shell (still backing /activity + legacy item pages)
  '/console-shell.js',
  '/console-palette.js',
  '/console-composer.js',
  '/console-confirm.js',
  '/console-live.js',
]);

/**
 * Asserts the zero-inline-script contract: every `<script>` tag on the page carries a `src`
 * from the allowlist and has NO body content between its open and close tags — external-only,
 * exactly the shape a CSP `script-src 'self'` (no `'unsafe-inline'`) policy requires. A future
 * accidental `<script>...inline code...</script>` or a `src` outside the allowlist both fail
 * this the same way a raw inline script used to.
 */
function assertOnlyAllowedExternalScripts(body: string, route: string): void {
  const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = scriptTagRe.exec(body)) !== null) {
    count++;
    const [, attrs, innerBody] = match;
    assert.equal(innerBody.trim(), '', `${route}: <script> tag must have no inline body (found on tag #${count})`);
    const srcMatch = /\bsrc="([^"]*)"/.exec(attrs ?? '');
    assert.ok(srcMatch, `${route}: <script> tag #${count} must carry a src= attribute`);
    const src = srcMatch![1];
    assert.ok(
      ALLOWED_SCRIPT_SRCS.has(src),
      `${route}: <script src="${src}"> is not in the external-script allowlist`,
    );
  }
}

for (const route of ALL_ROUTES) {
  test(`GET ${route} — renders the sidebar (NavigationRail) and the top bar (TopBar)`, async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}${route}`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.match(body, /class="opsui-rail[^"]*"[^>]*aria-label="Primary"/);
        assert.match(body, /class="opsui-topbar"[^>]*role="banner"/);
        // All six sidebar destinations render as flat rail items on every route, not just the
        // active one — the desktop rail has no "More" overflow (that's mobile bottom-nav only).
        for (const label of ['Command', 'Missions', 'Acceptance', 'System', 'Analytics', 'Knowledge']) {
          assert.match(body, new RegExp(`opsui-rail__title">${label}<`));
        }
      }),
    );
  });

  test(`GET ${route} — every <script> tag is external-src-only, from the allowlist`, async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}${route}`);
        const body = await res.text();
        assertOnlyAllowedExternalScripts(body, route);
      }),
    );
  });

}

// The no-JS TopBar fallback twins are an old-shell affordance: the @loopkit/opsui TopBar
// drives palette/intent/theme through its client shell module (data-opsui-shell hooks), so the
// twin markup only renders on the legacy-shell routes. Progressive enhancement for the WRITE
// verbs (intent/approve/reject/accept) is proven independently by the "No-JS verb sweep" tests
// below — those plain form POSTs work on every shell with JS disabled.
for (const route of LEGACY_SHELL_ROUTES) {
  test(`GET ${route} — the no-JS TopBar fallback twins still render (legacy shell)`, async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}${route}`);
        const body = await res.text();
        assert.match(body, /class="opsui-topbar__palette opsui-topbar__nojs"/);
        assert.match(body, /class="opsui-topbar__intent opsui-topbar__nojs"/);
        assert.match(body, /opsui-topbar__theme-form/);
      }),
    );
  });
}

test('GET /404-check — the not-found page also renders the shell, external-src-only scripts', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/does-not-exist`);
      assert.equal(res.status, 404);
      const body = await res.text();
      assert.match(body, /class="opsui-rail[^"]*"[^>]*aria-label="Primary"/);
      assertOnlyAllowedExternalScripts(body, '/does-not-exist');
    }),
  );
});

// ---------------------------------------------------------------------------
// Slice 3 — client-JS enhancement assets: served with the right content-type
// ---------------------------------------------------------------------------

const SHELL_JS_ASSETS = ['/console-shell.js', '/console-palette.js', '/console-composer.js', '/console-confirm.js', '/console-live.js'];

for (const assetPath of SHELL_JS_ASSETS) {
  test(`GET ${assetPath} — served with a JS content-type`, async () => {
    await withLedger((ledgerDir) =>
      withServer(ledgerDir, async (base) => {
        const res = await fetch(`${base}${assetPath}`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
        const body = await res.text();
        assert.ok(body.length > 0);
      }),
    );
  });
}

test('GET /console-shell.js — path traversal is refused, not served', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/../../../../etc/passwd`);
      assert.notEqual(res.status, 200);
    }),
  );
});

// ---------------------------------------------------------------------------
// Every operator verb works as a plain, no-JS form POST (task acceptance criteria)
// ---------------------------------------------------------------------------

test('No-JS verb sweep: intent capture, approve, reject, accept — each round-trips via a plain POST', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-test-'));
  try {
    await appendEvents(dir, sampleLedger());
    await withServer(dir, async (base) => {
      // Capture.
      const captureRes = await fetch(`${base}/intent`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: new URLSearchParams({ text: 'no-js sweep capture', returnTo: '/command' }).toString(),
        redirect: 'manual',
      });
      assert.equal(captureRes.status, 303);

      // Approve a decision park (WI-003).
      const approveRes = await fetch(`${base}/item/WI-003/approve?returnTo=%2Fcommand`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: '',
        redirect: 'manual',
      });
      assert.equal(approveRes.status, 303);

      // Accept a merged item (WI-004).
      const acceptRes = await fetch(`${base}/item/WI-004/accept?returnTo=%2Fmissions`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: '',
        redirect: 'manual',
      });
      assert.equal(acceptRes.status, 303);

      const events = await loadAllEvents(dir);
      assert.ok(events.some((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === 'no-js sweep capture'));
      assert.ok(events.some((e) => e.item === 'WI-003' && e.type === 'item.approved'));
      assert.ok(events.some((e) => e.item === 'WI-004' && e.type === 'item.accepted'));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WI-053 — the deterministic emoji-verb door: the exact operator-facing verb strings the
// markup emits, POSTed through /intent, must short-circuit to the shared core verb (zero
// LLM, never a capture) — the same verbs the REST routes prove, but through the composer
// door. Each fixture item is seeded in the state its verb requires.
// ---------------------------------------------------------------------------

/** A ledger seeded so every emoji verb has an item in a valid state:
 *   - WI-201 spine-parked, UNBUILT      → 🛡 spine approve (unpark) / target for reject
 *   - WI-202 spine-parked, UNBUILT      → 🛡 spine reject
 *   - WI-203 decision-parked            → ▶ parked approve
 *   - WI-204 decision-parked            → ▶ parked decline (reject)
 *   - WI-205 decision-parked            → ✔ resolve (reject, founder resolve)
 *   - WI-206 merged (awaiting)          → ✅ accept
 *   - WI-207 building                   → ⏹ stop / 🛎 escalate
 *   - WI-208 queued                     → ⏸ hold
 *   - WI-209 held                       → ▶ resume
 *   - WI-210 any state                  → 🔁 retry sonnet (lenient: always unpark+requeue)
 */
function emojiVerbLedger(): ReturnType<typeof sampleLedger> {
  const ts = (h: number, m = 0) => `2026-07-05T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const evs: ReturnType<typeof sampleLedger> = [];
  const capture = (id: string, text: string, h: number) => {
    evs.push(makeEvent('cli', id, 'item.captured', { source: 'cli', text }, ts(h, 0)));
    evs.push(makeEvent('reactor', id, 'item.queued', { spec: text }, ts(h, 1)));
  };

  // Parked, unbuilt (no build.dispatched → approve unparks cleanly, no branch check). The
  // 🛡 spine verb calls approveOrReject, which acts on any parked item regardless of parkClass
  // (the fold derives parkClass from the reason; the verb never inspects it).
  capture('WI-201', 'spine approve target', 9);
  evs.push(makeEvent('conductor', 'WI-201', 'item.parked', { reason: 'needs-decision: touches spine', parkKind: 'decision' }, ts(9, 2)));
  capture('WI-202', 'spine reject target', 10);
  evs.push(makeEvent('conductor', 'WI-202', 'item.parked', { reason: 'needs-decision: touches spine', parkKind: 'decision' }, ts(10, 2)));

  // Decision-parked.
  for (const [id, h] of [['WI-203', 11], ['WI-204', 12], ['WI-205', 13]] as const) {
    capture(id, `${id} decision`, h);
    evs.push(makeEvent('conductor', id, 'item.parked', { reason: 'touches a public API boundary', parkKind: 'decision' }, ts(h, 2)));
  }

  // Merged, awaiting acceptance.
  capture('WI-206', 'merged awaiting accept', 14);
  evs.push(makeEvent('dispatch', 'WI-206', 'build.dispatched', { attempt: 1 }, ts(14, 2)));
  evs.push(makeEvent('dispatch', 'WI-206', 'gate.passed', { tests: 'green' }, ts(14, 3)));
  evs.push(makeEvent('reactor', 'WI-206', 'item.merged', { commit: 'fed6789' }, ts(14, 4)));

  // Building.
  capture('WI-207', 'building item', 15);
  evs.push(makeEvent('dispatch', 'WI-207', 'build.dispatched', { attempt: 1 }, ts(15, 2)));

  // Queued (WI-208 stays queued from capture); held (WI-209 parked hold).
  capture('WI-208', 'queued item', 16);
  capture('WI-209', 'held item', 17);
  evs.push(makeEvent('cli', 'WI-209', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }, ts(17, 2)));

  // Retry target (any state; retryWithModel unparks+requeues unconditionally).
  capture('WI-210', 'retry target', 18);
  evs.push(makeEvent('cli', 'WI-210', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }, ts(18, 2)));

  return evs;
}

async function withEmojiLedger<T>(fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-emoji-'));
  try {
    await appendEvents(dir, emojiVerbLedger());
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function postVerb(base: string, verb: string): Promise<Response> {
  return fetch(`${base}/intent`, {
    method: 'POST',
    headers: sameOriginHeaders(base),
    body: new URLSearchParams({ intent: verb }).toString(),
    redirect: 'manual',
  });
}

test('Emoji-verb door: each deterministic verb string round-trips through /intent to its core verb', async () => {
  await withEmojiLedger(async (ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      // [verb string, expected redirect target, item, resulting event type]
      const cases: Array<[string, string, string, string]> = [
        ['🛡 spine WI-201: approve', '/command', 'WI-201', 'item.unparked'],
        ['🛡 spine WI-202: reject', '/command', 'WI-202', 'item.rejected'],
        ['▶ parked WI-203: approve', '/command', 'WI-203', 'item.unparked'],
        ['▶ parked WI-204: decline', '/command', 'WI-204', 'item.rejected'],
        ['✔ resolve WI-205', '/work', 'WI-205', 'item.rejected'],
        ['✅ accept WI-206', '/command', 'WI-206', 'item.accepted'],
        ['⏹ stop WI-207', '/work', 'WI-207', 'build.cancel-requested'],
        ['🛎 escalate WI-207', '/work', 'WI-207', 'item.escalated'],
        ['⏸ hold WI-208', '/work', 'WI-208', 'item.parked'],
        ['▶ resume WI-209', '/work', 'WI-209', 'item.unparked'],
        ['🔁 retry WI-210: sonnet', '/work', 'WI-210', 'item.queued'],
      ];

      for (const [verb, next, item, evType] of cases) {
        const res = await postVerb(base, verb);
        assert.equal(res.status, 303, `${verb}: expected a 303 redirect`);
        assert.equal(res.headers.get('location'), next, `${verb}: expected redirect to ${next}`);
        const events = await loadAllEvents(ledgerDir);
        assert.ok(
          events.some((e) => e.item === item && e.type === evType),
          `${verb}: expected a ${evType} event on ${item}`,
        );
        // A deterministic verb NEVER falls through to capture — no item.captured carries the raw
        // verb string as its text.
        assert.ok(
          !events.some((e) => e.type === 'item.captured' && (e.data as { text?: string }).text === verb),
          `${verb}: must short-circuit, never be captured as a work item`,
        );
      }
    }),
  );
});

test('No-JS verb sweep: reject round-trips via a plain POST', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/item/WI-003/reject?returnTo=%2Fcommand`, {
        method: 'POST',
        headers: sameOriginHeaders(base),
        body: '',
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const events = await loadAllEvents(ledgerDir);
      assert.ok(events.some((e) => e.item === 'WI-003' && e.type === 'item.rejected'));
    }),
  );
});

// ---------------------------------------------------------------------------
// Command window chips (?window=24h|7d|30d) change the shipped-count region
// ---------------------------------------------------------------------------

test('GET /command?window= — the window chips render and the active one carries aria-current', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const res = await fetch(`${base}/command?window=7d`);
      const body = await res.text();
      assert.match(body, /href="\?window=7d"[^>]*aria-current="true"/);
    }),
  );
});

test('GET /command with different ?window= values renders a different Glance card body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-test-'));
  try {
    // A merge 10 days ago — outside the 24h window, inside the 7d/30d windows — so the
    // shipped count (and therefore the rendered Glance body) differs between window values
    // regardless of when this test actually runs.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await appendEvents(dir, [
      ...sampleLedger(),
      { id: 'ev-old', ts: tenDaysAgo, actor: 'cli', item: 'WI-777', type: 'item.captured', data: { source: 'cli', text: 'old work' } },
      { id: 'ev-old2', ts: tenDaysAgo, actor: 'reactor', item: 'WI-777', type: 'item.merged', data: { commit: 'aaa0000' } },
    ]);
    await withServer(dir, async (base) => {
      const res24h = await fetch(`${base}/command?window=24h`);
      const res30d = await fetch(`${base}/command?window=30d`);
      const body24h = await res24h.text();
      const body30d = await res30d.text();
      assert.notEqual(body24h, body30d);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WI-053 shell-adoption guards — pin the canonical ops-console copy + compact-row rendering that
// silently drifted before the shell adoption. The Command page renders through @loopkit/opsui, so a
// future re-implementation or a fold-adapter regression that changes these footnote strings, the
// Glance markers, or reverts recent-work to cards would fail here rather than ship unnoticed.
// ---------------------------------------------------------------------------

/** Run `fn` against a server seeded with the now-relative Glance fixture, whose merged
 *  judge-failed item lands the Glance tiles in known states (see recentGlanceLedger). */
async function withGlanceServer(fn: (body: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkit-console-test-'));
  try {
    await appendEvents(dir, recentGlanceLedger());
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/command`);
      assert.equal(res.status, 200);
      fn(await res.text());
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('GET /command — the Glance footnotes carry the canonical copy', async () => {
  await withGlanceServer((body) => {
    // The three alarm tiles' zero/one states, verbatim (these strings drifted before).
    assert.match(body, /all clear/);                     // Decisions tile: no decision parks
    assert.match(body, /shipped, awaiting your verdict/); // To test tile: a must-tier merge awaits
    assert.match(body, /none stuck/);                     // Stuck tile: nothing stale
  });
});

test('GET /command — the Flow footnote keeps the "median cycle · N in / N out (…) · N queued" shape', async () => {
  await withGlanceServer((body) => {
    // Exact structural pattern, not just the literal — a reorder or a dropped term fails here.
    assert.match(body, /median cycle · \d+ in(?: \([^)]+\))? \/ \d+ out \([^)]+\) · \d+ queued/);
  });
});

test('GET /command — the Reliability footnote keeps the "N/M clean landing (7d) · N/M clean (30d) · target NN% · this try: N/M (…)" shape', async () => {
  await withGlanceServer((body) => {
    // The sole recent merge landed clean (no lifetime park/crash/gate-red/escalation counts)
    // and was also first-attempt ⇒ 1/1 on every axis, in both the 7d/30d windows and the
    // selected reliability window.
    assert.match(body, /1\/1 clean landing \(7d\) · 1\/1 clean \(30d\) · target 90% · this try: 1\/1 \([^)]+\)/);
  });
});

test('GET /command — the Glance grid + context bar + top bar render with the opsui markers', async () => {
  await withGlanceServer((body) => {
    assert.match(body, /opsui-glancegrid/);
    assert.match(body, /class="opsui-contextbar"/);
    assert.match(body, /class="opsui-topbar"[^>]*role="banner"/);
  });
});

test('GET /command — recent work items render as compact eventrows, not cards', async () => {
  await withLedger((ledgerDir) =>
    withServer(ledgerDir, async (base) => {
      const body = await (await fetch(`${base}/command`)).text();
      // The company/recent-work stream renders one compact opsui-eventrow per item (a card would
      // be opsui-card--*). At least one WI id from the sample ledger must surface inside a row.
      assert.match(body, /opsui-eventrow/);
      const rowWithWi = /<article class="opsui-eventrow[^>]*>[\s\S]*?WI-00\d[\s\S]*?<\/article>/;
      assert.match(body, rowWithWi);
    }),
  );
});
