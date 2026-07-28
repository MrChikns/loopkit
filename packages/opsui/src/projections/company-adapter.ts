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
  /** Configured plane/target that supplied the decision. */
  targetName?: string;
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
  decisionTotal: number;
  page: number;
  pageCount: number;
  query: string;
  statusFilter: CompanyStatusFilter;
  targetFilter: string | null;
  statusLinks: CompanyFilterLink[];
  targetLinks: CompanyFilterLink[];
  clearQueryHref: string;
  prevHref: string | null;
  nextHref: string | null;
};

export type CompanyStatusFilter = 'active' | 'superseded' | 'all';

export type CompanyFilterLink = {
  value: string;
  label: string;
  href: string;
  active: boolean;
};

// ─── State maps ───────────────────────────────────────────────────────────────

export function decisionStatusToOp(status: string): OperationalState {
  if (status.toLowerCase().startsWith('active')) return 'success';
  if (status.toLowerCase().startsWith('superseded')) return 'neutral';
  return 'neutral';
}

function statusKind(status: string): Exclude<CompanyStatusFilter, 'all'> | 'other' {
  const normalized = status.trim().toLowerCase();
  if (normalized.startsWith('active')) return 'active';
  if (normalized.startsWith('superseded')) return 'superseded';
  return 'other';
}

function normalizeStatus(value: string | null | undefined): CompanyStatusFilter {
  return value === 'superseded' || value === 'all' ? value : 'active';
}

function companyHref(filters: {
  query: string;
  status: CompanyStatusFilter;
  target: string | null;
  page?: number;
}): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.status !== 'active') params.set('status', filters.status);
  if (filters.target) params.set('target', filters.target);
  if ((filters.page ?? 1) > 1) params.set('page', String(filters.page));
  const query = params.toString();
  return query ? `/company?${query}` : '/company';
}

// ─── Glance builder ───────────────────────────────────────────────────────────

function buildGlance(decisions: DecisionCard[]): GlanceMetric[] {
  const activeDecisions = decisions.filter((d) => d.status.toLowerCase().startsWith('active')).length;
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
  opts: {
    ledgerSequence: number;
    generatedAt: string;
    staleAfterSeconds?: number;
    query?: string | null;
    status?: string | null;
    target?: string | null;
    targetNames?: string[];
    page?: number;
    pageSize?: number;
  },
): ProjectionEnvelope<CompanyData> {
  const staleAfter = opts.staleAfterSeconds ?? 300;
  const generatedAt = opts.generatedAt;
  const freshUntil = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();
  const query = (opts.query ?? '').trim();
  const status = normalizeStatus(opts.status);
  const knownTargets = [...new Set(opts.targetNames ?? input.decisions.map((d) => d.targetName).filter((v): v is string => Boolean(v)))];
  const target = opts.target && knownTargets.includes(opts.target) ? opts.target : null;
  const queryLower = query.toLowerCase();
  const filtered = input.decisions.filter((decision) => {
    if (target && decision.targetName !== target) return false;
    if (status !== 'all' && statusKind(decision.status) !== status) return false;
    if (!queryLower) return true;
    return [decision.id, decision.title, decision.status, decision.targetName ?? '']
      .some((value) => value.toLowerCase().includes(queryLower));
  });
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 20));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Math.max(1, Math.floor(opts.page ?? 1));
  const page = Math.min(requestedPage, pageCount);
  const decisions = filtered.slice((page - 1) * pageSize, page * pageSize);
  const hrefFor = (next: { status?: CompanyStatusFilter; target?: string | null; page?: number }) =>
    companyHref({
      query,
      status: next.status ?? status,
      target: next.target === undefined ? target : next.target,
      ...(next.page === undefined ? {} : { page: next.page }),
    });

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
      decisions,
      decisionTotal: filtered.length,
      page,
      pageCount,
      query,
      statusFilter: status,
      targetFilter: target,
      statusLinks: ([
        ['active', 'Active'],
        ['superseded', 'Superseded'],
        ['all', 'All statuses'],
      ] as const).map(([value, label]) => ({
        value,
        label,
        href: hrefFor({ status: value, page: 1 }),
        active: status === value,
      })),
      targetLinks: [
        { value: '', label: 'All targets' },
        ...knownTargets.map((value) => ({ value, label: value })),
      ].map(({ value, label }) => ({
        value,
        label,
        href: hrefFor({ target: value || null, page: 1 }),
        active: (target ?? '') === value,
      })),
      clearQueryHref: companyHref({ query: '', status, target }),
      prevHref: page > 1 ? hrefFor({ page: page - 1 }) : null,
      nextHref: page < pageCount ? hrefFor({ page: page + 1 }) : null,
    },
    // Evidence labels are derived by the binding layer from the actually-configured
    // knowledge sources. A generic label stands in when a caller passes no sources;
    // the console's renderCompanyPage overrides this list with the real source labels.
    evidence: input.evidence ?? [
      { id: 'decision-log', kind: 'artifact', label: 'configured knowledge sources' },
    ],
  };
}
