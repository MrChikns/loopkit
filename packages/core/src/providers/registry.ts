/**
 * providers/registry.ts — Provider registry with sensitivity-based routing and
 * health-aware fallback chains.
 *
 * Resolves a provider by sensitivity + health state from the loopkit config.
 *
 * Sensitivity policy:
 *   - 'public'   → providers in chains.public  (default: ['claude-cli'])
 *   - 'internal' → providers in chains.internal (default: ['claude-cli'])
 *   - 'private'  → providers in chains.private  (default: ['ollama'])
 *
 * Default chains:
 *   - internal/public: ['claude-cli']  (codex NOT in default — conserved consulting lane)
 *   - private:         ['ollama']
 *
 * Policy constraint (hard-encoded):
 *   codex-cli is the conserved consulting lane (the operator shares its quota manually
 *   with their own separate use). It MUST NOT appear in any default fallback chain. The
 *   chain config is operator-controlled; the default refuses codex. README documents how
 *   an operator could opt it in and why the default refuses it.
 *
 * Health-aware resolution (resolveWithHealth):
 *   - Walks the configured chain for the sensitivity tier.
 *   - Skips providers whose unhealthy marker is younger than cooldownMs.
 *   - When the marker has expired (cooldown elapsed), enters half-open: the provider
 *     is retried; a successful use clears the marker.
 *   - Skips providers lacking tools when requireTools=true.
 *   - Returns null when the chain is exhausted.
 *
 * Health state on disk:
 *   .ai/runs/loopkit/provider-<name>-unhealthy  — JSON: { ts: epochMs, reason: string }
 *   Written on auth-classified failure; deleted on successful use.
 *
 * The pure health logic (isUnhealthy / markUnhealthy / clearUnhealthy) is separated
 * from I/O via injected fs functions so it is directly testable.
 *
 * codex-cli (second-opinion consulting lane) and ollama (local private lane) are both live
 * built-in providers.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LlmProvider } from './types.js';
import { makeClaudeCliProvider } from './claudeCli.js';
import { makeCodexCliProvider } from './codexCli.js';
import { makeOllamaProvider } from './ollama.js';

export type Sensitivity = 'public' | 'internal' | 'private';

/**
 * TRUST-HARDENING: coerce any raw sensitivity value to a valid tier, FAIL-CLOSED.
 * A recognized tier passes through; anything else (an unknown string, a corrupt fold value,
 * undefined) resolves to the MOST restrictive tier, 'private' — so an item with a garbage
 * sensitivity is treated as local-only, never quietly routed to an external provider. Absent
 * sensitivity is intentionally NOT the same as invalid: the item.captured field is optional and
 * its documented default is 'internal', so callers pass `rec.sensitivity ?? 'internal'` here —
 * this guard only fail-closes genuinely UNRECOGNIZED values.
 */
export function normalizeSensitivity(raw: unknown): Sensitivity {
  return raw === 'public' || raw === 'internal' || raw === 'private' ? raw : 'private';
}

export interface ProviderConfig {
  /** Named providers and their model aliases / reasoning effort */
  providers: Record<string, { model?: string; effort?: string }>;
  /** Sensitivity → list of allowed provider names */
  sensitivityAllowlists: {
    public?: string[];      // default: all
    internal?: string[];    // default: all
    private?: string[];     // default: [] (nothing allowed on private without explicit list)
  };
  /**
   * Fallback chains per sensitivity tier.
   * Each value is an ordered list of provider names; the registry walks it in order,
   * skipping unhealthy or incompatible providers, and returns the first suitable one.
   *
   * Default chains:
   *   internal: ['claude-cli']   — codex NOT included (conserved consulting lane)
   *   public:   ['claude-cli']
   *   private:  ['ollama']
   *
   * To add ollama as a degraded-routing fallback for internal:
   *   { chains: { internal: ['claude-cli', 'ollama'] } }
   *
   * To add codex as a fallback (operator must opt in explicitly):
   *   { chains: { internal: ['claude-cli', 'codex-cli'] } }
   *   WARNING: codex quota is shared; use sparingly.
   */
  chains?: {
    internal?: string[];
    public?: string[];
    private?: string[];
  };
  /**
   * Cooldown in milliseconds after an auth failure before retrying a provider
   * (half-open behaviour). Default: 10 minutes.
   */
  cooldownMs?: number;
}

// ---------------------------------------------------------------------------
// Default chains — respects the conserved-consulting-lane policy (codex excluded)
// ---------------------------------------------------------------------------

const DEFAULT_CHAINS: Required<NonNullable<ProviderConfig['chains']>> = {
  internal: ['claude-cli'],
  public:   ['claude-cli'],
  private:  ['ollama'],
};

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Built-in factory map
// ---------------------------------------------------------------------------

type ProviderFactory = (config?: { model?: string; effort?: string }) => LlmProvider;

const BUILT_IN_FACTORIES: Record<string, ProviderFactory | null> = {
  'claude-cli': (config?: { model?: string; effort?: string }) => makeClaudeCliProvider({ defaultModel: config?.model, defaultEffort: config?.effort }),
  'codex-cli': (config?: { model?: string; effort?: string }) => makeCodexCliProvider({ effort: config?.model }),
  'ollama': (config?: { model?: string; effort?: string }) => makeOllamaProvider({ model: config?.model }),
};

// ---------------------------------------------------------------------------
// Health state — pure I/O via injected functions (testable)
// ---------------------------------------------------------------------------

export interface UnhealthyMarker {
  ts: number;     // epoch ms when the marker was written
  reason: string;
}

export type ReadMarkerFn  = (providerName: string) => UnhealthyMarker | null;
export type WriteMarkerFn = (providerName: string, marker: UnhealthyMarker) => void;
export type ClearMarkerFn = (providerName: string) => void;

/**
 * Real file-based health marker implementations. Markers live at
 * .ai/runs/loopkit/provider-<name>-unhealthy (JSON).
 */
export function makeFileHealthFns(runDir: string): {
  readMarker: ReadMarkerFn;
  writeMarker: WriteMarkerFn;
  clearMarker: ClearMarkerFn;
} {
  function markerPath(name: string): string {
    return join(runDir, `provider-${name}-unhealthy`);
  }

  function readMarker(name: string): UnhealthyMarker | null {
    try {
      const text = readFileSync(markerPath(name), 'utf8');
      const obj = JSON.parse(text) as Record<string, unknown>;
      const ts = typeof obj['ts'] === 'number' ? obj['ts'] : 0;
      const reason = typeof obj['reason'] === 'string' ? obj['reason'] : 'unknown';
      return { ts, reason };
    } catch {
      return null;
    }
  }

  function writeMarker(name: string, marker: UnhealthyMarker): void {
    try {
      writeFileSync(markerPath(name), JSON.stringify(marker), 'utf8');
    } catch { /* best-effort */ }
  }

  function clearMarker(name: string): void {
    try {
      rmSync(markerPath(name), { force: true });
    } catch { /* best-effort */ }
  }

  return { readMarker, writeMarker, clearMarker };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ResolveWithHealthOpts {
  /** When true, skip providers with supportsTools=false. */
  requireTools?: boolean;
}

export class ProviderRegistry {
  private readonly config: ProviderConfig;
  private readonly cache = new Map<string, LlmProvider>();
  private readonly cooldownMs: number;
  readonly readMarker: ReadMarkerFn;
  readonly writeMarker: WriteMarkerFn;
  readonly clearMarker: ClearMarkerFn;

  constructor(
    config: ProviderConfig,
    opts: {
      readMarker?: ReadMarkerFn;
      writeMarker?: WriteMarkerFn;
      clearMarker?: ClearMarkerFn;
    } = {},
  ) {
    this.config = config;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    // No-op stubs as defaults (used in tests that don't inject health fns)
    this.readMarker  = opts.readMarker  ?? (() => null);
    this.writeMarker = opts.writeMarker ?? (() => { /* no-op */ });
    this.clearMarker = opts.clearMarker ?? (() => { /* no-op */ });
  }

  /**
   * Legacy resolve: resolve a provider by name + sensitivity.
   * Does NOT consult health state. Kept for backwards-compat callers that do not
   * need fallback; health-aware callers should use resolveWithHealth.
   *
   * @param preferredName  - provider name to use (from item config or default)
   * @param sensitivity    - item sensitivity tag
   * @returns LlmProvider if one is available and allowed, null otherwise.
   */
  resolve(preferredName: string, sensitivity: Sensitivity = 'internal'): LlmProvider | null {
    const allowed = this.allowedProviders(sensitivity);
    if (!allowed.includes(preferredName)) {
      // The preferred provider is not allowed for this sensitivity level.
      // Try the first allowed provider as a fallback.
      const fallback = allowed.find(n => this.canInstantiate(n));
      if (!fallback) return null;
      return this.instantiate(fallback);
    }
    return this.instantiate(preferredName);
  }

  /**
   * Health-aware chain resolution.
   *
   * Walks the configured chain for the sensitivity tier in order:
   *   1. Skip providers not in the allowed list for the sensitivity.
   *   2. Skip providers whose unhealthy marker is younger than cooldownMs (unhealthy).
   *      Providers whose marker has expired enter half-open: they are retried.
   *   3. Skip providers lacking tools when requireTools=true.
   *   4. Return the first suitable provider.
   *
   * Returns null when the chain is exhausted (all unhealthy or incompatible).
   *
   * Callers that get a non-null result should call clearUnhealthyMarker on successful
   * use (so a recovered provider clears its marker). On auth failure, call
   * markUnhealthy to record the failure.
   */
  resolveWithHealth(
    sensitivity: Sensitivity,
    opts: ResolveWithHealthOpts = {},
  ): LlmProvider | null {
    const chain = this.chainFor(sensitivity);
    const allowed = this.allowedProviders(sensitivity);
    const now = Date.now();

    for (const name of chain) {
      // Must be in the sensitivity allowlist
      if (!allowed.includes(name)) continue;
      // Must be instantiable
      if (!this.canInstantiate(name)) continue;

      // Health check: is the marker present and still within cooldown?
      const marker = this.readMarker(name);
      if (marker !== null) {
        const ageMs = now - marker.ts;
        if (ageMs < this.cooldownMs) {
          // Still cooling down — skip this provider
          continue;
        }
        // Cooldown elapsed → half-open: fall through to try it
      }

      // Tools check — absent supportsTools defaults to true (backwards-compat with test fakes)
      const provider = this.instantiate(name);
      if (!provider) continue;
      if (opts.requireTools && provider.supportsTools === false) continue;

      return provider;
    }

    return null;
  }

  /**
   * Mark a provider unhealthy (called on auth-classified failure).
   * The marker persists for cooldownMs before the provider is retried (half-open).
   */
  markUnhealthy(name: string, reason: string): void {
    this.writeMarker(name, { ts: Date.now(), reason });
  }

  /**
   * Clear the unhealthy marker for a provider (called on successful use).
   * Idempotent: no-op if the marker is absent.
   */
  clearUnhealthy(name: string): void {
    this.clearMarker(name);
  }

  /**
   * Check whether a provider is currently unhealthy (marker present + within cooldown).
   * Half-open (marker expired): returns false — the provider should be retried.
   */
  isUnhealthy(name: string, nowMs?: number): boolean {
    const marker = this.readMarker(name);
    if (marker === null) return false;
    const now = nowMs ?? Date.now();
    return (now - marker.ts) < this.cooldownMs;
  }

  /**
   * Returns the ordered fallback chain for the given sensitivity tier.
   * Falls back to the sensitivity allowlist (legacy behavior) when no explicit chain
   * is configured.
   */
  chainFor(sensitivity: Sensitivity): string[] {
    const cfg = this.config.chains ?? {};
    switch (sensitivity) {
      case 'internal': return cfg.internal ?? DEFAULT_CHAINS.internal;
      case 'public':   return cfg.public   ?? DEFAULT_CHAINS.public;
      case 'private':  return cfg.private  ?? DEFAULT_CHAINS.private;
    }
  }

  /**
   * Returns the list of provider names allowed for the given sensitivity.
   * Private items get an empty list by default (must be explicitly configured).
   */
  allowedProviders(sensitivity: Sensitivity): string[] {
    const allNames = Object.keys(BUILT_IN_FACTORIES);
    switch (sensitivity) {
      case 'public':
        return this.config.sensitivityAllowlists.public ?? allNames;
      case 'internal':
        return this.config.sensitivityAllowlists.internal ?? allNames;
      case 'private':
        // Private: ONLY providers in the explicit allowlist; default is empty.
        return this.config.sensitivityAllowlists.private ?? [];
    }
  }

  private canInstantiate(name: string): boolean {
    const factory = BUILT_IN_FACTORIES[name];
    return factory != null;
  }

  private instantiate(name: string): LlmProvider | null {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const factory = BUILT_IN_FACTORIES[name];
    if (!factory) return null;   // unregistered provider name

    const providerConf = this.config.providers[name] ?? {};
    const provider = factory({ model: providerConf.model, effort: providerConf.effort });
    this.cache.set(name, provider);
    return provider;
  }
}

/** Build a registry from loopkit config sections. */
export function makeRegistry(
  config: ProviderConfig,
  opts: {
    readMarker?: ReadMarkerFn;
    writeMarker?: WriteMarkerFn;
    clearMarker?: ClearMarkerFn;
  } = {},
): ProviderRegistry {
  return new ProviderRegistry(config, opts);
}
