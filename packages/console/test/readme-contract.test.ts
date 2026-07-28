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
    '/timeline',
    '/activity',
    '/item/<WI-NNN>',
  ]) {
    assert.ok(readme.includes(`\`${route}\``), `README must document ${route}`);
  }
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
});

test('package description does not repeat the retired four-view/four-verb claim', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
  ) as { description?: string };
  assert.match(packageJson.description ?? '', /server-rendered loopkit ledger projections/i);
  assert.doesNotMatch(packageJson.description ?? '', /four views|four (?:operator )?verbs/i);
});
