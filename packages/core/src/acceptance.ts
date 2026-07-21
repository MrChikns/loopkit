/**
 * acceptance.ts — acceptance-tiering classifier.
 *
 * Generalizes plane-only provisional acceptance: instead of a single plane-only
 * boolean gate, every merged item is classified into one of four attention tiers.
 * The reactor (beats/reactor.ts, stepProvisionalAccept) drives its auto-accept loop
 * from this classification; this module is pure and deterministic — no LLM, no I/O.
 *
 * Tiers (highest attention wins — checked in order):
 *   'must'     — never auto-accept (judge failed, or a risk-flagged path was touched).
 *   'review'   — user-facing product surface; auto-accepts only after a longer window.
 *   'optional' — non-surface, non-plane product code; auto-accepts after a short window.
 *   'auto'     — no code changed (question/feedback) or ops-plane internals only;
 *                auto-accepts almost immediately (or silently, per the reactor's window
 *                config — this module only classifies, it does not decide timing).
 *
 * Operator-calibrated rules:
 *   ops-plane internals            → silent auto-accept
 *   no-code (question/feedback)    → drop (auto-accept)
 *   user-facing product changes    → auto-accept after 7 days
 *   risk/judge-fail                → never auto-accept
 */

export type AcceptanceTier = 'auto' | 'optional' | 'review' | 'must';

export interface TierResult {
  tier: AcceptanceTier;
  reason: string;
}

/** Attention ordering — higher rank = more operator attention. Used to take the max (upgrade-only). */
const TIER_RANK: Record<AcceptanceTier, number> = { auto: 0, optional: 1, review: 2, must: 3 };

/** Default judge-confidence floor for the overseer gate. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.7;

/**
 * The judge verdict the overseer gate reads — a superset of the old fail-only check.
 * Fields mirror the folded judgeVerdict (fold.ts) / ReviewVerdictData (schema.ts).
 */
export interface OverseerVerdict {
  verdict: string;
  confidence?: number;
  specSatisfied?: 'yes' | 'partial' | 'no' | 'unknown';
  scopeCreep?: 'none' | 'minor' | 'major' | 'unknown';
  testTheatre?: 'none' | 'suspected' | 'unknown';
}

/**
 * The subset of plane/surface/risk config the classifier needs (decoupled from LoopkitConfig).
 *
 * `planePrefixes` and `surfacePrefixes` are ORTHOGONAL axes, not mutually exclusive:
 *   - planePrefixes   = merge-trust: auto-merge without operator approval (framework-owned code).
 *   - surfacePrefixes = test-visibility: surface on the operator's acceptance desk for a human test.
 * A path listed in BOTH means "trust it to merge, but I still want eyes on it" — e.g. framework
 * code (an internal console) that a fork is actively developing and wants to test. Surface wins
 * over plane for tiering (see baseTier rule 4).
 */
export interface AcceptanceTierClassifyConfig {
  /** User-facing product surface path prefixes (e.g. services/app/src/public/, services/app/src/slices/). */
  surfacePrefixes: string[];
  /** Ops-plane internal path prefixes — reused from autoApprove.planePrefixes (merge-trust axis). */
  planePrefixes: string[];
  /** Hard risk/escalation patterns (substring match) — reused from autoApprove.escalationPatterns. */
  riskPatterns: string[];
  /**
   * Overseer gate: judge-confidence floor. A gate-green merge whose judge confidence
   * is below this (or which the judge flags for test-theatre / scope-creep / partial-spec)
   * is ratcheted up to at least 'review' so it never auto-accepts. Default: 0.7.
   */
  confidenceFloor?: number;
}

/**
 * Overseer gate. From the judge's quality signals, compute the MINIMUM acceptance
 * tier this merge is allowed to occupy. Upgrade-only by construction (the caller takes the
 * max against the deterministic base tier), so a low LLM confidence can only ever *lower*
 * autonomy — it can never wave a risk-flagged path through. Fires only when the judge
 * actually assessed code (a verdict exists AND files changed); returns null otherwise so
 * no-code items and un-judged merges are untouched.
 *
 * This is the core trust-hardening principle: confidence is bounded by the deterministic
 * risk class (base tier), not trusted as a raw self-report that can auto-approve.
 */
export function overseerFloor(
  files: string[],
  v: OverseerVerdict | undefined,
  confidenceFloor: number,
): TierResult | null {
  if (files.length === 0 || !v) return null;

  // TRUST-HARDENING: a judge attempt that produced NO usable verdict
  // (verdict:'unavailable' — provider error/timeout) is an evidence gap, not a pass. Floor the
  // item at 'review' so it can never auto/optional-accept silently. This fires only when a judge
  // attempt actually happened (the event exists AND files changed); an item where no judge was
  // ever attempted carries no judgeVerdict at all and reaches neither this branch nor overseerFloor.
  if (v.verdict === 'unavailable') {
    return { tier: 'review', reason: 'judge unavailable (provider error/timeout) — evidence gap, needs your eyes' };
  }

  // Spec not satisfied is as serious as an outright fail — the operator must look.
  if (v.specSatisfied === 'no') {
    return { tier: 'must', reason: 'judge: spec not satisfied' };
  }

  const flags: string[] = [];
  if (typeof v.confidence === 'number' && v.confidence < confidenceFloor) {
    flags.push(`judge confidence ${v.confidence.toFixed(2)} < floor ${confidenceFloor}`);
  }
  if (v.testTheatre === 'suspected') flags.push('judge: test-theatre suspected');
  if (v.scopeCreep === 'major') flags.push('judge: major scope creep');
  if (v.specSatisfied === 'partial') flags.push('judge: spec only partially satisfied');

  if (flags.length > 0) {
    return { tier: 'review', reason: flags.join('; ') };
  }
  return null;
}

/** Gate result shape shared with the shell gate (beats/dispatch.ts runGate) — the fold doesn't care which gate ran. */
export interface GateOutcome {
  passed: boolean;
  reason: string;
  output: string;
}

/**
 * Claim-audit gate: the definition-of-done for non-code delivery lanes
 * (dispatch.ts selects this instead of `npm test` when the item's lane isn't
 * 'engineering'). Wraps the deterministic base-tier guards — risk paths, plane vs.
 * surface split — as a pass/fail gate: 'must'-tier findings fail the gate, everything
 * else passes. A fuller claim-verification rubric can layer a real judgeVerdict-shaped
 * claim map through this same function later; this wires the mechanism with the guards
 * that already exist.
 */
export function runClaimAuditGate(
  files: string[],
  cfg: AcceptanceTierClassifyConfig,
): GateOutcome {
  const { tier, reason } = classifyAcceptanceTier(files, undefined, cfg);
  const passed = tier !== 'must';
  return {
    passed,
    reason: passed ? `claim-audit passed: ${reason}` : `claim-audit failed: ${reason}`,
    output: '',
  };
}

// Touches parsing/matching comes from the ONE shared module. A previous local
// matchesAnyPrefix used a substring-contains idiom (`f.includes('/' + pre)`) — a
// bug class dispatch already had to fix (`packages/foo` matched `packages/foo-bar`),
// which could mis-bucket an item's acceptance tier. splitTouches is re-exported for
// existing importers (reactor, cli).
import { splitTouches, matchesAnyTouchPrefix as matchesAnyPrefix } from './touches.js';
export { splitTouches };

/**
 * TRUST-HARDENING: pick the file list the acceptance tier classifies from.
 *
 * Prefer the ACTUAL merge evidence (`git diff --name-only base..head` captured at merge time)
 * over the item's DECLARED `touches` metadata. The old classifier fed only declared touches, so
 * an item merged with real code changes but missing/empty touches folded as "no code changed →
 * auto" — a trust hole (a change ships silently that actually touched code). When merge evidence
 * exists we classify from it: a merge with real changed files can never take the empty-files
 * "auto" branch.
 *
 * When BOTH evidence and touches are absent, this alone can no longer tell a genuine no-code
 * item apart from a merge whose evidence just wasn't captured (an attended/fast-drain
 * `item.merged` append that carries a commit but no `touches`) — see {@link hasEvidenceGap},
 * which the caller must consult alongside this to avoid silently auto-accepting the latter.
 *
 * @param evidenceFiles the folded item.merged changedFiles (undefined on legacy/no-code merges)
 * @param declaredTouches the comma-joined declared touches string (rec.touches)
 */
export function acceptanceClassifyFiles(
  evidenceFiles: string[] | undefined,
  declaredTouches: string | undefined,
): string[] {
  if (evidenceFiles !== undefined) return evidenceFiles;
  return splitTouches(declaredTouches);
}

/**
 * The subset of an item.merged event's evidence fields (schema.ts ItemMergedData) that prove a
 * real build/gate ran — as opposed to a bare no-code stub merge (`{ commit, deployed }` only,
 * e.g. a question/feedback item that never built). Mirrors the fold's `mergeGateCommand` /
 * `mergeBaseSha` / `mergeHeadSha` fields.
 */
export interface MergeProofFields {
  gateCommand?: string;
  baseSha?: string;
  headSha?: string;
}

/**
 * TRUST-HARDENING: true when a merged item PROVES a real build/gate ran (carries a gate command
 * and/or a base/head sha — the "branch/sha/gate" evidence a dispatched or attended build leaves)
 * but has NEITHER actual-diff evidence NOR declared touches to classify from — i.e.
 * `acceptanceClassifyFiles` collapsed to `[]` for lack of information, not because the merge was
 * proven no-code.
 *
 * This is the gap a fast-drain `item.merged --data` append leaves when the coordinator supplies
 * the build's evidence (gateCommand/shas) but forgets `touches`: without `mergeProof`, that gap
 * would be indistinguishable from a genuine no-code question/feedback item's stub merge
 * (`{ commit, deployed }` — no gate, no shas), which correctly stays 'auto'. Requiring proof of
 * an actual build is what tells the two apart.
 *
 * `classifyAcceptanceTier` uses this to hold the tier at 'review' instead of defaulting to
 * 'auto' on an evidence-free merge that we know was a real build.
 */
export function hasEvidenceGap(
  evidenceFiles: string[] | undefined,
  declaredTouches: string | undefined,
  mergeProof: MergeProofFields | undefined,
): boolean {
  if (evidenceFiles !== undefined) return false;
  if (splitTouches(declaredTouches).length > 0) return false;
  return !!(mergeProof && (mergeProof.gateCommand || mergeProof.baseSha || mergeProof.headSha));
}

/**
 * Classify a merged item into an acceptance tier.
 *
 * Four layers (highest attention wins):
 *   A. the deterministic base tier (baseTier below — paths + judge fail), then
 *   B. the overseer floor (overseerFloor above — judge quality signals), and
 *   C. the evidence-gap floor ({@link hasEvidenceGap}) — a merge with no diff evidence AND no
 *      declared touches is held at 'review' instead of defaulting to 'auto', since the absence
 *      of files here means "unknown", not "proven no-code".
 *   D. the truncation floor ({@link classifyAcceptanceTier}'s `evidenceTruncated`) — a merge whose
 *      actual-diff evidence was TRUNCATED (only the first N changed paths were captured) is held at
 *      'review', because a risk path beyond the cap can't be seen. The headline promise is "tier
 *      from the REAL diff"; when the real diff is only partially known we must fail closed rather
 *      than trust a classification computed from an incomplete file list.
 *   B, C, and D all apply upgrade-only: final = max(base, floor).
 *
 * `evidenceGap` / `evidenceTruncated` default to `false` so direct callers that already pass a real
 * file list (e.g. runClaimAuditGate's actual `git diff` output, where an empty array IS proof of
 * no-code and the list is complete) are unaffected — only callers classifying a merged item via
 * `acceptanceClassifyFiles` need to pass `hasEvidenceGap(...)` / the folded truncation flag through.
 */
export function classifyAcceptanceTier(
  files: string[],
  judgeVerdict: OverseerVerdict | undefined,
  cfg: AcceptanceTierClassifyConfig,
  evidenceGap: boolean = false,
  evidenceTruncated: boolean = false,
): TierResult {
  const base = baseTier(files, judgeVerdict, cfg);
  const floor = overseerFloor(files, judgeVerdict, cfg.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR);
  let best = base;
  if (floor && TIER_RANK[floor.tier] > TIER_RANK[best.tier]) {
    best = { tier: floor.tier, reason: `overseer held above '${base.tier}': ${floor.reason}` };
  }
  if (evidenceGap && files.length === 0 && TIER_RANK.review > TIER_RANK[best.tier]) {
    best = {
      tier: 'review',
      reason: `merged with no diff evidence and no declared touches — conservative default, not no-code (was '${base.tier}')`,
    };
  }
  // TRUST-HARDENING (defect: truncated diff evidence): the diff was capped, so a risk path beyond
  // the cap is invisible to baseTier. Fail closed — a partially-known diff can never auto/optional-
  // accept. Upgrade-only, so it can only ever raise attention, never wave a 'must' path through.
  if (evidenceTruncated && TIER_RANK.review > TIER_RANK[best.tier]) {
    best = {
      tier: 'review',
      reason: `diff evidence truncated (only the first paths captured) — a risk path beyond the cap is unseen, needs your eyes (was '${best.tier}')`,
    };
  }
  return best;
}

/**
 * Deterministic base tier from paths + a judge fail.
 *
 * Rules, in order (highest attention wins):
 *   1. judgeVerdict.verdict === 'fail'                    → must
 *   2. files.length === 0 (no code — question/feedback)   → auto
 *   3. any file matches a riskPattern                     → must
 *   4. any file matches a surfacePrefix                    → review
 *      (a declared product surface is surfaced for test even when it is also plane-trusted
 *       for merge — surfacePrefixes and planePrefixes are orthogonal; surface wins here)
 *   5. every file is plane                                 → auto
 *   6. else (non-surface, non-plane product code)          → optional
 */
export function baseTier(
  files: string[],
  judgeVerdict: OverseerVerdict | undefined,
  cfg: AcceptanceTierClassifyConfig,
): TierResult {
  if (judgeVerdict?.verdict === 'fail') {
    return { tier: 'must', reason: 'judge verdict = fail — needs your eyes' };
  }

  if (files.length === 0) {
    return { tier: 'auto', reason: 'no code changed — question/feedback, nothing to test' };
  }

  const riskHits = files.filter(f => cfg.riskPatterns.some(p => f.includes(p)));
  if (riskHits.length > 0) {
    const shown = riskHits.slice(0, 3).join(', ');
    return { tier: 'must', reason: `touches risk-flagged paths (${shown}) — must verify` };
  }

  const isPlane = (f: string): boolean => matchesAnyPrefix(f, cfg.planePrefixes);
  // Surface wins over plane: a path declared a product surface is surfaced for the operator's
  // test even when it is also plane-trusted for auto-merge (orthogonal axes — see the interface
  // doc). This is what lets a fork keep the ops console auto-merging while still testing it.
  const surfaceHit = files.find(f => matchesAnyPrefix(f, cfg.surfacePrefixes));
  if (surfaceHit) {
    return { tier: 'review', reason: `touches a user-facing surface (${surfaceHit})` };
  }

  if (files.every(isPlane)) {
    return { tier: 'auto', reason: 'ops-plane internals only — gate-proven, nothing to test' };
  }

  return { tier: 'optional', reason: 'non-surface change — auto-accepts after a short window' };
}
