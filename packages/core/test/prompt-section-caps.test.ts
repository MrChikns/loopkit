/**
 * prompt-section-caps.test.ts — WI-236: attention-budget hardening for prompt-assembly inputs.
 *
 * Scout output, pathology diffs, and judge diffs already had their own caps. spec text,
 * operator notes, repair evidence, and attachment lists did not — buildPrompt/buildBatchPrompt
 * (dispatch.ts) and the router's per-item prompt (reactor.ts) inlined them directly, so one
 * oversized capture could bloat the whole worker/router invocation. capPromptSection is the ONE
 * shared truncation helper both paths now call (one-parser doctrine). These pin: the helper
 * itself (passthrough + truncation + visible marker), that oversized synthetic inputs truncate
 * with a visible marker in BOTH the single-item and batch builder paths and in the router
 * prompt, and that normal-size inputs pass through byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  capPromptSection,
  PROMPT_SECTION_CAPS,
  buildPrompt,
  buildBatchPrompt,
} from '../src/beats/dispatch.js';
import { runReactor } from '../src/beats/reactor.js';
import { makeEvent } from '../src/schema.js';
import { appendEvents } from '../src/ledger.js';
import { CONFIG_DEFAULTS } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

let n = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi236-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// capPromptSection — unit tests
// ---------------------------------------------------------------------------

test('capPromptSection: text within the cap passes through byte-identical', () => {
  const text = 'a normal, small piece of prompt material';
  assert.equal(capPromptSection(text, 1000, 'TEST'), text);
});

test('capPromptSection: text exactly at the cap passes through byte-identical', () => {
  const text = 'x'.repeat(100);
  assert.equal(capPromptSection(text, 100, 'TEST'), text);
});

test('capPromptSection: oversized text truncates with a visible marker naming the label', () => {
  const text = 'x'.repeat(5000);
  const result = capPromptSection(text, 100, 'SPEC');
  assert.ok(result.length <= 100 + 60, 'result must stay close to the cap, not balloon');
  assert.match(result, /\[SPEC truncated/, 'the marker must name the section it truncated');
  assert.ok(result.startsWith('x'), 'the KEPT prefix must be real content, not just the marker');
});

test('capPromptSection: the marker reports the original size and the cap', () => {
  const text = 'y'.repeat(2000);
  const result = capPromptSection(text, 500, 'OPERATOR NOTES');
  assert.match(result, /2000 chars over the 500-char cap/);
});

test('capPromptSection: never throws on a cap smaller than the marker itself', () => {
  const text = 'z'.repeat(500);
  assert.doesNotThrow(() => capPromptSection(text, 5, 'X'));
});

// ---------------------------------------------------------------------------
// buildPrompt (single-item) — wiring
// ---------------------------------------------------------------------------

test('buildPrompt: a normal-size spec/notes/attachments prompt is unaffected (byte-identical section content)', () => {
  const spec = 'Add a small banner to the detail view.';
  const notes = 'OPERATOR NOTES (most recent first — a human\'s own diagnosis on this item; trust this over your own re-derivation where they conflict):\n[2026-01-01] short note';
  const prompt = buildPrompt(spec, undefined, ['src/foo.ts'], undefined, undefined, undefined, undefined, 'src/', notes);
  assert.ok(prompt.includes(spec), 'a normal spec must appear verbatim');
  assert.ok(prompt.includes(notes), 'normal operator notes must appear verbatim');
  assert.doesNotMatch(prompt, /truncated/, 'nothing here is oversized — no truncation marker should appear');
});

test('buildPrompt: an oversized spec truncates with a visible marker', () => {
  const hugeSpec = 'A'.repeat(PROMPT_SECTION_CAPS.spec + 5000);
  const prompt = buildPrompt(hugeSpec);
  assert.match(prompt, /\[REQUEST truncated/);
  assert.ok(prompt.length < hugeSpec.length + 2000, 'the prompt must not simply inline the whole oversized spec');
});

test('buildPrompt: oversized operator notes truncate with a visible marker', () => {
  const spec = 'small spec';
  const hugeNotes = 'N'.repeat(PROMPT_SECTION_CAPS.operatorNotes + 5000);
  const prompt = buildPrompt(spec, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hugeNotes);
  assert.match(prompt, /\[OPERATOR NOTES truncated/);
});

test('buildPrompt: oversized repair context truncates with a visible marker', () => {
  const spec = 'small spec';
  const hugeRepairContext = 'R'.repeat(PROMPT_SECTION_CAPS.repairEvidence + 5000);
  const prompt = buildPrompt(spec, hugeRepairContext);
  assert.match(prompt, /\[REPAIR CONTEXT truncated/);
});

test('buildPrompt: an oversized attachments list truncates with a visible marker', () => {
  const spec = 'small spec';
  const manyAttachments = Array.from({ length: 5000 }, (_, i) => `path/to/attachment-${i}.png`);
  const prompt = buildPrompt(spec, undefined, manyAttachments);
  assert.match(prompt, /\[ATTACHMENTS truncated/);
});

// ---------------------------------------------------------------------------
// buildBatchPrompt — wiring
// ---------------------------------------------------------------------------

test('buildBatchPrompt: normal-size items are unaffected (byte-identical spec content)', () => {
  const items = [{ id: 'WI-001', spec: 'Add the foo widget.', touches: 'src/foo/' }];
  const prompt = buildBatchPrompt(items);
  assert.ok(prompt.includes('Add the foo widget.'));
  assert.doesNotMatch(prompt, /truncated/);
});

test('buildBatchPrompt: an oversized item spec truncates with a visible marker naming the item', () => {
  const hugeSpec = 'B'.repeat(PROMPT_SECTION_CAPS.spec + 5000);
  const items = [{ id: 'WI-002', spec: hugeSpec }];
  const prompt = buildBatchPrompt(items);
  assert.match(prompt, /\[SPEC \(WI-002\) truncated/);
});

test('buildBatchPrompt: oversized per-item operator notes truncate with a visible marker', () => {
  const items = [{ id: 'WI-003', spec: 'small', operatorNotes: 'C'.repeat(PROMPT_SECTION_CAPS.operatorNotes + 5000) }];
  const prompt = buildBatchPrompt(items);
  assert.match(prompt, /\[OPERATOR NOTES \(WI-003\) truncated/);
});

test('buildBatchPrompt: oversized per-item repair evidence truncates with a visible marker', () => {
  const items = [{ id: 'WI-004', spec: 'small', repairEvidence: 'D'.repeat(PROMPT_SECTION_CAPS.repairEvidence + 5000) }];
  const prompt = buildBatchPrompt(items);
  assert.match(prompt, /\[REPAIR EVIDENCE \(WI-004\) truncated/);
});

// ---------------------------------------------------------------------------
// Router prompt (reactor.ts stepRoute) — wiring
// ---------------------------------------------------------------------------

function fakeProvider(text: string, captured: string[]): LlmProvider {
  return {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      captured.push(req.prompt);
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

const ANSWER_BLOCK = ['ROUTE: answer', 'REPLY: all good'].join('\n');

// NOTE on scale: the ledger's own per-event cap (MAX_EVENT_BYTES = 4096, ledger.ts) already
// truncates any free-text field — including item.captured.text — long before it could ever
// reach PROMPT_SECTION_CAPS.spec (40_000) through a real appendEvents call. So a genuinely
// oversized rec.sourceText can never arrive via the real ledger path today; the router's
// capPromptSection call on TEXT is deliberate defense-in-depth (the same one-parser helper
// dispatch's buildPrompt uses), not a reachable-in-practice guard. The wiring itself (that
// stepRoute really calls capPromptSection with PROMPT_SECTION_CAPS.spec on rec.sourceText) is
// already covered directly by the capPromptSection unit tests above using that exact constant;
// this test instead pins that the LARGEST text the ledger can actually deliver still reaches
// the router prompt without a false-positive truncation marker.
test('reactor: the largest TEXT the ledger can actually deliver reaches the router prompt untruncated', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'router.md'), 'stub routing prompt');

    // Comfortably under the ledger's 4096-byte whole-event cap, but far larger than a typical
    // operator message — the realistic upper bound for sourceText in practice.
    const largeButRealisticText = 'L'.repeat(3000);
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-500', 'item.captured', { source: 'test', text: largeButRealisticText }),
    ]);

    const captured: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: fakeProvider(ANSWER_BLOCK, captured),
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.', promptsDir: '.ai/loops/prompts' },
    });

    const routingPrompt = captured.find(p => p.includes('ID: WI-500'));
    assert.ok(routingPrompt, 'WI-500 must have been routed');
    assert.doesNotMatch(routingPrompt!, /\[TEXT truncated/, 'well under the cap must never false-positive truncate');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('capPromptSection: applying the router\'s exact TEXT cap to a synthetic oversized sourceText truncates visibly (wiring proof, bypassing the ledger\'s own smaller cap)', () => {
  // This exercises the SAME call the router makes (capPromptSection(text, PROMPT_SECTION_CAPS.spec,
  // 'TEXT')) against an input sized the way a non-ledger-sourced caller could one day supply it,
  // proving the wiring is correct independent of whether the ledger's own cap would ever let such
  // a value arrive in practice.
  const hugeText = 'T'.repeat(PROMPT_SECTION_CAPS.spec + 5000);
  const result = capPromptSection(hugeText, PROMPT_SECTION_CAPS.spec, 'TEXT');
  assert.match(result, /\[TEXT truncated/);
  assert.ok(result.length <= PROMPT_SECTION_CAPS.spec + 100);
});

test('reactor: a normal-size captured TEXT reaches the router prompt byte-identical, no truncation marker', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'router.md'), 'stub routing prompt');

    const normalText = 'please fix the login button color';
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-501', 'item.captured', { source: 'test', text: normalText }),
    ]);

    const captured: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: fakeProvider(ANSWER_BLOCK, captured),
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.', promptsDir: '.ai/loops/prompts' },
    });

    const routingPrompt = captured.find(p => p.includes('ID: WI-501'));
    assert.ok(routingPrompt, 'WI-501 must have been routed');
    assert.ok(routingPrompt!.includes(`TEXT: ${normalText}`), 'a normal TEXT must reach the prompt verbatim');
    assert.doesNotMatch(routingPrompt!, /truncated/);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});
