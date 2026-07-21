// Plane-observability projection — WI-235.
// Renders the ops-plane instrumentation surface using the design-system
// component idioms (Card, MetricTile, ProjectionFailure, StatusBadge, esc).
// Sections: How-to-read · Spend · Judge · Context packs · Repairs ·
//           Trajectory · Token usage (absorbed from old observability page).
// Fail-soft: each section renders an "unavailable" state when its data is null;
// the outer envelope only fails if the input itself could not be parsed.

import { Card } from '../components/Card.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { formatTokens } from './observability-adapter.ts';
import { laneRowsFromCosts } from './plane-observability-adapter.ts';
import type {
  PlaneObservabilityData,
  PlaneCostsData,
  PlaneVerdictsData,
  PlaneRepairArtifact,
  PlaneTrajectoryData,
  PlaneTokenCostRow,
  PlaneTrendPoint,
  PlaneTranscriptSize,
  PlaneFoldItem,
  PlaneBudgetConfig,
  PlaneAcceptSplit,
  PlaneProviderStatus,
  PlaneSalvageFile,
  PlaneManifestCoverage,
  PlaneLedgerHygiene,
  PlaneRoutingData,
  PlaneExecutionConfigData,
  PlaneCodexData,
  PlaneQuotaData,
  PlanesCacheEfficiencyData,
  PlanesPipelineLatencyData,
} from './plane-observability-adapter.ts';
// ─── Local helpers ────────────────────────────────────────────────────────────

/** Error boundary for region renderers — a thrown region must not crash the page. */
function safeRegion(name: string, fn: () => string): string {
  try {
    return fn();
  } catch {
    return Card({
      title: name,
      body:  `<p class="opsui-plane-obs__unavailable">${esc(name)} region unavailable.</p>`,
    });
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDurationMs(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000)    return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)     return `${Math.round(n / 1_024)} KB`;
  return `${n} B`;
}

// ─── Region renderers ─────────────────────────────────────────────────────────

function glanceRegion(metrics: PlaneObservabilityData['glance']): string {
  return Card({
    variant:  'glance',
    title:    'Ops observability',
    subtitle: 'Spend · Judge · Repairs · Provider',
    body:     `<div class="opsui-glancegrid">${metrics.map((m) => MetricTile(m)).join('')}</div>`,
  });
}

function howToReadRegion(): string {
  const body = `<details class="opsui-plane-obs__howto">
<summary>How to read this page — click to expand</summary>
<div class="opsui-plane-obs__howto-body">
<p>The agent plane records every action as events on the <strong>ledger</strong>
(<code>.ai/ledger/</code>, one <code>.jsonl</code> per month). These panels are
<strong>projections</strong> of those events — they never modify anything, they
count and summarise what already happened.</p>

<h4>Loop labels</h4>
<ul>
<li><strong>reactor</strong> — 30 s heartbeat: routes intents, fires founder verbs, merges approved branches, heals stalls, sends acceptance nudges.</li>
<li><strong>dispatch</strong> — 60 s heartbeat: picks Touches-disjoint queued items, spawns worker agents in git worktrees, gates finished builds.</li>
<li><strong>scout</strong> — lightweight agent the dispatcher spawns to read the repo and write a context pack before the builder starts.</li>
<li><strong>judge</strong> — advisory review agent that reads a finished diff and verdicts pass/fail/scope-creep/test-theatre. No merge-blocking power yet.</li>
<li><strong>interactive</strong> — the founder's own Claude Code CLI sessions (terminal, not a beat). Estimated from transcript token counts against list pricing since usage here is metered against the subscription, not billed per-call — see "By lane" under Spend.</li>
<li><strong>consult / founder-manual</strong> — Codex CLI sessions. "consult" is Codex dispatched from inside this project via a manual/consulting CLI session; "founder-manual" is the founder's own personal Codex CLI use. Both draw on the same subscription quota — see the Codex card.</li>
</ul>

<h4>What each section tells you</h4>
<ul>
<li><strong>Spend</strong> — metering so budgets can be set from measurement, not guesses. The ceiling is unset while the baseline is being measured.</li>
<li><strong>Judge (advisory)</strong> — no power to block merges until its false-alarm rate is proven near zero over a calibration window. Watch <em>false alarms</em> (trend toward 0) and <em>agreement</em> (trend toward high once outcomes accumulate).</li>
<li><strong>Acceptance split</strong> — human accepts are ground truth for judge calibration; provisional accepts are the plane self-accepting its own internals on an evidence ladder. Provisional accepts are excluded from agreement stats. What to watch: provisional accepts should have full evidence trails; a high provisional count with thin evidence is a signal to review.</li>
<li><strong>Provider chain</strong> — the LLM provider health as a circuit-breaker row. Primary healthy = all good; running on fallback = the primary is down and the plane degraded to a fallback provider; no healthy provider = the plane cannot route any LLM call. The breaker self-recovers when the primary comes back (default: Anthropic primary, Ollama degraded fallback).</li>
<li><strong>Context packs</strong> — fraction of dispatched items that had a scout brief before building. Higher coverage → builders start with more context → fewer first-attempt failures.</li>
<li><strong>Repairs</strong> — items that needed more than one build attempt. The evaluator-optimizer loop injects the previous diff + gate log so the repair has evidence of what went wrong.</li>
<li><strong>Salvage</strong> — when a worker is interrupted (crash or timeout) before committing, the dispatcher captures the uncommitted diff as a <code>.salvage.patch</code> file under <code>.ai/runs/loopkit/</code>. The next attempt pre-applies the patch as a suspect draft. Salvage is best-effort; a <code>.salvage.note</code> appears instead when the diff exceeds the size cap.</li>
<li><strong>Manifests</strong> — each worker writes a <code>.manifest.json</code> self-report (files touched, self-reported confidence) on completion. Confidence is data, not a gate — the plane records it but cannot yet act on it. Once enough manifests accumulate with ground-truth outcomes, the confidence scores become meaningful for calibration.</li>
<li><strong>Ledger hygiene</strong> — the raw event log is the truth; telemetry and ops segments archive when old, but work-item segments never do. A quarantined count above zero means some events were malformed and silenced; they do not affect fold correctness.</li>
<li><strong>Quota utilization</strong> — Claude (five_hour/seven_day) and Codex (primary) subscription-quota readings, with a capacity/runway estimate regressed from consecutive same-cycle readings. All $ figures are API-equivalent, not billed charges — the founder pays in quota, not per-call.</li>
<li><strong>Trajectory</strong> — aggregate velocity and quality metrics. The first-pass merge rate is shown against a reference baseline a deployment calibrates from its own history.</li>
<li><strong>Routing panel</strong> — when model routing is enabled, the plane routes different intent buckets to different models (scout → haiku, builder → sonnet, architect → opus) and tracks first-pass rate and cost per bucket. The panel shows advisory stats while the routing logic is being calibrated; it becomes active once per-bucket thresholds are set. Until then, this section shows "coming online".</li>
<li><strong>Token usage</strong> — raw transcript token and cost data from the Claude sessions driving the plane.</li>
</ul>

<h4>Kill switch</h4>
<p>Set <code>LOOPKIT_AUTONOMY=off</code> in <code>.ai/loops/config.env</code> to pause the entire
agent plane (reactor + dispatch both become no-ops). The console and all projections
remain readable — only autonomous action stops. Flip back to <code>on</code> to resume.
If the variable is unset entirely (bare invocation without sourcing config.env), the
beats default to <code>off</code> as a fail-safe.</p>

<h4>Operator controls</h4>
<ol>
<li><strong>Budget ceiling</strong> — set <code>budget.dispatchDailyUsd</code> in <code>loopkit.config.json</code> once a few days of baseline spend data have accumulated (see Spend section).</li>
<li><strong>Judge power</strong> — once the false-alarm cell stays near 0 over a calibration window of verdicts with outcomes, enable the judge as a merge gate.</li>
</ol>
</div>
</details>`;
  return Card({ variant: 'inset', title: 'How to read this page', body });
}

function spendRegion(costs: PlaneCostsData | null, budget: PlaneBudgetConfig): string {
  let body: string;

  if (!costs) {
    body = `<p class="opsui-plane-obs__unavailable">Cost data unavailable — loopctl CLI not found or costs command failed.</p>`;
  } else {
    const todayKey  = new Date().toISOString().slice(0, 10);
    const todayRow  = costs.byDay.find((r) => r.key === todayKey);
    const todayUsd  = todayRow?.usd ?? 0;

    const ceilingHtml = budget.dispatchDailyUsd !== undefined
      ? `<p class="opsui-plane-obs__ceiling">` +
        `Today vs ceiling: ${esc(fmtUsd(todayUsd))} / ${esc(fmtUsd(budget.dispatchDailyUsd))} ` +
        `(${esc(fmtPct(todayUsd / budget.dispatchDailyUsd))})</p>`
      : `<p class="opsui-plane-obs__ceiling opsui-plane-obs__ceiling--unset">` +
        `No ceiling set — measuring baseline (decision due after 2–3 days of data).</p>`;

    const totalLine = `<p class="opsui-plane-obs__total-row">` +
      `Total to date: ${esc(fmtNum(costs.totalTokens))} tokens · ${esc(fmtUsd(costs.totalUsd))} · ${esc(String(costs.totalCalls))} call(s)</p>`;

    const firstDay = costs.byDay[0]?.key;
    const allTimeLabel = firstDay ? `all-time since ${firstDay}` : 'all-time';

    const lanes = laneRowsFromCosts(costs);
    const laneRows = lanes.length === 0
      ? `<tr><td colspan="4"><p class="opsui-plane-obs__empty">No cost events yet.</p></td></tr>`
      : lanes.map((l) =>
          `<tr>` +
          `<td>${esc(l.label)}</td>` +
          `<td class="opsui-plane-obs__num">${esc(fmtNum(l.tokens))}</td>` +
          `<td class="opsui-plane-obs__num">${esc(fmtUsd(l.usd))}</td>` +
          `<td class="opsui-plane-obs__num">${esc(String(l.calls))}</td>` +
          `</tr>`,
        ).join('');

    const laneTable =
      `<p class="opsui-plane-obs__sub-heading">By lane (${esc(allTimeLabel)})</p>` +
      `<p class="opsui-plane-obs__caption">Metered against the Claude subscription, not billed per-call — figures are an API-equivalent estimate.</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Lane</th><th class="opsui-plane-obs__num">Tokens</th><th class="opsui-plane-obs__num">USD</th><th class="opsui-plane-obs__num">Calls</th></tr></thead>` +
      `<tbody>${laneRows}</tbody></table>` +
      `<p class="opsui-plane-obs__muted">Codex usage (consult + founder-manual) is tracked separately below — see "Codex" — since it is metered against a subscription quota, not this Claude spend total.</p>`;

    const loopRows = costs.byLoop.length === 0
      ? `<tr><td colspan="4"><p class="opsui-plane-obs__empty">No cost events yet.</p></td></tr>`
      : costs.byLoop.map((r) =>
          `<tr>` +
          `<td>${esc(r.key)}</td>` +
          `<td class="opsui-plane-obs__num">${esc(fmtNum(r.tokens))}</td>` +
          `<td class="opsui-plane-obs__num">${esc(fmtUsd(r.usd))}</td>` +
          `<td class="opsui-plane-obs__num">${esc(String(r.calls))}</td>` +
          `</tr>`,
        ).join('');

    const dayRows = costs.byDay.slice(-7).reverse().map((r) =>
      `<tr>` +
      `<td>${esc(r.key)}</td>` +
      `<td class="opsui-plane-obs__num">${esc(fmtNum(r.tokens))}</td>` +
      `<td class="opsui-plane-obs__num">${esc(fmtUsd(r.usd))}</td>` +
      `<td class="opsui-plane-obs__num">${esc(String(r.calls))}</td>` +
      `</tr>`,
    ).join('');

    body =
      ceilingHtml + totalLine + laneTable +
      `<p class="opsui-plane-obs__sub-heading">By loop (${esc(allTimeLabel)})</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Loop</th><th class="opsui-plane-obs__num">Tokens</th><th class="opsui-plane-obs__num">USD</th><th class="opsui-plane-obs__num">Calls</th></tr></thead>` +
      `<tbody>${loopRows}</tbody></table>` +
      `<p class="opsui-plane-obs__sub-heading">Last 7 days</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Day</th><th class="opsui-plane-obs__num">Tokens</th><th class="opsui-plane-obs__num">USD</th><th class="opsui-plane-obs__num">Calls</th></tr></thead>` +
      `<tbody>${dayRows || '<tr><td colspan="4"><p class="opsui-plane-obs__empty">No data.</p></td></tr>'}</tbody></table>`;
  }

  const headerAside = costs
    ? StatusBadge({ state: 'neutral', label: `${costs.byLoop.length} loop${costs.byLoop.length !== 1 ? 's' : ''}` })
    : StatusBadge({ state: 'warning', label: 'unavailable' });

  return Card({ title: 'Spend', subtitle: 'Metering — set budget ceiling from measurement', headerAside, body });
}

/**
 * Codex tile (WI-311) — consult count, tokens, and subscription quota used, split by lane
 * (consult = dispatched from inside this project via a manual/consulting CLI session;
 * founder-manual = the founder's own personal Codex CLI use). Both draw on the same quota,
 * so both need to be visible even though only consult is a plane-managed lane.
 */
function codexRegion(codex: PlaneCodexData): string {
  let body: string;

  if (!codex) {
    body = `<p class="opsui-plane-obs__unavailable">No Codex usage recorded yet — the collector reads ~/.codex/sessions and reports here once a session exists.</p>`;
  } else {
    const quotaLine = codex.quotaPercent !== null
      ? `<p class="opsui-plane-obs__caption">Quota used: <strong>${esc(fmtPct(codex.quotaPercent / 100))}</strong> (latest reading — a point-in-time subscription snapshot, never summed across calls).</p>`
      : `<p class="opsui-plane-obs__caption opsui-plane-obs__muted">Quota reading not yet available from any session.</p>`;

    const rows = codex.rows.map((r) =>
      `<tr>` +
      `<td>${esc(r.label)}</td>` +
      `<td class="opsui-plane-obs__num">${esc(fmtNum(r.tokens))}</td>` +
      `<td class="opsui-plane-obs__num">${esc(String(r.calls))}</td>` +
      `</tr>`,
    ).join('');

    body =
      quotaLine +
      `<p class="opsui-plane-obs__total-row">Total: ${esc(fmtNum(codex.totalTokens))} tokens · ${esc(String(codex.totalCalls))} call(s)</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Lane</th><th class="opsui-plane-obs__num">Tokens</th><th class="opsui-plane-obs__num">Calls</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<p class="opsui-plane-obs__muted">No usd figure — Codex is a subscription quota, not billed per call.</p>`;
  }

  const headerAside = codex
    ? StatusBadge({ state: 'neutral', label: `${codex.totalCalls} call${codex.totalCalls !== 1 ? 's' : ''}` })
    : StatusBadge({ state: 'neutral', label: 'no data' });

  return Card({ title: 'Codex', subtitle: 'Consult + founder-manual usage against the shared subscription quota', headerAside, body });
}

const QUOTA_PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const QUOTA_WINDOW_LABELS: Record<string, string> = { five_hour: '5h window', seven_day: '7d window' };

/**
 * Human label for a provider:window row (WI-356). Derives from `windowMinutes` when present
 * (Codex's 'primary' window: 10080min → "7d window") instead of a per-window-key hardcode;
 * falls back to the static map for Claude's known keys, else the raw key as a last resort.
 */
function quotaWindowLabel(window: string, windowMinutes?: number): string {
  if (typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d window`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h window`;
    return `${windowMinutes}m window`;
  }
  return QUOTA_WINDOW_LABELS[window] ?? window;
}

/** "reading 26h old" — Codex is conserved and only refreshes on a consult, so its reading
 *  can be genuinely stale; Claude refreshes every ~5min during a session. */
function fmtReadingAge(hours: number): string {
  return `reading ${Math.round(hours)}h old`;
}

/**
 * Unified quota panel (WI-314) — utilization bar + capacity/runway estimate per
 * provider:window, across both subscriptions (Claude five_hour/seven_day via statusline.py,
 * Codex primary via the WI-311 collector). All $ figures are API-equivalent estimates,
 * never a billed charge — the founder pays in quota, not per-call dollars.
 */
function quotaRegion(quota: PlaneQuotaData): string {
  let body: string;

  if (!quota || quota.rows.length === 0) {
    body = `<p class="opsui-plane-obs__unavailable">No quota snapshots yet — collectors are warming up.</p>`;
  } else {
    const rows = quota.rows.map((r) => {
      const pct = Math.max(0, Math.min(100, r.usedPct));
      const barState = pct >= 85 ? 'critical' : pct >= 60 ? 'warning' : 'neutral';
      const label = `${QUOTA_PROVIDER_LABELS[r.provider] ?? r.provider} · ${quotaWindowLabel(r.window, r.windowMinutes)}`;
      const stale = r.readingAgeHours !== undefined && r.readingAgeHours >= 24;
      const ageBadge = StatusBadge({
        state: r.readingAgeHours === undefined ? 'neutral' : stale ? 'warning' : 'neutral',
        label: r.readingAgeHours === undefined ? 'age unknown' : fmtReadingAge(r.readingAgeHours),
        size: 'sm',
      });

      const detailParts: string[] = [];
      if (r.capacityTokensPerWeek !== undefined) detailParts.push(`~${esc(fmtNum(r.capacityTokensPerWeek))} tok/wk`);
      if (r.capacityUsdPerWeek !== undefined) detailParts.push(`~${esc(fmtUsd(r.capacityUsdPerWeek))}/wk (API-equivalent)`);
      if (r.runwayDays !== undefined) detailParts.push(`runway ~${esc(r.runwayDays.toFixed(1))}d`);
      if (r.resetsAt) detailParts.push(`resets ${esc(r.resetsAt)}`);
      const detail = detailParts.length > 0
        ? `<p class="opsui-plane-obs__muted">${detailParts.join(' · ')}</p>`
        : `<p class="opsui-plane-obs__muted">Capacity estimate pending — needs a second same-cycle reading.</p>`;

      return (
        `<div class="opsui-plane-obs__quota-row">` +
        `<div class="opsui-plane-obs__quota-row-head">` +
        `<span class="opsui-plane-obs__quota-label">${esc(label)}</span>` +
        `<span class="opsui-plane-obs__quota-pct">${esc(fmtPct(pct / 100))}</span>` +
        `${ageBadge}` +
        `</div>` +
        `<div class="opsui-plane-obs__quota-bar"><div class="opsui-plane-obs__quota-bar-fill opsui-plane-obs__quota-bar-fill--${barState}" style="width:${pct}%"></div></div>` +
        detail +
        `</div>`
      );
    }).join('');

    body =
      `<p class="opsui-plane-obs__caption">Unified subscription-quota view — Claude (five_hour + seven_day) and Codex (primary). ` +
      `All $ figures are API-equivalent estimates, not billed charges (the founder pays in quota, not per-call).</p>` +
      rows;
  }

  const headerAside = quota
    ? StatusBadge({ state: 'neutral', label: `${quota.rows.length} window${quota.rows.length !== 1 ? 's' : ''}` })
    : StatusBadge({ state: 'neutral', label: 'no data' });

  return Card({ title: 'Quota utilization', subtitle: 'Claude + Codex subscription capacity and runway', headerAside, body });
}

/**
 * Cache-read efficiency per loop (WI-315). `cacheHitPercent` is null for any loop whose
 * cost.usage events never carried `cachedInputTokens` — today that's every Claude CLI loop
 * (dispatch/reactor/scout/judge/interactive): extractUsage() in claudeCli.ts merges cache-read
 * + cache-creation into a single `in` figure before it reaches the ledger, so the split isn't
 * recoverable here. Only the Codex collector (WI-311) populates the field. Cache-write
 * (prompt-cache creation) isn't tracked anywhere in the ledger yet — deliberately omitted
 * rather than shown as a fabricated zero.
 */
function cacheEfficiencyRegion(data: PlanesCacheEfficiencyData): string {
  let body: string;

  if (!data || data.rows.length === 0) {
    body = `<p class="opsui-plane-obs__unavailable">No cost.usage events recorded yet.</p>`;
  } else {
    const rowsHtml = data.rows.map((row) => {
      const hit = row.cacheHitPercent !== null
        ? esc(fmtPct(row.cacheHitPercent / 100))
        : `<span class="opsui-plane-obs__muted">not instrumented</span>`;
      return (
        `<tr>` +
        `<td>${esc(row.loop)}</td>` +
        `<td class="opsui-plane-obs__num">${hit}</td>` +
        `<td class="opsui-plane-obs__num">${esc(fmtNum(row.cacheReadTokens))}</td>` +
        `<td class="opsui-plane-obs__num">${esc(fmtNum(row.totalTokens))}</td>` +
        `</tr>`
      );
    }).join('');

    body =
      `<p class="opsui-plane-obs__caption">Cache-read hit % per loop, from cost.usage.cachedInputTokens. ` +
      `Only the Codex collector (WI-311) reports this today — Claude CLI loops show "not instrumented" ` +
      `until the read/write split is threaded through the ledger. Cache-write isn't tracked yet.</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Loop</th><th class="opsui-plane-obs__num">Cache hit %</th>` +
      `<th class="opsui-plane-obs__num">Cache-read tokens</th><th class="opsui-plane-obs__num">Total tokens</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`;
  }

  const headerAside = data
    ? StatusBadge({ state: 'neutral', label: `${data.rows.length} loop${data.rows.length !== 1 ? 's' : ''}` })
    : StatusBadge({ state: 'neutral', label: 'no data' });

  return Card({ title: 'Cache efficiency', subtitle: 'Prompt-cache read hit rate per loop', headerAside, body });
}

/**
 * Stage-transition pipeline latency (WI-315) — median + p90 for each captured→queued→
 * building→gated→merged hop, regressed from raw ledger events over the trailing window. A
 * stage is simply absent when zero merged items in the window carry both its endpoint events
 * (crashed/parked builds never reach gate.passed) — never shown as a fabricated 0ms.
 */
function pipelineLatencyRegion(data: PlanesPipelineLatencyData): string {
  let body: string;

  if (!data || data.stages.length === 0) {
    body = `<p class="opsui-plane-obs__unavailable">No merged items with complete stage timestamps in the window yet.</p>`;
  } else {
    const rowsHtml = data.stages.map((stage) =>
      `<tr>` +
      `<td>${esc(stage.name)}</td>` +
      `<td class="opsui-plane-obs__num">${esc(String(stage.samples))}</td>` +
      `<td class="opsui-plane-obs__num">${esc(fmtDurationMs(stage.medianMs))}</td>` +
      `<td class="opsui-plane-obs__num">${esc(fmtDurationMs(stage.p90Ms))}</td>` +
      `</tr>`,
    ).join('');

    body =
      `<p class="opsui-plane-obs__caption">Stage-transition latency over the trailing ${esc(String(data.window.days))} day` +
      `${data.window.days !== 1 ? 's' : ''} (${esc(data.window.from)} – ${esc(data.window.to)}). ` +
      `A transition is omitted per-item when either endpoint event is missing.</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Stage</th><th class="opsui-plane-obs__num">Samples</th>` +
      `<th class="opsui-plane-obs__num">Median</th><th class="opsui-plane-obs__num">p90</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`;
  }

  const headerAside = data
    ? StatusBadge({ state: 'neutral', label: `${data.stages.length} stage${data.stages.length !== 1 ? 's' : ''}` })
    : StatusBadge({ state: 'neutral', label: 'no data' });

  return Card({ title: 'Pipeline latency', subtitle: 'Stage-transition timing — median + p90', headerAside, body });
}

function judgeRegion(verdicts: PlaneVerdictsData | null): string {
  let body: string;

  if (!verdicts) {
    body = `<p class="opsui-plane-obs__unavailable">Judge data unavailable — loopctl CLI not found or verdicts command failed.</p>`;
  } else {
    const summaryHtml =
      `<div class="opsui-plane-obs__judge-summary">` +
      `<span>Total verdicts: <strong>${esc(String(verdicts.total))}</strong></span>` +
      `<span>Judged fail: <strong>${esc(String(verdicts.judgedFail))}</strong></span>` +
      `<span>With outcome: <strong>${esc(String(verdicts.withOutcome))}</strong></span>` +
      (verdicts.withOutcome > 0
        ? `<span>False alarms: <strong>${esc(String(verdicts.falseAlarm))}</strong></span>` +
          `<span>Agree (pass+accepted): <strong>${esc(String(verdicts.agreePass))}</strong></span>`
        : `<span class="opsui-plane-obs__muted">No outcomes yet — false-alarm rate unmeasurable.</span>`) +
      `</div>`;

    const last10     = verdicts.rows.slice(-10).reverse();
    const verdictRows = last10.length === 0
      ? `<tr><td colspan="5"><p class="opsui-plane-obs__empty">No verdicts yet.</p></td></tr>`
      : last10.map((row) => {
          const reasonsHtml = (row.reasons ?? []).length > 0
            ? `<details class="opsui-plane-obs__reasons"><summary>Reasons</summary>` +
              `<ul>${(row.reasons!).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>`
            : '';
          const flags = [
            row.scopeCreep   ? `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--warn">scope-creep</span>`   : '',
            row.testTheatre  ? `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--warn">test-theatre</span>`  : '',
          ].filter(Boolean).join(' ');
          const verdictKey  = typeof row.verdict === 'string' ? row.verdict.toLowerCase() : row.verdict;
          const verdictClass = `opsui-plane-obs__verdict opsui-plane-obs__verdict--${esc(verdictKey)}`;
          return `<tr>` +
            `<td>${esc(row.item)}</td>` +
            `<td><span class="${verdictClass}">${esc(row.verdict)}</span></td>` +
            `<td class="opsui-plane-obs__num">${row.confidence !== undefined ? esc(String(row.confidence)) : '—'}</td>` +
            `<td>${flags}${reasonsHtml}</td>` +
            `<td>${row.outcome ? esc(row.outcome) : `<span class="opsui-plane-obs__muted">none yet</span>`}</td>` +
            `</tr>`;
        }).join('');

    body =
      summaryHtml +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>WI</th><th>Verdict</th><th class="opsui-plane-obs__num">Conf</th><th>Flags / Reasons</th><th>Outcome</th></tr></thead>` +
      `<tbody>${verdictRows}</tbody></table>`;
  }

  const judgeAside = `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--advisory">ADVISORY</span>`;
  return Card({
    title:       'Judge',
    subtitle:    'No merge-blocking power until false-alarm rate is proven near zero',
    headerAside: judgeAside,
    body,
  });
}

function contextPacksRegion(activeItems: PlaneFoldItem[], costs: PlaneCostsData | null): string {
  const buildingItems = activeItems.filter(
    (i) => i['state'] === 'building' || i['state'] === 'queued' || i['state'] === 'approved',
  );
  const withBrief     = activeItems.filter((i) => Boolean(i['brief'])).length;
  const totalActive   = activeItems.length;
  const scoutRow      = costs?.byLoop.find((r) => r.key === 'scout');

  const body =
    `<p class="opsui-plane-obs__caption">Scout warm-start packs — what to watch: coverage rising and first-pass merges improving.</p>` +
    `<div class="opsui-plane-obs__context-stats">` +
    `<span>Items with a brief: <strong>${esc(String(withBrief))}</strong> of ${esc(String(totalActive))} active</span>` +
    (scoutRow
      ? `<span>Scout spend: <strong>${esc(fmtUsd(scoutRow.usd))}</strong> (${esc(fmtNum(scoutRow.tokens))} tokens · ${esc(String(scoutRow.calls))} call${scoutRow.calls !== 1 ? 's' : ''})</span>`
      : `<span class="opsui-plane-obs__muted">Scout spend: no cost events for "scout" loop yet.</span>`) +
    `</div>` +
    (buildingItems.length > 0
      ? `<p class="opsui-plane-obs__muted">In-flight or queued: ${esc(String(buildingItems.length))} item${buildingItems.length !== 1 ? 's' : ''}.</p>`
      : '') +
    `<p class="opsui-plane-obs__muted">Brief coverage grows as WI-218 context-pack events accumulate on the ledger.</p>`;

  return Card({ title: 'Context packs', subtitle: 'Scout warm-start coverage', body });
}

function repairsRegion(repairs: PlaneRepairArtifact[]): string {
  let body: string;

  if (repairs.length === 0) {
    body = `<p class="opsui-plane-obs__empty">No items with multiple build attempts at this time.</p>`;
  } else {
    const rows = repairs.map((r) => {
      const artifacts = [
        r.hasDiff
          ? `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--ok">diff</span>`
          : `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--missing">no diff</span>`,
        r.hasGateLog
          ? `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--ok">gate.log</span>`
          : `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--missing">no gate.log</span>`,
      ].join(' ');
      return `<tr>` +
        `<td>${esc(r.wiId)}</td>` +
        `<td class="opsui-plane-obs__num">${esc(String(r.attempts))}</td>` +
        `<td>${esc(r.state)}</td>` +
        `<td>${artifacts}</td>` +
        `</tr>`;
    }).join('');
    body =
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>WI</th><th class="opsui-plane-obs__num">Attempts</th><th>State</th><th>Evidence artifacts</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }

  const headerAside = StatusBadge({
    state: repairs.length > 0 ? 'warning' : 'success',
    label: `${repairs.length} repair${repairs.length !== 1 ? 's' : ''}`,
  });
  return Card({
    title:       'Repairs',
    subtitle:    'Items with attempt > 1 — evaluator-optimizer injects prior diff + gate log',
    headerAside,
    body,
  });
}

function trajectoryRegion(trajectory: PlaneTrajectoryData | null | 'absent'): string {
  let body: string;
  // Reference target for the first-pass merge rate. A neutral 50% placeholder — a deployment
  // sets its own baseline once it has measured its own calibration window.
  const FIRST_PASS_BASELINE = 0.5;

  if (trajectory === 'absent' || trajectory === null) {
    body = `<p class="opsui-plane-obs__unavailable">Coming online.${trajectory === null ? ' (CLI responded with an error.)' : ''}</p>`;
  } else {
    const t = trajectory as PlaneTrajectoryData;
    const cells: [string, string | null, string | null][] = [
      ['First-pass merge rate',
        t.firstPassMergeRate !== undefined ? fmtPct(t.firstPassMergeRate) : null,
        `baseline ${fmtPct(FIRST_PASS_BASELINE)}`],
      ['Repair merge rate',
        t.repairMergeRate !== undefined ? fmtPct(t.repairMergeRate) : null,
        null],
      ['Avg cost / merged',
        t.avgCostPerMergedUsd !== undefined ? fmtUsd(t.avgCostPerMergedUsd) : null,
        null],
      ['Avg turns',
        t.avgTurns !== undefined ? String(t.avgTurns) : null,
        null],
      ['Scout coverage',
        t.scoutCoverage !== undefined ? fmtPct(t.scoutCoverage) : null,
        null],
    ];
    const rows = cells.map(([label, value, note]) =>
      `<tr>` +
      `<td>${esc(label)}${note ? ` <span class="opsui-plane-obs__muted">(${esc(note)})</span>` : ''}</td>` +
      `<td class="opsui-plane-obs__num">${value !== null ? esc(value) : `<span class="opsui-plane-obs__muted">—</span>`}</td>` +
      `</tr>`,
    ).join('');
    body =
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Metric</th><th class="opsui-plane-obs__num">Value</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }

  return Card({ title: 'Trajectory', subtitle: 'Aggregate velocity and quality metrics', body });
}

function tokenUsageRegion(
  tokenRows: PlaneTokenCostRow[],
  trendPoints: PlaneTrendPoint[],
  transcriptSizes: PlaneTranscriptSize[],
): string {
  // Token rows table
  const totalTokens = tokenRows.reduce((s, r) => s + r.tokens, 0);
  const totalUsd    = tokenRows.reduce((s, r) => s + r.usd, 0);
  const rowsHtml =
    tokenRows.length === 0
      ? `<p class="opsui-plane-obs__empty">No token usage rows.</p>`
      : `<table class="opsui-plane-obs__table">` +
        `<thead><tr><th>Loop</th><th>Provider</th><th class="opsui-plane-obs__num">Tokens</th><th class="opsui-plane-obs__num">Cost</th></tr></thead>` +
        `<tbody>` +
        tokenRows.map((r) =>
          `<tr>` +
          `<td>${esc(r.loop)}</td>` +
          `<td>${esc(r.provider)}</td>` +
          `<td class="opsui-plane-obs__num">${esc(formatTokens(r.tokens))}</td>` +
          `<td class="opsui-plane-obs__num">$${r.usd.toFixed(3)}</td>` +
          `</tr>`,
        ).join('') +
        `</tbody>` +
        (tokenRows.length > 1
          ? `<tfoot><tr>` +
            `<td colspan="2" style="font-weight:600">Total</td>` +
            `<td class="opsui-plane-obs__num" style="font-weight:600">${esc(formatTokens(totalTokens))}</td>` +
            `<td class="opsui-plane-obs__num" style="font-weight:600">$${totalUsd.toFixed(3)}</td>` +
            `</tr></tfoot>`
          : '') +
        `</table>`;

  // Sparkline chart
  let chartHtml: string;
  if (trendPoints.length < 2) {
    chartHtml = `<p class="opsui-plane-obs__empty">Not enough trend data (need ≥ 2 days).</p>`;
  } else {
    const W = 200, H = 48, PAD = 3;
    const maxUsd = Math.max(...trendPoints.map((p) => p.usd), 0.001);
    const n      = trendPoints.length;
    const xs = trendPoints.map((_, i) => PAD + (i / (n - 1)) * (W - PAD * 2));
    const ys = trendPoints.map((p) => PAD + (1 - p.usd / maxUsd) * (H - PAD * 2));
    const linePoints = xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ');
    const areaPoints = [
      `${xs[0]!.toFixed(1)},${(H - PAD).toFixed(1)}`,
      ...xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`),
      `${xs[n - 1]!.toFixed(1)},${(H - PAD).toFixed(1)}`,
    ].join(' ');
    const svg =
      `<svg class="opsui-plane-obs__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      `<polygon class="opsui-plane-obs__svg-area" points="${areaPoints}"/>` +
      `<polyline class="opsui-plane-obs__svg-line" points="${linePoints}"/>` +
      `</svg>`;
    const firstDate = esc(trendPoints[0]!.date.slice(5, 10));
    const lastDate  = esc(trendPoints[n - 1]!.date.slice(5, 10));
    chartHtml =
      `<p class="opsui-plane-obs__sub-heading">7-day cost trend</p>` +
      `<div class="opsui-plane-obs__chart">${svg}` +
      `<div class="opsui-plane-obs__chart-dates"><span>${firstDate}</span><span>${lastDate}</span></div>` +
      `</div>`;
  }

  // Transcript sizes
  const sizesHtml =
    transcriptSizes.length === 0
      ? `<p class="opsui-plane-obs__empty">No transcript size data.</p>`
      : `<p class="opsui-plane-obs__sub-heading">Transcript sizes</p>` +
        `<ul class="opsui-plane-obs__sizes" role="list">` +
        transcriptSizes.map((s) =>
          `<li class="opsui-plane-obs__size-row">` +
          `<span class="opsui-plane-obs__size-label">${esc(s.label)}</span>` +
          `<span class="opsui-plane-obs__size-value">${esc(formatBytes(s.bytes))}</span>` +
          `</li>`,
        ).join('') +
        `</ul>`;

  const headerAside = StatusBadge({
    state: tokenRows.length ? 'neutral' : 'warning',
    label: `${tokenRows.length} row${tokenRows.length !== 1 ? 's' : ''}`,
  });

  return Card({
    title:       'Token usage',
    subtitle:    'Claude transcript usage — per-loop/provider cost breakdown',
    headerAside,
    body:        rowsHtml + chartHtml + sizesHtml,
  });
}

// ── WI-237: New section renderers ─────────────────────────────────────────────

function acceptSplitRegion(split: PlaneAcceptSplit | null, verdicts: PlaneVerdictsData | null): string {
  let body: string;
  if (!split && !verdicts) {
    body = `<p class="opsui-plane-obs__unavailable">Acceptance split unavailable — loopctl CLI not found or summary/verdicts command failed.</p>`;
  } else {
    const human        = split?.humanAccepted        ?? 0;
    const provisional  = split?.provisionalAccepted  ?? verdicts?.provisionalAccepted ?? 0;
    const total        = human + provisional;

    body =
      `<p class="opsui-plane-obs__caption">The plane may self-accept only its own internals on an evidence ladder. ` +
      `Provisional accepts are excluded from judge calibration — only human accepts count as ground truth.</p>` +
      `<div class="opsui-plane-obs__judge-summary">` +
      `<span>Human accepts: <strong>${esc(String(human))}</strong></span>` +
      `<span>Provisional accepts: <strong>${esc(String(provisional))}</strong></span>` +
      `<span>Total: <strong>${esc(String(total))}</strong></span>` +
      (provisional > 0
        ? `<span class="opsui-plane-obs__muted">Watch: provisional accepts should have full evidence trails.</span>`
        : `<span class="opsui-plane-obs__muted">No provisional accepts — only human ground truth so far.</span>`) +
      `</div>`;
  }

  return Card({ title: 'Acceptance split', subtitle: 'Human vs provisional accepts', body });
}

function providerStatusRegion(providerStatus: PlaneProviderStatus | null): string {
  let body: string;

  if (!providerStatus) {
    body = `<p class="opsui-plane-obs__unavailable">Provider chain status unavailable — loopctl CLI not found or slo command failed.</p>`;
  } else {
    const stateClass =
      providerStatus.status === 'met'      ? 'opsui-plane-obs__tag--ok'
      : providerStatus.status === 'at-risk' ? 'opsui-plane-obs__tag--warn'
      : providerStatus.status === 'breached' ? 'opsui-plane-obs__tag--missing'
      : '';
    const label =
      providerStatus.status === 'met'       ? 'Primary healthy'
      : providerStatus.status === 'at-risk'  ? 'Running on fallback'
      : providerStatus.status === 'breached' ? 'No healthy provider'
      : 'Unknown';

    body =
      `<p class="opsui-plane-obs__caption">Circuit breaker with self-recovery. ` +
      `Primary healthy = all good; running on fallback = primary down, degraded routing; ` +
      `no healthy provider = all LLM calls blocked.</p>` +
      `<div class="opsui-plane-obs__judge-summary">` +
      `<span>Status: <span class="opsui-plane-obs__tag ${stateClass}">${esc(label)}</span></span>` +
      `<span>Value: <strong>${esc(providerStatus.value)}</strong></span>` +
      `</div>`;
  }

  const headerAside = providerStatus
    ? StatusBadge({
        state: providerStatus.status === 'met' ? 'success'
          : providerStatus.status === 'at-risk' ? 'warning'
          : providerStatus.status === 'breached' ? 'critical'
          : 'neutral',
        label: providerStatus.status,
      })
    : StatusBadge({ state: 'warning', label: 'unavailable' });

  return Card({ title: 'Provider chain', subtitle: 'LLM provider health — circuit breaker with self-recovery', headerAside, body });
}

function salvageRegion(salvageFiles: PlaneSalvageFile[]): string {
  let body: string;
  if (salvageFiles.length === 0) {
    body = `<p class="opsui-plane-obs__empty">No salvage files — no interrupted attempts since the last cleanup.</p>`;
  } else {
    // Sort by mtime descending (most recent first), take last 10
    const sorted = [...salvageFiles].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10);
    const rows = sorted.map((f) => {
      const date = new Date(f.mtimeMs);
      const dateStr = `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
      const kindClass = f.kind === 'patch' ? 'opsui-plane-obs__tag--ok' : 'opsui-plane-obs__tag--warn';
      return `<tr>` +
        `<td>${esc(f.wi)}</td>` +
        `<td class="opsui-plane-obs__num">${esc(String(f.attempt))}</td>` +
        `<td><span class="opsui-plane-obs__tag ${kindClass}">${esc(f.kind)}</span></td>` +
        `<td class="opsui-plane-obs__num">${esc(String(Math.round(f.bytes / 1024))) + ' KB'}</td>` +
        `<td class="opsui-plane-obs__muted">${esc(dateStr)}</td>` +
        `</tr>`;
    }).join('');
    body =
      `<p class="opsui-plane-obs__caption">Interrupted attempts leave patches; retries pre-apply them as suspect drafts.</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>WI</th><th class="opsui-plane-obs__num">Attempt</th><th>Kind</th><th class="opsui-plane-obs__num">Size</th><th>When</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }

  const headerAside = StatusBadge({
    state: salvageFiles.length > 0 ? 'warning' : 'success',
    label: `${salvageFiles.length} file${salvageFiles.length !== 1 ? 's' : ''}`,
  });
  return Card({ title: 'Salvage activity', subtitle: 'Uncommitted partial work from interrupted attempts', headerAside, body });
}

function manifestRegion(coverage: PlaneManifestCoverage | null): string {
  let body: string;
  if (!coverage) {
    body = `<p class="opsui-plane-obs__unavailable">Manifest coverage unavailable — no attempt logs found or runs directory missing.</p>`;
  } else {
    const pct = coverage.totalAttempts > 0
      ? ((coverage.withManifest / coverage.totalAttempts) * 100).toFixed(1)
      : '—';
    const avgConf = coverage.avgConfidence !== null
      ? `${(coverage.avgConfidence * 100).toFixed(1)}%`
      : '—';

    body =
      `<p class="opsui-plane-obs__caption">Worker self-reports — recorded, powerless until calibrated. ` +
      `Confidence is data: once enough manifests accumulate with ground-truth outcomes, it becomes meaningful.</p>` +
      `<div class="opsui-plane-obs__judge-summary">` +
      `<span>Attempts with manifest: <strong>${esc(String(coverage.withManifest))}</strong> of ${esc(String(coverage.totalAttempts))}</span>` +
      (coverage.totalAttempts > 0
        ? `<span>Coverage: <strong>${esc(pct)}%</strong></span>`
        : '') +
      `<span>Avg self-reported confidence: <strong>${esc(avgConf)}</strong></span>` +
      `</div>`;
  }

  return Card({ title: 'Manifest coverage', subtitle: 'Worker self-reported files + confidence', body });
}

function ledgerHygieneRegion(hygiene: PlaneLedgerHygiene | null): string {
  let body: string;
  if (!hygiene) {
    body = `<p class="opsui-plane-obs__unavailable">Ledger hygiene data unavailable.</p>`;
  } else {
    const totalBytes = hygiene.segments.reduce((s, seg) => s + seg.bytes, 0);
    const totalMb = (totalBytes / 1_048_576).toFixed(2);
    const archiveStr = hygiene.archiveLastMtimeMs
      ? new Date(hygiene.archiveLastMtimeMs).toISOString().slice(0, 10)
      : 'no archive yet';

    const segRows = hygiene.segments.map((seg) =>
      `<tr>` +
      `<td>${esc(seg.name)}</td>` +
      `<td class="opsui-plane-obs__num">${esc((seg.bytes / 1_048_576).toFixed(2))} MB</td>` +
      `</tr>`,
    ).join('') || `<tr><td colspan="2"><p class="opsui-plane-obs__empty">No segments.</p></td></tr>`;

    body =
      `<p class="opsui-plane-obs__caption">Telemetry archives, truth never does. ` +
      `Work segments are never compacted; ops/other segments archive when old.</p>` +
      `<div class="opsui-plane-obs__judge-summary">` +
      `<span>Quarantined known-invalid events: <strong>${hygiene.quarantinedKnown !== null ? esc(String(hygiene.quarantinedKnown)) : '—'}</strong></span>` +
      `<span>Total segment size: <strong>${esc(totalMb)} MB</strong></span>` +
      `<span>Archive last compacted: <strong>${esc(archiveStr)}</strong></span>` +
      `</div>` +
      `<p class="opsui-plane-obs__sub-heading">Segments</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>File</th><th class="opsui-plane-obs__num">Size</th></tr></thead>` +
      `<tbody>${segRows}</tbody></table>`;
  }

  return Card({ title: 'Ledger hygiene', subtitle: 'Quarantine · segment sizes · archive', body });
}

function routingPanelRegion(routing: PlaneRoutingData): string {
  if (routing === null) {
    // Model routing not yet enabled — feature-detected absence.
    return Card({
      title:    'Routing panel',
      subtitle: 'Bucket × model stats',
      body:     `<p class="opsui-plane-obs__unavailable">Coming online. ` +
                `Once enabled, this panel shows advisory routing stats per bucket (scout/builder/architect) and model.</p>`,
    });
  }

  const modeAside = `<span class="opsui-plane-obs__tag opsui-plane-obs__tag--advisory">${esc(routing.mode.toUpperCase())}</span>`;

  let body: string;
  if (routing.rows.length === 0) {
    body = `<p class="opsui-plane-obs__empty">No routing data yet — stats accumulate as items are dispatched.</p>`;
  } else {
    const rows = routing.rows.map((r) =>
      `<tr>` +
      `<td>${esc(r.bucket)}</td>` +
      `<td>${esc(r.model)}</td>` +
      `<td class="opsui-plane-obs__num">${esc(String(r.samples))}</td>` +
      `<td class="opsui-plane-obs__num">${r.firstPassPct !== null ? `${r.firstPassPct.toFixed(1)}%` : `<span class="opsui-plane-obs__muted">—</span>`}</td>` +
      `<td class="opsui-plane-obs__num">${r.avgCostUsd !== null ? `$${r.avgCostUsd.toFixed(3)}` : `<span class="opsui-plane-obs__muted">—</span>`}</td>` +
      `</tr>`,
    ).join('');
    body =
      `<p class="opsui-plane-obs__caption">Advisory stats per bucket — graduation to active once per-bucket thresholds are set.</p>` +
      `<table class="opsui-plane-obs__table">` +
      `<thead><tr><th>Bucket</th><th>Model</th><th class="opsui-plane-obs__num">Samples</th><th class="opsui-plane-obs__num">1st-pass</th><th class="opsui-plane-obs__num">Avg $</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }

  return Card({ title: 'Routing panel', subtitle: `Bucket × model stats — mode: ${routing.mode}`, headerAside: modeAside, body });
}

/**
 * Execution config region — which execution CONFIGURATION (grouped by model) produces
 * ACCEPTED outcomes. Deliberately NOT an "agent performance" scoreboard: no radar chart,
 * no speed/quality/reliability axes, no invented baselines, no time/cost-saved framing.
 * Every number traces to real events (build.dispatched/gate.passed/item.merged/
 * item.accepted/cost.usage) via loopctl execution-config. A row with n below the
 * configured floor renders an explicit "insufficient data" state — never a ratio
 * computed from 1-2 points presented as authoritative.
 */
function executionConfigRegion(data: PlaneExecutionConfigData): string {
  if (data === null) {
    return Card({
      title:    'Execution config',
      subtitle: 'Which configuration produces accepted outcomes, by model',
      body:     `<p class="opsui-plane-obs__unavailable">Execution-config data unavailable — ` +
                `loopctl execution-config did not respond.</p>`,
    });
  }

  const caption =
    `<p class="opsui-plane-obs__caption">Measures which execution configurations produce ` +
    `accepted outcomes — not agent "performance". Window: ${esc(data.window.from.slice(0, 10))} ` +
    `→ ${esc(data.window.to.slice(0, 10))} (${data.window.days}d). Rows below n=${data.minSamples} ` +
    `show counts only — no ratio is presented as reliable on that little data.</p>`;

  if (data.rows.length === 0) {
    return Card({
      title:    'Execution config',
      subtitle: 'Which configuration produces accepted outcomes, by model',
      body:     caption + `<p class="opsui-plane-obs__empty">No model-attributed items yet.</p>`,
    });
  }

  const fmtRatio = (v: number | undefined, denomLabel: string): string =>
    v !== undefined
      ? `${(v * 100).toFixed(1)}%`
      : `<span class="opsui-plane-obs__muted">n/a (${esc(denomLabel)})</span>`;
  const fmtUsdOrNa = (v: number | undefined): string =>
    v !== undefined ? fmtUsd(v) : `<span class="opsui-plane-obs__muted">n/a (0 accepted)</span>`;
  const fmtNumOrNa = (v: number | undefined): string =>
    v !== undefined ? v.toFixed(2) : `<span class="opsui-plane-obs__muted">n/a (0 accepted)</span>`;

  const rows = data.rows.map((r) => {
    const insufficient = r.n < data.minSamples;
    const nCell = insufficient
      ? `${esc(String(r.n))} <span class="opsui-plane-obs__tag opsui-plane-obs__tag--missing">insufficient data</span>`
      : esc(String(r.n));
    if (insufficient) {
      // Raw counts only — no ratio rendered as authoritative on a low sample.
      return `<tr>` +
        `<td>${esc(r.model)}</td>` +
        `<td class="opsui-plane-obs__num">${nCell}</td>` +
        `<td class="opsui-plane-obs__num" colspan="4">` +
        `<span class="opsui-plane-obs__muted">merged=${r.merged} accepted=${r.accepted} gated=${r.gated}</span>` +
        `</td>` +
        `</tr>`;
    }
    return `<tr>` +
      `<td>${esc(r.model)}</td>` +
      `<td class="opsui-plane-obs__num">${nCell}</td>` +
      `<td class="opsui-plane-obs__num">${fmtRatio(r.acceptRate, '0 merged')} <span class="opsui-plane-obs__muted">(${r.accepted}/${r.merged})</span></td>` +
      `<td class="opsui-plane-obs__num">${fmtRatio(r.firstPassGateRate, '0 gated')} <span class="opsui-plane-obs__muted">(${r.gatedFirstPass}/${r.gated})</span></td>` +
      `<td class="opsui-plane-obs__num">${fmtUsdOrNa(r.costPerAcceptedUsd)}</td>` +
      `<td class="opsui-plane-obs__num">${fmtNumOrNa(r.retriesPerAccept)}</td>` +
      `</tr>`;
  }).join('');

  const body =
    caption +
    `<table class="opsui-plane-obs__table">` +
    `<thead><tr>` +
    `<th>Model</th><th class="opsui-plane-obs__num">n</th>` +
    `<th class="opsui-plane-obs__num">Accept rate</th>` +
    `<th class="opsui-plane-obs__num">1st-pass gate</th>` +
    `<th class="opsui-plane-obs__num">Cost / accept</th>` +
    `<th class="opsui-plane-obs__num">Retries / accept</th>` +
    `</tr></thead>` +
    `<tbody>${rows}</tbody></table>`;

  return Card({ title: 'Execution config', subtitle: 'Which configuration produces accepted outcomes, by model', body });
}

function provenanceRegion(env: ProjectionEnvelope<PlaneObservabilityData>): string {
  const chips = env.evidence
    .map(
      (e) =>
        `<a class="opsui-provenance__chip" data-opsui-action="evidence:${esc(e.id)}"` +
        (e.href ? ` href="${esc(e.href)}"` : '') +
        `>${esc(e.label)}</a>`,
    )
    .join('');
  const meta =
    `fold ${esc(env.foldVersion)} · seq #${esc(String(env.ledgerSequence))} · ` +
    `generated ${esc(env.generatedAt)}`;
  return Card({
    variant:  'inset',
    title:    'Provenance',
    subtitle: 'Every value above traces to the ledger events and transcript logs',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the plane-observability projection from its envelope.
 *  A `failed` envelope renders ProjectionFailure and nothing else. */
export function PlaneObservabilityProjection(env: ProjectionEnvelope<PlaneObservabilityData>): string {
  if (env.state === 'failed') {
    const ev = env.evidence[0];
    return ProjectionFailure({
      projection:       'Ops observability',
      reason:           'plane-observability input did not parse cleanly',
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt:       env.generatedAt,
      retry:            'refreshed on the next telemetry cycle',
      ...(ev
        ? { evidence: { id: ev.id, label: ev.label, ...(ev.href ? { href: ev.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-plane-obs" data-projection="plane-observability" data-state="${env.state}">` +
    safeRegion('How to read this page',   () => howToReadRegion()) +
    safeRegion('Ops observability',       () => glanceRegion(d.glance)) +
    safeRegion('Acceptance split',        () => acceptSplitRegion(d.acceptSplit, d.verdicts)) +
    safeRegion('Provider chain',          () => providerStatusRegion(d.providerStatus)) +
    safeRegion('Spend',                   () => spendRegion(d.costs, d.budget)) +
    safeRegion('Codex',                   () => codexRegion(d.codex)) +
    safeRegion('Quota utilization',       () => quotaRegion(d.quota)) +
    safeRegion('Cache efficiency',        () => cacheEfficiencyRegion(d.cacheEfficiency)) +
    safeRegion('Pipeline latency',        () => pipelineLatencyRegion(d.pipelineLatency)) +
    safeRegion('Judge',                   () => judgeRegion(d.verdicts)) +
    safeRegion('Context packs',           () => contextPacksRegion(d.activeItems, d.costs)) +
    safeRegion('Repairs',                 () => repairsRegion(d.repairs)) +
    safeRegion('Salvage activity',        () => salvageRegion(d.salvageFiles)) +
    safeRegion('Manifest coverage',       () => manifestRegion(d.manifestCoverage)) +
    safeRegion('Ledger hygiene',          () => ledgerHygieneRegion(d.ledgerHygiene)) +
    safeRegion('Trajectory',              () => trajectoryRegion(d.trajectory)) +
    safeRegion('Routing panel',           () => routingPanelRegion(d.routing)) +
    safeRegion('Execution config',        () => executionConfigRegion(d.executionConfig)) +
    safeRegion('Token usage',             () => tokenUsageRegion(d.tokenRows, d.trendPoints, d.transcriptSizes)) +
    safeRegion('Provenance',              () => provenanceRegion(env)) +
    `</div>`
  );
}
