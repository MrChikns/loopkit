// Projection layer — the typed contract + registry +
// the command projection and its fold adapter. Projections own data and hierarchy;
// they render only shared components.

export * from './projection-types.ts';
export * from './command-projection.ts';
export * from './fold-adapter.ts';
export * from './acceptance-projection.ts';
export * from './acceptance-adapter.ts';
export * from './work-projection.ts';
export * from './work-adapter.ts';
// Nav IA rewire — Workers is NET-NEW.
export * from './workers-projection.ts';
export * from './workers-adapter.ts';
// Extended projections (WI-158..163) — wired in by the WI-165 integration slice.
export * from './planner-projection.ts';
export * from './planner-adapter.ts';
export * from './workforce-projection.ts';
export * from './workforce-adapter.ts';
export * from './health-projection.ts';
export * from './health-adapter.ts';
export * from './observability-projection.ts';
export * from './observability-adapter.ts';
// WI-235: plane-observability replaces the old standalone observability page.
export * from './plane-observability-projection.ts';
export * from './plane-observability-adapter.ts';
export * from './company-projection.ts';
export * from './company-adapter.ts';
export * from './threads-projection.ts';
export * from './threads-adapter.ts';
export * from './thread-detail-projection.ts';
export * from './artifacts-projection.ts';
export * from './artifacts-adapter.ts';
export * from './timeline-projection.ts';
export * from './timeline-adapter.ts';
// Item hub (WI-349) — the drill view served at /item/{WI-NNN}; deliberately
// NOT registered in projection-registry.ts (no nav destination).
export * from './item-hub-projection.ts';
export * from './item-hub-adapter.ts';
export * from './projection-registry.ts';
