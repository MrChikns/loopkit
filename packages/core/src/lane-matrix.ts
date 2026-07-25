/**
 * lane-matrix.ts — the lane × guard matrix, DERIVED from source, never hand-typed
 * (ADR-010 point 6: `docs/decisions/ADR-010-one-lane.md`).
 *
 * ADR-013 deleted the conductor lane, so every remaining lane (planning, target, engineering)
 * lives in `dispatch.ts`. The generator still reads a MAP of source files rather than a single
 * one — a future lane in its own module needs a registry entry, not a rewrite.
 *
 * Why derived-from-source and not a runtime registry or a declared table:
 *
 *  - A runtime registry the lanes actually *consume* (guards as configured properties of one
 *    path) is the ADR-010 end state, but it requires editing `dispatch.ts` to read from it —
 *    exactly the file a sibling agent owned mid-refactor when this was written. Doing that here
 *    would either collide with that work or force touching frozen files. Deferred to the
 *    lane-as-parameter stage the ADR itself sequences last.
 *  - A hand-declared table (a JS object saying "target lane: no spine, no judge...") paired with
 *    a test asserting it matches reality just moves the rot one file over: nothing forces the
 *    declaration to be re-derived when a lane changes, and ADR-010's whole complaint is that
 *    exactly this kind of prose/table silently goes stale (`method.md`, 24 hours).
 *  - Static analysis of the ACTUAL lane source is the only option here that (a) requires no
 *    edit to the frozen files, (b) has no separate "declaration" a human can forget to update —
 *    the matrix cell IS the presence of a call-site marker in the lane's own code, and (c) fails
 *    loudly (not silently) the moment a lane's marker set changes, via the paired snapshot test.
 *
 * Mechanics: each lane function's source span is found by NAME (declaration line → matching
 * closing brace), never by line number — so this survives in-flight edits to `dispatch.ts`
 * (introducing `commitMode`, consolidating commit paths). Within a lane's span we
 * grep for a fixed set of identifier markers, one per guard column. A marker is a real exported
 * or local identifier the lane would have to call/name to exercise that guard (e.g.
 * `checkTouchesOverstep(`, `runJudge(`, `denialNote`) — not free text, so a rename shows up as
 * the marker disappearing (fails safe: a lane that silently loses a guard call also loses the
 * marker, and the matrix records `false` for it).
 *
 * This module only READS `dispatch.ts` as text. It imports nothing from it and is never
 * imported by it — safe to keep even if that file is mid-refactor or temporarily
 * uncompilable, and immune to identifier/type churn inside it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This module ships compiled at two DIFFERENT depths depending on which tsconfig produced it:
//   packages/core/dist/lane-matrix.js          (tsconfig.json,      rootDir: src)   — 1 level down
//   packages/core/dist-test/src/lane-matrix.js (tsconfig.test.json, no rootDir)     — 2 levels down
// Rather than hard-code either depth (which silently breaks the moment either tsconfig's
// rootDir/outDir setting changes), walk up from this file until we find the package root
// (the directory holding this package's package.json), then descend into ITS `src/`. The
// matrix always describes the SOURCE, never whichever build artifact happens to be running.
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'lane-matrix.ts'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `lane-matrix: could not locate the package root (a directory with package.json AND src/lane-matrix.ts) ` +
    `walking up from ${startDir}. Expected packages/core/{dist,dist-test/src}/lane-matrix.js layout.`,
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(__dirname);
const SRC_DIR = join(PACKAGE_ROOT, 'src');

/** Repo-relative source files the matrix is derived from. */
export const LANE_SOURCE_FILES = {
  dispatch: join(SRC_DIR, 'beats', 'dispatch.ts'),
} as const;

export type LaneId = 'planning' | 'target' | 'batch';

export const LANE_IDS: LaneId[] = ['planning', 'target', 'batch'];

/** One guard/property column. Order here is the order rendered. */
export const GUARD_IDS = [
  'touchesOverstep',
  'spineCheck',
  'judge',
  'scout',
  'push',
  'alreadyShippedCommit',
  'denialNote',
  'gateWrapper',
  'commitSide',
  'claimArbitration',
  'postIntegrationRegate',
] as const;
export type GuardId = (typeof GUARD_IDS)[number];

/**
 * Columns whose cell is an ENUM STRING rather than a boolean marker hit. A boolean would be a
 * lie for all of them: "does this lane arbitrate claims" and "does this lane re-gate" both have a
 * meaningful middle (reserve without arbitrating; gate once and merge anyway) that `no` would
 * flatten into "absent", which is precisely the misreading `limitations.md` warns about.
 */
export type EnumGuardId = 'gateWrapper' | 'commitSide' | 'claimArbitration' | 'postIntegrationRegate';

/** Cell value for the boolean guard columns. The {@link EnumGuardId} columns are strings instead. */
export type Cell = boolean | string;

export interface LaneRow {
  lane: LaneId;
  /** Name of the function(s) this lane's span was extracted from, for traceability. */
  functionNames: string[];
  cells: Record<GuardId, Cell>;
}

export interface LaneMatrix {
  rows: LaneRow[];
  /** Sha-independent — just a marker this was generated, not authored. */
  generatedNote: string;
}

// ---------------------------------------------------------------------------
// Source-span extraction (name-anchored, not line-number-anchored)
// ---------------------------------------------------------------------------

/**
 * Strip line comments and string/template literals so brace-counting isn't fooled by a `{` or
 * `}` inside a comment or a string (this file's own lane source uses both). Deliberately crude
 * (not a real tokenizer) — sufficient for balanced-brace scanning, not for anything semantic.
 *
 * LENGTH- AND OFFSET-PRESERVING: every stripped span is replaced with same-length filler
 * (newlines kept as newlines, everything else blanked to a space) so an index found in the
 * returned shadow string is valid at the SAME index in the original `src`. Losing this
 * invariant silently mis-locates function spans (caught during review of this generator: a
 * naive non-length-preserving strip mapped `finalizeTargetBuild`'s declaration onto an
 * unrelated, wrong brace range).
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = new Array(src.length);
  let i = 0;
  const n = src.length;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      fill(i, stop);
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j += 2;
        else j += 1;
      }
      const stop = Math.min(j + 1, n);
      fill(i, stop);
      i = stop;
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

/**
 * Strip ONLY comments (line + block), preserving string/template literal contents intact.
 * Used before guard-marker matching: a marker like the `push` check needs to see the real
 * string literal `'push'` inside a `spawnSync(...)` call, but must not fire on a comment that
 * merely NAMES a guard in prose (e.g. WI-166's commentary mentions `BUILDER_TOOLS` without the
 * lane actually granting it) — `stripCommentsAndStrings` above is too aggressive for this use
 * (it blanks strings too, which the `push` marker depends on).
 */
export function stripComments(src: string): string {
  const out: string[] = new Array(src.length);
  let i = 0;
  const n = src.length;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      fill(i, stop);
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j += 2;
        else j += 1;
      }
      const stop = Math.min(j + 1, n);
      // Copy the string literal VERBATIM (unlike stripCommentsAndStrings) — markers may
      // depend on its contents (e.g. the literal `'push'` argument).
      for (let k = i; k < stop; k++) out[k] = src[k];
      i = stop;
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

/**
 * Find a named function's source span: from its `function <name>` declaration to the matching
 * closing brace, using a comment/string-stripped shadow of the file for brace-counting so the
 * offsets still map back onto the ORIGINAL text. Anchored purely on the function name appearing
 * after the `function` keyword — survives reordering, reformatting, and line-number churn.
 * Returns the original (uncleaned) source slice, so downstream marker checks see real code.
 */
export function extractFunctionSpan(src: string, functionName: string): string | undefined {
  const shadow = stripCommentsAndStrings(src);
  const declRe = new RegExp(`function\\s+${functionName}\\s*[(<]`);
  const declMatch = declRe.exec(shadow);
  if (!declMatch) return undefined;

  // Find the parameter list's opening `(` (skipping over an optional `<...>` generic first —
  // the declaration regex already accepted `(` or `<` right after the name).
  let parenIdx = shadow.indexOf('(', declMatch.index);
  const angleIdx = shadow.indexOf('<', declMatch.index);
  if (angleIdx !== -1 && angleIdx < parenIdx) {
    // Skip the generic parameter list `<...>` (bracket-depth walk — generics can nest, e.g.
    // `Promise<Map<string, X>>`), then the next `(` is the real parameter list.
    let depth = 0;
    let j = angleIdx;
    for (; j < shadow.length; j++) {
      if (shadow[j] === '<') depth++;
      else if (shadow[j] === '>') { depth--; if (depth === 0) { j++; break; } }
    }
    parenIdx = shadow.indexOf('(', j);
  }
  if (parenIdx === -1) return undefined;

  // Walk the parameter list, tracking ALL bracket kinds ( ) { } [ ] together — a parameter's
  // type annotation (e.g. `ctx: { gitRoot: string; ... }`) legitimately contains `{`/`}` before
  // the function BODY even starts, so depth must be tracked jointly or the body's own opening
  // brace (and the parameter-type braces) get confused for each other.
  let depth = 0;
  let i = parenIdx;
  for (; i < shadow.length; i++) {
    const ch = shadow[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  // i now sits just past the parameter list's closing `)`. Whatever follows (return-type
  // annotation, then `{`) is the function body's opening brace — the first `{` from here.
  const bodyOpenIdx = shadow.indexOf('{', i);
  if (bodyOpenIdx === -1) return undefined;
  depth = 0;
  i = bodyOpenIdx;
  for (; i < shadow.length; i++) {
    if (shadow[i] === '{') depth++;
    else if (shadow[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(declMatch.index, i);
}

// ---------------------------------------------------------------------------
// Guard markers — one identifier per matrix column
// ---------------------------------------------------------------------------

/** A boolean-guard marker: the guard is "present" iff this pattern appears in the lane span. */
const BOOLEAN_MARKERS: Record<Exclude<GuardId, EnumGuardId>, RegExp> = {
  touchesOverstep: /checkTouchesOverstep\s*\(/,
  spineCheck: /checkSpine\s*\(/,
  judge: /\brunJudge\s*\(/,
  scout: /buildScoutPrompt\s*\(/,
  push: /spawnSync\(\s*['"]git['"]\s*,\s*\[\s*['"]push['"]/,
  alreadyShippedCommit: /alreadyShippedCommit\s*\(/,
  denialNote: /\bdenialNote\b/,
};

/**
 * ADR-010 stage 2: a lane running through the shared `runPostBuildGuards` pipeline no longer
 * calls `checkTouchesOverstep`/`checkSpine`/`runJudge` directly in its own span — those live
 * inside the pipeline function, invoked only when the lane's OWN config literal turns them on.
 * For these three guards, a `<key>: false` in the lane's `PostBuildGuardConfig` literal is an
 * explicit, unambiguous "off" (checked FIRST, so it wins over the direct-call fallback below —
 * a lane could theoretically still have a stray direct call in scope while declaring the guard
 * off, and the declared config is the one that actually executes); any other value for that key
 * (a literal `true`, or a conditional expression such as `!plan.target`) counts as "present" —
 * the guard fires under at least some condition. Declared literals win over the BOOLEAN_MARKERS
 * direct-call fallback (which stays live for a lane that hasn't migrated, e.g. the batch lane).
 */
const CONFIG_KEY_FOR_GUARD: Partial<Record<Exclude<GuardId, EnumGuardId>, string>> = {
  touchesOverstep: 'touchesOverstep',
  spineCheck: 'spineCheck',
  judge: 'judge',
};

function detectDeclaredGuard(span: string, key: string): boolean | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}]+)`);
  const m = re.exec(span);
  if (!m) return undefined;
  const value = m[1]!.trim();
  return value !== 'false';
}

/**
 * Which gate wrapper a span calls: the lane-aware dispatcher, the shared plain one, or a fork
 * local to the lane's own file.
 *
 * "Local fork" is decided by whether the lane's FILE defines the function itself versus importing
 * it — never by which file we happen to be looking at. An earlier version keyed this off the
 * lane's identity ("is this the conductor"), which stayed true only until that lane's forked
 * helpers were deleted and it began calling the beat's exported `runGate`: the cell then read
 * "local fork" for a call that had just been de-duplicated, i.e. it reported the opposite of what
 * had been fixed. A cell that lies is worse than a missing cell, so the signal has to come from
 * the source, not the filename.
 *
 * ADR-010 stage 2: a lane that runs its gate through the shared `runPostBuildGuards` pipeline
 * (`beats/dispatch.ts`) no longer calls `runGate`/`runLaneGate` directly in its OWN span — the
 * call lives inside the pipeline function instead, and the lane merely DECLARES which wrapper it
 * wants via a `gateWrapper: 'runGate' | 'runLaneGate'` config literal passed to it. Prefer that
 * DECLARED value (same "declared beats inferred" rule {@link detectCommitSide} already uses for
 * commit contracts) over the direct-call markers, which remain the fallback for a lane that still
 * calls the wrapper itself (the batch lane, pre-migration to the shared pipeline).
 */
function detectGateWrapper(span: string, fileSource: string): string {
  const declaredMatch = /gateWrapper\s*:\s*'(runGate|runLaneGate)'/.exec(span);
  if (declaredMatch) return `${declaredMatch[1]} (declared)`;

  // A FORK is a gate helper a lane's own file defines when the canonical implementation lives
  // elsewhere — i.e. defined here AND imported nowhere. dispatch.ts is the canonical home of
  // runGate/runLaneGate, so its own definitions are not forks; annotating them as such is how an
  // earlier version of this column labelled `runGate`'s own home a fork of itself.
  const isCanonicalHome = /^\s*export\s+(?:async\s+)?function\s+runGate\b/m.test(fileSource)
    || /^\s*export\s+(?:async\s+)?function\s+runLaneGate\b/m.test(fileSource);
  const definedLocally = (name: string): boolean =>
    new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(fileSource);
  const label = (name: string): string =>
    !isCanonicalHome && definedLocally(name) ? `${name} (local fork)` : name;

  if (/\brunLaneGate\s*\(/.test(span)) return label('runLaneGate');
  if (/\brunClusterGate\s*\(/.test(span)) return label('runClusterGate');
  if (/\brunGate\s*\(/.test(span)) return label('runGate');
  return 'none';
}

/**
 * Who holds the commit: the spawned worker (granted a `git commit`-capable toolset — the
 * `BUILDER_TOOLS` family, NOT its `DISPATCH_BUILDER_TOOLS` subset which strips commit tools) or
 * dispatch itself (a scoped commit dispatch performs on the worker's behalf). Two call shapes
 * both count as "dispatch commits": the shared `attemptScopedCommit` helper (target lane) and
 * the batch lane's own inline `planScopedCommit` + `git commit` sequence (WI-161) — both stage
 * only in-scope files and run `git commit` from dispatch's own code, never the worker's tool
 * grant. A lane with NEITHER marker present has no code-diff commit step at all (planning).
 */
function detectCommitSide(span: string, fileSource: string): string {
  const hasSharedScopedCommit = /attemptScopedCommit\s*\(/.test(span);
  const hasInlineScopedCommit = /planScopedCommit\s*\(/.test(span)
    && /spawnSync\(\s*['"]git['"]\s*,\s*\[\s*['"]commit['"]/.test(span);
  const dispatchCommits = hasSharedScopedCommit || hasInlineScopedCommit;

  // Prefer the DECLARED contract over inferred tool literals. Since the commitMode slice, a lane
  // states its contract explicitly (`commitMode: 'worker' | 'dispatch'`, or a constant passed to
  // `toolsForCommitMode`), and reading that declaration is both more accurate and more durable
  // than grepping for a `BUILDER_TOOLS` identifier that de-duplication is actively removing.
  // (Detecting the literal is what made this column report "no code diff" for a lane the moment
  // its hand-picked toolset became `toolsForCommitMode(...)` — the column degraded precisely
  // because the code improved.) The literal markers remain as a fallback for lanes that have not
  // yet been migrated.
  const allDeclaredIn = (text: string): string[] => {
    const found = new Set<string>();
    for (const re of [/\bcommitMode\s*:\s*'(worker|dispatch)'/g, /CommitMode\s*=\s*'(worker|dispatch)'/g]) {
      for (const m of text.matchAll(re)) found.add(m[1]);
    }
    return [...found];
  };
  // Span first: a declaration inside the lane's own body is unambiguously that lane's contract.
  const inSpan = allDeclaredIn(span);
  if (inSpan.length === 1) return `${inSpan[0]} (declared)`;
  // File scope only when UNAMBIGUOUS. A single-lane file would declare its contract as a
  // module-scope constant, which we should read. A multi-lane file (dispatch.ts houses planning,
  // target and batch, plus both branches of toolsForCommitMode) contains every mode, so a
  // file-scope match says nothing about WHICH lane owns it — reading one anyway reported the
  // planning lane as 'worker' when it has no commit step at all. Ambiguous ⇒ fall through to the
  // marker-based inference below rather than guess.
  const inFile = allDeclaredIn(fileSource);
  const declared = inFile.length === 1 ? { 1: inFile[0] } as unknown as RegExpExecArray : null;
  if (declared) return `${inFile[0]} (declared)`;
  const grantsCommitTool = /(?<!DISPATCH_)\bBUILDER_TOOLS\b/.test(span);
  if (dispatchCommits && !grantsCommitTool) return 'dispatch';
  if (grantsCommitTool && !dispatchCommits) return 'worker';
  if (dispatchCommits && grantsCommitTool) return 'worker+dispatch-fallback';
  return 'n/a (no code diff)';
}

/**
 * Claim-before-pick (ADR-007): does this lane RESERVE the item it is about to build, and does it
 * yield the ones a foreign holder took? Added for WI-184 — `limitations.md` names this as one of
 * the two invariants that genuinely differ between lanes, and the matrix could not see it.
 *
 * WI-186 (post-hoc revision): the reservation terminal was extracted into a factory,
 * `makeClaimBeforePick`, whose closure `claimBeforePick(candidateIds)` both picking lanes now
 * call. `decideClaimArbitration(` and the `'item.claimed'` append moved INSIDE the factory body
 * — a function distinct from `runDispatch` — so a span-only read of `runDispatch` no longer sees
 * either marker, and `finalizeTargetBuild`/`runTargetLane` never contained them to begin with.
 * The naive fix (matching `claimBeforePick(` as a new alias for `decideClaimArbitration(`) was
 * rejected: it would report the SAME cell for both call sites even though only one of them is in
 * a given lane's own span, silently erasing the distinction this column exists to draw.
 *
 * The honest fix has three parts (the third found by this fix's OWN bite-proof — see below):
 *
 *  1. `runDispatch` (batch's span) still calls `claimBeforePick(groups...)` as REAL code — the
 *     factory-vs-inline split is a refactor of WHERE the arbitration logic lives, not whether the
 *     batch lane calls it. `claimBeforePick(` naming the batch lane's own `groups`-derived
 *     candidate list is treated as equivalent evidence to the old inline markers.
 *  2. `finalizeTargetBuild`/`runTargetLane`'s span structurally CANNOT see the target lane's own
 *     reservation — it happens at the `claimBeforePick(targetedQueued...)` call site inside
 *     `runDispatch`, i.e. inside a DIFFERENT function than the target lane's own entry points.
 *     Reporting `none` here would be exactly the "reports the right answer for the wrong reason"
 *     failure inverted into its opposite: a column that goes on saying "no reservation" after the
 *     reservation shipped is a lie by omission, and WI-186's whole purpose was closing this gap.
 *     So this function accepts an OPTIONAL second span — `runDispatch`'s own source — and, for a
 *     lane whose own span has no reservation marker, greps that shared span for a
 *     `claimBeforePick(<lane's own queue variable>` call site keyed by an explicit, per-lane
 *     candidate-variable allowlist (never a generic "any call counts" scan, which could not tell
 *     target's call site from batch's). Finding one reports a DISTINCT cell —
 *     `claim (shared pick, via batch)` — that names both facts at once: reserved, and NOT in this
 *     lane's own code. Rounding it to `arbitrate+claim` would hide that the property no longer
 *     lives where the lane's own span says it does; `none` would hide that it happens at all.
 *  3. Neither (1) nor (2) is sufficient alone: both key off the NAME `claimBeforePick`, which is
 *     just an identifier — it says nothing about whether the factory that produced it still does
 *     the reservation. The bite-proof for this fix caught exactly that hole: deleting the real
 *     `item.claimed` append from inside `makeClaimBeforePick`'s own body, while leaving both call
 *     sites untouched, left every cell reporting reserved. A column that reports "reserved"
 *     because a function is still NAMED claimBeforePick, independent of what that function's body
 *     still does, is the same class of lie stripComments exists to prevent for a guard NAME in a
 *     comment — just one hop further away. So a THIRD optional span is threaded in —
 *     `makeClaimBeforePick`'s own body — and `claimBeforePick(` naming a lane's candidate list
 *     (in-span or cross-span) counts only when that factory span still contains the real
 *     `decideClaimArbitration(` + `'item.claimed'` markers. No factory span supplied (a caller
 *     that only wants the old inline behaviour, e.g. a unit test) falls back to treating any
 *     `claimBeforePick(` name-match as sufficient, matching the pre-fix behaviour for isolated
 *     fixtures that never define the factory at all.
 *
 * The ladder for a lane's OWN span, strongest first (comments stripped before matching, config
 * literals never count):
 *
 *  - `arbitrate+claim` — the lane's own span runs the inline arbitration
 *    (`decideClaimArbitration`) AND appends its own `item.claimed` in the same locked pass, OR
 *    calls the shared closure (`claimBeforePick`) against ITS OWN candidate list (WI-186 shape).
 *  - `claim (claimItems)` — the lane reserves through the SHARED session verb `claimItems`,
 *    which re-folds under the ledger lock and skips anything another session actively holds
 *    (`session.ts`). Deliberately a DIFFERENT cell from `arbitrate+claim`, not a weaker synonym:
 *    both yield to a foreign claim, but only the inline/closure path additionally yields to a
 *    foreign in-flight BUILD (a recent `build.dispatched` carrying no claim — WI-074). Reading
 *    these two as equal is the misreading this column exists to prevent.
 *  - `arbitrate (no claim)` / `claim (inline)` — the two half-ported shapes. Neither exists today;
 *    they are here so a partial port renders as what it is instead of being rounded to a
 *    neighbouring cell.
 *  - `claim (shared pick, via batch)` — see point 2 above: reserved by a call site OUTSIDE this
 *    lane's own span, inside the shared `runDispatch` function.
 *  - `defer-read` — the lane only READS claim state (`isClaimActive`) to skip claimed items. A
 *    read, not a reservation: it cannot close the read-to-spawn race.
 *  - `none` — the lane neither reserves (in its own span or via the shared pick site) nor reads.
 */
const CLAIM_BEFORE_PICK_CANDIDATE_VAR: Partial<Record<LaneId, string>> = {
  // The literal candidate-list expression at each call site (dispatch.ts:3428 / :3481) — an
  // explicit per-lane allowlist, not a generic "claimBeforePick( appears somewhere" scan, so a
  // future third call site cannot silently get attributed to the wrong lane.
  target: 'targetedQueued',
  batch: 'groups',
};

/**
 * Does the factory that PRODUCES the `claimBeforePick` closure still actually reserve anything?
 * A `claimBeforePick(` call site is just a name — it proves a lane invokes SOMETHING by that
 * name, not that the something still does the reservation. `factorySpan` is
 * `makeClaimBeforePick`'s own body; undefined means the caller never supplied one (isolated unit
 * fixtures that hand-roll a `claimBeforePick(` call without defining the factory at all still get
 * the pre-fix, name-only behaviour — see the doc comment above).
 */
function factoryStillReserves(factorySpan: string | undefined): boolean {
  if (factorySpan === undefined) return true;
  return /\bdecideClaimArbitration\s*\(/.test(factorySpan) && /['"]item\.claimed['"]/.test(factorySpan);
}

function detectClaimArbitration(
  span: string,
  lane: LaneId,
  sharedPickSpan?: string,
  factorySpan?: string,
): string {
  const arbitrates = /\bdecideClaimArbitration\s*\(/.test(span);
  // Naming the `item.claimed` event type in real (non-comment) code is how a lane appends a
  // reservation — the string literal is the event type passed to `makeEvent`. String literals
  // survive `stripComments`, so this fires on the append and not on prose about it.
  const claimsInline = /['"]item\.claimed['"]/.test(span);
  const factoryOk = factoryStillReserves(factorySpan);
  // WI-186: the shared closure, called against THIS lane's own candidate list, from THIS lane's
  // own span — e.g. the engineering lane calling `claimBeforePick(groups...)` inside its own
  // `runDispatch` body. Distinct from the cross-span case below (a lane whose span does not
  // contain the call at all). Gated on `factoryOk`: the call site's NAME survives a deletion of
  // the factory's actual reservation write, so the name alone is not sufficient evidence — see
  // `factoryStillReserves`'s doc comment (found by this column's own bite-proof).
  const candidateVar = CLAIM_BEFORE_PICK_CANDIDATE_VAR[lane];
  const closureCallRe = candidateVar
    ? new RegExp(`\\bclaimBeforePick\\s*\\(\\s*${candidateVar}\\b`)
    : undefined;
  const claimsViaClosureInOwnSpan = closureCallRe ? closureCallRe.test(span) && factoryOk : false;
  const claimsViaVerb = /\bclaimItems\s*\(/.test(span);
  const readsClaims = /\bisClaimActive\s*\(/.test(span);

  if (arbitrates && claimsInline) return 'arbitrate+claim';
  if (claimsViaClosureInOwnSpan) return 'arbitrate+claim';
  if (claimsViaVerb) return 'claim (claimItems)';
  if (arbitrates) return 'arbitrate (no claim)';
  if (claimsInline) return 'claim (inline)';

  // Cross-span attribution: this lane's OWN span has no reservation marker, but its candidate
  // list is reserved by name at a `claimBeforePick(` call site living in the shared span
  // (runDispatch) — gated on `factoryOk` for the same reason as the in-span case above. Checked
  // only after every in-span rung has failed, so a lane that reserves itself is never overridden
  // by a stale/unrelated shared-span match.
  if (sharedPickSpan && candidateVar && factoryOk) {
    const crossSpanRe = new RegExp(`\\bclaimBeforePick\\s*\\(\\s*${candidateVar}\\b`);
    if (crossSpanRe.test(sharedPickSpan)) return 'claim (shared pick, via batch)';
  }

  if (readsClaims) return 'defer-read';
  return 'none';
}

/**
 * Post-integration re-gate: before merging, does the lane replay its branch onto a merge
 * destination that MOVED during the build and re-run the gate over the combined state? The
 * invariant (engineering lane, `dispatch.ts`): nothing reaches the destination without a gate
 * covering every commit landed since the branch point.
 *
 * Detected structurally, in two parts with ORDER enforced (the gate marker must appear at a
 * later offset in the span than the replay marker — textual order is execution order in these
 * lanes' straight-line terminals). A lane that merely rebases somewhere, or merely gates, does
 * not qualify; only "replay, THEN gate again" does:
 *
 *  - replay = `git rebase` ONTO A REF, or the push-race variant (`git reset` to the
 *    freshly-fetched tip followed by a `git merge` of the branch). Both are the same invariant
 *    with different mechanics, and both are matched so a lane that ports only the second one is
 *    not reported as lacking the invariant it has.
 *    "Onto a ref" is load-bearing, not pedantry: the batch lane's conflict handler calls
 *    `git rebase --abort`, which a bare `['rebase'` marker happily matched — so deleting the
 *    real replay left the cleanup call behind and the cell went on reporting `re-gate` for a
 *    lane that no longer re-gated (found by mutation-testing this column, WI-184). The next
 *    argument must therefore NOT be a `--flag`; `--abort`/`--continue`/`--skip` are rebase
 *    bookkeeping, never an integration replay.
 *  - re-gate = any gate-running call (`runLaneGate` / `runGate` / `runClusterGate` /
 *    `runPostBuildGuards`) after that point.
 *
 * Cells: `re-gate` (replay + gate), `gate-once` (the lane merges — `closeMergedCluster` or an
 * inline `git merge` — having gated only on its own untouched branch), `n/a (no merge)` (no
 * merge step at all, i.e. the planning lane, which only queues child items).
 */
function detectPostIntegrationRegate(span: string): string {
  // The negative lookahead sits DIRECTLY after the comma and swallows the whitespace itself.
  // Written as `\s*,\s*(?!['"]--)` it is defeated by backtracking (the trailing `\s*` matches
  // zero characters, the lookahead then inspects a space instead of the quote, and `--abort`
  // sails through) — a hole this probe's own mutation test caught.
  const rebase = /spawnSync\(\s*['"]git['"]\s*,\s*\[\s*['"]rebase['"]\s*,(?!\s*['"]--)/.exec(span);
  const reset = /spawnSync\(\s*['"]git['"]\s*,\s*\[\s*['"]reset['"]/.exec(span);
  const mergeSpawn = /spawnSync\(\s*['"]git['"]\s*,\s*\[\s*['"]merge['"]/;
  const gateCall = /\b(?:runLaneGate|runClusterGate|runPostBuildGuards|runGate)\s*\(/;

  const replayOffsets: number[] = [];
  if (rebase) replayOffsets.push(rebase.index);
  // A bare `git reset` is not an integration replay (a lane may reset for cleanup); it counts
  // only when a `git merge` of the branch follows it — the push-race recovery shape.
  if (reset && mergeSpawn.test(span.slice(reset.index))) replayOffsets.push(reset.index);

  if (replayOffsets.length > 0) {
    const from = Math.min(...replayOffsets);
    if (gateCall.test(span.slice(from))) return 're-gate';
  }
  const merges = /\bcloseMergedCluster\s*\(/.test(span) || mergeSpawn.test(span);
  return merges ? 'gate-once' : 'n/a (no merge)';
}

// ---------------------------------------------------------------------------
// Per-lane extraction
// ---------------------------------------------------------------------------

interface LaneSpanSpec {
  lane: LaneId;
  file: keyof typeof LANE_SOURCE_FILES;
  /** Function name(s) whose spans are concatenated to form "the lane's code". */
  functionNames: string[];
}

const LANE_SPANS: LaneSpanSpec[] = [
  { lane: 'planning', file: 'dispatch', functionNames: ['runPlanningLane'] },
  { lane: 'target', file: 'dispatch', functionNames: ['finalizeTargetBuild', 'runTargetLane'] },
  { lane: 'batch', file: 'dispatch', functionNames: ['runDispatch'] },
];

function extractNamedSpan(src: string, functionName: string, forLane: LaneId, fileKey: string): string {
  const span = extractFunctionSpan(src, functionName);
  if (span === undefined) {
    throw new Error(
      `lane-matrix: could not locate function '${functionName}' in ${fileKey} for lane '${forLane}'. ` +
      `Either the function was renamed/removed (update LANE_SPANS in lane-matrix.ts to match) or the ` +
      `file's shape changed enough that brace-matching failed — investigate before trusting any matrix output.`,
    );
  }
  return span;
}

/**
 * `runDispatch`'s own span, comments-stripped — the ONE place both `claimBeforePick(` call sites
 * live post-WI-186 (dispatch.ts:3428 for the target lane's queue, :3481 for the batch lane's).
 * Computed once and passed into every `buildRow` call so a lane whose own span cannot see its
 * reservation (the target lane) can still be attributed correctly — see `detectClaimArbitration`'s
 * doc comment for why span-only attribution is wrong here specifically.
 */
function findSharedPickSpan(sources: Record<keyof typeof LANE_SOURCE_FILES, string>): string {
  const span = extractNamedSpan(sources.dispatch, 'runDispatch', 'batch', LANE_SOURCE_FILES.dispatch);
  return stripComments(span);
}

/**
 * `makeClaimBeforePick`'s own body, comments-stripped — where the REAL reservation write
 * (`decideClaimArbitration` + the `item.claimed` append) lives post-WI-186. Optional: a factory
 * by this name is not guaranteed to exist (a lane could still ship the pre-WI-186 inline shape,
 * or a test fixture may hand-roll a bare `claimBeforePick(` call without ever defining the
 * factory) — `undefined` signals "no factory to check", not "the factory is empty", and
 * `factoryStillReserves` treats the two differently. See that function's doc comment.
 */
function findClaimFactorySpan(sources: Record<keyof typeof LANE_SOURCE_FILES, string>): string | undefined {
  const span = extractFunctionSpan(sources.dispatch, 'makeClaimBeforePick');
  return span === undefined ? undefined : stripComments(span);
}

function buildRow(
  spec: LaneSpanSpec,
  sources: Record<keyof typeof LANE_SOURCE_FILES, string>,
  sharedPickSpan: string,
  factorySpan: string | undefined,
): LaneRow {
  const src = sources[spec.file];
  const spans = spec.functionNames.map(name => extractNamedSpan(src, name, spec.lane, LANE_SOURCE_FILES[spec.file]));
  // Comments-only stripped (string literals preserved — several markers depend on a literal
  // argument, e.g. `'push'`) so a marker can only fire on REAL code, never on prose that merely
  // names a guard (comments in this codebase narrate guard behaviour constantly).
  const combined = stripComments(spans.join('\n'));

  const cells = {} as Record<GuardId, Cell>;
  for (const id of Object.keys(BOOLEAN_MARKERS) as (keyof typeof BOOLEAN_MARKERS)[]) {
    const configKey = CONFIG_KEY_FOR_GUARD[id];
    const declared = configKey ? detectDeclaredGuard(combined, configKey) : undefined;
    cells[id] = declared !== undefined ? declared : BOOLEAN_MARKERS[id].test(combined);
  }
  // Whole-file source (comments stripped) so "local fork" is decided by whether this lane's file
  // DEFINES the gate helper or imports it — see detectGateWrapper.
  cells.gateWrapper = detectGateWrapper(combined, stripComments(src));
  cells.commitSide = detectCommitSide(combined, stripComments(src));
  // Span-only for every OTHER column (no file-scope fallback): both are properties of what THIS
  // lane's terminal does, and dispatch.ts houses three lanes — a file-scope read would attribute
  // the engineering lane's re-gate to the planning and target lanes that sit beside it.
  // claimArbitration is the deliberate, documented exception: it also takes the shared
  // `runDispatch` span, because WI-186 moved the target lane's reservation there — see
  // detectClaimArbitration's doc comment.
  cells.claimArbitration = detectClaimArbitration(combined, spec.lane, sharedPickSpan, factorySpan);
  cells.postIntegrationRegate = detectPostIntegrationRegate(combined);

  return { lane: spec.lane, functionNames: spec.functionNames, cells };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Build the matrix from the real files on disk (production use / doc generation). */
export function buildLaneMatrix(): LaneMatrix {
  const sources = {
    dispatch: readFileSync(LANE_SOURCE_FILES.dispatch, 'utf8'),
  };
  return buildLaneMatrixFromSources(sources);
}

/** Build the matrix from supplied source text (test injection — no disk dependency). */
export function buildLaneMatrixFromSources(sources: Record<keyof typeof LANE_SOURCE_FILES, string>): LaneMatrix {
  const sharedPickSpan = findSharedPickSpan(sources);
  const factorySpan = findClaimFactorySpan(sources);
  const rows = LANE_SPANS.map(spec => buildRow(spec, sources, sharedPickSpan, factorySpan));
  return {
    rows,
    generatedNote: 'GENERATED by packages/core/src/lane-matrix.ts — do not hand-edit; regenerate via `node dist/render-lane-matrix.js` or `npm run lane-matrix` (see docs/lane-matrix.md).',
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function cellText(c: Cell): string {
  if (typeof c === 'boolean') return c ? 'yes' : 'no';
  return c;
}

const GUARD_LABELS: Record<GuardId, string> = {
  touchesOverstep: 'Touches-overstep',
  spineCheck: 'spine check',
  judge: 'judge',
  scout: 'scout',
  push: 'git push',
  alreadyShippedCommit: 'alreadyShippedCommit',
  denialNote: 'denialNote',
  gateWrapper: 'gate wrapper',
  commitSide: 'commit side',
  claimArbitration: 'claim arbitration',
  postIntegrationRegate: 'post-integration re-gate',
};

export function renderLaneMatrixMarkdown(matrix: LaneMatrix): string {
  const header = ['lane', ...GUARD_IDS.map(g => GUARD_LABELS[g])];
  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  for (const row of matrix.rows) {
    const cells = [row.lane, ...GUARD_IDS.map(g => cellText(row.cells[g]))];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}
