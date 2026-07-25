/**
 * doc-claims.ts — pins the NUMBERS and the `file:line` CITATIONS in `docs/plane-flows.md`
 * and `docs/limitations.md` to the source they describe.
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
} as const;
export type SourceKey = keyof typeof SOURCE_PATHS;

export const DOC_PATHS = {
  'plane-flows': 'docs/plane-flows.md',
  'limitations': 'docs/limitations.md',
} as const;
export type DocKey = keyof typeof DOC_PATHS;

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
    id: 'lockTimeoutSeconds',
    doc: 'limitations',
    what: 'the ledger lock staleness window, after which another beat may reap it',
    sites: [{ file: 'ledger', pattern: /^const LOCK_TIMEOUT_MS = ([\d_]+);/m }],
    transform: n => n / 1000,
    transformNote: 'LOCK_TIMEOUT_MS is in ms; the doc states seconds',
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
  { id: 'ledgerAppendWrite', file: 'ledger', mustContain: 'await fh.write(line);' },
  { id: 'ledgerCorruptSkip', file: 'ledger', mustContain: 'Corrupt line — skip with a warning' },
  { id: 'ledgerLockAcquire', file: 'ledger', mustContain: 'async function acquireLock(' },
  { id: 'makeEventStampsVersion', file: 'schema', mustContain: 'v: LEDGER_SCHEMA_VERSION,' },
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

export interface Finding {
  claim: string;
  detail: string;
}

export interface DocClaimReport {
  numeric: Finding[];
  citation: Finding[];
  bijection: Finding[];
  unpinned: Finding[];
  /** Resolved source values, for reporting/debugging. */
  values: Record<string, number>;
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
  const bijection: Finding[] = [];
  const unpinned: Finding[] = [];
  const values: Record<string, number> = {};

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

  // ── Unpinned bolded numbers in plane-flows.md ───────────────────────────
  // The convention the doc states about itself: bold a threshold, pin it. Without this the
  // easy way to "fix" a drifted number is to stop tagging it.
  BOLD_NUMBER_RE.lastIndex = 0;
  {
    const text = docs['plane-flows'];
    let m: RegExpExecArray | null;
    while ((m = BOLD_NUMBER_RE.exec(text)) !== null) {
      if (m[2]) continue; // has a pin marker
      unpinned.push({
        claim: `**${m[1]}**`,
        detail:
          `${DOC_PATHS['plane-flows']}:${lineOf(text, m.index)} bolds the number ${m[1]} with no ` +
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

  return { numeric, citation, bijection, unpinned, values };
}

/** Convenience: run against the real tree. */
export function checkDocClaimsOnDisk(root: string = REPO_ROOT): DocClaimReport {
  return checkDocClaims(readSources(root), readDocs(root));
}
