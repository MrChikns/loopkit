/**
 * providers/claudeCli.ts — Claude CLI adapter for loopkit.
 *
 * Spawns `claude -p <prompt>` with:
 *   --model <alias>             when request.model is set
 *   --allowedTools <list>       when request.tools is set
 *   --output-format json        always, so we can extract usage
 *
 * Output parsing:
 *   The CLI with --output-format json emits a JSON object with keys:
 *     result (string), is_error (bool), total_cost_usd (number),
 *     num_turns (number), duration_ms (number)
 *
 *   When schema is provided in the request we additionally try to JSON-parse
 *   the text content as structured output.
 *
 * Error policy: NEVER throws — all failures return ProviderError.
 *
 * Operational lessons encoded here:
 *   - PATH must include /opt/homebrew/bin so `claude` resolves under launchd.
 *   - 0-byte or malformed JSON from a spawned claude means crash/OOM — not auth.
 *   - is_error:true with "not logged in" text → auth failure (distinct from crash).
 *   - stderr goes to a captured string, not /dev/null — it's the crash diagnostic channel.
 *   - Timeout default 5 min; a build agent may need longer (callers can override).
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { LlmProvider, ProviderRequest, ProviderResult } from './types.js';
import { writeExitFile, usageJsonPath } from '../exitfile.js';

// Default timeout 5 minutes (standard build agents need headroom)
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Parsed CLI output
// ---------------------------------------------------------------------------

export interface ClaudeJsonOutput {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  /** Real token counts emitted by --output-format json (not coerced to num_turns=1) */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** The usage figures ProviderResult carries. */
export interface ExtractedUsage {
  in: number;
  out: number;
  usd?: number;
  turns?: number;
  durationMs?: number;
}

/**
 * Extract usage figures from a parsed claude `--output-format json` object. Pure — no I/O.
 * The single source of truth for how the CLI's JSON maps to `{ in, out, usd, turns, durationMs }`
 * ("one parser, never a copy"): both the in-process provider path and a detached-build
 * collector derive usage from this one function, so they can never drift.
 *
 * `out` is real output_tokens (never num_turns, which is a step count, not a token count).
 * `in` sums the real input plus cache read/create tokens. turns + durationMs are trajectory
 * proxies. Returns undefined when the object carries no priceable usage at all (usage is
 * present only when total_cost_usd is a number OR in+out > 0).
 */
export function extractUsage(obj: ClaudeJsonOutput): ExtractedUsage | undefined {
  const inTok = typeof obj.usage?.input_tokens === 'number' ? obj.usage.input_tokens : 0;
  const outTok = typeof obj.usage?.output_tokens === 'number' ? obj.usage.output_tokens : 0;
  const cacheRead = typeof obj.usage?.cache_read_input_tokens === 'number' ? obj.usage.cache_read_input_tokens : 0;
  const cacheCreate = typeof obj.usage?.cache_creation_input_tokens === 'number' ? obj.usage.cache_creation_input_tokens : 0;
  const turns = typeof obj.num_turns === 'number' ? obj.num_turns : undefined;
  const durationMs = typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined;
  if (!(typeof obj.total_cost_usd === 'number' || (inTok + outTok) > 0)) return undefined;
  return {
    in: inTok + cacheRead + cacheCreate,
    out: outTok,
    usd: obj.total_cost_usd,
    ...(turns !== undefined ? { turns } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * Detect a Claude CLI authentication failure from the result text.
 * Auth failures return is_error:true with a "not logged in" message (exit code 0 —
 * a claude CLI invariant: it never exits non-zero for auth, only sets is_error).
 * Exported for unit testing without a real CLI spawn.
 */
export function detectAuthFailure(resultText: string): boolean {
  return /not logged in|authentication required|login required/i.test(resultText);
}

/**
 * Parse the claude CLI's `--output-format json` stdout. Exported ("one parser") so a
 * detached-build collector reuses the exact same parse the in-process path uses. Never throws.
 */
export function parseOutput(raw: string): { obj: ClaudeJsonOutput | null; parseErr: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { obj: null, parseErr: 'empty stdout' };
  try {
    return { obj: JSON.parse(trimmed) as ClaudeJsonOutput, parseErr: '' };
  } catch (e) {
    return { obj: null, parseErr: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli';
  /** claude CLI supports agentic tool loops via --allowedTools */
  readonly supportsTools = true;

  /** Optional model alias override (e.g. 'sonnet', 'haiku', 'opus'). */
  private readonly defaultModel?: string;
  /** Optional reasoning-effort override (e.g. 'low', 'high', 'max'). */
  private readonly defaultEffort?: string;

  constructor(opts: { defaultModel?: string; defaultEffort?: string } = {}) {
    this.defaultModel = opts.defaultModel;
    this.defaultEffort = opts.defaultEffort;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const model = req.model ?? this.defaultModel;
    const effort = req.effort ?? this.defaultEffort;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Build argv
    const args: string[] = ['-p', req.prompt, '--output-format', 'json'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (req.tools && req.tools.length > 0) {
      args.push('--allowedTools', req.tools.join(','));
    }

    // Inject Homebrew bin into PATH so claude resolves under launchd
    const env = {
      ...process.env,
      PATH: `${process.env['PATH'] ?? '/usr/bin:/bin'}:/opt/homebrew/bin`,
    };

    const cwd = req.cwd ?? process.cwd();

    // Write the exit-file protocol (exitfile.ts) alongside resolving the Promise, so a
    // reader of the on-disk artifact (a dispatcher's own collection path today; a cross-beat
    // collector later) derives an IDENTICAL result via the same parseOutput/extractUsage this
    // module exports — one parser, never a copy. Best-effort: exit-file I/O never blocks or
    // changes what run() resolves with.
    const finishWithExit = (result: ProviderResult, exitCode: number | null, rawObj?: ClaudeJsonOutput): ProviderResult => {
      if (req.exitFile) {
        let usagePath: string | undefined;
        if (rawObj) {
          usagePath = usageJsonPath(req.exitFile.runDir, req.exitFile.itemId, req.exitFile.attempt);
          try { writeFileSync(usagePath, JSON.stringify(rawObj), 'utf8'); } catch { /* best-effort */ }
        }
        // Carry the auth-vs-generic-failure distinction into the exit file itself — a detached
        // worker's ProviderResult never reaches a later collecting beat directly, so this is the
        // only signal a cross-beat collector has to tell "logged out mid-build" apart from any
        // other crash (parse/timeout/unknown).
        const authFailure = !result.ok && result.code === 'auth';
        writeExitFile(req.exitFile.runDir, req.exitFile.itemId, req.exitFile.attempt, {
          exitCode,
          ...(usagePath ? { usageJsonPath: usagePath } : {}),
          ...(authFailure ? { authFailure: true } : {}),
        });
      }
      return result;
    };

    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // Run-controls hard-stop: distinct from timedOut so the close handler can report a
      // truthful 'cancelled' code instead of 'timeout' when the cancel poll — not the
      // wall-clock timer — triggered the kill.
      let cancelled = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('claude', args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // A detached child is its own process-group leader (setsid pattern) — it
          // survives the parent beat process dying, and its pid IS the group id a health
          // monitor probes.
          ...(req.detached ? { detached: true } : {}),
        });
      } catch (e) {
        // Earliest possible death: spawn() threw synchronously (bad options / resource limit) —
        // the child never started. This is still a build "death" from the caller's view, so route
        // it through finishWithExit like every other terminal path: a detached build whose spawn
        // throws must leave an exit file (exitCode null = signalled/failed shape), not nothing.
        // Without this, the doctor would find a pgid-bearing build with no exit file and orphan-reap
        // it past the collection grace instead of collecting an honest crash.
        resolve(finishWithExit({
          ok: false,
          error: `Failed to spawn claude: ${e}`,
          code: 'spawn',
        }, null));
        return;
      }

      // Fires synchronously (before run() returns to the caller) so a caller that
      // awaits nothing yet still observes the pgid immediately — e.g. to record it on a
      // build.dispatched event before the child has done any work.
      if (req.detached && req.onSpawn && typeof child.pid === 'number') {
        req.onSpawn(child.pid);
      }

      if (req.system) {
        // claude -p doesn't have a --system flag; prepend to prompt via stdin is not standard.
        // The system prompt is injected by prepending it to the prompt string before spawn.
        // (Callers that need system should prepend it to req.prompt.)
        // This block intentionally left for documentation.
      }

      // ONE kill implementation, reused by both the wall-clock timeout below and the
      // run-controls cancel poll: SIGTERM, then SIGKILL after 10s if the process tree
      // survives (claude's process tree can outlive a plain SIGTERM).
      const escalateKill = () => {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        escalateKill();
      }, timeoutMs);

      // Run-controls cancel poll: while the child is alive, periodically ask the caller
      // (the dispatching beat) whether a build.cancel-requested landed for this attempt.
      // Fail-open — a throwing/rejecting poll is treated as "no cancel", never as a reason
      // to kill.
      let cancelTimer: ReturnType<typeof setInterval> | undefined;
      if (req.cancelCheck) {
        const intervalMs = req.cancelCheckIntervalMs ?? 20_000;
        cancelTimer = setInterval(() => {
          Promise.resolve()
            .then(() => req.cancelCheck!())
            .then(shouldCancel => {
              if (shouldCancel && !timedOut && !cancelled) {
                cancelled = true;
                escalateKill();
              }
            })
            .catch(() => { /* fail-open: poll error never cancels a healthy build */ });
        }, intervalMs);
        cancelTimer.unref();
      }

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', code => {
        clearTimeout(timer);
        if (cancelTimer) clearInterval(cancelTimer);

        if (cancelled) {
          resolve(finishWithExit({
            ok: false,
            error: 'claude build cancelled by operator (hard-stop)',
            code: 'cancelled',
            raw: stderr.slice(-500),
          }, code));
          return;
        }

        if (timedOut) {
          resolve(finishWithExit({
            ok: false,
            error: `claude timed out after ${timeoutMs}ms`,
            code: 'timeout',
            raw: stderr.slice(-500),
          }, code));
          return;
        }

        // Parse JSON output
        const { obj, parseErr } = parseOutput(stdout);

        if (!obj) {
          // 0-byte or malformed — crash/OOM (not auth)
          resolve(finishWithExit({
            ok: false,
            error: `claude output not parseable (exit ${code}): ${parseErr}`,
            code: 'parse',
            raw: (stdout.slice(0, 200) + '\nSTDERR: ' + stderr.slice(-300)).trim(),
          }, code));
          return;
        }

        // Auth failure: session expired (claude exits 0 with is_error:true and auth text).
        // Must be checked before the generic is_error branch below.
        const resultText = obj.result ?? '';
        if (detectAuthFailure(resultText)) {
          resolve(finishWithExit({
            ok: false,
            error: `claude auth failure: ${resultText.slice(0, 200)}`,
            code: 'auth',
            raw: stderr.slice(-300),
          }, code, obj));
          return;
        }

        // Non-auth error: is_error flag or non-zero exit (rate limit, quota, tool error, etc.)
        if (obj.is_error === true || code !== 0) {
          resolve(finishWithExit({
            ok: false,
            error: `claude exited ${code}: ${resultText.slice(0, 300)}`,
            code: 'unknown',
            raw: stderr.slice(-300),
          }, code, obj));
          return;
        }

        // Parse structured JSON if schema was requested
        let json: unknown;
        if (req.schema) {
          try {
            json = JSON.parse(resultText);
          } catch {
            // Not valid JSON — caller gets text only; json stays undefined
          }
        }

        // Extract usage — real token counts from the usage object (never num_turns, which
        // is always 1 regardless of actual token spend). Also capture num_turns and
        // duration_ms as trajectory proxies. extractUsage is the ONE parser shared with a
        // detached-build collector.
        const usage = extractUsage(obj);

        resolve(finishWithExit({
          ok: true,
          text: resultText,
          json,
          usage,
        }, code, obj));
      });

      child.on('error', err => {
        clearTimeout(timer);
        if (cancelTimer) clearInterval(cancelTimer);
        resolve(finishWithExit({
          ok: false,
          error: `claude spawn error: ${err.message}`,
          code: 'spawn',
        }, null));
      });
    });
  }
}

/** Singleton factory */
export function makeClaudeCliProvider(opts: { defaultModel?: string; defaultEffort?: string } = {}): LlmProvider {
  return new ClaudeCliProvider(opts);
}
