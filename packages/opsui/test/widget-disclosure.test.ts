import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsPath = resolve(here, '../public/opsui-widgets.js');
const cssPath = resolve(here, '../public/opsui-widgets.css');
const componentsCssPath = resolve(here, '../src/styles/components.css');

test('widget disclosure defaults open and persists per-page card state', async () => {
  const js = await readFile(jsPath, 'utf8');
  assert.match(js, /opsui\.widgets\.v1:/);
  assert.match(js, /window\.location\.pathname/);
  assert.match(js, /hasOwnProperty\.call\(state, key\) \? state\[key\] !== false : true/);
  assert.match(js, /window\.localStorage\.setItem/);
});

test('widget headers and the page-wide control share one expansion path', async () => {
  const js = await readFile(jsPath, 'utf8');
  assert.match(js, /data-opsui-widget-toggle/);
  assert.match(js, /toggleAll\.addEventListener\('click'/);
  assert.match(js, /setExpanded\(widget, shouldExpand, true\)/);
  assert.match(js, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(js, /interactive && interactive !== header/, 'the header itself must not be mistaken for an interactive child');
  assert.match(js, /new MutationObserver/, 'live card replacements must rejoin the disclosure system');
});

test('widget disclosure has visible keyboard focus and collapsed-state styling', async () => {
  const css = await readFile(cssPath, 'utf8');
  assert.match(css, /\.opsui-widget-controls__button:focus-visible/);
  assert.match(css, /\[data-opsui-widget-state="collapsed"\]/);
  assert.match(css, /cursor:\s*pointer/);
  assert.match(
    css,
    /\.opsui-card\[data-opsui-widget-ready\]\s*>\s*\.opsui-card__header\s*\{[^}]*display:\s*grid/s,
    'expanded and collapsed headers share the same grid contract',
  );
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+16px/);
  assert.match(css, /@media \(max-width:\s*760px\)/);
  assert.match(css, /grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /justify-self:\s*end/);
});

test('card header aside keeps badges and filters in one right-aligned controls cluster', async () => {
  const css = await readFile(componentsCssPath, 'utf8');
  const asideRule = css.match(/\.opsui-card__aside\s*\{([^}]*)\}/s);
  assert.ok(asideRule, 'shared card CSS defines the header controls cluster');
  assert.match(asideRule[1], /display:\s*flex/);
  assert.match(asideRule[1], /align-items:\s*center/);
  assert.match(asideRule[1], /justify-content:\s*flex-end/);
  assert.match(asideRule[1], /gap:\s*8px/);
  assert.match(asideRule[1], /margin-left:\s*auto/);
});
