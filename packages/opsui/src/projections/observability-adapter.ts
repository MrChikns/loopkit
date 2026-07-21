// Observability projection adapter — WI-161. Maps a raw ObservabilityInput
// (per-loop/provider token+cost rows, 7-day trend points, transcript sizes)
// into a typed ProjectionEnvelope<ObservabilityData>. Shapes mirror the
// tokenUsage.ts UsageWindow / TokenUsage vocabulary at the aggregate level
// (tokens, usd, session/trend windows). Malformed input yields a `failed`
// envelope — loud, never calm.

import type { GlanceMetric } from './command-projection.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';

// ─── Input types ──────────────────────────────────────────────────────────────

/** One per-loop/provider cost row (mirrors Claude transcript usage token split). */
export type TokenCostRow = {
  loop: string;
  provider: string;
  tokens: number;
  usd: number;
};

/** One 7-day trend point — daily aggregate (mirrors tokenUsage.ts UsageSample). */
export type TrendPoint = {
  date: string;   // ISO date "YYYY-MM-DD"
  tokens: number;
  usd: number;
};

/** One transcript size entry. */
export type TranscriptSize = {
  label: string;
  bytes: number;
};

/** Raw input shape the adapter accepts (fixture-driven; wire-up slice binds real source). */
export type ObservabilityInput = {
  rows: TokenCostRow[];
  trendPoints: TrendPoint[];
  transcriptSizes: TranscriptSize[];
  generatedAt: string;
};

// ─── Output types ─────────────────────────────────────────────────────────────

/** The typed payload the observability projection renders. */
export type ObservabilityData = {
  glance: GlanceMetric[];
  rows: TokenCostRow[];
  trendPoints: TrendPoint[];
  transcriptSizes: TranscriptSize[];
  totalTokens: number;
  totalUsd: number;
};

// ─── Validator ────────────────────────────────────────────────────────────────

export function isObservabilityInput(v: unknown): v is ObservabilityInput {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r['rows']) &&
    Array.isArray(r['trendPoints']) &&
    Array.isArray(r['transcriptSizes']) &&
    typeof r['generatedAt'] === 'string'
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a token count concisely: "1.2M", "850k", "42". Exported so the
 *  projection can reuse it when rendering the token rows table. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function buildGlance(
  totalTokens: number,
  totalUsd: number,
  rows: TokenCostRow[],
  trendPoints: TrendPoint[],
): GlanceMetric[] {
  const providers = new Set(rows.map((r) => r.provider)).size;
  const weekUsd   = trendPoints.reduce((s, p) => s + p.usd, 0);

  return [
    {
      label:    'Total tokens',
      value:    totalTokens > 0 ? formatTokens(totalTokens) : '—',
      footnote: providers > 0
        ? `${providers} provider${providers !== 1 ? 's' : ''}`
        : 'no data',
      state:    'neutral',
      open:     { kind: 'evidence', id: 'token-rows' },
    },
    {
      label:    'Total cost',
      value:    `$${totalUsd.toFixed(2)}`,
      footnote: 'this window',
      state:    totalUsd > 5 ? 'warning' : 'neutral',
      open:     { kind: 'evidence', id: 'token-rows' },
    },
    {
      label:    '7-day spend',
      value:    `$${weekUsd.toFixed(2)}`,
      footnote: trendPoints.length
        ? `${trendPoints.length} day${trendPoints.length !== 1 ? 's' : ''} of data`
        : 'no trend data',
      state:    weekUsd > 20 ? 'warning' : 'neutral',
      open:     { kind: 'evidence', id: 'trend-chart' },
    },
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Build the observability projection envelope from raw input.
 *  Unknown or malformed input yields a `failed` envelope. */
export function observabilityProjectionFromInput(
  raw: unknown,
  opts: { ledgerSequence: number; foldVersion?: string; staleAfterSeconds?: number } = { ledgerSequence: 0 },
): ProjectionEnvelope<ObservabilityData> {
  const foldVersion = opts.foldVersion ?? 'observability@1';
  const staleAfter  = opts.staleAfterSeconds ?? 300;

  if (!isObservabilityInput(raw)) {
    return {
      projectionId:   'observability',
      schemaVersion:  SCHEMA_VERSION,
      foldVersion,
      ledgerSequence: opts.ledgerSequence,
      generatedAt:    new Date().toISOString(),
      freshUntil:     new Date().toISOString(),
      state:          'failed',
      data: {
        glance: [], rows: [], trendPoints: [], transcriptSizes: [],
        totalTokens: 0, totalUsd: 0,
      },
      evidence: [
        { id: 'token-rows', kind: 'metric-query', label: 'Claude transcript usage logs' },
      ],
    };
  }

  const generatedAt = raw.generatedAt;
  const freshUntil  = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();
  const totalTokens = raw.rows.reduce((s, r) => s + r.tokens, 0);
  const totalUsd    = raw.rows.reduce((s, r) => s + r.usd, 0);

  return {
    projectionId:   'observability',
    schemaVersion:  SCHEMA_VERSION,
    foldVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance:          buildGlance(totalTokens, totalUsd, raw.rows, raw.trendPoints),
      rows:            raw.rows,
      trendPoints:     raw.trendPoints,
      transcriptSizes: raw.transcriptSizes,
      totalTokens,
      totalUsd,
    },
    evidence: [
      { id: 'token-rows',  kind: 'metric-query', label: 'Claude transcript usage logs' },
      { id: 'trend-chart', kind: 'metric-query', label: '7-day token spend trend' },
      { id: 'transcripts', kind: 'artifact',     label: 'session transcript files' },
    ],
  };
}
