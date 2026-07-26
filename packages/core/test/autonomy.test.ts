/**
 * autonomy.test.ts — WI-204. The plane kill-switch predicate that BOTH beat gates and the
 * console's beats indicator resolve through.
 *
 * The bug this exists for: the console derived its execution-mode pill from sessions alone and
 * never read LOOPKIT_AUTONOMY, so a halted plane rendered "the background beats handle the queue
 * autonomously" while both beats no-opped at the gate on every fire. The fix only holds if the
 * surface and the gate agree on what "on" means — so these pin `isPlaneArmed` to the exact
 * coalescing chain `runReactor`/`runDispatch` run, including its quirks, rather than to a tidier
 * definition the beats do not implement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AUTONOMY_ENV_VAR, AUTONOMY_OFF, isPlaneArmed, resolveAutonomy } from '../src/autonomy.js';
import { makeEvent } from '../src/schema.js';
import { appendEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

test('resolveAutonomy: an explicit override wins, else env, else the fail-safe off', () => {
  assert.equal(resolveAutonomy('on', 'off'), 'off', 'override wins over env');
  assert.equal(resolveAutonomy('off', 'on'), 'on', 'override wins over env');
  assert.equal(resolveAutonomy('on', undefined), 'on', 'no override ⇒ env');
  assert.equal(resolveAutonomy(undefined, undefined), AUTONOMY_OFF, 'unset ⇒ off (fail-safe)');
  assert.equal(AUTONOMY_OFF, 'off', 'the gate compares against the literal "off"');
  assert.equal(AUTONOMY_ENV_VAR, 'LOOPKIT_AUTONOMY');
});

test('isPlaneArmed: UNSET is halted, never armed — the fail-safe the beat gates apply', () => {
  // The case that matters most: a first-time user who has never set the var. The gate no-ops,
  // so the surface must not claim the beats own their queue.
  assert.equal(isPlaneArmed({}), false, 'unset ⇒ halted');
  assert.equal(isPlaneArmed(undefined), false, 'no env bag at all ⇒ halted');
  assert.equal(isPlaneArmed({ LOOPKIT_AUTONOMY: 'off' }), false, 'explicit off ⇒ halted');
  assert.equal(isPlaneArmed({ LOOPKIT_AUTONOMY: 'on' }), true, 'on ⇒ armed');
});

test('isPlaneArmed: only the literal "off" halts — matching the gate exactly, quirks included', () => {
  // `runReactor`/`runDispatch` gate on `autonomy === 'off'`, so ANY other non-undefined value
  // runs the beats. That is arguably too loose, but the pill's job is to report what the gate
  // will actually do, not what it ought to do — a pill that disagrees is worse than no pill.
  // If the gate is ever tightened, this test fails and the pill gets tightened with it.
  for (const val of ['on', 'ON', 'true', '1', 'yes', 'banana', 'Off', ' off', '']) {
    assert.equal(
      isPlaneArmed({ LOOPKIT_AUTONOMY: val }),
      resolveAutonomy(val) !== AUTONOMY_OFF,
      `isPlaneArmed must track the gate's own chain for ${JSON.stringify(val)}`,
    );
  }
  assert.equal(isPlaneArmed({ LOOPKIT_AUTONOMY: 'Off' }), true, 'the gate is case-SENSITIVE — so is the pill');
  assert.equal(isPlaneArmed({ LOOPKIT_AUTONOMY: '' }), true, 'empty-but-set is not undefined, so the gate runs');
});

// ---------------------------------------------------------------------------
// The equivalence that actually matters: the surface predicate vs. the REAL gates
// ---------------------------------------------------------------------------

let tmpCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-autonomy-${process.pid}-${++tmpCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function makeFakeProvider(): LlmProvider {
  return {
    name: 'fake',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text: 'fake-reply', usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}
function makeTestConfig(): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
  };
}

/** Run one beat with LOOPKIT_AUTONOMY set to `val` (or deleted when undefined) and report
 *  whether it returned the autonomy-gate no-op. `opts.autonomy` is deliberately NOT passed, so
 *  the beat resolves the env exactly as it does in production. */
async function beatsNoOpped(val: string | undefined): Promise<{ reactor: boolean; dispatch: boolean }> {
  const saved = process.env[AUTONOMY_ENV_VAR];
  if (val === undefined) delete process.env[AUTONOMY_ENV_VAR];
  else process.env[AUTONOMY_ENV_VAR] = val;
  // The unset case writes a fail-safe warning to stderr; swallow it so the test output stays clean.
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'do something' }),
    ]);
    const base = { repoRoot, ledgerDir, provider: makeFakeProvider(), config: makeTestConfig(), dryRun: true };
    const r = await runReactor({ ...base });
    const d = await runDispatch({ ...base });
    return {
      reactor: r.steps[0]?.step === 'autonomy-gate' && r.steps[0]?.detail?.includes('LOOPKIT_AUTONOMY=off') === true,
      dispatch: d.detail === 'LOOPKIT_AUTONOMY=off — no-op',
    };
  } finally {
    (process.stderr as unknown as { write: (s: string) => boolean }).write = origWrite;
    if (saved === undefined) delete process.env[AUTONOMY_ENV_VAR]; else process.env[AUTONOMY_ENV_VAR] = saved;
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
}

/**
 * THE anti-drift test for WI-204. The console's halted warning is only trustworthy if it fires
 * exactly when the beats actually refuse new work. Rather than sharing a constant with the gates
 * (which a future inline rewrite would silently escape), this drives the REAL `runReactor` and
 * `runDispatch` over the whole env matrix and asserts, per value, that the beat no-opped iff
 * `isPlaneArmed` said halted. If anyone changes what the gate accepts, this fails and the
 * surface predicate has to be changed with it.
 */
test('isPlaneArmed agrees with the REAL reactor/dispatch gates for every env value', async () => {
  const values: Array<string | undefined> = [undefined, '', 'off', 'on', 'ON', 'Off', 'true', 'banana'];
  const seenArmed = new Set<boolean>();
  for (const val of values) {
    const armed = isPlaneArmed(val === undefined ? {} : { [AUTONOMY_ENV_VAR]: val });
    const actual = await beatsNoOpped(val);
    const label = val === undefined ? '<unset>' : JSON.stringify(val);
    assert.equal(actual.reactor, !armed, `reactor gate disagrees with isPlaneArmed for ${label}`);
    assert.equal(actual.dispatch, !armed, `dispatch gate disagrees with isPlaneArmed for ${label}`);
    seenArmed.add(armed);
  }
  // Guard the guard: if every value in the matrix came out the same way, the equivalence above
  // holds vacuously and would keep passing while the predicate rotted. Both outcomes must occur.
  assert.deepEqual([...seenArmed].sort(), [false, true], 'the matrix must exercise BOTH armed and halted');
});
