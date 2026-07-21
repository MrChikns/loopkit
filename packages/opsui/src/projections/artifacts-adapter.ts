// Artifacts projection adapter — nav IA rewire.
// The founder's read-only list of REAL build artifacts the dispatch beat wrote for
// each work item/attempt — gate logs, diffs, and salvage patches — mtime-sorted
// newest first, capped ~50. Fixture-driven like the other adapters; the
// wire-up slice binds the real `.ai/runs/loopkit` directory listing (the host app
// reads the filesystem — this package stays filesystem-free).

import type { GlanceMetric } from './command-projection.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';

/** The artifact kinds the dispatch beat writes per work item/attempt
 *  (@loopkit/core src/beats/dispatch.ts persistGateLog/persistDiff, salvage.ts). */
export type ArtifactKind = 'gate.log' | 'diff' | 'salvage.patch' | 'salvage.md' | 'manifest.json' | 'log';

/** One real artifact file on disk. */
export type ArtifactRow = {
  itemId: string;
  attempt: number;
  kind: ArtifactKind;
  /** Filename only — the adapter never fabricates a path; the host app resolves the doc route. */
  filename: string;
  /** ISO mtime — sort key, also shown so the founder can judge freshness. */
  mtime: string;
  /** Bytes on disk — honest size, never estimated. */
  sizeBytes: number;
};

/** The typed payload the Artifacts projection renders. */
export type ArtifactsData = {
  glance: GlanceMetric[];
  /** Newest-first, capped by the caller (~50) — never silently truncated without a count. */
  artifacts: ArtifactRow[];
  /** True when the caller capped the listing — the empty state / count line says so honestly. */
  truncated: boolean;
};

function buildGlance(artifacts: ArtifactRow[], truncated: boolean): GlanceMetric[] {
  const items = new Set(artifacts.map((a) => a.itemId)).size;
  return [
    {
      label: 'Artifacts',
      value: artifacts.length,
      footnote: truncated ? 'capped — more exist' : artifacts.length ? 'gate logs, diffs, salvage patches' : 'none yet',
      state: artifacts.length ? 'neutral' : 'success',
      open: { kind: 'evidence', id: 'artifact-dir' },
    },
    {
      label: 'Work items',
      value: items,
      footnote: items ? 'distinct WI-NNN with artifacts' : 'no artifacts yet',
      state: 'neutral',
      open: { kind: 'evidence', id: 'artifact-dir' },
    },
  ];
}

/** Build the Artifacts projection envelope from a real (pre-sorted, pre-capped) listing.
 *  The caller (the host app) does the filesystem read + parse + sort + cap; this adapter only
 *  shapes it into the typed envelope — no fake data, an honest empty state when
 *  the listing is empty. */
export function artifactsProjectionFromInput(
  input: { artifacts: ArtifactRow[]; truncated: boolean },
  opts: { ledgerSequence: number; generatedAt: string; staleAfterSeconds?: number },
): ProjectionEnvelope<ArtifactsData> {
  const staleAfter = opts.staleAfterSeconds ?? 45;
  const generatedAt = opts.generatedAt;
  const freshUntil = new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString();

  return {
    projectionId: 'artifacts',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'fixture',
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(input.artifacts, input.truncated),
      artifacts: input.artifacts,
      truncated: input.truncated,
    },
    evidence: [
      { id: 'artifact-dir', kind: 'artifact', label: '.ai/runs/loopkit' },
    ],
  };
}
