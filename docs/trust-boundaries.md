# Trust boundaries — data sensitivity, provider routing, and what leaves the machine

loopkit has a provider registry for models with different trust levels: a hosted worker, an
optional provider on another quota, and a local model that never touches the network. Provider
selection is gated by declared data sensitivity and required tool capability. The exercised v0.1
worker is Claude CLI; Codex and Ollama adapters are experimental. Independent provider assignment
per stage, including an automatic cross-provider second-opinion lane, is not built yet.

## The threat model, plainly

When a work item is built, its prompt carries the item's text and may carry attachment paths,
operator notes, a configured playbook, prior diff/gate evidence, or a scout brief. A tool-enabled
worker can also read files from the target worktree. For an **external provider** (a hosted model),
material sent to or read by that worker leaves the machine. The plane's job is to make “what may
leave, for which project, to which provider” an explicit, enforced policy. Sensitivity routing and
the outbound credential tripwire cover part of that boundary; they are not a full content-DLP
guarantee.

With `knowledgePromotion.enabled`, the injected playbook stops being a hand-typed, arbitrary-trust
input: every line is gate-proven (harvested only from a merge whose gate passed) and
human-ratified (crossed the operator approve/reject gate) before it ever reaches a worker prompt —
a strictly higher trust class than "a file someone happened to edit." The harvest step itself reads
a merged item's spec and gate evidence under the SAME sensitivity-scoped provider resolution as the
merge judge and the pathologist (fail-closed: no allowed+healthy provider for that item's
sensitivity tier means the merge is skipped this beat, never routed to a disallowed provider) — see
docs/decisions/ADR-015-verified-knowledge-promotion.md.

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

**Honest status (v0.1):** the provider registry resolves item-bearing router, reply, build, and
pathology work against the item's sensitivity (or a build group's strictest sensitivity), and an
unknown/garbage value is treated as `private`, never quietly widened. Scout and the dispatch
judge reuse the already selected builder provider rather than selecting an independent
stage-specific provider. When a resolution point has no allowed, healthy,
capability-compatible provider, work waits, parks, or fails closed. Plane-level health
*readouts* use the `internal` chain only to inspect on-disk provider health markers; they send no
item or repo material.

There is also a deterministic credential tripwire at the provider boundary. Before a provider that
is not explicitly local runs, it scans the exact outbound `prompt` and optional `system` strings
and blocks high-confidence credential patterns. Missing or unknown provider locality is external,
and a finding exposes only typed rule ids — never the matched value or an excerpt.

That is not an end-to-end content guarantee or full DLP. The scanner does **not** inspect attachment
or repo files an agent later reads through tools, inherited environment variables, or provider/tool
transcripts. Sensitivity routing remains the control that keeps a private item on a local provider;
the credential tripwire is a narrow last line of defence for the text already assembled for egress.

Fallbacks are **ordered chains per tier** (the registry walks the chain, skipping unhealthy
providers):

```jsonc
"chains": {
  "internal": ["claude-cli", "ollama"]   // degrade to local rather than to a different cloud
}
```

Target-level default (roadmap, lands with the target manifest): a project declares its floor
once — `"sensitivity": "private"` in `loopkit.target.json` — and every item of that target
inherits it. One line makes an entire codebase local-only by construction.

## Multi-model customization (easy default, full control)

**Default exercised path: one provider.** A fresh plane uses one authenticated Claude CLI worker
for public/internal routing and builds with no additional provider-chain configuration. Private
items require an allowed local provider with the capability needed by that stage; otherwise they
wait or park rather than falling through to Claude.

**Customize models by stage** — different stages have different stakes and costs:

```jsonc
"models": {
  "router": "sonnet",
  "builderDefault": "sonnet"
},
"scout": { "model": "haiku" },
"judge": { "mode": "advisory", "model": "sonnet" },
"pathology": { "model": "opus" }
```

Provider chains are configured by sensitivity, not by stage. In the dispatch path, scout and
judge use the builder's selected provider; the judge is advisory and cannot block a merge.
Codex can be used manually as a conserved second opinion, but there is no automatic Codex review
stage. A local provider can be selected for private work or added explicitly as a degraded
fallback where its capabilities are sufficient.

**Or let measurement decide** — eval-driven routing tracks each model's first-pass merge rate and
cost per spec-size bucket from the ledger's own trajectory records, and can run:
- `off` — incumbent model always;
- `advisory` (default) — records what it *would* pick, so you can calibrate against reality;
- `active` — picks the best measured model, ties broken by cost, with a bounded exploration rate
  so cheaper models get a chance to earn samples.

Instrumented runs can land token/cost usage in the ledger, and subscription collectors add quota
readings. Coverage is incomplete: Codex adapter calls do not currently emit `cost.usage`, and the
effective reasoning effort is not recorded per call. Treat the usage projection as observed
telemetry, not a complete accounting of every provider invocation.

## Egress controls and remaining guards

1. ⚪ **Scope-not-prompt** (with plan runs): unattended items get their permissions — branch
   prefix, allowed paths, provider tier — at *creation* time, never negotiated mid-run.
2. ⚪ **Untrusted-payload wrapping**: text arriving via external triggers (webhooks, chat bridges)
   is labeled as untrusted data in worker prompts, not treated as operator instructions.
3. ✅ **Outbound-text credential tripwire**: block-only scanning of `prompt` and `system` before
   non-local provider calls. It neither redacts nor scans files, environment, or tool traffic.
4. ⚪ **Full egress DLP**: policy over attachments, tool reads/results, environment inheritance,
   transcripts, and configurable PII/secret handling.

## What this is not

Not a DLP product, not a sandbox escape guarantee, and not a substitute for repo hygiene (don't
commit secrets). It enforces provider eligibility by sensitivity and adds a narrow outbound-text
tripwire; it does not prove that every byte a tool-capable provider can observe was scanned.
