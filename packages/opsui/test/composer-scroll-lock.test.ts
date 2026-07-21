// WI-073 regression coverage — founder-reported bug: scrolling the page while the global
// "drop intent" dialog (IntentComposerModal, spec-correct `position: fixed`) is open makes the
// dialog itself appear to drift instead of staying anchored. The panel's own CSS was already
// right; the missing piece was a scroll-lock: nothing prevented the page underneath from
// scrolling while the dialog was up, and WebKit repaints fixed elements at scroll-end, so the
// panel visibly jumped mid-gesture. Fix: lock `document.body` scroll for the dialog's lifetime
// (open → hidden, close → restored). These assertions read the raw JS source (not a DOM) since
// there's no jsdom in this package's test setup — mirrors bottomnav-shell.test.ts's approach to
// a similar positioning-model defect.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsPath = resolve(here, '../public/opsui-shell.js');

async function functionBody(name: string): Promise<string> {
  const js = await readFile(jsPath, 'utf8');
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected a ${name}() function to exist`);
  const end = js.indexOf('\n  }', start);
  return js.slice(start, end);
}

test('openComposer locks page scroll after revealing the dialog', async () => {
  const body = await functionBody('openComposer');
  assert.match(body, /removeAttribute\('hidden'\)/);
  assert.match(body, /document\.body\.style\.overflow\s*=\s*'hidden'/, 'openComposer must lock body scroll so the fixed-position panel cannot appear to drift while the background scrolls (WI-073)');
});

test('closeComposer restores page scroll', async () => {
  const body = await functionBody('closeComposer');
  assert.match(body, /setAttribute\('hidden', ''\)/);
  assert.match(body, /document\.body\.style\.overflow\s*=\s*''/, 'closeComposer must release the scroll lock set by openComposer');
});
