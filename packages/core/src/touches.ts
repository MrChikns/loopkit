/**
 * THE one Touches parser/matcher. loopkit stores an item's Touches/changed-files
 * set as a single comma-joined string on the fold record; every consumer — the dispatch
 * picker, the overstep gate, acceptance tiering, projections — must parse and match it
 * through these four functions. A second parser is how the picker and the gate, and
 * later the acceptance tier, came to disagree on the same string in the past.
 */

/**
 * Parse a comma-separated Touches string into normalized path prefixes:
 * split on commas, trim, and strip trailing slashes (items conventionally write
 * `packages/some-dir/`).
 */
export function normalizeTouches(touches: string): string[] {
  return touches.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** Undefined-tolerant alias for fold records where `touches` may be absent. */
export function splitTouches(touches: string | undefined): string[] {
  return normalizeTouches(touches ?? '');
}

/**
 * Segment-boundary containment: does prefix `a` contain path `b`? True only when
 * `b` IS `a` or lives strictly beneath it (`b` starts with `a + '/'`). A raw
 * startsWith wrongly made `packages/foo` contain `packages/foo-bar` — the picker
 * over-serialized on it while the gate did not.
 */
export function touchesSegmentMatch(a: string, b: string): boolean {
  return b === a || b.startsWith(a + '/');
}

/** True if file `f` falls under any of `prefixes`, on segment boundaries. */
export function matchesAnyTouchPrefix(f: string, prefixes: string[]): boolean {
  return prefixes.some(pre => touchesSegmentMatch(pre.replace(/\/+$/, ''), f));
}

/**
 * Do two Touches strings conflict (same worktree/footprint contention)? Missing/'*' is a
 * wildcard that always conflicts. The "why isn't this building" projection reuses the SAME
 * predicate the picker gates dispatch with — a second implementation would silently drift.
 */
export function touchesConflict(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true; // missing = wildcard → always conflicts
  if (a === '*' || b === '*') return true;
  const aParts = normalizeTouches(a);
  const bParts = normalizeTouches(b);
  for (const pa of aParts) {
    for (const pb of bParts) {
      // Overlap when either prefix contains the other on a segment boundary.
      if (touchesSegmentMatch(pa, pb) || touchesSegmentMatch(pb, pa)) return true;
    }
  }
  return false;
}
