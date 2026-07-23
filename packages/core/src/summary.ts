/**
 * summary.ts — the ONE construction of the `loopctl summary --json` payload (WI-053).
 *
 * Extracted verbatim from cli.ts `cmdSummary` so the CLI command and the console server
 * share a single parser/builder (repo doctrine: one fact, one home — never two parallel
 * constructions of the same wire shape). The emitted shape is UNCHANGED:
 *   { counts, active, recentMerged, recentMerged30d, recentRejected, recentAnswered,
 *     threads, provisionalAccepted, tierWindows, queueBlocking, capturedLast24h,
 *     capturedLast7d, capturedLast30d, generatedAt }
 */

import { spawnSync } from 'node:child_process';
import type { LedgerEvent } from './schema.js';
import type { FoldResult, ItemRecord } from './fold.js';
import { resolveItemBranch } from './fold.js';
import type { LoopkitConfig } from './config.js';
import { touchesConflict, normalizeTouches, BUILDER_BREAKER_N } from './beats/dispatch.js';
import { classifyAcceptanceTier, acceptanceClassifyFiles, hasEvidenceGap } from './acceptance.js';
import { effectiveTierWindows } from './calibration.js';

/**
 * "Why isn't this building?" scheduling readout for the WI ops-console-scheduling region —
 * every item NOT currently building that an operator might wonder about: queued (runnable now,
 * blocked on in-flight touches, or breaker-tripped) and parked (with its park reason). Reuses
 * the SAME predicates `runDispatch` gates dispatch with (touchesConflict, BUILDER_BREAKER_N)
 * so this can never silently disagree with real dispatch behaviour — it only reports, never
 * re-decides. Planning-lane items never touch files, so they are excluded from the touches/
 * breaker reasoning the same way dispatch excludes them from the engineering picker.
 */
export function buildQueueBlocking(items: Map<string, ItemRecord>): Array<Record<string, unknown>> {
  const queued = Array.from(items.values())
    .filter((r) => r.state === 'queued' && r.spec && r.lane !== 'planning')
    .sort((a, b) => a.id.localeCompare(b.id));
  const parked = Array.from(items.values())
    .filter((r) => r.state === 'parked')
    .sort((a, b) => a.id.localeCompare(b.id));
  if (queued.length === 0 && parked.length === 0) return [];

  const inflight = Array.from(items.values()).filter((r) => r.state === 'building' && r.lane !== 'planning');
  let inflightTouches: string | undefined;
  for (const rec of inflight) {
    if (!rec.touches) { inflightTouches = '*'; break; }
    inflightTouches = inflightTouches ? `${inflightTouches},${rec.touches}` : rec.touches;
  }

  const rows: Array<Record<string, unknown>> = queued.map((rec) => {
    // Circuit breaker: exhausted attempts without a fresh unpark since the last park.
    if (rec.attempts >= BUILDER_BREAKER_N) {
      const freshUnpark = rec.lastUnparkedAt && (!rec.parkedAt || rec.lastUnparkedAt > rec.parkedAt);
      if (!freshUnpark) {
        return { id: rec.id, runnable: false, reason: `${rec.attempts} attempts — needs fresh unpark` };
      }
    }
    // In-flight touches conflict — name the actual blocking item + the overlapping segment.
    if (inflightTouches && touchesConflict(rec.touches, inflightTouches)) {
      const blocker = inflight.find((b) => touchesConflict(rec.touches, b.touches));
      const segment = rec.touches ? normalizeTouches(rec.touches)[0] : undefined;
      const reason = blocker
        ? `waiting on ${blocker.id}${segment ? ` (touches ${segment})` : ''}`
        : 'waiting on an in-flight build (touches overlap)';
      return { id: rec.id, runnable: false, reason };
    }
    return { id: rec.id, runnable: true };
  });

  for (const rec of parked) {
    rows.push({ id: rec.id, runnable: false, reason: `parked: ${rec.parkReason ?? 'no reason recorded'}` });
  }

  return rows;
}

export interface BuildSummaryOptions {
  /** The plane config — acceptance-tier classification + auto-approve prefixes read it. */
  cfg: LoopkitConfig;
  /** Repo root for the parked-item `git rev-parse --verify` branch-alive probe. */
  repoRoot: string;
  /** Injectable "now" (ms epoch) for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Build the compact fold summary the ops console consumes (`loopctl summary --json`).
 * Shape: { counts, active, recentMerged, recentMerged30d, ... } — see module header.
 * - counts: state → number
 * - active: items in [building, approved, parked, queued, routed] with key fields
 * - recentMerged: items merged in the last 7 days
 * - recentMerged30d: same shape, trimmed to a wider 30-day horizon
 */
export function buildSummary(
  result: FoldResult,
  allEvents: LedgerEvent[],
  opts: BuildSummaryOptions,
): Record<string, unknown> {
  const cfg = opts.cfg;
  const now = opts.now ?? Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const THIRTY_DAYS_MS = 30 * DAY_MS;
  const tierSurfacePrefixes = cfg.acceptance?.tiers?.surfacePrefixes ?? [];

  const counts: Record<string, number> = {};
  const active: Array<Record<string, unknown>> = [];
  const recentMerged: Array<Record<string, unknown>> = [];
  // Same merged-item shape as recentMerged, trimmed to a wider 30-day horizon — feeds the
  // Glance window picker's '30d' option (fold-adapter.ts mergedInWindow). Built from the SAME
  // record below, never a second parser over the fold (one-parser rule).
  const recentMerged30d: Array<Record<string, unknown>> = [];
  const recentRejected: Array<Record<string, unknown>> = [];
  const recentAnswered: Array<Record<string, unknown>> = [];
  // Compact thread projection: every item that has ever received a conductor reply, keyed by
  // its addressable source id, with the timestamp of its latest out-message. The console chat
  // SSE watches this to push a reply into the live thread. Independent of the `active` filter
  // above — a routed-but-not-queued item still has a reply to deliver.
  const threads: Array<Record<string, unknown>> = [];
  // Glance FLOW tile: captured-in-window, counted across ALL items regardless of current
  // state — `active` only holds non-terminal states, so a captured-then-merged item would
  // otherwise be invisible to the intake count. All three window counts are emitted so the
  // tile's intake side follows the selected window (a 24h-under-7d mismatch was reported;
  // 30d joined with the wider window option).
  let capturedLast24h = 0;
  let capturedLast7d = 0;
  let capturedLast30d = 0;

  for (const rec of result.items.values()) {
    counts[rec.state] = (counts[rec.state] ?? 0) + 1;

    const capturedMs = new Date(rec.createdAt ?? rec.capturedAt ?? '').getTime();
    if (Number.isFinite(capturedMs) && now - capturedMs < DAY_MS) capturedLast24h++;
    if (Number.isFinite(capturedMs) && now - capturedMs < 7 * DAY_MS) capturedLast7d++;
    if (Number.isFinite(capturedMs) && now - capturedMs < 30 * DAY_MS) capturedLast30d++;

    const outs = rec.messages.filter((m) => m.direction === 'out');
    // A thread is any source-originated item — the console renders it whether or not the
    // conductor has replied yet, so a freshly-captured intent shows up immediately. Threads
    // render from the fold; there is no external message-file seam.
    const externalRef = rec.externalRef ?? (rec.source?.startsWith('ext:') ? rec.source.slice(4) : undefined);
    const isThread = outs.length > 0 || !!externalRef;
    if (isThread) {
      // Prepend the operator's opening message (item.captured.text) as the first 'in' message — the
      // fold stores it as sourceText, not as a msg.in event, so it would otherwise be missing from
      // the thread body the console renders.
      const opening = (rec.sourceText ?? '').trim().length > 0
        ? [{ ts: rec.capturedAt ?? rec.createdAt ?? '', direction: 'in' as const, text: rec.sourceText! }]
        : [];
      threads.push({
        id: rec.id,
        ...(externalRef ? { externalRef } : {}),
        ...(outs.length > 0 ? { lastOutTs: outs[outs.length - 1]!.ts } : {}),
        outCount: outs.length,
        // Router-stamped short title, when the model gave one — the console
        // prefers this over its deterministic spec/text-truncation fallback.
        ...(rec.title ? { title: rec.title } : {}),
        // Carry the full msg.in/out history (opening capture + replies) so the console renders
        // threads from the fold; there is no external message-file seam.
        messages: [...opening, ...rec.messages.map((m) => ({ ts: m.ts, direction: m.direction, text: m.text }))],
      });
    }

    const activeStates = new Set(['building', 'approved', 'parked', 'queued', 'routed']);
    if (activeStates.has(rec.state)) {
      // For crashed/parked items, include last build's stderrTail
      const lastBuild = rec.builds[rec.builds.length - 1];
      // Extract legacy source-ids from the source field (older ledgers may carry externally-
      // captured source ids).
      const srcExternalRef = rec.source?.startsWith('ext:') ? rec.source.slice(4) : undefined;
      // Resolved via the shared one-parser helper (falls back to builds[] once a gate park
      // has archived currentBuild) — a live git check only for parked items that actually
      // need the approve button, so branchAlive stays absent noise-free elsewhere.
      const resolvedBranch = resolveItemBranch(rec);
      const branchAlive = rec.state === 'parked' && resolvedBranch
        ? spawnSync('git', ['rev-parse', '--verify', resolvedBranch], { cwd: opts.repoRoot, stdio: 'pipe' }).status === 0
        : undefined;
      active.push({
        id: rec.id,
        state: rec.state,
        attempts: rec.attempts,
        createdAt: rec.createdAt ?? rec.capturedAt,
        buildingAt: rec.buildingAt,
        queuedAt: rec.queuedAt,
        parkedAt: rec.parkedAt,
        approvedAt: rec.approvedAt,
        // Interim-status detection (mirrors isInterimApprovedStatus) needs this alongside
        // parkedAt to tell "just unparked, awaiting dispatch" apart from "queued for an
        // unrelated reason" — never cleared, see fold.ts.
        lastUnparkedAt: rec.lastUnparkedAt,
        parkReason: rec.parkReason,
        parkKind: rec.parkKind,
        // Leader-leader escalation payload (item.parked.escalation) — absent unless the
        // emitter supplied all four fields (fold.ts parseEscalation is all-or-nothing).
        ...(rec.escalation ? { escalation: rec.escalation } : {}),
        model: rec.model,
        priority: rec.priority,
        touches: rec.touches,
        spec: rec.spec ?? rec.sourceText,
        stderrTail: lastBuild?.stderrTail,
        crashReason: lastBuild?.crashReason,
        // scout context-pack coverage + judge status for the ops console
        briefed: rec.brief !== undefined,
        judgeVerdict: rec.judgeVerdict
          ? { verdict: rec.judgeVerdict.verdict, confidence: rec.judgeVerdict.confidence }
          : null,
        // Ops console run-card polish: the dispatched branch — resolved via resolveItemBranch
        // so a gate-parked item (currentBuild archived into builds[]) still carries it, not
        // just the mid-build "dispatched" phase signal this originally covered.
        ...(resolvedBranch ? { branch: resolvedBranch } : {}),
        ...(branchAlive !== undefined ? { branchAlive } : {}),
        // Ops console context manifest: the scout brief the agent was actually given
        // (item.briefed → rec.brief), text + model, for the per-item evidence drawer.
        ...(rec.brief ? { brief: { text: rec.brief.text, at: rec.brief.at, ...(rec.model ? { model: rec.model } : {}) } } : {}),
        ...(rec.externalRef ? { externalRef: rec.externalRef } : srcExternalRef ? { externalRef: srcExternalRef } : {}),
      });
    }

    // A still-unaccepted merged item must never age out of the operator window — it still
    // needs an operator decision no matter how old. The 7-day WEEK_MS
    // gate applies only to already-accepted items (kept around briefly for the "shipped
    // this week" glance, then dropped).
    if ((rec.state === 'merged' || rec.state === 'accepted') && rec.mergedAt) {
      const mergedMs = new Date(rec.mergedAt).getTime();
      const withinWeek = rec.state === 'merged' || now - mergedMs < WEEK_MS;
      const within30d = rec.state === 'merged' || now - mergedMs < THIRTY_DAYS_MS;
      if (within30d) {
        const mergedRecord = {
          id: rec.id,
          mergedAt: rec.mergedAt,
          mergeCommit: rec.mergeCommit,
          spec: (rec.spec ?? rec.sourceText ?? '').slice(0, 100),
          // capture→merge cycle time + first-attempt-merge-rate glance tiles read these off
          // each merged item — carried straight through, no re-derivation.
          ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
          attempts: rec.attempts,
          // WI-108 lifetime clean-landing counters — how rough the road to merge was, per WI.
          // Emitted only when non-zero (absent === 0) so a clean landing carries none and legacy
          // replays stay byte-identical. Lets a summary consumer compute per-WI clean-landing
          // rate without re-scanning the raw event stream.
          ...(rec.lifetimeParkCount ? { lifetimeParkCount: rec.lifetimeParkCount } : {}),
          ...(rec.lifetimeCrashCount ? { lifetimeCrashCount: rec.lifetimeCrashCount } : {}),
          ...(rec.lifetimeGateRedCount ? { lifetimeGateRedCount: rec.lifetimeGateRedCount } : {}),
          ...(rec.lifetimeEscalationCount ? { lifetimeEscalationCount: rec.lifetimeEscalationCount } : {}),
          // carry touches so the ops console can derive the origin chip for shipped items on
          // the stream + acceptance desk.
          ...(rec.touches ? { touches: rec.touches } : {}),
          accepted: rec.state === 'accepted',
          ...(rec.acceptedAt ? { acceptedAt: rec.acceptedAt } : {}),
          // provisional flag for ops-console feature detection.
          ...(rec.provisionalAccept ? { provisional: true } : {}),
          // Certify-don't-brief payload (item.merged.certification) — absent unless the
          // worker's manifest supplied all three fields (fold.ts parseCertification is
          // all-or-nothing). The acceptance desk renders a visible "no certification
          // provided" line when absent, never a silent blank.
          ...(rec.mergeCertification ? { certification: rec.mergeCertification } : {}),
          // scout coverage + judge status for the ops console
          briefed: rec.brief !== undefined,
          judgeVerdict: rec.judgeVerdict
            ? { verdict: rec.judgeVerdict.verdict, confidence: rec.judgeVerdict.confidence }
            : null,
          // acceptance tier for the acceptance queue — only meaningful while the
          // item still needs a decision (accepted items already resolved their tier).
          ...(rec.state !== 'accepted' ? {
            tier: classifyAcceptanceTier(
              acceptanceClassifyFiles(rec.mergeChangedFiles, rec.touches),
              rec.judgeVerdict,
              {
                surfacePrefixes: tierSurfacePrefixes,
                planePrefixes: cfg.autoApprove.planePrefixes,
                riskPatterns: cfg.autoApprove.escalationPatterns,
              },
              hasEvidenceGap(rec.mergeChangedFiles, rec.touches, {
                gateCommand: rec.mergeGateCommand,
                baseSha: rec.mergeBaseSha,
                headSha: rec.mergeHeadSha,
              }),
            ).tier,
          } : {}),
        };
        // recentMerged30d is a superset of recentMerged (30d ⊇ 7d) built from the
        // same record — never two independent constructions of the same shape.
        recentMerged30d.push(mergedRecord);
        if (withinWeek) recentMerged.push(mergedRecord);
      }
    }

    // rejected items from the last 7 days — shown in the collapsed Resolved section.
    if (rec.state === 'rejected' && rec.rejectedAt) {
      const rejectedMs = new Date(rec.rejectedAt).getTime();
      if (now - rejectedMs < WEEK_MS) {
        recentRejected.push({
          id: rec.id,
          rejectedAt: rec.rejectedAt,
          spec: (rec.spec ?? rec.sourceText ?? '').slice(0, 100),
          // who/what closed it — 'operator' vs a machine closure (reactor supersede,
          // duplicate-of-merged doctrine) — undefined on older replays.
          ...(rec.rejectedBy ? { rejectedBy: rec.rejectedBy } : {}),
        });
      }
    }

    // Terminal-routed items (route=answer|question|duplicate|merged) — shown in the collapsed
    // Answered/Closed section; never mixed with the live-work routed bucket.
    if (rec.state === 'answered') {
      recentAnswered.push({
        id: rec.id,
        answeredAt: rec.answeredAt,
        route: rec.route,
        spec: (rec.spec ?? rec.sourceText ?? '').slice(0, 100),
      });
    }
  }

  // count of items accepted provisionally (reactor:oc6-provisional). Feature-detected by the
  // ops-console. Items with the provisionalAccept flag in the fold also carry provisional:true
  // in the recentMerged/active arrays below.
  const provisionalAccepted = Array.from(result.items.values()).filter(r => r.provisionalAccept === true).length;
  // current calibrated 'optional'/'review' auto-accept windows, so the console can show the
  // operator how tiering has self-tuned from their verdicts.
  const { windows: tierWindows } = effectiveTierWindows(allEvents, {
    optional: cfg.acceptance?.tiers?.optionalAfterHours ?? 48,
    review: cfg.acceptance?.tiers?.reviewAfterHours ?? 168,
  });
  const queueBlocking = buildQueueBlocking(result.items);
  return { counts, active, recentMerged, recentMerged30d, recentRejected, recentAnswered, threads, provisionalAccepted, tierWindows, queueBlocking, capturedLast24h, capturedLast7d, capturedLast30d, generatedAt: new Date().toISOString() };
}
