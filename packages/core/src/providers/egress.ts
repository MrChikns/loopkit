/**
 * Provider egress guard.
 *
 * This is deliberately a narrow, block-only last line of defence. Before any provider that is
 * not explicitly local runs, it scans only the strings Loopkit is about to send (`prompt` and
 * `system`). It does not inspect the worktree, environment, transcripts, or files an agent may
 * later read with tools; those need their own policy boundary.
 *
 * Findings contain rule ids only. Matched values, excerpts, offsets, and the request itself never
 * leave this module, so callers can safely persist the generic ProviderError.
 */

import { LlmProvider, ProviderError, ProviderRequest, ProviderResult } from './types.js';

export type SecretRuleId =
  | 'private-key'
  | 'openai-token'
  | 'anthropic-token'
  | 'github-token'
  | 'gitlab-token'
  | 'npm-token'
  | 'slack-token'
  | 'stripe-live-secret'
  | 'google-api-key'
  | 'aws-access-key-pair'
  | 'secret-assignment';

interface SecretRule {
  id: SecretRuleId;
  test: (content: string) => boolean;
}

const ASSIGNMENT_RE =
  /(?:^|[\s,{])["']?((?:[A-Za-z][A-Za-z0-9_.-]*[_-])?(?:api[_-]?key|secret(?:[_-]?key)?|private[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|session[_-]?token|password|passwd|token))["']?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,#;}\]]+))/gim;

const PLACEHOLDER_RE =
  /^(?:<.*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|(?:your[-_ ]?)?(?:key|token|secret|password)|(?:your[-_ ]|placeholder|example|sample|dummy|fake|test|redacted|masked|changeme)[A-Za-z0-9_.-]*|none|null|undefined|x+|\*+)$/i;

/**
 * Values that name where a secret comes from are references, not secret material. Blocking these
 * would strand ordinary source-review prompts such as `CLIENT_SECRET=process.env.CLIENT_SECRET`.
 * This intentionally recognizes common JS/TS property, bracket, environment, and call shapes
 * before the literal-shape check below.
 */
const REFERENCE_VALUE_RE =
  /^(?:(?:process|Deno)\??\.env(?:\??\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\]|\??\.get\([^)]*\))|[A-Za-z_$][\w$]*(?:(?:\??\.)[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\])+(?:\([^)]*\))?|[A-Za-z_$][\w$]*\([^)]*\)|(?:vault|secret|env|file|sm):\/\/\S+)$/i;

function containsSecretAssignment(content: string): boolean {
  ASSIGNMENT_RE.lastIndex = 0;
  for (const match of content.matchAll(ASSIGNMENT_RE)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (value.length < 16 || PLACEHOLDER_RE.test(value) || REFERENCE_VALUE_RE.test(value)) continue;
    // Require a compact, non-prose literal: no raw whitespace (a genuine multi-word match is
    // prose, not a token) and at least one letter (so a bare numeric id doesn't trip this).
    // Exclude opening bracket/paren/brace characters: legitimate credential material never
    // contains them, and the unquoted branch of ASSIGNMENT_RE can capture a truncated fragment
    // of a property/index reference (e.g. `settings["privateKey"]` -> `settings["privateKey`)
    // that no longer matches REFERENCE_VALUE_RE once mangled — this exclusion is what keeps
    // that case from false-positiving, not a defence against real secrets.
    // Deliberately do NOT require a digit or a minimum character-class diversity: real
    // credentials are routinely pure-alphabetic or low-diversity. Fail closed — when the shape
    // is ambiguous, flag it. Known provider prefixes are handled by their dedicated rules above
    // this generic assignment fallback.
    if (/\s|[([{]/.test(value) || !/[A-Za-z]/.test(value)) continue;
    return true;
  }
  return false;
}

function containsAwsAccessKeyPair(content: string): boolean {
  const accessKey = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content);
  if (!accessKey) return false;
  return /(?:AWS_SECRET_ACCESS_KEY|SecretAccessKey)["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/i.test(content);
}

const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    test: content => /-----BEGIN (?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(content),
  },
  {
    id: 'openai-token',
    test: content => /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/.test(content),
  },
  {
    id: 'anthropic-token',
    test: content => /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}\b/.test(content),
  },
  {
    id: 'github-token',
    test: content => /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(content),
  },
  {
    id: 'gitlab-token',
    test: content => /\bglpat-[A-Za-z0-9_-]{20,}\b/.test(content),
  },
  {
    id: 'npm-token',
    test: content => /\bnpm_[A-Za-z0-9]{30,}\b/.test(content),
  },
  {
    id: 'slack-token',
    test: content => /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(content),
  },
  {
    id: 'stripe-live-secret',
    test: content => /\bsk_live_[A-Za-z0-9]{16,}\b/.test(content),
  },
  {
    id: 'google-api-key',
    test: content => /\bAIza[0-9A-Za-z_-]{35}\b/.test(content),
  },
  { id: 'aws-access-key-pair', test: containsAwsAccessKeyPair },
  { id: 'secret-assignment', test: containsSecretAssignment },
];

/** Scan content without ever returning the matched secret or its location. */
export function scanSecretRuleIds(content: string): SecretRuleId[] {
  if (!content) return [];
  return SECRET_RULES.filter(rule => rule.test(content)).map(rule => rule.id);
}

/** Scan exactly the outbound text fields, de-duplicating ids across prompt and system content. */
export function scanProviderRequest(req: ProviderRequest): SecretRuleId[] {
  return [...new Set([
    ...scanSecretRuleIds(req.prompt),
    ...scanSecretRuleIds(req.system ?? ''),
  ])];
}

export interface ProviderInvocation extends Promise<ProviderResult> {
  /**
   * Present only when the guard blocked synchronously. Detached callers use this safe metadata
   * to take their ordinary in-process failure path instead of recording a process that never
   * spawned. It contains rule ids only.
   */
  readonly egressBlockedBy?: readonly SecretRuleId[];
}

/**
 * The one provider-run wrapper. Only an explicit local provider bypasses scanning; missing or
 * unknown locality is external (fail closed). The provider is invoked synchronously after a
 * clean scan so existing detached `onSpawn` timing is preserved.
 */
export function invokeProvider(
  provider: LlmProvider,
  req: ProviderRequest,
): ProviderInvocation {
  if (provider.locality !== 'local') {
    const ruleIds = scanProviderRequest(req);
    if (ruleIds.length > 0) {
      const error: ProviderError = {
        ok: false,
        code: 'egress-blocked',
        error: `provider egress blocked by credential rules: ${ruleIds.join(', ')}`,
      };
      const blocked = Promise.resolve(error) as ProviderInvocation;
      Object.defineProperty(blocked, 'egressBlockedBy', {
        value: Object.freeze([...ruleIds]),
        enumerable: true,
      });
      return blocked;
    }
  }
  return provider.run(req) as ProviderInvocation;
}
