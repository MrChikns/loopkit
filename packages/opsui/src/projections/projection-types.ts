// Projection data contract. This is the
// typed layer between the fold substrate and the shared components: a projection is
// handed a `ProjectionEnvelope<T>` and never touches raw seam/ledger files.
//
// Rendering evidence (the render-prop `EvidenceRef` in ../components/types.ts) is a
// strict subset of the data-contract evidence here — the command projection narrows
// `ProjectionEvidenceRef` down to the component shape at render time. They are kept
// distinct so the data contract can carry ledger ranges / queries the chip omits.

/** Every plane projection id. The rail, palette, breadcrumbs, route
 *  loader, and permission checks all read from the registry keyed by this union. */
export type ProjectionId =
  | 'command'
  | 'acceptance'
  | 'work'
  | 'planner'
  | 'workforce'
  | 'workers'
  | 'decisions'
  | 'health'
  | 'observability'
  | 'plane-observability'
  | 'intelligence'
  | 'company'
  | 'threads'
  | 'artifacts'
  | 'timeline'
  | 'settings'
  // Item hub (WI-349) — a drill view served at /item/{WI-NNN}, deliberately NOT
  // added to projectionRegistry (it has no nav destination — Slice 1).
  | 'item-hub';

/** Freshness/failure state of a rendered projection. Distinct from the
 *  visual `OperationalState`; mapped to one centrally by `projectionStateToOperationalState`. */
export type ProjectionState = 'fresh' | 'stale' | 'failed';

/** A reference to a domain entity a projection points at. */
export type EntityRef = {
  type: 'work' | 'decision' | 'thread' | 'worker' | 'slo' | 'target' | 'deploy' | 'receipt';
  id: string;
  label?: string;
};

/** The data-contract evidence reference. Richer than the render-prop
 *  `EvidenceRef`: it can name a reproducible query or ledger range. */
export type ProjectionEvidenceRef = {
  id: string;
  kind: 'ledger-events' | 'receipt' | 'trace' | 'metric-query' | 'fold-definition' | 'artifact';
  label: string;
  href?: string;
  query?: string;
  ledgerRange?: { from: number; to: number };
  generatedAt?: string;
};

/** The one envelope every projection is rendered from. `data` is the
 *  projection-specific payload; everything else is provenance + freshness. */
export type ProjectionEnvelope<T> = {
  projectionId: ProjectionId;
  schemaVersion: string;
  foldVersion: string;
  ledgerSequence: number;
  generatedAt: string;
  freshUntil: string;
  state: ProjectionState;
  data: T;
  evidence: ProjectionEvidenceRef[];
};
