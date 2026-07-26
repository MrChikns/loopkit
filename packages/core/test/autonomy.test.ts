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

import {
  AUTONOMY_ENV_VAR, AUTONOMY_OFF, AUTONOMY_ON, autonomyWarning, isPlaneArmed, resolveAutonomy,
  resolveAutonomyDecision,
} from '../src/autonomy.js';
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
  assert.equal(AUTONOMY_OFF, 'off');
  assert.equal(AUTONOMY_ON, 'on');
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

/**
 * WI-207. The gate used to be a bare `=== 'off'` against a lowercase literal, so `off` halted,
 * UNSET halted, and EVERYTHING ELSE ARMED — `OFF`, `Off`, `''` and `banana` included. An operator
 * who wrote `LOOPKIT_AUTONOMY=OFF` got a plane that kept picking up work, building and merging.
 *
 * The allowlist is stated here as an explicit table rather than as `resolveAutonomy(val) !==
 * AUTONOMY_OFF` (which the old version of this test did): mirroring the implementation's own
 * expression made the assertion true by construction, so it would have kept passing through
 * exactly the defect it was supposed to describe. Every row below is authored by hand.
 */
const ALLOWLIST_TABLE: Array<{ val: string; armed: boolean; warns: boolean }> = [
  // Recognised — the only two that resolve without complaint.
  { val: 'on', armed: true, warns: false },
  { val: 'ON', armed: true, warns: false },
  { val: 'On', armed: true, warns: false },
  { val: ' on ', armed: true, warns: false },
  { val: 'off', armed: false, warns: false },
  { val: 'OFF', armed: false, warns: false },   // THE bug: this used to ARM the plane.
  { val: 'Off', armed: false, warns: false },   // ditto
  { val: ' off ', armed: false, warns: false },
  // Unrecognised — halt, and say so with the value. Someone who meant to arm loses one edit;
  // someone who meant to halt loses nothing. Only the second mistake is unrecoverable.
  { val: '', armed: false, warns: true },
  { val: 'banana', armed: false, warns: true },
  { val: 'true', armed: false, warns: true },
  { val: '1', armed: false, warns: true },
  { val: 'yes', armed: false, warns: true },
  { val: 'no', armed: false, warns: true },
  { val: 'offf', armed: false, warns: true },
  { val: '   ', armed: false, warns: true },
];

test('resolveAutonomy: a STRICT allowlist — only on/off are recognised, everything else halts (WI-207)', () => {
  for (const row of ALLOWLIST_TABLE) {
    const decision = resolveAutonomyDecision(row.val);
    assert.equal(
      decision.autonomy, row.armed ? AUTONOMY_ON : AUTONOMY_OFF,
      `${JSON.stringify(row.val)} must resolve ${row.armed ? 'ON' : 'OFF'}`,
    );
    assert.equal(
      decision.reason, row.warns ? 'unrecognised' : 'recognised',
      `${JSON.stringify(row.val)} reason`,
    );
    assert.equal(
      isPlaneArmed({ [AUTONOMY_ENV_VAR]: row.val }), row.armed,
      `isPlaneArmed disagrees with the allowlist for ${JSON.stringify(row.val)}`,
    );
  }
});

test('autonomyWarning: an unrecognised value is reported LOUDLY, naming the value (WI-207)', () => {
  // Silence is what made the original defect invisible: the operator had no signal at all that
  // the value they set meant nothing. The value must appear in the line so the fix is one edit.
  for (const row of ALLOWLIST_TABLE) {
    const warning = autonomyWarning(resolveAutonomyDecision(row.val));
    if (!row.warns) {
      assert.equal(warning, null, `${JSON.stringify(row.val)} is recognised — nothing to warn about`);
      continue;
    }
    assert.ok(warning, `${JSON.stringify(row.val)} must warn`);
    assert.match(warning!, /is not recognised/, 'the warning must say the value was not recognised');
    assert.match(warning!, /defaulting to OFF/, 'the warning must state which way it failed');
    assert.ok(
      warning!.includes(JSON.stringify(row.val)),
      `the warning must NAME the offending value; got: ${warning}`,
    );
  }

  // The unset case keeps its own, long-standing wording — it is a different operator situation
  // (nothing was ever configured) and the existing shims/docs quote this line.
  const unset = autonomyWarning(resolveAutonomyDecision(undefined));
  assert.ok(unset);
  assert.match(unset!, /LOOPKIT_AUTONOMY unset — defaulting to OFF \(fail-safe\)/);
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
 *  whether it returned the autonomy-gate no-op, plus everything it wrote to stderr.
 *  `opts.autonomy` is deliberately NOT passed, so the beat resolves the env exactly as it does
 *  in production — the warning captured here is the real one an operator would see. */
async function beatsNoOpped(val: string | undefined): Promise<{ reactor: boolean; dispatch: boolean; stderr: string }> {
  const saved = process.env[AUTONOMY_ENV_VAR];
  if (val === undefined) delete process.env[AUTONOMY_ENV_VAR];
  else process.env[AUTONOMY_ENV_VAR] = val;
  // Capture rather than discard: the fail-safe warnings are part of the contract under test, and
  // capturing also keeps the test output clean.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { captured += s; return true; };
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
      stderr: captured,
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
  // The whole allowlist table plus the unset case, driven through the real beats. `'OFF'` and
  // `' off '` are the rows that matter most: both used to ARM both beats.
  const values: Array<string | undefined> = [undefined, ...ALLOWLIST_TABLE.map(r => r.val)];
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

/**
 * WI-207: the halt must be AUDIBLE. A plane that silently refuses the value you set is a nicer
 * failure than one that silently arms, but it is still a bad one — so both beats are asserted to
 * emit the naming line themselves, not merely to resolve correctly in a pure function.
 */
test('the REAL beats warn on stderr for every unrecognised value, and stay quiet for recognised ones', async () => {
  for (const row of ALLOWLIST_TABLE) {
    const { stderr } = await beatsNoOpped(row.val);
    if (!row.warns) {
      assert.equal(stderr, '', `${JSON.stringify(row.val)} is recognised — the beats must not warn`);
      continue;
    }
    // Once per beat: an operator running either beat alone must still be told.
    const hits = stderr.split('\n').filter(l => l.includes('is not recognised')).length;
    assert.equal(hits, 2, `both beats must warn for ${JSON.stringify(row.val)}; got: ${JSON.stringify(stderr)}`);
    assert.ok(
      stderr.includes(JSON.stringify(row.val)),
      `the beats' warning must NAME the offending value; got: ${JSON.stringify(stderr)}`,
    );
  }

  const unsetRun = await beatsNoOpped(undefined);
  assert.match(unsetRun.stderr, /LOOPKIT_AUTONOMY unset — defaulting to OFF \(fail-safe\)/);
  assert.doesNotMatch(unsetRun.stderr, /is not recognised/, 'unset is not the same situation as a typo');
});
