// Projection registry — one typed place that owns navigation, palette,
// route metadata, mobile priority, and renderer selection for every projection. The
// rail, bottom nav, palette, and breadcrumbs read from HERE and never define
// destinations themselves. The shell stories keep their literal
// destinations; `registryDestinations()` returns the registered ones and
// `registeredStylesheets()` the CSS a server serves for them.

import type { NavDestination } from '../components/types.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { ProjectionId } from './projection-types.ts';
import { CommandProjection, type CommandData } from './command-projection.ts';
import { AcceptanceProjection, type AcceptanceData } from './acceptance-projection.ts';
import { WorkProjection } from './work-projection.ts';
import type { WorkLedgerData } from './work-adapter.ts';
import { HealthProjection } from './health-projection.ts';
import type { HealthData } from './health-adapter.ts';
import { PlaneObservabilityProjection } from './plane-observability-projection.ts';
import type { PlaneObservabilityData } from './plane-observability-adapter.ts';
import { CompanyProjection } from './company-projection.ts';
import type { CompanyData } from './company-adapter.ts';
import { ThreadsProjection } from './threads-projection.ts';
import type { ThreadsData } from './threads-adapter.ts';

/** A projection's registry entry. `render` is a server-side string renderer
 *  (no React); it is the single renderer the route loader selects. */
export type ProjectionDefinition<T = unknown> = {
  id: ProjectionId;
  title: string;
  /** One-sentence operational purpose — shown in the expanded rail. */
  description: string;
  route: string;
  /** Bottom-nav ordering on mobile; null = palette-only. */
  mobilePriority: number | null;
  commandKeywords: string[];
  /** Capabilities the viewer must hold (the union lands with the command
   *  dispatcher — strings until then). */
  requiredCapabilities: string[];
  /** Freshness horizon before the envelope is `stale`. */
  staleAfterSeconds: number;
  /** The projection's own stylesheet, path relative to the package root (e.g.
   *  `src/styles/projections/health.css`). A server serves these alongside
   *  tokens + `components.css` (the "css serving" wire-up). Omitted when the
   *  projection styles entirely from `components.css`. */
  stylesheet?: string;
  render: (env: ProjectionEnvelope<T>) => string;
};

export const commandProjectionDefinition: ProjectionDefinition<CommandData> = {
  id: 'command',
  title: 'Command',
  description: 'Glance, act and drill without leaving the operating picture',
  route: '/command',
  mobilePriority: 1,
  commandKeywords: ['home', 'founder', 'pulse', 'conductor', 'threads', 'conversation', 'messages', 'chat'],
  requiredCapabilities: ['ledger.read', 'intent.submit'],
  staleAfterSeconds: 45,
  // Nav IA rewire: Command now composes the threadCard
  // renderer (folded-in "Conversations" region) so it needs threads.css's classes too. The
  // /ops/threads route also still renders those classes directly — one stylesheet, two callers.
  stylesheet: 'src/styles/projections/threads.css',
  render: CommandProjection,
};

export const acceptanceProjectionDefinition: ProjectionDefinition<AcceptanceData> = {
  id: 'acceptance',
  // This page is where merged slices get tested and accepted/rejected — the to-test
  // desk is findable under its own name.
  title: 'Acceptance',
  description: 'Merged slices awaiting your works / found-a-problem verdict',
  route: '/acceptance',
  mobilePriority: 3,
  commandKeywords: [
    'accept', 'decisions', 'test', 'verify', 'sign off', 'checklist',
  ],
  requiredCapabilities: ['ledger.read', 'acceptance.record'],
  staleAfterSeconds: 45,
  render: AcceptanceProjection,
};

export const workProjectionDefinition: ProjectionDefinition<WorkLedgerData> = {
  id: 'work',
  title: 'Missions',
  description: 'Active work items, live builds, queue, backlog and engine health in one board',
  route: '/work',
  mobilePriority: 2,
  // Nav collapse 9→5 (WI-350): Missions re-absorbs Workers — its in-flight/queue/beat/
  // breaker keywords fold in here (the Workers registry entry retires).
  commandKeywords: [
    'work', 'missions', 'build', 'queue', 'parked', 'ledger', 'lane',
    'backlog', 'groom', 'groomable', 'planner',
    'workers', 'workforce', 'beats', 'reactor', 'dispatch', 'sessions', 'worktree',
    'breakers', 'in flight', 'inflight', 'building', 'hold', 'resume', 'retry', 'stop', 'engine',
  ],
  requiredCapabilities: ['ledger.read'],
  staleAfterSeconds: 45,
  stylesheet: 'src/styles/projections/work.css',
  render: WorkProjection,
};

// Nav collapse 9→5 (WI-350): the Workers registry entry RETIRES — Missions re-absorbs its
// content (in-flight run cards + queued/parked rows merged into ONE board ordered
// building → queued → parked, beats/breakers collapsed into a bottom "Engine" section).
// workers-projection.ts/workers-adapter.ts stay as region providers (their exported region
// renderers are imported by work-projection.ts) — nothing registers them any more.
// `/ops/workers` 301s to `/ops/work`.

export const healthProjectionDefinition: ProjectionDefinition<HealthData> = {
  id: 'health',
  title: 'System',
  description: 'SLO board, spend/quota strip, self-heal activity and build artifacts for the pipeline itself',
  route: '/health',
  mobilePriority: 4,
  // Widened with the forensic-artifact terms — the artifact list renders as a System
  // region (id="artifacts").
  commandKeywords: [
    'health', 'system', 'slo', 'uptime', 'pipeline', 'degraded', 'breached',
    'heal', 'self-heal', 'findings',
    'artifacts', 'gate log', 'diff', 'salvage', 'patch', 'evidence', 'build log',
    'analytics', 'quota', 'spend', 'first-pass', 'acceptance split',
  ],
  requiredCapabilities: ['ledger.read'],
  staleAfterSeconds: 45,
  stylesheet: 'src/styles/projections/health.css',
  render: HealthProjection,
};

// The plane-observability definition renders spend/judge/trajectory/token telemetry.
// Its title is 'Analytics'; the destination is derived from THIS registry, the single
// source, so the shell title never diverges from the nav label.
export const planeObservabilityProjectionDefinition: ProjectionDefinition<PlaneObservabilityData> = {
  id: 'plane-observability',
  title: 'Analytics',
  description: 'Plane spend·judge·trajectory·tokens',
  route: '/observability',
  mobilePriority: null,
  commandKeywords: [
    'observability', 'analytics', 'ops', 'spend', 'judge', 'verdicts', 'repairs', 'trajectory', 'tokens', 'cost',
  ],
  requiredCapabilities: ['ledger.read'],
  staleAfterSeconds: 300,
  stylesheet: 'src/styles/projections/plane-observability.css',
  render: PlaneObservabilityProjection,
};

export const companyProjectionDefinition: ProjectionDefinition<CompanyData> = {
  id: 'company',
  title: 'Knowledge',
  description: 'The knowledge stream: decisions and operator-configured reference docs',
  route: '/company',
  // Knowledge joins the bottom-5 (command·work·acceptance·health·company) — Analytics
  // stays palette-only, linked from System's Analytics strip.
  mobilePriority: 5,
  commandKeywords: [
    'company', 'knowledge', 'decisions', 'docs', 'stream', 'adr', 'provenance',
  ],
  requiredCapabilities: ['ledger.read'],
  staleAfterSeconds: 45,
  stylesheet: 'src/styles/projections/company.css',
  render: CompanyProjection,
};

export const threadsProjectionDefinition: ProjectionDefinition<ThreadsData> = {
  id: 'threads',
  title: 'Threads',
  description: 'Founder conversations with the conductor — full message history',
  route: '/threads',
  mobilePriority: null,
  commandKeywords: ['threads', 'conversation', 'messages', 'chat', 'conductor', 'replies'],
  requiredCapabilities: ['ledger.read', 'intent.submit'],
  staleAfterSeconds: 45,
  stylesheet: 'src/styles/projections/threads.css',
  render: ThreadsProjection,
};

// The Artifacts content renders as a region on the System page (id="artifacts") —
// artifacts-projection.ts/artifacts-adapter.ts stay as region providers (their exported
// region renderers are imported by health-projection.ts; item-hub-projection.ts also
// still reuses `artifactRow` directly). `/ops/artifacts` 301s to `/ops/health#artifacts`.

/** Registered projections, keyed by id. The bottom-5 (mobile bar, in priority order):
 *  command(1) · work(2) · acceptance(3) · health(4) · company(5). plane-observability
 *  stays registered but palette-only (mobilePriority null; linked from System's
 *  Analytics strip). Content that renders as a region on an absorbing page (threads→command,
 *  workers→work, artifacts→health) keeps its old route as a 301 — never a 404. */
export const projectionRegistry: Partial<Record<ProjectionId, ProjectionDefinition>> = {
  command: commandProjectionDefinition as ProjectionDefinition,
  work: workProjectionDefinition as ProjectionDefinition,
  acceptance: acceptanceProjectionDefinition as ProjectionDefinition,
  health: healthProjectionDefinition as ProjectionDefinition,
  company: companyProjectionDefinition as ProjectionDefinition,
  'plane-observability': planeObservabilityProjectionDefinition as ProjectionDefinition,
};

/** Nav destinations derived from the registry — the single source the rail, bottom
 *  nav, and palette render. Ordered by mobile priority, then title. */
export function registryDestinations(): NavDestination[] {
  return Object.values(projectionRegistry)
    .filter((d): d is ProjectionDefinition => Boolean(d))
    .map((d) => ({
      id: d.id,
      title: d.title,
      purpose: d.description,
      href: d.route,
      mobilePriority: d.mobilePriority,
    }))
    .sort((a, b) => {
      const pa = a.mobilePriority ?? Number.POSITIVE_INFINITY;
      const pb = b.mobilePriority ?? Number.POSITIVE_INFINITY;
      return pa - pb || a.title.localeCompare(b.title);
    });
}

/** Package-relative stylesheet paths for every registered projection that ships its
 *  own CSS — the ordered list a server serves after tokens + `components.css`
 *  (the "css serving" wire-up). Registry-derived so a new projection's
 *  stylesheet is served the moment it registers, never hand-listed. */
export function registeredStylesheets(): string[] {
  return Object.values(projectionRegistry)
    .filter((d): d is ProjectionDefinition => Boolean(d))
    .map((d) => d.stylesheet)
    .filter((s): s is string => Boolean(s));
}
