/**
 * knowledge-harvest.ts — ADR-015 Slice 3: the strict-auditor harvest step.
 *
 * FAIL-CLOSED, DEFAULT-REJECT: the harvest prompt sees ONE gate-proven merge (its spec, its
 * gate evidence) and is instructed that most merges teach nothing generalizable — emit an
 * empty JSON array unless a lesson is execution-proven, durable, and not already obvious.
 * A provider error/timeout/unparseable output means ZERO candidates from that merge, never a
 * fabricated one (mirrors judge.ts / pathology.ts's fail-open-to-nothing posture, inverted for
 * a step whose whole point is scarcity).
 *
 * Structurally mirrors judge.ts (buildJudgePrompt / parseJudgeOutput / runJudge) — same
 * transcribe-not-transform wall discipline: the LLM emits structured JSON, this module only
 * validates/caps it, never re-interprets it.
 */

import { LlmProvider } from './providers/types.js';
import { invokeProvider } from './providers/egress.js';

// ---------------------------------------------------------------------------
// Prompt-input caps (mirror judge.ts / pathology.ts's own section caps)
// ---------------------------------------------------------------------------

const HARVEST_SPEC_MAX_CHARS = 4_000;
const HARVEST_GATE_EVIDENCE_MAX_CHARS = 2_000;

/** Truncate a prompt-input section, appending a visible marker — never a silent cut. */
function capSection(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[${label} truncated — too large for harvest]`;
}

// ---------------------------------------------------------------------------
// Harvest prompt builder
// ---------------------------------------------------------------------------

/** One candidate lesson as the strict auditor emits it — pre-validation shape. */
export interface RawKnowledgeCandidate {
  lesson?: unknown;
  verifyPath?: unknown;
  verifyCommand?: unknown;
}

/**
 * Build the strict-auditor harvest prompt. The auditor is a third party — it reads ONE merged
 * item's spec and gate evidence, never the builder's own transcript or manifest, and never
 * grades its own trace (the self-confirmation trap, EDV arXiv 2606.24428).
 *
 * Output grammar (transcribe-not-transform wall): a bare JSON array, each element
 * `{ "lesson": string, "verifyPath"?: string, "verifyCommand"?: string }`. The default,
 * expected output for MOST merges is `[]` (GovMem arXiv 2607.02579: zero candidates safe for
 * automatic promotion on most real traces — default-reject curation, not a rare edge case).
 */
export function buildKnowledgeAuditPrompt(rec: { id: string; spec?: string }, gateEvidence?: string): string {
  const spec = capSection(rec.spec ?? '(no spec recorded)', HARVEST_SPEC_MAX_CHARS, 'SPEC');
  const evidence = gateEvidence
    ? capSection(gateEvidence, HARVEST_GATE_EVIDENCE_MAX_CHARS, 'GATE EVIDENCE')
    : '(no gate evidence captured)';

  return `You are a STRICT auditor distilling durable knowledge from ONE merged, gate-proven \
work item. You did NOT write this code. Your default answer is an empty result — most merges \
teach nothing generalizable beyond the one item they shipped.

WORK ITEM: ${rec.id}

SPEC:
${spec}

GATE EVIDENCE (the objective proof this merge's own gate passed):
${evidence}

Emit a lesson ONLY if ALL of the following hold:
  (a) it is execution-proven by THIS merge's gate evidence above — not a plausible-sounding
      claim, an actual thing this gate run demonstrated;
  (b) it is durable beyond this one item — a pattern a future, unrelated work item would hit
      again, not a fact specific to this item's own business logic;
  (c) it is not already obvious from the repo's own contributing/style docs — do not restate
      conventions a contributor guide already states.

If you are unsure whether a candidate lesson clears this bar, do NOT emit it. Silence (an empty
array) is the correct, expected output for the overwhelming majority of merges.

Answer with EXACTLY a JSON array — no prose before or after, no markdown code fence:

[]

or, when (and only when) at least one lesson clears the bar:

[
  { "lesson": "<one imperative-voice line, playbook style>", "verifyPath": "<repo path this lesson depends on, if concrete>" }
]

Rules for each element:
- "lesson" is REQUIRED: one line, imperative playbook voice (e.g. "Run the gate before merging a
  schema change."), no more than 200 characters.
- "verifyPath" is OPTIONAL: a repo-relative path the lesson is grounded in (a concrete file or
  directory), when the lesson is about one. Omit it when the lesson isn't tied to one file.
- "verifyCommand" is OPTIONAL: a command whose leading binary the lesson depends on. Omit unless
  concretely applicable.
- Emit at most 3 lessons total, even if you can think of more — pick the strongest ones only.
- Never invent a verifyPath/verifyCommand not evidenced above.`;
}

// ---------------------------------------------------------------------------
// Parse wall
// ---------------------------------------------------------------------------

export interface HarvestedCandidate {
  lesson: string;
  verifyPath?: string;
  verifyCommand?: string;
}

export interface HarvestParseResult {
  /** Validated candidates — always an array, possibly empty (the expected common case). */
  candidates: HarvestedCandidate[];
  /** Set when the raw output could not be parsed as a JSON array at all. */
  unparseable?: boolean;
  raw?: string;
}

const HARVEST_LESSON_MAX_CHARS = 200;
/** Per-item cap on lessons harvested from ONE merge, independent of the per-beat cap. */
export const HARVEST_LESSONS_PER_ITEM_CAP = 3;

/**
 * Lenient parser for the harvest output. Extracts the first `[...]` JSON array found in the
 * text (tolerating stray prose/code fences the model may add despite instructions), validates
 * each element, and drops anything malformed rather than throwing. Never fabricates a lesson
 * from unparseable output — an unparseable response yields zero candidates, exactly like an
 * empty array.
 */
export function parseKnowledgeAuditOutput(text: string): HarvestParseResult {
  const raw500 = text.slice(0, 500);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    return { candidates: [], unparseable: true, raw: raw500 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { candidates: [], unparseable: true, raw: raw500 };
  }

  if (!Array.isArray(parsed)) {
    return { candidates: [], unparseable: true, raw: raw500 };
  }

  const candidates: HarvestedCandidate[] = [];
  for (const item of parsed as RawKnowledgeCandidate[]) {
    if (candidates.length >= HARVEST_LESSONS_PER_ITEM_CAP) break;
    if (!item || typeof item !== 'object') continue;
    const lessonRaw = item.lesson;
    if (typeof lessonRaw !== 'string' || lessonRaw.trim().length === 0) continue;
    const lesson = lessonRaw.trim().slice(0, HARVEST_LESSON_MAX_CHARS);
    const candidate: HarvestedCandidate = { lesson };
    if (typeof item.verifyPath === 'string' && item.verifyPath.trim().length > 0) {
      candidate.verifyPath = item.verifyPath.trim();
    }
    if (typeof item.verifyCommand === 'string' && item.verifyCommand.trim().length > 0) {
      candidate.verifyCommand = item.verifyCommand.trim();
    }
    candidates.push(candidate);
  }

  return { candidates };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface HarvestRunResult {
  parsed: HarvestParseResult | null;  // null = provider error (fail-closed, no candidates)
  usage?: { in: number; out: number; usd?: number; turns?: number; durationMs?: number };
  providerError?: string;
}

/**
 * Run the harvest auditor. One provider call, no tools (independence is the point, same as the
 * judge). Returns { parsed: null, providerError } on timeout/error — the caller treats this as
 * zero candidates, never a fabricated one.
 */
export async function runKnowledgeHarvest(
  provider: LlmProvider,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<HarvestRunResult> {
  let result;
  try {
    result = await invokeProvider(provider, {
      prompt,
      model,
      tools: [],
      timeoutMs,
    });
  } catch (e) {
    return { parsed: null, providerError: String(e) };
  }

  if (!result.ok) {
    return { parsed: null, providerError: result.error };
  }

  const parsed = parseKnowledgeAuditOutput(result.text ?? '');
  return { parsed, usage: result.usage };
}
