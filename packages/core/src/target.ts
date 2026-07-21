/**
 * target.ts — the target manifest (`loopkit.target.json`) and its registration record.
 *
 * A "target" is any git repo the plane drives that is NOT the plane's own home
 * (docs/event-model.md §"The two repos"). The plane-home holds the one ledger + runtime
 * state; a target holds only a versioned, non-secret manifest at its root. This module owns
 * reading + validating that manifest and computing its stable content hash — nothing here
 * ever *executes* a manifest (that is the operator's explicit `loopctl target add` consent
 * step, per docs/event-model.md §"The target manifest").
 *
 * The manifest deliberately mirrors the subset of LoopkitConfig the beats consume for a
 * build (gateCommand/gateWorkdir, defaultBranch, worktreePrefix, touches.conflictMode,
 * the boundaries block, acceptance tiers, buildTimeoutMinutes). It is a SEPARATE type, not
 * a re-export of LoopkitConfig, because a manifest is per-target trusted-local-code that a
 * target repo versions independently — but `manifestToConfig` bridges the two so the
 * existing beat machinery runs unchanged against a target's settings.
 */

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Target identity (docs/event-model.md §"Register a target": identity ≠ name)
// ---------------------------------------------------------------------------

/** Lowercase RFC-4648 base32 alphabet used for target-id encoding. */
const TARGET_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Shape every target id conforms to: `tgt-` + 8 lowercase base32 chars. */
export const TARGET_ID_RE = /^tgt-[a-z2-7]{8}$/;

/** Encode the first 5 bytes (40 bits) as exactly 8 lowercase base32 chars. */
function encodeTargetIdBytes(bytes: Uint8Array): string {
  let n = 0n;
  for (let i = 0; i < 5; i++) n = (n << 8n) | BigInt(bytes[i] ?? 0);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = TARGET_ID_ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

/**
 * Mint a fresh opaque target id (`tgt-<8 lowercase base32 chars>`), minted ONCE at first
 * registration. Cryptographically random (node:crypto randomBytes — never Math.random), so
 * two planes registering different repos can never mint colliding ids by clock coincidence.
 * Identity ≠ name: the id never changes across renames; re-registering a previously seen
 * repoPath must REVIVE the original id (the fold pins identity on repoPath), never mint anew.
 */
export function mintTargetId(): string {
  return 'tgt-' + encodeTargetIdBytes(randomBytes(5));
}

/**
 * Deterministic fallback id for a registration event that predates `targetId` (legacy
 * ledgers). Hash-derived from the repoPath — the same stable key the fold uses for identity
 * revival — so every replay of an old ledger folds the same target to the same id, with no
 * ledger rewrite. Same shape as a minted id, distinguishable only by determinism.
 */
export function fallbackTargetId(repoPath: string): string {
  const digest = createHash('sha256').update(`target-repo:${repoPath}`).digest();
  return 'tgt-' + encodeTargetIdBytes(digest);
}

// ---------------------------------------------------------------------------
// Manifest shape (docs/event-model.md §"The target manifest")
// ---------------------------------------------------------------------------

/**
 * The generalized plane/target boundary. All fields except
 * `name` have sane defaults so a minimal manifest — `{ "name": "notes" }` — is valid and
 * behaves like the framework's own defaults (gate `npm test` on the repo root, merge to
 * `main`). Mirrors LoopkitConfig field names so `manifestToConfig` is a straight copy.
 */
export interface TargetManifest {
  /** Human handle; the targetId derives from the registration event, not from this name. */
  name: string;
  /** Branch the plane merges finished builds into. Default: 'main'. */
  defaultBranch: string;
  /** Deterministic proof command, run (via `sh -c`) in the worktree. Default: 'npm test'. */
  gateCommand: string;
  /** Working dir for the gate command, relative to the target repo root. Default: '.'. */
  gateWorkdir: string;
  /** Optional post-merge deploy command. Empty string = no deploy step (the default). */
  deployCommand: string;
  /** Prefix for the sibling worktree dirs the beats create next to the target repo. Default: 'loop-'. */
  worktreePrefix: string;
  /** Workdirs (repo-relative; '.' = repo root) whose installed node_modules the beats
   *  provision into each build worktree. A target knows its own dependency roots — the
   *  plane config's depsWorkdirs only describes the plane's own embedded repo. Default: []. */
  depsWorkdirs: string[];
  /** Touches conflict rules (per-target lane disjointness). */
  touches: {
    /** 'prefix' means two Touches patterns conflict when one is a string prefix of the other. */
    conflictMode: 'prefix';
  };
  /**
   * The three boundary axes, per target:
   *   - planePrefixes     — merge-trust axis: paths that auto-merge without operator approval
   *   - surfacePrefixes   — test-visibility axis: paths that surface on the acceptance desk
   *   - escalationPatterns — risk axis: paths that ALWAYS park for the operator
   * Empty arrays (the defaults) declare no special boundaries — everything auto-merges on green
   * and nothing is force-surfaced, which is the safe minimal shape for a fresh demo target.
   */
  boundaries: {
    planePrefixes: string[];
    surfacePrefixes: string[];
    escalationPatterns: string[];
  };
  /**
   * Optional per-target acceptance-tier window overrides. Same schema as the plane config's
   * acceptance.tiers block; absent = the plane defaults apply. Kept open so a target tunes
   * only the keys it cares about.
   */
  acceptance?: {
    tiers?: {
      autoAfterHours?: number;
      optionalAfterHours?: number;
      reviewAfterHours?: number;
      confidenceFloor?: number;
    };
  };
  /** Optional per-target prompt overrides dir (relative to the target repo). Empty = plane prompts. */
  promptsDir: string;
  /** Max minutes a single build agent may run against this target before timing out. Default: 45. */
  buildTimeoutMinutes: number;
}

/** Filename of the manifest at a target repo's root. */
export const TARGET_MANIFEST_FILENAME = 'loopkit.target.json';

/**
 * Manifest defaults. Any field absent from the on-disk manifest falls back to these, so a
 * minimal `{ "name": "..." }` manifest is fully valid (docs/event-model.md — every field
 * except `name` has a documented default).
 */
const MANIFEST_DEFAULTS: Omit<TargetManifest, 'name'> = {
  defaultBranch: 'main',
  gateCommand: 'npm test',
  gateWorkdir: '.',
  deployCommand: '',
  worktreePrefix: 'loop-',
  depsWorkdirs: [],
  touches: { conflictMode: 'prefix' },
  boundaries: {
    planePrefixes: [],
    surfacePrefixes: [],
    escalationPatterns: [],
  },
  promptsDir: '',
  buildTimeoutMinutes: 45,
};

// ---------------------------------------------------------------------------
// Read + validate
// ---------------------------------------------------------------------------

function requireStringArray(v: unknown, path: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: ${path} must be an array of strings`);
  }
  return v as string[];
}

/**
 * Parse + validate a raw manifest object into a fully-defaulted TargetManifest.
 * Clear, path-prefixed errors on any malformed field (mirrors config.ts's merge* validators):
 * an operator registering a target sees exactly which field is wrong before anything is appended.
 */
export function parseTargetManifest(raw: unknown): TargetManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;

  const name = r['name'];
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: name must be a non-empty string`);
  }

  const strOr = (key: string, def: string): string => {
    const v = r[key];
    if (v === undefined) return def;
    if (typeof v !== 'string') throw new Error(`${TARGET_MANIFEST_FILENAME}: ${key} must be a string`);
    return v;
  };

  const touchesRaw = r['touches'] as Record<string, unknown> | undefined;
  if (touchesRaw !== undefined && (typeof touchesRaw !== 'object' || Array.isArray(touchesRaw))) {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: touches must be an object`);
  }
  const conflictMode = touchesRaw?.['conflictMode'] ?? MANIFEST_DEFAULTS.touches.conflictMode;
  if (conflictMode !== 'prefix') {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: touches.conflictMode must be 'prefix'`);
  }

  const boundariesRaw = r['boundaries'] as Record<string, unknown> | undefined;
  if (boundariesRaw !== undefined && (typeof boundariesRaw !== 'object' || Array.isArray(boundariesRaw))) {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: boundaries must be an object`);
  }

  const buildTimeout = r['buildTimeoutMinutes'];
  if (buildTimeout !== undefined && (typeof buildTimeout !== 'number' || buildTimeout <= 0)) {
    throw new Error(`${TARGET_MANIFEST_FILENAME}: buildTimeoutMinutes must be a positive number`);
  }

  // acceptance.tiers is validated shallowly — number-or-absent per key — so a fork can tune
  // only the windows it cares about; unknown keys are dropped (forward-compatible like config).
  let acceptance: TargetManifest['acceptance'];
  const accRaw = r['acceptance'] as Record<string, unknown> | undefined;
  if (accRaw !== undefined) {
    if (typeof accRaw !== 'object' || Array.isArray(accRaw)) {
      throw new Error(`${TARGET_MANIFEST_FILENAME}: acceptance must be an object`);
    }
    const tiersRaw = accRaw['tiers'] as Record<string, unknown> | undefined;
    if (tiersRaw !== undefined) {
      if (typeof tiersRaw !== 'object' || Array.isArray(tiersRaw)) {
        throw new Error(`${TARGET_MANIFEST_FILENAME}: acceptance.tiers must be an object`);
      }
      const numOr = (key: string): number | undefined => {
        const v = tiersRaw[key];
        if (v === undefined) return undefined;
        if (typeof v !== 'number') throw new Error(`${TARGET_MANIFEST_FILENAME}: acceptance.tiers.${key} must be a number`);
        return v;
      };
      acceptance = {
        tiers: {
          autoAfterHours: numOr('autoAfterHours'),
          optionalAfterHours: numOr('optionalAfterHours'),
          reviewAfterHours: numOr('reviewAfterHours'),
          confidenceFloor: numOr('confidenceFloor'),
        },
      };
    }
  }

  return {
    name,
    defaultBranch: strOr('defaultBranch', MANIFEST_DEFAULTS.defaultBranch),
    gateCommand: strOr('gateCommand', MANIFEST_DEFAULTS.gateCommand),
    gateWorkdir: strOr('gateWorkdir', MANIFEST_DEFAULTS.gateWorkdir),
    deployCommand: strOr('deployCommand', MANIFEST_DEFAULTS.deployCommand),
    worktreePrefix: strOr('worktreePrefix', MANIFEST_DEFAULTS.worktreePrefix),
    depsWorkdirs: requireStringArray((raw as Record<string, unknown>)['depsWorkdirs'], 'depsWorkdirs'),
    touches: { conflictMode: 'prefix' },
    boundaries: {
      planePrefixes: requireStringArray(boundariesRaw?.['planePrefixes'], 'boundaries.planePrefixes'),
      surfacePrefixes: requireStringArray(boundariesRaw?.['surfacePrefixes'], 'boundaries.surfacePrefixes'),
      escalationPatterns: requireStringArray(boundariesRaw?.['escalationPatterns'], 'boundaries.escalationPatterns'),
    },
    acceptance,
    promptsDir: strOr('promptsDir', MANIFEST_DEFAULTS.promptsDir),
    buildTimeoutMinutes: (buildTimeout as number | undefined) ?? MANIFEST_DEFAULTS.buildTimeoutMinutes,
  };
}

/**
 * Read + validate `<repoPath>/loopkit.target.json`. Throws a clear error when the file is
 * missing (so `target add` tells the operator exactly which path lacked a manifest) or when
 * the JSON is malformed.
 */
export function readTargetManifest(repoPath: string): TargetManifest {
  const manifestPath = join(repoPath, TARGET_MANIFEST_FILENAME);
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No ${TARGET_MANIFEST_FILENAME} found at ${manifestPath} — a target repo must carry a manifest at its root`);
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: unknown) {
    throw new Error(`${TARGET_MANIFEST_FILENAME} parse error at ${manifestPath}: ${e}`);
  }
  return parseTargetManifest(raw);
}

// ---------------------------------------------------------------------------
// Registration resolution — THE one target-resolution rule
// ---------------------------------------------------------------------------

/**
 * The subset of a registered-target record the resolution rule needs. Structural (not a
 * fold import) so this module stays dependency-free of the fold that imports it.
 */
export interface RegisteredTargetRef {
  targetId: string;
  name: string;
  repoPath: string;
  manifestHash: string;
}

/** Structural view of the fold's targets projection (byId/byName secondary lookups). */
export interface TargetLookup {
  byId(targetId: string): RegisteredTargetRef | undefined;
  byName(name: string): RegisteredTargetRef | undefined;
}

/**
 * THE one registration-lookup rule (docs/event-model.md: identity ≠ name). The item's
 * stable targetId wins; the mutable display name is only the legacy fallback. Every beat
 * site that maps an item to a registered target — dispatch's build lane, the reactor's
 * approved-merge path, the routing wall's tree grounding — must resolve through here;
 * a second copy is how two lanes come to disagree about which repo an item belongs to.
 */
export function lookupRegisteredTarget(
  targets: TargetLookup,
  ref: { target?: string; targetId?: string },
): RegisteredTargetRef | undefined {
  return (ref.targetId ? targets.byId(ref.targetId) : undefined)
    ?? (ref.target ? targets.byName(ref.target) : undefined);
}

/** Discriminated result of resolveRegisteredTarget. */
export type TargetResolution =
  | {
      ok: true;
      reg: RegisteredTargetRef;
      manifest: TargetManifest;
      /** Content hash of the manifest as read from disk NOW. */
      manifestHash: string;
      /** True when the on-disk manifest differs from the registered hash — the caller
       *  appends target.manifest-updated (append-only; this function never writes). */
      manifestChanged: boolean;
    }
  | { ok: false; kind: 'unregistered' | 'manifest-unreadable'; error: string };

/**
 * Resolve a targeted item to its registered repo + freshly-read manifest (re-read at use
 * time per docs/event-model.md §"Build execution"). Pure read — the caller owns any
 * ledger append for a changed manifest. Shared by dispatch's build lane and the reactor's
 * approved-merge path so both resolve through the SAME rule.
 */
export function resolveRegisteredTarget(
  targets: TargetLookup,
  ref: { target?: string; targetId?: string },
): TargetResolution {
  const name = ref.target ?? '';
  const reg = lookupRegisteredTarget(targets, ref);
  if (!reg) return { ok: false, kind: 'unregistered', error: `targets unregistered '${name}'` };
  let manifest: TargetManifest;
  try {
    manifest = readTargetManifest(reg.repoPath);
  } catch (e) {
    return {
      ok: false,
      kind: 'manifest-unreadable',
      error: `manifest unreadable for target '${name}': ${e instanceof Error ? e.message : e}`,
    };
  }
  const hash = manifestHash(manifest);
  return { ok: true, reg, manifest, manifestHash: hash, manifestChanged: hash !== reg.manifestHash };
}

// ---------------------------------------------------------------------------
// Stable content hash
// ---------------------------------------------------------------------------

/**
 * Deterministic content hash of a manifest. Computed over the FULLY-DEFAULTED, key-sorted
 * JSON so two manifests that differ only in key order (or in an omitted-vs-explicit default)
 * hash identically — the hash tracks EFFECTIVE settings, which is what the beat's re-read
 * ("changed manifest → append target.manifest-updated") must key on (docs/event-model.md
 * §"Register a target").
 */
export function manifestHash(manifest: TargetManifest): string {
  const canonical = JSON.stringify(sortKeysDeep(manifest as unknown));
  return createHash('sha256').update(canonical).digest('hex');
}

/** Recursively sort object keys so JSON.stringify is order-independent (arrays keep order). */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeysDeep(val);
    }
    return out;
  }
  return v;
}
