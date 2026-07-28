import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const packageRoot = resolve(process.cwd());

test('console README names the current canonical route and action surface', async () => {
  const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8');
  for (const route of [
    '/command',
    '/work',
    '/acceptance',
    '/health',
    '/company',
    '/observability',
    '/threads',
    '/activity',
    '/item/<WI-NNN>',
  ]) {
    assert.ok(readme.includes(`\`${route}\``), `README must document ${route}`);
  }
  assert.match(
    readme,
    /`\/activity`[^.\n]*canonical paginated global ledger history/i,
    'README must name /activity as the canonical global history',
  );
  assert.match(
    readme,
    /`\/timeline`[^.\n]*compatibility-only[\s\S]{0,180}global route redirects to `\/activity`/i,
    'README must describe global /timeline as a compatibility redirect to /activity',
  );
  assert.match(
    readme,
    /`\/timeline\?item=WI-NNN` redirects to the canonical `\/item\/WI-NNN` hub/i,
    'README must keep item-specific history on the canonical item hub',
  );
  assert.doesNotMatch(
    readme,
    /`\/timeline`[^.\n]*(?:most recent|cross-item ledger events)/i,
    'README must not claim /timeline is still a rendered global history',
  );
  for (const action of [
    'approve',
    'reject',
    'accept',
    'reply',
    'feedback',
    'stop',
    'hold',
    'resume',
    'requeue',
    'escalate',
    'dismiss',
  ]) {
    assert.ok(
      readme.includes(`\`POST /item/<id>/${action}\``),
      `README must document the ${action} action`,
    );
  }
  assert.doesNotMatch(readme, /four (?:read )?views|four (?:operator |write )?verbs/i);
  assert.match(readme, /no third-party runtime dependencies/i);
  assert.doesNotMatch(readme, /zero runtime dependencies/i);
});

test('package description does not repeat the retired four-view/four-verb claim', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
  ) as { description?: string };
  assert.match(packageJson.description ?? '', /server-rendered loopkit ledger projections/i);
  assert.doesNotMatch(packageJson.description ?? '', /four views|four (?:operator )?verbs/i);
});
