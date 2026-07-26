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
 * Both readers now resolve through `resolveAutonomyDecision` HERE. They used to be two
 * implementations — the beats gated inline on `=== 'off'` while this module mirrored that chain
 * for the surfaces — and WI-207 collapsed them, because two copies of a kill switch is exactly
 * how a surface and a gate come to disagree. The behavioural equivalence test in
 * `test/autonomy.test.ts` (which drives the REAL `runReactor`/`runDispatch` over the whole env
 * matrix) is kept anyway: shared code makes agreement likely, the test makes it provable, and it
 * still catches a future inline rewrite that walks away from this module.
 *
 * FAIL-SAFE — A STRICT ALLOWLIST (WI-207). Exactly two values are recognised, after trimming and
 * lower-casing: `on` arms, `off` halts. EVERYTHING ELSE HALTS — an unset var, an empty string, and
 * any unrecognised value (`yes`, `true`, `1`, `banana`) — and an unrecognised value also writes a
 * loud stderr line naming it.
 *
 * The bug this closes: the gate compared against the lowercase literal `'off'`, so `off` halted,
 * UNSET halted (the intended fail-safe) and everything else ARMED — including `OFF`, `Off` and
 * `''`. An operator who wrote `LOOPKIT_AUTONOMY=OFF` believed the plane was stopped while the
 * beats kept picking up work, building code and merging it. The fail-safe reasoning had been
 * applied to the ABSENT case and not the UNRECOGNISED one, so the design intent visibly read
 * "default off" while the implementation defaulted off only for `undefined`.
 *
 * The asymmetry is deliberate and is the whole point. Halting a plane someone meant to arm with
 * `yes` costs one edit and says exactly what to fix; arming a plane someone meant to stop costs
 * whatever the beats do in the meantime, silently. Only one of those is recoverable, so the
 * unrecognised case resolves to the recoverable one. Case-insensitivity means `ON` and `OFF` both
 * do the obvious thing rather than the surprising one.
 *
 * The launchd shims source `.ai/loops/config.env`, which sets `on`/`off` explicitly, so production
 * behaviour is unchanged; bare, cron, and first-run invocations that never set it are
 * safe-by-default (and a first-time user who has not armed anything is told the plane is halted,
 * not that beats are working for them).
 *
 * Pure: nothing here reads `process.env` itself. The environment bag is passed in by the layer
 * that already has process access (the beat entry points; the console's `OpsPageContext.env`),
 * mirroring `readOpsAutonomy` on the console side.
 */

/** The only value that ARMS the plane (after trim + lowercase). */
export const AUTONOMY_ON = 'on';

/** The value that HALTS the plane, and what every unrecognised input resolves to. */
export const AUTONOMY_OFF = 'off';

/** The env var carrying the plane kill switch. */
export const AUTONOMY_ENV_VAR = 'LOOPKIT_AUTONOMY';

/** The resolved gate state. Only these two exist — there is no third, "unknown" behaviour. */
export type Autonomy = typeof AUTONOMY_ON | typeof AUTONOMY_OFF;

/**
 * WHY the resolver landed where it did. Carried separately from the value so this module can stay
 * pure: the beats own the stderr write, this owns the decision and the wording.
 *  - `recognised`   — the input was `on`/`off` (any case, any surrounding whitespace).
 *  - `unset`        — no override and no env var. Halts, with the long-standing fail-safe notice.
 *  - `unrecognised` — a value that is neither. Halts, and must be reported loudly with the value:
 *                     silence here is what let `LOOPKIT_AUTONOMY=OFF` arm the plane.
 */
export type AutonomyReason = 'recognised' | 'unset' | 'unrecognised';

export interface AutonomyDecision {
  autonomy: Autonomy;
  reason: AutonomyReason;
  /** The rejected input, verbatim (pre-normalisation), for the warning. Only when `unrecognised`. */
  raw?: string;
}

/**
 * THE kill-switch resolver — one home, used by the beat gates and by every surface.
 *
 * An explicit override (test/caller injection) wins, else the env value, else the fail-safe.
 * Normalises by trimming and lower-casing, then accepts EXACTLY `on` and `off`; anything else,
 * including the empty string, resolves to OFF. See the header for why the unrecognised case
 * fails closed rather than open.
 */
export function resolveAutonomyDecision(envVal: string | undefined, override?: string): AutonomyDecision {
  const raw = override ?? envVal;
  if (raw === undefined) return { autonomy: AUTONOMY_OFF, reason: 'unset' };
  const normalized = raw.trim().toLowerCase();
  if (normalized === AUTONOMY_ON) return { autonomy: AUTONOMY_ON, reason: 'recognised' };
  if (normalized === AUTONOMY_OFF) return { autonomy: AUTONOMY_OFF, reason: 'recognised' };
  return { autonomy: AUTONOMY_OFF, reason: 'unrecognised', raw };
}

/**
 * The stderr line a beat must write for this decision, or `null` when there is nothing to say.
 * Lives here so both beats emit the identical wording — the `unrecognised` line is the operator's
 * only clue that the plane they thought they armed is halted, so it names the offending value.
 */
export function autonomyWarning(decision: AutonomyDecision): string | null {
  if (decision.reason === 'unset') {
    return `[loopkit] ${AUTONOMY_ENV_VAR} unset — defaulting to OFF (fail-safe); set it in .ai/loops/config.env\n`;
  }
  if (decision.reason === 'unrecognised') {
    return (
      `[loopkit] ${AUTONOMY_ENV_VAR}=${JSON.stringify(decision.raw)} is not recognised — ` +
      `defaulting to OFF (fail-safe); the only accepted values are "on" and "off" ` +
      `(case-insensitive); set it in .ai/loops/config.env\n`
    );
  }
  return null;
}

/**
 * Resolve the effective autonomy value. This is the exact chain both beat gates run.
 */
export function resolveAutonomy(envVal: string | undefined, override?: string): Autonomy {
  return resolveAutonomyDecision(envVal, override).autonomy;
}

/**
 * Is the plane ARMED — i.e. would the beats actually do work right now, rather than no-op at
 * the autonomy gate? Reads only the passed env bag; an absent bag, an unset var, and an
 * unrecognised value are all `false`, the same fail-safe the beats apply.
 */
export function isPlaneArmed(env: NodeJS.ProcessEnv | undefined): boolean {
  return resolveAutonomy(env?.[AUTONOMY_ENV_VAR]) === AUTONOMY_ON;
}
