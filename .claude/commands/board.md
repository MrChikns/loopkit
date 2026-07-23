---
description: The status window — render the loopkit board and the deterministic readouts (summary, brief, slo, quota, costs) and answer "where are we?" without starting any work.
---

Status questions get status answers — **never start building to answer one**. Everything below
is a projection of the ledger; render it, interpret briefly, stop. (Not all of it is a pure
read: `brief`/`quota`/`costs` collect and append usage events as part of producing their view.)

```bash
LOOPCTL="node <loopkit-repo>/packages/core/dist/cli.js"
```

- `$LOOPCTL board` — the work board: queued · building · gated · needs-you · merged · accepted.
- `$LOOPCTL summary` — compact counts + active items (`--json` for scripting).
- `$LOOPCTL brief` — the deterministic daily ops brief: shipped, in-flight, needs-you, health.
- `$LOOPCTL slo` — SLO board; breaches are the headline.
- `$LOOPCTL quota` / `$LOOPCTL costs --by provider` — spend and subscription-quota posture.
- `$LOOPCTL state --item WI-NNN` — one item's current state;
  `$LOOPCTL events --item WI-NNN` — its full event timeline, when the operator asks about a
  specific piece of work.

Present it as the operator's window ([docs/method.md](../../docs/method.md)): what shipped,
what's in flight, the short list that actually needs them, and the one next step. If something
in the readouts looks unhealthy, say so and offer `/plane-check` — don't silently start
diagnosing.
