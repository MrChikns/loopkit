/**
 * judge.ts — LLM-as-judge merge review.
 *
 * ADVISORY-ONLY: the judge is called after the gate passes and before the merge.
 * It never changes merge behavior — errors, timeouts, and unparseable output are all
 * fail-open (merge proceeds exactly as without the judge). Power (blocking mode) is a
 * future step gated on calibration via `loopctl verdicts`.
 *
 * The judge sees ONLY the work-item spec + diff — no repo access, no builder transcript.
 * Independence from the builder is the point.
 */

import { spawnSync } from 'node:child_process';
import { ReviewVerdictData } from './schema.js';
import { LlmProvider } from './providers/types.js';

// ---------------------------------------------------------------------------
// Diff capture (shared helper, factored out to avoid
// duplicating diff-capture logic; dispatch imports captureWorktreeDiff too).
// ---------------------------------------------------------------------------

const JUDGE_TRUNCATION_MARKER = '\n[diff truncated — too large for judge]\n';

/**
 * Explicit maxBuffer for the diff-capture spawnSync calls. spawnSync's DEFAULT is 1 MiB;
 * a real multi-file slice's raw `git diff` routinely exceeds that. On overflow Node returns
 * status=null with error.code ENOBUFS and a stdout SILENTLY truncated at ~1 MiB — no throw,
 * so the try/catch never fires. The judge would then review a leading fragment believing it
 * saw the whole diff. We size the buffer well above any realistic `maxChars` so the code's
 * OWN cap (with the visible JUDGE_TRUNCATION_MARKER) is what actually runs, and we detect a
 * residual ENOBUFS so the marker is appended even when the truncated fragment is short.
 */
const DIFF_SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Capture `git diff --stat + patch` from a worktree (mergeBase..HEAD),
 * capped at `maxChars`. Best-effort: returns empty string on any error.
 * Used by both the judge stage and the dispatch repair-evidence path.
 */
export function captureWorktreeDiff(
  wtPath: string,
  mergeBase: string,
  maxChars: number,
): string {
  if (!wtPath || !mergeBase) return '';
  try {
    const stat = spawnSync('git', ['diff', '--stat', `${mergeBase}..HEAD`], {
      cwd: wtPath, stdio: 'pipe', maxBuffer: DIFF_SPAWN_MAX_BUFFER,
    });
    const patch = spawnSync('git', ['diff', `${mergeBase}..HEAD`], {
      cwd: wtPath, stdio: 'pipe', maxBuffer: DIFF_SPAWN_MAX_BUFFER,
    });
    const statText = stat.stdout?.toString() ?? '';
    const patchText = patch.stdout?.toString() ?? '';
    const combined = (statText + '\n' + patchText).trim();
    // A residual ENOBUFS (raw diff still over the generous buffer) leaves stdout truncated
    // WITHOUT throwing. Treat it as "too large" unconditionally so the judge is never told a
    // fragment is the whole diff, even when that fragment happens to be shorter than maxChars.
    const overflowed = (stat.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS'
      || (patch.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
    if (!overflowed && combined.length <= maxChars) return combined;
    const keep = maxChars - JUDGE_TRUNCATION_MARKER.length;
    return combined.slice(0, Math.max(0, keep)) + JUDGE_TRUNCATION_MARKER;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Judge prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the judge prompt. The judge is an independent reviewer who did NOT write
 * the code. It sees ONLY the work-item spec, declared Touches, and the diff.
 * No tools, no repo access, no builder transcript.
 *
 * Output grammar (transcribe-not-transform wall):
 *   VERDICT: pass|fail
 *   CONFIDENCE: <0.0-1.0>
 *   SPEC_SATISFIED: yes|partial|no
 *   SCOPE_CREEP: none|minor|major
 *   TEST_THEATRE: none|suspected
 *   REASONS:
 *   - <up to 5 short bullets citing concrete diff hunks/files>
 */
export function buildJudgePrompt(
  itemId: string,
  spec: string,
  diff: string,
  touches?: string,
): string {
  const touchesLine = touches
    ? `Declared Touches (code area the change is authorized to modify): ${touches}\n`
    : '';
  return `You are an independent code reviewer. You did NOT write this code. \
Your job is to judge whether the diff satisfies the spec — nothing else.

WORK ITEM: ${itemId}
${touchesLine}
WORK ITEM SPEC:
${spec}

THE DIFF (git diff --stat + patch, possibly truncated):
${diff || '(empty diff — no changes detected)'}

Evaluate the diff against the spec ONLY. Answer in EXACTLY this grammar — no prose before or after:

VERDICT: pass|fail
CONFIDENCE: <0.0-1.0>
SPEC_SATISFIED: yes|partial|no
SCOPE_CREEP: none|minor|major
TEST_THEATRE: none|suspected
REASONS:
- <up to 5 short bullets citing concrete diff hunks/files>

Scoring rules:
- A diff that does MORE than the spec is scope creep even if the extras are good.
- Tests that only restate the implementation without a behavioral assertion are test theatre.
- If the diff is empty or the material is insufficient to judge: VERDICT: pass, CONFIDENCE: 0, \
and a REASONS bullet saying "unjudgeable — insufficient diff material".
- Do not reward verbosity. Be concise.`;
}

// ---------------------------------------------------------------------------
// Parse wall
// ---------------------------------------------------------------------------

export interface JudgeParseResult {
  verdict: ReviewVerdictData['verdict'];
  confidence: number;
  specSatisfied: ReviewVerdictData['specSatisfied'];
  scopeCreep: ReviewVerdictData['scopeCreep'];
  testTheatre: ReviewVerdictData['testTheatre'];
  reasons: string[];
  raw?: string;         // present only when verdict is 'unparseable'
}

/**
 * Lenient parser for judge output. Extracts fields from the structured grammar.
 * Missing or malformed VERDICT or CONFIDENCE → verdict:'unparseable'.
 * Confidence is clamped to [0, 1]. Field matching is case-insensitive.
 *
 * Returns a JudgeParseResult. Never throws.
 */
export function parseJudgeOutput(text: string): JudgeParseResult {
  const raw500 = text.slice(0, 500);

  // Extract a named field value (case-insensitive key, first match)
  function field(key: string): string | undefined {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'im');
    const m = re.exec(text);
    return m ? m[1]!.trim() : undefined;
  }

  const verdictRaw = field('VERDICT');
  const confidenceRaw = field('CONFIDENCE');

  // Validate required fields
  const lv = verdictRaw?.toLowerCase();
  if (!lv || (lv !== 'pass' && lv !== 'fail')) {
    return {
      verdict: 'unparseable',
      confidence: 0,
      specSatisfied: 'unknown',
      scopeCreep: 'unknown',
      testTheatre: 'unknown',
      reasons: [`unparseable judge output: ${raw500}`],
      raw: raw500,
    };
  }

  const confidence = parseFloat(confidenceRaw ?? '');
  if (isNaN(confidence)) {
    return {
      verdict: 'unparseable',
      confidence: 0,
      specSatisfied: 'unknown',
      scopeCreep: 'unknown',
      testTheatre: 'unknown',
      reasons: [`unparseable CONFIDENCE value: ${raw500}`],
      raw: raw500,
    };
  }

  // Clamp confidence to [0, 1]
  const clampedConfidence = Math.max(0, Math.min(1, confidence));

  // Parse optional fields with lenient defaults
  const specSatisfiedRaw = field('SPEC_SATISFIED')?.toLowerCase();
  const specSatisfied: ReviewVerdictData['specSatisfied'] =
    specSatisfiedRaw === 'yes' ? 'yes'
    : specSatisfiedRaw === 'partial' ? 'partial'
    : specSatisfiedRaw === 'no' ? 'no'
    : 'unknown';

  const scopeCreepRaw = field('SCOPE_CREEP')?.toLowerCase();
  const scopeCreep: ReviewVerdictData['scopeCreep'] =
    scopeCreepRaw === 'none' ? 'none'
    : scopeCreepRaw === 'minor' ? 'minor'
    : scopeCreepRaw === 'major' ? 'major'
    : 'unknown';

  const testTheatreRaw = field('TEST_THEATRE')?.toLowerCase();
  const testTheatre: ReviewVerdictData['testTheatre'] =
    testTheatreRaw === 'none' ? 'none'
    : testTheatreRaw === 'suspected' ? 'suspected'
    : 'unknown';

  // Extract REASONS bullets: lines starting with "- " after the REASONS: line
  const reasons: string[] = [];
  const reasonsMarker = /^REASONS:\s*$/im.exec(text);
  if (reasonsMarker) {
    const after = text.slice(reasonsMarker.index + reasonsMarker[0].length);
    for (const line of after.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        reasons.push(trimmed.slice(2).trim());
        if (reasons.length >= 5) break;
      }
    }
  }

  return {
    verdict: lv as 'pass' | 'fail',
    confidence: clampedConfidence,
    specSatisfied,
    scopeCreep,
    testTheatre,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Judge runner
// ---------------------------------------------------------------------------

export interface JudgeRunResult {
  parsed: JudgeParseResult | null;  // null = provider error (fail-open, no event)
  /** Usage figures from the provider — mirrors ProviderSuccess.usage including trajectory proxies. */
  usage?: { in: number; out: number; usd?: number; turns?: number; durationMs?: number };
  providerError?: string;            // set when provider call failed
}

/**
 * Run the judge. One provider call, no tools, fail-open.
 * Returns { parsed: null, providerError } on timeout/error.
 * Returns { parsed: { verdict:'unparseable', ... } } when output cannot be parsed.
 */
export async function runJudge(
  provider: LlmProvider,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<JudgeRunResult> {
  let result;
  try {
    result = await provider.run({
      prompt,
      model,
      tools: [],          // no tools — independence is the point
      timeoutMs,
    });
  } catch (e) {
    return { parsed: null, providerError: String(e) };
  }

  if (!result.ok) {
    return { parsed: null, providerError: result.error };
  }

  const parsed = parseJudgeOutput(result.text ?? '');
  return { parsed, usage: result.usage };
}
