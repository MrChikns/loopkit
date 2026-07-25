/**
 * criteria.ts — acceptance criteria as a first-class artifact (WI-193).
 *
 * WHY THIS EXISTS
 * ---------------
 * The gates prove a change is HARMLESS: the existing tests still pass and the diff stayed
 * inside its declared `Touches`. Nothing in that proves it is THE CHANGE THAT WAS ASKED FOR.
 * An item can merge green having implemented nothing. Acceptance was therefore human-only,
 * and the operator became the throughput bottleneck.
 *
 * Acceptance criteria are the missing artifact: a small list of falsifiable statements about
 * OBSERVABLE behaviour, written down before the work starts, that both the judge and the
 * operator can read side-by-side with the diff.
 *
 * THE INDEPENDENCE PROPERTY (protect this — it is the whole point)
 * ---------------------------------------------------------------
 * Criteria MUST be authored before any build context exists. That ordering is the only
 * independence property available here; without it, criteria drift toward whatever happens
 * to be convenient to satisfy, and "done = measurable" silently degrades back to "done =
 * the agent says so".
 *
 * It is enforced structurally, not by convention: {@link CRITERIA_AUTHORS} names the only
 * actors whose events may author criteria — the routing wall (`reactor`, which sees raw
 * intent and nothing else) and the operator (`cli`). An event from a BUILD actor
 * (`dispatch`, a worker) that carries a `criteria` field is ignored by the fold. A builder
 * therefore cannot write, widen, or soften the bar it is being measured against, even by
 * appending a well-formed event.
 *
 * DELIBERATELY NOT BUILT
 * ----------------------
 * No rubric engine, no scoring, no falsifiability checking, no criteria-quality grading.
 * A list of short sentences is the artifact; judgement stays with the judge and the operator.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * The artifact: a small ordered list of falsifiable statements.
 *
 * A LIST, not one prose blob, because both readers are better served by it — the judge can
 * answer "which of these is satisfied?" per line instead of grading an essay, and the
 * operator scanning the acceptance desk can tick items off against the shipped surface. It
 * stays a plain `string[]` (no ids, no weights, no per-criterion state) because anything
 * richer is the rubric engine this slice explicitly refuses to build.
 */
export type AcceptanceCriteria = string[];

/** Upper bound on criteria per item. A list longer than this is a spec, not a bar. */
export const MAX_CRITERIA = 7;

/** Upper bound on a single criterion's length. Longer text is truncated, never dropped. */
export const MAX_CRITERION_CHARS = 300;

/**
 * The ONLY actors whose events may author acceptance criteria — the independence property
 * above, in code. `reactor` is the routing wall (it event-models raw intent and has no build
 * context by construction); `cli` is the operator's own hand. Every other actor — most
 * importantly `dispatch` and the build workers it spawns — has seen the build, so criteria
 * carried on its events are IGNORED by the fold rather than trusted.
 */
export const CRITERIA_AUTHORS: ReadonlySet<string> = new Set(['reactor', 'cli']);

/**
 * Grandfather cutoff: the moment loopkit began requiring acceptance criteria.
 *
 * BACKWARD COMPATIBILITY, stated plainly: an item CAPTURED before this instant is exempt
 * from the requirement and queues exactly as it always did; an item captured at or after it
 * may not reach `queued` without criteria.
 *
 * Why grandfather rather than backfill: a backfill would author criteria for an item whose
 * build context already exists (some of these items are parked mid-build, some already have
 * builds on them), which is precisely the ordering the independence property forbids.
 * Backfilled criteria would be measured against work already done — an expensive way to
 * manufacture agreement. Grandfathering is honest about it instead.
 *
 * Why not silently exempt everything: exemption is RECORDED, not assumed. A grandfathered
 * item folds with `criteriaExempt: true`, and every operator surface says "captured before
 * criteria were required" rather than rendering a blank that reads like compliance.
 *
 * This is a property of the CODE VERSION (when the feature shipped), not of a deployment,
 * so it is a constant rather than config — the set of exempt items is finite, closed, and
 * shrinks to nothing as those items land.
 */
export const CRITERIA_REQUIRED_FROM = '2026-07-25T00:00:00.000Z';

/**
 * Lanes exempt from the criteria requirement. The planning lane produces decompositions and
 * plans — it never writes product code, so there is no diff for criteria to be measured
 * against. Every code-writing lane is subject to the requirement.
 */
const EXEMPT_LANES: ReadonlySet<string> = new Set(['planning']);

// ---------------------------------------------------------------------------
// The one normalizer (one predicate, one parser — a second one is the drift)
// ---------------------------------------------------------------------------

/**
 * Normalize criteria from ANY source into the canonical shape — the single funnel every
 * producer and consumer goes through, so a criterion can never mean two things depending on
 * where it entered.
 *
 * Accepts an array (a `criteria` field off a ledger event) or a raw string block (the
 * router's `CRITERIA:` field, bullets or bare lines). Trims, strips leading bullet/number
 * markers, drops blanks, de-duplicates case-insensitively, truncates over-long entries, and
 * caps the list at {@link MAX_CRITERIA}.
 *
 * Returns `undefined` — never `[]` — when nothing survives, so "absent" and "present but
 * empty" cannot diverge downstream.
 */
export function normalizeCriteria(raw: unknown): AcceptanceCriteria | undefined {
  let parts: string[];
  if (Array.isArray(raw)) {
    parts = raw.filter((x): x is string => typeof x === 'string');
  } else if (typeof raw === 'string') {
    parts = raw.split(/\r?\n/);
  } else {
    return undefined;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    // Strip a leading bullet ("- ", "* ", "• ") or ordinal ("1. ", "2) ") marker.
    const cleaned = part.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!cleaned) continue;
    const capped = cleaned.length > MAX_CRITERION_CHARS
      ? cleaned.slice(0, MAX_CRITERION_CHARS - 1).trimEnd() + '…'
      : cleaned;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
    if (out.length >= MAX_CRITERIA) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Adopt criteria off a ledger event, enforcing the independence property: only an event from
 * a {@link CRITERIA_AUTHORS} actor may carry them. Returns `undefined` for every other actor
 * — including a build worker appending a perfectly well-formed `criteria` field.
 */
export function adoptCriteriaFromEvent(actor: string, raw: unknown): AcceptanceCriteria | undefined {
  if (!CRITERIA_AUTHORS.has(actor)) return undefined;
  return normalizeCriteria(raw);
}

// ---------------------------------------------------------------------------
// The requirement gate
// ---------------------------------------------------------------------------

export type CriteriaGateResult =
  /** The item may be queued. `exempt` marks a grandfathered/planning-lane pass, which every
   *  operator surface must render as an explicit "no criteria" note, never as a blank. */
  | { ok: true; exempt: boolean }
  /** The item may NOT be queued. `reason` is operator-facing. */
  | { ok: false; reason: string };

/** Is an item captured at `capturedAt` grandfathered (captured before criteria existed)? */
export function isCriteriaGrandfathered(capturedAt: string | undefined): boolean {
  if (!capturedAt) return true;           // no capture timestamp at all ⇒ a legacy replay
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return true;   // unparseable ⇒ treat as legacy, never strand it
  return t < Date.parse(CRITERIA_REQUIRED_FROM);
}

/**
 * The ONE predicate that decides whether an item may enter the build queue.
 *
 * Consulted by the routing wall before it emits `item.queued` — an item may not reach
 * `queued` without acceptance criteria. A `false` result is treated by the reactor exactly
 * like a garbled route: retry with backoff, then cap into an ops park. It is never
 * downgraded into "queue it anyway with a placeholder", because a placeholder criterion is
 * indistinguishable from none and would re-open the hole this slice closes.
 */
export function criteriaGate(input: {
  criteria: AcceptanceCriteria | undefined;
  capturedAt: string | undefined;
  lane?: string;
}): CriteriaGateResult {
  if (input.criteria && input.criteria.length > 0) return { ok: true, exempt: false };
  if (input.lane && EXEMPT_LANES.has(input.lane)) return { ok: true, exempt: true };
  if (isCriteriaGrandfathered(input.capturedAt)) return { ok: true, exempt: true };
  return {
    ok: false,
    reason:
      'no acceptance criteria — an item may not be queued without them. The routing block must ' +
      'carry a CRITERIA: list of falsifiable, observable statements, authored from the request ' +
      'text alone.',
  };
}

// ---------------------------------------------------------------------------
// Prompt contract (injected, never assumed present in a target's prompt file)
// ---------------------------------------------------------------------------

/**
 * The criteria half of the routing output contract, appended to whatever router prompt a
 * target repo happens to ship.
 *
 * It is INJECTED rather than merely documented in `prompts/router.md` because that file
 * is copied into each target repo and versions independently — a target running a
 * pre-criteria copy would otherwise never emit CRITERIA and every one of its build routes
 * would fail the gate. Injecting makes the contract a property of the code doing the
 * enforcing, so the two can never drift apart.
 */
export const CRITERIA_CONTRACT = `
## CRITERIA — required on every \`build\` route

A \`build\` route MUST also emit a \`CRITERIA:\` block: 2-5 lines, one \`- \` bullet each,
stating what must be OBSERVABLY TRUE once the work is done. A build route without CRITERIA is
rejected and re-routed — it does not reach the queue.

\`\`\`
CRITERIA:
- <a falsifiable statement about observable behaviour>
- <another>
\`\`\`

Write them from the REQUEST TEXT ALONE, before anything is built. Rules:
- Each line must be checkable against a diff or a running surface by someone who did not do
  the work — "the export button downloads a CSV with one row per booking", not "export works well".
- State the OUTCOME, never the implementation route ("...appears on the detail view", not
  "...add a renderCriteria() helper").
- Falsifiable means a reviewer can point at the diff and say "no, that one is not met".
- 2-5 lines. Fewer than 2 is not a bar; more than 5 is a spec, and only the first ${MAX_CRITERIA} are kept.
- Do NOT restate the SPEC. CRITERIA are how you would REFUTE that the SPEC was delivered.
`.trim();

// ---------------------------------------------------------------------------
// Shared render helpers (one formatter per surface family, no per-caller drift)
// ---------------------------------------------------------------------------

/** Shown when an item has no criteria and no recorded reason to be missing them. */
export const NO_CRITERIA_NOTE = 'no acceptance criteria recorded';
/** Shown when the absence is a RECORDED exemption (grandfathered capture / code-less lane). */
export const EXEMPT_CRITERIA_NOTE = 'no acceptance criteria (item predates the requirement)';

/**
 * The one line a surface shows in place of criteria — never a blank, and never the wrong
 * excuse: a genuinely un-criteria'd item must not borrow the grandfathering explanation.
 */
export function criteriaAbsenceNote(exempt: boolean | undefined): string {
  return exempt ? EXEMPT_CRITERIA_NOTE : NO_CRITERIA_NOTE;
}

/**
 * Format criteria as plain text lines for terminal/markdown surfaces. Returns a single
 * absence note when there are none, so a caller cannot accidentally render silence in place
 * of a missing bar.
 */
export function formatCriteriaLines(
  criteria: AcceptanceCriteria | undefined,
  opts: { indent?: string; exempt?: boolean } = {},
): string[] {
  const indent = opts.indent ?? '';
  if (!criteria || criteria.length === 0) return [`${indent}${criteriaAbsenceNote(opts.exempt)}`];
  return criteria.map((c) => `${indent}- ${c}`);
}
