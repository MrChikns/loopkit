import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { generateTokensCss } from '../src/tokens/css.ts';

const here = dirname(fileURLToPath(import.meta.url));
const canonicalPath = resolve(here, '../canonical/tokens.css');

test('generated CSS reproduces canonical/tokens.css byte-for-byte', async () => {
  const canonical = await readFile(canonicalPath, 'utf8');
  assert.equal(generateTokensCss(), canonical);
});

test('generated CSS defines dark root and light override', () => {
  const css = generateTokensCss();
  assert.match(css, /:root \{\s*\n\s*color-scheme: dark;/);
  assert.match(css, /html\[data-theme="light"\] \{\s*\n\s*color-scheme: light;/);
});

test('every operational state emits fg/bg/border/tab variables', () => {
  const css = generateTokensCss();
  for (const state of ['success', 'warning', 'critical', 'info', 'progress', 'neutral']) {
    for (const facet of ['fg', 'bg', 'border', 'tab']) {
      assert.ok(css.includes(`--${state}-${facet}:`), `missing --${state}-${facet}`);
    }
  }
});

test('component/layout tokens only appear in the dark root', () => {
  const css = generateTokensCss();
  assert.equal(css.match(/--r-card:/g)?.length, 1);
  assert.equal(css.match(/--rail-compact-width:/g)?.length, 1);
});
