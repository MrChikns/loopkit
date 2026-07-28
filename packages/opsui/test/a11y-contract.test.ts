import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Card } from '../src/components/Card.ts';
import { CommandPalette } from '../src/components/CommandPalette.ts';
import { EventRow } from '../src/components/EventRow.ts';
import { TopBar } from '../src/components/TopBar.ts';
import { themes } from '../src/tokens/semantic.ts';

const here = dirname(fileURLToPath(import.meta.url));

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

test('duplicated shell components preserve accessible names and heading hierarchy', () => {
  const palette = CommandPalette({ open: true });
  assert.match(
    palette,
    /role="combobox"[^>]*aria-label="Search commands and destinations"/,
  );

  const page =
    TopBar({ title: 'Work' }) +
    Card({
      title: 'Waiting',
      body: EventRow({ state: 'neutral', title: 'Dependency', metadata: [] }),
    });
  assert.deepEqual(
    [...page.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1])),
    [1, 2, 3],
  );
});

test('opsui source tokens keep action and state contrast above WCAG AA', () => {
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

test('opsui stylesheet gives text actions visible focus and 24px targets', async () => {
  const css = await readFile(resolve(here, '../src/styles/components.css'), 'utf8');
  assert.match(css, /\.opsui-root a:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.opsui-root summary \{ min-height: 24px; \}/);
  assert.match(css, /\.opsui-eventrow__metaitem--link,[\s\S]*min-height: 24px;/);
  assert.match(css, /\.opsui-provenance__chip \{[\s\S]*min-height: 24px;/);
});
