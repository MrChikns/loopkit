# Trust boundaries — data sensitivity, provider routing, and what leaves the machine

loopkit assumes a world where you run **several models with different trust levels at once** — a
subscription frontier model, a second-opinion lane on a separate quota, and a local model that
never touches the network. The plane routes work between them **by declared data sensitivity and
by measured capability** — enforced in code, not by operator discipline.

## The threat model, plainly

When a work item is built, its prompt carries: the item's text, relevant file contents from the
target's worktree, and method/prompt-pack text. For an **external provider** (a hosted model),
all of that leaves the machine. The plane's job is to make "what may leave, for which project,
to which provider" an explicit, enforced policy — because "we were careful" does not survive an
overnight run.

## Sensitivity tiers (fail-closed routing, enforced per item)

Every work item carries a sensitivity: `public` · `internal` · `private` (default `internal`).
The provider registry **hard-gates** selection on it:

```jsonc
"sensitivityAllowlists": {
  "public":   ["claude-cli", "codex-cli", "ollama"],
  "internal": ["claude-cli"],
  "private":  ["ollama"]          // local model only
}
```

If no allowed provider is healthy, the item waits or parks — it is never quietly routed to a
disallowed one.

**Honest status (v0.1):** provider resolution is now **per-item and fail-closed at every routing
and build call site**. The reactor routes each captured item through a provider re-resolved against
*that item's own* sensitivity; the dispatch builder and the merge-review judge each resolve against
the most restrictive sensitivity in the build group; and an unknown/garbage sensitivity value is
treated as `private` (the most restrictive tier), never quietly widened. When no allowed, healthy
provider exists for an item's tier, the item **waits or parks — it is never routed to a disallowed
provider**. The only sites that still name a fixed `internal` tier are the plane-level health
*readouts* (the SLO board, the `slo`/`brief` CLI status lines), which read on-disk health markers
and send no item or repo material to any provider — each is annotated in code as such.

The **remaining** work before "private never leaves the machine" is a provable end-to-end
*content* guarantee (not just routing) is the pre-egress content scan below — a deterministic
secret/credential check on any prompt bound for a non-local provider. Routing is fail-closed; the
payload-content guard is still roadmap.

Fallbacks are **ordered chains per tier** (the registry walks the chain, skipping unhealthy
providers):

```jsonc
"fallbackChains": {
  "internal": ["claude-cli", "ollama"]   // degrade to local rather than to a different cloud
}
```

Target-level default (roadmap, lands with the target manifest): a project declares its floor
once — `"sensitivity": "private"` in `loopkit.target.json` — and every item of that target
inherits it. One line makes an entire codebase local-only by construction.

## Multi-model customization (easy default, full control)

**Default: one provider for everything.** A fresh install with a single configured provider works
end-to-end with zero routing config.

**Customize by role** — different stages have different stakes and costs:

```jsonc
"models": {
  "scout":  "haiku",    // cheap discovery
  "builder": "sonnet",  // the volume lane
  "judge":  "opus"      // the quality gate reads, it doesn't write
}
```

**Customize by provider lane** — e.g. a conserved second-opinion quota used only for review-stage
consults, never for build volume; a local model for private targets and as the degraded-mode
fallback.

**Or let measurement decide** — eval-driven routing tracks each model's first-pass merge rate and
cost per spec-size bucket from the ledger's own trajectory records, and can run:
- `off` — incumbent model always;
- `advisory` (default) — records what it *would* pick, so you can calibrate against reality;
- `active` — picks the best measured model, ties broken by cost, with a bounded exploration rate
  so cheaper models get a chance to earn samples.

Every provider call lands usage in the ledger (tokens, and quota-% for subscription-metered
providers), so "which model is actually earning its keep" is a projection, not a feeling.

## Egress guards (roadmap, in order)

1. **Scope-not-prompt** (with plan runs): unattended items get their permissions — branch
   prefix, allowed paths, provider tier — at *creation* time, never negotiated mid-run.
2. **Untrusted-payload wrapping**: text arriving via external triggers (webhooks, chat bridges)
   is labeled as untrusted data in worker prompts, not treated as operator instructions.
3. **Pre-egress content guard**: a deterministic secret/credential scan (and configurable
   redaction) on any prompt bound for a non-local provider — catching the `.env` that snuck into
   a worktree before it leaves the machine.

## What this is not

Not a DLP product, not a sandbox escape guarantee, and not a substitute for repo hygiene (don't
commit secrets). It is one enforced answer to one question: **which of my models is allowed to
see which of my projects — and does the record prove that's what happened.**
