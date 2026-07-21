/**
 * armed.ts — self-arming trigger map.
 *
 * An "armed item" is a machine-checkable predicate paired with a pre-written capture
 * payload. Each reactor beat evaluates every armed predicate; on a false→true edge
 * (the first time the predicate holds) it emits `item.captured` so a deferred step
 * flows through normal routing/dispatch on its own — "triggers itself into flight."
 *
 * Edge-triggered + idempotent: dedupe by a STABLE armed-id. Once an armed-id has fired
 * (an item.captured carries it), it never fires again — a still-true predicate is not
 * re-captured, and a predicate that goes false→true→false→true only ever fires once
 * ("fire once per arming, never re-capture a still-true predicate").
 *
 * Safety: the mechanism only ever CAPTURES; nothing here merges. An
 * escalation-class payload (capture.priority === 'escalation') parks for the operator
 * (item.parked) instead of queueing to build. The whole feature is gated by
 * LOOPKIT_AUTONOMY at the reactor boundary.
 *
 * ALL predicate evaluation is injected (ArmedProbe): the pure evaluator does NO
 * fs/spawn/SQL itself (mirrors slo.ts). Fail-open: a probe returning `undefined`
 * (error / unknown / timeout) is skipped — never crashes the beat, never parks.
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A machine-checkable predicate. Only 'shell' today: the command is run with `sh -c`
 * from the repo root and its EXIT CODE is the predicate — exit 0 = TRUE (fire), a clean
 * non-zero exit = FALSE, a kill/timeout (status null) = unknown (fail-open skip). A
 * "fold query" or "SQL" predicate is expressed as a shell command (e.g. one that runs
 * `loopctl …` and greps its output), so one kind covers the substrate; extend the union
 * when a non-shell predicate genuinely earns it.
 */
export interface ArmedPredicate {
  kind: 'shell';
  command: string;
  /** Timeout (ms) for the real shell probe. Default 10_000. */
  timeoutMs?: number;
}

/** The pre-written intent that a fired predicate captures onto the ledger. */
export interface ArmedCapture {
  /** Intent text = the item.captured text (what to build, or the operator note to park). */
  text: string;
  /** Comma-separated Touches path prefixes for the queued build (directory prefixes, trailing /). */
  touches?: string;
  /**
   * Dispatch priority (blocker|high|medium|low) OR the sentinel 'escalation'.
   * 'escalation' → the firing PARKS (item.parked, parkKind 'decision') instead of
   * queueing to build: costly-AND-irreversible payloads never auto-build.
   */
  priority?: string;
}

export interface ArmedItem {
  /** Stable armed-id — the dedup key. Never reuse across different predicates. */
  id: string;
  predicate: ArmedPredicate;
  capture: ArmedCapture;
  /** Default true. Set false to keep a row defined but dormant. */
  enabled?: boolean;
}

/**
 * Predicate probe. Returns true (holds → fire), false (does not hold), or undefined
 * (error / unknown → skip, fail-open). The reactor injects a real shell probe in
 * production; tests inject a fake.
 */
export type ArmedProbe = (pred: ArmedPredicate) => boolean | undefined;

export interface ArmedFiring {
  armedId: string;
  capture: ArmedCapture;
  /** true when capture.priority === 'escalation' → park for the operator, don't auto-build. */
  escalation: boolean;
}

/** The capture.priority sentinel that routes a firing to a park instead of a build. */
export const ESCALATION_PRIORITY = 'escalation';

// ---------------------------------------------------------------------------
// Pure evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate every armed item against its probe and return the firings for THIS beat.
 *
 * - Skips items with enabled === false, a blank id, or a duplicate id within this pass.
 * - Skips any armed-id already present in `alreadyFired` (the once-ever edge dedup;
 *   callers build this set from prior item.captured events carrying an armedId).
 * - A probe returning false OR undefined (fail-open) does not fire.
 * - A probe that throws is treated as undefined (skip), never propagated.
 */
export function evaluateArmed(
  armed: ArmedItem[],
  alreadyFired: Set<string>,
  probe: ArmedProbe,
): ArmedFiring[] {
  const firings: ArmedFiring[] = [];
  const seenThisPass = new Set<string>();
  for (const item of armed) {
    if (!item || item.enabled === false) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seenThisPass.has(id)) continue;
    seenThisPass.add(id);
    if (alreadyFired.has(id)) continue; // edge already consumed — never re-fire

    let held: boolean | undefined;
    try {
      held = probe(item.predicate);
    } catch {
      held = undefined;
    }
    if (held !== true) continue; // false OR undefined (fail-open) → no fire

    firings.push({
      armedId: id,
      capture: item.capture,
      escalation: (item.capture?.priority ?? '').toLowerCase() === ESCALATION_PRIORITY,
    });
  }
  return firings;
}

// ---------------------------------------------------------------------------
// Real probe (not used in tests — they inject a fake)
// ---------------------------------------------------------------------------

/**
 * Build the real shell probe. Runs the command with `sh -c` from `repoRoot`:
 *   exit 0            → true  (predicate holds, fire)
 *   clean non-zero    → false (predicate does not hold)
 *   killed (null) / error / unknown kind → undefined (fail-open skip)
 */
export function makeArmedProbe(repoRoot: string): ArmedProbe {
  return (pred) => {
    if (!pred || pred.kind !== 'shell') return undefined;
    const cmd = (pred.command ?? '').trim();
    if (!cmd) return undefined;
    try {
      const r = spawnSync('sh', ['-c', cmd], {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: pred.timeoutMs ?? 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (r.status === 0) return true;
      if (typeof r.status === 'number') return false; // clean non-zero exit = predicate false
      return undefined; // status null = killed (timeout/signal) → unknown, fail-open
    } catch {
      return undefined;
    }
  };
}
