# loopkit event model — targets, plane-home, and the multi-target contract

Status: v0.1 design. Single-target preview ships first; `targetId` is in every
contract from birth so one-to-many is an activation, not a migration.

## The two repos

- **Plane-home** (default `~/.loopkit/`, overridable via `LOOPKIT_HOME`): the plane's own state —
  an initialized **git repository** so the durable-git-bus and commit-on-append/truncation
  protections apply to runtime state the same way they apply to any driven repo.

  ```
  <plane-home>/
    config/loopkit.json     # plane-level config: providers, beats, models, defaults
    targets/<targetId>.json # registration record (projection convenience; ledger is truth)
    ledger/                 # ONE ledger, monthly segments; every event carries targetId
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
  "worktreePrefix": "loop-",
  "touches": { "conflictMode": "prefix" },
  "boundaries": {
    "planePrefixes": [],              // merge-trust axis: auto-merge without operator approval
    "surfacePrefixes": [],            // test-visibility axis: surface on the acceptance desk
    "escalationPatterns": []          // risk axis: always park for the operator
  },
  "acceptance": { "tiers": { /* per-tier acceptance windows */ } },
  "promptsDir": "",                   // optional per-target prompt overrides
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
  even share a name without colliding. Nothing downstream (fold keys, event fields, worktree and
  run paths) may key on `name`. (v0.1 implementation note: the single-target preview still keys
  by name — minting the id is the first step of multi-target activation.)
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
- **Event** `item.captured { targetId, source, text }` — and **every** downstream event on the
  item (`item.queued`, `item.routed`, `build.dispatched`, `gate.passed|failed|parked`,
  `item.merged`, `item.accepted`, `msg.out`, …) carries the item's `targetId`. The fold keys work
  items by `(targetId, itemId)`; item ids stay globally unique (`WI-NNN` counter is plane-scoped,
  not per-target, so cross-target references stay unambiguous).

### Build execution
- Dispatch resolves the item's target, creates the worktree **from the target repo** (prefix from
  its manifest), runs the target's `gateCommand` in it, merges to the target's `defaultBranch`.
  Lane/`Touches` disjointness is evaluated **per target** (two targets never conflict by
  construction; the `'*'` serialization lane is per-target). Worktree directory names include the
  `targetId` so sibling repos sharing a parent dir and a `worktreePrefix` can never clobber each
  other's builds — per-target namespacing, like `runs/`, is part of the same invariant.
- Acceptance tiering classifies against the **target's** boundaries block, applying the
  precedence: surface wins over plane; risk wins over both.

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
- `stepPortabilityPromotion` (reactor) is unchanged: it already re-reads `cert.portability` every
  beat, so the very next beat after an amendment promotes the sibling on the named target.

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

**Event scope pin:** plane-scoped events (provider quota, plane health, doctor) carry an explicit
`targetId: null` — never a missing field. The missing-field → `defaultTarget` fallback below is
strictly the legacy-ledger upgrade path; new writers always set `targetId` (an id or null), so a
`target export` never drags plane noise along.

## Compatibility & migration

- Events with **no `targetId`** (a ledger written by a pre-multi-target deployment) fold as
  `targetId = config.defaultTarget` — a plane-level config key. No rewrite of any existing
  ledger, ever.
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
