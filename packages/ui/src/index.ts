// @loopkit/ui — canonical design system.
// Projections own data and hierarchy; this package owns every visual decision,
// interaction pattern, semantic state, and component behaviour.

export * from './tokens/index.ts';
export * from './states/index.ts';
export * from './render/html.ts';
export * from './components/index.ts';
// Shared server-side time-window model (the one `?window=` parser behind WindowPicker).
export * from './time-window.ts';
