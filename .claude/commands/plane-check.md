---
description: Health-check the loopkit plane — deterministic readouts first (doctor, summary, slo), then diagnose anything red and route each finding: self-heal, capture a repair item, or park a decision for the operator. Use for "is the plane actually processing the queue, and if not, why".
---

Answer mechanically first; spend judgment only on what the readouts flag. Never "fix" a symptom
by weakening a gate or a picker — capture the root cause instead
([docs/method.md](../../docs/method.md): failures become evidence-carrying work items).

```bash
LOOPCTL="node <loopkit-repo>/packages/core/dist/cli.js"
```

## 1 · Deterministic readouts (no judgment yet)

```bash
$LOOPCTL doctor --json     # orphaned builds, quarantined events, dist drift
$LOOPCTL summary --json    # queue depth, building, parked, awaiting acceptance
$LOOPCTL slo --json        # SLO board — breaches are the "is it healthy" headline
$LOOPCTL brief             # the deterministic daily ops brief
echo "autonomy: ${LOOPKIT_AUTONOMY:-off(unset)}"
```
These are diagnostics, not pure reads: `brief`/`quota`/`costs` collect and append usage events
as they run, and `doctor` may execute the manifest's `deployCommand` to heal dist drift — know
that before running them in someone else's plane.

Verify the beats are actually firing under whatever scheduler runs them (cron, launchd, systemd
timer): look for recent `loop.beat` events specifically —
`$LOOPCTL events --recent 50 --json | grep '"loop.beat"'` — or the console `/health` view's
last-event age. Recent session/usage events alone do not prove the beats are alive.

## 2 · Interpret the known classes

- **`doctor` orphans** — an item stuck `building` whose worker pid is dead with no terminal
  event. Doctor *proposes* (requeue while attempts < breaker, park on breaker); the **reactor's
  doctor pass applies it** on its next beat. Beats off? Run `$LOOPCTL beat reactor` once to
  apply — never hand-edit state.
- **A long-running build** — check the worker log under `$LOOPKIT_HOME/runs/` before assuming a
  hang: long gates are long by design. Stall *detection* (progress probes + timeout) runs
  inside the beats, not in the CLI doctor readout — a live-but-silent worker shows up there.
- **`distDrift.drifted: true, healed: false`** — the plane merged its own code but is executing
  a stale build. Rebuild (`npm run build` in the plane repo / run the manifest's
  `deployCommand`) and re-run doctor to confirm healed.
- **`quarantinedKnown > 0`** — invalid events were quarantined rather than crashing the fold.
  Read them, fix the producer, never hand-edit the ledger (append-only — corrections are new
  events).
- **Queue full but nothing dispatchable** — items usually share a Touches footprint (or lack
  `touches` entirely, which serializes as wildcard). This is the conflict rule working, not a
  stall: narrow `touches` on items whose specs name files, or accept serial and say so.
- **Repeated parks with the same failure class** (`summary` park reasons) — systemic, not
  per-item. Read the newest worker log for the class; capture ONE repair item with the
  diagnosis + log path rather than requeueing the victims one by one.
- **Beats not firing** — scheduler-level drift (unloaded job, wrong env, dead machine timer).
  Fix the scheduler entry; if a beat crashes on start, its stderr log names why.

## 3 · Route every finding (never just report and walk away)

- Mechanical, few-line fix in the plane's own config/scheduler → do it now, re-run the readout.
- A real slice of work → capture it: `$LOOPCTL new "repair: <diagnosis with file:line + log
  paths>" --target <name>` — the repro travels with the item.
- Costly-and-irreversible, or judgment the operator owns → park it as a decision:
  `$LOOPCTL append item.parked --item WI-NNN --data '{"reason":"<intent, evidence, risk, what
  would change my mind>","parkKind":"decision"}'`.

## 4 · Close the loop

Re-run step 1 after any fix. Report: before/after verdict per readout, failure classes found,
what was fixed / captured / escalated.
