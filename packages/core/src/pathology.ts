/**
 * pathology.ts — WI-084 the park pathologist.
 *
 * FAIL-OPEN, READ-ONLY: on every FAILURE park (gate-red / crash / infra — NEVER
 * parkKind:'decision', which is an operator question, not a plane failure), the reactor spawns
 * ONE bounded diagnosis pass here, gets a structured verdict, then acts by classification
 * (see beats/reactor.ts stepPathology). The pathologist never makes reliability worse: a
 * provider error/timeout/unparseable output degrades to a skip note and the park stands
 * exactly as it would without this module.
 *
 * Structurally mirrors judge.ts (buildJudgePrompt / parseJudgeOutput / runJudge) — same
 * transcribe-not-transform wall discipline, same tolerant field() regex extractor, same
 * fail-open provider-error handling. captureWorktreeDiff is judge.ts's, reused as-is (import
 * it from there rather than duplicating diff capture — one implementation).
 */

import { LlmProvider } from './providers/types.js';

// ---------------------------------------------------------------------------
// Event-trail formatter
// ---------------------------------------------------------------------------

/** A minimal event shape the trail formatter needs — avoids importing LedgerEvent's full generic. */
export interface TrailEvent {
  ts: string;
  type: string;
  data: unknown;
}

/**
 * Compact event-trail formatter (pure, exported for tests): the last `max` events for one
 * item, one line each — `type: <short data>`. Used to give the diagnostician just enough
 * context without dumping the raw ledger.
 */
export function formatEventTrail(events: TrailEvent[], max = 15): string {
  const tail = events.slice(-max);
  if (tail.length === 0) return '(no prior events)';
  return tail
    .map((ev) => {
      let shortData = '';
      try {
        shortData = JSON.stringify(ev.data);
      } catch {
        shortData = '(unserializable data)';
      }
      if (shortData.length > 200) shortData = shortData.slice(0, 200) + '…';
      return `${ev.ts} ${ev.type}: ${shortData}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Pathology prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the pathologist prompt. The pathologist is a READ-ONLY diagnostician — it sees the
 * item id, the park reason/kind, a compact event trail, the gate/crash tail, and the branch
 * diff when available. No tools, no repo access, no builder transcript.
 *
 * Output grammar (transcribe-not-transform wall):
 *   CLASSIFICATION: transient-infra|plane-infra-bug|items-own-code
 *   EVIDENCE:
 *   - <up to 5 bullets citing concrete trail/tail/diff lines>
 *   PROPOSED_ACTION: <one line>
 */
export function buildPathologyPrompt(
  itemId: string,
  parkReason: string,
  parkKind: string | undefined,
  eventTrail: string,
  gateCrashTail: string,
  diff?: string,
): string {
  return `You are an independent, read-only diagnostician for an autonomous build plane. You did \
NOT write this code and you have no tools — your job is to classify WHY this work item's build \
was parked, nothing else.

WORK ITEM: ${itemId}
PARK REASON: ${parkReason}
PARK KIND: ${parkKind ?? '(none)'}

RECENT EVENT TRAIL (most recent last):
${eventTrail || '(no prior events)'}

GATE/CRASH TAIL:
${gateCrashTail || '(no tail captured)'}

THE DIFF (git diff --stat + patch, possibly truncated):
${diff || '(empty diff — no changes detected, or the worktree is gone)'}

Classify the failure. Answer in EXACTLY this grammar — no prose before or after:

CLASSIFICATION: transient-infra|plane-infra-bug|items-own-code
EVIDENCE:
- <up to 5 bullets citing concrete trail/tail/diff lines>
PROPOSED_ACTION: <one line>

Classification rules:
- transient-infra: a timeout, network blip, lock contention, ENOBUFS, or provider blip NOT \
caused by the diff. Safe to retry as-is.
- plane-infra-bug: the FRAMEWORK/plane tooling itself is broken — a bug in the harness, the \
gate runner, a config file, or a plane script. Evidence must point at plane code, never at the \
item's own diff.
- items-own-code: the item's OWN diff/spec is wrong — a test failure in the changed files, a \
type error in the diff, a spec the diff doesn't satisfy.
- If the material given is insufficient to tell: CLASSIFICATION: items-own-code with an \
EVIDENCE bullet "insufficient — defaulting to own-code (conservative: parks for review sooner)". \
This is the conservative default — it fails safe toward operator review, never toward an \
infinite plane-bug block.

Do not reward verbosity. Be concise.`;
}

// ---------------------------------------------------------------------------
// Parse wall
// ---------------------------------------------------------------------------

export interface PathologyParseResult {
  classification: 'transient-infra' | 'plane-infra-bug' | 'items-own-code' | 'unparseable';
  evidence: string[];
  proposedAction: string;
  raw?: string;   // present only when classification is 'unparseable'
}

/**
 * Lenient parser for pathologist output. Extracts fields from the structured grammar.
 * Missing/invalid CLASSIFICATION → classification:'unparseable'. Field matching is
 * case-insensitive. Never throws.
 */
export function parsePathologyOutput(text: string): PathologyParseResult {
  const raw500 = text.slice(0, 500);

  // Extract a named field value (case-insensitive key, first match) — COPIED from judge.ts's
  // field() helper (one idiom, no second parser).
  function field(key: string): string | undefined {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'im');
    const m = re.exec(text);
    return m ? m[1]!.trim() : undefined;
  }

  const classificationRaw = field('CLASSIFICATION')?.toLowerCase();
  const classification: PathologyParseResult['classification'] | undefined =
    classificationRaw === 'transient-infra' ? 'transient-infra'
    : classificationRaw === 'plane-infra-bug' ? 'plane-infra-bug'
    : classificationRaw === 'items-own-code' ? 'items-own-code'
    : undefined;

  if (!classification) {
    return {
      classification: 'unparseable',
      evidence: [`unparseable pathology output: ${raw500}`],
      proposedAction: '',
      raw: raw500,
    };
  }

  // Extract EVIDENCE bullets: lines starting with "- " after the EVIDENCE: line
  const evidence: string[] = [];
  const evidenceMarker = /^EVIDENCE:\s*$/im.exec(text);
  if (evidenceMarker) {
    const after = text.slice(evidenceMarker.index + evidenceMarker[0].length);
    for (const line of after.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        evidence.push(trimmed.slice(2).trim());
        if (evidence.length >= 5) break;
      } else if (trimmed.startsWith('PROPOSED_ACTION:')) {
        break;
      }
    }
  }

  const proposedAction = field('PROPOSED_ACTION') ?? '';

  return { classification, evidence, proposedAction };
}

// ---------------------------------------------------------------------------
// Pathology runner
// ---------------------------------------------------------------------------

export interface PathologyRunResult {
  parsed: PathologyParseResult | null;   // null = provider error (fail-open, no event)
  /** Usage figures from the provider — mirrors JudgeRunResult.usage. */
  usage?: { in: number; out: number; usd?: number; turns?: number; durationMs?: number };
  providerError?: string;                 // set when the provider call failed
}

/**
 * Run the pathologist. One provider call, no tools, fail-open — COPIED from judge.ts's
 * runJudge shape exactly (one runner idiom for both advisory LLM stages).
 * Returns { parsed: null, providerError } on timeout/error.
 * Returns { parsed: { classification:'unparseable', ... } } when output cannot be parsed.
 */
export async function runPathology(
  provider: LlmProvider,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<PathologyRunResult> {
  let result;
  try {
    result = await provider.run({
      prompt,
      model,
      tools: [],          // no tools — read-only diagnosis, independence is the point
      timeoutMs,
    });
  } catch (e) {
    return { parsed: null, providerError: String(e) };
  }

  if (!result.ok) {
    return { parsed: null, providerError: result.error };
  }

  const parsed = parsePathologyOutput(result.text ?? '');
  return { parsed, usage: result.usage };
}
