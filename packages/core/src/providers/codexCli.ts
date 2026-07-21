/**
 * providers/codexCli.ts — Codex CLI adapter for loopkit's second-opinion review lane.
 *
 * Spawns `codex exec -p <profile> [-c model_reasoning_effort=<effort>] [-C <cwd>] <prompt>`.
 * Codex is the independent reviewer: it is DELIBERATELY given only the diff + the task
 * contract, never the builder's prompt scaffolding or the planning context — so it judges
 * the change, not the instructions that produced it.
 *
 * Error policy: NEVER throws — all failures return ProviderError.
 *
 * Usage tracking: `codex exec` does not emit a machine-readable cost/token line in its default
 * text mode, so `usage` is left undefined here (no cost.usage event is emitted for codex calls
 * until a JSON-output mode is wired). This is intentional and noted, not an oversight.
 */

import { spawn } from 'node:child_process';
import { LlmProvider, ProviderRequest, ProviderResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Review input assembly
// ---------------------------------------------------------------------------
//
// A naive review prompt risks the builder-prompt constraint footer ("- State your assumptions
// explicitly…" / "No features beyond what was asked." / "No abstractions for single-use
// code…") being echoed back as if it were an independent Codex *finding*, and risks bleeding
// in unrelated planning context (queue/backlog/roadmap text). Either failure mode treats the
// instructions-to-the-builder as the thing under review, instead of the diff itself.
//
// The fix is structural: assemble the review prompt from ONLY (diff + task contract), stripping
// the constraint footer from the contract. Planning docs are excluded by construction — this
// function never accepts them as an input.

export interface ReviewInput {
  /** The unified diff under review. */
  diff: string;
  /** The task contract / spec the diff claims to implement. Context, not the review target. */
  taskContract: string;
  /** Optional coding-guidelines reference (a path or short text). */
  guidelines?: string;
}

/**
 * The builder-prompt constraint footer always begins with a "State your assumptions" line.
 * Everything from that line to the end of the block is builder scaffolding, not review
 * target, so it is stripped before the contract reaches the reviewer.
 */
const CONSTRAINT_FOOTER_RE = /^\s*[-*]?\s*State your assumptions\b/im;

/** Standalone constraint lines that may appear without the footer header. */
const CONSTRAINT_LINE_RE =
  /^\s*[-*]?\s*(No features beyond what was asked|No abstractions for single-use code|If uncertain,? ask)\b.*$/gim;

/** Strip the builder constraint footer + any stray constraint lines from a contract body. */
export function stripConstraintFooter(contract: string): string {
  let out = contract;
  const footer = out.search(CONSTRAINT_FOOTER_RE);
  if (footer !== -1) {
    // Drop the footer header line and everything after it.
    out = out.slice(0, footer);
  }
  // Belt-and-braces: remove any surviving standalone constraint lines above the footer.
  out = out.replace(CONSTRAINT_LINE_RE, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Assemble the review prompt Codex receives. Built from diff + (footer-stripped) contract only;
 * planning context cannot enter because it is not a parameter. Frames the diff as the review
 * target and the contract as reference, so the contract body is not mistaken for findings.
 */
export function assembleReviewInput(input: ReviewInput): string {
  const contract = stripConstraintFooter(input.taskContract);
  const parts: string[] = [
    'You are an independent code reviewer. Review ONLY the diff below for correctness bugs,',
    'scope creep, and violations of the referenced guidelines. The task contract is provided',
    'as REFERENCE for what the diff should do — it is not itself the thing under review, and its',
    'text must never be echoed back as a finding. End with a line `VERDICT: clean` or',
    '`VERDICT: findings`.',
    '',
    '=== TASK CONTRACT (reference only) ===',
    contract || '(none provided)',
  ];
  if (input.guidelines) {
    parts.push('', '=== GUIDELINES ===', input.guidelines);
  }
  parts.push('', '=== DIFF UNDER REVIEW ===', input.diff.trim() || '(empty diff)');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CodexCliProvider implements LlmProvider {
  readonly name = 'codex-cli';
  /**
   * codex-cli does NOT support the ProviderRequest.tools list.
   * `codex exec` runs as a text-mode subprocess (no agentic tool loop).
   * Codex is a conserved consulting lane only — never in default fallback chains.
   */
  readonly supportsTools = false;

  private readonly profile: string;
  private readonly effort?: string;

  constructor(opts: { profile?: string; effort?: string } = {}) {
    this.profile = opts.profile ?? 'review';
    this.effort = opts.effort;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const args: string[] = ['exec', '-p', this.profile];
    if (this.effort) args.push('-c', `model_reasoning_effort=${this.effort}`);
    if (req.cwd) args.push('-C', req.cwd);
    args.push(req.prompt);

    const env = {
      ...process.env,
      PATH: `${process.env['PATH'] ?? '/usr/bin:/bin'}:/opt/homebrew/bin`,
    };

    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('codex', args, {
          cwd: req.cwd ?? process.cwd(),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],   // stdin ignored — a live stdin hangs codex exec
        });
      } catch (e) {
        resolve({ ok: false, error: `Failed to spawn codex: ${e}`, code: 'spawn' });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
      }, timeoutMs);

      child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
      child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, error: `codex timed out after ${timeoutMs}ms`, code: 'timeout', raw: stderr.slice(-500) });
          return;
        }
        const text = stdout.trim();
        if (code !== 0 && !text) {
          resolve({ ok: false, error: `codex exited ${code}`, code: 'unknown', raw: stderr.slice(-500) });
          return;
        }
        if (/usage limit|rate.?limit|quota exceeded/i.test(stdout + stderr)) {
          resolve({ ok: false, error: 'codex depleted (usage/rate limit)', code: 'auth', raw: stderr.slice(-300) });
          return;
        }
        resolve({ ok: true, text });
      });

      child.on('error', err => {
        clearTimeout(timer);
        resolve({ ok: false, error: `codex spawn error: ${err.message}`, code: 'spawn' });
      });
    });
  }
}

/** Factory */
export function makeCodexCliProvider(opts: { profile?: string; effort?: string } = {}): LlmProvider {
  return new CodexCliProvider(opts);
}
