/**
 * approval.ts — delegated approval boundary classifier.
 *
 * The approval boundary sits at costly-AND-irreversible: a green build that only oversteps
 * its declared scope in a "same-origin" way, or that only touches the PLANE spine, is a
 * delegated approval — the agent/plane approves it with a trail note rather than parking it
 * on the operator's needs-you board.
 *
 * This module is the pure, deterministic classifier the reactor's auto-approve step calls.
 * It reads a parked ItemRecord (its parkClass + the human-readable parkReason produced by the
 * dispatch gate) and decides whether the park is delegated.
 *
 * Park-reason grammar this parses (produced by the dispatch beat):
 *   touches-overstep → item.parked.reason:
 *     "needs-decision: files outside declared Touches (<TOUCHES>): <f1>, <f2>, ..."
 *   spine → item.parked.reason:
 *     "needs-decision: touches spine (<f1>, <f2>, ...) — approve to merge"
 *
 * Doctrine: transcribe-not-transform. The gate already emitted the class token
 * (gate.parked.reason) and the file list (item.parked.reason); here we only classify — no LLM.
 */

export interface AutoApproveConfig {
  enabled: boolean;
  /** Plane path prefixes — a spine park auto-approves only when every spine file matches one. */
  planePrefixes: string[];
  /** Companion path segments beside declared scope (projections/components/styles/tests). */
  companionSegments: string[];
  /** Hard escalation list — any match ALWAYS parks for the operator. */
  escalationPatterns: string[];
  /**
   * Narrative-doc allowlist for touches-overstep. A `touches-overstep` park auto-
   * approves as a companion merge when EVERY overstep file matches one of these patterns
   * (and none is operative markdown, config, or an escalation hit). Fail-safe: an
   * unrecognized path never matches, so it keeps parking.
   */
  docCompanionGlobs: string[];
  /**
   * Operator-declared operative markdown — exact repo-relative paths (or `/`-suffixed
   * "endsWith" matches) that ALWAYS surface, never auto-approve as a doc companion, on top
   * of the framework built-ins (`.ai/**`, `CLAUDE.md`, `AGENTS.md`). Empty by default; an
   * operator whose decision log / gate registry lives outside `.ai/**` lists it here.
   */
  operativeDocs: string[];
  /**
   * Governance-critical classifiers (approval.ts / acceptance.ts / armed.ts). A park
   * whose file list includes one of these paths (substring match, like planePrefixes) NEVER
   * auto-approves — these files govern the auto-approve boundary itself, so a change to one
   * must not self-approve. Checked first, before any delegated-class rule. The operator's
   * explicit approve verb still merges (it does not route through this classifier).
   */
  governanceCriticalPaths: string[];
}

/** The minimal ItemRecord shape the classifier needs (keeps it decoupled from fold.ts). */
export interface ParkedItemView {
  parkClass?: string;
  parkReason?: string;
}

export interface AutoApproveDecision {
  /** True → the reactor silently approves with a trail note. */
  autoApprove: boolean;
  /** Human-readable rationale (goes into the msg.out trail on approve; a park note otherwise). */
  reason: string;
  /** The delegated class recognized ('touches-overstep' | 'spine'), if any. */
  parkClass?: string;
}

// ---------------------------------------------------------------------------
// Parsers for the two delegated park-reason grammars
// ---------------------------------------------------------------------------

/**
 * Parse a touches-overstep item.parked reason into (declaredTouches, overstepFiles).
 * Returns null when the string doesn't match the grammar (defensive — never crash a beat).
 */
export function parseOverstepReason(
  reason: string,
): { declared: string[]; files: string[] } | null {
  const m = reason.match(/files outside declared Touches \(([^)]*)\):\s*(.*)$/s);
  if (!m) return null;
  const declared = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const files = m[2].split(',').map(s => s.trim()).filter(Boolean);
  if (files.length === 0) return null;
  return { declared, files };
}

/**
 * Parse a spine item.parked reason into the list of spine files.
 * Returns null when the string doesn't match the grammar.
 */
export function parseSpineReason(reason: string): { files: string[] } | null {
  const m = reason.match(/touches spine \(([^)]*)\)/s);
  if (!m) return null;
  const files = m[1].split(',').map(s => s.trim()).filter(Boolean);
  if (files.length === 0) return null;
  return { files };
}

// ---------------------------------------------------------------------------
// Dependency-wait stored-spec approval
// ---------------------------------------------------------------------------

/**
 * Parse a "depends on WI-NNN" / "blocked on WI-NNN" reference out of a park reason.
 * Transcribe-not-transform: this only EXTRACTS an id the conductor already wrote in
 * plain English at park time — it never infers or guesses one. Returns null when the reason
 * doesn't name a dependency this way; the caller must then fall back to the LLM routing path.
 */
export function parseDependencyReason(reason: string): { depId: string } | null {
  const m = reason.match(/\b(?:depends on|blocked on|blocking on)\s+(WI-\d+)\b/i);
  return m ? { depId: m[1].toUpperCase() } : null;
}

/** Minimal item-state shape a dependency check needs (keeps approval.ts decoupled from fold.ts). */
export interface DependencyItemView {
  state?: string;
}

/**
 * Deterministically classify whether `depId` has cleared. 'unknown' when the dependency isn't
 * in the fold at all (a typo'd id, a stale ref, a ledger replay gap) — callers treat this the
 * same as 'unresolved': never build ahead of a dependency that can't be verified.
 */
export type DependencyState = 'resolved' | 'unresolved' | 'unknown';

export function checkDependencyState(
  depId: string,
  items: ReadonlyMap<string, DependencyItemView>,
): DependencyState {
  const dep = items.get(depId);
  if (!dep) return 'unknown';
  return dep.state === 'merged' || dep.state === 'accepted' || dep.state === 'done' ? 'resolved' : 'unresolved';
}

/** The parked-item shape a stored-spec approve check needs (extends ParkedItemView with storedSpec). */
export interface StoredSpecParkedView extends ParkedItemView {
  storedSpec?: string;
}

export type StoredSpecApproval =
  | { kind: 'no-stored-spec' }
  | { kind: 'unparseable-dependency' }
  | { kind: 'unresolved'; depId: string }
  | { kind: 'resolved'; depId: string; spec: string };

/**
 * The operator-approve-time decision for a dependency-wait park: when a spec was
 * stored at park time AND its named dependency has since merged, approve can queue the build
 * directly — no LLM routing call. One predicate composing the two pure checks above (never
 * inlined at the call site), so the approve path and any future caller share the exact same rule.
 */
export function resolveStoredSpecApproval(
  item: StoredSpecParkedView,
  items: ReadonlyMap<string, DependencyItemView>,
): StoredSpecApproval {
  if (!item.storedSpec) return { kind: 'no-stored-spec' };
  const dep = parseDependencyReason(item.parkReason ?? '');
  if (!dep) return { kind: 'unparseable-dependency' };
  const state = checkDependencyState(dep.depId, items);
  return state === 'resolved'
    ? { kind: 'resolved', depId: dep.depId, spec: item.storedSpec }
    : { kind: 'unresolved', depId: dep.depId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Top-level directory of a path prefix/file (e.g. "packages/some-ui/x.ts" → "packages"). */
function topDir(p: string): string {
  const clean = p.replace(/^\.\//, '');
  const idx = clean.indexOf('/');
  return idx === -1 ? clean : clean.slice(0, idx);
}

/** True if `file` is a same-origin extension of the declared scope or a companion dir. */
function isSameOrigin(file: string, declaredTopDirs: Set<string>, companionSegments: string[]): boolean {
  // Same top-level dir as a declared Touches prefix (the projection/component/test sibling
  // usually lands under the same top dir as the declared scope, e.g. services/api/... ).
  if (declaredTopDirs.has(topDir(file))) return true;
  // Or a standard companion segment anywhere in the path (projections/, components/, styles/, test/).
  return companionSegments.some(seg => file.includes(seg));
}

/**
 * Extract the parked file list from whichever park grammar matches (spine or touches-
 * overstep). Returns [] when neither matches — a governance check on [] is a no-op, so an
 * unparseable reason falls through to the per-class rules (which park on unparseable).
 */
function extractParkedFiles(reason: string): string[] {
  const parsed = parseSpineReason(reason) ?? parseOverstepReason(reason);
  return parsed?.files ?? [];
}

/** True if any file matches the hard escalation list (substring match). */
function hitsEscalation(files: string[], patterns: string[]): string | null {
  for (const f of files) {
    for (const pat of patterns) {
      if (f.includes(pat)) return `${f} (matches escalation pattern "${pat}")`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Narrative-doc companion allowlist (touches-overstep only)
// ---------------------------------------------------------------------------

/**
 * The plane's own prompt/config files under `.ai/loops/**` (e.g.
 * `.ai/loops/prompts/conductor.md`, `.ai/loops/config.env`) are REVERSIBLE plane-spine
 * companions, not operator-decision surfaces — a worker touching them should be able to
 * auto-approve (with a visible trail), unlike the rest of `.ai/**`. Matches both the
 * repo-root prefix and the "anywhere in path" shape, mirroring the existing `.ai/` idiom.
 */
export function isPlaneOwnedDoc(file: string): boolean {
  return file.startsWith('.ai/loops/') || file.includes('/.ai/loops/');
}

/**
 * Operative markdown that agents/gates read as instructions — ALWAYS surfaces, never a
 * doc-companion, regardless of docCompanionGlobs. Built-in list: `.ai/**`,
 * `CLAUDE.md`, `AGENTS.md`, plus any operator-declared `operativeDocs` (exact repo-relative
 * paths). `.ai/loops/**` (the plane's own prompt/config) is carved out — those are reversible
 * plane-spine companions, not operator-decision surfaces, so they don't hit this hard block.
 */
function isOperativeMarkdown(file: string, operativeDocs: string[]): boolean {
  if ((file.startsWith('.ai/') || file.includes('/.ai/')) && !isPlaneOwnedDoc(file)) return true;
  if (file === 'CLAUDE.md' || file.endsWith('/CLAUDE.md')) return true;
  if (file === 'AGENTS.md' || file.endsWith('/AGENTS.md')) return true;
  if (operativeDocs.some(p => file === p || file.endsWith('/' + p))) return true;
  return false;
}

/**
 * Config/lockfile paths — ALWAYS surface (a config change can be behavioural), never a
 * doc-companion regardless of docCompanionGlobs: `*.json` / `*.config.*` /
 * `config.env` / `*.plist` / lockfiles.
 */
function isConfigPath(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (file.endsWith('.json')) return true;
  if (file.endsWith('.plist')) return true;
  if (/\.config\./.test(base)) return true;
  if (base === 'config.env') return true;
  const lockfiles = new Set(['yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'go.mod', 'Cargo.lock', 'composer.lock']);
  return lockfiles.has(base);
}

/**
 * Match one docCompanionGlobs entry against a file path using the same substring/includes
 * idiom as isSameOrigin — no glob library. Supported shapes:
 *   "README.md"    — bare filename, matches at any directory depth
 *   "**\/README.md" — same as bare (explicit "any depth" spelling)
 *   "docs/**"       — directory prefix (anywhere in the path), markdown files only
 *   "docs/roadmap.md" — exact repo-relative path
 */
function matchesDocPattern(file: string, pattern: string): boolean {
  if (pattern.startsWith('**/')) {
    const suffix = pattern.slice(3);
    return file === suffix || file.endsWith('/' + suffix);
  }
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -2); // "docs/**" -> "docs/"
    if (!file.endsWith('.md')) return false;
    return file.startsWith(prefix) || file.includes('/' + prefix);
  }
  if (!pattern.includes('/')) {
    return file === pattern || file.endsWith('/' + pattern);
  }
  return file === pattern || file.endsWith('/' + pattern);
}

/**
 * True iff `file` is a narrative-doc companion: matches docCompanionGlobs AND is
 * not operative markdown or config. Fail-safe — an unrecognized path returns false.
 *
 * A plane-owned doc (`.ai/loops/**`) is ALWAYS treated as an approvable
 * companion here, independent of the configured docCompanionGlobs — it's the plane's own
 * reversible prompt/config surface, not a narrative doc that happens to match a glob.
 */
function isDocCompanion(file: string, docCompanionGlobs: string[], operativeDocs: string[]): boolean {
  if (isPlaneOwnedDoc(file)) return true;
  if (isOperativeMarkdown(file, operativeDocs)) return false;
  if (isConfigPath(file)) return false;
  return docCompanionGlobs.some(pat => matchesDocPattern(file, pat));
}

// ---------------------------------------------------------------------------
// Shared plane-path helper (used by provisional acceptance)
// ---------------------------------------------------------------------------

/**
 * Classify a list of files against the plane config.
 *
 * Returns:
 *   planeOnly  — true iff EVERY file is under at least one planePrefixes entry
 *   escalated  — subset matching the hard escalation list (disqualifies auto-acceptance)
 *
 * Consumers (auto-approve and provisional accept) share this so the
 * plane boundary is defined in exactly one place (the config's planePrefixes +
 * escalationPatterns).
 */
export function classifyPathsPlaneOnly(
  files: string[],
  planePrefixes: string[],
  escalationPatterns: string[],
): { planeOnly: boolean; escalated: string[] } {
  const isPlane = (f: string): boolean =>
    planePrefixes.some(pre => f.startsWith(pre) || f.includes('/' + pre));
  const escalated = files.filter(f =>
    escalationPatterns.some(pat => f.includes(pat)),
  );
  const planeOnly = files.length > 0 && files.every(f => isPlane(f));
  return { planeOnly, escalated };
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Classify a parked item for delegated auto-approval.
 *
 * Rules (in order):
 *   0. autoApprove disabled → never auto-approve.
 *   0b. governance-critical: any parked file is an operator-interrupt classifier
 *      (approval.ts / acceptance.ts / armed.ts) → ALWAYS parks, regardless of class.
 *   1. Escalation list: any parked file matches money/external/contracts/authz/migrations
 *      → ALWAYS parks (costly-and-irreversible), regardless of class.
 *   2. touches-overstep: auto-approve iff EVERY overstep file is same-origin (under a declared
 *      Touches top-dir, or a companion segment beside declared scope).
 *   3. spine: auto-approve iff EVERY spine file is a PLANE path (planePrefixes). Any product
 *      spine file keeps the whole park for the operator.
 *   Anything else → parks.
 */
export function classifyParkForAutoApprove(
  item: ParkedItemView,
  cfg: AutoApproveConfig,
): AutoApproveDecision {
  if (!cfg.enabled) {
    return { autoApprove: false, reason: 'auto-approve disabled in config' };
  }

  // Governance-critical classifiers govern the auto-approve boundary itself — a change
  // to one must never self-approve. Checked before the delegated-class rules, alongside the
  // escalation guard. Only blocks AUTO-approval: the operator's explicit approve verb routes
  // through stepApplyVerbs (state === 'approved'), never this classifier.
  const govPaths = cfg.governanceCriticalPaths ?? [];
  if (govPaths.length > 0) {
    const govHit = extractParkedFiles(item.parkReason ?? '').find(
      f => govPaths.some(p => f.includes(p)),
    );
    if (govHit) {
      return {
        autoApprove: false,
        parkClass: item.parkClass,
        reason: `governance: ${govHit} is a governance-critical classifier — operator approval required`,
      };
    }
  }

  const parkClass = item.parkClass;
  const parkReason = item.parkReason ?? '';

  if (parkClass === 'touches-overstep') {
    const parsed = parseOverstepReason(parkReason);
    if (!parsed) {
      return { autoApprove: false, reason: 'touches-overstep park: unparseable reason — parking for operator', parkClass };
    }
    const esc = hitsEscalation(parsed.files, cfg.escalationPatterns);
    if (esc) {
      return { autoApprove: false, reason: `escalation: ${esc}`, parkClass };
    }
    const declaredTopDirs = new Set(parsed.declared.map(topDir));
    const offOrigin = parsed.files.filter(f => !isSameOrigin(f, declaredTopDirs, cfg.companionSegments));
    if (offOrigin.length === 0) {
      return {
        autoApprove: true,
        parkClass,
        reason: `auto-approve: touches-overstep is same-origin (${parsed.files.join(', ')}) — projection-pattern extension of declared scope [${parsed.declared.join(', ')}]`,
      };
    }
    // Narrative-doc companion — conjunction, not partial. A single non-doc file
    // (config/code/operative-markdown) among the overstep forces the whole item to surface.
    if (parsed.files.every(f => isDocCompanion(f, cfg.docCompanionGlobs, cfg.operativeDocs))) {
      // When every overstep file is plane-owned (`.ai/loops/**`), give it a
      // distinct trail reason — this is a reversible plane-spine companion, not a narrative-
      // doc waiver, so the trail event should say so accurately.
      if (parsed.files.every(isPlaneOwnedDoc)) {
        return {
          autoApprove: true,
          parkClass,
          reason: `auto-approve: plane-owned prompt/config (.ai/loops) — reversible plane-spine companion (${parsed.files.join(', ')})`,
        };
      }
      return {
        autoApprove: true,
        parkClass,
        reason: `auto-approve: narrative-doc companion merge (${parsed.files.join(', ')}) — waived as documentation, no code/config changed`,
      };
    }
    return {
      autoApprove: false,
      parkClass,
      reason: `touches-overstep with off-origin files (${offOrigin.join(', ')}) — parking for operator`,
    };
  }

  if (parkClass === 'spine') {
    const parsed = parseSpineReason(parkReason);
    if (!parsed) {
      return { autoApprove: false, reason: 'spine park: unparseable reason — parking for operator', parkClass };
    }
    const esc = hitsEscalation(parsed.files, cfg.escalationPatterns);
    if (esc) {
      return { autoApprove: false, reason: `escalation: ${esc}`, parkClass };
    }
    const isPlane = (f: string): boolean => cfg.planePrefixes.some(pre => f.startsWith(pre) || f.includes('/' + pre));
    const productSpine = parsed.files.filter(f => !isPlane(f));
    if (productSpine.length === 0) {
      return {
        autoApprove: true,
        parkClass,
        reason: `auto-approve: plane-only spine (${parsed.files.join(', ')}) — auto-merges on green`,
      };
    }
    return {
      autoApprove: false,
      parkClass,
      reason: `product spine hit (${productSpine.join(', ')}) — parking for operator`,
    };
  }

  return { autoApprove: false, reason: `park class '${parkClass ?? 'unknown'}' is not a delegated class`, parkClass };
}
