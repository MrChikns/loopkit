/**
 * providers/types.ts — LLM provider interface for the loopkit agent plane.
 *
 * Every adapter implements LlmProvider. The result is always returned (never throws on
 * provider failure) — errors come back as ProviderError results.
 */

// ---------------------------------------------------------------------------
// Request / result types
// ---------------------------------------------------------------------------

export interface ProviderRequest {
  prompt: string;
  system?: string;
  model?: string;
  effort?: string;            // reasoning effort level (claude-cli --effort flag)
  tools?: string[];           // --allowedTools list (claude-cli format)
  schema?: object;            // JSON schema for structured output
  cwd?: string;               // working directory for the subprocess
  timeoutMs?: number;         // wall-clock timeout; default 300_000 (5 min)
  /**
   * Run-controls hard-stop seam: an optional poll
   * invoked periodically while the provider's child process is alive. Returning true escalates
   * the SAME SIGTERM→SIGKILL kill the provider already uses for its own timeout — there is
   * exactly ONE kill implementation, this hook only decides WHEN to fire it early. Providers
   * that don't own a long-lived child process (ollama's HTTP call, codex's non-agentic exec)
   * may ignore this field; only claude-cli's `run()` polls it. Never throws; a throwing poll is
   * treated as "no cancel" (fail-open — a poll bug must not spuriously kill a healthy build).
   */
  cancelCheck?: () => boolean | Promise<boolean>;
  /** Poll interval for `cancelCheck`, ms. Default 20_000 (contract: ~15-30s). */
  cancelCheckIntervalMs?: number;
  /**
   * Spawn the provider's child as a DETACHED process group (setsid pattern) instead
   * of an attached child, so the worker survives even if the parent beat process itself dies.
   * Only claude-cli's run() honors this; providers with no owned child process (ollama's
   * HTTP call, codex's non-agentic exec) may ignore it.
   */
  detached?: boolean;
  /**
   * Invoked synchronously, once, the moment the detached child is spawned — before
   * run() resolves — with the process-GROUP id (== the child's own pid under setsid: it is
   * the group leader). Lets the caller record `pgid` on `build.dispatched` immediately,
   * without waiting for completion. Only fires when `detached` is true and the provider
   * supports it.
   */
  onSpawn?: (pgid: number) => void;
  /**
   * When set (together with `detached`), the provider additionally writes the
   * exit-file protocol (exitfile.ts) for this attempt as it completes — the SAME raw
   * output payload the resolved ProviderResult is built from, so a reader (a dispatcher's own
   * collection path today; a cross-beat collector later) can derive an identical result via
   * the shared parseOutput/extractUsage functions (one-parser invariant). Never changes
   * what run() resolves with.
   */
  exitFile?: { runDir: string; itemId: string; attempt: number };
}

export type ProviderResult =
  | ProviderSuccess
  | ProviderError;

export interface ProviderSuccess {
  ok: true;
  text: string;
  json?: unknown;             // populated when schema was requested and response is valid JSON
  usage?: {
    in: number;
    out: number;
    usd?: number;
    /** Number of agentic turns (from claude CLI num_turns — proxy for steps, not exact tool calls). */
    turns?: number;
    /** Wall-clock duration of the provider call in milliseconds (from claude CLI duration_ms). */
    durationMs?: number;
  };
}

export interface ProviderError {
  ok: false;
  error: string;              // human-readable description
  code?: string;              // 'timeout' | 'spawn' | 'parse' | 'auth' | 'unknown' | 'cancelled'
  raw?: string;               // stdout/stderr excerpt for debugging
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LlmProvider {
  /** Stable name used in cost.usage events and config maps */
  name: string;

  /**
   * Whether this provider runs an agentic tool loop that can accept the
   * ProviderRequest.tools list.
   *
   * - claude-cli: true  (--allowedTools is supported)
   * - codex-cli:  false (codex exec runs as a text subprocess, no tool loop)
   * - ollama:     false (HTTP /api/generate, no tool loop)
   *
   * Callers that requireTools (dispatch scout/build, reactor routing) skip
   * providers with supportsTools=false.
   *
   * Optional: defaults to true when absent (backwards-compat with test fakes
   * that pre-date this field and don't declare it).
   */
  supportsTools?: boolean;

  /**
   * Run a prompt. NEVER throws — always returns a ProviderResult.
   * Callers must check result.ok before using result.text.
   */
  run(req: ProviderRequest): Promise<ProviderResult>;
}
