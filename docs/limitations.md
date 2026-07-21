# Known limitations (v0.1)

This is a deliberate scope boundary, not an apology. loopkit is an event-sourced delivery plane
whose safe core — claim-before-pick TOCTOU arbitration, re-gate-after-rebase integration, tiered
acceptance on the real diff, and fail-closed provider routing — is built and tested. The gaps
below are the ones a staff review would raise; each is bounded, understood, and cheap to reach
from where the code is today. They are listed here so the seams are explicit rather than
discovered in production.

Each entry states *what's bounded* and *when it would actually matter*.

## Ledger durability & concurrency

- **Append is serialized, not atomic** (`ledger.ts:135`, `:72`). Events are written under a
  process lock, and single-line atomicity leans on `PIPE_BUF` — but that is a *pipe* write
  guarantee, not a regular-file one, so a torn write is theoretically possible on a crash mid-append.
  *Bounded:* the lock serializes writers, id-dedupe on load makes re-append idempotent, and the
  regression guard halts on a shrunk ledger. *Matters when:* a hard crash or full disk lands
  exactly between the write syscall and its flush on a filesystem that doesn't honor the append —
  rare, and recoverable from the local checkpoint refs.

- **The ledger lock carries no owner/PID token** (`ledger.ts:40`, `:54`). A transaction that holds
  the lock longer than the staleness window can have it reaped by another beat that assumes the
  holder is dead. *Bounded:* real appends are sub-second; the window is generous relative to them.
  *Matters when:* a pathologically slow append (e.g. under heavy I/O contention) overruns the
  window while still alive — two writers could then interleave. An owner/PID + liveness token on
  the lock closes this; it is a known next step.

## Event schema evolution

- **No event-schema versioning or upcaster** (`schema.ts:791`). Only the event *envelope* is
  validated; the `data` payload of each event type has no version tag and no migration path.
  *Bounded:* the fold reads fields defensively (absent/wrong-typed fields fold to `undefined`),
  so additive field changes are already safe. *Matters when:* a *breaking* change to an existing
  event's shape ships — old events in the historical stream would need an upcaster to re-interpret,
  and there is none. New event *types* are safe; renaming or re-typing a field on an existing type
  is not, yet.

- **Event-id entropy comment vs. reality; wall-clock ordering** (`schema.ts:34`, `:46`). The id
  comment says "50 random bits" but the generator emits ~30, and cross-process event ordering
  still leans on the wall clock. *Bounded:* 30 bits is ample against collision at this event
  volume, and same-process ordering is monotonic. *Matters when:* two processes on skewed clocks
  append in the same millisecond and a consumer depends on strict cross-process total order — the
  fold is designed to be order-tolerant, but a future consumer that isn't would be exposed.

## Integration-lane invariants (target + conductor)

- **Target and conductor lanes branch from arbitrary `HEAD`, not the default branch, and skip
  claim-before-pick / post-integration re-gate** (`dispatch.ts:1773`, `conductor.ts:17`, `:425`).
  The *main* engineering lane does all three (claim under the ledger lock, rebase-and-re-gate,
  re-merge-and-re-gate on a push race). The target build lane and the attended conductor do not yet
  carry those invariants. *Bounded:* both are attended/opt-in paths, run against their own repos,
  and still gate once before merge. *Matters when:* two concurrent conductor clusters or target
  builds race the same base — without claim-before-pick they could both pick, and without a
  post-integration re-gate an advanced base could merge un-re-verified. Porting the engineering
  lane's terminal to these two lanes is the fix.

- **Recovery does `reset --hard origin/master` with no clean-tree guard** (`dispatch.ts:3606`).
  The self-heal path force-resets a worktree without first checking for uncommitted work. *Bounded:*
  it runs only on a build worktree the plane owns and expects to be disposable. *Matters when:* a
  recovery fires against a tree that unexpectedly holds unsaved state — that state is lost. A
  `git status --porcelain` guard (bail if dirty in an unexpected way) closes it.

## Deploy signalling

- **Deploy is marked `true` on spawn, before success is observed** (`dispatch.ts:1618`). The
  `item.merged.deployed` flag records that a deploy command was *fired*, not that it *succeeded* —
  the deploy child is detached and its exit is not awaited. *Bounded:* deploy is off by default
  (empty `deployCommand`), and merge correctness does not depend on deploy. *Matters when:* a
  deploy hook fails silently — the ledger will still read `deployed: true`. A deploy-result event
  (succeeded/failed, keyed to the merge) would make this observable.

## Provider content guarantee (routing done, payload not)

- **Fail-closed provider resolution is routing-level, not content-level.** As of this hardening
  pass, provider resolution is per-item/per-group and fail-closed at **every** content-bearing call
  site — the engineering group, the planning lane, the target build lane, the conductor cluster,
  the operator-reply engagement lane, and the failure-pathology lane all resolve against the item's
  own (or the group's strictest) sensitivity and refuse to route a private-only item to a
  disallowed provider. What is **not** yet in place is a *pre-egress content scan*: a deterministic
  secret/credential/PII check on the prompt payload actually bound for a non-local provider.
  *Bounded:* routing can no longer send a private item to a cloud provider, so the tier boundary is
  enforced. *Matters when:* an *internal*-tier item (legitimately cloud-routed) carries a secret in
  its spec/diff — routing is correct but nothing scrubs the payload. The content DLP guard is
  explicitly roadmap, and `trust-boundaries.md` already frames it as such.

## Deliberately deferred (not bugs — scope)

These are out of scope for v0.1 by choice, not oversight:

- Linux/systemd host support (macOS/launchd only today).
- `npm`/`npx` install of the framework (run from a clone).
- Multi-target scheduling *guarantees* (multiple registered targets work; cross-target fairness/
  starvation guarantees are not modelled).
- Provider-agnostic claims beyond the built-in factory set.
- Pre-egress DLP / content scanning (see above).
- UI/opsui package consolidation (they share several byte-identical files).
- RBAC / cloud / team features.
