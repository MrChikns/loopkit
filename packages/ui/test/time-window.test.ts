// time-window.test.ts — the shared `?window=` grammar: curated presets, arbitrary
// Nm/Nh/Nd durations typed straight into the URL, and garbage falling back instead of
// throwing. Also covers the WindowPicker's configurable option set / query param, since the
// chips and the parser must stay two faces of the same grammar.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseTimeWindow,
  windowCutoffMs,
  FOLLOW_WINDOW_OPTIONS,
  FAST_WINDOW_OPTIONS,
} from '../src/time-window.ts';
import { WindowPicker } from '../src/components/WindowPicker.ts';

test('parseTimeWindow: every curated preset parses to its own key', () => {
  for (const key of [...FOLLOW_WINDOW_OPTIONS, ...FAST_WINDOW_OPTIONS]) {
    const spec = parseTimeWindow(key, '24h');
    assert.equal(spec.key, key);
  }
});

test('parseTimeWindow: preset durations carry the right milliseconds', () => {
  assert.equal(parseTimeWindow('5m', '24h').ms, 5 * 60_000);
  assert.equal(parseTimeWindow('1h', '24h').ms, 3_600_000);
  assert.equal(parseTimeWindow('24h', '7d').ms, 24 * 3_600_000);
  assert.equal(parseTimeWindow('7d', '24h').ms, 7 * 86_400_000);
  assert.equal(parseTimeWindow('30d', '24h').ms, 30 * 86_400_000);
});

test('parseTimeWindow: "all" means unbounded (ms null, all-time label)', () => {
  const spec = parseTimeWindow('all', '24h');
  assert.equal(spec.ms, null);
  assert.equal(spec.label, 'all-time');
  assert.equal(windowCutoffMs(spec, 1_000_000), null);
});

test('parseTimeWindow: a custom 45m duration parses even though no chip offers it', () => {
  const spec = parseTimeWindow('45m', '24h');
  assert.equal(spec.key, '45m');
  assert.equal(spec.ms, 45 * 60_000);
  assert.equal(spec.label, 'last 45m');
});

test('parseTimeWindow: garbage rejected — falls back to the given default', () => {
  for (const garbage of ['bogus', '', '0m', '-5h', '5w', '1.5h', 'm', '99999999d', '24H']) {
    const spec = parseTimeWindow(garbage, '7d');
    assert.equal(spec.key, '7d', `expected fallback for ${JSON.stringify(garbage)}`);
  }
  assert.equal(parseTimeWindow(null, '7d').key, '7d');
  assert.equal(parseTimeWindow(undefined, '7d').key, '7d');
});

test('parseTimeWindow: an invalid fallback still resolves (24h last resort), never throws', () => {
  const spec = parseTimeWindow('nonsense', 'also-nonsense');
  assert.equal(spec.key, '24h');
});

test('windowCutoffMs: subtracts the window from now for bounded windows', () => {
  const spec = parseTimeWindow('1h', '24h');
  assert.equal(windowCutoffMs(spec, 10_000_000), 10_000_000 - 3_600_000);
});

test('WindowPicker: default options render the follow-the-picker preset with aria-current', () => {
  const html = WindowPicker({ active: '7d' });
  for (const key of FOLLOW_WINDOW_OPTIONS) {
    assert.ok(html.includes(`?window=${key}`), `missing chip ${key}`);
  }
  assert.match(html, /aria-current="true"[^>]*>7d</);
});

test('WindowPicker: custom options + param render chips on that param only', () => {
  const html = WindowPicker({ active: '1h', options: FAST_WINDOW_OPTIONS, param: 'cache' });
  assert.ok(html.includes('?cache=5m'));
  assert.ok(html.includes('?cache=1h'));
  assert.ok(html.includes('?cache=24h'));
  assert.ok(!html.includes('?window='));
});

test('WindowPicker: extraQuery is preserved on every chip href', () => {
  const html = WindowPicker({ active: '24h', extraQuery: 'theme=light' });
  assert.match(html, /\?window=24h&theme=light/);
  assert.match(html, /\?window=all&theme=light/);
});

test('WindowPicker: an unlisted active key (custom URL window) highlights nothing', () => {
  const html = WindowPicker({ active: '45m' });
  assert.ok(!html.includes('aria-current'));
});
