/**
 * providers/ollama.ts — Local Ollama adapter for loopkit's private sensitivity lane.
 *
 * The private sensitivity tier routes ONLY to this provider (registry allowlist), and this
 * provider talks ONLY to a loopback Ollama daemon. Both halves are enforced structurally:
 *
 *   1. Registry: sensitivityAllowlists.private = ['ollama'] (config) — cloud providers are
 *      never even instantiated for a private item.
 *   2. Here: the endpoint host MUST be loopback (127.0.0.1 / ::1 / localhost). A non-loopback
 *      OLLAMA_HOST is REFUSED with a ProviderError — a private item can never be sent off-box
 *      even by misconfiguration. This enforces a "raw data never leaves localhost" posture.
 *
 * Schema pinning: pass the JSON schema via Ollama's `format` field so the envelope is pinned
 * server-side, rather than relying on prompt instructions alone; downstream logic still
 * validates/derives from the parsed result rather than trusting the model's own reasoning.
 *
 * Error policy: NEVER throws — all failures return ProviderError.
 */

import { LlmProvider, ProviderRequest, ProviderResult } from './types.js';

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** True when a base URL points at the local machine (loopback). */
export function isLoopbackHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets if present (URL.hostname keeps them for literals).
  host = host.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.')
  );
}

/** Resolve the Ollama base URL (env override → loopback default). */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['OLLAMA_HOST'] ?? DEFAULT_HOST;
}

interface OllamaGenerateResponse {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  /**
   * ollama does NOT support the ProviderRequest.tools list.
   * It is a plain HTTP /api/generate call (no agentic tool loop).
   * Suitable for tool-less routing in degraded mode (internal chain fallback).
   */
  readonly supportsTools = false;

  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? ollamaBaseUrl()).replace(/\/+$/, '');
    this.defaultModel = opts.model ?? 'qwen3:8b';
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    // Hard guard: refuse any non-loopback endpoint. A private item must never leave the box.
    if (!isLoopbackHost(this.baseUrl)) {
      return {
        ok: false,
        error: `ollama endpoint is not loopback (${this.baseUrl}) — refusing to send data off-box`,
        code: 'auth',
      };
    }

    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      prompt: req.prompt,
      stream: false,
    };
    if (req.system) body['system'] = req.system;
    if (req.schema) body['format'] = req.schema;   // pin the envelope server-side

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        return { ok: false, error: `ollama HTTP ${res.status}`, code: 'unknown', raw: raw.slice(0, 300) };
      }
      const parsed = (await res.json()) as OllamaGenerateResponse;
      const text = parsed.response ?? '';
      let json: unknown;
      if (req.schema) {
        try { json = JSON.parse(text); } catch { /* text-only fallback */ }
      }
      const inTok = parsed.prompt_eval_count ?? 0;
      const outTok = parsed.eval_count ?? 0;
      return {
        ok: true,
        text,
        json,
        // Local inference is free — usd: 0 so the cost panel shows local vs cloud split.
        usage: { in: inTok, out: outTok, usd: 0 },
      };
    } catch (e: unknown) {
      const aborted = (e as { name?: string }).name === 'AbortError';
      return {
        ok: false,
        error: aborted ? `ollama timed out after ${timeoutMs}ms` : `ollama request failed: ${e}`,
        code: aborted ? 'timeout' : 'spawn',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Factory */
export function makeOllamaProvider(opts: { baseUrl?: string; model?: string } = {}): LlmProvider {
  return new OllamaProvider(opts);
}
