// WI-204 — the plane-halted notice on the design-system IntentComposer.
//
// `@loopkit/ui` and `@loopkit/opsui` carry deliberately separate copies of this component (the
// ui one is app-agnostic: it takes a resolved `capturedHref` and knows no routes). Both back a
// LIVE intent surface in the console — this one through the legacy `page()` shell — so the
// halted warning has to exist in both, and the same content contract is asserted in both so the
// two copies cannot quietly drift apart on what the notice teaches.
//
// The asymmetry is the point: halted warns at the door, armed says nothing at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IntentComposer, IntentComposerModal } from '../src/components/IntentComposer.ts';

const ACTION = '/intent';

/** The four things the notice must teach a first-time reader. Matched loosely enough to survive
 *  rewording, tightly enough to catch removal. */
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
  assert.match(html, /scheduler that launches the beats/i, 'arming belongs in the scheduler environment');
  assert.match(html, /LOOPKIT_HOME/, 'standalone arming must name the plane-home selector');
  assert.match(html, /\$LOOPKIT_HOME\/config\/loopkit\.json/, 'standalone config source must be explicit');
  assert.doesNotMatch(html, /\.ai\/loops\/config\.env/, 'must not assume an embedded repo layout');
});

test('IntentComposer: the notice never implies the halt expires or that running work stopped', () => {
  const html = IntentComposer({ action: ACTION, planeHalted: true });
  // The halt does not expire — no timeout, no auto-rearm, no countdown. (A "halted since <time>"
  // readout would be fine; anything implying it lapses is not.)
  assert.doesNotMatch(html, /expire|expires|time ?out|auto-?re-?arm|resumes? (in|after)|countdown/i,
    'the notice must not imply the halt lapses on its own');
  // The autonomy gate is checked ONCE at the top of each beat, and a build runs INSIDE its beat,
  // so halting takes on no NEW work but never aborts what is already running. An operator
  // watching a live build must not read this notice as a contradiction.
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
  const modal = IntentComposerModal({ action: ACTION, planeHalted: true });
  assert.match(modal, /opsui-composer__halted/, 'the modal composer must carry the notice');
  assert.doesNotMatch(
    IntentComposerModal({ action: ACTION, planeHalted: false }),
    /opsui-composer__halted/,
    'an armed modal must stay quiet',
  );
});
