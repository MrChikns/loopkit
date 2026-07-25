/**
 * operator-notes.test.ts — Tests for the OPERATOR NOTES prompt section (WI-168).
 *
 * Covers:
 *   operatorNotesFor  — filters to actor:'cli' msg.out, newest-first, bounded count/chars
 *   buildPrompt        — OPERATOR NOTES section placement (after CONTEXT PACK, before RESUME
 *                        NOTE/REPAIR EVIDENCE), absence when there are no operator notes
 *   buildBatchPrompt   — per-item OPERATOR NOTES section
 *   end-to-end          — a worker fake captures the prompt text and asserts an operator's
 *                        msg.out note reached it, while reactor/dispatch msg.out chatter did not
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch, operatorNotesFor, buildPrompt, buildBatchPrompt } from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    salvage: { enabled: false, maxPatchKb: 256 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// operatorNotesFor — unit tests
// ---------------------------------------------------------------------------

test('operatorNotesFor: no msg.out events for the item → undefined', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }),
  ];
  assert.equal(operatorNotesFor(events, 'WI-001'), undefined);
});

test('operatorNotesFor: filters OUT reactor/dispatch msg.out (machine chatter), keeps actor:cli', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'msg.out', { text: 'routing acknowledgement' }),
    makeEvent('dispatch', 'WI-001', 'msg.out', { text: 'pathology: requeued once' }),
    makeEvent('cli', 'WI-001', 'msg.out', { text: 'DIAGNOSIS: ruled out the config path.' }),
  ];
  const notes = operatorNotesFor(events, 'WI-001');
  assert.ok(notes, 'must produce a section when a cli-actor note exists');
  assert.ok(notes!.includes('DIAGNOSIS: ruled out the config path.'), 'operator note text must be included');
  assert.ok(!notes!.includes('routing acknowledgement'), 'reactor chatter must be excluded');
  assert.ok(!notes!.includes('pathology: requeued once'), 'dispatch chatter must be excluded');
});

test('operatorNotesFor: only matches msg.out for the requested item id', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-001', 'msg.out', { text: 'note for WI-001' }),
    makeEvent('cli', 'WI-002', 'msg.out', { text: 'note for WI-002' }),
  ];
  const notes = operatorNotesFor(events, 'WI-001');
  assert.ok(notes!.includes('note for WI-001'));
  assert.ok(!notes!.includes('note for WI-002'));
});

test('operatorNotesFor: blank/whitespace-only cli msg.out is dropped', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-001', 'msg.out', { text: '   ' }),
  ];
  assert.equal(operatorNotesFor(events, 'WI-001'), undefined);
});

test('operatorNotesFor: newest-first ordering, capped to the most recent N notes', () => {
  const events: LedgerEvent[] = [];
  for (let i = 1; i <= 8; i++) {
    events.push(makeEvent('cli', 'WI-001', 'msg.out', { text: `note ${i}` }, `2026-01-0${i}T00:00:00Z`));
  }
  const notes = operatorNotesFor(events, 'WI-001');
  assert.ok(notes, 'must produce a section');
  // Bounded count: with 8 notes and a cap of 5, only the newest 5 (notes 4-8) survive —
  // check ordering against note 5 (the oldest SURVIVING note), not note 1 (correctly dropped).
  const idx8 = notes!.indexOf('note 8');
  const idx5 = notes!.indexOf('note 5');
  assert.ok(idx8 !== -1 && idx5 !== -1, 'both the newest and the oldest-surviving note must be present');
  assert.ok(idx8 < idx5, 'newest note must be rendered first');
  // Notes beyond the most-recent-N cap must be dropped entirely.
  assert.ok(!notes!.includes('note 3'), 'notes beyond the most-recent-N cap must be dropped');
  assert.ok(!notes!.includes('note 1'), 'the oldest note must be dropped (cap of 5, 8 notes total)');
});

test('operatorNotesFor: a single very long note is truncated, not silently dropped', () => {
  const longText = 'x'.repeat(10_000);
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-001', 'msg.out', { text: longText }),
  ];
  const notes = operatorNotesFor(events, 'WI-001');
  assert.ok(notes, 'must still produce a section');
  assert.ok(notes!.length < longText.length, 'total section must be bounded well below the raw note length');
  assert.ok(notes!.includes('[truncated]'), 'a truncated note must say so');
});

// ---------------------------------------------------------------------------
// buildPrompt / buildBatchPrompt — section placement
// ---------------------------------------------------------------------------

test('buildPrompt: OPERATOR NOTES section appears after CONTEXT PACK and before RESUME NOTE', () => {
  const prompt = buildPrompt(
    'do the thing', undefined, undefined,
    'a scout brief', undefined, 'RESUME NOTE: prior patch applied',
    undefined, undefined,
    'OPERATOR NOTES (most recent first — a human\'s own diagnosis on this item; trust this over your own re-derivation where they conflict):\n[2026-01-01] diagnosis text',
  );
  const briefIdx = prompt.indexOf('CONTEXT PACK');
  const notesIdx = prompt.indexOf('OPERATOR NOTES');
  const resumeIdx = prompt.indexOf('RESUME NOTE');
  assert.ok(briefIdx !== -1 && notesIdx !== -1 && resumeIdx !== -1, 'all three sections must be present');
  assert.ok(briefIdx < notesIdx, 'CONTEXT PACK must come before OPERATOR NOTES');
  assert.ok(notesIdx < resumeIdx, 'OPERATOR NOTES must come before RESUME NOTE');
});

test('buildPrompt: OPERATOR NOTES section appears before REPAIR EVIDENCE', () => {
  const prompt = buildPrompt(
    'fix it', undefined, undefined,
    undefined, 'REPAIR EVIDENCE — a prior attempt failed...', undefined,
    undefined, undefined,
    'OPERATOR NOTES (most recent first — a human\'s own diagnosis on this item; trust this over your own re-derivation where they conflict):\n[2026-01-01] diagnosis text',
  );
  const notesIdx = prompt.indexOf('OPERATOR NOTES');
  const evidenceIdx = prompt.indexOf('REPAIR EVIDENCE');
  assert.ok(notesIdx !== -1 && evidenceIdx !== -1);
  assert.ok(notesIdx < evidenceIdx, 'OPERATOR NOTES must come before REPAIR EVIDENCE');
});

test('buildPrompt: no operator notes → no OPERATOR NOTES section, prompt unchanged otherwise', () => {
  const prompt = buildPrompt('do the thing');
  assert.ok(!prompt.includes('OPERATOR NOTES'), 'section must be absent when no notes are supplied');
});

test('buildBatchPrompt: per-item OPERATOR NOTES section, only for the item that has one', () => {
  const items = [
    { id: 'WI-001', spec: 'do A', operatorNotes: 'OPERATOR NOTES (most recent first — a human\'s own diagnosis on this item; trust this over your own re-derivation where they conflict):\n[2026-01-01] diag for A' },
    { id: 'WI-002', spec: 'do B' },
  ];
  const prompt = buildBatchPrompt(items);
  assert.ok(prompt.includes('diag for A'), 'WI-001 operator note must be present');
  const wi001Idx = prompt.indexOf('WI-001');
  const wi002Idx = prompt.indexOf('WI-002');
  const notesIdx = prompt.indexOf('OPERATOR NOTES');
  assert.ok(wi001Idx < notesIdx && notesIdx < wi002Idx, 'the operator note must render under ITEM 1 (WI-001), not leak into ITEM 2');
});

// ---------------------------------------------------------------------------
// End-to-end: an operator's msg.out reaches the worker prompt; beat chatter does not
// ---------------------------------------------------------------------------

test('E2E: operator msg.out (actor cli) reaches the build prompt; reactor msg.out does not', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-operator-notes-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
      // Operator's own diagnosis note (mirrors the real WI-164 incident: actor 'cli').
      makeEvent('cli', 'WI-001', 'msg.out', {
        text: 'DIAGNOSIS: ruled out hypotheses 1-4, the real cause is X.',
      }, '2026-01-01T00:02:00Z'),
      // Machine-generated routing chatter — must NOT reach the worker prompt.
      makeEvent('reactor', 'WI-001', 'msg.out', {
        text: 'routing WI-001 to the engineering lane',
      }, '2026-01-01T00:02:30Z'),
    ]);

    // The same fake provider handles both the real build call AND the post-merge judge call
    // (runDispatch's own review step) — only the build call sets req.exitFile (mirrors the
    // existing "worker spawn: passes detached:false" test's convention for isolating it).
    let capturedPrompt = '';
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        if (!req.exitFile) return { ok: true, text: 'ok' };
        capturedPrompt = req.prompt;
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        return { ok: true, text: 'done, left uncommitted for dispatch' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.ok(capturedPrompt.includes('OPERATOR NOTES'), 'prompt must contain the OPERATOR NOTES section');
    assert.ok(capturedPrompt.includes('ruled out hypotheses 1-4'), "the operator's own diagnosis text must reach the prompt");
    assert.ok(!capturedPrompt.includes('routing WI-001 to the engineering lane'), 'reactor routing chatter must NOT reach the prompt');

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', `WI-001 must merge via the scoped commit; result: ${JSON.stringify(result.dispatched)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
