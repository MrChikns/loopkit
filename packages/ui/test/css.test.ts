import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { generateTokensCss } from '../src/tokens/css.ts';
import { themes } from '../src/tokens/semantic.ts';

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

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

test('authored primary action and status token pairs meet WCAG AA text contrast', () => {
  for (const [themeName, theme] of Object.entries(themes)) {
    assert.ok(
      contrastRatio(theme.base.inverse, theme.base.accent) >= 4.5,
      `${themeName} inverse/accent must remain readable`,
    );
    for (const [state, tokens] of Object.entries(theme.state)) {
      assert.ok(
        contrastRatio(tokens.fg, tokens.bg) >= 4.5,
        `${themeName} ${state} foreground/background must remain readable`,
      );
    }
  }
});

test('component stylesheet gives text actions visible focus and 24px targets', async () => {
  const css = await readFile(resolve(here, '../src/styles/components.css'), 'utf8');
  assert.match(css, /\.opsui-root a:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.opsui-root summary \{ min-height: 24px; \}/);
  assert.match(css, /\.opsui-eventrow__metaitem--link,[\s\S]*min-height: 24px;/);
  assert.match(css, /\.opsui-provenance__chip \{[\s\S]*min-height: 24px;/);
});

test('mobile top bar protects long page titles from action overlap', async () => {
  const css = await readFile(resolve(here, '../src/styles/components.css'), 'utf8');
  assert.match(css, /\.opsui-topbar__lead \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.opsui-topbar__title \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(css, /\.opsui-topbar__actions \{[^}]*flex: 0 0 auto;/);
  assert.match(
    css,
    /@media \(max-width: 640px\), \(max-height: 500px\) \{[\s\S]*\.opsui-topbar__crumb,[\s\S]*\.opsui-topbar__kbd \{ display: none; \}/,
  );
});
