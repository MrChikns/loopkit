/**
 * lane-matrix.ts — the lane × guard matrix, DERIVED from source, never hand-typed
 * (ADR-010 point 6: `docs/decisions/ADR-010-one-lane.md`).
 *
 * Why derived-from-source and not a runtime registry or a declared table:
 *
 *  - A runtime registry the lanes actually *consume* (guards as configured properties of one
 *    path) is the ADR-010 end state, but it requires editing `dispatch.ts`/`conductor.ts` to
 *    read from it — exactly the two files a sibling agent owns mid-refactor right now. Doing
 *    that here would either collide with that work or force touching frozen files. Deferred to
 *    the lane-as-parameter stage the ADR itself sequences last.
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
 * closing brace), never by line number — so this survives the sibling's in-flight edits to
 * `dispatch.ts` (introducing `commitMode`, consolidating commit paths). Within a lane's span we
 * grep for a fixed set of identifier markers, one per guard column. A marker is a real exported
 * or local identifier the lane would have to call/name to exercise that guard (e.g.
 * `checkTouchesOverstep(`, `runJudge(`, `denialNote`) — not free text, so a rename shows up as
 * the marker disappearing (fails safe: a lane that silently loses a guard call also loses the
 * marker, and the matrix records `false` for it).
 *
 * This module only READS `dispatch.ts` / `conductor.ts` as text. It imports nothing from them
 * and is never imported by them — safe to keep even if those files are mid-refactor or
 * temporarily uncompilable, and immune to identifier/type churn inside them.
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
  conductor: join(SRC_DIR, 'conductor.ts'),
} as const;

export type LaneId = 'planning' | 'target' | 'batch' | 'conductor';

export const LANE_IDS: LaneId[] = ['planning', 'target', 'batch', 'conductor'];

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
] as const;
export type GuardId = (typeof GUARD_IDS)[number];

/** Cell value for the boolean guard columns. `gateWrapper`/`commitSide` are enums instead. */
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
const BOOLEAN_MARKERS: Record<Exclude<GuardId, 'gateWrapper' | 'commitSide'>, RegExp> = {
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
const CONFIG_KEY_FOR_GUARD: Partial<Record<Exclude<GuardId, 'gateWrapper' | 'commitSide'>, string>> = {
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
 * it — never by which file we happen to be looking at. An earlier version keyed this off "is this
 * the conductor", which was true only until the conductor's forked helpers were deleted and it
 * began calling the beat's exported `runGate`: the cell then read "local fork" for a call that had
 * just been de-duplicated, i.e. it reported the opposite of what had been fixed. A cell that lies
 * is worse than a missing cell, so the signal has to come from the source, not the filename.
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
  // (Detecting the literal is what made this column report "no code diff" for the conductor the
  // moment its hand-picked toolset became `toolsForCommitMode(CONDUCT_COMMIT_MODE)` — the column
  // degraded precisely because the code improved.) The literal markers remain as a fallback for
  // lanes that have not yet been migrated.
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
  // File scope only when UNAMBIGUOUS. A single-lane file (conductor.ts) declares its contract as a
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
  { lane: 'conductor', file: 'conductor', functionNames: ['runConduct', 'runCluster'] },
];

function buildRow(spec: LaneSpanSpec, sources: Record<keyof typeof LANE_SOURCE_FILES, string>): LaneRow {
  const src = sources[spec.file];
  const spans = spec.functionNames.map(name => {
    const span = extractFunctionSpan(src, name);
    if (span === undefined) {
      throw new Error(
        `lane-matrix: could not locate function '${name}' in ${LANE_SOURCE_FILES[spec.file]} for lane '${spec.lane}'. ` +
        `Either the function was renamed/removed (update LANE_SPANS in lane-matrix.ts to match) or the ` +
        `file's shape changed enough that brace-matching failed — investigate before trusting any matrix output.`,
      );
    }
    return span;
  });
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

  return { lane: spec.lane, functionNames: spec.functionNames, cells };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Build the matrix from the real files on disk (production use / doc generation). */
export function buildLaneMatrix(): LaneMatrix {
  const sources = {
    dispatch: readFileSync(LANE_SOURCE_FILES.dispatch, 'utf8'),
    conductor: readFileSync(LANE_SOURCE_FILES.conductor, 'utf8'),
  };
  return buildLaneMatrixFromSources(sources);
}

/** Build the matrix from supplied source text (test injection — no disk dependency). */
export function buildLaneMatrixFromSources(sources: Record<keyof typeof LANE_SOURCE_FILES, string>): LaneMatrix {
  const rows = LANE_SPANS.map(spec => buildRow(spec, sources));
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
