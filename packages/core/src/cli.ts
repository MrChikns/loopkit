#!/usr/bin/env node
/**
 * cli.ts — loopctl entrypoint
 *
 * Commands:
 *   new "<text>"                      Capture a new work item
 *   append <type> --item WI-NNN --data '<json>'  Append an event
 *   state [--item WI-NNN] [--json|--md]          Show item(s) state
 *   board                             Render the markdown board
 *   doctor [--json]                   Run orphan/breaker detection
 *   import                            One-time seam-file migration
 *   slo [--json]                      Print the SLO board
 *   compact [--dry-run]               Archive old ops segments
 *   audit <target-path> [--json]      Target-readiness hygiene check + autonomy tier
 *
 *   beat reactor|dispatch             implemented
 *   approve|reject <item> [--trail]   deterministic operator verb (implemented)
 *   accept <item> [--trail]           emit item.accepted (implemented)
 *   route <item>                      not yet implemented
 *   park <item>                       not yet implemented
 *   costs                             not yet implemented
 *   quota [--json]                    Unified subscription-quota view
 */

import { join, resolve, dirname } from 'node:path';
import { mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendEvents, loadAllEventsWithQuarantine, withLock } from './ledger.js';
import { compact, formatCompactResult, loadQuarantine } from './hygiene.js';
import { fold, nextConvId } from './fold.js';
import { renderBoard } from './board.js';
import { runDoctor, defaultPidProbe, detectDistDrift, DistDriftResult } from './doctor.js';
import { makeEvent, validateEvent } from './schema.js';
import { captureIntent, approveOrReject, acceptItem, amendPortability, VerbError } from './verbs.js';
import {
  startSession, heartbeatSession, endSession, claimItems, releaseItems,
  readCurrentSession, writeCurrentSession, clearCurrentSession,
} from './session.js';
import { runConduct } from './conductor.js';
import { runReactor } from './beats/reactor.js';
import { runDispatch, parseManifest } from './beats/dispatch.js';
import { evaluateSloBoard, makeRealProbes, deriveSloState, makeDeployProbe, makeInstanceProbe } from './slo.js';
import { runAudit } from './audit/index.js';
import { makeRegistry, makeFileHealthFns } from './providers/registry.js';
import { loadConfig, resolvePlaneHome, ensurePlaneHome } from './config.js';
import { readTargetManifest, manifestHash, mintTargetId, resolveRegisteredTarget } from './target.js';
import { foldCosts, CostRow, formatQuotaWindowLabel } from './costs.js';
import { collectInteractiveUsage } from './collectors/interactive-usage.js';
import { collectCodexUsage } from './collectors/codex-usage.js';
import { collectClaudeQuota } from './collectors/claude-quota.js';
import { projectVerdicts } from './verdicts.js';
import { projectTrajectory } from './trajectory.js';
import { projectExecutionConfig } from './executionConfig.js';
import { computeBrief, renderBriefMarkdown, BriefConfig, RoutingSection } from './brief.js';
import { findSalvagePatch } from './salvage.js';
import { buildSummary } from './summary.js';
import {
  bucketSpec,
  buildRoutingTableWithSpecs,
  chooseModel,
  ROUTING_CONFIG_DEFAULTS,
  mergeRoutingConfig,
  RoutingTable,
  SpecBucket,
} from './routing.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Repo root: env override, else walk up from this module (dist/cli.js → package → repo),
// else walk up from cwd — a wrong default here can point the beat at the wrong directory.
function resolveRepoRoot(): string {
  const envRoot = process.env['LOOPKIT_REPO'];
  if (envRoot) return resolve(envRoot);
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let candidate = resolve(start);
    for (;;) {
      if (existsSync(join(candidate, 'loopkit.config.json')) || existsSync(join(candidate, '.ai'))) {
        return candidate;
      }
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return process.cwd();
}

const REPO_ROOT = resolveRepoRoot();

// Plane-home resolution (docs/event-model.md §"The two repos"): LOOPKIT_HOME → explicit
// plane-home; deprecated LOOPKIT_LEDGER → legacy ledger override; else ~/.loopkit if it
// exists; else an existing in-repo .ai/ledger (embedded mode); else the ~/.loopkit default.
// resolvePlaneHome (config.ts) is the ONE source of truth for the precedence rule.
const PLANE_HOME = resolvePlaneHome({ repoRoot: REPO_ROOT });
const LEDGER_DIR = PLANE_HOME.ledgerDir;
// Run-state (watermarks, locks, salvage patches, manifests, worker logs) must live BESIDE
// the ledger it describes: plane-home mode → $LOOPKIT_HOME/runs/loopkit, embedded →
// <repo>/.ai/runs/loopkit. Mixing them was the P4 first-beat incident — the regression
// guard read the embedded plane's watermarks against the fresh plane-home ledger and
// (correctly, given its inputs) halted the plane.
const RUN_DIR = join(PLANE_HOME.runsDir, 'loopkit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`
loopctl — event-sourced agent plane CLI

Commands:
  new "<text>" [--target <name>]       Capture a new WI item (stamps the sole target, or --target)
  target add <path>                    Register an external target repo (validates + prints its manifest)
  target list [--json]                 List registered target repos
  append <type> --item <WI-NNN> --data '<json>'  Append an event
  state [--item <WI-NNN>] [--json|--md]          Show item state(s)
  board                                Render markdown board
  doctor [--json]                      Detect orphaned builds
  import [--dry-run]                   One-time seam-file migration
  sync [--dry-run] [--json]            Incremental sync: new rows + state transitions
  summary [--json]                     Compact fold summary (counts + active items)
  events [--item <WI-NNN>] [--recent <N>] [--json]  Emit ledger events (canonical reader)
  conv new "<title>"                   Create a new CONV-NNN conversation
  conv say <CONV-NNN> "<text>"         Append msg.in to a conversation
  conv close <CONV-NNN> [--reason]     Close a conversation

  beat reactor|dispatch [--dry-run]    Run a beat
  slo [--json]                         Print SLO board
  brief [--json]                       Deterministic daily ops brief
  approve|reject <item> [--trail "<text>"]  Operator approve/reject a parked spine item
  portability <item> "<reply>" [--by <actor>] [--trail "<text>"]  Confirm a portability-nudge reply ("applies to: <targets> | none")
  costs [--by loop|provider|day] [--json]   Per-loop/provider/day spend (cost.usage)
  quota [--json]                       Unified subscription-quota view: utilization + capacity/runway
  verdicts [--json]                    Judge calibration: verdict rows + agreement stats
  trajectory [--json] [--days N]       Per-attempt efficiency projection (turns, cost, duration)
  routing [--json]                     Model routing table (bucket × model: samples, first-pass %, avg $)
  execution-config [--json] [--days N] Execution-config-by-model: accept rate, first-pass gate rate, cost/accept, retries/accept
  compact [--dry-run]                  Archive old ops segments
  audit <target-path> [--json]         Target-readiness hygiene check + autonomy tier
  route <item>                         [not yet implemented]
  park|accept <item>                   [not yet implemented]

  session start|beat|end               Attended session lifecycle (claims lease queued items)
  claim <ids...|--all-queued> [--ttl <min>]   Lease queued items to the current session
  release <ids...> [--reason "<text>"]        Return leased items to the shared queue
  conduct [--claim-all-queued] [--dry-run]    Build the session's claimed items (clustered, one gate per cluster)

Environment:
  LOOPKIT_HOME     Plane-home root (default: ~/.loopkit — holds ledger/, config/, targets/, runs/)
  LOOPKIT_LEDGER   DEPRECATED — overrides the ledger directory only; use LOOPKIT_HOME
  LOOPKIT_REPO     Repo root for import/sync (default: ../../ from cwd)
`);
}

function notImplemented(cmd: string): never {
  console.error(`[loopctl] '${cmd}' is not yet implemented.`);
  process.exit(2);
}

function parseArgs(argv: string[]): { cmd: string; rest: string[] } {
  const [, , cmd, ...rest] = argv;
  return { cmd: cmd ?? '', rest };
}

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Strip a known set of value-flags (and their values) from argv, wherever they appear,
 * returning the remaining positional arguments in their original relative order.
 *
 * `getFlag`/`hasFlag` alone are order-BLIND: they find a flag's value by fixed offset, but
 * any caller that then reads `rest[0]` for "the positional" silently breaks when a flag
 * comes first (`--target X "text"` stored the literal string "--target" as the captured
 * text — the argv-order bug this helper exists to fix). Use this wherever a command mixes
 * one or more positionals with named flags, so positional extraction is order-independent
 * by construction rather than by convention at each call site.
 */
function positionals(args: string[], knownValueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (knownValueFlags.includes(a)) {
      i++; // skip the flag's value too
      continue;
    }
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdNew(rest: string[]): Promise<void> {
  // --source lets a caller stamp the capture's origin so the importer can dedup against a
  // legacy source-id (older ledgers may carry externally-captured source ids, e.g. an
  // "ext:<id>"-prefixed console capture — buildLegacyToWiMap keys item.captured on this
  // field). Defaults to "cli".
  const source = getFlag(rest, '--source') ?? 'cli';
  // TARGET EXTERNALIZATION (docs/event-model.md §"Capture intent against a target"):
  // resolve which target (if any) this capture builds against.
  //   - explicit --target <name> always wins (and must name a registered target)
  //   - no flag + exactly ONE registered target → stamp that target (the single-target preview)
  //   - no flag + zero targets → legacy: no target field, builds against the plane's own repo
  //   - no flag + N>1 targets → require --target (multi-target routing beyond the stamp is
  //     out of scope for v0.1; an explicit selection is required)
  const targetFlag = getFlag(rest, '--target');
  // The text is whatever positional survives once --source/--target and their values are
  // stripped, REGARDLESS of where the flags sit in argv (`new "<text>" --target X` and
  // `new --target X "<text>"` must both capture the same text — see the `positionals` doc
  // comment for the bug this fixes). A resulting text that is empty or itself looks like a
  // flag (starts with '-') is refused before any ledger write: junk on an append-only ledger
  // is forever, and a missing/misplaced value is far more likely than a genuine leading-dash
  // capture.
  const text = positionals(rest, ['--source', '--target']).join(' ').trim();
  if (!text || text.startsWith('-')) {
    console.error('Usage: loopctl new "<text>" [--source <origin>] [--target <name>]');
    process.exit(1);
  }
  try {
    const { wiId, target } = await captureIntent(LEDGER_DIR, { text, source, target: targetFlag });
    console.log(target !== undefined ? `Created ${wiId} (target: ${target})` : `Created ${wiId}`);
  } catch (e) {
    if (e instanceof VerbError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

/**
 * TARGET EXTERNALIZATION — `loopctl target add <path>` / `loopctl target list`.
 * `add` is the explicit operator consent step (docs/event-model.md §"Register a target"):
 * it validates the path is a git repo + the manifest parses, PRINTS the manifest's commands
 * for the operator to see, then appends target.registered. Manifests are trusted local code;
 * nothing is auto-discovered or auto-executed here.
 */
async function cmdTarget(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub === 'add') {
    const path = rest[1];
    if (!path || path.startsWith('--')) {
      console.error('Usage: loopctl target add <path>');
      process.exit(1);
    }
    const repoPath = resolve(path);
    // Validate the path is a git repository (top-level of a worktree). A non-repo path or a
    // bare/uninitialized dir must fail loudly BEFORE any event is appended.
    const gitCheck = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (gitCheck.status !== 0) {
      console.error(`Not a git repository: ${repoPath}\n${(gitCheck.stderr ?? '').trim()}`);
      process.exit(1);
    }
    const toplevel = gitCheck.stdout.trim();

    let manifest;
    try {
      manifest = readTargetManifest(toplevel);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    }

    const hash = manifestHash(manifest);
    // Consent surface: show the operator exactly what the plane will run against this repo.
    console.log(`Target '${manifest.name}' at ${toplevel}`);
    console.log(`  defaultBranch:  ${manifest.defaultBranch}`);
    console.log(`  gateCommand:    ${manifest.gateCommand}  (in ${manifest.gateWorkdir})`);
    console.log(`  deployCommand:  ${manifest.deployCommand || '(none)'}`);
    console.log(`  worktreePrefix: ${manifest.worktreePrefix}`);
    console.log(`  manifestHash:   ${hash.slice(0, 12)}`);

    await withLock(LEDGER_DIR, async tx => {
      const allEvents = await tx.loadAll();
      const result = fold(allEvents);
      // Identity pins on repoPath, not name (names are mutable display attributes): look the
      // target up by repoPath so a rename revives the SAME targetId instead of minting a twin.
      const existing = result.targets.byRepoPath(toplevel);
      if (existing) {
        if (existing.manifestHash === hash && existing.name === manifest.name) {
          console.log(`Target '${manifest.name}' already registered with the same manifest — no change.`);
          return;
        }
        if (existing.name !== manifest.name) {
          // Rename: re-register under the EXISTING id — never re-mint on a name change.
          const ev = makeEvent('cli', manifest.name, 'target.registered', {
            targetId: existing.targetId,
            name: manifest.name,
            repoPath: toplevel,
            manifestHash: hash,
            defaultBranch: manifest.defaultBranch,
          });
          await tx.append([ev]);
          console.log(`Renamed target '${existing.name}' → '${manifest.name}' (${existing.targetId}).`);
          return;
        }
        // Re-registering a changed manifest: append target.manifest-updated, never mutate.
        const ev = makeEvent('cli', manifest.name, 'target.manifest-updated', {
          targetId: existing.targetId,
          name: manifest.name,
          manifestHash: hash,
          defaultBranch: manifest.defaultBranch,
        });
        await tx.append([ev]);
        console.log(`Updated manifest for target '${manifest.name}' (${existing.targetId}).`);
        return;
      }
      const targetId = mintTargetId();
      const ev = makeEvent('cli', manifest.name, 'target.registered', {
        targetId,
        name: manifest.name,
        repoPath: toplevel,
        manifestHash: hash,
        defaultBranch: manifest.defaultBranch,
      });
      await tx.append([ev]);
      console.log(`Registered target '${manifest.name}' (${targetId}).`);
    });
  } else if (sub === 'list') {
    const asJson = hasFlag(rest, '--json');
    const events = await loadAllEventsWithQuarantine(LEDGER_DIR);
    const result = fold(events);
    const rows = [...result.targets.values()];
    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('No targets registered.');
      return;
    }
    for (const t of rows) {
      console.log(`${t.targetId}\t${t.name}\t${t.defaultBranch}\t${t.manifestHash.slice(0, 12)}\t${t.repoPath}`);
    }
  } else {
    console.error('Usage: loopctl target add <path> | loopctl target list [--json]');
    process.exit(1);
  }
}

async function cmdAppend(rest: string[]): Promise<void> {
  const type = rest[0];
  const item = getFlag(rest, '--item');
  const dataStr = getFlag(rest, '--data');
  if (!type || !item || !dataStr) {
    console.error('Usage: loopctl append <type> --item <WI-NNN> --data \'<json>\'');
    process.exit(1);
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch (e) {
    console.error(`Invalid JSON in --data: ${e}`);
    process.exit(1);
  }
  const ev = makeEvent('cli', item, type, data as never);
  await appendEvents(LEDGER_DIR, [ev]);
  console.log(`Appended ${ev.id} (${type} on ${item})`);
}

/**
 * events [--item <WI-NNN>] [--recent <N>] [--json]
 * Emit ledger events via the single canonical reader (loadAllEventsWithQuarantine).
 *
 * --item WI-NNN  only events for that item, oldest-first
 * --recent N     N most-recent events across all items, newest-first (default N=200)
 * --json         JSON array of RawEvent objects
 */
async function cmdEvents(rest: string[]): Promise<void> {
  const itemFilter = getFlag(rest, '--item');
  const recentStr = getFlag(rest, '--recent');
  const asJson = hasFlag(rest, '--json');

  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  // allEvents are pre-sorted oldest-first by loadAllEvents

  let events: typeof allEvents;

  if (itemFilter) {
    events = allEvents.filter(ev => ev.item === itemFilter);
    // Already oldest-first — keep as-is
  } else {
    const limit = recentStr !== undefined ? Math.max(1, parseInt(recentStr, 10) || 200) : 200;
    events = [...allEvents].reverse().slice(0, limit);
  }

  const output = events.map(ev => ({
    id: ev.id,
    ts: ev.ts,
    actor: ev.actor,
    item: ev.item,
    type: ev.type,
    data: ev.data as Record<string, unknown>,
  }));

  if (asJson) {
    console.log(JSON.stringify(output));
  } else {
    for (const ev of output) {
      console.log(`${ev.ts}  ${ev.item.padEnd(8)}  ${ev.type.padEnd(24)}  ${ev.actor}`);
    }
  }
}

async function cmdState(rest: string[]): Promise<void> {
  const itemFilter = getFlag(rest, '--item');
  const asJson = hasFlag(rest, '--json');
  const asMd = hasFlag(rest, '--md');

  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const result = fold(allEvents);

  if (itemFilter) {
    const rec = result.items.get(itemFilter);
    if (!rec) {
      console.error(`Item ${itemFilter} not found`);
      process.exit(1);
    }
    // Derive salvageAvailable from fs at render time. Fail-soft: any error = false.
    let salvageAvailable = false;
    try {
      const runDir = RUN_DIR;
      const found = findSalvagePatch(runDir, rec.id, rec.attempts + 1);
      salvageAvailable = found !== undefined;
    } catch { /* fail-soft */ }

    // Derive manifest summary from fs at render time. Fail-soft: any error = undefined.
    // Reads the latest attempt's manifest evidence file (fs-derived, not a fold field).
    let manifestSummary: { confidence: number; files: number } | undefined;
    try {
      const runDir = RUN_DIR;
      // Walk back from the current attempt to find the latest manifest evidence file.
      for (let a = rec.attempts; a >= 1; a--) {
        const mPath = join(runDir, `${rec.id}-attempt-${a}.manifest.json`);
        if (existsSync(mPath)) {
          const parsed = parseManifest(readFileSync(mPath, 'utf8'));
          if (parsed) {
            manifestSummary = { confidence: parsed.confidence, files: parsed.filesTouched.length };
          }
          break;
        }
      }
    } catch { /* fail-soft */ }

    if (asJson) {
      console.log(JSON.stringify({ ...rec, salvageAvailable, ...(manifestSummary ? { manifest: manifestSummary } : {}) }, null, 2));
    } else {
      const manifestTag = manifestSummary
        ? `  manifest(conf=${manifestSummary.confidence.toFixed(2)},files=${manifestSummary.files})`
        : '';
      console.log(`${rec.id}  ${rec.state}  attempts=${rec.attempts}  messages=${rec.messages.length}${salvageAvailable ? '  salvageAvailable=true' : ''}${manifestTag}`);
      if (rec.sourceText) console.log(`  text: ${rec.sourceText.slice(0, 100)}`);
    }
  } else {
    if (asJson) {
      const obj: Record<string, unknown> = {};
      for (const [id, rec] of result.items) obj[id] = rec;
      console.log(JSON.stringify(obj, null, 2));
    } else if (asMd) {
      console.log(renderBoard(result));
    } else {
      for (const [, rec] of result.items) {
        console.log(`${rec.id.padEnd(8)}  ${rec.state.padEnd(12)}  ${rec.sourceText?.slice(0, 60) ?? ''}`);
      }
    }
  }
}

/**
 * summary --json: Returns a compact fold summary for the ops console.
 * The construction lives in summary.ts (buildSummary) — ONE builder shared by this CLI
 * command and the console server (WI-053), so the wire shape can never fork.
 */
async function cmdSummary(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  // Load config first: acceptance-tier classification (recentMerged) and the
  // fold's null-target coalescing both read it.
  const cfg = loadConfig(REPO_ROOT);
  const result = fold(allEvents, { defaultTarget: cfg.defaultTarget });
  const summary = buildSummary(result, allEvents, { cfg, repoRoot: REPO_ROOT });

  if (asJson) {
    console.log(JSON.stringify(summary));
  } else {
    const counts = summary.counts as Record<string, number>;
    const active = summary.active as unknown[];
    const recentMerged = summary.recentMerged as unknown[];
    console.log(`Fold summary (${result.items.size} total items):`);
    for (const [state, count] of Object.entries(counts)) {
      console.log(`  ${state.padEnd(12)} ${count}`);
    }
    console.log(`\nActive: ${active.length} items`);
    console.log(`Merged this week: ${recentMerged.length} items`);
  }
}

async function cmdApprove(rest: string[], verb: 'approve' | 'reject'): Promise<void> {
  const rawId = rest[0];
  if (!rawId) {
    console.error(`Usage: loopctl ${verb} <WI-NNN> [--trail "<text>"]${verb === 'reject' ? ' [--by <actor>]' : ''}`);
    process.exit(1);
  }
  const trailText = getFlag(rest, '--trail');
  // A reject invoked by an autonomous agent (worker/doctor, e.g. a reject-if-already-done
  // doctrine) is a machine closure, not an operator decline — it must not silently stamp
  // by:'operator' (that made a superseded/duplicate item indistinguishable from a real operator
  // rejection on the console). Plain `loopctl reject <id>` with no --by is still assumed
  // operator (the console/chat-bridge path — "apply operator verbs"); an explicit --by overrides
  // it for machine-driven callers.
  const rejectBy = getFlag(rest, '--by');

  try {
    const { message } = await approveOrReject(LEDGER_DIR, rawId, verb, {
      repoRoot: REPO_ROOT,
      ...(trailText !== undefined ? { trail: trailText } : {}),
      ...(rejectBy !== undefined ? { by: rejectBy } : {}),
    });
    console.log(message);
  } catch (e) {
    if (e instanceof VerbError) {
      // reject junk arguments (e.g. a stray "--help") before ever touching the ledger —
      // otherwise `loopctl reject --help` would reject a literal item named "--help".
      // approveOrReject validates the id shape before any withLock/fold.
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdAccept(rest: string[]): Promise<void> {
  const rawId = rest[0];
  if (!rawId) {
    console.error('Usage: loopctl accept <WI-NNN> [--trail "<text>"]');
    process.exit(1);
  }
  const trailText = getFlag(rest, '--trail');

  try {
    const { message } = await acceptItem(LEDGER_DIR, rawId, trailText !== undefined ? { trail: trailText } : {});
    console.log(message);
  } catch (e) {
    if (e instanceof VerbError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdPortability(rest: string[]): Promise<void> {
  const positionalArgs = positionals(rest, ['--by', '--trail']);
  const rawId = positionalArgs[0];
  const replyBody = positionalArgs[1];
  if (!rawId || replyBody === undefined) {
    console.error('Usage: loopctl portability <WI-NNN> "<reply body>" [--by <actor>] [--trail "<text>"]');
    process.exit(1);
  }
  const by = getFlag(rest, '--by');
  const trailText = getFlag(rest, '--trail');

  try {
    const { outcome, message } = await amendPortability(LEDGER_DIR, rawId, replyBody, {
      ...(by !== undefined ? { by } : {}),
      ...(trailText !== undefined ? { trail: trailText } : {}),
    });
    if (outcome === 'rejected') {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  } catch (e) {
    if (e instanceof VerbError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdBeat(rest: string[]): Promise<void> {
  const beatName = rest[0];
  const dryRun = hasFlag(rest, '--dry-run');
  const repoRoot = REPO_ROOT;

  if (beatName !== 'reactor' && beatName !== 'dispatch') {
    console.error(`Usage: loopctl beat reactor|dispatch [--dry-run]`);
    process.exit(1);
  }

  if (beatName === 'reactor') {
    // runDir: RUN_DIR — the beats' run-state (watermarks, locks, notified stamps) must live
    // beside the ledger they describe (plane-home aware), not under the driven repo.
    const result = await runReactor({ repoRoot, ledgerDir: LEDGER_DIR, runDir: RUN_DIR, dryRun });
    if (dryRun) console.log('[dry-run] reactor beat planned actions:');
    for (const step of result.steps) {
      const mark = step.ok ? '✓' : '✗';
      console.log(`  ${mark} ${step.step}: ${step.detail ?? ''} (events=${step.eventsWritten})`);
    }
    console.log(`Total events written: ${result.totalEventsWritten}`);
    const anyFailed = result.steps.some(s => !s.ok);
    if (anyFailed) process.exit(1);
  } else {
    const result = await runDispatch({ repoRoot, ledgerDir: LEDGER_DIR, runDir: RUN_DIR, dryRun });
    if (dryRun) console.log('[dry-run] dispatch beat planned actions:');
    if (result.detail) console.log(`  ${result.detail}`);
    for (const d of result.dispatched) {
      console.log(`  ${d.item}: dispatched=${d.dispatched} gate=${d.gateOutcome ?? 'n/a'} ${d.detail ?? ''}`);
    }
    console.log(`Total events written: ${result.totalEventsWritten}`);
  }
  // A stray provider-child handle must never keep the beat process alive past its work —
  // launchd will not refire while the old instance runs (a stale handle wedges the next beat).
  process.exit(0);
}

async function cmdBoard(): Promise<void> {
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const cfg = loadConfig(REPO_ROOT);
  const result = fold(allEvents, { defaultTarget: cfg.defaultTarget });
  console.log(renderBoard(result));
}

async function cmdSlo(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const cfg = loadConfig(REPO_ROOT);
  const opsEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const opsOnly = opsEvents.filter(ev =>
    ev.type.startsWith('slo.') ||
    ev.type.startsWith('heal.') ||
    ev.type === 'loop.beat',
  );

  const probes = makeRealProbes(REPO_ROOT, RUN_DIR, cfg.slo?.expectedLaunchdLabels, cfg.slo?.probePaths);
  // deploy + instance probes are loopkit-native (makeRealProbes deliberately leaves them for
  // the caller to inject — same as reactor.ts's stepProvisionalAccept/stepSloEvaluate).
  // Without this the 'instances' row always reads unknown ('app ? / demo ?') regardless of
  // actual health, since evaluateSloBoard never calls a probe that was never set.
  probes.deploy = makeDeployProbe(REPO_ROOT);
  probes.instanceProbe = makeInstanceProbe();
  // Inject provider health probe — same closure pattern as stepSloEvaluate in reactor.ts.
  const runDir = RUN_DIR;
  const reg = makeRegistry({
    providers: Object.fromEntries(
      Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }])
    ),
    sensitivityAllowlists: cfg.sensitivityAllowlists,
    chains: cfg.chains,
    cooldownMs: cfg.providerCooldownMs,
  }, makeFileHealthFns(runDir));
  probes.providerHealth = () => {
    // TRUST-HARDENING (defect c): plane-level health readout of the reference ('internal') routing
    // lane for the `slo` CLI display. Reads on-disk health markers only — sends NO item/repo
    // material to any provider — so 'internal' is the correct, justified literal here (there is no
    // item to resolve a sensitivity from). Per-item fail-closed resolution lives at the routing/
    // build call sites (reactor stepRoute, dispatch), not in this status probe.
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
  const board = evaluateSloBoard(cfg.slo, probes, opsOnly);

  if (asJson) {
    console.log(JSON.stringify(board, null, 2));
  } else {
    const DOT: Record<string, string> = { met: 'OK', 'at-risk': '??', breached: 'XX', unknown: '--' };
    for (const row of board) {
      const dot = DOT[row.status] ?? '--';
      const grad = row.graduation
        ? ` [grad:${row.graduation.cleanDays}d${row.graduation.eligible ? ' ELIGIBLE' : ''}${row.graduation.shadowDays > 0 ? ` shadow:${row.graduation.shadowDays}d` : ''}]`
        : '';
      console.log(`[${dot}] ${row.key.padEnd(18)} ${row.value.padEnd(30)} target: ${row.target}${grad}`);
    }
    const breached = board.filter(r => r.status === 'breached').length;
    const atRisk = board.filter(r => r.status === 'at-risk').length;
    console.log(`\n${breached} breached · ${atRisk} at-risk · ${board.length - breached - atRisk} met/unknown`);
  }
}

/**
 * brief [--json]
 * Deterministic daily ops brief: composes fold()/evaluateSloBoard()/foldCosts()/
 * projectVerdicts()/buildRoutingTableWithSpecs() (the last only on Mondays) into one digest.
 * Zero-LLM, pure composition — see brief.ts for the render/compute split.
 */
async function cmdBrief(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const cfg = loadConfig(REPO_ROOT);
  await collectAndAppendAllUsage();
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const result = fold(allEvents);
  const costSummary = foldCosts(allEvents);
  const verdicts = projectVerdicts(allEvents);

  const probes = makeRealProbes(REPO_ROOT, RUN_DIR, cfg.slo?.expectedLaunchdLabels, cfg.slo?.probePaths);
  // makeRealProbes deliberately leaves deploy/instanceProbe for the caller (see cmdSlo)
  // — without this the brief's 'instances' row always reads unknown regardless of actual health.
  probes.deploy = makeDeployProbe(REPO_ROOT);
  probes.instanceProbe = makeInstanceProbe();
  const runDir = RUN_DIR;
  const reg = makeRegistry({
    providers: Object.fromEntries(
      Object.entries(cfg.providers).map(([k, v]) => [k, { model: v.model }])
    ),
    sensitivityAllowlists: cfg.sensitivityAllowlists,
    chains: cfg.chains,
    cooldownMs: cfg.providerCooldownMs,
  }, makeFileHealthFns(runDir));
  probes.providerHealth = () => {
    // TRUST-HARDENING (defect c): plane-level health readout of the reference ('internal') routing
    // lane for the daily `brief`. Reads on-disk health markers only — no item/repo material leaves
    // the process — so 'internal' is the correct, justified literal (there is no item context here).
    // Per-item fail-closed resolution lives at the routing/build call sites, not this probe.
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
  const opsOnly = allEvents.filter(ev =>
    ev.type.startsWith('slo.') ||
    ev.type.startsWith('heal.') ||
    ev.type === 'loop.beat',
  );
  const sloRows = evaluateSloBoard(cfg.slo, probes, opsOnly);

  const now = new Date();
  let routing: RoutingSection | undefined;
  if (now.getUTCDay() === 1) {
    const routingCfg = mergeRoutingConfig(cfg.routing, ROUTING_CONFIG_DEFAULTS);
    const trajectory = projectTrajectory(allEvents, { days: routingCfg.windowDays });
    const specsByWi = new Map<string, string | undefined>(
      Array.from(result.items.entries()).map(([id, r]) => [id, r.spec ?? r.sourceText]),
    );
    const table = buildRoutingTableWithSpecs(trajectory.attempts, specsByWi, { windowDays: routingCfg.windowDays });
    routing = { windowDays: routingCfg.windowDays, table };
  }

  const briefCfg: BriefConfig = {
    cycleTimeMedianHours: cfg.slo.cycleTimeMedianHours ?? 24,
    firstPassRate7dFloor: cfg.slo.firstPassRate7dFloor ?? 0.5,
    ...(cfg.slo.dailyTokenBudget !== undefined ? { dailyTokenBudget: cfg.slo.dailyTokenBudget } : {}),
  };

  const brief = computeBrief({
    fold: result,
    events: allEvents,
    sloRows,
    costSummary,
    verdicts,
    cfg: briefCfg,
    sla: {
      decisionMaxHours: cfg.slo.decisionMaxHours ?? 72,
      acceptanceMaxHours: cfg.slo.acceptanceMaxHours ?? 48,
    },
    now,
    ...(routing ? { routing } : {}),
  });

  if (asJson) {
    console.log(JSON.stringify(brief));
  } else {
    console.log(renderBriefMarkdown(brief));
  }
}

/**
 * Top up the ledger with the operator's interactive-session spend and consult/
 * interactive-manual spend before every `costs` read — both collectors are watermark-
 * incremental, so steady-state cost is a few small file stats, not a full transcript re-scan.
 * Each collector is independently fail-soft and time-bounded: a stuck or failing one must
 * never block the other or break `costs` reporting for the rest of the plane.
 */
async function collectAndAppendAllUsage(): Promise<void> {
  try {
    const watermarkPath = join(RUN_DIR, 'interactive-usage.watermark.json');
    const { events } = await collectInteractiveUsage({ watermarkPath, timeBudgetMs: 3_000 });
    if (events.length > 0) await appendEvents(LEDGER_DIR, events);
  } catch {
    // Best-effort — ledger-tracked (dispatch/reactor/scout/judge) spend still reports.
  }
  try {
    const watermarkPath = join(RUN_DIR, 'codex-usage.watermark.json');
    const { events } = await collectCodexUsage({ watermarkPath, timeBudgetMs: 3_000 });
    if (events.length > 0) await appendEvents(LEDGER_DIR, events);
  } catch {
    // Best-effort — an operator machine with no ~/.codex/sessions just no-ops here.
  }
  try {
    // The drop file is written by the EXTERNAL statusline hook into the driven repo's
    // embedded run dir — that producer contract stays put; only CLI-owned run-state
    // (the watermark) follows the resolved RUN_DIR.
    const dropFilePath = join(REPO_ROOT, '.ai', 'runs', 'loopkit', 'claude-quota.jsonl');
    const watermarkPath = join(RUN_DIR, 'claude-quota.watermark.json');
    const { events } = await collectClaudeQuota({ dropFilePath, watermarkPath });
    if (events.length > 0) await appendEvents(LEDGER_DIR, events);
  } catch {
    // Best-effort — no drop file yet (statusline.py hasn't run since this shipped) just no-ops.
  }
}

/**
 * costs [--by loop|provider|day] [--json]
 * Projects `cost.usage` ops events into per-loop / per-provider / per-day spend.
 * Default (no --by, no --json) prints all three groupings plus a total.
 */
async function cmdCosts(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const by = getFlag(rest, '--by');
  await collectAndAppendAllUsage();
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const summary = foldCosts(allEvents);

  if (asJson) {
    console.log(JSON.stringify(summary));
    return;
  }

  const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;
  const printRows = (title: string, rows: CostRow[]): void => {
    console.log(`\n${title}:`);
    if (rows.length === 0) { console.log('  (no cost.usage events)'); return; }
    for (const r of rows) {
      console.log(`  ${r.key.padEnd(14)} ${String(r.tokens).padStart(8)} tok  ${fmtUsd(r.usd).padStart(10)}  ${r.calls} call(s)`);
    }
  };

  if (by === 'loop') printRows('By loop', summary.byLoop);
  else if (by === 'provider') printRows('By provider', summary.byProvider);
  else if (by === 'day') printRows('By day', summary.byDay);
  else {
    printRows('By loop', summary.byLoop);
    printRows('By provider', summary.byProvider);
    printRows('By day', summary.byDay);
  }
  console.log(`\nTotal: ${summary.totalTokens} tokens · ${fmtUsd(summary.totalUsd)} · ${summary.totalCalls} call(s)`);
}

/**
 * quota [--json]
 * Unified subscription-quota view: latest utilization plus a regressed capacity/runway
 * estimate per provider:window, folded from `quota.snapshot` events (a provider's
 * five_hour/seven_day windows via a statusline, another's primary via the rollout
 * collector). All $ figures are API-equivalent estimates, never a billed charge.
 */
const QUOTA_PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** "reading 26h old" — Codex is conserved and only refreshes on a consult, so its reading
 *  can be genuinely old; Claude refreshes every ~5min during a session. Exported for direct
 *  unit-test coverage (cmdQuota itself is exercised via CLI spawn tests, not import). */
export function fmtReadingAge(hours: number): string {
  return `reading ${Math.round(hours)}h old`;
}

async function cmdQuota(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  await collectAndAppendAllUsage();
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const summary = foldCosts(allEvents);

  if (asJson) {
    console.log(JSON.stringify(summary.quotaCapacity));
    return;
  }

  if (summary.quotaCapacity.length === 0) {
    console.log('No quota.snapshot events yet — collectors report here once a session has run.');
    return;
  }

  const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;
  for (const r of summary.quotaCapacity) {
    const cap = r.capacityTokensPerWeek !== undefined
      ? `~${Math.round(r.capacityTokensPerWeek).toLocaleString()} tok/wk (~${fmtUsd(r.capacityUsdPerWeek ?? 0)}/wk, API-equivalent)`
      : 'capacity pending (needs a second same-cycle reading)';
    const runway = r.runwayDays !== undefined ? `runway ~${r.runwayDays.toFixed(1)}d` : 'runway pending';
    const label = `${QUOTA_PROVIDER_LABELS[r.provider] ?? r.provider} · ${formatQuotaWindowLabel(r.window, r.windowMinutes)}`;
    const reset = r.resetsAt ? `resets ${r.resetsAt}` : 'reset unknown';
    const age = `${fmtReadingAge(r.readingAgeHours)}${r.readingAgeHours >= 24 ? ' [stale]' : ''}`;
    console.log(`  ${label.padEnd(22)} ${r.usedPct.toFixed(1).padStart(5)}%  ${cap}  ${runway}  ${reset}  ${age}`);
  }
}

/**
 * verdicts [--json]
 * Judge calibration projection: for every review.verdict event, report the item,
 * verdict, confidence, and outcome so far (accepted | none-yet), plus summary stats.
 * Use this to track judge agreement before promoting to gating mode.
 */
async function cmdVerdicts(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const summary = projectVerdicts(allEvents);

  if (asJson) {
    console.log(JSON.stringify(summary));
    return;
  }

  console.log(`Judge verdicts (calibration): ${summary.total} total`);
  console.log(`  Judged fail:  ${summary.judgedFail}`);
  console.log(`  With outcome: ${summary.withOutcome}`);
  if (summary.withOutcome > 0) {
    console.log(`  Agree (pass+accepted):     ${summary.agreePass}`);
    console.log(`  False alarm (fail+accept): ${summary.falseAlarm}`);
  }
  if (summary.rows.length === 0) {
    console.log('\n  No judge verdicts in the ledger yet.');
    return;
  }
  console.log('');
  for (const row of summary.rows) {
    const conf = row.confidence.toFixed(2);
    console.log(`  ${row.wi.padEnd(8)} ${row.verdict.padEnd(12)} conf=${conf}  outcome=${row.outcome}`);
  }
}

/**
 * trajectory [--json] [--days N]
 * Per-attempt efficiency projection: recent attempts + aggregate efficiency stats.
 * Pure projection; computed on demand — no beat, no cron.
 *
 * Proxy caveat (displayed in human mode): `turns` ≈ agentic steps from claude CLI
 * num_turns, not exact tool calls. See trajectory.ts for the full caveat.
 */
async function cmdTrajectory(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const daysStr = getFlag(rest, '--days');
  const days = daysStr !== undefined ? Math.max(1, parseInt(daysStr, 10) || 14) : 14;

  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const result = projectTrajectory(allEvents, { days });

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }

  const { window: win, attempts, aggregates: agg } = result;
  console.log(`Trajectory — ${win.days}d window: ${win.from.slice(0, 10)} → ${win.to.slice(0, 10)}`);
  console.log(`  Note: turns ≈ agentic steps (claude CLI proxy, not exact tool calls)`);
  console.log('');

  if (attempts.length === 0) {
    console.log('  No dispatched attempts in window.');
    return;
  }

  // Recent attempts table (last 20, newest first)
  const recent = [...attempts].reverse().slice(0, 20);
  console.log(`Recent attempts (${attempts.length} total, showing last ${recent.length}):`);
  for (const a of recent) {
    const dur = a.durationMinutes !== undefined ? `${a.durationMinutes.toFixed(1)}m` : '--';
    const tok = a.tokens !== undefined ? String(a.tokens) : '--';
    const turns = a.turns !== undefined ? String(a.turns) : '--';
    const usd = a.usd !== undefined ? `$${a.usd.toFixed(4)}` : '--';
    const briefed = a.briefed ? 'briefed' : 'cold';
    const verdict = a.judgeVerdict ? `judge=${a.judgeVerdict}` : '';
    console.log(
      `  ${a.wi.padEnd(8)} #${a.attempt} ${a.outcome.padEnd(12)} dur=${dur.padStart(6)}` +
      ` tok=${tok.padStart(6)} turns=${turns.padStart(3)} ${usd.padStart(8)}  ${briefed}${verdict ? '  ' + verdict : ''}`,
    );
  }

  console.log('');
  console.log('Aggregates:');
  console.log(`  Attempts:             ${agg.attempts}`);
  console.log(`  Distinct items:       ${agg.distinctItems}`);
  console.log(`  Merges:               ${agg.merges}`);
  console.log(`  First-pass merge %:   ${(agg.firstPassMergeRate * 100).toFixed(1)}%`);
  console.log(`  Repair merge %:       ${agg.repairMergeRate > 0 ? (agg.repairMergeRate * 100).toFixed(1) + '%' : 'n/a'}`);
  console.log(`  Avg USD/merged item:  $${agg.avgUsdPerMergedItem.toFixed(4)}`);
  console.log(`  Avg turns/attempt:    ${agg.avgTurnsPerAttempt > 0 ? agg.avgTurnsPerAttempt.toFixed(1) : 'n/a (no turns data)'}`);
  console.log(`  Avg duration/attempt: ${agg.avgDurationMinutes > 0 ? agg.avgDurationMinutes.toFixed(1) + 'm' : 'n/a'}`);
  console.log(`  Scout coverage:       ${(agg.scoutCoverage * 100).toFixed(1)}%`);
  console.log(`  Judge fail share:     ${agg.judgeFailShare > 0 ? (agg.judgeFailShare * 100).toFixed(1) + '%' : 'n/a (no verdicts)'}`);
}

/**
 * routing [--json]
 * Render the model routing table (bucket × model: samples, first-pass %, avg $),
 * the current routing mode, and what 'active' mode would change from the current config.
 *
 * Output shape (--json):
 * {
 *   mode: 'off'|'advisory'|'active',
 *   windowDays: number,
 *   minSamples: number,
 *   exploreRate: number,
 *   exploreModel: string,
 *   table: {
 *     small:  Record<model, { samples, firstPassRate, avgUsd }>,
 *     medium: Record<model, { samples, firstPassRate, avgUsd }>,
 *     large:  Record<model, { samples, firstPassRate, avgUsd }>,
 *   },
 *   // What 'active' mode would pick for each bucket, given current table + config.
 *   // Uses injected rand=()=>1 (never explores) for a deterministic advisory snapshot.
 *   advisory: Record<bucket, { model: string; source: string } | null>,
 * }
 *
 * Returns valid JSON + exit 0 even with no data (empty table) so the console feature-detects it.
 */
async function cmdRouting(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');

  const cfg = loadConfig(REPO_ROOT);
  const routingCfg = mergeRoutingConfig(cfg.routing, ROUTING_CONFIG_DEFAULTS);

  // The quarantine-aware loader is the CLI's one read path — keep it so.
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const result = fold(allEvents);
  const trajectory = projectTrajectory(allEvents, { days: routingCfg.windowDays });

  // Build specsByWi from the fold
  const specsByWi = new Map<string, string | undefined>(
    Array.from(result.items.entries()).map(([id, r]) => [id, r.spec ?? r.sourceText]),
  );

  const table = buildRoutingTableWithSpecs(
    trajectory.attempts,
    specsByWi,
    { windowDays: routingCfg.windowDays },
  );

  // Compute what 'active' would pick for each bucket, deterministically (no exploration randomness).
  // Use rand=()=>1 so exploration never fires (1 >= exploreRate always) — advisory snapshot only.
  const activeCfg = { ...routingCfg, mode: 'active' as const };
  const noRand = () => 1;
  const advisory: Record<string, { model: string; source: string } | null> = {};
  for (const bucket of (['small', 'medium', 'large'] as SpecBucket[])) {
    const choice = chooseModel(table, bucket, routingCfg.exploreModel, activeCfg, noRand);
    advisory[bucket] = choice.modelSource !== 'incumbent'
      ? { model: choice.model, source: choice.modelSource }
      : (Object.keys(table[bucket]).length > 0
          ? { model: choice.model, source: choice.modelSource }
          : null);
  }

  if (asJson) {
    console.log(JSON.stringify({
      mode: routingCfg.mode,
      windowDays: routingCfg.windowDays,
      minSamples: routingCfg.minSamples,
      exploreRate: routingCfg.exploreRate,
      exploreModel: routingCfg.exploreModel,
      table,
      advisory,
    }));
    return;
  }

  const BUCKETS: SpecBucket[] = ['small', 'medium', 'large'];
  const BUCKET_LABELS: Record<SpecBucket, string> = {
    small: 'small (<1500)',
    medium: 'medium (<6000)',
    large: 'large (≥6000)',
  };

  console.log(`Model routing table — mode: ${routingCfg.mode}  window: ${routingCfg.windowDays}d  minSamples: ${routingCfg.minSamples}`);
  console.log(`  Exploration: rate=${(routingCfg.exploreRate * 100).toFixed(0)}%  model=${routingCfg.exploreModel}  (small bucket, active mode, under-sampled only)`);
  console.log('');

  let hasAnyData = false;
  for (const bucket of BUCKETS) {
    const cells = table[bucket];
    const models = Object.keys(cells);
    if (models.length === 0) {
      console.log(`  ${BUCKET_LABELS[bucket].padEnd(20)}  (no data in window)`);
      continue;
    }
    hasAnyData = true;
    console.log(`  ${BUCKET_LABELS[bucket]}`);
    for (const m of models) {
      const c = cells[m]!;
      const passStr = `${(c.firstPassRate * 100).toFixed(1)}%`;
      const usdStr = c.avgUsd > 0 ? `$${c.avgUsd.toFixed(4)}` : '--';
      console.log(`    ${m.padEnd(16)} samples=${String(c.samples).padStart(3)}  first-pass=${passStr.padStart(6)}  avg=${usdStr}`);
    }
  }

  if (!hasAnyData) {
    console.log('  No attempt data in window — run builds first, then inspect this table.');
    console.log('  To graduate to active mode, set routing.mode="active" in loopkit.config.json');
    console.log('  after the table has minSamples per model per bucket.');
  } else {
    console.log('');
    console.log('Active-mode advisory (what would change if mode=active):');
    for (const bucket of BUCKETS) {
      const a = advisory[bucket];
      console.log(`  ${BUCKET_LABELS[bucket].padEnd(20)}  → ${a ? `${a.model} (${a.source})` : '(incumbent, no qualified model)'}`);
    }
    console.log('');
    console.log('Graduation path:');
    console.log('  1. Keep mode=advisory (default). Inspect this table regularly.');
    console.log(`  2. When cells have ≥${routingCfg.minSamples} samples, flip mode=active in loopkit.config.json.`);
    console.log('  3. Watch for regime changes (new model, repo shifts) and re-evaluate windowDays.');
  }
}

/**
 * execution-config [--json] [--days N]
 * Which execution CONFIGURATION (grouped by model) produces ACCEPTED outcomes — not
 * anthropomorphic "agent performance". Pure aggregation over existing events
 * (build.dispatched/gate.passed/item.merged/item.accepted/cost.usage) via
 * projectExecutionConfig (executionConfig.ts).
 *
 * Output shape (--json):
 * {
 *   minSamples: number,
 *   window: { days, from, to },
 *   cells: Array<{
 *     model, n, merged, accepted, gated, gatedFirstPass, totalUsd, totalRetries,
 *     acceptRate?, firstPassGateRate?, costPerAcceptedUsd?, retriesPerAccept?,
 *   }>,
 * }
 *
 * Returns valid JSON + exit 0 even with no data (empty cells) so the console
 * feature-detects it, same contract as `routing`.
 */
async function cmdExecutionConfig(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const daysStr = getFlag(rest, '--days');
  const days = daysStr !== undefined ? Math.max(1, parseInt(daysStr, 10) || 30) : 30;

  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const result = projectExecutionConfig(allEvents, { days });

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Execution config (by model) — ${result.window.days}d window: ${result.window.from.slice(0, 10)} → ${result.window.to.slice(0, 10)}`);
  console.log(`  minSamples for a reliable ratio: ${result.minSamples}`);
  console.log('');

  if (result.cells.length === 0) {
    console.log('  No model-attributed items in window.');
    return;
  }

  for (const c of result.cells) {
    const insufficient = c.n < result.minSamples ? '  [insufficient data]' : '';
    console.log(`  ${c.model.padEnd(16)} n=${String(c.n).padStart(3)}${insufficient}`);
    console.log(`    accept rate:        ${c.acceptRate !== undefined ? `${(c.acceptRate * 100).toFixed(1)}%` : 'n/a (0 merged)'}  (${c.accepted}/${c.merged})`);
    console.log(`    first-pass gate:    ${c.firstPassGateRate !== undefined ? `${(c.firstPassGateRate * 100).toFixed(1)}%` : 'n/a (0 gated)'}  (${c.gatedFirstPass}/${c.gated})`);
    console.log(`    cost / accepted:    ${c.costPerAcceptedUsd !== undefined ? `$${c.costPerAcceptedUsd.toFixed(4)}` : 'n/a (0 accepted)'}`);
    console.log(`    retries / accept:   ${c.retriesPerAccept !== undefined ? c.retriesPerAccept.toFixed(2) : 'n/a (0 accepted)'}`);
  }
}

/**
 * Oldest build-entry mtime across every `packages/*` workspace that declares a `build`
 * script — a proxy for "when was this repo's dist last (re)built as a whole". Stats each
 * workspace's own `main` entry point (the file every build touches) rather than the `dist`
 * directory's own mtime: overwriting an existing file's CONTENT in place (what an incremental
 * tsc build does) updates the file's mtime but does not necessarily touch its parent
 * directory's entry list, so a directory-mtime probe would miss exactly the drift this
 * backstop exists to catch. Returns null when there is no `packages/` dir at all (non-monorepo
 * layout, or nothing to check); a workspace that declares `build` but has no built entry yet
 * pins the result at 0 (maximally stale) regardless of any other workspace's freshness.
 */
function distEntryMtimeMs(repoRoot: string): number | null {
  const workspacesRoot = join(repoRoot, 'packages');
  let entries: string[];
  try { entries = readdirSync(workspacesRoot); } catch { return null; }
  let oldest: number | null = null;
  for (const entry of entries) {
    let pkg: { main?: string; scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(workspacesRoot, entry, 'package.json'), 'utf8'));
    } catch { continue; }
    if (!pkg.scripts?.build) continue;
    try {
      const mtimeMs = statSync(join(workspacesRoot, entry, pkg.main ?? 'dist/index.js')).mtimeMs;
      if (oldest === null || mtimeMs < oldest) oldest = mtimeMs;
    } catch {
      oldest = 0;
    }
  }
  return oldest;
}

async function cmdDoctor(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  // Use quarantine-aware load so known-invalid events don't flood stderr
  const quarantinePath = join(LEDGER_DIR, 'quarantine.json');
  const quarantine = loadQuarantine(quarantinePath);
  const allEvents = await loadAllEventsWithQuarantine(LEDGER_DIR);
  const result = fold(allEvents);
  const doctorResult = runDoctor(result, defaultPidProbe);

  // Dist-drift backstop (self-deploy — see loopkit.target.json deployCommand): the newest
  // merge that resolved to THIS repo (a self-hosting target, ADR-005) vs the newest
  // build-entry mtime under packages/*. A merge landing after dist was last built means the
  // beats are executing code older than what was just merged — the incident class an empty
  // deployCommand produced. Self-heals by re-running the manifest's deployCommand when one is
  // configured; otherwise surfaces the gap instead of leaving it invisible.
  let selfMergeMs: number | null = null;
  for (const rec of result.items.values()) {
    if (!rec.mergedAt) continue;
    const resolution = resolveRegisteredTarget(result.targets, rec);
    if (!resolution.ok || resolution.reg.repoPath !== REPO_ROOT) continue;
    const ms = new Date(rec.mergedAt).getTime();
    if (!isNaN(ms) && (selfMergeMs === null || ms > selfMergeMs)) selfMergeMs = ms;
  }
  let distDrift: (DistDriftResult & { healed: boolean; reason?: string }) | undefined;
  if (selfMergeMs !== null) {
    const drift = detectDistDrift(selfMergeMs, distEntryMtimeMs(REPO_ROOT), Date.now());
    if (drift.drifted) {
      const manifestPath = join(REPO_ROOT, 'loopkit.target.json');
      const manifest = existsSync(manifestPath) ? readTargetManifest(REPO_ROOT) : undefined;
      if (manifest?.deployCommand) {
        const r = spawnSync('sh', ['-c', manifest.deployCommand], { cwd: REPO_ROOT, stdio: 'pipe' });
        distDrift = {
          ...drift,
          healed: r.status === 0,
          reason: r.status === 0 ? undefined : (r.stderr?.toString().slice(-400) || 'deployCommand exited non-zero'),
        };
      } else {
        distDrift = { ...drift, healed: false, reason: 'no deployCommand configured for this target' };
      }
    }
  }

  // Count invalid events: re-scan the ledger for lines that fail validateEvent,
  // splitting into known-quarantined vs new unknowns.
  // (We derive this from the quarantine set size vs what the raw load found.)
  const quarantinedKnown = quarantine.size;
  // Unknown invalids: events that would warn but aren't in quarantine.
  // We can't easily recount without a second pass — report quarantine size as proxy.
  const invalidUnknown = 0;  // surfaced by stderr warnings; not re-computed here

  if (asJson) {
    console.log(JSON.stringify({
      orphans: doctorResult.orphans.map(r => ({ id: r.id, state: r.state, attempts: r.attempts })),
      actions: doctorResult.actions.map(a => ({ type: a.type, item: a.item, attempt: a.attempt })),
      quarantinedKnown,
      invalidUnknown,
      distDrift: distDrift ?? null,
    }, null, 2));
  } else {
    if (doctorResult.orphans.length === 0) {
      console.log('No orphans detected.');
    } else {
      console.log(`Orphans detected: ${doctorResult.orphans.length}`);
      for (const action of doctorResult.actions) {
        console.log(`  ${action.item}: ${action.type} (attempt ${action.attempt})`);
      }
      console.log('\nRun with --heal to apply actions.');
    }
    if (quarantinedKnown > 0) {
      console.log(`Quarantined known-invalid events: ${quarantinedKnown} (warnings suppressed)`);
    }
    if (distDrift) {
      const behindMin = Math.round(distDrift.behindMs / 60_000);
      if (distDrift.healed) {
        console.log(`Dist drift detected (last merge ${behindMin}m ahead of built dist) — rebuilt via deployCommand.`);
      } else {
        console.log(`Dist drift detected (last merge ${behindMin}m ahead of built dist) — NOT healed: ${distDrift.reason}`);
      }
    }
  }
}

/**
 * audit <target> [--json]
 * Target-readiness hygiene checker: zero-LLM, deterministic file/git/ledger presence
 * checks against `<target>` (a loopkit-enabled repo tree), reporting which autonomy tier the
 * target has earned. See audit/index.ts for the current-shape scoping note.
 */
async function cmdAudit(rest: string[]): Promise<void> {
  const asJson = hasFlag(rest, '--json');
  const target = rest[0];
  if (!target) {
    console.error('Usage: loopctl audit <target-path> [--json]');
    process.exit(1);
  }
  const targetPath = resolve(target);
  if (!existsSync(targetPath)) {
    console.error(`Target path not found: ${targetPath}`);
    process.exit(1);
  }
  const result = await runAudit(targetPath);

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Audit: ${result.target}`);
  console.log(`${result.score.label}  (${result.score.passed}/${result.score.total} checks passed)`);
  console.log('');
  for (const c of result.checks) {
    console.log(`  [${c.passed ? 'OK' : '--'}] ${c.id.padEnd(16)} ${c.message}`);
  }
}

async function cmdCompact(rest: string[]): Promise<void> {
  const dryRun = hasFlag(rest, '--dry-run');
  const cfg = loadConfig(REPO_ROOT);
  const opsRetentionMonths = cfg.ledger?.opsRetentionMonths ?? 2;

  const result = await compact({
    ledgerDir: LEDGER_DIR,
    opsRetentionMonths,
    dryRun,
  });

  console.log(formatCompactResult(result));
  if (!dryRun && result.archived.length > 0) {
    console.log(`\nArchive: ${join(LEDGER_DIR, 'archive')}`);
  }
}

/**
 * Conversation commands: conv new, conv say, conv close
 */
async function cmdConv(rest: string[]): Promise<void> {
  const subcmd = rest[0];

  if (subcmd === 'new') {
    const title = rest[1];
    if (!title) {
      console.error('Usage: loopctl conv new "<title>"');
      process.exit(1);
    }
    await withLock(LEDGER_DIR, async tx => {
      const allEvents = await tx.loadAll();
      const result = fold(allEvents);
      const convId = nextConvId(result);
      const ev = makeEvent('cli', convId, 'conv.started', {
        source: 'cli',
        title,
      });
      await tx.append([ev]);
      console.log(`Created ${convId}`);
    });
  } else if (subcmd === 'say') {
    const convId = rest[1];
    const text = rest[2];
    if (!convId || !text) {
      console.error('Usage: loopctl conv say <CONV-NNN> "<text>"');
      process.exit(1);
    }
    if (!/^CONV-\d+$/.test(convId)) {
      console.error(`Invalid conversation id: ${convId}`);
      process.exit(1);
    }
    const ev = makeEvent('cli', convId, 'msg.in', { text });
    await appendEvents(LEDGER_DIR, [ev]);
    console.log(`Added message to ${convId}`);
  } else if (subcmd === 'close') {
    const convId = rest[1];
    const reason = getFlag(rest, '--reason') ?? 'operator';
    if (!convId) {
      console.error('Usage: loopctl conv close <CONV-NNN> [--reason <reason>]');
      process.exit(1);
    }
    if (!/^CONV-\d+$/.test(convId)) {
      console.error(`Invalid conversation id: ${convId}`);
      process.exit(1);
    }
    const ev = makeEvent('cli', convId, 'conv.closed', { reason });
    await appendEvents(LEDGER_DIR, [ev]);
    console.log(`Closed ${convId}`);
  } else {
    console.error(`Unknown conv subcommand: ${subcmd}`);
    console.error('Usage: loopctl conv new|say|close ...');
    process.exit(1);
  }
}


// ---------------------------------------------------------------------------
// Session mode (attended): session / claim / release / conduct
// Bounded section — the claim-lease kernel verbs (session.ts) and the conductor
// (conductor.ts). Nothing here touches the beat commands above.
// ---------------------------------------------------------------------------

/** Resolve the terminal's current session id or exit with a hint. */
function requireCurrentSession(): string {
  const sessionId = readCurrentSession(RUN_DIR);
  if (!sessionId) {
    console.error('No active session — run `loopctl session start` first.');
    process.exit(1);
  }
  return sessionId;
}

async function cmdSession(rest: string[]): Promise<void> {
  const sub = rest[0];
  try {
    if (sub === 'start') {
      const existing = readCurrentSession(RUN_DIR);
      if (existing) {
        console.error(`Session ${existing} is already current — run \`loopctl session end\` first.`);
        process.exit(1);
      }
      const { sessionId } = await startSession(LEDGER_DIR, { source: 'cli' });
      writeCurrentSession(RUN_DIR, sessionId);
      console.log(`Started session ${sessionId}`);
    } else if (sub === 'beat') {
      const sessionId = getFlag(rest, '--session') ?? requireCurrentSession();
      await heartbeatSession(LEDGER_DIR, sessionId);
      console.log(`Heartbeat recorded for ${sessionId}`);
    } else if (sub === 'end') {
      const sessionId = getFlag(rest, '--session') ?? requireCurrentSession();
      const { released } = await endSession(LEDGER_DIR, sessionId);
      clearCurrentSession(RUN_DIR);
      console.log(released.length > 0
        ? `Ended session ${sessionId} — released ${released.join(', ')}`
        : `Ended session ${sessionId} — no claims held`);
    } else {
      console.error('Usage: loopctl session start|beat|end [--session <ses-id>]');
      process.exit(1);
    }
  } catch (e) {
    if (e instanceof VerbError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdClaim(rest: string[]): Promise<void> {
  const allQueued = hasFlag(rest, '--all-queued');
  const ttlStr = getFlag(rest, '--ttl');
  const ids = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--ttl' && rest[i - 1] !== '--session');
  if (!allQueued && ids.length === 0) {
    console.error('Usage: loopctl claim <WI-NNN...|--all-queued> [--ttl <minutes>]');
    process.exit(1);
  }
  const sessionId = getFlag(rest, '--session') ?? requireCurrentSession();
  try {
    const result = await claimItems(LEDGER_DIR, {
      sessionId,
      ...(allQueued ? { allQueued: true } : { ids }),
      ...(ttlStr !== undefined ? { ttlMinutes: Math.max(1, parseInt(ttlStr, 10) || 0) } : {}),
    });
    console.log(result.claimed.length > 0
      ? `Claimed ${result.claimed.join(', ')} for ${sessionId}`
      : 'Nothing claimed.');
    for (const s of result.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  } catch (e) {
    if (e instanceof VerbError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdRelease(rest: string[]): Promise<void> {
  const reason = getFlag(rest, '--reason');
  const ids = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--reason');
  if (ids.length === 0) {
    console.error('Usage: loopctl release <WI-NNN...> [--reason "<text>"]');
    process.exit(1);
  }
  try {
    const result = await releaseItems(LEDGER_DIR, { ids, ...(reason !== undefined ? { reason } : {}) });
    console.log(result.released.length > 0
      ? `Released ${result.released.join(', ')}`
      : 'Nothing released.');
    for (const s of result.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  } catch (e) {
    if (e instanceof VerbError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdConduct(rest: string[]): Promise<void> {
  const dryRun = hasFlag(rest, '--dry-run');
  const claimAllQueued = hasFlag(rest, '--claim-all-queued');
  const result = await runConduct({
    ledgerDir: LEDGER_DIR,
    runDir: RUN_DIR,
    repoRoot: REPO_ROOT,
    dryRun,
    claimAllQueued,
  });

  if (result.clusters.length === 0) {
    console.log(result.detail ?? 'Nothing to conduct.');
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] conduct plan for ${result.sessionId} — ${result.clusters.length} cluster(s):`);
    for (const c of result.clusters) {
      const mode = c.serial ? 'serial' : 'parallel';
      const tgt = c.target ? ` target=${c.target}` : '';
      console.log(`  cluster ${c.index} (${mode})${tgt}: ${c.items.join(', ')}`);
      if (c.detail) console.log(`    ${c.detail}`);
    }
    return;
  }
  console.log(`Conduct ${result.sessionId} — ${result.clusters.length} cluster(s):`);
  let anyFailed = false;
  for (const c of result.clusters) {
    const tgt = c.target ? ` target=${c.target}` : '';
    const commit = c.mergeCommit ? ` (${c.mergeCommit.slice(0, 8)})` : '';
    console.log(`  cluster ${c.index}${tgt}: ${c.outcome}${commit} — ${c.items.join(', ')}${c.detail ? ` · ${c.detail}` : ''}`);
    if (c.outcome !== 'merged') anyFailed = true;
  }
  if (anyFailed) process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { cmd, rest } = parseArgs(process.argv);

  // Enforce-or-init the plane-home BEFORE any command can append: a plane-home root that
  // is not a git repo would make commit-on-append durability a silent no-op, so the first
  // append must always land in an initialized repo. Idempotent and cheap once initialized;
  // embedded mode (incl. the legacy LOOPKIT_LEDGER override) is a no-op. A failed init
  // throws loudly and aborts the command — never degrade silently.
  ensurePlaneHome(PLANE_HOME);

  switch (cmd) {
    case 'new':
      await cmdNew(rest);
      break;
    case 'append':
      await cmdAppend(rest);
      break;
    case 'state':
      await cmdState(rest);
      break;
    case 'events':
      await cmdEvents(rest);
      break;
    case 'board':
      await cmdBoard();
      break;
    case 'summary':
      await cmdSummary(rest);
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;

    case 'beat':
      await cmdBeat(rest);
      break;

    case 'slo':
      await cmdSlo(rest);
      break;

    case 'brief':
      await cmdBrief(rest);
      break;

    case 'approve':
    case 'reject':
      await cmdApprove(rest, cmd as 'approve' | 'reject');
      break;

    case 'costs':
      await cmdCosts(rest);
      break;

    case 'quota':
      await cmdQuota(rest);
      break;

    case 'verdicts':
      await cmdVerdicts(rest);
      break;

    case 'trajectory':
      await cmdTrajectory(rest);
      break;

    case 'routing':
      await cmdRouting(rest);
      break;

    case 'execution-config':
      await cmdExecutionConfig(rest);
      break;

    case 'accept':
      await cmdAccept(rest);
      break;

    case 'portability':
      await cmdPortability(rest);
      break;

    case 'compact':
      await cmdCompact(rest);
      break;

    case 'audit':
      await cmdAudit(rest);
      break;

    case 'conv':
      await cmdConv(rest);
      break;

    case 'target':
      await cmdTarget(rest);
      break;

    // Session mode (attended) — see the bounded section above.
    case 'session':
      await cmdSession(rest);
      break;
    case 'claim':
      await cmdClaim(rest);
      break;
    case 'release':
      await cmdRelease(rest);
      break;
    case 'conduct':
      await cmdConduct(rest);
      break;

    // stubs (route/park still pending full implementation)
    case 'route':
    case 'park':
      notImplemented(cmd);
      break;

    case '':
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;

    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
