/**
 * provenance.ts — verify a commit range against the operator's real ledger.
 *
 * WHY THIS EXISTS: 53 commits once landed on `main` over six days with no work item, no gate
 * record, no acceptance event — a silent bypass of the plane's own selling point (agent work is
 * PROVEN before it merges). An earlier design tried to close this with a commit-message trailer
 * (`Work-Item: WI-123`). That was rejected as theater: an agent that bypasses the plane can
 * equally type a fake id, which just relocates a silent failure into an unverified assertion.
 *
 * The correct design verifies commits against the plane's real `.ai/ledger` — where
 * `item.merged` receipts and gate evidence actually live, and which an agent cannot forge by
 * typing text into a commit message. This module is PURE: all fs/git/ledger I/O happens in
 * {@link gatherProvenanceInput} (the impure probe), and {@link verifyProvenance} only classifies
 * the resulting snapshot — same split as `audit/index.ts` (probe once, classify with pure
 * functions; see that module's header comment).
 *
 * THE MOST IMPORTANT PROPERTY: no vacuous pass. The original incident was a SILENT failure — a
 * verifier that passes because it checked nothing would be the identical bug with extra
 * ceremony. Every ambiguity here FAILS CLOSED as `indeterminate`, each with its own named cause
 * (see {@link IndeterminateCause}) so a test can pin every single one individually.
 */

import type { LedgerEvent } from './schema.js';
import type { ProvenanceBaseline } from './target.js';

// ---------------------------------------------------------------------------
// SHA matching — the ONE comparison function (no second copy anywhere else)
// ---------------------------------------------------------------------------

/**
 * Minimum SHA prefix length treated as a real match. Measured over 185 real `item.merged`
 * events in the operator's own ledger: 73 receipts carry a 7-char sha, 3 carry 8 chars, 80
 * carry the full 40 chars, and 29 carry no commit at all (no-code merges, e.g. planning-lane
 * items). A verifier that required full-length shas would fail closed on the operator's own
 * normal working mode — that is not stricter, it is broken. 7 is git's own historical default
 * short-sha length and is what actually appears in the data.
 */
export const MIN_SHA_MATCH = 7;

/**
 * THE ONE sha-comparison predicate (mirrors the one-parser/one-predicate rule — see AGENTS.md).
 * Case-insensitive prefix match, either direction may be the shorter string, floored at
 * MIN_SHA_MATCH so a receipt with no commit (`undefined`) — or a pathologically short one —
 * matches nothing. A receipt sha longer than the commit sha (should not happen with real git
 * shas, but the comparison is symmetric) is handled the same way.
 */
export function shaMatches(receiptSha: string | undefined, commitSha: string): boolean {
  if (!receiptSha) return false;
  const a = receiptSha.trim().toLowerCase();
  const b = commitSha.trim().toLowerCase();
  if (a.length < MIN_SHA_MATCH || b.length < MIN_SHA_MATCH) return false;
  const len = Math.min(a.length, b.length);
  return a.slice(0, len) === b.slice(0, len);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-commit classification. */
export type CommitProvenanceStatus =
  | 'verified'             // receipt whose commit matches AND gate evidence present
  | 'receipt-without-gate' // receipt matched but no gate evidence of any shape — NOT a pass
  | 'break-glass'          // covered by an open, unexpired grant
  | 'uncovered';            // no receipt at all

/** Range-level roll-up. */
export type RangeProvenanceStatus = 'verified' | 'break-glass-open' | 'uncovered' | 'indeterminate';

/** Every fail-closed refusal, each named so a test can pin it. */
export type IndeterminateCause =
  | 'no-baseline' | 'baseline-unresolvable' | 'baseline-not-ancestor'
  | 'range-unresolvable' | 'empty-range' | 'ledger-unreadable'
  | 'target-not-registered' | 'non-linear-ancestry' | 'break-glass-multiple';

/**
 * A `item.merged` receipt extracted from the ledger. `commit` is absent for no-code merges
 * (e.g. planning-lane items) — such a receipt matches no commit (shaMatches fails closed on
 * `undefined`), which is correct: a receipt for nothing landed cannot vouch for something that
 * did. `hasGate` is true when ANY of the three legitimate gate-evidence shapes was present on
 * the merge (see {@link extractMergeReceipts}) — a `gate.passed` event on the same item, a
 * `gateCommand` string, or free-text `gate`/`gateResult` (attended-coordinator merges).
 */
export interface MergeReceipt { item: string; ts: string; commit?: string; hasGate: boolean; gateDetail?: string }

/**
 * An open break-glass grant (see the `provenance.break-glass` ledger event in schema.ts).
 * Coverage is a TIME WINDOW, not a commit range: see {@link grantCoversCommit}.
 */
export interface BreakGlassGrant { item: string; targetId: string; fromSha: string; reason: string; grantedAt: string; expiresAt: string; retroItem?: string }

/** One commit in the verified range (first-parent walk — see verifyProvenance's header note). */
export interface RangeCommit { sha: string; subject: string; committedAt: string }

/** Per-commit verdict in the report. */
export interface CommitVerdict { sha: string; subject: string; status: CommitProvenanceStatus; detail: string }

/**
 * Everything {@link verifyProvenance} needs, gathered once by the impure probe
 * ({@link gatherProvenanceInput}) or fabricated directly by a test. No fs/git/ledger access
 * happens past this boundary.
 */
export interface ProvenanceInput {
  targetName: string;
  targetId: string | null;        // null = not registered → indeterminate
  ledgerReadable: boolean;
  baseline: ProvenanceBaseline | null;   // from the target manifest
  baselineResolved: string | null;       // full sha in this repo, null = unresolvable
  baselineIsAncestor: boolean;           // baseline is an ancestor of `to`
  rangeResolved: boolean;                // git could resolve from..to
  ancestryLinear: boolean;               // `from` is an ancestor of `to` (force-push detector)
  commits: RangeCommit[];                // FIRST-PARENT, oldest first, exclusive of `from`
  receipts: MergeReceipt[];
  grants: BreakGlassGrant[];
  now: string;                           // ISO
}

export interface ProvenanceReport {
  status: RangeProvenanceStatus;
  cause?: IndeterminateCause;
  commits: CommitVerdict[];
  counts: Record<CommitProvenanceStatus, number>;
  lines: string[];      // human report
  exitCode: number;     // 0 verified | 1 uncovered | 2 indeterminate | 3 break-glass-open
}

// ---------------------------------------------------------------------------
// Break-glass coverage
// ---------------------------------------------------------------------------

/** Slack at the grant START edge, in ms — see grantCoversCommit. */
export const GRANT_START_SLACK_MS = 1000;

/**
 * Does `grant` cover `commit`? Coverage is a TIME WINDOW: the commit's `committedAt` falls in
 * [grantedAt, expiresAt] AND `now` <= expiresAt — an expired grant covers NOTHING (there is no
 * separate 'expired' cause; expiry simply makes the commit fall through to 'uncovered', which is
 * the correct louder outcome — an operator re-checking an old range should not see a silently
 * still-passing grant).
 *
 * `fromSha` is recorded on the grant for the audit trail and printed in the report, but is NOT
 * part of the coverage test — coverage is the time window alone. Stated honestly: commit dates
 * are author-controlled (`git commit --date` or a replayed/rebased commit), so this is
 * accident-prevention (did an operator actually open a grant around when this landed?), not an
 * adversarial control. A grant is an operator act recorded in the ledger; it is not meant to
 * resist a determined bad actor rewriting timestamps, only to keep an honest break-glass merge
 * from silently reading as fully verified.
 */
export function grantCoversCommit(grant: BreakGlassGrant, commit: RangeCommit, now: string): boolean {
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(grant.expiresAt);
  const grantedMs = Date.parse(grant.grantedAt);
  const commitMs = Date.parse(commit.committedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || !Number.isFinite(grantedMs) || !Number.isFinite(commitMs)) {
    return false;
  }
  if (nowMs > expiresMs) return false; // expired — covers nothing
  // GRANT_START_SLACK_MS: git commit timestamps are SECOND-precision while ledger event
  // timestamps are millisecond-precision. Without slack, a commit made in the same wall-clock
  // second as (but chronologically after) the grant truncates to a committedAt strictly BELOW
  // grantedAt and falls outside its own grant — so the very first commit an operator makes
  // after breaking glass reads 'uncovered' and blocks the push the grant was opened to allow.
  // One second of slack at the START edge only; the expiry edge is left exact, because
  // widening THAT one would extend the exception past the window the operator declared.
  return commitMs >= grantedMs - GRANT_START_SLACK_MS && commitMs <= expiresMs;
}

/** Grants for `targetId` that have not yet expired as of `now` (ignores commit-window coverage). */
export function openGrants(grants: BreakGlassGrant[], targetId: string, now: string): BreakGlassGrant[] {
  const nowMs = Date.parse(now);
  return grants.filter(g => g.targetId === targetId && Number.isFinite(Date.parse(g.expiresAt)) && Date.parse(g.expiresAt) >= nowMs);
}

// ---------------------------------------------------------------------------
// Ledger extraction
// ---------------------------------------------------------------------------

/**
 * Extract `item.merged` receipts from raw ledger events.
 *
 * Gate evidence has THREE legitimate shapes in real data (requiring only `gate.passed` would
 * flag every attended-coordinator merge as unverified):
 *   1. a `gate.passed` event on the SAME item (beat-built merges), OR
 *   2. `item.merged.data.gateCommand` (a non-empty string), OR
 *   3. `item.merged.data.gate` or `.gateResult` (free-text, attended-coordinator merges — not
 *      part of the typed `ItemMergedData` shape, so read defensively off `data` as unknown).
 * This is the ONE place the gate-evidence rule is evaluated — nowhere else re-derives it.
 */
export function extractMergeReceipts(events: LedgerEvent[]): MergeReceipt[] {
  const gatePassedItems = new Set(events.filter(ev => ev.type === 'gate.passed').map(ev => ev.item));
  const out: MergeReceipt[] = [];
  for (const ev of events) {
    if (ev.type !== 'item.merged') continue;
    const data = ev.data as Record<string, unknown>;
    const commit = typeof data['commit'] === 'string' && data['commit'].trim() ? (data['commit'] as string) : undefined;
    const gateCommand = typeof data['gateCommand'] === 'string' && data['gateCommand'].trim() ? (data['gateCommand'] as string) : undefined;
    const gateFreeText = [data['gate'], data['gateResult']]
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const hasGate = gatePassedItems.has(ev.item) || !!gateCommand || !!gateFreeText;
    const gateDetail = gatePassedItems.has(ev.item)
      ? 'gate.passed event'
      : gateCommand
        ? `gateCommand: ${gateCommand}`
        : gateFreeText
          ? `gate: ${gateFreeText}`
          : undefined;
    out.push({
      item: ev.item,
      ts: ev.ts,
      commit,
      hasGate,
      ...(gateDetail !== undefined ? { gateDetail } : {}),
    });
  }
  return out;
}

/** Extract `provenance.break-glass` grants from raw ledger events. */
export function extractBreakGlassGrants(events: LedgerEvent[]): BreakGlassGrant[] {
  const out: BreakGlassGrant[] = [];
  for (const ev of events) {
    if (ev.type !== 'provenance.break-glass') continue;
    const data = ev.data as Record<string, unknown>;
    const targetId = typeof data['targetId'] === 'string' ? data['targetId'] : undefined;
    const fromSha = typeof data['fromSha'] === 'string' ? data['fromSha'] : undefined;
    const reason = typeof data['reason'] === 'string' ? data['reason'] : undefined;
    const expiresAt = typeof data['expiresAt'] === 'string' ? data['expiresAt'] : undefined;
    if (!targetId || !fromSha || !reason || !expiresAt) continue; // malformed event — skip, never throw
    const retroItem = typeof data['retroItem'] === 'string' ? data['retroItem'] : undefined;
    out.push({
      item: ev.item,
      targetId,
      fromSha,
      reason,
      grantedAt: ev.ts,
      expiresAt,
      ...(retroItem !== undefined ? { retroItem } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// verifyProvenance — the ONE pure decision function
// ---------------------------------------------------------------------------

const EMPTY_COUNTS: Record<CommitProvenanceStatus, number> = {
  verified: 0,
  'receipt-without-gate': 0,
  'break-glass': 0,
  uncovered: 0,
};

/**
 * Classify a commit against every receipt. Receipts are matched by SHA ALONE, never filtered by
 * target: `item.merged.data.target`, when present, is a mutable display-NAME string, and some
 * merges carry no target at all. A SHA is globally unique across the target repo's history, so a
 * receipt from another target's item can never accidentally match a commit here — filtering by
 * target would only add a chance to wrongly EXCLUDE a legitimate receipt (e.g. one recorded
 * before `target` was stamped, or under a since-renamed target name) without closing any real
 * gap. Priority when multiple receipts match (rare, but a rebase/cherry-pick replay could
 * duplicate a sha): a matching receipt WITH gate evidence wins over one without.
 */
function classifyCommit(commit: RangeCommit, receipts: MergeReceipt[], grants: BreakGlassGrant[], targetId: string, now: string): CommitVerdict {
  const matches = receipts.filter(r => shaMatches(r.commit, commit.sha));
  const withGate = matches.find(r => r.hasGate);
  if (withGate) {
    return { sha: commit.sha, subject: commit.subject, status: 'verified', detail: `receipt on ${withGate.item} (${withGate.gateDetail ?? 'gate evidence present'})` };
  }
  if (matches.length > 0) {
    return { sha: commit.sha, subject: commit.subject, status: 'receipt-without-gate', detail: `receipt on ${matches[0]!.item} but no gate evidence of any shape` };
  }
  const covering = grants.find(g => g.targetId === targetId && grantCoversCommit(g, commit, now));
  if (covering) {
    return { sha: commit.sha, subject: commit.subject, status: 'break-glass', detail: `covered by break-glass grant on ${covering.item} (${covering.reason})` };
  }
  return { sha: commit.sha, subject: commit.subject, status: 'uncovered', detail: 'no matching item.merged receipt' };
}

/**
 * Verify a commit range against the operator's real ledger. PURE — no fs, no git, no ledger I/O;
 * everything needed is already in `input` (see {@link gatherProvenanceInput} for how it is
 * gathered).
 *
 * Fail-closed preconditions are checked IN ORDER; the first that fails returns
 * status:'indeterminate' with the named cause and exitCode 2. See {@link IndeterminateCause} for
 * what each one means. Precondition 8 (break-glass-multiple) is checked before commits are
 * classified because more than one simultaneously open grant on a target is an INVARIANT
 * VIOLATION (at most one grant may be outstanding per target — see schema.ts's
 * `provenance.break-glass` doc comment) rather than an ordinary per-commit ambiguity; refusing
 * the whole range is the correct response to a state the plane itself never intended to reach.
 */
export function verifyProvenance(input: ProvenanceInput): ProvenanceReport {
  const indeterminate = (cause: IndeterminateCause, extra: string[] = []): ProvenanceReport => ({
    status: 'indeterminate',
    cause,
    commits: [],
    counts: { ...EMPTY_COUNTS },
    exitCode: 2,
    lines: [`provenance: INDETERMINATE (${cause})`, ...extra],
  });

  if (!input.ledgerReadable) {
    return indeterminate('ledger-unreadable', ['the plane ledger could not be read — verification refuses to run over unknown history']);
  }
  if (input.targetId === null) {
    return indeterminate('target-not-registered', [`'${input.targetName}' is not a registered target of any plane this verifier can see`]);
  }
  if (input.baseline === null) {
    return indeterminate('no-baseline', ['no provenanceBaseline declared in loopkit.target.json — the manifest must state where verification starts']);
  }
  if (input.baselineResolved === null) {
    return indeterminate('baseline-unresolvable', [`declared baseline commit '${input.baseline.commit}' does not resolve in this repo`]);
  }
  if (!input.baselineIsAncestor) {
    return indeterminate('baseline-not-ancestor', ['the declared baseline is not an ancestor of the range end — history below the declared line may have been rewritten']);
  }
  if (!input.rangeResolved) {
    return indeterminate('range-unresolvable', ['git could not resolve the requested commit range']);
  }
  if (!input.ancestryLinear) {
    return indeterminate('non-linear-ancestry', ['the range start is not an ancestor of the range end — force-push or divergent history; a linear first-parent walk is not meaningful here']);
  }

  const openForTarget = openGrants(input.grants, input.targetId, input.now);
  if (openForTarget.length > 1) {
    return indeterminate('break-glass-multiple', [`${openForTarget.length} simultaneously open break-glass grants on this target (invariant: at most one) — items: ${openForTarget.map(g => g.item).join(', ')}`]);
  }

  if (input.commits.length === 0) {
    // THE headline vacuous-pass case. "0 commits checked" is NEVER a pass — deliberately
    // stricter than scripts/leak-scan.sh's --range mode, which merely ANNOUNCES an empty range
    // (exit 3, "green can't mean empty") because leak-scan's job is to find a pattern that
    // may legitimately be absent from a real range. Provenance's job is the opposite: an empty
    // range here almost always means the caller passed the WRONG range (a typo'd ref, an
    // already-merged range, comparing a branch to itself) — the exact shape of mistake that
    // would make a bypassed 53-commit incident read as "verified" if this returned 'verified'
    // on zero commits. Silence about the mistake is worse than refusing to answer.
    return indeterminate('empty-range', ['the resolved range contains zero commits — this is refused, never reported as verified']);
  }

  const commits = input.commits.map(c => classifyCommit(c, input.receipts, input.grants, input.targetId!, input.now));
  const counts = { ...EMPTY_COUNTS };
  for (const c of commits) counts[c.status]++;

  let status: RangeProvenanceStatus;
  let exitCode: number;
  if (counts.uncovered > 0 || counts['receipt-without-gate'] > 0) {
    status = 'uncovered';
    exitCode = 1;
  } else if (counts['break-glass'] > 0) {
    status = 'break-glass-open';
    exitCode = 3;
  } else {
    status = 'verified';
    exitCode = 0;
  }

  const lines = [
    `provenance: ${status.toUpperCase()} — ${commits.length} commit(s) checked`,
    `  verified: ${counts.verified}  break-glass: ${counts['break-glass']}  receipt-without-gate: ${counts['receipt-without-gate']}  uncovered: ${counts.uncovered}`,
    ...commits
      .filter(c => c.status !== 'verified')
      .map(c => `  ${c.status}: ${c.sha.slice(0, MIN_SHA_MATCH)} ${c.subject} — ${c.detail}`),
  ];

  return { status, commits, counts, exitCode, lines };
}

// ---------------------------------------------------------------------------
// gatherProvenanceInput — the impure probe (all git/fs/ledger I/O lives here)
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { loadAllEventsWithQuarantine } from './ledger.js';
import { readTargetManifest } from './target.js';

export interface ProvenanceProbeOptions {
  repoPath: string;
  ledgerDir: string;
  from?: string;
  to?: string;
  now?: string;
  /**
   * Structural target lookup (mirrors target.ts's TargetLookup) — how the caller resolves
   * `repoPath` to a registered `targetId`. Optional: a caller that already knows the id (e.g.
   * the CLI, which reads the fold) may pass it directly via `targetId` instead of a lookup.
   */
  targetId?: string | null;
  /**
   * Display name for the report (e.g. the registered target's name). Falls back to `repoPath`
   * when omitted, which is the previous behavior.
   */
  targetName?: string;
}

/**
 * Does `dir` look like a real, readable ledger? `loadAllEventsWithQuarantine` deliberately fails
 * SOFT on bad input (a missing dir, an unreadable segment, a torn line all just yield fewer
 * events rather than a thrown error) — that is the right behavior for the loader, whose job is
 * to keep the fold alive across partial corruption. It is the WRONG behavior for a verifier: a
 * missing or empty ledger directory reads through the loader as "zero events", which is
 * indistinguishable from "a real, intact ledger that happens to hold no receipts yet" — and
 * every commit in the range then falsely classifies as `uncovered` instead of the true
 * `ledger-unreadable`. A verifier that cannot see the evidence must refuse to render a verdict,
 * not silently render one from an empty set. So this checks existence/readability/non-emptiness
 * explicitly, ahead of (and independent from) the loader call.
 */
function probeLedgerReadable(dir: string): boolean {
  let entries: string[];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return false;
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(f => f.endsWith('.jsonl'));
}

function git(args: string[], cwd: string): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { cwd, stdio: 'pipe', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status, stdout: (r.stdout ?? '').toString() };
}

/**
 * Gather every fact {@link verifyProvenance} needs, from real git/fs/ledger I/O. IMPURE — mirrors
 * the split in `audit/index.ts` (probe once, classify with pure functions). Never throws on a
 * probe failure; instead it produces an `input` that `verifyProvenance` will correctly refuse
 * (e.g. `rangeResolved: false`) — the caller never has to special-case a probe exception versus
 * a legitimate indeterminate verdict.
 */
export async function gatherProvenanceInput(opts: ProvenanceProbeOptions): Promise<ProvenanceInput> {
  const now = opts.now ?? new Date().toISOString();
  const targetName = opts.targetName ?? opts.repoPath;
  const to = opts.to ?? 'HEAD';

  // See probeLedgerReadable's doc comment: the loader fails soft (missing/empty dir -> []
  // rather than a throw), so existence/non-emptiness must be checked explicitly — a throw alone
  // cannot distinguish "no ledger here" from "a real, receipt-free ledger".
  let ledgerReadable = probeLedgerReadable(opts.ledgerDir);
  let events: LedgerEvent[] = [];
  if (ledgerReadable) {
    try {
      events = await loadAllEventsWithQuarantine(opts.ledgerDir);
    } catch {
      ledgerReadable = false;
    }
  }

  const targetId = opts.targetId ?? null;

  let baseline: ProvenanceBaseline | null = null;
  try {
    const manifest = readTargetManifest(opts.repoPath);
    baseline = manifest.provenanceBaseline ?? null;
  } catch {
    baseline = null;
  }

  const from = opts.from ?? baseline?.commit;

  let baselineResolved: string | null = null;
  let baselineIsAncestor = false;
  if (baseline) {
    const resolved = git(['rev-parse', '--verify', `${baseline.commit}^{commit}`], opts.repoPath);
    if (resolved.status === 0 && resolved.stdout.trim()) {
      baselineResolved = resolved.stdout.trim();
      const anc = git(['merge-base', '--is-ancestor', baselineResolved, to], opts.repoPath);
      baselineIsAncestor = anc.status === 0;
    }
  }

  let rangeResolved = false;
  let ancestryLinear = false;
  const commits: RangeCommit[] = [];
  if (from) {
    const rangeCheck = git(['rev-parse', '--verify', `${from}^{commit}`], opts.repoPath);
    const toCheck = git(['rev-parse', '--verify', `${to}^{commit}`], opts.repoPath);
    rangeResolved = rangeCheck.status === 0 && toCheck.status === 0;
    if (rangeResolved) {
      const anc = git(['merge-base', '--is-ancestor', from, to], opts.repoPath);
      ancestryLinear = anc.status === 0;
      if (ancestryLinear) {
        // FIRST-PARENT only: the plane merges with --no-ff, so a receipt's `commit` is the
        // MERGE commit on the default branch. Walking first-parent is what makes "no
        // exemptions to write" true — a revert, a version bump, or any hand-made commit
        // landing directly on the default branch IS a first-parent commit with no receipt,
        // and is correctly reported uncovered rather than silently skipped as a side commit.
        const log = git(['log', '--first-parent', '--reverse', '--format=%H%x1f%s%x1f%cI', `${from}..${to}`], opts.repoPath);
        if (log.status === 0) {
          for (const line of log.stdout.split('\n')) {
            if (!line) continue;
            const [sha, subject, committedAt] = line.split('\x1f');
            if (sha && committedAt) commits.push({ sha, subject: subject ?? '', committedAt });
          }
        }
      }
    }
  }

  const receipts = extractMergeReceipts(events);
  const grants = extractBreakGlassGrants(events);

  return {
    targetName,
    targetId,
    ledgerReadable,
    baseline,
    baselineResolved,
    baselineIsAncestor,
    rangeResolved,
    ancestryLinear,
    commits,
    receipts,
    grants,
    now,
  };
}
