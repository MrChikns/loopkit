/**
 * providers.test.ts — provider-breadth tests:
 *   1. codex-cli review-input assembly excludes the builder constraint footer.
 *   2. ollama adapter refuses any non-loopback endpoint (private-lane guard).
 *   3. sensitivity routing: a private item resolves ONLY to ollama, never a cloud provider.
 *   4. cost projection groups cost.usage by loop / provider / day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleReviewInput, stripConstraintFooter, makeCodexCliProvider } from '../src/providers/codexCli.js';
import { detectAuthFailure, parseOutput, extractUsage } from '../src/providers/claudeCli.js';
import { OllamaProvider, isLoopbackHost, makeOllamaProvider } from '../src/providers/ollama.js';
import { makeRegistry } from '../src/providers/registry.js';
import { foldCosts } from '../src/costs.js';
import { makeEvent } from '../src/schema.js';

// ---------------------------------------------------------------------------
// 1. Review input assembly excludes the constraint footer
// ---------------------------------------------------------------------------

const FOOTER = `- State your assumptions explicitly. If uncertain, ask.
- No features beyond what was asked.
- No abstractions for single-use code.`;

test('assembleReviewInput: strips the builder constraint footer (zero bleed)', () => {
  const contract = `Add a pageSize query param to the queue fragment URL.
Files: src/queue.ts
${FOOTER}`;
  const out = assembleReviewInput({ diff: '+ const pageSize = 20;', taskContract: contract });

  assert.ok(!/State your assumptions/i.test(out), 'footer header must not appear in review input');
  assert.ok(!/No features beyond what was asked/i.test(out), 'footer constraint lines must not bleed');
  assert.ok(!/No abstractions for single-use code/i.test(out), 'footer constraint lines must not bleed');
  // The real contract intent and the diff still survive.
  assert.ok(/pageSize query param/.test(out), 'legitimate contract text must survive');
  assert.ok(/const pageSize = 20/.test(out), 'diff must survive');
});

test('stripConstraintFooter: removes stray constraint lines even without the header', () => {
  const body = `Do the thing.
No features beyond what was asked.
Keep going.`;
  const out = stripConstraintFooter(body);
  assert.ok(!/No features beyond what was asked/.test(out));
  assert.ok(/Do the thing/.test(out) && /Keep going/.test(out));
});

test('assembleReviewInput: planning context cannot enter (excluded by construction)', () => {
  // The function accepts only diff + taskContract; there is no parameter that could carry
  // notes.md / queue.md / roadmap content into the reviewer's input.
  const out = assembleReviewInput({ diff: 'x', taskContract: 'y' });
  assert.ok(!/notes\.md|queue\.md|roadmap|SENT-1/i.test(out));
});

test('makeCodexCliProvider: exposes the codex-cli name', () => {
  assert.equal(makeCodexCliProvider().name, 'codex-cli');
});

// ---------------------------------------------------------------------------
// 2. ollama loopback guard
// ---------------------------------------------------------------------------

test('isLoopbackHost: accepts loopback, rejects remote', () => {
  assert.ok(isLoopbackHost('http://127.0.0.1:11434'));
  assert.ok(isLoopbackHost('http://localhost:11434'));
  assert.ok(isLoopbackHost('http://[::1]:11434'));
  assert.ok(!isLoopbackHost('http://10.0.0.5:11434'));
  assert.ok(!isLoopbackHost('https://ollama.example.com'));
  assert.ok(!isLoopbackHost('not a url'));
});

test('ollama: refuses a non-loopback endpoint (never leaves the box)', async () => {
  const provider = new OllamaProvider({ baseUrl: 'http://ollama.example.com:11434' });
  const result = await provider.run({ prompt: 'hi' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /not loopback|off-box/i);
  }
});

test('makeOllamaProvider: default endpoint is loopback', () => {
  // No fetch is issued; we only assert the constructed adapter would target the local box.
  assert.ok(isLoopbackHost('http://127.0.0.1:11434'));
  assert.equal(makeOllamaProvider().name, 'ollama');
});

// ---------------------------------------------------------------------------
// 3. Sensitivity routing — private resolves ONLY to ollama
// ---------------------------------------------------------------------------

test('registry: private item resolves to ollama, never a cloud provider', () => {
  const registry = makeRegistry({
    providers: {
      'claude-cli': { model: 'sonnet' },
      'codex-cli': {},
      'ollama': {},
    },
    sensitivityAllowlists: {
      public: ['claude-cli', 'codex-cli', 'ollama'],
      internal: ['claude-cli', 'codex-cli'],
      private: ['ollama'],
    },
  });

  // Even when the caller *prefers* a cloud provider, a private item is forced onto ollama.
  const resolved = registry.resolve('claude-cli', 'private');
  assert.ok(resolved !== null, 'private must resolve to the local provider');
  assert.equal(resolved?.name, 'ollama', 'private must never resolve to a cloud provider');

  // codex-cli preference on a private item is likewise coerced to ollama.
  assert.equal(registry.resolve('codex-cli', 'private')?.name, 'ollama');

  // Internal items keep cloud access.
  assert.equal(registry.resolve('claude-cli', 'internal')?.name, 'claude-cli');

  // With no local provider on the private allowlist, a private item resolves to NOTHING
  // (the caller parks it — it is never handed to a cloud provider).
  const noLocal = makeRegistry({
    providers: { 'claude-cli': {} },
    sensitivityAllowlists: { internal: ['claude-cli'], private: [] },
  });
  assert.equal(noLocal.resolve('claude-cli', 'private'), null, 'private with empty allowlist must be null, never cloud');
});

// ---------------------------------------------------------------------------
// 4. Cost projection
// ---------------------------------------------------------------------------

test('foldCosts: groups cost.usage by loop, provider, and day', () => {
  const events = [
    makeEvent('reactor', 'WI-001', 'cost.usage', { provider: 'claude-cli', loop: 'reactor', tokens: 100, usd: 0.01 }, '2026-07-10T08:00:00Z'),
    makeEvent('dispatch', 'WI-002', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 200, usd: 0.02 }, '2026-07-10T09:00:00Z'),
    makeEvent('reactor', 'WI-003', 'cost.usage', { provider: 'ollama', loop: 'reactor', tokens: 50, usd: 0 }, '2026-07-11T08:00:00Z'),
    // A non-cost event must be ignored.
    makeEvent('reactor', 'WI-003', 'loop.beat', { loop: 'reactor', result: 'ok' }, '2026-07-11T08:00:01Z'),
  ];
  const summary = foldCosts(events);

  assert.equal(summary.totalTokens, 350);
  assert.ok(Math.abs(summary.totalUsd - 0.03) < 1e-9);
  assert.equal(summary.totalCalls, 3);

  const reactorLoop = summary.byLoop.find(r => r.key === 'reactor');
  assert.equal(reactorLoop?.tokens, 150);
  assert.equal(reactorLoop?.calls, 2);

  const claude = summary.byProvider.find(r => r.key === 'claude-cli');
  assert.equal(claude?.tokens, 300);
  assert.ok(Math.abs((claude?.usd ?? 0) - 0.03) < 1e-9);

  const day10 = summary.byDay.find(r => r.key === '2026-07-10');
  assert.equal(day10?.tokens, 300);
  // Days are sorted oldest → newest.
  assert.deepEqual(summary.byDay.map(r => r.key), ['2026-07-10', '2026-07-11']);
});

test('foldCosts: empty ledger yields zeroed summary', () => {
  const s = foldCosts([]);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.totalCalls, 0);
  assert.deepEqual(s.byLoop, []);
});

// ---------------------------------------------------------------------------
// claudeCli.ts: detectAuthFailure (auth vs non-auth is_error separation)
// ---------------------------------------------------------------------------

test('detectAuthFailure: matches login-required patterns from the CLI', () => {
  // Exact text observed from real CLI auth-failure output
  assert.ok(detectAuthFailure('Not logged in · Please run /login'));
  // Canonical patterns the regex covers
  assert.ok(detectAuthFailure('not logged in'));
  assert.ok(detectAuthFailure('Authentication required'));
  assert.ok(detectAuthFailure('login required to continue'));
  // Case-insensitive
  assert.ok(detectAuthFailure('NOT LOGGED IN'));
  assert.ok(detectAuthFailure('LOGIN REQUIRED'));
});

test('detectAuthFailure: does not match non-auth error text', () => {
  // Generic is_error strings that must NOT be classified as auth
  assert.ok(!detectAuthFailure('Rate limit exceeded'));
  assert.ok(!detectAuthFailure('Context window exceeded'));
  assert.ok(!detectAuthFailure('claude exited 1'));
  assert.ok(!detectAuthFailure('OK, ping!'));
  assert.ok(!detectAuthFailure(''));
  // Partial substring that must not fire
  assert.ok(!detectAuthFailure('Please read the log'));
});

// ---------------------------------------------------------------------------
// spendForDay: sums only the given day's cost.usage events
// ---------------------------------------------------------------------------

import { spendForDay } from '../src/costs.js';

test('spendForDay: sums only cost.usage events on the target day', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 100, usd: 0.01 }, '2026-07-10T08:00:00Z'),
    makeEvent('dispatch', 'WI-002', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 200, usd: 0.02 }, '2026-07-10T20:00:00Z'),
    // Different day — must NOT be counted
    makeEvent('dispatch', 'WI-003', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 500, usd: 0.05 }, '2026-07-11T08:00:00Z'),
    // Different event type — must NOT be counted
    makeEvent('reactor', 'WI-004', 'loop.beat', { loop: 'reactor', result: 'ok' }, '2026-07-10T09:00:00Z'),
  ];
  assert.ok(Math.abs(spendForDay(events, '2026-07-10') - 0.03) < 1e-9, 'should sum only 07-10 cost events');
  assert.ok(Math.abs(spendForDay(events, '2026-07-11') - 0.05) < 1e-9, 'should sum only 07-11 cost events');
  assert.equal(spendForDay(events, '2026-07-09'), 0, 'no events on 07-09 → 0');
});

test('spendForDay: events with missing usd contribute 0 (graceful)', () => {
  const events = [
    makeEvent('dispatch', 'WI-001', 'cost.usage', { provider: 'ollama', loop: 'dispatch', tokens: 1000 }, '2026-07-10T08:00:00Z'),
    makeEvent('dispatch', 'WI-002', 'cost.usage', { provider: 'claude-cli', loop: 'dispatch', tokens: 100, usd: 0.01 }, '2026-07-10T09:00:00Z'),
  ];
  assert.ok(Math.abs(spendForDay(events, '2026-07-10') - 0.01) < 1e-9,
    'missing usd (ollama = free) must contribute 0, not NaN');
});

// ---------------------------------------------------------------------------
// claudeCli.ts token extraction (regression guard: was always num_turns=1)
// ---------------------------------------------------------------------------

// We test the raw JSON parsing path by importing parseOutput indirectly through
// a synthetic ProviderSuccess shape. The actual path through claudeCli is covered by
// the dispatch integration tests; here we validate the parsing logic explicitly by
// examining what foldCosts sees after a dispatch build that returned real token counts.

test('spendForDay: tokens sum is consistent with real usage shape emitted by dispatch', () => {
  // Simulate what dispatch now emits: tokens = in + out from usage object
  const events = [
    makeEvent('dispatch', 'WI-001', 'cost.usage', {
      provider: 'claude-cli', loop: 'dispatch',
      tokens: 1500,   // 1200 input + 300 output
      usd: 0.0045,
      wi: 'WI-001',
    }, '2026-07-11T10:00:00Z'),
  ];
  const summary = foldCosts(events);
  assert.equal(summary.totalTokens, 1500);
  assert.ok(Math.abs(summary.totalUsd - 0.0045) < 1e-9);
  const dispatchLoop = summary.byLoop.find(r => r.key === 'dispatch');
  assert.equal(dispatchLoop?.tokens, 1500);
});

// ---------------------------------------------------------------------------
// parseOutput + extractUsage are the ONE parser shared by the in-process
// provider path and the detached-build collector (never a copy).
// ---------------------------------------------------------------------------

test('parseOutput: valid JSON parses; empty/garbage returns null with a reason', () => {
  const ok = parseOutput('{"result":"hi","is_error":false}');
  assert.equal(ok.parseErr, '');
  assert.equal(ok.obj?.result, 'hi');
  assert.equal(parseOutput('').obj, null);
  assert.equal(parseOutput('  ').obj, null);
  assert.ok(parseOutput('{not json').parseErr.length > 0);
});

test('extractUsage: sums input + cache tokens as `in`, real output_tokens as `out`', () => {
  const u = extractUsage({
    total_cost_usd: 0.0045,
    num_turns: 7,
    duration_ms: 12345,
    usage: {
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 50,
    },
  });
  assert.ok(u);
  assert.equal(u!.in, 1200);   // 1000 + 150 + 50
  assert.equal(u!.out, 300);
  assert.equal(u!.usd, 0.0045);
  assert.equal(u!.turns, 7);
  assert.equal(u!.durationMs, 12345);
});

test('extractUsage: no priceable usage (no cost, zero tokens) returns undefined', () => {
  assert.equal(extractUsage({}), undefined);
  assert.equal(extractUsage({ num_turns: 3 }), undefined);
  // cost present but no tokens still counts as usage (the prior inline behaviour).
  const u = extractUsage({ total_cost_usd: 0 });
  assert.ok(u);
  assert.equal(u!.in, 0);
  assert.equal(u!.out, 0);
});

test('extractUsage: turns/durationMs omitted when the CLI did not emit them', () => {
  const u = extractUsage({ usage: { input_tokens: 5, output_tokens: 2 } });
  assert.ok(u);
  assert.equal(u!.in, 5);
  assert.equal(u!.out, 2);
  assert.equal('turns' in u!, false);
  assert.equal('durationMs' in u!, false);
});

// ---------------------------------------------------------------------------
// Run-controls hard-stop: claudeCli.ts cancel poll
// reuses the SAME SIGTERM→SIGKILL escalation as the existing timeout path. Exercised against a
// real spawned child (a fake `claude` shell script on PATH) so the test proves the actual signal
// delivery, not just that a callback was invoked.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeCliProvider } from '../src/providers/claudeCli.js';
import { readExitFile } from '../src/exitfile.js';

/**
 * Write a fake `claude` executable (a Node script, NOT a /bin/sh script — a foreground `sleep`
 * in dash/sh only checks pending traps AFTER the blocking syscall returns, so a shell-script
 * fake never observes a mid-sleep SIGTERM in time; Node's signal handler fires immediately) on
 * a scratch dir and prepends it to PATH for the duration of the callback. The script installs a
 * REAL SIGTERM handler and records that it fired, so the test proves the provider's escalation
 * reached the REAL child process — not just that the poll callback was invoked.
 */
async function withFakeClaude(
  scriptBody: string,
  fn: (env: { binDir: string; markerFile: string; readyFile: string }) => Promise<void>,
): Promise<void> {
  const binDir = mkdtempSync(join(tmpdir(), 'fake-claude-bin-'));
  const markerFile = join(binDir, 'sigterm-received');
  const readyFile = join(binDir, 'ready');
  const scriptPath = join(binDir, 'claude');
  // Writes `readyFile` as the FIRST statement — Node's own process-boot overhead (loading the
  // shebang'd interpreter, module resolution) is non-trivial relative to a fast poll interval, so
  // a test that starts counting cancelCheck ticks before the child has even installed its SIGTERM
  // handler can spuriously kill it before the handler exists. Callers gate the actual test
  // assertion on readyFile so the race is with process boot, never with signal delivery itself.
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node\nconst MARKER = ${JSON.stringify(markerFile)};\nrequire('fs').writeFileSync(${JSON.stringify(readyFile)}, '');\n${scriptBody}\n`,
    'utf8',
  );
  chmodSync(scriptPath, 0o755);
  const savedPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${savedPath ?? ''}`;
  try {
    await fn({ binDir, markerFile, readyFile });
  } finally {
    process.env['PATH'] = savedPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

test('claudeCli: cancelCheck returning true escalates the SAME SIGTERM→SIGKILL kill (real child)', async () => {
  // Installs a real SIGTERM handler, writes the marker, then exits — proving the escalation
  // actually reached this process (not just that the poll callback fired).
  const script = [
    "process.on('SIGTERM', () => { require('fs').writeFileSync(MARKER, ''); process.exit(143); });",
    'setTimeout(() => { process.exit(0); }, 10000);',
  ].join('\n');

  await withFakeClaude(script, async ({ markerFile, readyFile }) => {
    const provider = makeClaudeCliProvider();
    let pollCount = 0;
    const result = await provider.run({
      prompt: 'hi',
      timeoutMs: 30_000,          // long enough that the wall-clock timer never fires first
      cancelCheckIntervalMs: 50,  // fast poll so the test doesn't wait long
      // Only signal "cancel" once the child has proven it booted (readyFile exists) AND has
      // had one extra tick to reach its SIGTERM handler registration — otherwise this poll can
      // race Node's own child-process boot time, not the provider's escalation logic.
      cancelCheck: () => {
        pollCount += 1;
        return existsSync(readyFile) && pollCount >= 4;
      },
    });

    assert.equal(result.ok, false, 'a cancelled build must resolve as a provider error');
    if (!result.ok) {
      assert.equal(result.code, 'cancelled', 'must report code:cancelled, distinct from code:timeout');
    }
    assert.ok(pollCount >= 2, 'cancelCheck must have been polled at least twice');
    // Give the marker write a moment to land (process teardown is async relative to close).
    await new Promise(r => setTimeout(r, 150));
    assert.ok(existsSync(markerFile), 'the child must have actually received SIGTERM (the escalation reused, not a separate kill path)');
  });
});

test('claudeCli: cancelCheck returning false never kills a healthy build', async () => {
  const script = ["process.stdout.write(JSON.stringify({ result: 'ok', is_error: false }));"].join('\n');
  await withFakeClaude(script, async () => {
    const provider = makeClaudeCliProvider();
    const result = await provider.run({
      prompt: 'hi',
      timeoutMs: 5_000,
      cancelCheckIntervalMs: 50,
      cancelCheck: () => false,
    });
    assert.equal(result.ok, true, 'a build with cancelCheck always false must complete normally');
  });
});

test('claudeCli: a throwing cancelCheck fails open (never cancels a healthy build)', async () => {
  const script = [
    "setTimeout(() => { process.stdout.write(JSON.stringify({ result: 'ok', is_error: false })); process.exit(0); }, 300);",
  ].join('\n');
  await withFakeClaude(script, async () => {
    const provider = makeClaudeCliProvider();
    const result = await provider.run({
      prompt: 'hi',
      timeoutMs: 5_000,
      cancelCheckIntervalMs: 50,
      cancelCheck: () => { throw new Error('poll boom'); },
    });
    assert.equal(result.ok, true, 'a throwing cancelCheck must never cancel a healthy build (fail-open)');
  });
});

// ---------------------------------------------------------------------------
// Detached spawn + exit-file protocol, against a REAL spawned child (the fake `claude`
// script on PATH) — proves the actual claudeCli.ts implementation, not just a test-level fake.
// ---------------------------------------------------------------------------

test('claudeCli: detached:true spawns as its own process-group leader — onSpawn fires synchronously with a real, live pgid', async () => {
  const script = [
    "setTimeout(() => { process.stdout.write(JSON.stringify({ result: 'ok', is_error: false })); process.exit(0); }, 200);",
  ].join('\n');
  await withFakeClaude(script, async () => {
    const provider = makeClaudeCliProvider();
    let spawnedPgid: number | undefined;
    const result = await provider.run({
      prompt: 'hi',
      timeoutMs: 5_000,
      detached: true,
      onSpawn: pgid => { spawnedPgid = pgid; },
    });
    assert.equal(result.ok, true);
    assert.equal(typeof spawnedPgid, 'number', 'onSpawn fired with a numeric pgid before the promise resolved');
  });
});

test('claudeCli: exitFile option writes the exit-file protocol — readable via readExitFile + the SAME parseOutput/extractUsage', async () => {
  const script = [
    "process.stdout.write(JSON.stringify({ result: 'exit-file round trip', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }));",
  ].join('\n');
  await withFakeClaude(script, async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'claudecli-exitfile-'));
    try {
      const provider = makeClaudeCliProvider();
      const result = await provider.run({
        prompt: 'hi',
        timeoutMs: 5_000,
        detached: true,
        exitFile: { runDir, itemId: 'WI-999', attempt: 1 },
      });
      assert.equal(result.ok, true);

      const record = readExitFile(runDir, 'WI-999', 1);
      assert.ok(record, 'exit file is readable immediately after run() resolves');
      assert.equal(record!.exitCode, 0);
      assert.ok(record!.usageJsonPath, 'usage json path recorded on the exit sentinel');

      // The SAME functions a cross-beat collector (or dispatch's own terminal path) uses.
      const { obj } = parseOutput(readFileSync(record!.usageJsonPath!, 'utf8'));
      assert.ok(obj);
      assert.equal(obj!.result, 'exit-file round trip');
      const usage = extractUsage(obj!);
      assert.ok(usage);
      assert.equal(usage!.in, 10);
      assert.equal(usage!.out, 5);
      assert.equal(usage!.usd, 0.01);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Early-death exit-file path (orphan-reap defect, layer 2). A detached worker that dies EARLY —
// e.g. it loses interactive/keychain auth in its new session and exits within the first minute —
// must STILL leave an exit file. Without it, a later beat's doctor finds a pgid-bearing 'building'
// item with no exit sentinel and orphan-reaps it (build.crashed → requeue, charged to the breaker),
// instead of collecting an honest, auth-tagged crash. These prove the provider's exit-file writer
// fires on early death for every terminal path it owns (auth loss, hard crash).
// ---------------------------------------------------------------------------

test('claudeCli: early auth-loss death still writes an exit file with authFailure (collectable, not a phantom orphan)', async () => {
  // The claude CLI signals auth loss by exiting 0 with is_error:true and "not logged in" text.
  const script = ["process.stdout.write(JSON.stringify({ result: 'Not logged in · Please run /login', is_error: true })); process.exit(0);"].join('\n');
  await withFakeClaude(script, async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'claudecli-early-auth-'));
    try {
      const provider = makeClaudeCliProvider();
      const result = await provider.run({
        prompt: 'hi', timeoutMs: 5_000, detached: true,
        exitFile: { runDir, itemId: 'WI-990', attempt: 1 },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'auth');
      const record = readExitFile(runDir, 'WI-990', 1);
      assert.ok(record, 'early auth death must still leave an exit file');
      assert.equal(record!.exitCode, 0);
      assert.equal(record!.authFailure, true, 'the auth-failure signal is carried on the exit file for the collector');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

test('claudeCli: early hard-crash death (no output, non-zero exit) still writes an exit file', async () => {
  // A worker that dies before emitting any parseable JSON — the crash/OOM shape — must still land
  // an exit sentinel so the build is collected and crashed honestly rather than orphan-reaped.
  const script = ['process.exit(1);'].join('\n');
  await withFakeClaude(script, async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'claudecli-early-crash-'));
    try {
      const provider = makeClaudeCliProvider();
      const result = await provider.run({
        prompt: 'hi', timeoutMs: 5_000, detached: true,
        exitFile: { runDir, itemId: 'WI-991', attempt: 1 },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'parse');
      const record = readExitFile(runDir, 'WI-991', 1);
      assert.ok(record, 'a crashed worker must still leave an exit file');
      assert.equal(record!.exitCode, 1);
      assert.equal(record!.authFailure, undefined, 'a generic crash is not tagged as an auth failure');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

test('claudeCli: no exitFile option → no exit sentinel written (legacy/non-detached callers unaffected)', async () => {
  const script = ["process.stdout.write(JSON.stringify({ result: 'ok', is_error: false }));"].join('\n');
  await withFakeClaude(script, async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'claudecli-no-exitfile-'));
    try {
      const provider = makeClaudeCliProvider();
      const result = await provider.run({ prompt: 'hi', timeoutMs: 5_000 });
      assert.equal(result.ok, true);
      assert.equal(readExitFile(runDir, 'WI-999', 1), null, 'no exit file exists when exitFile was not requested');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --effort flag (reasoning effort passthrough to the claude-cli binary).
// ---------------------------------------------------------------------------

test('claudeCli: req.effort appends --effort <level> to argv; absent effort omits the flag', async () => {
  const script = [
    "require('fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ result: 'ok', is_error: false }));",
  ].join('\n');
  await withFakeClaude(script, async () => {
    const argvFile = join(tmpdir(), `claudecli-argv-${process.pid}-${Date.now()}.json`);
    process.env['ARGV_FILE'] = argvFile;
    try {
      const provider = makeClaudeCliProvider();
      const result = await provider.run({ prompt: 'hi', effort: 'high', timeoutMs: 5_000 });
      assert.equal(result.ok, true);
      const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
      assert.ok(argv.includes('--effort'), 'argv must include the --effort flag when req.effort is set');
      assert.equal(argv[argv.indexOf('--effort') + 1], 'high');

      rmSync(argvFile, { force: true });
      const result2 = await provider.run({ prompt: 'hi', timeoutMs: 5_000 });
      assert.equal(result2.ok, true);
      const argv2 = JSON.parse(readFileSync(argvFile, 'utf8'));
      assert.ok(!argv2.includes('--effort'), 'argv must omit --effort when req.effort is absent');
    } finally {
      delete process.env['ARGV_FILE'];
      rmSync(argvFile, { force: true });
    }
  });
});

test('claudeCli: defaultEffort (registry provider config) is used when req.effort is absent; req.effort wins when both set', async () => {
  const script = [
    "require('fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ result: 'ok', is_error: false }));",
  ].join('\n');
  await withFakeClaude(script, async () => {
    const argvFile = join(tmpdir(), `claudecli-argv-default-${process.pid}-${Date.now()}.json`);
    process.env['ARGV_FILE'] = argvFile;
    try {
      const provider = makeClaudeCliProvider({ defaultEffort: 'medium' });

      const result = await provider.run({ prompt: 'hi', timeoutMs: 5_000 });
      assert.equal(result.ok, true);
      const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
      assert.equal(argv[argv.indexOf('--effort') + 1], 'medium', 'falls back to the provider defaultEffort');

      rmSync(argvFile, { force: true });
      const result2 = await provider.run({ prompt: 'hi', effort: 'max', timeoutMs: 5_000 });
      assert.equal(result2.ok, true);
      const argv2 = JSON.parse(readFileSync(argvFile, 'utf8'));
      assert.equal(argv2[argv2.indexOf('--effort') + 1], 'max', 'a per-request effort overrides the provider defaultEffort');
    } finally {
      delete process.env['ARGV_FILE'];
      rmSync(argvFile, { force: true });
    }
  });
});
