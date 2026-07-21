// Knowledge projection adapter. Typed envelope for the operator's knowledge picture:
// active decisions from the configured decision log, with used-by provenance.
// Fixture-driven; the binding layer supplies decisions read from operator-configured
// knowledge sources. State vocabulary is decided here — downstream renderers never
// re-derive it.

import type { GlanceMetric } from './command-projection.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope, ProjectionEvidenceRef } from './projection-types.ts';

const SCHEMA_VERSION = '1';

// ─── Output types ─────────────────────────────────────────────────────────────

/** One active/recent decision from the configured decision log. Each entry carries
 *  provenance — `usedByCount`, the number of already-loaded ledger item specs/trail
 *  texts that cite this decision id. Absent (never `0`) when nothing cites it — the
 *  renderer omits the count rather than showing a fabricated-looking "0 uses". */
export type DecisionCard = {
  id: string;
  title: string;
  date: string;
  status: 'Active' | 'Superseded' | string;
  usedByCount?: number;
};

// ─── Provenance: used-by counting ──────────────────────────────────────────────
// Counts decision-id occurrences across already-loaded ledger item text (specs, park
// reasons, etc.) — a cheap grep over data the caller already has in memory, never a
// new file/ledger scan. Pure and adapter-owned so it's independently testable; the
// caller (the host app) supplies the text corpus from the same fold it already reads.

/** Count occurrences of each decision's id across a corpus of already-loaded ledger
 *  text (e.g. every active/merged/answered item's spec + park reason). A decision with
 *  zero occurrences is simply absent from the returned map — callers must never
 *  synthesize a `0` count (spec trap: "omit the count when zero, never fabricate"). */
export function countDecisionUsage(decisionIds: string[], corpus: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of decisionIds) {
    // Word-boundary match so a short id doesn't also match inside a longer one.
    const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    let total = 0;
    for (const text of corpus) {
      if (!text) continue;
      const matches = text.match(re);
      if (matches) total += matches.length;
    }
    if (total > 0) counts.set(id, total);
  }
  return counts;
}

/** Apply used-by counts onto decision cards — the join point between `countDecisionUsage`'s
 *  output and the typed `DecisionCard[]` the projection renders. Cards with a zero/absent
 *  count keep `usedByCount` unset (never a fabricated `0`). */
export function withUsedByCounts(decisions: DecisionCard[], counts: Map<string, number>): DecisionCard[] {
  return decisions.map((d) => {
    const count = counts.get(d.id);
    return count ? { ...d, usedByCount: count } : d;
  });
}

/** The typed payload the knowledge projection renders. */
export type CompanyData = {
  glance: GlanceMetric[];
  decisions: DecisionCard[];
};

// ─── State maps ───────────────────────────────────────────────────────────────

export function decisionStatusToOp(status: string): OperationalState {
  if (status === 'Active') return 'success';
  if (status === 'Superseded') return 'neutral';
  return 'neutral';
}

// ─── Glance builder ───────────────────────────────────────────────────────────

function buildGlance(decisions: DecisionCard[]): GlanceMetric[] {
  const activeDecisions = decisions.filter((d) => d.status === 'Active').length;
  return [
    {
      label: 'Active decisions',
      value: activeDecisions,
      footnote: activeDecisions ? 'live decision entries' : 'no open decisions',
      state: activeDecisions ? 'success' : 'neutral',
      open: { kind: 'evidence', id: 'decision-log' },
    },
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Build the knowledge projection envelope from typed decision input. The binding
 *  layer supplies decisions read from operator-configured knowledge sources. */
export function companyProjectionFromInput(
  input: {
    decisions: DecisionCard[];
    /** Provenance chips — derived by the binding layer from the actually-configured
     *  knowledge sources. Omitted → a generic single-chip default. */
    evidence?: ProjectionEvidenceRef[];
  },
  opts: { ledgerSequence: number; generatedAt: string; staleAfterSeconds?: number },
): ProjectionEnvelope<CompanyData> {
  const staleAfter = opts.staleAfterSeconds ?? 300;
  const generatedAt = opts.generatedAt;
  const freshUntil = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();

  return {
    projectionId: 'company',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'fixture',
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(input.decisions),
      decisions: input.decisions,
    },
    // Evidence labels are derived by the binding layer from the actually-configured
    // knowledge sources. A generic label stands in when a caller passes no sources;
    // the console's renderCompanyPage overrides this list with the real source labels.
    evidence: input.evidence ?? [
      { id: 'decision-log', kind: 'artifact', label: 'configured knowledge sources' },
    ],
  };
}
