// WI-067 regression coverage — founder-reported bug: on the Missions (/work) page the
// mobile bottom nav sat visibly off the true screen bottom, while every other page showed
// it flush. Root cause: `.opsui-shell` is a CSS grid with no `align-items` (default
// `stretch`), so `.opsui-bottomnav` — a direct grid-item sibling of the workspace column —
// stretched to the tallest sibling's height. `position: sticky; bottom: 0` then stuck
// within that (possibly page-length-tall) box, not the viewport, so it only reached the
// true bottom once scrolled all the way down. Missions is the tallest page (WI-350 folded
// the former Workers sections into it), so it was the only page long enough to expose the
// otherwise-universal defect.
//
// Fix: `position: fixed` (viewport-relative, sidesteps the grid-track/stretch interaction
// entirely) + a matching `.opsui-shell` padding-bottom so scrolled content clears the now-
// fixed bar. This mirrors the fix already shipped in the sibling `@loopkit/ui` package's
// components.css — these assertions read the raw CSS text (not rendered HTML) because the
// bug was a positioning-model defect, invisible to any HTML-shape assertion.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../src/styles/components.css');

async function mobileNavBlock(): Promise<string> {
  const css = await readFile(cssPath, 'utf8');
  const start = css.indexOf('@media (max-width: 640px), (max-height: 500px)');
  assert.ok(start >= 0, 'expected the mobile BottomNav breakpoint block to exist');
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

test('.opsui-bottomnav is fixed to the viewport on mobile, not sticky within its grid track', async () => {
  const block = await mobileNavBlock();
  const navRule = block.slice(block.indexOf('.opsui-bottomnav {'));
  // Strip /* ... */ comments before asserting — the fix's own explanatory comment
  // discusses the old (buggy) `position: sticky` in prose, which would otherwise
  // false-fail the "must not use sticky" check below.
  const declarationsOnly = navRule.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(declarationsOnly, /position:\s*fixed/, 'bottomnav must be position: fixed, not sticky — sticky sticks within the grid-stretched box, not the viewport (WI-067)');
  assert.doesNotMatch(declarationsOnly, /position:\s*sticky/);
  assert.match(declarationsOnly, /bottom:\s*0/);
  assert.match(declarationsOnly, /left:\s*0/);
  assert.match(declarationsOnly, /right:\s*0/);
});

test('.opsui-shell reserves bottom padding matching the fixed bottomnav on mobile', async () => {
  const block = await mobileNavBlock();
  const shellRule = block.slice(block.indexOf('.opsui-shell {'), block.indexOf('}') + 1);
  assert.match(
    shellRule,
    /padding-bottom:\s*calc\(64px \+ env\(safe-area-inset-bottom\)\)/,
    'shell must reserve room for the fixed bottomnav so scrolled content is not hidden behind it',
  );
});
