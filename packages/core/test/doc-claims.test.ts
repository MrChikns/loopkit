/**
 * doc-claims.test.ts — the CI tripwire for `docs/plane-flows.md` and `docs/limitations.md`.
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
 *
 * Never loosen an assertion here into a no-op. The whole point is that a doc which claims a
 * number must pay for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NUMERIC_CLAIMS,
  CITATION_CLAIMS,
  DOC_PATHS,
  SOURCE_PATHS,
  checkDocClaims,
  checkDocClaimsOnDisk,
  probeNumber,
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
