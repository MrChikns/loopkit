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
 *
 * WI-184 (claimArbitration + postIntegrationRegate): the two invariants `limitations.md` says
 * actually differ between lanes, previously invisible here. Each cell below was read off the
 * source before the generator was run, not copied from its output:
 *   - batch `arbitrate+claim` — `decideClaimArbitration` + the `item.claimed` append inside
 *     runDispatch's locked pre-spawn pass; `re-gate` — `git rebase` onto the advanced tip
 *     followed by a second `runLaneGate` before the merge (plus the push-race repeat).
 *   - conductor `claim (claimItems)` — runConduct reserves via the shared session verb;
 *     `gate-once` — runCluster gates its branch then `closeMergedCluster`s it, no replay.
 *   - target `none` / `gate-once` — runTargetLane and finalizeTargetBuild contain no claim code
 *     at all (runDispatch's shared pick list defers on their behalf, but never reserves) and
 *     merge via `closeMergedCluster` straight after their single gate.
 *   - planning `none` / `n/a (no merge)` — queues child items; no claim, no git merge.
 * A change in ANY of these four cells is a real lane-invariant change (e.g. WI-186 porting
 * claim-before-pick to the target lane would flip target's claimArbitration) — update the cell
 * deliberately, never by pasting the regen.
 *
 * WI-186 (post-hoc revision of the above, same session): WI-186 shipped the exact change the
 * prior paragraph named as hypothetical — the target lane's TOCTOU gap is closed — but did it by
 * extracting BOTH lanes' reservation call into a shared factory closure (`makeClaimBeforePick`,
 * called once, producing `claimBeforePick`), rather than by giving the target lane its own inline
 * copy. Re-derived cell by cell against the new shape:
 *   - batch `arbitrate+claim` (UNCHANGED VALUE, different reason): `runDispatch`'s own span no
 *     longer contains `decideClaimArbitration`/`item.claimed` directly (they moved inside the
 *     factory body), but it DOES call `claimBeforePick(groups...)` — the shared closure, invoked
 *     against the batch lane's own candidate list, from the batch lane's own span. That is
 *     judged equivalent evidence to the old inline markers: WHERE the arbitration logic is
 *     defined changed; THAT the batch lane invokes it against its own picks did not.
 *   - target `claim (shared pick, via batch)` (WAS `none` — that was the false negative this
 *     entry repairs). `finalizeTargetBuild`/`runTargetLane` still contain no claim code — that
 *     part of the old comment remains true — but it was never the right test. The target lane's
 *     reservation happens at `claimBeforePick(targetedQueued...)`, a call site that lives inside
 *     `runDispatch` (dispatch.ts:3428), which is BATCH's span, not target's. Span-only attribution
 *     is structurally blind to this, so `detectClaimArbitration` now also greps `runDispatch`'s
 *     span for the target lane's own candidate-variable name (`targetedQueued`) as an explicit,
 *     per-lane exception — never a generic "any call to claimBeforePick counts for every lane"
 *     scan, which could not distinguish target's call site from batch's. Reporting `none` here
 *     would misrepresent the code exactly as badly as batch briefly reporting `defer-read` did:
 *     the reservation is real, WI-186's whole point was adding it, and the column exists to make
 *     it visible. The distinct cell value (not reused `arbitrate+claim`) is deliberate: it tells
 *     the reader BOTH that the item is reserved AND that the reservation is not in this lane's
 *     own code — collapsing that distinction would hide the very indirection a maintainer needs
 *     to know about when next touching either lane.
 *   - conductor / planning: unaffected — WI-186 touched only the two dispatch.ts picking lanes.
 * A change to ANY of the four claimArbitration cells (or the detector's candidate-variable
 * allowlist) is a real lane-invariant change — update deliberately, cell by cell, never by
 * pasting the regen.
 */
const EXPECTED_SNAPSHOT: Record<string, Record<string, boolean | string>> = {
  planning: {
    touchesOverstep: false, spineCheck: false, judge: false, scout: false, push: false,
    alreadyShippedCommit: false, denialNote: false,
    gateWrapper: 'none', commitSide: 'n/a (no code diff)',
    claimArbitration: 'none', postIntegrationRegate: 'n/a (no merge)',
  },
  target: {
    touchesOverstep: true, spineCheck: false, judge: true, scout: false, push: false,
    alreadyShippedCommit: false, denialNote: false,
    gateWrapper: 'runGate (declared)', commitSide: 'dispatch (declared)',
    claimArbitration: 'claim (shared pick, via batch)', postIntegrationRegate: 'gate-once',
  },
  batch: {
    touchesOverstep: true, spineCheck: true, judge: true, scout: true, push: true,
    alreadyShippedCommit: true, denialNote: true,
    gateWrapper: 'runLaneGate', commitSide: 'dispatch (declared)',
    claimArbitration: 'arbitrate+claim', postIntegrationRegate: 're-gate',
  },
  conductor: {
    touchesOverstep: true, spineCheck: true, judge: true, scout: false, push: false,
    alreadyShippedCommit: false, denialNote: false,
    gateWrapper: 'runGate (declared)', commitSide: 'worker (declared)',
    claimArbitration: 'claim (claimItems)', postIntegrationRegate: 'gate-once',
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
  assert.ok(md.includes('claim arbitration'));
  assert.ok(md.includes('post-integration re-gate'));
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
  // Also narrating decideClaimArbitration, claimItems, an 'item.claimed' append and a
  // spawnSync('git', ['rebase', tip]) re-gate — all prose, none of it executed here.
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
  assert.equal(batch.cells.claimArbitration, 'none', 'claim arbitration must not fire from prose');
  assert.equal(batch.cells.postIntegrationRegate, 'n/a (no merge)', 're-gate must not fire from prose');
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
  const decided = decideClaimArbitration(candidateIds, freshResult, sessionId, nowMs, ttlMs);
  await tx.append([makeEvent('dispatch', d.item, 'item.claimed', { sessionId, ttlMinutes })]);
  spawnSync('git', ['rebase', headBefore], { cwd: w.wtPath, stdio: 'pipe' });
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
  assert.equal(batch.cells.claimArbitration, 'arbitrate+claim');
  assert.equal(batch.cells.postIntegrationRegate, 're-gate');
});

// ---------------------------------------------------------------------------
// WI-184 columns: claim arbitration + post-integration re-gate.
// These two are the invariants that actually differ between lanes (limitations.md), so their
// probes get explicit coverage of every rung — a cell that silently rounds one lane's shape to
// a neighbouring lane's would make the table lie exactly where it is trusted most.
// ---------------------------------------------------------------------------

/** Build a matrix from minimal lane stubs, overriding one lane's body. */
function matrixWithBodies(bodies: { batch?: string; target?: string; conduct?: string }): LaneMatrix {
  const dispatchSrc = `
async function runPlanningLane(): Promise<void> { noop(); }
async function finalizeTargetBuild(): Promise<void> { ${bodies.target ?? 'noop();'} }
async function runTargetLane(): Promise<void> { noop(); }
export async function runDispatch(opts: unknown): Promise<void> { ${bodies.batch ?? 'noop();'} }
`;
  const conductorSrc = `
export async function runConduct(): Promise<void> { ${bodies.conduct ?? 'noop();'} }
async function runCluster(): Promise<void> { noop(); }
`;
  return buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc });
}

function cellOf(matrix: LaneMatrix, lane: string, guard: 'claimArbitration' | 'postIntegrationRegate'): string {
  return String(matrix.rows.find(r => r.lane === lane)!.cells[guard]);
}

/**
 * Build a matrix from minimal lane stubs INCLUDING a `makeClaimBeforePick` factory definition,
 * for exercising `factoryStillReserves` (WI-186 repair): a real `dispatch.ts` post-WI-186 always
 * defines this factory, so its body is the thing that must actually contain the reservation
 * markers — a `claimBeforePick(` call site's NAME is not sufficient evidence on its own.
 */
function matrixWithFactory(bodies: { batch?: string; target?: string; factory?: string }): LaneMatrix {
  const dispatchSrc = `
function makeClaimBeforePick(ledgerDir: string, sessionId: string, ttl: number) {
  ${bodies.factory ?? `return async (candidateIds: string[]) => {
    const decided = decideClaimArbitration(candidateIds, freshResult, sessionId, Date.now(), ttl);
    const kept = decided.filter(d => d.keep);
    await tx.append([...kept.map(d => makeEvent('dispatch', d.item, 'item.claimed', { sessionId, ttl }))]);
    return decided;
  };`}
}
async function runPlanningLane(): Promise<void> { noop(); }
async function finalizeTargetBuild(): Promise<void> { ${bodies.target ?? 'noop();'} }
async function runTargetLane(): Promise<void> { noop(); }
export async function runDispatch(opts: unknown): Promise<void> {
  const claimBeforePick = makeClaimBeforePick(opts.ledgerDir, sessionId, ttl);
  ${bodies.batch ?? `const decisions = await claimBeforePick(groups.flatMap(g => g.map(r => r.id)));`}
}
`;
  const conductorSrc = `
export async function runConduct(): Promise<void> { noop(); }
async function runCluster(): Promise<void> { noop(); }
`;
  return buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc });
}

test('claim arbitration: the shared session verb reads as its own rung, not as inline arbitration', () => {
  // The conductor reserves via claimItems (which yields to a foreign CLAIM under the lock) but
  // has no inline arbitration (which additionally yields to a foreign in-flight BUILD). Rounding
  // these two together is the misreading the column exists to prevent.
  const m = matrixWithBodies({ conduct: `await claimItems(opts.ledgerDir, { sessionId, allQueued: true });` });
  assert.equal(cellOf(m, 'conductor', 'claimArbitration'), 'claim (claimItems)');
});

test('claim arbitration: reading claim state without reserving is defer-read, not a claim', () => {
  const m = matrixWithBodies({ batch: `const pick = recs.filter(r => !isClaimActive(r, sessions, Date.now()));` });
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'defer-read');
});

test('claim arbitration: a half-ported lane renders as half-ported (arbitrate without claim, claim without arbitration)', () => {
  const arbitrateOnly = matrixWithBodies({ batch: `const d = decideClaimArbitration(ids, fresh, sid, now, ttl);` });
  assert.equal(cellOf(arbitrateOnly, 'batch', 'claimArbitration'), 'arbitrate (no claim)');
  const claimOnly = matrixWithBodies({ batch: `await tx.append([makeEvent('dispatch', id, 'item.claimed', { sessionId })]);` });
  assert.equal(cellOf(claimOnly, 'batch', 'claimArbitration'), 'claim (inline)');
});

test('claim arbitration: a lane with genuinely no claim code anywhere (own span or shared pick) reads none', () => {
  // Neither the target lane's own span NOR the shared runDispatch span (default `noop();` here)
  // names targetedQueued at a claimBeforePick( call site — the true "gap" shape, pre-WI-186.
  const m = matrixWithBodies({ target: `const closed = closeMergedCluster(gitRoot, wtPath, branch, dest, msg);` });
  assert.equal(cellOf(m, 'target', 'claimArbitration'), 'none');
});

test('claim arbitration: WI-186 shape — target reserved by the shared closure in runDispatch, not its own span', () => {
  // The real dispatch.ts shape post-WI-186: the target lane's own functions contain no claim
  // code (mirrors the prior test's body), but runDispatch calls the shared closure against
  // targetedQueued — the target lane's own candidate-list variable, named at a real call site
  // living in a DIFFERENT function than the target lane's own span. This is the exact case the
  // coordinator flagged as a false negative (`none`) and the fix must report reserved-elsewhere.
  const m = matrixWithBodies({
    target: `const closed = closeMergedCluster(gitRoot, wtPath, branch, dest, msg);`,
    batch: `const decisions = await claimBeforePick(targetedQueued.map(r => r.id));
  const more = await claimBeforePick(groups.flatMap(g => g.map(r => r.id)));`,
  });
  assert.equal(cellOf(m, 'target', 'claimArbitration'), 'claim (shared pick, via batch)');
  // The SAME call site, read from batch's own span, is in-span evidence — batch is not
  // downgraded to the cross-span rung just because it shares the source with target's mention.
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'arbitrate+claim');
});

test('claim arbitration: a claimBeforePick( call for ONE lane must not bleed into the other lane\'s cell', () => {
  // Only the target lane's candidate variable appears at a real call site; batch's own span has
  // no reservation marker of any kind, in-span or shared, so it must read none — proves the
  // per-lane candidate-variable allowlist is doing real discrimination, not just "some call to
  // claimBeforePick exists somewhere in the file ⇒ every picking lane is claimed".
  const m = matrixWithBodies({
    batch: `const decisions = await claimBeforePick(targetedQueued.map(r => r.id));`,
  });
  assert.equal(cellOf(m, 'target', 'claimArbitration'), 'claim (shared pick, via batch)');
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'none');
});

test('claim arbitration: cross-span attribution never overrides a lane that already reserves in its own span', () => {
  // If a lane's OWN span already resolves to a rung (e.g. conductor's claimItems), a claim
  // mentioning that lane's name/variable elsewhere in the shared span must not overwrite it.
  // (conductor.ts is a separate source file from dispatch.ts, so this is belt-and-braces: the
  // shared-pick lookup only ever reads dispatch.ts's runDispatch, never conductor.ts — confirmed
  // by asserting the conductor cell is unaffected by a batch body that mentions its variable.)
  const m = matrixWithBodies({
    conduct: `await claimItems(opts.ledgerDir, { sessionId, allQueued: true });`,
    batch: `const decisions = await claimBeforePick(targetedQueued.map(r => r.id));`,
  });
  assert.equal(cellOf(m, 'conductor', 'claimArbitration'), 'claim (claimItems)');
});

// ---------------------------------------------------------------------------
// Factory integrity (WI-186 repair, found by this fix's OWN bite-proof): `claimBeforePick(` is
// just a NAME. A `makeClaimBeforePick` factory that still exists and is still called, but whose
// body no longer writes the reservation, must not report `arbitrate+claim` / `claim (shared
// pick, via batch)` for either lane — that is precisely the false-negative-turned-false-positive
// this repair closes.
// ---------------------------------------------------------------------------

test('claim arbitration: a real factory that still reserves reports normally (control case)', () => {
  const m = matrixWithFactory({});
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'arbitrate+claim');
  assert.equal(cellOf(m, 'target', 'claimArbitration'), 'none'); // default batch body only calls with groups
});

test('claim arbitration: BITE — deleting the item.claimed append from the factory body flips both lanes off', () => {
  // Mirrors the exact mutation applied to the real dispatch.ts during this fix's bite-proof:
  // the two call sites (`claimBeforePick(groups...)`, `claimBeforePick(targetedQueued...)`) are
  // left completely untouched; only the factory's own reservation write is removed. Before the
  // `factoryStillReserves` gate, this mutation was INVISIBLE to the column — both lanes still
  // reported reserved because the call sites still named `claimBeforePick`.
  const m = matrixWithFactory({
    factory: `return async (candidateIds: string[]) => {
    const decided = decideClaimArbitration(candidateIds, freshResult, sessionId, Date.now(), ttl);
    const kept = decided.filter(d => d.keep);
    // item.claimed append REMOVED — the reservation write is gone, the call sites are untouched.
    return decided;
  };`,
    batch: `const decisions = await claimBeforePick(targetedQueued.map(r => r.id));
  const more = await claimBeforePick(groups.flatMap(g => g.map(r => r.id)));`,
  });
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'none', 'batch must NOT read arbitrate+claim once the factory stops appending item.claimed');
  assert.equal(cellOf(m, 'target', 'claimArbitration'), 'none', 'target must NOT read claim (shared pick) once the factory stops appending item.claimed');
});

test('claim arbitration: BITE — deleting decideClaimArbitration from the factory body also flips both lanes off', () => {
  const m = matrixWithFactory({
    factory: `return async (candidateIds: string[]) => {
    // decideClaimArbitration REMOVED — the factory no longer arbitrates at all.
    const kept = candidateIds.map(id => ({ item: id, keep: true }));
    await tx.append([...kept.map(d => makeEvent('dispatch', d.item, 'item.claimed', { sessionId, ttl }))]);
    return kept;
  };`,
    batch: `const decisions = await claimBeforePick(targetedQueued.map(r => r.id));
  const more = await claimBeforePick(groups.flatMap(g => g.map(r => r.id)));`,
  });
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'none');
  assert.equal(cellOf(m, 'target', 'claimArbitration'), 'none');
});

test('claim arbitration: no makeClaimBeforePick factory defined at all falls back to name-only (isolated fixtures)', () => {
  // matrixWithBodies (used throughout this file for every OTHER claim-arbitration test) never
  // defines the factory — `factorySpan` is undefined, not empty — so `claimBeforePick(` naming a
  // lane's own candidate list is sufficient on its own, matching every existing assertion above.
  // This is the documented, deliberate fallback for a caller that doesn't model the factory.
  const m = matrixWithBodies({ batch: `const decisions = await claimBeforePick(groups.flatMap(g => g.map(r => r.id)));` });
  assert.equal(cellOf(m, 'batch', 'claimArbitration'), 'arbitrate+claim');
});

test('post-integration re-gate: a merge with no replay is gate-once, both merge shapes', () => {
  const helper = matrixWithBodies({ target: `const closed = closeMergedCluster(gitRoot, wtPath, branch, dest, msg);` });
  assert.equal(cellOf(helper, 'target', 'postIntegrationRegate'), 'gate-once');
  const inline = matrixWithBodies({ batch: `spawnSync('git', ['merge', '--no-ff', '-m', msg, branch], { cwd: root });` });
  assert.equal(cellOf(inline, 'batch', 'postIntegrationRegate'), 'gate-once');
});

test('post-integration re-gate: ORDER is enforced — a gate BEFORE the replay does not count as a re-gate', () => {
  // The invariant is "replay onto the moved destination, THEN gate the combined state". A lane
  // that gates first and rebases afterwards has not re-verified anything; reporting it as
  // re-gated would be precisely the kind of authoritative-but-wrong cell this table must not have.
  const gateThenRebase = matrixWithBodies({
    batch: `runLaneGate(gateId, cfg, wt, false, base, files);
  spawnSync('git', ['rebase', headBefore], { cwd: wt });
  spawnSync('git', ['merge', '--no-ff', '-m', msg, branch], { cwd: root });`,
  });
  assert.equal(cellOf(gateThenRebase, 'batch', 'postIntegrationRegate'), 'gate-once');

  const rebaseThenGate = matrixWithBodies({
    batch: `spawnSync('git', ['rebase', headBefore], { cwd: wt });
  runLaneGate(gateId, cfg, wt, false, headBefore, files);
  spawnSync('git', ['merge', '--no-ff', '-m', msg, branch], { cwd: root });`,
  });
  assert.equal(cellOf(rebaseThenGate, 'batch', 'postIntegrationRegate'), 're-gate');
});

test('post-integration re-gate: `git rebase --abort` is cleanup, not a replay (mutation-testing find)', () => {
  // Mutation-testing this column (WI-184) caught the probe reporting `re-gate` for a lane whose
  // real replay had been deleted: the conflict handler's `git rebase --abort` still matched a
  // bare `['rebase'` marker, and a gate call sits after it. A cell that survives the removal of
  // the thing it claims to detect is worse than no cell, so a rebase must name a REF, not a flag.
  const abortOnly = matrixWithBodies({
    batch: `spawnSync('git', ['rebase', '--abort'], { cwd: wt, stdio: 'pipe' });
  runLaneGate(gateId, cfg, wt, false, base, files);
  spawnSync('git', ['merge', '--no-ff', '-m', msg, branch], { cwd: root });`,
  });
  assert.equal(cellOf(abortOnly, 'batch', 'postIntegrationRegate'), 'gate-once');
});

test('post-integration re-gate: the push-race variant (reset + re-merge + gate) counts; a bare reset does not', () => {
  const pushRace = matrixWithBodies({
    batch: `spawnSync('git', ['reset', '--hard', 'origin/master'], { cwd: root });
  spawnSync('git', ['merge', '--no-ff', '-m', msg, branch], { cwd: root });
  runLaneGate(gateId, cfg, root, false, freshBase, freshFiles);`,
  });
  assert.equal(cellOf(pushRace, 'batch', 'postIntegrationRegate'), 're-gate');

  // A reset used for cleanup, with a gate somewhere after it but no re-merge, is NOT a replay.
  const bareReset = matrixWithBodies({
    batch: `spawnSync('git', ['reset', '--hard', 'HEAD'], { cwd: wt });
  runLaneGate(gateId, cfg, wt, false, base, files);
  closeMergedCluster(root, wt, branch, dest, msg);`,
  });
  assert.equal(cellOf(bareReset, 'batch', 'postIntegrationRegate'), 'gate-once');
});

test('lane matrix: throws a clear error (not a silent wrong answer) when the shared pick span (runDispatch) is missing', () => {
  // WI-186: `findSharedPickSpan` resolves `runDispatch` BEFORE any lane row is built (every
  // row's claimArbitration cell may need it), so a dispatch.ts missing `runDispatch` entirely
  // now fails loudly at that point, before ever reaching a per-lane function lookup.
  const dispatchSrc = `async function runPlanningLane(): Promise<void> { noop(); }`;
  const conductorSrc = `export async function runConduct(): Promise<void> { noop(); }`;
  assert.throws(
    () => buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc }),
    /could not locate function 'runDispatch'/,
  );
});

test('lane matrix: throws a clear error when a named lane function cannot be found (rename/removal, runDispatch present)', () => {
  // Simulates the sibling's in-flight rename churn: if a lane entry point OTHER than
  // runDispatch is renamed and LANE_SPANS in lane-matrix.ts is not updated to match, the
  // generator must fail loudly rather than silently produce an empty/misleading row.
  const dispatchSrc = `
async function runPlanningLane(): Promise<void> { noop(); }
export async function runDispatch(opts: unknown): Promise<void> { noop(); }
`;
  const conductorSrc = `export async function runConduct(): Promise<void> { noop(); }`;
  assert.throws(
    () => buildLaneMatrixFromSources({ dispatch: dispatchSrc, conductor: conductorSrc }),
    /could not locate function 'finalizeTargetBuild'/,
  );
});
