/**
 * autonomy.ts — THE plane autonomy gate predicate (one home).
 *
 * `LOOPKIT_AUTONOMY` is the plane's kill switch: with it off, BOTH beats (reactor and
 * dispatch) return their no-op at the very top of the run, before any routing, picking, or
 * spawning happens.
 *
 * PRECISION that every surface wording depends on: the gate is checked ONCE, at the top of
 * `runReactor`/`runDispatch`, and a dispatch build runs INSIDE its own beat. So "halted" means
 * NO NEW WORK IS TAKEN ON — it does not abort a beat already in flight, and it does not kill a
 * build already running. An operator who reads "halted" while a build is still going must not
 * be able to conclude the surface is lying.
 *
 * ORTHOGONAL to attendance (fold.ts `planeMode`): a live operator session and armed beats
 * coexist happily (claims arbitrate — ADR-007), and neither implies the other. Do not fuse
 * them into one mode vocabulary; carry the two facts separately.
 *
 * Two readers need to agree on what "on" means, and a disagreement between them is a lie on an
 * operator-facing surface rather than a harmless inconsistency:
 *   1. the beats themselves (`runReactor` / `runDispatch`) — do we run at all?
 *   2. the console — do we warn the operator that a dropped intent will just sit there?
 *
 * The beat gates keep their own inline chain (they read `process.env` directly at the top of the
 * run, before anything else). `isPlaneArmed` MIRRORS that chain for the surfaces. The mirror is
 * held honest behaviourally, not by shared syntax: `test/autonomy.test.ts` drives the REAL
 * `runReactor`/`runDispatch` across the whole env matrix and asserts each one no-ops exactly
 * when `isPlaneArmed` is false. That catches drift even if someone rewrites a gate inline —
 * which a shared constant would not.
 *
 * FAIL-SAFE: an UNSET `LOOPKIT_AUTONOMY` resolves to OFF, never on. The launchd shims source
 * `.ai/loops/config.env` which sets it explicitly, so production behaviour is unchanged; bare,
 * cron, and first-run invocations that never set it are safe-by-default (and a first-time user
 * who has not armed anything is told the plane is halted, not that beats are working for them).
 *
 * Note the exact shape: only the literal string `'off'` gates the beats off — any other
 * non-undefined value (including `'on'`, and including a typo) runs. This module deliberately
 * preserves that rather than "fixing" it, because the pill's whole job is to report what the
 * gate will actually do.
 *
 * Pure: nothing here reads `process.env` itself. The environment bag is passed in by the layer
 * that already has process access (the beat entry points; the console's `OpsPageContext.env`),
 * mirroring `readOpsAutonomy` on the console side.
 */

/** The one value of `LOOPKIT_AUTONOMY` that gates the beats OFF, and the unset default. */
export const AUTONOMY_OFF = 'off';

/** The env var carrying the plane kill switch. */
export const AUTONOMY_ENV_VAR = 'LOOPKIT_AUTONOMY';

/**
 * Resolve the effective autonomy value: an explicit override (test/caller injection) wins,
 * else the env value, else the fail-safe `'off'`. This is the exact chain both beat gates run.
 */
export function resolveAutonomy(envVal: string | undefined, override?: string): string {
  return override ?? (envVal ?? AUTONOMY_OFF);
}

/**
 * Is the plane ARMED — i.e. would the beats actually do work right now, rather than no-op at
 * the autonomy gate? Reads only the passed env bag; an absent bag (or an unset var) is `false`,
 * the same fail-safe the beats apply.
 */
export function isPlaneArmed(env: NodeJS.ProcessEnv | undefined): boolean {
  return resolveAutonomy(env?.[AUTONOMY_ENV_VAR]) !== AUTONOMY_OFF;
}
