/**
 * doc-claims.test.ts — the CI tripwire for `docs/plane-flows.md`, `docs/limitations.md` and
 * `docs/method.md` (the method doc joined in WI-202; see doc-claims.ts's header for why it is
 * covered by existence markers rather than numbers or citations).
 *
 * Sibling of `lane-matrix.test.ts`, same discipline and the same reason: the guard matrix is
 * derived-and-pinned, so it does not rot; the two narrative docs were not, so they did. This
 * test makes every threshold either checkable or absent, and every `file.ts:NNN` citation
 * either correct or loudly wrong.
 *
 * How to read a failure:
 *   - "states **N**, source says M"  → someone changed a constant. Decide which is right, fix
 *      the doc (usually) or the constant, in the same commit.
 *   - "cites X:123 but that line now reads ..." → the code moved. The message names where it
 *      moved to; update the citation.
 *   - "no marker found" / "which no claim resolves" → the doc and the registry fell out of
 *      step. Do NOT resolve this by deleting the other side; that is the drift, not the fix.
 *   - "bolds the number N with no pin marker" → a new threshold arrived unpinned. Register it.
 *   - "the symbol X is NOT DECLARED" → the doc promises a capability the code does not have.
 *      Fix the SENTENCE first; re-anchoring a promise onto whatever survived is how the
 *      "with acceptance criteria" claim stayed published for weeks.
 *
 * WHY THERE IS NO CONTRADICTION CHECK (WI-196, decided deliberately)
 * ------------------------------------------------------------------
 * The second false claim that reached the published docs was not an unbacked assertion — it was
 * Plate 02 of `plane-flows.md` saying build worktrees open from ambient `HEAD` while
 * `limitations.md`, twenty files away in the same repo, said WI-183 had fixed exactly that. Both
 * sentences were markable. Both would have passed every probe in `doc-claims.ts`, because each
 * one is a claim ABOUT THE CODE and the checker only ever compares a doc to source, never a doc
 * to a doc.
 *
 * Closing it mechanically would need one of:
 *   (a) natural-language contradiction detection over prose — an LLM in the test suite, whose
 *       verdict is non-deterministic, unreviewable, and would flag paraphrase as conflict;
 *   (b) a keyword/antonym heuristic ("HEAD" near "ambient" in one doc vs "not ambient" in
 *       another) — it fires on every sentence that legitimately describes an old behaviour to
 *       contrast it, which both docs do constantly, on purpose;
 *   (c) a shared machine-readable statement layer both docs render from — real, and a rewrite of
 *       the documentation model, not a test.
 *
 * (a) and (b) are the same trap: a check with false alarms gets disabled, and a disabled check
 * protects nothing while still reading as coverage. That is strictly worse than the gap.
 *
 * What actually catches this class, honestly stated: CO-ANCHORING — when two docs describe one
 * behaviour, mark both sentences with the SAME marker id. `ExistenceClaim.doc` accepts a list for
 * exactly this, and every listed doc must carry the marker, so the pairing cannot rot by one side
 * dropping it. A change to the symbol then surfaces both sentences in one failure, and whoever
 * fixes one has the other in front of them. It does not DETECT the contradiction — it removes the
 * conditions for it, by making the two sentences fail together. (The WI-183 case is the worked
 * example: `limitations.md` cites `openBuildWorktreeHead`; if Plate 02 ever restates the worktree
 * base behaviour again, it co-anchors there rather than describing it freehand.)
 *
 * The residual gap is real and is not closed: two docs can still disagree about behaviour neither
 * has marked. The thing that caught it in July 2026 was a human reading both files in one sitting,
 * and until (c) exists that remains the only real detector. Do not let a green run here read as
 * "the docs agree" — it reads as "no marked claim is false".
 *
 * Never loosen an assertion here into a no-op. The whole point is that a doc which claims a
 * number must pay for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NUMERIC_CLAIMS,
  CITATION_CLAIMS,
  EXISTENCE_CLAIMS,
  DOC_PATHS,
  SOURCE_PATHS,
  checkDocClaims,
  checkDocClaimsOnDisk,
  probeNumber,
  probeSymbol,
  readDocs,
  readSources,
  SourceBundle,
  DocBundle,
} from '../src/doc-claims.js';

function summarize(label: string, findings: { claim: string; detail: string }[]): string {
  if (findings.length === 0) return '';
  return `\n${label} (${findings.length}):\n${findings.map(f => `  - ${f.claim}: ${f.detail}`).join('\n')}`;
}

test('doc claims: every number the docs state matches the constant it describes', () => {
  const report = checkDocClaimsOnDisk();
  assert.equal(
    report.numeric.length, 0,
    `\nA threshold in the docs no longer matches its source constant:` +
    summarize('numeric drift', report.numeric) +
    `\n\nResolved source values this run:\n` +
    Object.entries(report.values).map(([k, v]) => `  ${k} = ${v}`).join('\n') +
    `\n\nFix the DOC and the code in the same commit — that is the entire point of pinning them.\n`,
  );
});

test('doc claims: every file:line citation still points at the code it claims', () => {
  const report = checkDocClaimsOnDisk();
  assert.equal(
    report.citation.length, 0,
    `\nA citation in the docs drifted off the code it names:` +
    summarize('citation drift', report.citation) +
    `\n\nCiting a line that has moved is the exact defect this test exists to prevent — a reader\n` +
    `who follows the citation lands on unrelated code and concludes the doc is fiction.\n`,
  );
});

test('doc claims: every capability the docs assert is backed by a symbol that really exists', () => {
  const report = checkDocClaimsOnDisk();
  assert.equal(
    report.existence.length, 0,
    `\nA doc asserts a capability the code does not (or no longer) has:` +
    summarize('existence drift', report.existence) +
    `\n\nSymbols resolved this run:\n` +
    Object.entries(report.symbols)
      .map(([k, e]) => `  ${k}\n    declared: ${e.declaredAt.join(', ')}\n${e.references.map(r => `    ref: ${r}`).join('\n')}`)
      .join('\n') +
    `\n\nA published doc describing a feature the plane does not have is the worst defect class here:\n` +
    `the reader cannot discover the gap by testing. Fix the SENTENCE unless the capability really\n` +
    `exists under a new name.\n`,
  );
});

test('doc claims: markers and the registry are a bijection — no unchecked marker, no orphaned claim', () => {
  const report = checkDocClaimsOnDisk();
  assert.equal(
    report.bijection.length, 0,
    `\nA doc marker has no claim behind it (so it is not actually verified):` +
    summarize('unmatched markers', report.bijection) + '\n',
  );
});

test('doc claims: plane-flows.md bolds no threshold it has not pinned', () => {
  const report = checkDocClaimsOnDisk();
  assert.equal(
    report.unpinned.length, 0,
    `\nplane-flows.md states a bolded number with no pin:` +
    summarize('unpinned numbers', report.unpinned) +
    `\n\nThe doc's own convention: bold a threshold and you pin it. Deleting the pin instead of\n` +
    `fixing the number is how the last drift survived for months.\n`,
  );
});

test('doc claims: every registered claim is actually exercised (the tripwire is armed)', () => {
  // Guards against the failure mode where a registry entry silently stops matching anything
  // and the suite still reports green — the "test that cannot fail" this whole slice is about.
  const sources = readSources();
  const docs = readDocs();
  const report = checkDocClaims(sources, docs);

  assert.ok(NUMERIC_CLAIMS.length >= 15, `expected a meaningful number of pinned constants, got ${NUMERIC_CLAIMS.length}`);
  assert.ok(CITATION_CLAIMS.length >= 25, `expected a meaningful number of pinned citations, got ${CITATION_CLAIMS.length}`);
  assert.ok(EXISTENCE_CLAIMS.length >= 2, `expected the existence registry to be non-token, got ${EXISTENCE_CLAIMS.length}`);

  // Every numeric claim resolved to a real value from source (probeNumber throws otherwise,
  // so reaching here with a full value map is the assertion).
  for (const claim of NUMERIC_CLAIMS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(report.values, claim.id),
      `numeric claim '${claim.id}' produced no resolved source value`,
    );
  }

  // Every citation claim's anchor text exists in its source file exactly where the doc says.
  // (checkDocClaims already reports drift; this asserts the anchors are non-vacuous — an empty
  // or whitespace anchor would match every line and verify nothing.)
  for (const claim of CITATION_CLAIMS) {
    assert.ok(claim.mustContain.trim().length >= 8, `citation anchor for '${claim.id}' is too weak to prove anything`);
  }

  // Every existence claim resolved to a real declaration site, and each declared reference site
  // matched a real line. probeSymbol throws otherwise, so a populated evidence map IS the
  // assertion — but assert the evidence is non-empty too, since an empty one would mean the
  // claim was recorded without proving anything.
  for (const claim of EXISTENCE_CLAIMS) {
    const evidence = report.symbols[claim.id];
    assert.ok(evidence, `existence claim '${claim.id}' produced no resolved symbol evidence`);
    assert.ok(evidence!.declaredAt.length > 0, `existence claim '${claim.id}' resolved to no declaration site`);
    assert.equal(
      evidence!.references.length, (claim.referencedBy ?? []).length,
      `existence claim '${claim.id}' did not resolve every declared reference site`,
    );
    assert.ok(
      claim.declaration.source.length >= 10,
      `declaration pattern for '${claim.id}' is too loose to prove a symbol exists`,
    );
  }
});

// ---------------------------------------------------------------------------
// Machinery coverage — proof the checker BITES, run against injected sources/docs
// so it does not depend on the real tree happening to be broken.
// ---------------------------------------------------------------------------

/** A minimal source/doc pair carrying exactly one real claim of each kind. */
function fixture(overrides: { source?: Partial<SourceBundle>; docs?: Partial<DocBundle> } = {}) {
  const sources = readSources();
  const docs = readDocs();
  return {
    sources: { ...sources, ...overrides.source } as SourceBundle,
    docs: { ...docs, ...overrides.docs } as DocBundle,
  };
}

test('doc claims: a constant that moves without the doc FAILS (this is the drift the test exists for)', () => {
  const { sources, docs } = fixture();
  // Move BUILDER_BREAKER_N in the injected source only — the doc is untouched and still states 5.
  const mutated: SourceBundle = {
    ...sources,
    dispatch: sources.dispatch.replace(
      /^export const BUILDER_BREAKER_N = \d+;/m,
      'export const BUILDER_BREAKER_N = 9;',
    ),
  };
  assert.notEqual(mutated.dispatch, sources.dispatch, 'fixture failed to mutate the constant — the regex is wrong');

  const report = checkDocClaims(mutated, docs);
  const hit = report.numeric.find(f => f.claim === 'BUILDER_BREAKER_N');
  assert.ok(hit, `expected a numeric finding for BUILDER_BREAKER_N, got: ${JSON.stringify(report.numeric)}`);
  assert.match(hit!.detail, /source says 9/);
});

test('doc claims: a doc number that moves without the constant FAILS (drift in the other direction)', () => {
  const { sources, docs } = fixture();
  const mutated: DocBundle = {
    ...docs,
    'plane-flows': docs['plane-flows'].replace(
      /\*\*\d+\*\*<!--pin:BUILDER_BREAKER_N-->/,
      '**42**<!--pin:BUILDER_BREAKER_N-->',
    ),
  };
  assert.notEqual(mutated['plane-flows'], docs['plane-flows'], 'fixture failed to mutate the doc');

  const report = checkDocClaims(sources, mutated);
  assert.ok(
    report.numeric.some(f => f.claim === 'BUILDER_BREAKER_N' && /states \*\*42\*\*/.test(f.detail)),
    `expected a numeric finding for the doc's changed number, got: ${JSON.stringify(report.numeric)}`,
  );
});

test('doc claims: deleting a pin marker FAILS rather than silently un-checking the claim', () => {
  const { sources, docs } = fixture();
  const mutated: DocBundle = {
    ...docs,
    'plane-flows': docs['plane-flows'].replace(/<!--pin:BUILDER_BREAKER_N-->/g, ''),
  };
  const report = checkDocClaims(sources, mutated);
  assert.ok(
    report.numeric.some(f => f.claim === 'BUILDER_BREAKER_N' && /no .*marker found/.test(f.detail)),
    'removing the marker must be reported, not silently accepted',
  );
  // ...and the now-bare bolded number is caught by the unpinned sweep too.
  assert.ok(report.unpinned.length > 0, 'a bolded number left without a pin must be reported');
});

test('doc claims: a citation whose code moved reports the line it moved TO', () => {
  const { sources, docs } = fixture();
  // Insert 3 blank lines at the top of ledger.ts so every cited line in it shifts by 3.
  const mutated: SourceBundle = { ...sources, ledger: '\n\n\n' + sources.ledger };
  const report = checkDocClaims(mutated, docs);
  const hit = report.citation.find(f => f.claim === 'ledgerAppendWrite');
  assert.ok(hit, `expected a citation finding for ledgerAppendWrite, got: ${JSON.stringify(report.citation)}`);
  assert.match(hit!.detail, /The code moved to packages\/core\/src\/ledger\.ts:\d+/);
});

test('doc claims: a citation whose anchor code was deleted reports that, not a wrong line', () => {
  const { sources, docs } = fixture();
  const mutated: SourceBundle = {
    ...sources,
    ledger: sources.ledger.replace('await fh.write(line);', 'await writeTheLine(line);'),
  };
  const report = checkDocClaims(mutated, docs);
  assert.ok(
    report.citation.some(f => f.claim === 'ledgerAppendWrite' && /no longer appears anywhere/.test(f.detail)),
    'a renamed/removed anchor must be reported as gone, not as a line mismatch',
  );
});

test('doc claims: an unregistered marker in a doc is reported (a marker that verifies nothing)', () => {
  const { sources, docs } = fixture();
  const mutated: DocBundle = {
    ...docs,
    'plane-flows': docs['plane-flows'] + '\n\nSomething takes **17**<!--pin:notARealClaim--> seconds.\n',
  };
  const report = checkDocClaims(sources, mutated);
  assert.ok(
    report.bijection.some(f => f.claim === 'notARealClaim'),
    'a pin naming no registered claim must be reported',
  );
});

// ── Existence machinery ────────────────────────────────────────────────────

test('doc claims: a doc capability whose symbol is DELETED from source FAILS naming the symbol', () => {
  // The WI-196 case, reproduced: `plane-flows.md` says the reactor produces items with acceptance
  // criteria. Take the field back out of the schema — as it genuinely was, while both docs
  // claimed it — and the checker must say so.
  const { sources, docs } = fixture();
  const mutated: SourceBundle = {
    ...sources,
    schema: sources.schema.replace(/^ {2}criteria\?: string\[\];$/gm, '  // (criteria field removed)'),
  };
  assert.notEqual(mutated.schema, sources.schema, 'fixture failed to remove the field — the regex is wrong');

  const report = checkDocClaims(mutated, docs);
  const hit = report.existence.find(f => f.claim === 'itemCriteriaField');
  assert.ok(hit, `expected an existence finding for itemCriteriaField, got: ${JSON.stringify(report.existence)}`);
  assert.match(hit!.detail, /is NOT DECLARED in packages\/core\/src\/schema\.ts/);
  assert.match(hit!.detail, /docs\/plane-flows\.md/);
});

test('doc claims: a symbol that survives but stops being REFERENCED still FAILS (declared-but-dead)', () => {
  const { sources, docs } = fixture();
  const mutated: SourceBundle = {
    ...sources,
    reactor: sources.reactor.replace("normalizeCriteria(fields['CRITERIA'])", 'undefined'),
  };
  assert.notEqual(mutated.reactor, sources.reactor, 'fixture failed to remove the reference');

  const report = checkDocClaims(mutated, docs);
  const hit = report.existence.find(f => f.claim === 'itemCriteriaField');
  assert.ok(hit, `expected an existence finding when the reactor stops writing criteria, got: ${JSON.stringify(report.existence)}`);
  assert.match(hit!.detail, /no\s+longer references it/);
});

test('doc claims: deleting an existence marker from the doc FAILS rather than un-checking the claim', () => {
  const { sources, docs } = fixture();
  const mutated: DocBundle = {
    ...docs,
    'plane-flows': docs['plane-flows'].replace(/<!--exists:itemCriteriaField-->/g, ''),
  };
  assert.notEqual(mutated['plane-flows'], docs['plane-flows'], 'fixture failed to remove the marker');

  const report = checkDocClaims(sources, mutated);
  assert.ok(
    report.existence.some(f => f.claim === 'itemCriteriaField' && /no .*marker found/.test(f.detail)),
    `removing the marker must be reported, not silently accepted: ${JSON.stringify(report.existence)}`,
  );
});

test('doc claims: an unregistered existence marker is reported (a sentence nothing checks)', () => {
  const { sources, docs } = fixture();
  const mutated: DocBundle = {
    ...docs,
    'plane-flows': docs['plane-flows'] + '\n\nThe plane also grows its own vegetables.<!--exists:notARealCapability-->\n',
  };
  const report = checkDocClaims(sources, mutated);
  assert.ok(
    report.bijection.some(f => f.claim === 'notARealCapability'),
    'an exists marker naming no registered claim must be reported',
  );
});

test('doc claims: probeSymbol throws (loudly) when the symbol it names is gone', () => {
  const sources = readSources();
  assert.throws(
    () => probeSymbol(
      {
        id: 'fake', doc: 'plane-flows', symbol: 'noSuchThing',
        what: 'a capability nobody built',
        file: 'dispatch', declaration: /^export const NO_SUCH_SYMBOL =/,
      },
      sources,
    ),
    /is NOT DECLARED/,
  );
});

test('doc claims: probeSymbol throws when a reference site the doc names stops matching', () => {
  const sources = readSources();
  assert.throws(
    () => probeSymbol(
      {
        id: 'fake', doc: 'plane-flows', symbol: 'BUILDER_BREAKER_N',
        what: 'a real symbol the doc claims a module uses',
        file: 'dispatch', declaration: /^export const BUILDER_BREAKER_N = /,
        referencedBy: [{ file: 'ledger', pattern: /BUILDER_BREAKER_N/, proves: 'a reference that was never there' }],
      },
      sources,
    ),
    /no\s+longer references it/,
  );
});

test('doc claims: probeSymbol throws on a pattern too loose to prove anything (no vacuous pins)', () => {
  const sources = readSources();
  assert.throws(
    () => probeSymbol(
      {
        id: 'fake', doc: 'plane-flows', symbol: 'anything at all',
        what: 'a claim pinned to a pattern that matches half the file',
        file: 'dispatch', declaration: /const/,
      },
      sources,
    ),
    /proves nothing/,
  );
});

test('doc claims: probeNumber throws (loudly) when a constant it names cannot be found', () => {
  const sources = readSources();
  assert.throws(
    () => probeNumber('fake', [{ file: 'dispatch', pattern: /^export const NO_SUCH_CONSTANT = (\d+);/m }], sources),
    /found NO match/,
  );
});

test('doc claims: probeNumber throws when duplicated copies of a threshold disagree', () => {
  const sources = readSources();
  const mutated: SourceBundle = {
    ...sources,
    reactor: sources.reactor.replace(/optionalAfterHours \?\? \d+/g, 'optionalAfterHours ?? 999'),
  };
  assert.throws(
    () => probeNumber(
      'optionalAfterHours',
      [
        { file: 'config', pattern: /optionalAfterHours: (\d+),/ },
        { file: 'reactor', pattern: /optionalAfterHours \?\? (\d+)/ },
      ],
      mutated,
    ),
    /DISAGREEING values/,
  );
});

test('doc claims: registry paths all exist and are readable (no claim points at a deleted file)', () => {
  const sources = readSources();
  for (const [key, path] of Object.entries(SOURCE_PATHS)) {
    assert.ok((sources as Record<string, string>)[key].length > 0, `source ${path} read empty`);
  }
  const docs = readDocs();
  for (const [key, path] of Object.entries(DOC_PATHS)) {
    assert.ok((docs as Record<string, string>)[key].length > 0, `doc ${path} read empty`);
  }
});
