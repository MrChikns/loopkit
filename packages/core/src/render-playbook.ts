/**
 * render-playbook.ts — ADR-015 Slice 1: renders `.ai/loops/playbook.md` from the ledger's
 * `knowledge.ratified`/`knowledge.expired` events (see docs/decisions/ADR-015-verified-
 * knowledge-promotion.md). This is a pure library — no fs writes, no process.argv — matching
 * render-lane-matrix.ts's split between logic (here) and the reactor step that actually writes
 * the file (`stepPlaybookMaterialize` in beats/reactor.ts).
 *
 * Three responsibilities, in order:
 *   1. `revalidateKnowledge` — read-time freshness check (anchor, else TTL) over the fold's live
 *      `KnowledgeFact`s, producing `knowledge.expired{reason:'stale'}` events for the ones that
 *      no longer hold.
 *   2. `rankKnowledge` — recency × usefulness ranking of what survives revalidation, returning
 *      whatever falls past the line budget as a plain `evicted` list — PROJECTION-ONLY (no
 *      `knowledge.expired` event; see rankKnowledge's own doc comment for why appending one
 *      there used to make the eviction permanent, contradicting the ADR's "rises back next
 *      beat" promise — WI-270 defect 2).
 *   3. `renderPlaybookMarkdown` — the GENERATED file body for the surviving, budgeted set.
 */
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute, delimiter, relative } from 'node:path';
import { KnowledgeFact, ItemRecord } from './fold.js';
import { makeEvent, LedgerEvent, KnowledgeExpiredData } from './schema.js';

/** GENERATED banner — mirrors render-lane-matrix.ts's own "do not hand-edit" convention. */
export const PLAYBOOK_GENERATED_BANNER =
  '<!-- GENERATED — do not hand-edit. Rendered by stepPlaybookMaterialize from ledger ' +
  'knowledge.ratified/knowledge.expired events (ADR-015). Edits here are lost on the next ' +
  'materialize beat; retract a lesson via the operator `retract` verb instead. -->';

/**
 * Resolve whether a command's LEADING binary token exists — either an explicit path (contains
 * '/', checked directly) or a bare name searched across `PATH`. Deliberately cheap/synchronous
 * and dependency-free (no shell-out): existence only, not "runs successfully" — the read-time
 * safety net this feeds is accident-prevention, not proof (ADR-015 Consequences).
 */
export function resolveCommandBinary(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const bin = trimmed.split(/\s+/)[0] as string;
  if (bin.includes('/')) return existsSync(bin);
  const pathVar = env['PATH'] ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return true;
  }
  return false;
}

/**
 * Resolve a lesson's `verifyPath` against the target repo root, or reject it as invalid
 * (WI-270 defect 4 fix). A `verifyPath` is operator/auditor-sourced free text carried through
 * the ledger, so it must be treated as untrusted input, not a pre-validated repo-relative path:
 *   - an ABSOLUTE path is rejected outright — the anchor's entire point is "does this repo-
 *     relative path still exist in THIS repo," and an absolute path bypasses that scoping
 *     (it could point anywhere on the host running the beat).
 *   - a path that resolves OUTSIDE `repoRoot` (e.g. `../../etc/passwd`) is rejected the same
 *     way — `relative(repoRoot, resolved)` starting with `..` or being itself absolute is the
 *     standard node:path containment check.
 * Fail-safe posture: an invalid path returns `undefined`, and the caller treats that exactly
 * like a failed anchor (the lesson is stale/anchor-failed) rather than silently falling through
 * to the no-anchor TTL path — a malformed anchor must never make a lesson MORE trusted (TTL-only)
 * than a well-formed one that failed its check.
 */
function resolveVerifyPath(verifyPath: string, repoRoot: string): string | undefined {
  if (isAbsolute(verifyPath)) return undefined;
  const resolved = join(repoRoot, verifyPath);
  const rel = relative(repoRoot, resolved);
  if (rel === '') return resolved; // repoRoot itself — degenerate but not a traversal
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return resolved;
}

export interface RevalidationResult {
  /** Live facts (by contentHash) that survived revalidation — anchor holds, or no anchor + within TTL. */
  fresh: KnowledgeFact[];
  /** knowledge.expired{reason:'stale'} events for facts that failed revalidation this beat. */
  expiredEvents: LedgerEvent[];
}

/**
 * Read-time revalidation (ADR-015 "Read-time safety"): for each LIVE fact, check its anchor
 * (verifyPath must exist under repoRoot; verifyCommand's leading binary must resolve on PATH)
 * if it carries one, else fall back to a TTL measured from `ratifiedAt`. A fact with BOTH an
 * anchor and no anchor is impossible by construction (verifyPath/verifyCommand are optional
 * independently) — a fact with either anchor present is anchor-checked; TTL applies only when
 * NEITHER is set.
 */
export function revalidateKnowledge(
  facts: KnowledgeFact[],
  repoRoot: string,
  ttlDays: number,
  now: number = Date.now(),
): RevalidationResult {
  const fresh: KnowledgeFact[] = [];
  const expiredEvents: LedgerEvent[] = [];
  for (const fact of facts) {
    if (!fact.live) continue;
    let failedAnchor: string | undefined;

    if (fact.verifyPath) {
      const abs = resolveVerifyPath(fact.verifyPath, repoRoot);
      // An absolute path or one that escapes repoRoot is an INVALID anchor (WI-270 defect 4) —
      // treated as failed exactly like a missing file, never silently ignored/passed through.
      if (abs === undefined || !existsSync(abs)) failedAnchor = fact.verifyPath;
    }
    if (!failedAnchor && fact.verifyCommand) {
      if (!resolveCommandBinary(fact.verifyCommand)) failedAnchor = fact.verifyCommand;
    }
    if (!failedAnchor && !fact.verifyPath && !fact.verifyCommand) {
      const ageMs = now - new Date(fact.ratifiedAt).getTime();
      const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
      if (Number.isFinite(ageMs) && ageMs > ttlMs) failedAnchor = `ttl:${ttlDays}d`;
    }

    if (failedAnchor) {
      expiredEvents.push(makeEvent('reactor', fact.sourceWi, 'knowledge.expired', {
        contentHash: fact.contentHash,
        reason: 'stale',
        failedAnchor,
      } satisfies KnowledgeExpiredData));
    } else {
      fresh.push(fact);
    }
  }
  return { fresh, expiredEvents };
}

export interface RankingResult {
  /** Facts kept within the line budget, ordered highest-ranked first. */
  kept: KnowledgeFact[];
  /**
   * Facts past the budget cutoff, in rank order. WI-270 defect 2 fix: the budget cutoff is
   * PROJECTION-ONLY — no `knowledge.expired` is ever appended for these (see rankKnowledge's
   * doc comment). This list exists only so the caller can report `evictedForBudget` on
   * `playbook.materialized`; nothing folds behavior off it.
   */
  evicted: KnowledgeFact[];
}

/**
 * Cheap ledger-derived "usefulness" signal for one fact: how many items merged AFTER this
 * lesson was ratified touch the same area as its `verifyPath` (directory-prefix overlap
 * against `mergeChangedFiles`). A lesson with no `verifyPath` has no touched-area signal, so
 * usefulness is 0 (recency alone still ranks it). Deliberately not a measurement of whether the
 * lesson actually helped (ADR-015 Consequences: "a heuristic, not proof").
 */
function computeUsefulness(fact: KnowledgeFact, laterMerges: ItemRecord[]): number {
  if (!fact.verifyPath) return 0;
  const area = fact.verifyPath.includes('/')
    ? fact.verifyPath.slice(0, fact.verifyPath.lastIndexOf('/'))
    : fact.verifyPath;
  let count = 0;
  for (const rec of laterMerges) {
    const files = rec.mergeChangedFiles ?? [];
    if (files.some(f => f === fact.verifyPath || f.startsWith(`${area}/`) || area === '')) count++;
  }
  return count;
}

/**
 * Rank fresh facts by recency × usefulness and keep only the top `maxLines`. WI-270 defect 2
 * fix: the budget cutoff is a PROJECTION-ONLY cut — it never appends `knowledge.expired` for
 * whatever falls past `maxLines`. The old code appended `knowledge.expired{reason:'budget-
 * evicted'}` here, which flips the fact's `live` flag to `false` FOREVER (fold.ts's LWW never
 * un-expires a fact without a fresh `knowledge.ratified`) — so a budget-evicted lesson could
 * never "rise back next beat" the way the ADR promises, because by the NEXT beat it would no
 * longer even be in the `fresh` (live) set this function is ranking. Instead, a lesson past the
 * cutoff simply isn't rendered this beat; it stays fully live in the ledger and re-enters
 * ranking (and may place inside the budget) on every subsequent materialize — which is what
 * actually delivers "rises back next beat" when a higher-ranked lesson later expires stale.
 */
export function rankKnowledge(
  fresh: KnowledgeFact[],
  allMergedItems: ItemRecord[],
  maxLines: number,
): RankingResult {
  const scored = fresh.map(fact => {
    const ratifiedMs = new Date(fact.ratifiedAt).getTime();
    const laterMerges = allMergedItems.filter(rec => {
      const mergedMs = rec.mergedAt ? new Date(rec.mergedAt).getTime() : NaN;
      return Number.isFinite(mergedMs) && mergedMs > ratifiedMs;
    });
    const usefulness = computeUsefulness(fact, laterMerges);
    // Recency: newer ratifiedAt ⇒ larger score. Combined multiplicatively with usefulness+1
    // (so a zero-usefulness lesson isn't zeroed out entirely — recency alone still ranks it).
    const recencyScore = Number.isFinite(ratifiedMs) ? ratifiedMs : 0;
    const score = recencyScore * (usefulness + 1);
    return { fact, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const kept = scored.slice(0, maxLines).map(s => s.fact);
  const evicted = scored.slice(maxLines).map(s => s.fact);

  return { kept, evicted };
}

/**
 * Render the playbook file body for a ranked, budgeted set of lessons. Deterministic order
 * (caller passes the already-ranked list); one lesson per line, imperative playbook voice
 * (KnowledgeCandidateData.lesson's own contract), GENERATED banner first.
 */
export function renderPlaybookMarkdown(lessons: KnowledgeFact[]): string {
  const lines = lessons.map(l => `- ${l.lesson}`);
  return `${PLAYBOOK_GENERATED_BANNER}\n\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

/** Stable content hash of a rendered file body — the idempotent-write key. */
export function hashPlaybookContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
