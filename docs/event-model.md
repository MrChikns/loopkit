# loopkit event model — targets, plane-home, and the multi-target contract

Status: v0.1 design. Single-target preview ships first. Target registration and new
`item.captured` data can carry a stable `targetId`; the fold retains that identity on the item
projection so downstream item events do not have to repeat it.

## The two repos

- **Plane-home** (default `~/.loopkit/`, overridable via `LOOPKIT_HOME`): the plane's own state —
  an initialized **git repository** so the durable-git-bus and commit-on-append/truncation
  protections apply to runtime state the same way they apply to any driven repo.

  ```
  <plane-home>/
    config/loopkit.json     # plane-level config: providers, beats, models, defaults
    targets/<targetId>.json # registration record (projection convenience; ledger is truth)
    ledger/                 # ONE ledger, monthly segments; item target is projected by the fold
    runs/<targetId>/        # worker logs, exit files, scratch — namespaced per target
  ```

- **Target repo** (any git repo the plane drives): holds only a **versioned, non-secret manifest**
  `loopkit.target.json` at its root. Manifests are trusted local code — the plane never
  auto-executes a manifest it hasn't been explicitly pointed at (`loopctl target add` is the
  consent step; commands inside are shown to the operator at registration).

## The target manifest (`loopkit.target.json`)

The generalized plane/target boundary, lifted to N targets:

```jsonc
{
  "name": "notes",                    // human handle; targetId derives from registration event
  "defaultBranch": "main",
  "gateCommand": "npm test",          // deterministic proof, run in the worktree
  "gateWorkdir": ".",
  "deployCommand": "",                // optional; empty = no deploy step
  "surfaceUrl": "",                   // optional HTTP(S) product link; never inferred from repoPath
  "worktreePrefix": "loop-",
  "touches": { "conflictMode": "prefix" },
  "boundaries": {
    "planePrefixes": [],              // merge-trust axis: auto-merge without operator approval
    "surfacePrefixes": [],            // test-visibility axis: surface on the acceptance desk
    "escalationPatterns": []          // risk axis: classify `must`; pre-merge hold is opt-in
  },
  "acceptance": { "tiers": { /* per-tier acceptance windows */ } },
  "promptsDir": "",                   // reserved; parsed but not consumed by the v0.1 runtime
  "buildTimeoutMinutes": 45
}
```

## Commands → events → projections

### Register a target
- **Command** `loopctl target add <path>` — validates the repo + manifest, prints the manifest's
  commands for operator review, then appends.
- **Event** `target.registered { targetId, name, repoPath, manifestHash, defaultBranch }`
  (actor: cli). Re-registering the same path with a changed manifest appends
  `target.manifest-updated { targetId, manifestHash }` — never mutates.
- **Identity ≠ name.** `targetId` is an opaque id **minted once** at first registration; `name`
  is a mutable display handle. Renaming a target never changes its identity, and two targets may
  even share a name without colliding. Runtime lookup and target-specific worktree/run paths use
  the projected id where available; downstream item events need not restamp it. (The mutable name
  remains on captures for display and backward compatibility.)
- **Projection** `TargetBoard`: per-target status (registered · active items · last build ·
  health), derived by the one fold.

### Target lifecycle (pause · resume · archive · export)

Attach/detach is a ledger contract, not config mutation. Verbs (post-v0.1 activation; the
contract is pinned now so activation is additive):

- **`loopctl target pause <name>`** → `target.paused { targetId }` — registered but dormant: the
  reactor stops routing new intent to it, dispatch skips its queued items. `resume` →
  `target.resumed { targetId }`. This is the everyday verb ("not working on X right now").
- **`loopctl target archive <name>`** → `target.archived { targetId }` — terminal detach: routing
  stops permanently; history and projections stay readable (append-only — unlink never means
  delete). Guard: refused while the target has in-flight builds; drain or park them first.
- **`loopctl target export <name>`** — filters the stream by `targetId` into a fresh standalone
  plane-home (itself a valid git repo). Lossless by construction. An export is a **copy**, not a
  move: removing the exported events from the source plane-home is a history rewrite of that
  repo, a deliberate operator ritual, never a command. Importing into a *live* plane is
  unsupported (WI-id remapping); export targets a fresh plane-home only.
- **Identity pin:** re-registering a previously archived `repoPath` **revives its original
  `targetId`** (the fold matches on repoPath) — one project, one id, forever; re-adding never
  fragments history across ids.

### Capture intent against a target
- **Command** `loopctl new [--target <name>] "<text>"` — `--target` optional while exactly one
  target is registered (the single-target preview); required once N>1. Explicit selection first;
  natural-language routing is a later milestone.
- **Event** `item.captured { targetId?, target?, source, text }` — new targeted captures stamp the
  stable id and display name. Downstream events (`item.queued`, `build.dispatched`, `gate.*`,
  `item.merged`, `msg.out`, …) are still addressed by the globally unique `WI-NNN` subject and
  usually omit target fields; the fold inherits target identity from the capture onto the item
  projection. Legacy captures that carry only the name resolve through the target registry.

### Build execution
- Dispatch resolves the item's target, creates the worktree **from the target repo** (prefix from
  its manifest), runs the target's `gateCommand` in it, merges to the target's `defaultBranch`.
  Lane/`Touches` disjointness is evaluated **per target** (two targets never conflict by
  construction; the `'*'` serialization lane is per-target). Worktree directory names include the
  `targetId` so sibling repos sharing a parent dir and a `worktreePrefix` can never clobber each
  other's builds — per-target namespacing, like `runs/`, is part of the same invariant.
- Acceptance tiering classifies against the **target's** boundaries block, applying the
  precedence: surface wins over plane; risk wins over both.

### Park and dependency semantics

`item.parked.parkKind` is the intent of a pause, not an interchangeable failure label:

| kind/state | meaning | automatic behavior | operator surface |
|---|---|---|---|
| `parked/hold` | deliberately paused | none | neutral; Resume only |
| `parked/decomposition` | waiting for the planner | planner owns the next transition | informational |
| `parked/ops` | plane-owned failure recovery | bounded retry and pathology | health/recovery; decision only when its breaker is exhausted |
| `parked/decision` | one concrete operator call | waits indefinitely | decision desk |
| `blocked` | waits on a named work item | releases when that blocker merges or is accepted | shows the blocker and its current state |

The pathologist diagnoses only failure parks (`ops`, plus legacy unstamped parks). It never sends
`hold`, `decision`, or `decomposition` through a diagnosis provider. A blocked victim waits while
its blocker is live, planning, or recovering. If the blocker is held or already needs a decision,
the victim keeps pointing at that actionable blocker rather than creating a duplicate decision.
Only a missing or terminal-without-merge blocker escalates the victim after the configured wait
timeout. A deliberately held victim never moves automatically, even if its blocker later lands.

Legacy unstamped parks remain fail-safe: a breaker-prefixed legacy park is still an ops failure,
but age alone never turns an unstamped park into an operator alarm.

### Confirm a portability-nudge reply (ADR-009)
- A merged/accepted item's certification may carry a `portability` note (`"applies to: <targets>
  | none"`) declaring which OTHER registered targets its pattern generalizes to. When an
  ADR-bearing or incident-fix item ships without one, the reactor nudges the operator once
  (`msg.out`) — but a bare reply in the thread never becomes a certification amendment; it must be
  confirmed through the verb below.
- **Command** `loopctl portability <WI-NNN> "<reply body>" [--by <actor>] [--trail "<text>"]` —
  precondition: item is `merged` or `accepted`. The reply body is validated against a strict
  grammar (`schema.ts` `parsePortabilityTargets`): case-insensitive target names, `none` valid
  alone, empty body always an error, unknown (unregistered) targets reject the **whole**
  amendment with an operator-facing `msg.out` (all-or-nothing, unlike the reactor's own tolerant
  read of the same field).
- **Event** `item.certification-amended { field: 'portability', portability, targets, by,
  inReplyTo }` on success, paired with the `msg.in` reply trail (linked via `inReplyTo`, mirroring
  approve/reject). The fold merges it onto `mergeCertification.portability`, last-writer-wins —
  any amendment (including `none`) also silences the nudge, since the nudge's dedup key is simply
  "does `cert.portability` have a value".
- `stepPortabilityPromotion` (reactor) re-reads `cert.portability`, but the feature is staged
  behind `portabilityPromotion.enabled` and defaults **off**. Only an explicitly enabled plane
  captures the sibling on a subsequent beat.

## Plane topology — one default plane; detached planes; never federation

The plane is **machine-level infrastructure, not project tooling**: one plane-home, one
reactor+dispatch pair, one console showing every registered target (the portfolio view falls out
of the one fold — no aggregation layer exists or ever will).

When a project genuinely must be isolated (separate trust domain, different machine, someone
else's repo), it runs a **detached plane**: its own plane-home via `LOOPKIT_HOME`, its own beat
labels, its own console. Detachment is the escape hatch — the detached plane being invisible
from the default console is the feature, not a gap. Moving a project between planes is
`target export` into the fresh plane-home. There is **no cross-plane aggregation, discovery, or
federated console**; anyone needing a unified view of two planes should merge them into one.

**Event scope pin:** target identity is data on target registration/capture and projected item
state, not a universal envelope field. Plane-scoped events (provider quota, plane health, doctor)
remain distinguishable by their event type and non-work-item subject (for example `system`);
they do not need a fabricated `targetId: null`.

## Compatibility & migration

- Items whose capture carries **no target stamp** can fold with
  `targetId = config.defaultTarget` — a caller-supplied compatibility option. The fold can also
  resolve a name-only legacy capture, or coalesce an unstamped item onto the sole registered
  target. No rewrite of any existing ledger is required.
- An embedded single-target deployment keeps running its in-repo ledger untouched. Parity check
  before any cutover: point the packaged fold (read-only) at the live ledger with
  `defaultTarget` set to that deployment's name and diff `summary --json` against the embedded
  fold's output.

## Deliberately NOT in v0.1

Natural-language target routing · cross-target scheduling optimization · portfolio board polish ·
per-target ledger segmentation (one ledger + targetId is enough until proven otherwise) ·
remote/auto-discovered manifests (registration is always an explicit local operator act) ·
target lifecycle verbs pause/archive/export (contract pinned above; ships with multi-target
activation) · plane federation (**never** — see "Plane topology"; a detached plane is the
escape hatch, not an aggregation problem).
