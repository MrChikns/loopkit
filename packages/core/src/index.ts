/**
 * index.ts — loopkit public library API.
 *
 * The framework is consumed two ways: as a CLI (`loopctl`, the `bin`
 * entry → `dist/cli.js`) and as a library import (ops console, tests, other
 * projects). This barrel is the library surface — a single, stable import point
 * so downstream code never reaches into `dist/<module>.js` by path.
 *
 *     import { fold, appendEvents, loadConfig } from '@loopkit/core';
 *
 * `cli.ts` is intentionally NOT re-exported here: it is an executable with
 * top-level side effects, reachable via the `@loopkit/core/cli` subpath export.
 */

// Kernel: ledger + schema + fold
export * from './schema.js';
export * from './ledger.js';
export * from './fold.js';

// Projections
export * from './board.js';
export * from './summary.js';
export * from './doctor.js';
export * from './slo.js';
export * from './costs.js';
export * from './runbooks.js';
export * from './verdicts.js';

// Judge: LLM-as-judge merge review
export * from './judge.js';

// Trajectory projection: per-attempt efficiency
export * from './trajectory.js';

// Model routing: eval-driven model selection
export * from './routing.js';

// Hygiene: edge-triggered heartbeats, compact, quarantine
export * from './hygiene.js';

// Target-readiness audit (loopctl audit)
export * from './audit/index.js';

// Config
export * from './config.js';

// Targets (TARGET EXTERNALIZATION — external-repo manifests)
export * from './target.js';

// Operator verbs (capture / approve / reject / accept) — shared by the CLI and a console's
// HTTP write path. approval.js/acceptance.js are the pure classifiers the
// verbs (and the reactor) build on.
export * from './verbs.js';
export * from './approval.js';
export * from './acceptance.js';

// Beats
export * from './beats/reactor.js';
export * from './beats/dispatch.js';

// Providers (provider-agnostic layer)
export * from './providers/types.js';
export * from './providers/registry.js';
export * from './providers/claudeCli.js';
export * from './providers/codexCli.js';
export * from './providers/ollama.js';

// `Sensitivity` is declared identically in both schema.ts and providers/registry.ts;
// pin it explicitly so the star re-exports above don't leave it ambiguous.
export type { Sensitivity } from './schema.js';
export * from './executionConfig.js';
export * from './session.js';
export * from './conductor.js';
