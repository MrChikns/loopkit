/**
 * lane-matrix.test.ts — the CI tripwire for ADR-010 point 6 (`docs/decisions/ADR-010-one-lane.md`).
 *
 * The matrix itself is DERIVED from `dispatch.ts`/`conductor.ts` source (see lane-matrix.ts's
 * own doc comment for why: a runtime registry would require editing the two files a sibling
 * agent owns mid-refactor; a hand-declared table just moves the same staleness risk one file
 * over). This test pins today's derived matrix as an explicit snapshot. It is deliberately
 * NOT a loose "still compiles" check — a lane silently losing (or gaining) a guard changes a
 * cell, and this test fails with a message naming exactly which lane/guard moved and telling
 * the reader to update the snapshot DELIBERATELY (i.e. only after confirming the change is
 * intended), never to just re-run and accept whatever comes out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLaneMatrix,
  buildLaneMatrixFromSources,
  extractFunctionSpan,
  stripComments,
  stripCommentsAndStrings,
  renderLaneMatrixMarkdown,
  LANE_IDS,
  GUARD_IDS,
  LaneMatrix,
} from '../src/lane-matrix.js';

// ---------------------------------------------------------------------------
// The pinned snapshot — the CI tripwire.
// ---------------------------------------------------------------------------

/**
 * Today's known-correct matrix, verified by direct source reading against
 * `packages/core/src/beats/dispatch.ts` / `conductor.ts` at the time this test was written
 * (ADR-010's own table, cross-checked cell by cell). If a lane's guard set changes on purpose,
 * update THIS object to match — never loosen the assertion below into a no-op.
 *
 * ADR-010 stage 2 (guard unification): target and conductor now run their post-build checks
 * through the shared `runPostBuildGuards` pipeline (beats/dispatch.ts), configured per lane —
 * see that function's own doc comment. Touches-overstep and judge are NEWLY TRUE for both
 * lanes (previously false — neither lane had any boundary/quality guard at all); spine stays
 * false for target (a target repo has no plane-spine concept — see finalizeTargetBuild's own
 * comment) and is now CONDITIONALLY true for conductor (`!plan.target` — on for the plane's own
 * repo, off for a target cluster) — the generator reports a config key present with any
 * non-`false` value (including a conditional expression) as `true`, matching "the guard fires
 * under at least some real condition". gateWrapper now reads `'<name> (declared)'` for both
 * migrated lanes: the call to runGate/runLaneGate lives inside the shared pipeline function, not
 * the lane's own span, so the generator reads the lane's DECLARED `gateWrapper` config literal
 * instead of a direct-call marker (see detectGateWrapper's doc comment) — this is not a
 * regression, it is the intended shape once a lane delegates its gate-running to one place.
 */
const EXPECTED_SNAPSHOT: Record<string, Record<string, boolean | string>> = {
  planning: {
    touchesOverstep: false, spineCheck: false, judge: false, scout: false, push: false,
    alreadyShippedCommit: false, denialNote: false,
    gateWrapper: 'none', commitSide: 'n/a (no code diff)',
  },
  target: {
    touchesOverstep: true, spineCheck: false, judge: true, scout: false, push: false,
    alreadyShippedCommit: false, denialNote: false,
    gateWrapper: 'runGate (declared)', commitSide: 'dispatch (declared)',
  },
  batch: {
    touchesOverstep: true, spineCheck: true, judge: true, scout: true, push: true,
    alreadyShippedCommit: true, denialNote: true,
    gateWrapper: 'runLaneGate', commitSide: 'dispatch (declared)',
  },
  conductor: {
    touchesOverstep: true, spineCheck: true, judge: true, scout: false, push: false,
    alreadyShippedCommit: false, denialNote: false,
    gateWrapper: 'runGate (declared)', commitSide: 'worker (declared)',
  },
};

function describeMatrix(matrix: LaneMatrix): string {
  return matrix.rows.map(r => `  ${r.lane}: ${JSON.stringify(r.cells)}`).join('\n');
}

test('lane matrix: matches the pinned snapshot exactly — a diff here means a lane changed its guard set', () => {
  const matrix = buildLaneMatrix();
  const drift: string[] = [];
  for (const row of matrix.rows) {
    const expected = EXPECTED_SNAPSHOT[row.lane];
    for (const guard of GUARD_IDS) {
      const actual = row.cells[guard];
      const want = expected[guard];
      if (actual !== want) {
        drift.push(`  lane '${row.lane}' guard '${guard}': expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
      }
    }
  }
  assert.equal(
    drift.length, 0,
    `\nLane × guard matrix drifted from the pinned snapshot (ADR-010 point 6 tripwire):\n${drift.join('\n')}\n\n` +
    `This means a lane (dispatch.ts / conductor.ts) silently gained or lost a guard/property.\n` +
    `If this is INTENTIONAL (e.g. a lane just picked up Touches-overstep or a judge stage), update\n` +
    `EXPECTED_SNAPSHOT in packages/core/test/lane-matrix.test.ts to match — deliberately, cell by\n` +
    `cell, not by copy-pasting the new output wholesale. If it is NOT intentional, the lane just\n` +
    `regressed a guard silently — this is exactly the class of defect ADR-010 was written for.\n\n` +
    `Current full matrix:\n${describeMatrix(matrix)}\n`,
  );
});

test('lane matrix: every declared lane produces a row, no silent gaps', () => {
  const matrix = buildLaneMatrix();
  const lanes = matrix.rows.map(r => r.lane).sort();
  assert.deepEqual(lanes, [...LANE_IDS].sort());
});

test('lane matrix: markdown rendering contains every lane and every guard column', () => {
  const matrix = buildLaneMatrix();
  const md = renderLaneMatrixMarkdown(matrix);
  for (const lane of LANE_IDS) assert.ok(md.includes(lane), `rendering missing lane '${lane}'`);
  assert.ok(md.includes('Touches-overstep'));
  assert.ok(md.includes('gate wrapper'));
  assert.ok(md.includes('commit side'));
});

// ---------------------------------------------------------------------------
// Unit coverage for the extraction primitives — these are what make the tripwire trustworthy.
// ---------------------------------------------------------------------------

test('extractFunctionSpan: finds a function whose parameter list itself contains braces (object-typed param)', () => {
  const src = `
function noise() { return 1; }
async function targetFn(
  opts: Options,
  ctx: { gitRoot: string; nested: { deep: string } },
): Promise<void> {
  doGuardThing();
}
function trailer() { return 2; }
`;
  const span = extractFunctionSpan(src, 'targetFn');
  assert.ok(span, 'expected a span to be found');
  assert.ok(span!.includes('doGuardThing()'), 'span should include the function body');
  assert.ok(!span!.includes('function trailer'), 'span must not swallow the next function');
  assert.ok(!span!.includes('function noise'), 'span must not include a preceding function');
});

test('extractFunctionSpan: is robust to a nested brace INSIDE the body (not just the param list)', () => {
  const src = `
export async function withNesting(x: number) {
  if (x > 0) {
    const obj = { a: { b: 1 } };
    return obj;
  }
  return null;
}
`;
  const span = extractFunctionSpan(src, 'withNesting');
  assert.ok(span);
  assert.ok(span!.includes('return null;'), 'span must extend to the REAL closing brace, not an inner one');
});

test('extractFunctionSpan: returns undefined for a function name that does not exist (fails loud, not silent)', () => {
  const src = `function realFn() { return 1; }`;
  assert.equal(extractFunctionSpan(src, 'doesNotExist'), undefined);
});

test('stripComments: blanks a // line comment and a /* block */ comment but preserves string literals', () => {
  const src = `const x = 'push'; // this line mentions BUILDER_TOOLS in prose\nconst y = /* BUILDER_TOOLS noise */ 2;`;
  const stripped = stripComments(src);
  assert.ok(stripped.includes(`'push'`), 'string literal content must survive comment stripping');
  assert.ok(!stripped.includes('BUILDER_TOOLS'), 'comment content must be blanked');
  assert.equal(stripped.length, src.length, 'stripComments must be length-preserving (offset safety)');
});

test('stripCommentsAndStrings: blanks both comments and string contents, staying length-preserving', () => {
  const src = `const s = "has a { brace"; // and a } here too\nconst n = 1;`;
  const stripped = stripCommentsAndStrings(src);
  assert.equal(stripped.length, src.length);
  assert.ok(!stripped.includes('brace'));
  assert.ok(!stripped.includes('here too'));
});

test('lane matrix: a marker mentioned only in a COMMENT must not flip a guard cell (false-positive guard)', () => {
  // Regression coverage for the exact class of bug caught while building this generator: WI-166's
  // own commentary narrates `BUILDER_TOOLS` and `attemptScopedCommit` in prose near the batch
  // lane's INLINE commit block, which must not be confused for the lane actually calling them.
  const dispatchSrc = `
export async function runDispatch(opts: unknown): Promise<void> {
  // commentary mentioning BUILDER_TOOLS and attemptScopedCommit and runJudge and checkSpine
  // and checkTouchesOverstep and alreadyShippedCommit and buildScoutPrompt in prose only.
  const denialNoteLookingIdentifierButNotReal = 'denialNote appears only as a string here';
  doRealWork();
}
async function runPlanningLane(): Promise<void> { noop(); }
async function finalizeTargetBuild(): Promise<void> { noop(); }
async function runTargetLane(): Promise<void> { noop(); }
`;
  const conductorSrc = `
export async function runConduct(): Promise<void> { noop(); }
async function runCluster(): Promise<void> { noop(); }
`;
  const matrix = buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc });
  const batch = matrix.rows.find(r => r.lane === 'batch')!;
  for (const guard of ['touchesOverstep', 'spineCheck', 'judge', 'scout', 'alreadyShippedCommit'] as const) {
    assert.equal(batch.cells[guard], false, `guard '${guard}' must not fire from prose-only comment mentions`);
  }
  assert.equal(batch.cells.gateWrapper, 'none');
  assert.equal(batch.cells.commitSide, 'n/a (no code diff)');
});

test('lane matrix: a lane that genuinely calls a guard reports it present, from injected sources', () => {
  const dispatchSrc = `
async function runPlanningLane(): Promise<void> { noop(); }
async function finalizeTargetBuild(): Promise<void> { noop(); }
async function runTargetLane(): Promise<void> { noop(); }
export async function runDispatch(opts: unknown): Promise<void> {
  const overstep = checkTouchesOverstep(changedFiles, gt, approvedTouches);
  const spine = checkSpine(cfg.spineRegex, changedFiles);
  await runJudge(provider, model, prompt, timeout);
  buildScoutPrompt(id, spec, touches);
  spawnSync('git', ['push'], { cwd: opts.repoRoot });
  const shipped = alreadyShippedCommit(opts.repoRoot, id);
  let denialNote = '';
  runLaneGate(gateId, cfg, wtPath, false, base, changedFiles);
}
`;
  const conductorSrc = `
export async function runConduct(): Promise<void> { noop(); }
async function runCluster(): Promise<void> { noop(); }
`;
  const matrix = buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc });
  const batch = matrix.rows.find(r => r.lane === 'batch')!;
  for (const guard of ['touchesOverstep', 'spineCheck', 'judge', 'scout', 'push', 'alreadyShippedCommit', 'denialNote'] as const) {
    assert.equal(batch.cells[guard], true, `guard '${guard}' should be detected as present`);
  }
  assert.equal(batch.cells.gateWrapper, 'runLaneGate');
});

test('lane matrix: throws a clear error (not a silent wrong answer) when a named lane function cannot be found', () => {
  // Simulates the sibling's in-flight rename churn: if `runDispatch` (or any lane entry point)
  // is renamed and LANE_SPANS in lane-matrix.ts is not updated to match, the generator must fail
  // loudly rather than silently produce an empty/misleading row.
  const dispatchSrc = `async function runPlanningLane(): Promise<void> { noop(); }`;
  const conductorSrc = `export async function runConduct(): Promise<void> { noop(); }`;
  assert.throws(
    () => buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc }),
    /could not locate function 'finalizeTargetBuild'/,
  );
});
