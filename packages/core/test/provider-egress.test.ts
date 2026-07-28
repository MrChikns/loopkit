/**
 * Provider egress guard: high-confidence credential rules, fail-closed locality, and the
 * single-call-site invariant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  invokeProvider,
  scanProviderRequest,
  scanSecretRuleIds,
  SecretRuleId,
} from '../src/providers/egress.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { makeClaudeCliProvider } from '../src/providers/claudeCli.js';
import { makeCodexCliProvider } from '../src/providers/codexCli.js';
import { makeOllamaProvider } from '../src/providers/ollama.js';

const RULE_CASES: Array<[SecretRuleId, string]> = [
  ['private-key', ['-----BEGIN', 'PRIVATE', 'KEY-----\nnot-the-real-body'].join(' ')],
  ['private-key', ['-----BEGIN', 'ENCRYPTED PRIVATE', 'KEY-----\nnot-the-real-body'].join(' ')],
  ['private-key', ['-----BEGIN', 'OPENSSH PRIVATE', 'KEY-----\nnot-the-real-body'].join(' ')],
  ['private-key', ['-----BEGIN', 'PGP PRIVATE KEY', 'BLOCK-----\nnot-the-real-body'].join(' ')],
  ['openai-token', `sk-proj-${'A'.repeat(24)}7`],
  ['anthropic-token', `sk-ant-api03-${'B'.repeat(24)}8`],
  ['github-token', `ghp_${'C'.repeat(36)}`],
  ['gitlab-token', `glpat-${'D'.repeat(20)}9`],
  ['npm-token', `npm_${'E'.repeat(36)}`],
  ['slack-token', `xoxb-${'1'.repeat(12)}-${'F'.repeat(20)}`],
  ['stripe-live-secret', `sk_live_${'G'.repeat(20)}7`],
  ['google-api-key', `AIza${'H'.repeat(34)}7`],
  [
    'aws-access-key-pair',
    `AWS_ACCESS_KEY_ID=AKIA${'J'.repeat(16)}\nAWS_SECRET_ACCESS_KEY=${'k'.repeat(40)}`,
  ],
  ['secret-assignment', `api_key=${'a'.repeat(20)}7`],
];

for (const [ruleId, content] of RULE_CASES) {
  test(`credential scanner: detects ${ruleId}`, () => {
    assert.ok(scanSecretRuleIds(content).includes(ruleId));
  });
}

test('credential scanner: secret assignment covers bare and prefixed env/YAML/JSON key families', () => {
  const keys = [
    'api_key',
    'token',
    'secret',
    'password',
    'client_secret',
    'private_key',
    'session_token',
    'SERVICE_AUTH_TOKEN',
  ];
  for (const [index, key] of keys.entries()) {
    const separator = index % 2 === 0 ? '=' : ': ';
    const value = `RealValue${index}${'z'.repeat(18)}`;
    assert.ok(
      scanSecretRuleIds(`${JSON.stringify(key)}${separator}${JSON.stringify(value)}`).includes('secret-assignment'),
      `expected ${key} to be covered`,
    );
  }
});

test('credential scanner: ignores placeholders, redactions, variables, examples, and an unpaired AWS id', () => {
  const safeExamples = [
    'API_KEY=$API_KEY',
    'token=${TOKEN}',
    'secret=<redacted>',
    'password=redacted-value-12345',
    'client_secret=example-secret-value-123',
    'private_key=test-private-key-123456',
    'session_token=your-session-token-12345',
    `AWS_ACCESS_KEY_ID=AKIA${'Q'.repeat(16)}`,
  ];
  for (const content of safeExamples) {
    assert.deepEqual(scanSecretRuleIds(content), [], `placeholder should not block: ${content.split('=')[0]}`);
  }
});

test('request scanner: scans prompt and system and de-duplicates rule ids', () => {
  const token = `ghp_${'R'.repeat(36)}`;
  assert.deepEqual(
    scanProviderRequest({ prompt: token, system: `Never repeat ${token}` }),
    ['github-token'],
  );
});

function makeProvider(
  locality: LlmProvider['locality'],
  run: (req: ProviderRequest) => Promise<ProviderResult>,
): LlmProvider {
  return {
    name: locality === 'local' ? 'test-local' : 'test-external',
    ...(locality ? { locality } : {}),
    run,
  };
}

test('invokeProvider: external prompt hit blocks before provider.run and exposes ids only', async () => {
  const sentinel = `ghp_${'S'.repeat(36)}`;
  let calls = 0;
  const provider = makeProvider('external', async () => {
    calls++;
    return { ok: true, text: 'unexpected' };
  });

  const invocation = invokeProvider(provider, { prompt: `Review ${sentinel}` });
  assert.deepEqual(invocation.egressBlockedBy, ['github-token']);
  const result = await invocation;

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.code, 'egress-blocked');
  const serialized = JSON.stringify({ result, ids: invocation.egressBlockedBy });
  assert.ok(!serialized.includes(sentinel), 'blocked result must never contain the credential value');
  assert.ok(!serialized.includes('Review '), 'blocked result must never contain a request excerpt');
});

test('invokeProvider: external system hit blocks even when prompt is clean', async () => {
  let calls = 0;
  const provider = makeProvider('external', async () => {
    calls++;
    return { ok: true, text: 'unexpected' };
  });
  const result = await invokeProvider(provider, {
    prompt: 'Summarize safely',
    system: `SERVICE_PASSWORD=${'p'.repeat(20)}7`,
  });
  assert.equal(calls, 0);
  assert.equal(result.ok ? undefined : result.code, 'egress-blocked');
});

test('invokeProvider: only explicit local bypasses; missing locality fails closed as external', async () => {
  const secret = `glpat-${'T'.repeat(20)}7`;
  let localCalls = 0;
  const local = makeProvider('local', async () => {
    localCalls++;
    return { ok: true, text: 'local result' };
  });
  const localResult = await invokeProvider(local, { prompt: secret });
  assert.equal(localResult.ok, true);
  assert.equal(localCalls, 1);

  let unknownCalls = 0;
  const unknown = makeProvider(undefined, async () => {
    unknownCalls++;
    return { ok: true, text: 'unexpected' };
  });
  const unknownResult = await invokeProvider(unknown, { prompt: secret });
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownCalls, 0);
});

test('built-in provider locality: Claude/Codex are external and Ollama is local', () => {
  assert.equal(makeClaudeCliProvider().locality, 'external');
  assert.equal(makeCodexCliProvider().locality, 'external');
  assert.equal(makeOllamaProvider().locality, 'local');
});

test('invokeProvider: blocked detached request never calls run or fires onSpawn', async () => {
  let calls = 0;
  let spawned = false;
  const provider = makeProvider('external', async req => {
    calls++;
    req.onSpawn?.(4242);
    return { ok: true, text: 'unexpected' };
  });
  const result = await invokeProvider(provider, {
    prompt: `sk_live_${'U'.repeat(20)}7`,
    detached: true,
    onSpawn: () => { spawned = true; },
  });
  assert.equal(result.ok ? undefined : result.code, 'egress-blocked');
  assert.equal(calls, 0);
  assert.equal(spawned, false);
});

test('invokeProvider: clean external invocation preserves synchronous onSpawn timing', async () => {
  let spawned = false;
  const provider = makeProvider('external', req => {
    req.onSpawn?.(4242);
    return Promise.resolve({ ok: true, text: 'done' });
  });
  const invocation = invokeProvider(provider, {
    prompt: 'Implement the bounded change.',
    detached: true,
    onSpawn: () => { spawned = true; },
  });
  assert.equal(spawned, true);
  assert.equal((await invocation).ok, true);
});

test('provider source guard: production callers cannot bypass invokeProvider with direct .run(...)', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const allowed = new Set([
    join(srcRoot, 'providers', 'claudeCli.ts'),
    join(srcRoot, 'providers', 'codexCli.ts'),
    join(srcRoot, 'providers', 'ollama.ts'),
    join(srcRoot, 'providers', 'egress.ts'),
  ]);
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  };
  visit(srcRoot);

  const bypasses: string[] = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (/\.run\s*\(/.test(line)) bypasses.push(`${file}:${index + 1}`);
    }
  }
  assert.deepEqual(bypasses, [], `direct provider run call(s) bypass the egress guard: ${bypasses.join(', ')}`);
});
