// WI-204 — the plane-halted notice, and the deliberate asymmetry around it.
//
// The defect: the console derived its execution-mode indicator from sessions alone and never
// read the autonomy gate, so a halted plane rendered "the background reactor/dispatch beats
// handle the queue autonomously" while both beats no-opped at the gate on every fire. Because
// the gate FAILS SAFE — an unset LOOPKIT_AUTONOMY defaults to OFF — the surface lied hardest to
// a first-time reader of the public repo, who had never armed anything.
//
// The fix is asymmetric on purpose:
//   · HALTED warns at the intent box, because that is where a dropped intent silently fails to
//     be picked up. It must EXPLAIN itself, not just colour a word.
//   · ARMED adds nothing to the composer. It is the normal state and it stays quiet; it is
//     reported as a state on the ops observability page instead.
//
// These pin the CONTENT contract (the four things the notice must teach) rather than exact
// prose, so a copy edit stays free while a silent gutting of the explanation fails.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IntentComposer, IntentComposerModal } from '../src/components/IntentComposer.ts';
import { TopBar } from '../src/components/TopBar.ts';
import { PlaneObservabilityProjection } from '../src/projections/plane-observability-projection.ts';
import { planeObservabilityProjectionFromInput } from '../src/projections/plane-observability-adapter.ts';

const ACTION = '/intent?next=/command';

/** The four things the notice must teach a first-time reader, per WI-204. Each is a property of
 *  the copy, matched loosely enough to survive rewording and tightly enough to catch removal. */
const REQUIRED_TEACHING: Array<[string, RegExp]> = [
  ['what happens to the intent you are dropping', /captured|recorded|waits? in the queue/i],
  ['that in-flight work is NOT aborted', /already running|in flight|does not abort/i],
  ['that attended/CLI work is unaffected', /attended|CLI work/i],
  ['how to change it', /LOOPKIT_AUTONOMY=on/],
];

test('IntentComposer: halted renders a notice that explains itself', () => {
  const html = IntentComposer({ action: ACTION, planeHalted: true });
  assert.match(html, /opsui-composer__halted/, 'expected the halted notice');
  const seen = new Set<string>();
  for (const [what, re] of REQUIRED_TEACHING) {
    assert.match(html, re, `the halted notice must say: ${what}`);
    seen.add(what);
  }
  assert.equal(seen.size, REQUIRED_TEACHING.length, 'every teaching point must be exercised');
});

test('IntentComposer: the notice never implies the halt expires or that running work stopped', () => {
  const html = IntentComposer({ action: ACTION, planeHalted: true });
  // Halt does not expire — no timeout, no auto-rearm, no countdown (founder decision). A
  // "halted since <time>" READOUT would be fine; anything implying it lapses is not.
  assert.doesNotMatch(html, /expire|expires|time ?out|auto-?re-?arm|resumes? (in|after)|countdown/i,
    'the notice must not imply the halt lapses on its own');
  // And it must not claim in-flight work stopped: the gate is checked ONCE at the top of each
  // beat and a build runs INSIDE its beat, so an operator watching a live build must not read
  // this as a contradiction.
  assert.doesNotMatch(html, /aborts? (any|all|the) (running|in-flight)|kills? (the )?build|stops? everything/i,
    'the notice must not claim running work was aborted');
  assert.match(html, /continues/i, 'the notice must state that running work continues');
});

test('IntentComposer: armed and default are SILENT — the normal state adds no chrome', () => {
  for (const [what, html] of [
    ['explicitly armed', IntentComposer({ action: ACTION, planeHalted: false })],
    ['prop omitted', IntentComposer({ action: ACTION })],
  ] as Array<[string, string]>) {
    assert.doesNotMatch(html, /opsui-composer__halted/, `${what}: must render no notice`);
    assert.doesNotMatch(html, /halted|armed|kill switch/i, `${what}: must not mention the gate at all`);
    // The composer itself must still be intact — silence is not breakage.
    assert.match(html, /opsui-composer__input/, `${what}: the input must still render`);
    assert.match(html, /Drop intent/, `${what}: the label must still render`);
  }
});

test('IntentComposer: the notice sits above the input, and rides the modal too', () => {
  const html = IntentComposer({ action: ACTION, planeHalted: true });
  assert.ok(
    html.indexOf('opsui-composer__halted') < html.indexOf('opsui-composer__input'),
    'the notice must precede the textarea — a warning below the box is read after the act',
  );
  // The modal is the global "drop intent" entry point on every ops page, so the warning has to
  // travel with it, not just with the inline form.
  const modal = IntentComposerModal({ action: ACTION, planeHalted: true });
  assert.match(modal, /opsui-composer__halted/, 'the modal composer must carry the notice');
  assert.doesNotMatch(
    IntentComposerModal({ action: ACTION, planeHalted: false }),
    /opsui-composer__halted/,
    'an armed modal must stay quiet',
  );
});

test('TopBar: halted is a critical blocking tag between the title and global actions; armed stays quiet', () => {
  const halted = TopBar({
    title: 'Command',
    status: { state: 'critical', label: 'Plane halted', emphasis: 'blocking', size: 'sm' },
  });
  assert.match(halted, /opsui-topbar__status/);
  assert.match(halted, /opsui-status--critical/);
  assert.match(halted, /opsui-status--blocking/);
  assert.ok(
    halted.indexOf('opsui-topbar__title') <
      halted.indexOf('opsui-topbar__status') &&
      halted.indexOf('opsui-topbar__status') <
      halted.indexOf('data-opsui-shell="composer-open"'),
    'the halted tag must sit between title and global actions',
  );
  assert.doesNotMatch(TopBar({ title: 'Command' }), /opsui-topbar__status|Plane halted/);
});

// ---------------------------------------------------------------------------
// The armed half — reported on the ops page, and ONLY there
// ---------------------------------------------------------------------------

function observabilityHtml(planeArmed: boolean | undefined): string {
  const input = {
    generatedAt: '2026-07-25T12:00:00.000Z',
    costs: null, budget: {}, verdicts: null, repairs: [], trajectory: null,
    activeItems: [], tokenRows: [], trendPoints: [], transcriptSizes: [],
    acceptSplit: null, providerStatus: null, salvageFiles: [],
    manifestCoverage: null, ledgerHygiene: null, routing: null,
    ...(planeArmed === undefined ? {} : { planeArmed }),
  };
  return PlaneObservabilityProjection(planeObservabilityProjectionFromInput(input, { ledgerSequence: 0 }));
}

test('observability: the autonomy gate is reported as a state — armed, halted, and unknown', () => {
  const seen = new Set<string>();

  const armed = observabilityHtml(true);
  assert.match(armed, /Autonomy \(kill switch\)/, 'armed: expected the autonomy region');
  assert.match(armed, /opsui-status--success/, 'armed: must read as healthy here');
  assert.match(armed, />armed</, 'armed: expected the armed label');
  seen.add('armed');

  const halted = observabilityHtml(false);
  assert.match(halted, />halted</, 'halted: expected the halted label');
  assert.match(halted, /opsui-status--critical/, 'halted: must use the same critical stop-state as the global header');
  assert.match(halted, /opsui-status--blocking/, 'halted: must not rely on colour alone');
  // It explains itself here too, and with the same precision about the boundary.
  assert.match(halted, /no new work is taken on/i, 'halted: must say new work is not taken on');
  assert.match(halted, /already running continues/i, 'halted: must say running work continues');
  assert.match(halted, /no timeout, no auto-rearm/i, 'halted: must not imply the halt lapses');
  assert.match(halted, /LOOPKIT_AUTONOMY=on/, 'halted: must name the fix');
  seen.add('halted');

  // An absent reading is UNKNOWN. Defaulting it to "armed" would be the same flattering guess
  // this item exists to remove.
  const unknown = observabilityHtml(undefined);
  assert.match(unknown, /not reported/i, 'unknown: must say so');
  assert.doesNotMatch(unknown, />armed</, 'unknown: must never claim armed');
  seen.add('unknown');

  assert.deepEqual([...seen].sort(), ['armed', 'halted', 'unknown'],
    'all three autonomy readings must be exercised');
});
