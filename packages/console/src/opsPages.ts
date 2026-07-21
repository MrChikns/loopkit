/**
 * opsPages.ts — the ops-console rendering stack, bound to the loopkit core.
 *
 * Composes AppShell + NavigationRail + TopBar + ContextBar + BottomNav around each
 * @loopkit/opsui projection, with real data bound at this boundary. Data comes from
 * @loopkit/core (fold + buildSummary + foldCosts + projectVerdicts + projectTrajectory +
 * evaluateSloBoard + runs-dir scans). Projections whose inputs are not available in a given
 * deployment (e.g. a decision-log stream or external metrics) are fed their EMPTY state.
 * The command surface lives at /command; pages are served from the root base path.
 * Document titles read "loopkit ops".
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadAllEventsWithQuarantine,
  fold,
  buildSummary,
  loadConfig,
  loadQuarantine,
  foldCosts,
  projectVerdicts,
  projectTrajectory,
  projectExecutionConfig,
  evaluateSloBoard,
  makeRealProbes,
  makeDeployProbe,
  makeInstanceProbe,
  makeRegistry,
  makeFileHealthFns,
  mergeRoutingConfig,
  buildRoutingTableWithSpecs,
  ROUTING_CONFIG_DEFAULTS,
} from '@loopkit/core';
import type { LoopkitConfig, FoldResult, LedgerEvent, VerdictSummary, SloRow as CoreSloRow } from '@loopkit/core';

import {
  AppShell,
  BottomNav,
  Card,
  esc,
  StatusBadge,
  CommandPalette,
  ContextBar,
  IntentComposerModal,
  NavigationRail,
  TopBar,
  commandProjectionFromFold,
  CommandProjection,
  acceptanceProjectionFromFold,
  AcceptanceProjection,
  workProjectionFromFold,
  WorkProjection,
  registryDestinations,
  formatLocal,
  workforceProjectionFromSummary,
  healthProjectionFromBoard,
  HealthProjection,
  healActivityFromEvents,
  planeObservabilityProjectionFromInput,
  PlaneObservabilityProjection,
  analyticsStripFromData,
  quotaPanelFromCosts,
  companyProjectionFromInput,
  CompanyProjection,
  timelineProjectionFromInput,
  TimelineProjection,
  ThreadDetailProjection,
  threadsProjectionFromFold,
  ThreadsProjection,
  itemHubProjectionFromInput,
  ItemHubProjection,
  artifactsProjectionFromInput,
  projectionRegistry,
  Pagination,
} from '@loopkit/opsui';
import type {
  GlanceWindow,
  FoldSummary,
  FoldThread,
  GlanceMetric,
  WorkforceSummary,
  BuildRecord,
  BeatInfoRaw,
  BreakerRecord,
  BacklogRow,
  ArtifactRow,
  ArtifactKind,
  ArtifactsData,
  ThreadDetailAttachment,
  ThreadDetailData,
  ThreadDetailMessage,
  PlaneObservabilityInput,
  PlaneAcceptSplit,
  PlaneProviderStatus,
  PlaneSalvageFile,
  PlaneManifestCoverage,
  PlaneLedgerHygiene,
  PlaneRoutingData,
  PlaneExecutionConfigData,
  PlaneExecutionConfigRow,
  DecisionCard,
} from '@loopkit/opsui';

// WI-055: legacy-shell convergence reuses views.ts's page-slicer/row-renderer (one paginator,
// one event-row renderer — not a second copy) and html.ts's zero-dependency empty-state helper.
import { paginate, pageHrefFor, timelineEntryRow } from './views.js';
import { emptyState } from './html.js';

// ---------------------------------------------------------------------------
// Shared per-request data bundle — ONE ledger read + fold + summary per GET.
// ---------------------------------------------------------------------------

export interface OpsData {
  events: LedgerEvent[];
  cfg: LoopkitConfig;
  result: FoldResult;
  /** The `loopctl summary --json` shape (buildSummary — the ONE construction), JSON
   *  round-tripped so undefined-valued keys are dropped exactly as the CLI wire shape
   *  drops them (the opsui fold-adapter validates the wire shape). */
  fold: FoldSummary;
}

export async function loadOpsData(ledgerDir: string, repoRoot: string): Promise<OpsData> {
  const events = await loadAllEventsWithQuarantine(ledgerDir);
  const cfg = loadConfig(repoRoot);
  const result = fold(events, { defaultTarget: cfg.defaultTarget });
  const summary = buildSummary(result, events, { cfg, repoRoot });
  const foldSummary = JSON.parse(JSON.stringify(summary)) as FoldSummary;
  return { events, cfg, result, fold: foldSummary };
}

/** Nav/page title single source: section page titles derive from the projection registry —
 *  the same field the sidebar nav renders — so a retitle can never split the nav label from
 *  the page header. */
function sectionTitle(id: keyof typeof projectionRegistry & string): string {
  return projectionRegistry[id]?.title ?? id;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

/**
 * Find the conversation thread the chat panel is addressed to. Matches an EXT id against
 * `externalRef` (the operator always addresses an EXT ref) or, as a fallback, a WI id against `id`.
 */
export function findChatThread(foldSummary: FoldSummary, addressee: string): FoldThread | undefined {
  if (!addressee) return undefined;
  return (foldSummary.threads ?? []).find((t) => t.externalRef === addressee || t.id === addressee);
}

// ---------------------------------------------------------------------------
// Shell assembly (opsPalette / composerModal / projectionShell / projectionDocument
// compose the AppShell chrome shared by every page renderer below).
// ---------------------------------------------------------------------------

function opsDestinations(): ReturnType<typeof registryDestinations> {
  // Registry routes already serve at root (base-path swap) — no remap needed.
  return registryDestinations();
}

/** The command palette, populated with every registry destination as a navigate:* action. */
function opsPalette(): string {
  const items = opsDestinations().map((d) => ({
    label: d.title,
    action: `navigate:${d.href}`,
    ...(d.purpose ? { meta: d.purpose } : {}),
  }));
  return CommandPalette({ groups: [{ heading: 'Go to', items }], placeholder: 'Search projections…' });
}

/** The global "drop intent" modal, opened from the TopBar composer trigger on every page.
 *  `next` is the current page's own serving path, so a capture posts back to wherever the
 *  operator opened it from. `targetNames` (the registered target display names) drives the
 *  multi-target selector: with >1 registered, a bare capture must name which plane it's for
 *  (core captureIntent throws otherwise); with 0 or 1, the server stamps the sole target and
 *  no selector shows. */
function composerModal(next: string, targetNames: string[] = []): string {
  return IntentComposerModal({
    action: `/intent?next=${next}`,
    ...(targetNames.length > 1 ? { targets: targetNames } : {}),
  });
}

/** Registered target display NAMES from the fold (what the operator recognizes and what the
 *  server's /intent handler resolves back to a targetId). Mirrors the pre-port console's
 *  `[...result.targets.values()].map(t => t.name)`. */
function targetNamesFrom(data: OpsData): string[] {
  return [...data.result.targets.values()].map((t) => t.name);
}

function projectionDocument(title: string, shellHtml: string, theme: 'dark' | 'light' = 'dark'): string {
  return (
    `<!doctype html><html lang="en" data-theme="${theme}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="/ui-fonts.css">` +
    `<link rel="stylesheet" href="/ui/tokens.css">` +
    `<link rel="stylesheet" href="/ui/components.css">` +
    `<link rel="stylesheet" href="/ui/projections.css">` +
    `<script type="module" src="/ui/shell.js"></script>` +
    `<script src="/ui/composer.js" defer></script>` +
    `<script src="/ui/palette.js" defer></script>` +
    `<script src="/ui/confirm.js" defer></script>` +
    `<script src="/ui/live.js" defer></script>` +
    `</head><body class="opsui-root">${shellHtml}</body></html>`
  );
}

/** Shared AppShell assembly for a projection: rail + TopBar + ContextBar around the
 *  projection workspace, wrapped in the standard projection document. State → visual mapping:
 *  a failed envelope is always `critical`; otherwise `success` (the glance carries the nuance). */
function projectionShell(
  activeId: string,
  title: string,
  workspace: string,
  state: 'fresh' | 'stale' | 'failed',
  generatedAt: string,
  stateLabel: string,
  theme?: string | null,
  targetNames: string[] = [],
): string {
  const destinations = opsDestinations();
  const rail = NavigationRail({ destinations, activeId, expanded: true });
  const topBar = TopBar({ title, breadcrumbs: [{ label: 'Ops', href: '/command' }] });
  const visual = state === 'failed' ? 'critical' : state === 'stale' ? 'warning' : 'success';
  const freshness = state === 'failed'
    ? 'Source unavailable'
    : `Updated ${formatLocal(generatedAt, { seconds: true })}`;
  const contextBar = ContextBar({ state: visual, stateLabel, freshness });
  const bottomNav = BottomNav({ destinations, activeId });
  const composerNext = destinations.find((d) => d.id === activeId)?.href ?? '/command';
  const shell = AppShell({
    rail, topBar, contextBar, workspace, bottomNav,
    palette: opsPalette(),
    composerModal: composerModal(composerNext, targetNames),
    railExpanded: true,
  });
  return projectionDocument(`${title} · loopkit ops`, shell, theme === 'light' ? 'light' : 'dark');
}

// ---------------------------------------------------------------------------
// Fold-derived workforce/backlog builders, fed by the standalone plane's runs dir.
// ---------------------------------------------------------------------------

/** Age in whole seconds of a loopkit beat lock dir (reactor.lock / dispatch.lock) under the
 *  plane's run-state dir, or undefined if the lock has never been taken (dir absent). */
function beatAgeSec(runDir: string, lock: 'reactor.lock' | 'dispatch.lock', now: number): number | undefined {
  try {
    const st = statSync(join(runDir, lock));
    return Math.max(0, Math.round((now - st.mtimeMs) / 1000));
  } catch {
    return undefined;
  }
}

function foldBeats(runDir: string, now: number): BeatInfoRaw[] {
  const reactor = beatAgeSec(runDir, 'reactor.lock', now);
  const dispatch = beatAgeSec(runDir, 'dispatch.lock', now);
  return [
    { name: 'reactor', ...(reactor !== undefined ? { ageSec: reactor } : {}) },
    { name: 'dispatch', ...(dispatch !== undefined ? { ageSec: dispatch } : {}) },
  ];
}

/** Building items → inflight BuildRecords. Elapsed derived from buildingAt vs now; budget from
 *  buildTimeoutMinutes config. Attempt from the fold's attempts count. */
function foldInflight(foldSummary: FoldSummary, now: number, budgetMin: number): BuildRecord[] {
  return foldSummary.active
    .filter((i) => i.state === 'building')
    .map((i) => {
      const started = i.buildingAt ? Date.parse(i.buildingAt) : NaN;
      const elapsedMin = Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 60000)) : undefined;
      return {
        id: i.id,
        attempt: i.attempts ?? 1,
        ...(elapsedMin !== undefined ? { elapsedMin } : {}),
        budgetMin,
        ...(i.branch ? { branch: i.branch } : {}),
        ...(i.touches ? { touches: i.touches } : {}),
      };
    });
}

/** parked items whose reason starts with 'breaker' → BreakerRecord[]. */
function foldBreakers(foldSummary: FoldSummary): BreakerRecord[] {
  return foldSummary.active
    .filter((i) => i.state === 'parked' && (i.parkReason ?? '').trim().toLowerCase().startsWith('breaker'))
    .map((i) => ({
      id: i.id,
      attempts: i.attempts ?? 0,
      ...(i.spec ? { spec: i.spec.slice(0, 120) } : {}),
    }));
}

/** Last N build outcomes from the fold's recent merged/rejected transitions + currently-parked
 *  items. merged → 'merged', rejected → 'rejected', parked → 'parked'; newest first. */
function foldRecentOutcomes(foldSummary: FoldSummary, limit: number): WorkforceSummary['recentOutcomes'] {
  const merged = (foldSummary.recentMerged ?? []).map((m) => ({
    id: m.id,
    outcome: 'merged' as const,
    ...(m.spec ? { spec: m.spec.slice(0, 120) } : {}),
    ...(m.mergedAt ? { at: m.mergedAt } : {}),
  }));
  const rejected = (foldSummary.recentRejected ?? []).map((r) => ({
    id: r.id,
    outcome: 'rejected' as const,
    ...(r.spec ? { spec: r.spec.slice(0, 120) } : {}),
    ...((r as { rejectedAt?: string }).rejectedAt ? { at: (r as { rejectedAt?: string }).rejectedAt } : {}),
  }));
  const parked = foldSummary.active
    .filter((i) => i.state === 'parked')
    .map((i) => ({
      id: i.id,
      outcome: 'parked' as const,
      ...(i.spec ? { spec: i.spec.slice(0, 120) } : {}),
      ...(i.parkedAt ? { at: i.parkedAt } : {}),
    }));
  return [...merged, ...rejected, ...parked]
    .sort((a, b) => ((b as { at?: string }).at ?? '').localeCompare((a as { at?: string }).at ?? ''))
    .slice(0, limit);
}

function buildWorkforceSummary(
  foldSummary: FoldSummary,
  runDir: string,
  now: number,
  budgetMin: number,
): WorkforceSummary {
  return {
    beats: foldBeats(runDir, now),
    inflight: foldInflight(foldSummary, now, budgetMin),
    recentOutcomes: foldRecentOutcomes(foldSummary, 8),
    breakerStates: foldBreakers(foldSummary),
    generatedAt: new Date(now).toISOString(),
  };
}

/** Fold queued + parked items → the groomable backlog. Priority defaults to 'normal'. */
function foldBacklog(foldSummary: FoldSummary): BacklogRow[] {
  return foldSummary.active
    .filter((i) => i.state === 'queued' || i.state === 'parked')
    .map((i) => ({
      id: i.id,
      title: (i.spec ? i.spec.slice(0, 100) : i.id),
      priority: (i.priority ?? 'normal') as BacklogRow['priority'],
      state: i.state as BacklogRow['state'],
    }));
}

// ---------------------------------------------------------------------------
// Artifact scanning (runs dir + per-target namespaces) → opsui ArtifactRow[].
// ---------------------------------------------------------------------------

/** `<WI-NNN>-attempt-<N>.<kind>` — every artifact-suffix the dispatch beat is known to write. */
const OPSUI_ARTIFACT_RE = /^(WI-\d+)-attempt-(\d+)\.(gate\.log|salvage\.patch|salvage\.md|manifest\.json|diff|log)$/;
const TARGET_DIR_RE = /^tgt-[a-z0-9]+$/;

function scanArtifactRows(dir: string): ArtifactRow[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: ArtifactRow[] = [];
  for (const filename of entries) {
    const m = OPSUI_ARTIFACT_RE.exec(filename);
    if (!m) continue;
    try {
      const st = statSync(join(dir, filename));
      rows.push({
        itemId: m[1]!,
        attempt: Number(m[2]),
        kind: m[3] as ArtifactKind,
        filename,
        mtime: new Date(st.mtimeMs).toISOString(),
        sizeBytes: st.size,
      });
    } catch {
      // File vanished between readdir and stat — skip rather than render a broken row.
    }
  }
  return rows;
}

/** Read the real build-artifact listing from the plane's runs dir (untargeted root plus one
 *  level into each per-target namespace) — mtime-sorted newest first, capped at `limit`. */
export function readArtifacts(runsDir: string, limit: number): { artifacts: ArtifactRow[]; truncated: boolean } {
  const rows = scanArtifactRows(runsDir);
  try {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && TARGET_DIR_RE.test(entry.name)) {
        rows.push(...scanArtifactRows(join(runsDir, entry.name)));
      }
    }
  } catch {
    // unreadable runs dir — the root scan already yielded [] in that case
  }
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  const truncated = rows.length > limit;
  return { artifacts: rows.slice(0, limit), truncated };
}

// ---------------------------------------------------------------------------
// SLO board (health page) — the standalone equivalent of `loopctl slo --json`,
// mirroring the CLI's own probe construction so the two can never disagree.
// ---------------------------------------------------------------------------

/** How long a computed SLO board stays valid before the next GET re-probes (WI-055 item 3):
 *  `evaluateSloBoard` runs several real `spawnSync` probes (git rev-parse/rev-list, curl,
 *  the configured plane-check validator) — cheap individually but wasteful to re-run on every `/health` and
 *  `/observability` GET when an operator or a `refreshSeconds` auto-reload is polling. The
 *  the board is cached for the same ~30s window across those polling routes. */
const SLO_CACHE_TTL_MS = 30_000;

interface SloCacheEntry {
  computedAtMs: number;
  rows: CoreSloRow[];
}

/** Keyed by repoRoot+runDir so tests (each with their own temp dirs) never share a cached
 *  board across independent server instances/processes. */
const sloCache = new Map<string, SloCacheEntry>();

/** Clears the in-process SLO cache — test-only escape hatch so a test can force a fresh probe
 *  round without waiting out SLO_CACHE_TTL_MS or fabricating a distinct repoRoot/runDir. */
export function resetSloCacheForTests(): void {
  sloCache.clear();
}

export function computeSloRows(cfg: LoopkitConfig, repoRoot: string, runDir: string, events: LedgerEvent[]): CoreSloRow[] {
  const cacheKey = `${repoRoot} ${runDir}`;
  const now = Date.now();
  const cached = sloCache.get(cacheKey);
  if (cached && now - cached.computedAtMs < SLO_CACHE_TTL_MS) {
    return cached.rows;
  }

  const opsOnly = events.filter((ev) =>
    ev.type.startsWith('slo.') ||
    ev.type.startsWith('heal.') ||
    ev.type === 'loop.beat',
  );
  const probes = makeRealProbes(repoRoot, runDir);
  probes.deploy = makeDeployProbe(repoRoot);
  probes.instanceProbe = makeInstanceProbe();
  const reg = makeRegistry({
    providers: Object.fromEntries(
      Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }]),
    ),
    sensitivityAllowlists: cfg.sensitivityAllowlists,
    chains: cfg.chains,
    cooldownMs: cfg.providerCooldownMs,
  }, makeFileHealthFns(runDir));
  probes.providerHealth = () => {
    // Plane-level health readout of the reference ('internal') routing lane — reads on-disk
    // health markers only, sends nothing to any provider (mirrors the CLI's own probe).
    const chain = reg.chainFor('internal');
    if (chain.length === 0) return { status: 'all-unhealthy' as const };
    const primary = chain[0]!;
    if (!reg.isUnhealthy(primary)) return { status: 'primary-healthy' as const, primaryProvider: primary, activeProvider: primary };
    const allowed = reg.allowedProviders('internal');
    for (let i = 1; i < chain.length; i++) {
      const name = chain[i]!;
      if (!allowed.includes(name)) continue;
      if (!reg.isUnhealthy(name)) {
        return { status: 'fallback-active' as const, primaryProvider: primary, activeProvider: name };
      }
    }
    return { status: 'all-unhealthy' as const };
  };
  const rows = evaluateSloBoard(cfg.slo, probes, opsOnly);
  sloCache.set(cacheKey, { computedAtMs: now, rows });
  return rows;
}

type OpsHealthBoard = {
  rollup: { status: string; label: string; breached: number; atRisk: number };
  panes: Array<{ title: string; rows: CoreSloRow[] }>;
};

/** Fold SLO rows into the board shape the health adapter validates (rollup + panes). */
function buildHealthBoard(sloRows: CoreSloRow[]): OpsHealthBoard {
  let breached = 0;
  let atRisk = 0;
  let met = 0;
  for (const row of sloRows) {
    if (row.status === 'breached') breached++;
    else if (row.status === 'at-risk') atRisk++;
    else if (row.status === 'met') met++;
  }
  const status = breached > 0 ? 'breached' : atRisk > 0 ? 'at-risk' : met > 0 ? 'met' : 'unknown';
  const label = breached > 0
    ? `${breached} breached`
    : atRisk > 0 ? `${atRisk} at risk` : met > 0 ? 'All clear' : 'No data';
  return {
    rollup: { status, label, breached, atRisk },
    panes: sloRows.length ? [{ title: 'Loopkit SLOs', rows: sloRows }] : [],
  };
}

/** Reactor self-heal tier (badges the heal activity feed). Env-only in the standalone plane. */
function readOpsAutonomy(env: NodeJS.ProcessEnv): 'watch' | 'propose' | 'heal' {
  const fromEnv = env['OPS_AUTONOMY'];
  if (fromEnv === 'watch' || fromEnv === 'propose' || fromEnv === 'heal') return fromEnv;
  return 'propose';
}

// ---------------------------------------------------------------------------
// Plane-observability data builders, sourced from core projections + runs-dir scans
// instead of loopctl subprocesses.
// ---------------------------------------------------------------------------

/** Map the routing table shape ({ mode, table }) into the wire rows the adapter expects.
 *  Unknown shape → null (panel renders unavailable). */
export function mapRoutingJson(raw: unknown): PlaneRoutingData {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.mode !== 'string') return null;
  if (Array.isArray(obj.rows)) return obj as unknown as PlaneRoutingData;
  const table = obj.table;
  if (table === null || typeof table !== 'object') return null;
  const rows: Array<{ bucket: string; model: string; samples: number; firstPassPct: number | null; avgCostUsd: number | null }> = [];
  for (const [bucket, models] of Object.entries(table as Record<string, unknown>)) {
    if (models === null || typeof models !== 'object') continue;
    for (const [model, stats] of Object.entries(models as Record<string, unknown>)) {
      if (stats === null || typeof stats !== 'object') continue;
      const s = stats as Record<string, unknown>;
      const samples = typeof s.samples === 'number' ? s.samples : 0;
      rows.push({
        bucket,
        model,
        samples,
        // firstPassPct is already a percent number (0-100), not a 0-1 ratio.
        firstPassPct: typeof s.firstPassRate === 'number' ? Math.round(s.firstPassRate * 1000) / 10 : null,
        avgCostUsd: typeof s.avgUsd === 'number' ? s.avgUsd : null,
      });
    }
  }
  return { mode: obj.mode, rows };
}

/** Map the execution-config projection ({ minSamples, window, cells }) into `rows`.
 *  Unknown shape → null. */
export function mapExecutionConfigJson(raw: unknown): PlaneExecutionConfigData {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.minSamples !== 'number') return null;
  const win = obj.window;
  if (win === null || typeof win !== 'object') return null;
  const w = win as Record<string, unknown>;
  if (typeof w.days !== 'number' || typeof w.from !== 'string' || typeof w.to !== 'string') return null;
  const rawRows = obj.rows ?? obj.cells;
  if (!Array.isArray(rawRows)) return null;
  const rows: PlaneExecutionConfigRow[] = [];
  for (const entry of rawRows) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== 'string' || typeof e.n !== 'number') continue;
    rows.push({
      model: e.model,
      n: e.n,
      ...(typeof e.acceptRate === 'number' ? { acceptRate: e.acceptRate } : {}),
      ...(typeof e.firstPassGateRate === 'number' ? { firstPassGateRate: e.firstPassGateRate } : {}),
      ...(typeof e.costPerAcceptedUsd === 'number' ? { costPerAcceptedUsd: e.costPerAcceptedUsd } : {}),
      ...(typeof e.retriesPerAccept === 'number' ? { retriesPerAccept: e.retriesPerAccept } : {}),
      merged: typeof e.merged === 'number' ? e.merged : 0,
      accepted: typeof e.accepted === 'number' ? e.accepted : 0,
      gated: typeof e.gated === 'number' ? e.gated : 0,
      gatedFirstPass: typeof e.gatedFirstPass === 'number' ? e.gatedFirstPass : 0,
    });
  }
  return { minSamples: obj.minSamples, window: { days: w.days, from: w.from, to: w.to }, rows };
}

/** Build acceptance split from fold summary + verdicts. Fail-soft to null. */
function buildAcceptSplit(foldSummary: FoldSummary, verdicts: VerdictSummary | null): PlaneAcceptSplit | null {
  try {
    const foldAny = foldSummary as unknown as Record<string, unknown>;
    const provisionalFromSummary = typeof foldAny['provisionalAccepted'] === 'number'
      ? (foldAny['provisionalAccepted'] as number)
      : 0;
    const provisionalFromVerdicts = verdicts && typeof verdicts.provisionalAccepted === 'number'
      ? verdicts.provisionalAccepted
      : 0;
    const provisionalAccepted = Math.max(provisionalFromSummary, provisionalFromVerdicts);
    const humanFromCounts = typeof foldSummary.counts['accepted'] === 'number' ? foldSummary.counts['accepted']! : 0;
    const humanFromVerdicts = verdicts
      ? verdicts.rows.filter((r) => r.outcome === 'accepted').length
      : 0;
    const humanAccepted = Math.max(humanFromCounts, humanFromVerdicts);
    return { humanAccepted, provisionalAccepted };
  } catch { return null; }
}

/** Extract provider status from the SLO rows. Fail-soft to null. */
function extractProviderStatus(sloRows: CoreSloRow[] | null): PlaneProviderStatus | null {
  if (!sloRows) return null;
  const row = sloRows.find((r) => r.key === 'provider');
  if (!row) return null;
  const status: NonNullable<PlaneProviderStatus>['status'] =
    row.status === 'met' ? 'met'
    : row.status === 'at-risk' ? 'at-risk'
    : row.status === 'breached' ? 'breached'
    : 'unknown';
  return { status, value: row.value };
}

/** Scan the runs dir (+ per-target namespaces) for salvage patch and note files. */
function readSalvageFiles(runsDir: string): PlaneSalvageFile[] {
  const dirs: string[] = [runsDir];
  try {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && TARGET_DIR_RE.test(entry.name)) dirs.push(join(runsDir, entry.name));
    }
  } catch { return []; }
  const files: PlaneSalvageFile[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const patchMatch = /^(WI-\d+)-attempt-(\d+)\.salvage\.patch$/.exec(name);
      const noteMatch = /^(WI-\d+)-attempt-(\d+)\.salvage\.(?:note|md)$/.exec(name);
      const match = patchMatch ?? noteMatch;
      if (!match) continue;
      let stat;
      try { stat = statSync(join(dir, name)); } catch { continue; }
      files.push({
        wi: match[1]!,
        attempt: Number(match[2]),
        kind: patchMatch ? 'patch' : 'note',
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return files;
}

/** Compute manifest coverage from runs-dir attempt manifests. Fail-soft to null. */
function readManifestCoverage(runsDir: string): PlaneManifestCoverage | null {
  try {
    const dirs: string[] = [runsDir];
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && TARGET_DIR_RE.test(entry.name)) dirs.push(join(runsDir, entry.name));
    }
    let totalAttempts = 0;
    let withManifest = 0;
    let totalConf = 0;
    let confCount = 0;
    for (const dir of dirs) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      totalAttempts += names.filter((n) => /^WI-\d+-attempt-\d+\.log$/.test(n)).length;
      for (const mf of names.filter((n) => /^WI-\d+-attempt-\d+\.manifest\.json$/.test(n))) {
        withManifest++;
        try {
          const parsed = JSON.parse(readFileSync(join(dir, mf), 'utf8')) as { confidence?: number };
          if (typeof parsed.confidence === 'number') {
            totalConf += parsed.confidence;
            confCount++;
          }
        } catch { /* skip */ }
      }
    }
    return {
      withManifest,
      totalAttempts,
      avgConfidence: confCount > 0 ? totalConf / confCount : null,
    };
  } catch { return null; }
}

/** Ledger hygiene: quarantine count + segment sizes + archive mtime. */
function readLedgerHygiene(ledgerDir: string): PlaneLedgerHygiene | null {
  try {
    const quarantinedKnown = loadQuarantine(join(ledgerDir, 'quarantine.json')).size;
    const segments: { name: string; bytes: number }[] = [];
    try {
      for (const name of readdirSync(ledgerDir)) {
        if (!name.endsWith('.jsonl')) continue;
        let sz: number;
        try { sz = statSync(join(ledgerDir, name)).size; } catch { sz = 0; }
        segments.push({ name, bytes: sz });
      }
    } catch { /* fail-soft */ }
    const archiveDir = join(ledgerDir, 'archive');
    let archiveLastMtimeMs: number | null = null;
    if (existsSync(archiveDir)) {
      try {
        let maxMs = 0;
        for (const f of readdirSync(archiveDir)) {
          try { const m = statSync(join(archiveDir, f)).mtimeMs; if (m > maxMs) maxMs = m; } catch { /* skip */ }
        }
        if (maxMs > 0) archiveLastMtimeMs = maxMs;
      } catch { /* fail-soft */ }
    }
    return { quarantinedKnown, segments, archiveLastMtimeMs };
  } catch { return null; }
}

/** Repair-artifact existence per active item with attempts > 1, derived from the artifact scan. */
function readRepairArtifacts(foldSummary: FoldSummary, artifacts: ArtifactRow[]): Array<{ wiId: string; attempts: number; state: string; hasDiff: boolean; hasGateLog: boolean }> {
  return foldSummary.active
    .filter((item) => (item.attempts ?? 0) > 1)
    .map((item) => {
      const n = item.attempts ?? 0;
      const hasDiff = artifacts.some((a) => a.itemId === item.id && a.attempt === n && a.kind === 'diff');
      const hasGateLog = artifacts.some((a) => a.itemId === item.id && a.attempt === n && a.kind === 'gate.log');
      return { wiId: item.id, attempts: n, state: item.state, hasDiff, hasGateLog };
    });
}

/** The routing snapshot ({ mode, table }), equivalent to what `loopctl routing` reports. */
function buildRoutingData(data: OpsData): PlaneRoutingData {
  try {
    const routingCfg = mergeRoutingConfig(data.cfg.routing, ROUTING_CONFIG_DEFAULTS);
    const trajectory = projectTrajectory(data.events, { days: routingCfg.windowDays });
    const specsByWi = new Map<string, string | undefined>(
      Array.from(data.result.items.entries()).map(([id, r]) => [id, r.spec ?? r.sourceText]),
    );
    const table = buildRoutingTableWithSpecs(trajectory.attempts, specsByWi, { windowDays: routingCfg.windowDays });
    return mapRoutingJson({ mode: routingCfg.mode, table });
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Page renderers — one per GET route.
// ---------------------------------------------------------------------------

export interface OpsPageContext {
  ledgerDir: string;
  repoRoot: string;
  /** The plane's runs dir (artifact browse). */
  runsDir: string;
  /** The plane's run-state dir (beat locks, provider health markers) — `<runsDir>/loopkit`. */
  runDir: string;
  env: NodeJS.ProcessEnv;
}

/** Command projection — glance, needs-you desk, recent deliveries, conversations. */
export function renderCommandPage(
  data: OpsData,
  ctx: OpsPageContext,
  capturedId?: string,
  deliveryPage?: number,
  threadsPage?: number,
  windowParam?: string | null,
): string {
  const windowOpt: GlanceWindow | undefined =
    windowParam === '24h' ? '24h' : windowParam === '7d' ? '7d' : windowParam === '30d' ? '30d' : undefined;
  const envelope = commandProjectionFromFold(data.fold, { ledgerSequence: 0, staleAfterSeconds: 45, ...(windowOpt ? { window: windowOpt } : {}) });
  const destinations = opsDestinations();
  const workspace = CommandProjection(envelope, {
    ...(capturedId ? { capturedId } : {}),
    ...(deliveryPage ? { deliveryPage } : {}),
    ...(threadsPage ? { threadsPage } : {}),
    ...(windowOpt ? { window: windowOpt } : {}),
  });
  const rail = NavigationRail({ destinations, activeId: 'command', expanded: true });
  const topBar = TopBar({ title: sectionTitle('command'), breadcrumbs: [{ label: 'Ops', href: '/command' }] });
  const opsHealth = envelope.state === 'failed' ? 'critical' : envelope.data.opsHealth.state;
  const freshness = envelope.state === 'failed'
    ? 'Fold unavailable'
    : `Updated ${formatLocal(envelope.generatedAt, { seconds: true })}`;
  const contextBar = ContextBar({ state: opsHealth, stateLabel: envelope.state === 'failed' ? 'Fold failed' : envelope.data.opsHealth.headline, freshness });
  const bottomNav = BottomNav({ destinations, activeId: 'command' });
  const shell = AppShell({
    rail, topBar, contextBar, workspace, bottomNav,
    palette: opsPalette(),
    composerModal: composerModal('/command', targetNamesFrom(data)),
    railExpanded: true,
  });
  return projectionDocument('Command · loopkit ops', shell);
}

/** Acceptance projection — shipped slices awaiting the operator's verdict. */
export function renderAcceptancePage(data: OpsData, theme?: string | null, filter?: string | null): string {
  const originFilter: 'all' | 'target' | 'plane' | 'other' =
    filter === 'target' ? 'target'
    : filter === 'plane' ? 'plane'
    : filter === 'other' ? 'other'
    : 'all';
  const envelope = acceptanceProjectionFromFold(data.fold, {
    ledgerSequence: 0, staleAfterSeconds: 45, filter: originFilter,
  });
  const destinations = opsDestinations();
  const workspace = AcceptanceProjection(envelope);
  const rail = NavigationRail({ destinations, activeId: 'acceptance', expanded: true });
  const topBar = TopBar({ title: sectionTitle('acceptance'), breadcrumbs: [{ label: 'Ops', href: '/command' }] });
  const pending = envelope.state === 'failed' ? 0 : envelope.data.queue.length;
  const state = envelope.state === 'failed' ? 'critical' : pending ? 'warning' : 'success';
  const freshness = envelope.state === 'failed'
    ? 'Fold unavailable'
    : `Updated ${formatLocal(envelope.generatedAt, { seconds: true })}`;
  const stateLabel = envelope.state === 'failed'
    ? 'Fold failed'
    : pending ? `${pending} to test` : 'All caught up';
  const contextBar = ContextBar({ state, stateLabel, freshness });
  const bottomNav = BottomNav({ destinations, activeId: 'acceptance' });
  const shell = AppShell({
    rail, topBar, contextBar, workspace, bottomNav,
    palette: opsPalette(),
    composerModal: composerModal('/acceptance', targetNamesFrom(data)),
    railExpanded: true,
  });
  return projectionDocument('Acceptance · loopkit ops', shell, theme === 'light' ? 'light' : 'dark');
}

/** "Missions" projection — ONE EventRow board (building → queued → parked) with run-control
 *  verbs, glance metrics, backlog, and the collapsed Engine section (beats + breakers). */
export function renderWorkPage(data: OpsData, ctx: OpsPageContext, theme?: string | null): string {
  const budgetMin = data.cfg.buildTimeoutMinutes ?? 40;
  const workforceSummary = buildWorkforceSummary(data.fold, ctx.runDir, Date.now(), budgetMin);
  const workforceEnvelope = workforceProjectionFromSummary(workforceSummary, { ledgerSequence: 0, staleAfterSeconds: 45 });
  const workforce = workforceEnvelope.state === 'failed' ? undefined : workforceEnvelope.data;
  const backlog = foldBacklog(data.fold);
  const envelope = workProjectionFromFold(data.fold, {
    ledgerSequence: 0, staleAfterSeconds: 45,
    ...(workforce ? { workforce } : {}),
    ...(backlog.length ? { backlog } : {}),
  });
  const destinations = opsDestinations();
  const workspace = WorkProjection(envelope);
  const rail = NavigationRail({ destinations, activeId: 'work', expanded: true });
  const topBar = TopBar({ title: sectionTitle('work'), breadcrumbs: [{ label: 'Ops', href: '/command' }] });
  const active = envelope.state === 'failed' ? 0 : envelope.data.active.length;
  const glance = envelope.state === 'failed' ? [] : envelope.data.glance;
  const opState = envelope.state === 'failed' ? 'critical'
    : glance.some((m: { state: string }) => m.state === 'critical') ? 'critical'
    : glance.some((m: { state: string }) => m.state === 'warning') ? 'warning'
    : active ? 'progress' : 'success';
  const freshness = envelope.state === 'failed'
    ? 'Fold unavailable'
    : `Updated ${formatLocal(envelope.generatedAt, { seconds: true })}`;
  const stateLabel = envelope.state === 'failed'
    ? 'Fold failed'
    : active ? `${active} active` : 'Lane clear';
  const contextBar = ContextBar({ state: opState, stateLabel, freshness });
  const bottomNav = BottomNav({ destinations, activeId: 'work' });
  const shell = AppShell({
    rail, topBar, contextBar, workspace, bottomNav,
    palette: opsPalette(),
    composerModal: composerModal('/work', targetNamesFrom(data)),
    railExpanded: true,
  });
  return projectionDocument('Missions · loopkit ops', shell, theme === 'light' ? 'light' : 'dark');
}

/** Health/System projection — SLO board + heal feed + analytics strip + artifacts region.
 *  Optional panes (product SLIs) are fed their absent state when unused. */
export function renderHealthPage(data: OpsData, ctx: OpsPageContext, theme?: string | null, windowParam?: string | null): string {
  const healWindow: '24h' | '7d' | '30d' | undefined =
    windowParam === '24h' ? '24h' : windowParam === '7d' ? '7d' : windowParam === '30d' ? '30d' : undefined;
  const sloRows = computeSloRows(data.cfg, ctx.repoRoot, ctx.runDir, data.events);
  const board = buildHealthBoard(sloRows);
  const healActivity = healActivityFromEvents(data.events.filter((e) => e.item === 'system')).slice(0, 30);
  const analyticsStrip = buildAnalyticsStrip(data);
  const artifactsData = buildArtifactsData(ctx.runsDir);
  const envelope = healthProjectionFromBoard(board, {
    ledgerSequence: 0, staleAfterSeconds: 300,
    healActivity, opsAutonomy: readOpsAutonomy(ctx.env),
    ...(analyticsStrip.length ? { analyticsStrip } : {}),
    artifacts: artifactsData,
    ...(healWindow ? { window: healWindow } : {}),
  });
  const breached = envelope.state === 'failed' ? 0 : envelope.data.rollup.breached;
  const stateLabel = envelope.state === 'failed' ? 'Board unavailable'
    : breached ? `${breached} breached` : envelope.data.rollup.label;
  return projectionShell('health', sectionTitle('health'), HealthProjection(envelope), envelope.state,
    envelope.generatedAt, stateLabel, theme, targetNamesFrom(data));
}

/** Analytics top strip — quota utilization, spend, first-pass rate, acceptance split,
 *  computed by the SAME reader calls + `analyticsStripFromData` logic Analytics uses. */
function buildAnalyticsStrip(data: OpsData): GlanceMetric[] {
  try {
    const costs = foldCosts(data.events);
    const verdicts = projectVerdicts(data.events);
    const trajectory = projectTrajectory(data.events, { days: 14 });
    const acceptSplit = buildAcceptSplit(data.fold, verdicts);
    const quota = quotaPanelFromCosts(costs as never);
    return analyticsStripFromData({ quota, costs: costs as never, trajectory: trajectory as never, acceptSplit });
  } catch { return []; }
}

/** Real build artifacts (gate logs, diffs, salvage patches) folded into System as a region. */
function buildArtifactsData(runsDir: string): ArtifactsData {
  const { artifacts, truncated } = readArtifacts(runsDir, 50);
  const envelope = artifactsProjectionFromInput(
    { artifacts, truncated },
    { ledgerSequence: 0, generatedAt: new Date().toISOString(), staleAfterSeconds: 45 },
  );
  return envelope.state === 'failed' ? { glance: [], artifacts: [], truncated: false } : envelope.data;
}

/** Analytics (plane observability) — plane spend·judge·trajectory + token/product regions.
 *  Token-usage rows and product metrics have no standalone source → empty/absent state. */
export function renderObservabilityPage(data: OpsData, ctx: OpsPageContext, theme?: string | null): string {
  const costs = foldCosts(data.events);
  const verdicts = projectVerdicts(data.events);
  const trajectory = projectTrajectory(data.events, { days: 14 });
  const budgetUsd = data.cfg.budget?.dispatchDailyUsd;
  const budget = { ...(typeof budgetUsd === 'number' ? { dispatchDailyUsd: budgetUsd } : {}) };
  const { artifacts } = readArtifacts(ctx.runsDir, 500);
  const repairs = readRepairArtifacts(data.fold, artifacts);
  const salvageFiles = readSalvageFiles(ctx.runsDir);
  const manifestCoverage = readManifestCoverage(ctx.runsDir);
  const ledgerHygiene = readLedgerHygiene(ctx.ledgerDir);
  const acceptSplit = buildAcceptSplit(data.fold, verdicts);
  const sloRows = computeSloRows(data.cfg, ctx.repoRoot, ctx.runDir, data.events);
  const providerStatus = extractProviderStatus(sloRows);
  const routing = buildRoutingData(data);
  const executionConfig = mapExecutionConfigJson(projectExecutionConfig(data.events, { days: 30 }));

  const input: PlaneObservabilityInput = {
    generatedAt: data.fold.generatedAt ?? new Date().toISOString(),
    costs: costs as never,
    budget,
    verdicts: JSON.parse(JSON.stringify(verdicts)) as never,
    repairs,
    trajectory: JSON.parse(JSON.stringify(trajectory)) as never,
    activeItems: data.fold.active as never,
    // Token usage rows/trend/transcripts require a host-provided aggregator — no
    // built-in source here, deliberately empty rather than fabricated.
    tokenRows: [],
    trendPoints: [],
    transcriptSizes: [],
    acceptSplit,
    providerStatus,
    salvageFiles,
    manifestCoverage,
    ledgerHygiene,
    routing,
    executionConfig,
  };

  const envelope = planeObservabilityProjectionFromInput(input, {
    ledgerSequence: 0, staleAfterSeconds: 300,
  });

  const stateLabel = envelope.state === 'failed'
    ? 'Unavailable'
    : costs
      ? `$${costs.totalUsd.toFixed(2)} total`
      : 'No cost data';

  return projectionShell('plane-observability', sectionTitle('plane-observability'),
    PlaneObservabilityProjection(envelope),
    envelope.state, envelope.generatedAt, stateLabel, theme, targetNamesFrom(data));
}

/**
 * One operator-configured knowledge source, read server-side (server.ts collectKnowledge).
 * `kind:'markdown'` → a knowledge card; `kind:'decision-log'` → parsed into decision cards.
 * A missing/unreadable file carries `error` (never a throw). This is the input seam between
 * the server's filesystem layer and the pure render below.
 */
export interface KnowledgeSourceRecord {
  /** Grouping key — the target display name, or 'Plane repo' for root-level `paths`. */
  targetName: string;
  /** Human label for the card/region (source `label`, else the file basename). */
  label: string;
  /** Display path (as configured) — the operator's mental key for the source. */
  path: string;
  kind: 'markdown' | 'decision-log';
  /** File body (bounded for markdown; full for a decision log so it parses). Empty on error. */
  content: string;
  /** Modification time (epoch ms) for the freshness note. Absent on error. */
  mtime?: number;
  /** Present when the file was missing/unreadable — renders a warning card, never a crash. */
  error?: string;
}

/** Human-readable "age" of a source's mtime for the card subtitle (e.g. "2h old", "5d old",
 *  "just now"). Absent mtime → empty string. */
function freshnessAge(mtime: number | undefined, now: number): string {
  if (typeof mtime !== 'number') return '';
  const sec = Math.max(0, Math.round((now - mtime) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m old`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h old`;
  return `${Math.round(hr / 24)}d old`;
}

/** Parse a decision-log document into DecisionCards. Two heading conventions are recognized,
 *  matching the two real-world shapes seen in the wild:
 *   (a) id-in-heading — `## RFC-042 — Some title`, `# ADR-001 — Some title`. The block that
 *       follows (until the next such heading) may carry a `Status:` line (Active/Superseded/…)
 *       and a date (ISO or `YYYY-MM-DD`).
 *   (b) date-headed with a metadata line — `### 2026-01-05 — Some title` followed by a body
 *       whose first non-blank line matches `**ID:** D-NNN`, optionally with a trailing
 *       `· **Status:** <word>` fragment (or a separate `**Status:**` line later in the block).
 *       The heading's date and title (the text after the date and dash) feed the card directly.
 *  Both shapes may appear in the same document. The id token is a generic `PREFIX-NNN` —
 *  any uppercase-led prefix (`D-NNN`, `ADR-NNN`, `RFC-NNN`, …) followed by a dash and digits —
 *  so both a single-file append-only log (`D-NNN`) and a per-file ADR-style directory
 *  (`ADR-NNN`, one decision per file) parse under the same function. Decision logs are
 *  append-only, so the source file is always oldest-first in document order; the origin
 *  console rendered newest-first (most recent decision on top), so the parsed blocks are
 *  reversed before returning. A plain reversal (not a sort by parsed date string) is
 *  deliberate: it preserves the correct relative order even for same-day entries, where date
 *  strings alone can't disambiguate. Unparseable input (no decision found in either shape) →
 *  an empty array, so the caller falls back to a markdown card. */
function parseDecisionLog(content: string): DecisionCard[] {
  const lines = content.split('\n');
  const cards: DecisionCard[] = [];
  // Shape (a): a markdown heading (must start with `#`) carrying a PREFIX-NNN id directly.
  const ID_HEAD_RE = /^\s*#{1,6}\s*([A-Z][A-Z0-9]*-\d+)\s*[—:.\-–]?\s*(.*)$/;
  // Shape (b): a markdown heading of the form `<date> — <title>` (no id on the heading itself).
  const DATE_HEAD_RE = /^\s*(#{1,6})\s*(\d{4}-\d{2}-\d{2})\s*[—:.\-–]\s*(.*)$/;
  // The metadata line: `**ID:** PREFIX-NNN` optionally followed by `· **Status:** <word...>`.
  // Note the closing `**` sits *before* the colon (`**ID:**`), not after — bold wraps the label.
  const META_ID_RE = /^\s*\**ID\*{0,2}\s*[:：]\s*\**\s*([A-Z][A-Z0-9]*-\d+)(?:\s*[·•|]\s*\**Status\*{0,2}\s*[:：]\s*\**\s*(\w[\w -]*))?/i;

  type Block = { id: string; title: string; date: string; body: string[] };
  const blocks: Block[] = [];
  let current: { id: string; title: string; date: string } | undefined;
  let body: string[] = [];
  let awaitingMetaId = false;

  const flush = () => {
    if (current) blocks.push({ ...current, body });
  };

  for (const line of lines) {
    const idHead = ID_HEAD_RE.exec(line);
    if (idHead) {
      flush();
      current = { id: idHead[1]!, title: (idHead[2] ?? '').trim(), date: '' };
      body = [];
      awaitingMetaId = false;
      continue;
    }

    const dateHead = DATE_HEAD_RE.exec(line);
    if (dateHead) {
      flush();
      // Provisional block — kept only if the next non-blank line supplies `**ID:**`.
      current = { id: '', title: (dateHead[3] ?? '').trim(), date: dateHead[2]! };
      body = [];
      awaitingMetaId = true;
      continue;
    }

    if (awaitingMetaId) {
      if (line.trim() === '') continue; // tolerate blank lines before the metadata line
      awaitingMetaId = false;
      const metaM = META_ID_RE.exec(line);
      if (metaM && current) {
        current.id = metaM[1]!;
        if (metaM[2]) body.push(`Status: ${metaM[2]}`); // fold inline status into the body scan
        continue; // metadata line itself isn't part of the visible body
      }
      // No id on the first body line → not a decision heading after all; drop it so a stray
      // date-dash heading (e.g. a changelog entry) doesn't produce an id-less card.
      current = undefined;
      body = [];
      continue;
    }

    if (current) body.push(line);
  }
  flush();

  for (const blk of blocks) {
    if (!blk.id) continue; // shape (b) block that never found its **ID:** line
    const bodyText = blk.body.join('\n');
    // `\**` after the colon tolerates a bold-wrapped value (ADR files write `**Status:** active`,
    // wrapping the value itself in `**`, not just the label).
    const statusM = /^\s*(?:[-*]\s*)?\**Status\**\s*[:：]\s*\**\s*(\w[\w -]*)/im.exec(bodyText);
    const rawStatus = statusM?.[1]?.trim() || 'Active';
    // Normalize only the first character to uppercase (ADR files carry lowercase `active`;
    // downstream consumers match the status string exact-case, e.g. `d.status === 'Active'`).
    // The rest of the string is left as-is (e.g. `superseded by ADR-004` → `Superseded by ADR-004`).
    const status = rawStatus.length ? rawStatus[0]!.toUpperCase() + rawStatus.slice(1) : rawStatus;
    const dateM = blk.date || /\b(\d{4}-\d{2}-\d{2})\b/.exec(blk.title + '\n' + bodyText)?.[1];
    cards.push({
      id: blk.id,
      title: blk.title || blk.id,
      date: dateM ?? '',
      status,
    });
  }
  // Reverse to newest-first (the log itself is oldest-first, append-only). A document-order
  // reversal, not a date sort — correct even when multiple entries share a date.
  return cards.reverse();
}

/** The target switcher chips — "All" plus one chip per registered target name, driving
 *  `?target=<name>`. Mirrors the acceptance filter pattern (WI-180) with the same `.opsui`
 *  filter classes, no new visual language. */
function knowledgeTargetChips(targetNames: string[], active: string | null): string {
  const options: Array<{ value: string | null; label: string }> = [
    { value: null, label: 'All' },
    ...targetNames.map((n) => ({ value: n, label: n })),
  ];
  const links = options
    .map((o) => {
      const isActive = (o.value ?? null) === (active ?? null);
      const href = o.value === null ? '?' : `?target=${encodeURIComponent(o.value)}`;
      const cls = `opsui-acceptance__filter-btn${isActive ? ' opsui-acceptance__filter-btn--active' : ''}`;
      return `<a class="${cls}" href="${esc(href)}"` + (isActive ? ` aria-current="true"` : '') + `>${esc(o.label)}</a>`;
    })
    .join('');
  return (
    `<div class="opsui-acceptance__filter" role="group" aria-label="Filter by target">` +
    `<span class="opsui-acceptance__filter-label">Target</span>${links}</div>`
  );
}

/** One markdown knowledge card: title = label, subtitle = basename + freshness, body an
 *  escaped-text excerpt inside a collapsible <details>. Kept as plain as the legacy
 *  renderKnowledge — minimal structure, escaped content. */
function knowledgeMarkdownCard(rec: KnowledgeSourceRecord, now: number): string {
  const age = freshnessAge(rec.mtime, now);
  const base = rec.path.split('/').pop() || rec.path;
  const subtitle = age ? `${base} · ${age}` : base;
  const body =
    `<details class="opsui-knowledge__doc"><summary>Show document</summary>` +
    `<pre class="opsui-knowledge__excerpt">${esc(rec.content)}</pre></details>`;
  return Card({ title: rec.label, subtitle, body });
}

/** An unreadable source → a small warning card (label + "source unreadable"), never a crash. */
function knowledgeErrorCard(rec: KnowledgeSourceRecord): string {
  return Card({
    title: rec.label,
    subtitle: rec.path,
    headerAside: StatusBadge({ state: 'warning', label: 'unreadable' }),
    body: `<p class="opsui-empty">${esc(rec.error ?? 'source unreadable')}</p>`,
  });
}

/** The knowledge region: markdown + error cards, grouped by target when viewing "All".
 *  Decision-log sources are consumed into the projection's Decisions region, not here. */
function knowledgeRegion(records: KnowledgeSourceRecord[], showGroups: boolean, now: number): string {
  const nonDecision = records.filter((r) => r.kind !== 'decision-log' || r.error);
  if (nonDecision.length === 0) return '';
  const renderCard = (r: KnowledgeSourceRecord): string =>
    r.error ? knowledgeErrorCard(r) : knowledgeMarkdownCard(r, now);
  if (!showGroups) {
    return `<div class="opsui-company__knowledge">${nonDecision.map(renderCard).join('')}</div>`;
  }
  const byTarget = new Map<string, KnowledgeSourceRecord[]>();
  for (const r of nonDecision) {
    const list = byTarget.get(r.targetName) ?? [];
    list.push(r);
    byTarget.set(r.targetName, list);
  }
  const groups = [...byTarget.entries()]
    .map(([target, recs]) =>
      Card({
        title: target,
        subtitle: `${recs.length} source${recs.length === 1 ? '' : 's'}`,
        body: recs.map(renderCard).join(''),
      }),
    )
    .join('');
  return `<div class="opsui-company__knowledge">${groups}</div>`;
}

/**
 * Knowledge projection — decision cards + operator-configured knowledge
 * sources. `sources` (server.ts collectKnowledge) are read from the plane's `knowledge`
 * config; undefined → today's honest empty state, unchanged. `?target=` filters the view to
 * one registered target (null = All).
 */
export function renderCompanyPage(
  data: OpsData,
  theme?: string | null,
  sources?: KnowledgeSourceRecord[],
  targetFilter?: string | null,
): string {
  const now = Date.now();
  const targetNames = targetNamesFrom(data);
  // A ?target= naming an actually-registered target (or 'Plane repo' when paths are configured)
  // filters; anything else falls back to All rather than an empty view.
  const knownTargets = new Set([...targetNames, 'Plane repo']);
  const active = targetFilter && knownTargets.has(targetFilter) ? targetFilter : null;

  const all = sources ?? [];
  const filtered = active ? all.filter((r) => r.targetName === active) : all;

  // Decision-log sources → DecisionCards; a decision log that parsed to nothing falls back to
  // a markdown card (handled by knowledgeRegion, which keeps unparsed decision-log records
  // only when they errored — so we re-tag unparseable ones as markdown here).
  let decisions: DecisionCard[] = [];
  const renderRecords: KnowledgeSourceRecord[] = [];
  for (const rec of filtered) {
    if (rec.kind === 'decision-log' && !rec.error) {
      const parsed = parseDecisionLog(rec.content);
      if (parsed.length) {
        decisions.push(...parsed);
      } else {
        // Unparseable decision log → a plain markdown card, never a crash or a silent drop.
        renderRecords.push({ ...rec, kind: 'markdown' });
      }
    } else {
      renderRecords.push(rec);
    }
  }
  // Sort the concatenated set newest-first across ALL sources (WI-066). Each per-file parse
  // above is already newest-first *within* its own file (parseDecisionLog's reversal), which is
  // sufficient for a single-file append-only log (the common case) but not for a glob source
  // (WI-058, one file per decision, e.g. docs/decisions/*.md): `expandKnowledgePattern` sorts
  // matched filenames alphabetically, so without a final sort the concatenated cards would stay
  // in file-name order (ADR-001 before ADR-007) instead of newest-first. A stable numeric sort
  // by the id's trailing digits (not a lexical string sort, which would rank RFC-10 before RFC-2)
  // fixes the glob case and is a no-op for a single well-formed log, where document order and
  // numeric id order already coincide (id-in-heading and date-headed decisions both increase
  // monotonically as the log is appended to).
  decisions = [...decisions].sort((a, b) => {
    const numA = Number(/-(\d+)$/.exec(a.id)?.[1] ?? NaN);
    const numB = Number(/-(\d+)$/.exec(b.id)?.[1] ?? NaN);
    if (Number.isNaN(numA) || Number.isNaN(numB)) return 0; // unparseable id → leave relative order
    return numB - numA;
  });

  // Evidence labels are derived from the actually-configured sources (WI-054 residue kill),
  // not hardcoded doc paths — the adapter's default is a single generic chip.
  const evidenceLabels = [...new Set(all.map((r) => r.label))];
  const evidence = evidenceLabels.length
    ? evidenceLabels.map((label, i) => ({ id: i === 0 ? 'decision-log' : `source-${i}`, kind: 'artifact' as const, label }))
    : [{ id: 'decision-log', kind: 'artifact' as const, label: 'no sources configured' }];
  const envelope = companyProjectionFromInput(
    {
      decisions,
      evidence,
    },
    { ledgerSequence: 0, generatedAt: new Date().toISOString(), staleAfterSeconds: 300 },
  );

  const activeCount = decisions.filter((d) => d.status === 'Active').length;
  const stateLabel =
    sources === undefined
      ? 'no sources configured'
      : activeCount
        ? `${activeCount} active decision${activeCount === 1 ? '' : 's'}`
        : renderRecords.length
          ? `${renderRecords.length} knowledge source${renderRecords.length === 1 ? '' : 's'}`
          : 'no decisions loaded';

  const chips = sources === undefined ? '' : knowledgeTargetChips(targetNames, active);
  const knowledge = knowledgeRegion(renderRecords, active === null, now);
  const workspace = chips + CompanyProjection(envelope) + knowledge;

  return projectionShell('company', sectionTitle('company'), workspace, envelope.state,
    envelope.generatedAt, stateLabel, theme, targetNames);
}

/** Threads projection — full conversation history with inline reply composers. */
export function renderThreadsPage(data: OpsData, page?: number, theme?: string | null): string {
  const envelope = threadsProjectionFromFold(data.fold, { ledgerSequence: 0, staleAfterSeconds: 45 });
  const count = envelope.state === 'failed' ? 0 : envelope.data.threads.length;
  const stateLabel = envelope.state === 'failed'
    ? 'Fold failed'
    : count ? `${count} conversation${count !== 1 ? 's' : ''}` : 'No conversations yet';
  return projectionShell('threads', sectionTitle('threads'),
    ThreadsProjection(envelope, { ...(page ? { page } : {}) }),
    envelope.state, envelope.generatedAt, stateLabel, theme, targetNamesFrom(data));
}

/** Assemble the typed ThreadDetailData for one fold thread — shared by the thread-detail
 *  page and the item hub's conversation region (one attachment-parse + message read). */
function buildThreadDetailData(data: OpsData, thread: FoldThread, itemState: string): ThreadDetailData {
  const externalRef = thread.externalRef ?? thread.id;

  const messages = thread.messages ?? [];
  const firstIn = messages.find((m) => m.direction === 'in');
  const originalText = firstIn?.text ?? '';

  // Parse attachment lines embedded in the original message text:
  // "attachment: EXT-NNN/filename (N bytes)"
  const ATTACH_RE = /^attachment: ([^/\s]+)\/(\S+) \((\d+) bytes\)$/gm;
  const attachments: ThreadDetailAttachment[] = [];
  let am: RegExpExecArray | null;
  while ((am = ATTACH_RE.exec(originalText)) !== null) {
    attachments.push({ externalId: am[1]!, name: am[2]!, bytes: Number(am[3]) });
  }
  const bodyText = originalText.replace(/^attachment: .+$/gm, '').trim();

  // msg.in/msg.out events straight off the already-loaded ledger — both directions (the
  // operator's own follow-up replies land as msg.in events too).
  const messagesOut: ThreadDetailMessage[] = data.events
    .filter((e) => e.item === thread.id && (e.type === 'msg.in' || e.type === 'msg.out'))
    .map((e) => ({
      ts: e.ts,
      direction: e.type === 'msg.out' ? 'out' as const : 'in' as const,
      text: typeof (e.data as Record<string, unknown>)['text'] === 'string'
        ? (e.data as Record<string, unknown>)['text'] as string
        : '',
    }));

  return {
    externalRef,
    wiRef: thread.id,
    itemState,
    ...(firstIn?.ts ? { capturedAt: firstIn.ts } : {}),
    originalText: bodyText,
    attachments,
    messages: messagesOut,
    outCount: thread.outCount,
  };
}

/** Thread detail page — GET /threads/:externalRef. */
export function renderThreadDetailPage(data: OpsData, externalRef: string, theme?: string | null): string {
  const thread = findChatThread(data.fold, externalRef);
  const generatedAt = data.fold.generatedAt;

  if (!thread) {
    const workspace = `<div><p>${escapeHtml(externalRef)} not found in the current fold — it may be too old or not yet synced.</p></div>`;
    return projectionShell('threads', `Thread · ${externalRef}`, workspace, 'failed', generatedAt, 'Not found', theme, targetNamesFrom(data));
  }

  const activeItem = data.fold.active.find((a) => a.id === thread.id);
  const mergedItem = data.fold.recentMerged.find((m) => m.id === thread.id);
  let itemState = 'captured';
  if (activeItem) {
    itemState = activeItem.state;
  } else if (mergedItem) {
    itemState = 'merged';
  } else if (thread.outCount > 0) {
    itemState = 'routed';
  }

  const detail = buildThreadDetailData(data, thread, itemState);
  const workspace = ThreadDetailProjection(detail);

  return projectionShell(
    'threads',
    `${externalRef} · ${thread.id}`,
    workspace,
    'fresh',
    generatedAt,
    `${thread.id} · ${itemState}`,
    theme,
    targetNamesFrom(data),
  );
}

/** Item hub — GET /item/:WI-NNN. The one canonical per-item page: state header, actions,
 *  timeline, conversation, and evidence — composed from the same fold + ledger + artifact
 *  reads every other surface does. */
export function renderItemHubPage(data: OpsData, ctx: OpsPageContext, itemId: string, theme?: string | null): string {
  const nextPath = `/item/${itemId}`;

  const itemEvents = data.events.filter((e) => e.item === itemId);
  const timelineEnvelope = timelineProjectionFromInput(
    { events: itemEvents as never, itemId, generatedAt: new Date().toISOString() },
    { ledgerSequence: 0, staleAfterSeconds: 45 },
  );
  const timelineRows = timelineEnvelope.state === 'failed' ? [] : timelineEnvelope.data.rows;

  const thread = findChatThread(data.fold, itemId);
  let threadData: ThreadDetailData | undefined;
  if (thread) {
    const activeItem = data.fold.active.find((a) => a.id === thread.id);
    const mergedItem = data.fold.recentMerged.find((m) => m.id === thread.id);
    let itemState = 'captured';
    if (activeItem) itemState = activeItem.state;
    else if (mergedItem) itemState = mergedItem.accepted ? 'accepted' : 'merged';
    else if (thread.outCount > 0) itemState = 'routed';
    threadData = buildThreadDetailData(data, thread, itemState);
  }

  const { artifacts: allArtifacts, truncated: allTruncated } = readArtifacts(ctx.runsDir, 500);
  const artifacts = allArtifacts.filter((a) => a.itemId === itemId);
  const artifactsTruncated = allTruncated && artifacts.length > 0 && allArtifacts.length >= 500;

  const envelope = itemHubProjectionFromInput(data.fold, {
    itemId,
    timeline: timelineRows,
    ...(threadData ? { thread: threadData } : {}),
    artifacts,
    artifactsTruncated,
    nextPath,
  }, { ledgerSequence: 0, staleAfterSeconds: 45 });

  const stateLabel = envelope.state === 'failed'
    ? 'Fold unavailable'
    : `${envelope.data.header.stateLabel}`;

  return projectionShell(
    'work',
    `${itemId} · loopkit ops`,
    ItemHubProjection(envelope),
    envelope.state,
    envelope.generatedAt,
    stateLabel,
    theme,
    targetNamesFrom(data),
  );
}

/** Timeline projection — all-items view: most recent 200 events across all work items. */
export function renderTimelinePage(data: OpsData, theme?: string | null): string {
  const recent = [...data.events].slice(-200).reverse();
  const generatedAt = new Date().toISOString();
  const envelope = timelineProjectionFromInput(
    { events: recent as never, generatedAt },
    { ledgerSequence: 0, staleAfterSeconds: 45 },
  );
  const rows = envelope.state === 'failed' ? 0 : envelope.data.rows.length;
  const stateLabel = envelope.state === 'failed'
    ? 'Ledger unavailable'
    : `${rows} recent event${rows !== 1 ? 's' : ''}`;
  return projectionShell('work', 'Timeline', TimelineProjection(envelope), envelope.state,
    envelope.generatedAt, stateLabel, theme, targetNamesFrom(data));
}

// ---------------------------------------------------------------------------
// Legacy shell convergence (WI-055 item 1) — /activity and the write-verb error/404 envelopes
// were the last surfaces still rendering through html.ts's pre-WI-053 `page()` shell (a
// standalone NavigationRail/TopBar/AppShell wiring, /console.css, /ui-components.css). Every
// other route converged onto the @loopkit/opsui shell in WI-053; these three render
// through `projectionShell` too now, on the SAME `/ui/*` stylesheet + script set as every other
// page, so an operator never sees two different chrome styles depending which route 404s or
// which activity page they open.
// ---------------------------------------------------------------------------

const ACTIVITY_PAGE_SIZE = 50;

/**
 * Cross-item activity feed: the whole ledger's events, newest first, one row per event via the
 * SAME `timelineEntryRow` renderer views.ts's per-item timeline uses (@loopkit/ui's EventRow and
 * @loopkit/opsui's EventRow render byte-identical `opsui-eventrow__*` markup, so reusing it here
 * needs no second implementation). Reachable from Health's nav, read-only.
 */
export function renderActivityPage(data: OpsData, now: Date = new Date(), theme?: string | null, url: URL = new URL('http://localhost/activity')): string {
  const { events, result } = data;
  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
  const requestedPage = Number(url.searchParams.get('page')) || 1;
  const { pageItems, page: currentPage, pageCount, total } = paginate(sorted, requestedPage, ACTIVITY_PAGE_SIZE);
  const pager = Pagination({
    page: currentPage,
    pageCount,
    total,
    itemNoun: 'events',
    hrefFor: (p) => pageHrefFor(url, 'page', p),
    label: 'Activity pages',
  });

  const feed = pageItems.length
    ? pageItems
        .map((e) =>
          timelineEntryRow(e, { itemHref: result.items.has(e.item) ? `/item/${encodeURIComponent(e.item)}` : undefined }),
        )
        .join('\n') + pager
    : emptyState('No ledger activity yet', 'Events land here the moment the first item is captured.');

  const workspace = `<h1 class="opsui-page-title">Activity</h1>
<p class="opsui-page-updated">${escapeHtml(String(total))} event(s) across the ledger, newest first</p>
${Card({ title: 'Activity', body: feed })}`;

  return projectionShell(
    'health',
    'Activity',
    workspace,
    'fresh',
    now.toISOString(),
    `${total} event${total !== 1 ? 's' : ''}`,
    theme,
    targetNamesFrom(data),
  );
}

/**
 * Write-verb failure envelope (no such item, wrong item state, verb validation failure) — the
 * console-wide "cannot do that" page, on the shared opsui shell. Always carries a link back to
 * the view the operator came from: on a zero-JS console a dead-end error page would strand them.
 */
export function renderErrorPage(data: OpsData, message: string, backHref: string, theme?: string | null): string {
  const workspace = `<h1 class="opsui-page-title">Cannot do that</h1>
<p>${escapeHtml(message)}</p>
<p><a href="${escapeHtml(backHref)}">← Back</a></p>`;
  return projectionShell('command', 'Cannot do that', workspace, 'failed', new Date().toISOString(), 'Action failed', theme, targetNamesFrom(data));
}

/** 404 envelope, on the shared opsui shell. */
export function renderNotFoundPage(data: OpsData, path: string, theme?: string | null): string {
  const workspace = `<h1 class="opsui-page-title">404</h1><p>No route for <code>${escapeHtml(path)}</code>.</p>`;
  return projectionShell('command', '404 — not found', workspace, 'failed', new Date().toISOString(), 'Not found', theme, targetNamesFrom(data));
}
