/**
 * supervisor.ts — per-build survivability supervisor (ADR-008 Phase B prep 1).
 *
 * THE GAP THIS CLOSES. Today a detached build's exit file is written by the PARENT beat's own
 * in-process completion handler (claudeCli.ts `finishWithExit`, run inside dispatch.ts's process).
 * If the beat process dies mid-build — SIGKILL, crash, launchd restart — that handler never fires,
 * so no `<WI>-a<N>.exit` sentinel ever lands. The next beat's collection pass finds a pgid-bearing
 * 'building' item with no exit file and the doctor honestly orphan-reaps it (ADR-008 §4). That is
 * correct-but-wasteful: near-finished work is thrown away and requeued.
 *
 * THE PRIMITIVE. This module is a standalone process that OWNS the worker child and writes the exit
 * file from ITS OWN close handler. Spawned detached (its own session — `detached: true`/setsid) it
 * is a DIFFERENT process from the beat, so a beat death mid-build no longer strands the build: the
 * supervisor outlives the beat and still lands a valid exit file for a later beat to collect. It is
 * the "standalone supervisor/wrapper process that owns output capture, timeout, and the atomic
 * completion write" ADR-008 names as the phase-B survival requirement.
 *
 * PHASE-B BOUNDARY (what this slice deliberately does NOT do). This is prep only: the survivability
 * PRIMITIVE plus its proof. It is NOT wired into the live dispatch spawn path — that is the two-phase
 * spawn-protocol change of phase B. There is no behaviour flip and no default change here; nothing
 * that ships today calls this yet.
 *
 * ONE WRITER, ONE PATH CONVENTION. The exit sentinel and the teed usage JSON are written via
 * exitfile.ts (`writeExitFile` / `usageJsonPath`) — the SAME writer and naming the in-process path
 * and the collector (collectDetachedBuilds) already use, never a second implementation. The collector
 * re-parses exactly this usage JSON with the provider's `parseOutput`, so a supervised build and an
 * in-process build converge on identical terminal decoding.
 *
 * Zero runtime dependencies; Node built-ins only.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { writeExitFile, usageJsonPath } from './exitfile.js';

/** What a supervisor needs to run one worker to completion and land its exit file. */
export interface SuperviseOptions {
  /** Runs directory the exit sentinel + usage JSON land in — the SAME dir the collector reads. */
  runDir: string;
  /** WI-NNN — names the exit sentinel (`<WI>-a<N>.exit`). */
  itemId: string;
  /** Build attempt number — names the exit sentinel. */
  attempt: number;
  /** The worker command to run (e.g. 'claude'). */
  command: string;
  /** Worker argv. */
  args: string[];
  /** Working directory for the worker (the build worktree). Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Optional path to persist the worker's stderr (crash-diagnostic channel — mirrors the beat's
   * per-WI `.err` file). Best-effort; a failed write never blocks the exit file.
   */
  errFile?: string;
}

/**
 * Supervise one worker to completion: spawn it, buffer its stdout, and on close write the usage
 * JSON then the exit sentinel (exitfile.ts, atomic tmp+rename). Resolves with the worker's exit
 * code once the exit file has been written (null when the worker was signalled).
 *
 * NEVER rejects. A supervisor that threw would strand the build exactly like the gap it closes,
 * so every failure direction — spawn failure, child 'error', a signalled worker — still lands a
 * valid exit file (a `null` exitCode for the signalled/failed-spawn shapes) rather than nothing.
 *
 * The usage JSON is written BEFORE the exit sentinel, so a collector that observes a complete exit
 * file can always read a complete usage sidecar (usage remains best-effort — the collector tolerates
 * an absent/unreadable one — but it is never observed half-written behind a present exit file).
 */
export function superviseBuild(opts: SuperviseOptions): Promise<number | null> {
  return new Promise(resolve => {
    const usagePath = usageJsonPath(opts.runDir, opts.itemId, opts.attempt);
    let stdout = '';
    let stderr = '';

    // Single terminal path — write usage JSON, optional stderr diagnostic, then the exit sentinel.
    // The exit sentinel is written LAST so its presence implies the sidecars are already complete.
    const finish = (exitCode: number | null): void => {
      let wroteUsage = false;
      try { writeFileSync(usagePath, stdout, 'utf8'); wroteUsage = true; } catch { /* best-effort */ }
      if (opts.errFile) {
        try { writeFileSync(opts.errFile, stderr, 'utf8'); } catch { /* best-effort */ }
      }
      writeExitFile(opts.runDir, opts.itemId, opts.attempt, {
        exitCode,
        ...(wroteUsage ? { usageJsonPath: usagePath } : {}),
      });
      resolve(exitCode);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Spawn itself failed — still land an exit file (signalled shape) so the build is collected
      // and crashed honestly rather than stranded with no sentinel.
      finish(null);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // 'close' (not 'exit') so stdout/stderr have flushed before we snapshot them. code is null
    // when the worker was terminated by a signal — exactly the ExitRecord's `exitCode: null` shape.
    child.on('close', code => finish(code));
    // A spawned child that later emits 'error' (e.g. the binary vanished after fork) still lands
    // an exit file rather than hanging the supervisor forever.
    child.on('error', () => finish(null));
  });
}

/**
 * Parse the standalone supervisor entry's argv (everything after `node build-supervisor.js`).
 * Wire form:
 *
 *     --run-dir <dir> --item <WI> --attempt <N> [--cwd <dir>] [--err-file <path>] -- <command> [args...]
 *
 * Flags before `--`; the worker command and its argv follow `--` verbatim (so a worker flag that
 * looks like one of ours is never misread). Pure — the inverse of {@link formatSupervisorArgs}.
 */
export function parseSupervisorArgv(
  argv: string[],
): { ok: true; opts: SuperviseOptions } | { ok: false; error: string } {
  let runDir: string | undefined;
  let itemId: string | undefined;
  let cwd: string | undefined;
  let errFile: string | undefined;
  let attempt: number | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case '--run-dir': runDir = next(); break;
      case '--item': itemId = next(); break;
      case '--attempt': attempt = parseInt(next() ?? '', 10); break;
      case '--cwd': cwd = next(); break;
      case '--err-file': errFile = next(); break;
      default: return { ok: false, error: `unknown arg: ${a}` };
    }
  }
  const command = argv[i];
  const args = argv.slice(i + 1);
  if (!runDir || !itemId || attempt === undefined || !Number.isFinite(attempt) || !command) {
    return {
      ok: false,
      error: 'usage: build-supervisor --run-dir <dir> --item <WI> --attempt <N> [--cwd <dir>] [--err-file <path>] -- <command> [args...]',
    };
  }
  return {
    ok: true,
    opts: { runDir, itemId, attempt, command, args, ...(cwd ? { cwd } : {}), ...(errFile ? { errFile } : {}) },
  };
}

/**
 * Build the argv a beat passes to the standalone supervisor entry (`build-supervisor.js`) when it
 * spawns the supervisor detached. The inverse of {@link parseSupervisorArgv} — pure, so phase B's
 * live wiring and its tests share ONE wire format rather than two hand-rolled copies. Returns only
 * the supervisor's OWN argv (the caller prepends the node exec + the entry-script path).
 */
export function formatSupervisorArgs(opts: SuperviseOptions): string[] {
  return [
    '--run-dir', opts.runDir,
    '--item', opts.itemId,
    '--attempt', String(opts.attempt),
    ...(opts.cwd ? ['--cwd', opts.cwd] : []),
    ...(opts.errFile ? ['--err-file', opts.errFile] : []),
    '--', opts.command, ...opts.args,
  ];
}

/**
 * Entrypoint body for the standalone supervisor process. Parses argv, runs the worker to
 * completion, then exits mirroring the worker's exit code so a foreground caller can still observe
 * it (a detached caller ignores the code and reads the exit file instead). Kept here — rather than
 * in the thin `build-supervisor.ts` entry — so it is unit-testable without executing on import.
 */
export async function runSupervisorMain(argv: string[]): Promise<void> {
  const parsed = parseSupervisorArgv(argv);
  if (!parsed.ok) {
    process.stderr.write(`[supervisor] ${parsed.error}\n`);
    process.exit(2);
    return;
  }
  const code = await superviseBuild(parsed.opts);
  process.exit(code ?? 1);
}
