/**
 * doc-claims.ts — pins the NUMBERS, the `file:line` CITATIONS, and the EXISTENCE CLAIMS in
 * `docs/plane-flows.md`, `docs/limitations.md` and `docs/method.md` to the source they describe.
 *
 * Why this exists: both documents drifted. `plane-flows.md` said a breaker tripped on the
 * "third attempt" while `BUILDER_BREAKER_N` had been 5 for months; `limitations.md` advertised
 * a schema-versioning gap that had since been closed and cited three line numbers that had
 * moved. A reader who had only read those files reached three wrong conclusions about the
 * plane in one sitting. For a published framework whose pitch is "a diagram that flatters the
 * system is useless when something breaks", that is the highest-severity defect class in the
 * repo — and the only durable answer is the one `lane-matrix.ts` already applies to the guard
 * matrix: derive one side from source and fail CI when the two disagree.
 *
 * The pin is inline and invisible. The doc writes the number the reader sees, immediately
 * followed by an HTML comment naming the constant:
 *
 *     a pick guard of **5**<!--pin:BUILDER_BREAKER_N--> attempts
 *
 * so the tested value IS the rendered value — there is no second copy of the number that can
 * quietly disagree with the prose. Citations use the same shape:
 *
 *     (`packages/core/src/ledger.ts:129`<!--cite:ledgerAppendWrite-->)
 *
 * and are checked by READING the cited line and asserting it still contains the code the
 * citation claims to point at. A line that drifts fails with the line number it drifted to,
 * so the fix is one edit.
 *
 * THE THIRD KIND: EXISTENCE (WI-196)
 * ----------------------------------
 * Numbers and citations between them could not catch the worst thing either doc did — assert
 * that a CAPABILITY EXISTS. Both `plane-flows.md` and `method.md` said the reactor produced work
 * items "with acceptance criteria" for weeks while the concept `criteria` appeared nowhere in
 * `packages/core/src`; it became true only when WI-193 shipped the field. The sentence carried no
 * number and cited no line, so the tripwire — which the same day caught 26 drifted citations —
 * had nothing to bite on. A published framework describing a feature it does not have is a worse
 * defect than a stale threshold, because the reader cannot even discover the gap by testing.
 *
 * An existence marker binds a doc sentence to a SYMBOL — a schema field, an exported function, a
 * config key, a parameter — and asserts the symbol is really declared in the module the claim
 * names, and (optionally) that named other modules really reference it:
 *
 *     a short list of falsifiable **acceptance criteria**<!--exists:itemCriteriaField-->
 *
 * The reference half is what makes it more than a spell-check on the codebase: a field can be
 * declared and dead. "The reactor produces items carrying criteria" is only true if `reactor.ts`
 * writes them, so that claim registers `reactor.ts` as a reference site and fails if it stops.
 *
 * Same anti-theatre properties as the other two kinds — one authored side (the registry states a
 * PATTERN, never the symbol's existence, which is derived from source text every run), bijection
 * with the markers, and a probe that throws rather than defaults.
 *
 * THE METHOD DOC (WI-202)
 * -----------------------
 * `method.md` was the OTHER half of that same incident — it said "with acceptance criteria" on the
 * same day `plane-flows.md` did — and it was covered by nothing at all, because `DOC_PATHS` never
 * named it. It is also the doc an outsider reads to decide whether the method is worth anything,
 * so a false claim there costs the most and is discoverable by the fewest readers.
 *
 * It pins ALMOST ENTIRELY THROUGH EXISTENCE MARKERS, and that is a property of the document rather
 * than a shortcut: a principles doc states capabilities ("the remainder is auto-captured", "the
 * flag defaults off") and cites other DOCS, not source lines. It carries no thresholds and no
 * `file.ts:NNN` citations, so the numeric and citation halves have nothing to bite on here — the
 * honest coverage is the third kind. The unpinned-bold sweep still runs over it (see
 * `UNPINNED_SWEEP_DOCS`) so the first threshold that ever arrives in it arrives pinned.
 *
 * The marker pass found two sentences that had gone false under it, both of the class the header
 * warns about — a live symbol with stale framing (limit 5). Deferred work was described as
 * "evidence, not a work item" after WI-177 started auto-capturing it as a child item, and
 * decomposition was described as routing queueing a planning child when routing in fact parks
 * first and the child follows the operator's approval. Neither was re-anchored onto whatever
 * survived; both sentences were rewritten to what the code does. That order — fix the claim, then
 * pin it — is the whole discipline.
 *
 * THE ROADMAP DOC (WI-206)
 * ------------------------
 * `operating-model.md` is the third doc and the awkward one: it is MOSTLY UNBUILT. It described
 * `scope.claimed`, `plan.defined`, `loopkit attended start` and `loopkit reconcile` in the present
 * indicative while none of them existed anywhere in `packages/core/src` — not a lie (its status
 * line said the layers were roadmap) but exactly the shape a first-time reader mis-reads, in the
 * doc a launch post points at.
 *
 * The fix was editorial first: every capability there now carries a ✅/⚪ status mark, reusing
 * `plane-flows.md`'s vocabulary rather than inventing a second one, and planned material left the
 * present indicative. Markers came second, and only on the ✅ subset — five claims, which is the
 * whole shipped surface of that page. The doc states that rule about itself, so ✅ and "carries a
 * marker" are one thing and a future ✅ arrives pinned. Marking a mostly-roadmap doc is only safe
 * BECAUSE the unmarked sentences are visibly labelled ⚪: without the marks, an unmarked sentence
 * would read as "checked and fine" (limit 2 below), which is worse than no markers at all.
 *
 * Two claims were false rather than merely early, both found by checking the doc's concrete nouns
 * against source: "every event carries an optional `target`" (the envelope has no such field — it
 * is stamped on `item.captured` and inherited through the fold) and "Touches, surfaces, risk
 * patterns are path prefixes" (risk patterns are substring matches). Both sentences were rewritten
 * to what the code does before anything was pinned to them.
 *
 * WHAT THIS STILL CANNOT CATCH — read this before trusting a green run
 * -------------------------------------------------------------------
 * The point of the mechanism is that it earns a specific, narrow trust. Over-trusting it is the
 * same failure as the drift it replaces, so the limits are stated rather than implied:
 *
 *  1. IT PROVES EXISTENCE, NEVER BEHAVIOUR. `criteria?: string[]` being declared and referenced
 *     says nothing about whether criteria are enforced, correct, or reached at runtime. A field
 *     that is written and never read passes. Only the real test suite speaks to behaviour.
 *  2. IT CANNOT SEE AN UNMARKED SENTENCE. Every claim here exists because a human chose to mark
 *     it. Unlike bolded numbers — where "if you bold a threshold you pin it" is mechanically
 *     enforceable, because a bare `**12**` is recognisable — a prose capability assertion has no
 *     detectable shape. There is no sweep for "this paragraph promises something"; a new
 *     unmarked false claim lands exactly as the criteria one did. This is the mechanism's
 *     biggest hole and no amount of regex closes it.
 *  3. IT CANNOT SEE A CONTRADICTION BETWEEN TWO DOCS. Plate 02 of `plane-flows.md` said build
 *     worktrees open from ambient `HEAD` while `limitations.md`, in the same repo, said WI-183
 *     had fixed exactly that. Each sentence is individually markable and individually
 *     true-looking; nothing here compares two docs' MEANINGS. See the note in
 *     `doc-claims.test.ts` for why no mechanical check was built for this.
 *  4. A REFERENCE SITE PROVES A PATTERN MATCHES A LINE, NOT THAT THE LINE IS LIVE CODE. Patterns
 *     are matched per line against source TEXT, so a match inside a comment or a dead branch
 *     counts. Registry patterns are written to be call-shaped for that reason.
 *  5. IT CANNOT SEE STALE FRAMING AROUND A LIVE SYMBOL. "The reactor slices anything too big
 *     into children" can go from true to misleading with the symbol untouched — scope, defaults
 *     and ordering all drift under a still-declared name. Pinning `criteria` proves the field is
 *     there, not that the paragraph around it still describes what the plane does.
 *  6. A DOC THAT SAYS NOTHING PASSES EVERYTHING. Deleting a claim removes its marker and its
 *     registry entry together, which is a legitimate two-sided edit. The bijection stops the
 *     one-sided delete (a marker gone while the claim stands, or vice versa), not an honest
 *     retreat into vagueness. Silence is always the cheapest way to be un-wrong.
 *
 * Anti-theatre properties, deliberately:
 *
 *  - Only ONE side is authored. The source value is parsed out of the real `.ts` file every
 *    run; nothing here restates it. A test that hardcoded both sides would pass forever.
 *  - Every probe demands EXACTLY ONE (or, for the multi-site probes, a set of mutually
 *    AGREEING) match and throws otherwise. A renamed constant fails loud, never silently
 *    "finds nothing and passes".
 *  - The registry and the markers form a BIJECTION (checked in the test): a marker in a doc
 *    with no claim behind it, or a claim whose marker was deleted from the doc, both fail.
 *    Deleting the awkward number is therefore not a way to make the test go quiet.
 *  - A bolded bare number in `plane-flows.md` with no pin marker fails. The convention is
 *    "if you bold a threshold, you pin it" — which is what stops the next number from
 *    arriving unpinned.
 *
 * Like `lane-matrix.ts`, this module only READS source as text. It imports nothing from
 * `dispatch.ts`/`reactor.ts`/`config.ts`, so it stays usable while those files are mid-refactor.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Locating the tree (same walk-up discipline as lane-matrix.ts — never a fixed depth)
// ---------------------------------------------------------------------------

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'doc-claims.ts'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `doc-claims: could not locate the package root (a directory with package.json AND src/doc-claims.ts) ` +
    `walking up from ${startDir}.`,
  );
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'docs', 'plane-flows.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `doc-claims: could not locate the repo root (a directory containing docs/plane-flows.md) ` +
    `walking up from ${startDir}.`,
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = findPackageRoot(__dirname);
export const REPO_ROOT = findRepoRoot(PACKAGE_ROOT);

/** Repo-relative paths, exactly as the docs cite them. */
const SRC = 'packages/core/src';
export const SOURCE_PATHS = {
  dispatch: `${SRC}/beats/dispatch.ts`,
  reactor: `${SRC}/beats/reactor.ts`,
  deploy: `${SRC}/deploy.ts`,
  worktreeDeps: `${SRC}/beats/worktree-deps.ts`,
  config: `${SRC}/config.ts`,
  schema: `${SRC}/schema.ts`,
  ledger: `${SRC}/ledger.ts`,
  fold: `${SRC}/fold.ts`,
  slo: `${SRC}/slo.ts`,
  acceptance: `${SRC}/acceptance.ts`,
  judge: `${SRC}/judge.ts`,
  criteria: `${SRC}/criteria.ts`,
  verdicts: `${SRC}/verdicts.ts`,
  // Added for method.md's claims (WI-202): the intake verb, the operator CLI, the disjointness
  // predicate, the felt-reliability projection and the model-routing policy.
  verbs: `${SRC}/verbs.ts`,
  cli: `${SRC}/cli.ts`,
  touches: `${SRC}/touches.ts`,
  trajectory: `${SRC}/trajectory.ts`,
  routing: `${SRC}/routing.ts`,
  // Added for operating-model.md's claims (WI-206): the attended-session claim verbs and the
  // target manifest reader — the two shipped halves of a doc that is otherwise roadmap.
  session: `${SRC}/session.ts`,
  target: `${SRC}/target.ts`,
} as const;
export type SourceKey = keyof typeof SOURCE_PATHS;

export const DOC_PATHS = {
  'plane-flows': 'docs/plane-flows.md',
  'limitations': 'docs/limitations.md',
  'method': 'docs/method.md',
  'operating-model': 'docs/operating-model.md',
} as const;
export type DocKey = keyof typeof DOC_PATHS;

/**
 * Docs the "bold a threshold ⇒ pin it" sweep runs over. `plane-flows.md` states the convention
 * about itself; `method.md` joins it (WI-202) while it contains ZERO bolded numbers, which is the
 * cheapest moment to adopt a ratchet — the sweep costs nothing today and refuses the first
 * unpinned threshold that ever lands in the method doc. `limitations.md` is deliberately NOT
 * swept: it quotes numbers it is arguing *about* (sizes, versions, dates in prose) and a sweep
 * there would fire on sentences that are not thresholds — a check with false alarms gets disabled.
 * `operating-model.md` joins on the same terms as `method.md` (WI-206): it bolds no bare number
 * today, so the ratchet costs nothing now and refuses the first unpinned threshold that lands.
 */
export const UNPINNED_SWEEP_DOCS: DocKey[] = ['plane-flows', 'method', 'operating-model'];

/** All source text, read once. Injectable so the test can exercise the machinery hermetically. */
export type SourceBundle = Record<SourceKey, string>;
export type DocBundle = Record<DocKey, string>;

export function readSources(root: string = REPO_ROOT): SourceBundle {
  const out = {} as SourceBundle;
  for (const [k, p] of Object.entries(SOURCE_PATHS) as [SourceKey, string][]) {
    out[k] = readFileSync(join(root, p), 'utf8');
  }
  return out;
}

export function readDocs(root: string = REPO_ROOT): DocBundle {
  const out = {} as DocBundle;
  for (const [k, p] of Object.entries(DOC_PATHS) as [DocKey, string][]) {
    out[k] = readFileSync(join(root, p), 'utf8');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source probes — every number comes from here, never from this file's own text
// ---------------------------------------------------------------------------

/** One place a value is written in source. */
export interface ProbeSite {
  file: SourceKey;
  /** Must capture the value in group 1. Applied globally. */
  pattern: RegExp;
}

/**
 * Read a value from one or more source sites and require them to AGREE.
 *
 * Several of these thresholds are written twice on purpose (a `DEFAULTS` entry in `config.ts`
 * and an inline `?? n` fallback at the read site, so a partial config never yields `undefined`).
 * Probing every site and demanding agreement makes this test catch the drift BETWEEN those
 * copies as well as the drift between source and doc — a strictly stronger check than reading
 * whichever copy happened to be convenient.
 *
 * Throws (never returns a default) when a site matches nothing or the sites disagree: a
 * renamed constant must fail loudly, not quietly stop being checked.
 */
export function probeNumber(id: string, sites: ProbeSite[], sources: SourceBundle): number {
  const found: { where: string; value: number }[] = [];
  for (const site of sites) {
    const re = new RegExp(site.pattern.source, site.pattern.flags.includes('g') ? site.pattern.flags : site.pattern.flags + 'g');
    const text = sources[site.file];
    let m: RegExpExecArray | null;
    let hits = 0;
    while ((m = re.exec(text)) !== null) {
      hits++;
      const n = Number(m[1]!.replace(/_/g, ''));
      if (!Number.isFinite(n)) {
        throw new Error(`doc-claims: probe '${id}' matched a non-numeric value ${JSON.stringify(m[1])} in ${SOURCE_PATHS[site.file]}`);
      }
      found.push({ where: `${SOURCE_PATHS[site.file]} (${site.pattern.source})`, value: n });
    }
    if (hits === 0) {
      throw new Error(
        `doc-claims: probe '${id}' found NO match for ${site.pattern} in ${SOURCE_PATHS[site.file]}. ` +
        `The constant was renamed, moved or reshaped — update the probe in doc-claims.ts deliberately ` +
        `(and check whether docs/ still states the right number), never delete the claim to silence this.`,
      );
    }
  }
  const distinct = [...new Set(found.map(f => f.value))];
  if (distinct.length !== 1) {
    throw new Error(
      `doc-claims: probe '${id}' read DISAGREEING values from source — the duplicated copies of this ` +
      `threshold have drifted apart:\n${found.map(f => `  ${f.value} @ ${f.where}`).join('\n')}`,
    );
  }
  return distinct[0]!;
}

// ---------------------------------------------------------------------------
// The numeric claim registry
// ---------------------------------------------------------------------------

export interface NumericClaim {
  /** Marker id: the doc writes `**<value>**<!--pin:<id>-->`. */
  id: string;
  doc: DocKey;
  /** One line, for the failure message — what the reader is being told. */
  what: string;
  sites: ProbeSite[];
  /**
   * Optional unit conversion applied to the source value before comparing with the doc.
   * Only for cases where the doc legitimately renders a different unit (ms → s).
   */
  transform?: (n: number) => number;
  transformNote?: string;
}

const cfg = (pattern: RegExp): ProbeSite => ({ file: 'config', pattern });

export const NUMERIC_CLAIMS: NumericClaim[] = [
  // ── The four independent counters. Conflating them is what made the "requeue arm is
  //    unreachable" defect possible in the first place, so each is pinned separately.
  {
    id: 'BUILDER_BREAKER_N',
    doc: 'plane-flows',
    what: "dispatch's pick guard — attempts before an item stops being picked",
    sites: [{ file: 'dispatch', pattern: /^export const BUILDER_BREAKER_N = (\d+);/m }],
  },
  {
    id: 'breakerN',
    doc: 'plane-flows',
    what: "the doctor's crash/stall retry breaker (also bounds transient ops-park requeues)",
    sites: [cfg(/^ {2}breakerN: (\d+),/m)],
  },
  // ── Judge arm-ability (WI-193 win 4). The deferral of judge-blocking used to have no
  //    stated trigger; pinning these makes "not calibrated yet" a number, not a memory.
  {
    id: 'JUDGE_CALIBRATION_SAMPLE',
    doc: 'plane-flows',
    what: 'human-accepted outcomes needed before the judge agreement rate means anything',
    sites: [{ file: 'verdicts', pattern: /^export const JUDGE_CALIBRATION_SAMPLE = (\d+);/m }],
  },
  {
    id: 'maxTransientRequeues',
    doc: 'plane-flows',
    what: "the pathologist's transient-infra requeue budget (a counter of its own, not rec.attempts)",
    sites: [
      cfg(/^ {4}maxTransientRequeues: (\d+),/m),
      { file: 'reactor', pattern: /maxTransientRequeues \?\? (\d+)/ },
    ],
  },
  {
    id: 'MAX_TRANSIENT_TIMEOUT_RETRIES',
    doc: 'plane-flows',
    what: 'gate-TIMEOUT (not gate-red) retries before the item parks',
    sites: [{ file: 'reactor', pattern: /^const MAX_TRANSIENT_TIMEOUT_RETRIES = (\d+);/m }],
  },

  // ── Dispatch picking
  {
    id: 'batchMaxItems',
    doc: 'plane-flows',
    what: 'items per worktree — 1 means batch co-location is off by default',
    sites: [cfg(/^ {2}batchMaxItems: (\d+),/m)],
  },
  {
    id: 'BATCH_SPEC_MAX',
    doc: 'plane-flows',
    what: 'max spec length (chars) for a co-locatable item',
    sites: [{ file: 'dispatch', pattern: /^const BATCH_SPEC_MAX = (\d+);/m }],
  },
  {
    id: 'quotaThresholdPct',
    doc: 'plane-flows',
    what: 'provider:window quota use that flips dispatch to collect-only',
    sites: [cfg(/^ {4}thresholdPct: (\d+),/m)],
  },
  {
    id: 'buildTimeoutMinutes',
    doc: 'plane-flows',
    what: "a build's wall-clock budget, and the base of dispatch's own claim lease",
    sites: [cfg(/^ {2}buildTimeoutMinutes: (\d+),/m)],
  },
  {
    id: 'DEFAULT_CLAIM_TTL_MINUTES',
    doc: 'plane-flows',
    what: 'how long an attended CLI session holds a claim before it reads inactive',
    sites: [{ file: 'schema', pattern: /^export const DEFAULT_CLAIM_TTL_MINUTES = (\d+);/m }],
  },

  // ── Ordering / dependencies
  {
    id: 'blockedWaitTimeoutHours',
    doc: 'plane-flows',
    what: 'how long a blocked victim waits before it is re-parked for your decision',
    sites: [
      cfg(/^ {4}blockedWaitTimeoutHours: (\d+),/m),
      { file: 'reactor', pattern: /blockedWaitTimeoutHours \?\? (\d+)/ },
    ],
  },

  // ── Acceptance
  {
    id: 'autoAfterHours',
    doc: 'plane-flows',
    what: "the 'auto' tier's silent window",
    sites: [
      cfg(/autoAfterHours: (\d+),/),
      { file: 'reactor', pattern: /autoAfterHours \?\? (\d+)/ },
    ],
  },
  {
    id: 'optionalAfterHours',
    doc: 'plane-flows',
    what: "the 'optional' tier's starting window",
    sites: [
      cfg(/optionalAfterHours: (\d+),/),
      { file: 'reactor', pattern: /optionalAfterHours \?\? (\d+)/ },
    ],
  },
  {
    id: 'reviewAfterHours',
    doc: 'plane-flows',
    what: "the 'review' tier's starting window",
    sites: [
      cfg(/reviewAfterHours: (\d+),/),
      { file: 'reactor', pattern: /reviewAfterHours \?\? (\d+)/ },
    ],
  },
  {
    id: 'holdMaxHours',
    doc: 'plane-flows',
    what: 'how long an unanswered operator reply holds an accepted item',
    sites: [{ file: 'reactor', pattern: /holdMaxHours \?\? (\d+)/ }],
  },
  {
    id: 'windowCeilingHours',
    doc: 'plane-flows',
    what: 'the ceiling self-calibration may grow an acceptance window to',
    sites: [
      cfg(/^ {8}windowCeilingHours: (\d+),/m),
      cfg(/windowCeilingHours: rawDc\?\.windowCeilingHours \?\? (\d+)/),
    ],
  },

  // ── Deploy backstop
  {
    id: 'deployBehindHours',
    doc: 'plane-flows',
    what: 'how far the deployed checkout may lag master before the SLO row goes red',
    sites: [
      { file: 'slo', pattern: /^ {2}deployBehindHours: (\d+),/m },
      cfg(/^ {4}deployBehindHours: (\d+),/m),
    ],
  },
  {
    id: 'atRiskFraction',
    doc: 'plane-flows',
    what: 'the fraction of an SLO target at which a row turns amber',
    sites: [
      { file: 'slo', pattern: /^ {2}atRiskFraction: ([\d.]+),/m },
      cfg(/^ {4}atRiskFraction: ([\d.]+),/m),
    ],
  },

  // ── Ledger (limitations.md)
  {
    id: 'lockStaleSeconds',
    doc: 'limitations',
    what: 'the ledger lock staleness window, after which another beat may reap it',
    sites: [{ file: 'ledger', pattern: /^const LOCK_STALE_MS = ([\d_]+);/m }],
    transform: n => n / 1000,
    transformNote: 'LOCK_STALE_MS is in ms; the doc states seconds',
  },
  {
    id: 'lockSpinSeconds',
    doc: 'limitations',
    what: 'how long a contender waits for the ledger lock before it judges the holder',
    sites: [{ file: 'ledger', pattern: /^const LOCK_SPIN_TIMEOUT_MS = ([\d_]+);/m }],
    transform: n => n / 1000,
    transformNote: 'LOCK_SPIN_TIMEOUT_MS is in ms; the doc states seconds',
  },
  {
    id: 'eventIdRandomBits',
    doc: 'limitations',
    what: 'the random bits an event id actually carries (the comment beside it claims 50)',
    sites: [{ file: 'schema', pattern: /Math\.random\(\) \* 2 \*\* (\d+)/ }],
  },
  {
    id: 'LEDGER_SCHEMA_VERSION',
    doc: 'limitations',
    what: 'the envelope schema version stamped on every event',
    sites: [{ file: 'schema', pattern: /^export const LEDGER_SCHEMA_VERSION = (\d+);/m }],
  },
];

// ---------------------------------------------------------------------------
// The citation registry — `file.ts:NNN` in a doc must still point at the claimed code
// ---------------------------------------------------------------------------

export interface CitationClaim {
  /** Marker id: the doc writes `` `<path>:<line>` ``<!--cite:<id>-->. */
  id: string;
  file: SourceKey;
  /** Substring the cited line must contain. Chosen to be stable under formatting, not unique-ish. */
  mustContain: string;
}

export const CITATION_CLAIMS: CitationClaim[] = [
  // dispatch
  { id: 'detachedTargetGuard', file: 'dispatch', mustContain: 'const hasDetachedTargetBuild' },
  { id: 'collectorSkipsTargets', file: 'dispatch', mustContain: 'if (rec.target) continue;' },
  { id: 'claimArbitration', file: 'dispatch', mustContain: 'decideClaimArbitration(candidateIds' },
  { id: 'batchColocation', file: 'dispatch', mustContain: 'if (batchMax > 1 && isBatchEligible(rec))' },
  { id: 'quotaDegraded', file: 'dispatch', mustContain: 'if (quotaPressure.degraded)' },
  { id: 'providerFallback', file: 'dispatch', mustContain: "registry.markUnhealthy(provider!.name, r.error ?? 'auth failure')" },
  { id: 'openBuildWorktreeHead', file: 'dispatch', mustContain: "'worktree', 'add', '-b', branch, wtPath, baseRef" },
  { id: 'planScopedCommit', file: 'dispatch', mustContain: 'export function planScopedCommit(' },
  { id: 'checkTouchesOverstep', file: 'dispatch', mustContain: 'function checkTouchesOverstep(' },
  { id: 'checkSpine', file: 'dispatch', mustContain: 'function checkSpine(' },
  { id: 'postIntegrationRegate', file: 'dispatch', mustContain: 'opts.postIntegrationGateResult' },
  { id: 'pushRaceReset', file: 'dispatch', mustContain: "['reset', '--hard', 'origin/master']" },
  { id: 'pushRaceRegate', file: 'dispatch', mustContain: 'opts.nonFfGateResult' },
  { id: 'queuedClaimDeference', file: 'dispatch', mustContain: '!isClaimActive(r, foldResult.sessions, Date.now())' },
  { id: 'runPlanningLane', file: 'dispatch', mustContain: 'export async function runPlanningLane(' },
  { id: 'runTargetLane', file: 'dispatch', mustContain: 'export async function runTargetLane(' },
  { id: 'salvageOnCrash', file: 'dispatch', mustContain: "salvageFn(w.wtPath, rec.id, w.attempt, artifactDir, 'crash'" },
  { id: 'deferralCapture', file: 'dispatch', mustContain: 'export async function captureDeferralChildren(' },

  // reactor
  { id: 'repairItemCapture', file: 'reactor', mustContain: "source: 'reactor:pathology'" },
  { id: 'blockedVictimRelease', file: 'reactor', mustContain: 'blocker && blocker.state ===' },
  { id: 'blockedVictimTimeout', file: 'reactor', mustContain: 'reason: `blocked-victim wait-timeout' },
  { id: 'acceptWithholdKeys', file: 'reactor', mustContain: 'const PROVISIONAL_ACCEPT_SLO_KEYS' },
  { id: 'mustNeverAutoAccepts', file: 'reactor', mustContain: "if (tier === 'must') continue;" },
  { id: 'staleClaimReap', file: 'reactor', mustContain: 'reapStaleClaims(' },

  // elsewhere
  { id: 'requestDeployOnMerge', file: 'deploy', mustContain: 'export async function requestDeployOnMerge(' },
  { id: 'stalePendingDeployEvents', file: 'deploy', mustContain: 'export function stalePendingDeployEvents(' },
  { id: 'fireDeployOnMerge', file: 'worktreeDeps', mustContain: 'export function fireDeployOnMerge(' },
  { id: 'deployProbe', file: 'slo', mustContain: 'export function makeDeployProbe(' },
  { id: 'foldDeploySucceeded', file: 'fold', mustContain: "case 'deploy.succeeded':" },
  { id: 'foldRespec', file: 'fold', mustContain: "case 'item.respec':" },
  { id: 'certificationRollback', file: 'fold', mustContain: 'if (!couldBreak || !detection || !rollback)' },
  { id: 'overseerFloor', file: 'acceptance', mustContain: 'export function overseerFloor(' },
  // acceptance criteria (WI-193)
  { id: 'criteriaGate', file: 'criteria', mustContain: 'export function criteriaGate(' },
  { id: 'criteriaAuthors', file: 'criteria', mustContain: 'export const CRITERIA_AUTHORS' },
  { id: 'judgeAdvisoryOnly', file: 'judge', mustContain: 'ADVISORY-ONLY' },
  { id: 'judgeCriteriaBar', file: 'judge', mustContain: 'SPEC_SATISFIED is about the CRITERIA' },
  { id: 'calibrationProgress', file: 'verdicts', mustContain: 'export interface CalibrationProgress' },
  { id: 'ledgerAppendWrite', file: 'ledger', mustContain: 'await fh.write(line);' },
  { id: 'ledgerCorruptSkip', file: 'ledger', mustContain: 'Corrupt line — skip with a warning' },
  { id: 'ledgerLockAcquire', file: 'ledger', mustContain: 'async function acquireLock(' },
  { id: 'makeEventStampsVersion', file: 'schema', mustContain: 'v: LEDGER_SCHEMA_VERSION,' },
];

// ---------------------------------------------------------------------------
// The existence registry — a doc sentence asserting a capability must name a real symbol
// ---------------------------------------------------------------------------

/**
 * A probe could not resolve at all: the symbol a doc names is gone, is unreferenced where the
 * doc says it is used, or the registry pattern is too loose to prove anything. Distinct from
 * `Error` so `checkDocClaims` can aggregate exactly these into the report and let any genuine
 * bug in this module keep propagating.
 */
export class DocClaimProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocClaimProbeError';
  }
}

/**
 * A module the doc says USES the symbol. Declared-but-dead is the failure this catches: the
 * criteria field could have existed on the event type for weeks without the reactor ever
 * writing one, and the sentence "the reactor turns prose into an item carrying criteria"
 * would still have been false.
 */
export interface ReferenceSite {
  file: SourceKey;
  /** Matched per line against source text. Write it call-shaped, not name-shaped. */
  pattern: RegExp;
  /** One line: what this reference proves. Printed when it stops matching. */
  proves: string;
}

export interface ExistenceClaim {
  /** Marker id: the doc writes `<phrase><!--exists:<id>-->`. */
  id: string;
  /**
   * The doc(s) that must carry this marker. A LIST is the co-anchoring convention: when two docs
   * describe the same behaviour, marking both sentences with one id means a change to that symbol
   * surfaces both sentences in a single failure, and whoever fixes one has the other in front of
   * them. It is the only leverage available against the two-docs-disagreeing class (see the note
   * in doc-claims.test.ts) — every listed doc must carry the marker, so the pairing cannot rot by
   * one side quietly dropping it.
   */
  doc: DocKey | DocKey[];
  /** The symbol as a reader would grep for it — used in the failure message, not in the check. */
  symbol: string;
  /** One line: the capability the marked sentence asserts. */
  what: string;
  /** Where the symbol is DECLARED. */
  file: SourceKey;
  /** Must match the declaration line. ≥1 match required; a pattern matching everything throws. */
  declaration: RegExp;
  referencedBy?: ReferenceSite[];
}

/** Above this many declaration hits the pattern is proving nothing — treat as a broken probe. */
const VACUOUS_MATCH_LIMIT = 20;

/** The docs a claim must be marked in, always as a list. */
export function claimDocs(claim: ExistenceClaim): DocKey[] {
  return Array.isArray(claim.doc) ? claim.doc : [claim.doc];
}

/** Lines (1-based) of `text` that the pattern matches. Cloned without /g so it stays stateless. */
function matchingLines(text: string, pattern: RegExp): number[] {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  const out: number[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) out.push(i + 1);
  }
  return out;
}

/** Where the symbol was actually found this run — derived, never authored. */
export interface SymbolEvidence {
  /** `path:line` for every declaration hit. */
  declaredAt: string[];
  /** `path:line (proves)` for every required reference. */
  references: string[];
}

/**
 * Resolve one existence claim against source text.
 *
 * Throws `DocClaimProbeError` — never returns a "not found" — for the same reason `probeNumber`
 * throws: a renamed or deleted symbol must fail loudly. A probe that shrugged and returned false
 * would let the next reader assume the claim was checked when it had quietly stopped being.
 */
export function probeSymbol(claim: ExistenceClaim, sources: SourceBundle): SymbolEvidence {
  const path = SOURCE_PATHS[claim.file];
  const hits = matchingLines(sources[claim.file], claim.declaration);
  if (hits.length === 0) {
    throw new DocClaimProbeError(
      `existence claim '${claim.id}': the symbol \`${claim.symbol}\` is NOT DECLARED in ${path} ` +
      `(no line matches ${claim.declaration}). ${claimDocs(claim).map(d => DOC_PATHS[d]).join(' + ')} ` +
      `tells the reader "${claim.what}" — ` +
      `either the code never had that capability, or it was renamed. Do not re-anchor before ` +
      `re-reading the doc's sentence: if the capability is gone, the sentence is the thing to fix.`,
    );
  }
  if (hits.length > VACUOUS_MATCH_LIMIT) {
    throw new DocClaimProbeError(
      `existence claim '${claim.id}': the declaration pattern ${claim.declaration} matches ${hits.length} ` +
      `lines in ${path}. A pattern that matches that much proves nothing about \`${claim.symbol}\` — ` +
      `tighten it to the declaration.`,
    );
  }
  const references: string[] = [];
  for (const site of claim.referencedBy ?? []) {
    const sitePath = SOURCE_PATHS[site.file];
    const refHits = matchingLines(sources[site.file], site.pattern);
    if (refHits.length === 0) {
      throw new DocClaimProbeError(
        `existence claim '${claim.id}': \`${claim.symbol}\` is declared in ${path}, but ${sitePath} no ` +
        `longer references it (${site.pattern} matches no line). That reference is what made the claim ` +
        `true — ${site.proves}. A declared-but-unused symbol still leaves ` +
        `${claimDocs(claim).map(d => DOC_PATHS[d]).join(' + ')} claiming "${claim.what}" of a plane ` +
        `that does not do it.`,
      );
    }
    references.push(`${sitePath}:${refHits.join('/')} (${site.proves})`);
  }
  return { declaredAt: hits.map(l => `${path}:${l}`), references };
}

export const EXISTENCE_CLAIMS: ExistenceClaim[] = [
  // ── The claim that motivated this whole marker kind. Both docs asserted the reactor produced
  //    items "with acceptance criteria" while `criteria` existed nowhere in src; WI-193 made it
  //    true afterwards. Declaration alone is not enough here — the sentence is about the REACTOR
  //    authoring them and the FOLD carrying them, so both are reference sites.
  {
    id: 'itemCriteriaField',
    doc: 'plane-flows',
    symbol: 'criteria?: string[] (on the captured-item event)',
    what: 'the reactor turns prose into a work item carrying falsifiable acceptance criteria',
    file: 'schema',
    declaration: /^\s{2}criteria\?: string\[\];$/,
    referencedBy: [
      {
        file: 'reactor',
        pattern: /normalizeCriteria\(fields\['CRITERIA'\]\)/,
        proves: 'the routing wall parses a CRITERIA block off the router output and emits it',
      },
      {
        file: 'fold',
        pattern: /adoptCriteriaFromEvent\(ev\.actor,/,
        proves: 'the fold carries criteria onto the item, from authorized actors only',
      },
    ],
  },
  // ── The judge's bar. "SPEC_SATISFIED is measured against the criteria" is false the moment the
  //    prompt builder stops taking them, or dispatch stops passing them — which is a caller-side
  //    regression a citation on judge.ts alone would never see.
  {
    id: 'judgePromptCriteriaArg',
    doc: 'plane-flows',
    symbol: 'buildJudgePrompt(..., criteria?: string[])',
    what: "the judge is handed the item's acceptance criteria as the bar for SPEC_SATISFIED",
    file: 'judge',
    declaration: /^\s{2}criteria\?: string\[\],$/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /buildJudgePrompt\(.*criteria\)/i,
        proves: "the lane that runs the judge actually passes the item's criteria into the prompt",
      },
    ],
  },
  // ── The grandfathering promise in limitations.md. If the flag stops being folded, that doc's
  //    "the exemption is rendered in words, never a blank" becomes a claim about nothing.
  {
    id: 'criteriaExemptFlag',
    doc: 'limitations',
    symbol: 'criteriaExempt',
    what: 'an item captured before the requirement queues without criteria and folds as exempt',
    file: 'fold',
    declaration: /^\s{2}criteriaExempt\?: boolean;$/,
    referencedBy: [
      {
        file: 'fold',
        pattern: /rec\.criteriaExempt = \(critGate\.ok && critGate\.exempt\)/,
        proves: 'the fold sets the flag from the gate result rather than leaving it assumed',
      },
      {
        file: 'criteria',
        pattern: /^export const CRITERIA_REQUIRED_FROM = '/,
        proves: 'the cutoff the exemption is computed from is a real, single, stated instant',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // method.md (WI-202). The method doc states CAPABILITIES and cites other docs; it carries no
  // thresholds and no file:line citations, so existence is the whole of its coverage.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── "One door in": the doc's opening promise is that transport is incidental. That is only
  //    true if every transport lands the SAME event and one fold reads it — a second intake
  //    shape (a queue write that skips capture) would falsify the section without renaming a
  //    thing, so both halves are reference sites.
  {
    id: 'oneDoorCapture',
    doc: 'method',
    symbol: "item.captured",
    what: 'every intent, whatever its transport, lands as one item.captured event and routes identically',
    file: 'schema',
    declaration: /^ {2}'item\.captured': ItemCapturedData;$/,
    referencedBy: [
      {
        file: 'verbs',
        pattern: /makeEvent\(actor, wiId, 'item\.captured', \{/,
        proves: 'the capture verb every transport calls emits exactly that event, not a private shape',
      },
      {
        file: 'fold',
        pattern: /^ +case 'item\.captured':$/,
        proves: 'one fold case is where a captured item becomes board state — the single routing path',
      },
    ],
  },

  // ── "The orchestrator holds no context." The section's whole argument is that coordination
  //    state is re-derived, never remembered. A fold that existed but was called once at boot and
  //    cached would make the paragraph false with the symbol untouched, so the references are the
  //    per-beat re-reads in BOTH beats.
  {
    id: 'foldOrchestrator',
    doc: 'method',
    symbol: 'fold(events)',
    what: 'the orchestrator is a fold over the ledger, reconstructed from events on every beat',
    file: 'fold',
    declaration: /^export function fold\(events: LedgerEvent\[\]/,
    referencedBy: [
      {
        file: 'reactor',
        pattern: /const foldResult = fold\(allEvents\);/,
        proves: 'the reactor rebuilds its whole view from events inside the beat, holding nothing across beats',
      },
      {
        file: 'dispatch',
        pattern: /fold\(await tx\.loadAll\(\)\)/,
        proves: 'dispatch re-folds under the ledger lock before it writes, rather than trusting a carried view',
      },
    ],
  },

  // ── "Two in-flight builds may never share a Touches set" — the claim that lets the synthesizer
  //    disappear. One predicate, applied to the in-flight set AND to the group being assembled;
  //    losing either reference re-opens two-workers-one-file while `touchesConflict` still exists.
  {
    id: 'touchesDisjointInflight',
    doc: 'method',
    symbol: 'touchesConflict(a, b)',
    what: 'no two in-flight builds may share a Touches set — enforced before the work, deterministically',
    file: 'touches',
    declaration: /^export function touchesConflict\(a: string \| undefined, b: string \| undefined\): boolean \{$/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /if \(inflightTouches && touchesConflict\(rec\.touches, inflightTouches\)\) continue;/,
        proves: 'the picker skips any candidate overlapping work already in flight',
      },
      {
        file: 'dispatch',
        pattern: /groups\.some\(g => touchesConflict\(rec\.touches, groupTouches\(g\)\)\)/,
        proves: 'candidates are also held disjoint from every group being assembled this beat',
      },
    ],
  },

  // ── The trade paragraph. This sentence WAS false: it said a deferral is "evidence, not a work
  //    item" long after WI-177 started auto-capturing a child from the manifest's `deferred`
  //    field. The corrected sentence is pinned on both halves — that a child is captured at all,
  //    and that what it emits is a CAPTURE (intake), never a queue event.
  {
    id: 'deferralChildCapture',
    doc: 'method',
    symbol: 'captureDeferralChildren()',
    what: "a worker's stated remainder is auto-captured at merge as one child item on the intake, never queued",
    file: 'dispatch',
    declaration: /^export async function captureDeferralChildren\($/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /await captureDeferralChildren\(opts\.ledgerDir, \[\{/,
        proves: 'the merge path really calls it, so a partial build cannot close leaving no trace on the board',
      },
      {
        file: 'dispatch',
        pattern: /events\.push\(makeEvent\('dispatch', childId, 'item\.captured', \{/,
        proves: 'the child is CAPTURED and nothing else — a worker can propose, it can never queue a build',
      },
    ],
  },

  // ── "Decomposition happens at intake, not mid-flight." Also rewritten: routing PARKS an
  //    oversized intent and the planning child follows the operator's approval. The references
  //    pin both the lane the child is queued into and the routing site that emits it.
  {
    id: 'decompositionAtIntake',
    doc: 'method',
    symbol: 'makeDecompositionChildEvents()',
    what: 'an oversized intent parks, and once approved a planning-lane child is queued to split it before any builder runs',
    file: 'reactor',
    declaration: /^function makeDecompositionChildEvents\($/,
    referencedBy: [
      {
        file: 'reactor',
        pattern: /^ {8}lane: 'planning',$/,
        proves: 'the child is queued into the planning lane, which is what splits the epic before a build',
      },
      {
        file: 'reactor',
        pattern: /maybeEmitDecompositionChild\(rec\.id, reason\);/,
        proves: 'the routing step emits the child on the approved-reroute path rather than stranding the park',
      },
    ],
  },

  // ── Tiered acceptance, half one: classification reads the REAL diff. "not the item's own
  //    declared metadata" is the load-bearing clause — if the reactor went back to classifying
  //    from declared touches, a code change could launder itself as "nothing changed" while
  //    `acceptanceClassifyFiles` still existed.
  {
    id: 'mergeDiffTiering',
    doc: 'method',
    symbol: 'acceptanceClassifyFiles(evidenceFiles, declaredTouches)',
    what: 'a merged item is tiered from what it actually changed at merge time, not from its declared touches',
    file: 'acceptance',
    declaration: /^export function acceptanceClassifyFiles\($/,
    referencedBy: [
      {
        file: 'reactor',
        pattern: /acceptanceClassifyFiles\(rec\.mergeChangedFiles, rec\.touches\)/,
        proves: 'the acceptance step feeds the merge-time diff first and declared touches only as fallback',
      },
    ],
  },

  // ── Tiered acceptance, half two: the ceiling. "money, auth, or migrations … waits for a human,
  //    forever" is two separate facts — that risk paths classify as `must`, and that `must` is
  //    never swept up by the auto-accept loop. Co-anchored in plane-flows via the
  //    `mustNeverAutoAccepts` citation on the same line the second reference names.
  {
    id: 'mustTierWaitsForHuman',
    doc: 'method',
    symbol: "AcceptanceTier 'must'",
    what: 'a risk-flagged or judge-failed change waits for a human and never auto-accepts',
    file: 'acceptance',
    declaration: /^export type AcceptanceTier = 'auto' \| 'optional' \| 'review' \| 'must';$/,
    referencedBy: [
      {
        file: 'acceptance',
        pattern: /reason: `touches risk-flagged paths/,
        proves: 'a diff hitting a configured risk path classifies as must, rather than being a policy in prose',
      },
      {
        file: 'reactor',
        pattern: /if \(tier === 'must'\) continue;/,
        proves: "the auto-accept loop skips 'must' outright — the wait is unbounded, not a longer window",
      },
    ],
  },

  // ── "Staged flags — the rollback is written before the flip." The claim is specifically that an
  //    UNSET flag is today's behaviour, which needs the default AND the read site: a `?? true` at
  //    the read would make the doc false while the config default still said false.
  {
    id: 'stagedFlagDefaultsOff',
    doc: 'method',
    symbol: 'execution.detachedDispatch',
    what: 'the staged dispatch flag defaults off, so an unset flag is byte-for-byte the shipped behaviour',
    file: 'config',
    declaration: /^ {4}detachedDispatch\?: boolean;$/,
    referencedBy: [
      {
        file: 'config',
        pattern: /^ {4}detachedDispatch: false,$/,
        proves: 'the shipped default really is off, not merely documented as off',
      },
      {
        file: 'dispatch',
        pattern: /cfg\.execution\?\.detachedDispatch \?\? false/,
        proves: 'the read site fails closed, so a missing config section cannot arm the flag',
      },
    ],
  },

  // ── ADR-009's completion path. The paragraph's point is that the nudge stopped being a nudge
  //    into the void — which is true only while the operator verb and the fold case both exist.
  {
    id: 'portabilityCompletion',
    doc: 'method',
    symbol: 'item.certification-amended',
    what: 'the portability nudge has a real completion path — an operator verb that appends an event the fold applies',
    file: 'schema',
    declaration: /^ {2}'item\.certification-amended': ItemCertificationAmendedData;$/,
    referencedBy: [
      {
        file: 'cli',
        pattern: /^ {4}case 'portability':$/,
        proves: 'the operator verb exists on the CLI, so the reply has somewhere to be typed',
      },
      {
        file: 'fold',
        pattern: /^ +case 'item\.certification-amended': \{$/,
        proves: 'the fold applies the amendment, so a confirmed reply changes the board and not just the thread',
      },
    ],
  },

  // ── "Failures become evidence-carrying work items." The sentence names three incidents; each is
  //    pinned separately, because "handled once" and "pinned by a mechanism" are the distinction
  //    the whole section is about.
  {
    id: 'noCommitParkEvidence',
    doc: 'method',
    symbol: 'noCommitParkReason()',
    what: 'a fabricated "done" with no commit is detected and parked with an evidence log',
    file: 'dispatch',
    declaration: /^export function noCommitParkReason\(detail: string\): string \{$/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /noCommitParkReason\(`agent produced no commit\$\{denialNote\}\$\{residueNote\} \(log: \$\{logPath\}\)`\)/,
        proves: 'the park reason is produced at the real no-commit site and carries the run log that evidences it',
      },
    ],
  },
  {
    id: 'oversizedEventClipped',
    doc: 'method',
    symbol: 'shrinkEventToFit()',
    what: 'an oversized event is clipped and marked rather than crashing the appender',
    file: 'ledger',
    declaration: /^export function shrinkEventToFit\(event: LedgerEvent, maxBytes: number = MAX_EVENT_BYTES\): LedgerEvent \{$/,
    referencedBy: [
      {
        file: 'ledger',
        pattern: /toWrite = shrinkEventToFit\(event, MAX_EVENT_BYTES\);/,
        proves: 'the append path itself clips — a helper nobody called would leave the crash class open',
      },
    ],
  },
  {
    id: 'orphanLockReclaim',
    doc: 'method',
    symbol: 'beatLockOwnerAlive()',
    what: 'a lock orphaned by a crashed beat is reclaimed instead of wedging the plane',
    file: 'dispatch',
    declaration: /^export function beatLockOwnerAlive\(lockPath: string\): boolean \| null \{$/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /const ownerAlive = beatLockOwnerAlive\(lockPath\);/,
        proves: 'the acquire path consults liveness before it blocks, which is where the reclaim happens',
      },
      {
        file: 'reactor',
        pattern: /const ownerAlive = beatLockOwnerAlive\(lockPath\);/,
        proves: 'the other beat reuses the SAME predicate — one parser, never a second copy that disagrees',
      },
    ],
  },

  // ── "Measure operator felt-reliability." Only the attention half is a projection today, so only
  //    the attention half is pinned — the clean/minor/major/blocker read is stated in the doc as
  //    the operator's own, deliberately unpinned rather than pinned to something adjacent.
  {
    id: 'attentionCostMetric',
    doc: 'method',
    symbol: 'attentionCostShare',
    what: "the attention an item cost is a real projection the operator can read, not a feeling",
    file: 'trajectory',
    declaration: /^ {2}attentionCostShare: number;$/,
    referencedBy: [
      {
        file: 'trajectory',
        pattern: /const attentionCostShare = attentionEligible\.length > 0 \?/,
        proves: 'it is computed from the ledger window rather than declared on an interface and never filled',
      },
      {
        file: 'cli',
        pattern: /agg\.attentionCostShare \* 100/,
        proves: 'the operator surface actually renders it, so the metric reaches the person it is about',
      },
    ],
  },

  // ── The usage claim under the same section: "every provider call lands its usage in the ledger"
  //    is what makes model economics a projection instead of an anecdote.
  {
    id: 'usageInLedger',
    doc: 'method',
    symbol: 'cost.usage',
    what: 'provider usage lands in the ledger as events, so model spend is a projection you can read',
    file: 'schema',
    declaration: /^ {2}'cost\.usage': CostUsageData;$/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /makeEvent\('dispatch', recs\[0\]\.id, 'cost\.usage', \{/,
        proves: 'every terminal build path emits usage attributed to the work item that spent it',
      },
      {
        file: 'fold',
        pattern: /^ +case 'cost\.usage':$/,
        proves: 'the fold reads those events, so spend is derivable rather than write-only',
      },
    ],
  },

  // ── Eval-driven routing. The doc used to say routing "optimizes for trust per token"; the code
  //    ranks on measured first-pass merge rate, so the sentence now names that and pins it.
  {
    id: 'evalDrivenRouting',
    doc: 'method',
    symbol: 'chooseModel()',
    what: 'model routing picks on measured first-pass merge rate rather than speed',
    file: 'routing',
    declaration: /^export function chooseModel\($/,
    referencedBy: [
      {
        file: 'routing',
        pattern: /const rateDiff = b\.firstPassRate - a\.firstPassRate;/,
        proves: 'the ranking really is by first-pass rate — the quantity the sentence names',
      },
      {
        file: 'dispatch',
        pattern: /chooseModel\(routingTable, carrierBucket, carrierIncumbent, routingCfg, routingRand\)/,
        proves: 'the build path calls the policy, so routing is live rather than an unused module',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // operating-model.md (WI-206). That doc is MOSTLY ROADMAP and used to state all of it in the
  // present indicative ("appends `scope.claimed`") while `scope.*`, `plan.*`, `attended start`
  // and `reconcile` appeared nowhere in src. The honesty pass marks every capability ✅ or ⚪ in
  // the rendered text, and the doc states a rule about itself: where a ✅ names a symbol in
  // packages/core/src, that sentence carries an existence marker. The five claims below ARE that
  // set — the shipped subset of a roadmap doc. Their smallness is the finding, not a gap: a ⚪
  // sentence has nothing to bind to, which is exactly what the mark tells the reader.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── What shipped INSTEAD of the doc's file-scope `scope.claimed`: leases on whole work items.
  //    The sentence is about the away beats DEFERRING and an expired lease RETURNING the item, so
  //    the deference read and the reaper are reference sites — a claim event nobody honoured would
  //    leave the paragraph false with `item.claimed` still declared.
  {
    id: 'attendedItemClaimLease',
    doc: 'operating-model',
    symbol: 'item.claimed',
    what: 'an attended session leases whole queued work items and the away beats defer to it while the lease is active',
    file: 'schema',
    declaration: /^ {2}'item\.claimed': ItemClaimedData;$/,
    referencedBy: [
      {
        file: 'session',
        pattern: /makeEvent\('cli', rec\.id, 'item\.claimed', \{ sessionId, ttlMinutes \}\)/,
        proves: 'the operator verb really leases an item, with a ttl, rather than mutating queue state',
      },
      {
        file: 'dispatch',
        pattern: /!isClaimActive\(r, foldResult\.sessions, Date\.now\(\)\)/,
        proves: 'the picker skips claimed items — the deference the section promises',
      },
      {
        file: 'reactor',
        pattern: /reapStaleClaims\(freshResult, freshResult\.sessions, now\)/,
        proves: 'an expired lease is returned to the shared queue instead of blocking it forever',
      },
    ],
  },

  // ── "Race-safe by construction, not a check-then-act" (ADR-007). The decision function alone
  //    proves nothing: the property holds only while the picker CALLS it and claims the survivors
  //    in the same locked append, so both halves of that pass are pinned.
  {
    id: 'claimArbitrationLock',
    doc: 'operating-model',
    symbol: 'decideClaimArbitration()',
    what: 'claim acquisition and dispatch admission are arbitrated in one re-folded pass under the ledger lock',
    file: 'dispatch',
    declaration: /^export function decideClaimArbitration\($/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /const decisions = await claimBeforePick\(/,
        proves: 'the picker actually arbitrates before it spawns, closing the read-to-spawn window',
      },
      {
        file: 'dispatch',
        pattern: /makeEvent\('dispatch', d\.item, 'item\.claimed', \{ sessionId: dispatchSessionId, ttlMinutes: claimTtlMinutes \}\)/,
        proves: 'surviving candidates are claimed in the SAME locked append — the check and the act are one step',
      },
    ],
  },

  // ── Contract 1. The doc previously said "every event carries an optional `target`"; the
  //    envelope has no such field — it is stamped on the CAPTURE and inherited through the fold.
  //    The corrected sentence is pinned on the field where it really lives, with the targeted
  //    lane as proof the folded value is load-bearing rather than decorative.
  {
    id: 'envelopeTargetStamp',
    doc: 'operating-model',
    symbol: 'ItemCapturedData.target',
    what: "a work item's target is stamped once at capture and inherited by downstream events through the fold",
    file: 'schema',
    declaration: /^ {2}target\?: string;$/,
    referencedBy: [
      {
        file: 'dispatch',
        pattern: /targetedQueued = queued\.filter\(r => r\.lane !== 'planning' && r\.target\)/,
        proves: 'the folded target selects the item into its own target lane, so the stamp really routes work',
      },
    ],
  },

  // ── "Any folder is a target" — the half that exists. `target add` REGISTERS an existing git
  //    repo with a manifest; the doc's `--init` (git init a plain folder) does not exist, and the
  //    git check pinned here is what actively rejects it, so this claim also anchors the ⚪ next
  //    to it.
  {
    id: 'targetAddRegistersRepo',
    doc: 'operating-model',
    symbol: 'readTargetManifest()',
    what: 'target registration reads and validates a repo\'s manifest, and rejects a path that is not a git worktree',
    file: 'target',
    declaration: /^export function readTargetManifest\(repoPath: string\): TargetManifest \{$/,
    referencedBy: [
      {
        file: 'cli',
        pattern: /manifest = readTargetManifest\(toplevel\);/,
        proves: 'the operator verb validates the manifest before any event is appended',
      },
      {
        file: 'cli',
        pattern: /spawnSync\('git', \['-C', repoPath, 'rev-parse', '--show-toplevel'\]/,
        proves: 'a non-repo path fails loudly — which is why `--init` is roadmap and not a missing flag',
      },
    ],
  },

  // ── "Boundaries are path-shaped." The doc used to flatten Touches, surfaces AND risk patterns
  //    into "path prefixes"; risk patterns are substring matches. Only the prefix half is pinned,
  //    on the ONE matcher, so a second parser re-appearing is what breaks it.
  {
    id: 'touchesPrefixMatcher',
    doc: 'operating-model',
    symbol: 'matchesAnyTouchPrefix()',
    what: 'Touches and the plane/surface split are matched as segment-boundary path prefixes by one shared matcher',
    file: 'touches',
    declaration: /^export function matchesAnyTouchPrefix\(f: string, prefixes: string\[\]\): boolean \{$/,
    referencedBy: [
      {
        file: 'touches',
        pattern: /return prefixes\.some\(pre => touchesSegmentMatch\(pre\.replace\(/,
        proves: 'the match really is on segment boundaries, not a startsWith that spans path segments',
      },
      {
        file: 'acceptance',
        pattern: /const surfaceHit = files\.find\(f => matchesAnyPrefix\(f, cfg\.surfacePrefixes\)\);/,
        proves: 'acceptance classifies surfaces through the same matcher, so one prefix means one thing',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Marker extraction + checking
// ---------------------------------------------------------------------------

/** `**42**<!--pin:id-->` — the bolded number the reader sees, tagged with its constant. */
const PIN_RE = /\*\*([\d.]+)\*\*<!--pin:([A-Za-z_][A-Za-z0-9_]*)-->/g;
/** Any bolded bare number — used to catch a threshold that arrived WITHOUT a pin. */
const BOLD_NUMBER_RE = /\*\*([\d.]+)\*\*(<!--pin:[A-Za-z_][A-Za-z0-9_]*-->)?/g;
/** `` `path/to/file.ts:123` ``<!--cite:id--> */
const CITE_RE = /`([A-Za-z0-9_\-./]+\.ts):(\d+)`<!--cite:([A-Za-z_][A-Za-z0-9_]*)-->/g;
/** `<the sentence asserting a capability>`<!--exists:id--> — no rendered value, so no value to compare. */
const EXISTS_RE = /<!--exists:([A-Za-z_][A-Za-z0-9_]*)-->/g;

export interface Finding {
  claim: string;
  detail: string;
}

export interface DocClaimReport {
  numeric: Finding[];
  citation: Finding[];
  existence: Finding[];
  bijection: Finding[];
  unpinned: Finding[];
  /** Resolved source values, for reporting/debugging. */
  values: Record<string, number>;
  /** Where each existence claim's symbol was actually found this run. */
  symbols: Record<string, SymbolEvidence>;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Run every claim. Returns findings rather than throwing so one run reports EVERY drift at
 * once — chasing them one failed assertion at a time is how a doc pass gets abandoned halfway.
 * A probe that cannot resolve at all still throws (see probeNumber): that is a broken tripwire,
 * not a drift finding, and must not be reportable-and-ignorable.
 */
export function checkDocClaims(sources: SourceBundle, docs: DocBundle): DocClaimReport {
  const numeric: Finding[] = [];
  const citation: Finding[] = [];
  const existence: Finding[] = [];
  const bijection: Finding[] = [];
  const unpinned: Finding[] = [];
  const values: Record<string, number> = {};
  const symbols: Record<string, SymbolEvidence> = {};

  // ── Numeric claims ──────────────────────────────────────────────────────
  const pinsSeen = new Map<string, { doc: DocKey; value: string; line: number }[]>();
  for (const [docKey, text] of Object.entries(docs) as [DocKey, string][]) {
    PIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PIN_RE.exec(text)) !== null) {
      const list = pinsSeen.get(m[2]!) ?? [];
      list.push({ doc: docKey, value: m[1]!, line: lineOf(text, m.index) });
      pinsSeen.set(m[2]!, list);
    }
  }

  for (const claim of NUMERIC_CLAIMS) {
    const raw = probeNumber(claim.id, claim.sites, sources);
    const expected = claim.transform ? claim.transform(raw) : raw;
    values[claim.id] = expected;
    const occurrences = pinsSeen.get(claim.id) ?? [];
    if (occurrences.length === 0) {
      numeric.push({
        claim: claim.id,
        detail:
          `no \`**<n>**<!--pin:${claim.id}-->\` marker found in ${DOC_PATHS[claim.doc]}. ` +
          `Source says ${expected}${claim.transformNote ? ` (${claim.transformNote})` : ''} — ` +
          `"${claim.what}". Either the doc dropped the claim (restore it, or drop the claim here ` +
          `deliberately) or the marker was mangled.`,
      });
      continue;
    }
    for (const occ of occurrences) {
      if (occ.doc !== claim.doc) {
        numeric.push({
          claim: claim.id,
          detail: `pinned in ${DOC_PATHS[occ.doc]}:${occ.line} but the claim is registered against ${DOC_PATHS[claim.doc]}.`,
        });
      }
      if (Number(occ.value) !== expected) {
        numeric.push({
          claim: claim.id,
          detail:
            `${DOC_PATHS[occ.doc]}:${occ.line} states **${occ.value}**, source says ${expected}` +
            `${claim.transformNote ? ` (${claim.transformNote})` : ''}. "${claim.what}".`,
        });
      }
    }
  }

  for (const [id, occurrences] of pinsSeen) {
    if (!NUMERIC_CLAIMS.some(c => c.id === id)) {
      bijection.push({
        claim: id,
        detail:
          `${DOC_PATHS[occurrences[0]!.doc]}:${occurrences[0]!.line} pins '${id}', which no claim in ` +
          `NUMERIC_CLAIMS resolves — so that number is not actually checked against anything.`,
      });
    }
  }

  // ── Unpinned bolded numbers (see UNPINNED_SWEEP_DOCS) ───────────────────
  // The convention the doc states about itself: bold a threshold, pin it. Without this the
  // easy way to "fix" a drifted number is to stop tagging it.
  for (const docKey of UNPINNED_SWEEP_DOCS) {
    BOLD_NUMBER_RE.lastIndex = 0;
    const text = docs[docKey];
    let m: RegExpExecArray | null;
    while ((m = BOLD_NUMBER_RE.exec(text)) !== null) {
      if (m[2]) continue; // has a pin marker
      unpinned.push({
        claim: `**${m[1]}**`,
        detail:
          `${DOC_PATHS[docKey]}:${lineOf(text, m.index)} bolds the number ${m[1]} with no ` +
          `\`<!--pin:...-->\` marker. Either pin it to a real constant (add a claim in doc-claims.ts) ` +
          `or stop stating it as a number — an unpinned threshold is exactly what drifted last time.`,
      });
    }
  }

  // ── Citation claims ─────────────────────────────────────────────────────
  const citesSeen = new Map<string, { doc: DocKey; path: string; line: number; docLine: number }[]>();
  for (const [docKey, text] of Object.entries(docs) as [DocKey, string][]) {
    CITE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE_RE.exec(text)) !== null) {
      const list = citesSeen.get(m[3]!) ?? [];
      list.push({ doc: docKey, path: m[1]!, line: Number(m[2]!), docLine: lineOf(text, m.index) });
      citesSeen.set(m[3]!, list);
    }
  }

  for (const claim of CITATION_CLAIMS) {
    const occurrences = citesSeen.get(claim.id) ?? [];
    const srcPath = SOURCE_PATHS[claim.file];
    const srcLines = sources[claim.file].split('\n');
    const trueLines = srcLines
      .map((l, i) => (l.includes(claim.mustContain) ? i + 1 : 0))
      .filter(n => n > 0);
    if (trueLines.length === 0) {
      citation.push({
        claim: claim.id,
        detail:
          `the anchor text ${JSON.stringify(claim.mustContain)} no longer appears anywhere in ${srcPath}. ` +
          `The code it named was renamed or removed — re-read the doc's claim about it before ` +
          `re-anchoring, because the doc may now be describing something that does not exist.`,
      });
      continue;
    }
    if (occurrences.length === 0) {
      citation.push({
        claim: claim.id,
        detail:
          `no \`<path>:<line>\`\`<!--cite:${claim.id}-->\` marker found in either doc, but the claim is ` +
          `registered. Restore the citation (${srcPath}:${trueLines.join(' or ')}) or remove the claim here.`,
      });
      continue;
    }
    for (const occ of occurrences) {
      if (occ.path !== srcPath) {
        citation.push({
          claim: claim.id,
          detail: `${DOC_PATHS[occ.doc]}:${occ.docLine} cites ${occ.path}, but this claim is registered against ${srcPath}.`,
        });
        continue;
      }
      const cited = srcLines[occ.line - 1];
      if (cited === undefined || !cited.includes(claim.mustContain)) {
        citation.push({
          claim: claim.id,
          detail:
            `${DOC_PATHS[occ.doc]}:${occ.docLine} cites ${srcPath}:${occ.line}, but that line no longer ` +
            `contains ${JSON.stringify(claim.mustContain)} — it now reads ${JSON.stringify((cited ?? '<past end of file>').trim().slice(0, 90))}. ` +
            `The code moved to ${srcPath}:${trueLines.join(' / ')}; update the citation.`,
        });
      }
    }
  }

  for (const [id, occurrences] of citesSeen) {
    if (!CITATION_CLAIMS.some(c => c.id === id)) {
      bijection.push({
        claim: id,
        detail:
          `${DOC_PATHS[occurrences[0]!.doc]}:${occurrences[0]!.docLine} cites with marker '${id}', which no ` +
          `entry in CITATION_CLAIMS resolves — that citation is unverified.`,
      });
    }
  }

  // ── Existence claims ────────────────────────────────────────────────────
  const existsSeen = new Map<string, { doc: DocKey; docLine: number }[]>();
  for (const [docKey, text] of Object.entries(docs) as [DocKey, string][]) {
    EXISTS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXISTS_RE.exec(text)) !== null) {
      const list = existsSeen.get(m[1]!) ?? [];
      list.push({ doc: docKey, docLine: lineOf(text, m.index) });
      existsSeen.set(m[1]!, list);
    }
  }

  for (const claim of EXISTENCE_CLAIMS) {
    // probeSymbol THROWS when the symbol is gone (see its doc comment). It is caught here — and
    // only `DocClaimProbeError` is caught — so one run reports every drift at once, the same
    // property the numeric/citation halves have. The finding is still a hard failure in the
    // test; catching aggregates it, it does not soften it. A genuine bug in this module throws
    // a plain Error and keeps propagating, so a broken checker can never read as "no findings".
    try {
      symbols[claim.id] = probeSymbol(claim, sources);
    } catch (err) {
      if (!(err instanceof DocClaimProbeError)) throw err;
      existence.push({ claim: claim.id, detail: err.message });
      continue;
    }
    const occurrences = existsSeen.get(claim.id) ?? [];
    const expectedDocs = claimDocs(claim);
    for (const want of expectedDocs) {
      if (!occurrences.some(o => o.doc === want)) {
        existence.push({
          claim: claim.id,
          detail:
            `no \`<!--exists:${claim.id}-->\` marker found in ${DOC_PATHS[want]}, but the claim is ` +
            `registered${expectedDocs.length > 1 ? ` (co-anchored across ${expectedDocs.map(d => DOC_PATHS[d]).join(' + ')})` : ''}. ` +
            `The doc asserts "${claim.what}" nowhere the checker can see it — restore the marker on ` +
            `the sentence, or drop this claim deliberately (both sides, one commit).`,
        });
      }
    }
    for (const occ of occurrences) {
      if (!expectedDocs.includes(occ.doc)) {
        existence.push({
          claim: claim.id,
          detail:
            `marked in ${DOC_PATHS[occ.doc]}:${occ.docLine} but the claim is registered against ` +
            `${expectedDocs.map(d => DOC_PATHS[d]).join(' + ')}.`,
        });
      }
    }
  }

  for (const [id, occurrences] of existsSeen) {
    if (!EXISTENCE_CLAIMS.some(c => c.id === id)) {
      bijection.push({
        claim: id,
        detail:
          `${DOC_PATHS[occurrences[0]!.doc]}:${occurrences[0]!.docLine} marks '${id}' as an existence claim, ` +
          `which no entry in EXISTENCE_CLAIMS resolves — that sentence asserts a capability nothing checks.`,
      });
    }
  }

  return { numeric, citation, existence, bijection, unpinned, values, symbols };
}

/** Convenience: run against the real tree. */
export function checkDocClaimsOnDisk(root: string = REPO_ROOT): DocClaimReport {
  return checkDocClaims(readSources(root), readDocs(root));
}
