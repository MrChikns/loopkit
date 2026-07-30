# ADR-014 — Ledger-verified commit provenance, enforced at promotion, watched on a beat

**Status:** active

## Context

53 commits once landed on the default branch of this repo over six days with no work item, no
gate record, and no acceptance event — a silent bypass of the plane's own selling point, which is
that agent work is *proven* before it merges, not merely trusted. The bypass was invisible until
someone went looking: nothing in the push path, the beats, or the console said "this history is
ungoverned."

An earlier design tried to close the gap with a commit-message trailer (`Work-Item: WI-123`). That
was rejected as theater before it shipped: an agent capable of bypassing the plane can equally type
a fake id into a trailer, which does not close the hole, it relocates a silent failure into an
unverified assertion that *looks* like evidence. The only thing an agent cannot forge is the plane's
own ledger — `item.merged` receipts and gate evidence are appended by the mechanism that actually
ran the work, not typed by whichever process is trying to land a commit.

## Decision

**Verify every commit reaching the default branch against the operator's real ledger, at the point
of promotion — and separately, watch for the same gap on a beat cadence, report-only.**

### 1. What "verified" means

`packages/core/src/provenance.ts` walks the **first-parent** history of a commit range (the plane
merges with `--no-ff`, so a receipt's `commit` field names the merge commit on the default branch;
walking first-parent means a hand-made commit landing directly on the branch — a revert, a version
bump, anything — is a first-parent commit with no receipt, and is correctly reported `uncovered`
rather than silently skipped as a side commit) and classifies each commit into exactly one of four
states (`packages/core/src/provenance.ts:61-65`<!--cite:CommitProvenanceStatus--> — `verified`,
`receipt-without-gate`, `break-glass`, `uncovered`), rolled up into a range-level verdict
(`RangeProvenanceStatus`) plus a fifth, `indeterminate`, for every precondition that could not be
established (unreadable ledger, unregistered target, no or unresolvable baseline, non-linear
ancestry, more than one simultaneously open break-glass grant, or an empty range).

**Indeterminate is the load-bearing state, not an edge case.** A verifier that returns "verified"
when it could not actually check anything is the identical bug as the original incident, with extra
ceremony. Every ambiguity fails closed with its own named cause
(`packages/core/src/provenance.ts:71-74`<!--cite:IndeterminateCause-->) so each one is independently
testable, and a genuinely empty commit range is refused rather than reported clean — the exact shape
of mistake (a typo'd ref, an already-merged range, a branch compared to itself) that would make a
bypassed range read as "verified" if zero commits were treated as a vacuous pass.

### 2. Enforcement lives at the promotion boundary, not inside repair paths

`scripts/git-hooks/pre-push` runs `verify-provenance` per pushed ref and blocks the push
(`exit 1`) on `uncovered`, blocks on `indeterminate` (`exit 2` — "the check could not run" is
fatal here, unlike a merely-empty range in the sibling leak-scan tripwire, because every
indeterminate cause means governance could not be established, not that there was legitimately
nothing to check), warns-but-allows on an open break-glass grant (`exit 3`), and passes silently on
`verified` (`exit 0`). `git push` is the one place a commit range crosses from a private worktree
into shared, governed history — that is why enforcement sits here and nowhere earlier.

The same hook also fails closed if the provenance CLI itself is missing
(`scripts/git-hooks/pre-push` — the `PROVENANCE_CLI` existence check ahead of the leak-scan and
provenance blocks) rather than skipping the gate: a promotion control that silently disappears
whenever its own build artifact happens to be absent is the same hole one layer down.

**Deliberately, nothing inside a repair or self-heal path enforces this.** `packages/core/src/doctor.ts`'s
`ProvenanceProbe` (`packages/core/src/doctor.ts:181`<!--cite:ProvenanceProbe-->) is wired to run on
every doctor pass (beat cadence, WI-239) and specifically on the dist-drift self-heal path (WI-240 —
the local, ungoverned-runtime-promotion path a push-time gate never observes, because nothing is
pushed), and both surface a `ProvenanceFinding` that is **rendered, never enforced**
(`packages/core/src/doctor.ts:176`<!--cite:runDoctorNeverActsOnFinding-->: `runDoctor` never turns a
provenance finding into a requeue or `item.parked` action). This is the deliberate trade this ADR
names: a fail-closed check inside a repair path can wedge the plane permanently — an unreadable
ledger blocking the very repair that would fix the ledger, or a self-heal step refusing to rebuild a
stale `dist/` because it cannot first prove governance, leaving the plane unable to run `loopctl` at
all. The doctor's job is to make an ungoverned commit visible **within minutes** — on the next beat,
not discovered six days later at the next push — never to add a second failure mode to recovery
itself.

### 3. The receipt model

`extractMergeReceipts` (`packages/core/src/provenance.ts:223`<!--cite:extractMergeReceipts-->) reads
`item.merged` events off the real ledger and classifies gate evidence into two **execution shapes**
(WI-241), not just presence/absence:

- **`gate-run`** — a `gate.passed` event recorded by a beat, or an `item.merged.data.gateCommand`
  string naming the command that actually executed. Evidence a process ran.
- **`self-declared`** — the free-text `gate`/`gateResult` fields typed onto the *same* `item.merged`
  event that also carries the commit — the shape an attended coordinator hand-appends
  (`loopctl append item.merged --data '{"gate": "..."}'`), the appending agent vouching for its own
  commit with no independent execution record behind it.

A commit whose only matching receipt has *no* gate evidence at all classifies as
`receipt-without-gate` and fails the range (it is not "verified" — a receipt naming an item without
proof anything ran is closer to the trailer design this ADR already rejected). A commit backed by a
`self-declared` receipt does classify as `verified` — attended-coordinator merges are a real, sanctioned
path, not a bypass — but the attestation shape rides along on the verdict
(`CommitVerdict.gateAttestation`) and is broken out explicitly in the human-readable report
(`packages/core/src/provenance.ts:412-419`<!--cite:selfDeclaredVerifiedReporting-->), so "verified"
alone can no longer silently conflate "a gate ran" with "an agent typed a claim into its own merge
event."

**Break-glass is the one sanctioned, time-boxed exception**, and it is a ledger event
(`provenance.break-glass`), not a config toggle or an env var: `grantCoversCommit`
(`packages/core/src/provenance.ts:183`<!--cite:grantCoversCommit-->) covers a commit by a *time
window* (`grantedAt`..`expiresAt`), not a commit range — an expired grant covers nothing, with no
separate "expired" state, because a commit falling through to `uncovered` on re-check is the correct
louder outcome for an operator revisiting old history. At most one break-glass grant may be open per
target at a time; more than one open simultaneously is treated as an invariant violation
(`break-glass-multiple`) and refuses the whole range rather than picking one, because that is a plane
state that should never have been reachable at all.

## Consequences

**What this buys.** An unattributed commit can no longer reach the default branch of this repo
silently — it is blocked at push, and if it somehow lands anyway (a direct push bypassing the hook,
or a hook that was never installed on some clone), the beat-cadence doctor probe surfaces it within
one cadence, not six days. The receipt/attestation split (WI-241) makes a previously invisible
distinction visible: "verified" no longer means only "some receipt named this commit," it now also
says whether that receipt is backed by an execution record or a self-declared claim.

**What this does not buy, stated honestly:**

- **The self-heal and beat-cadence paths are report-only.** An ungoverned commit discovered by the
  doctor is *seen*, not blocked, not requeued, not auto-parked. Closing that gap without also
  reopening the wedge risk above is open work, not a promise this ADR makes.
- **"Receipt exists" and "gate ran" are now distinguishable but not separately enforced.** The
  `pre-push` gate still passes a range whose every commit is `verified`, including one where every
  verified commit is `self-declared` — WI-241 made the gap legible in the report, it did not add a
  new blocking condition on top of it. Whether self-declared-only ranges should someday warrant
  their own posture is an open question, not decided here.
- **Gate evidence is not yet bound to a specific attempt or SHA.** `hasGate` and `gateAttestation`
  are derived per `item.merged` event, not cross-checked against which build attempt or which exact
  commit a `gate.passed` event was recorded for. A ledger that happened to carry a `gate.passed` for
  the same item from an earlier, unrelated attempt would currently satisfy the same check. This is a
  known, named gap — not sound in the adversarial sense, only in the accidental-omission sense the
  break-glass time-window check (§3) also admits to.
- **Coverage is not adversarial-proof.** Break-glass coverage tests a commit's `committedAt` against
  a grant window; commit timestamps are author-controlled (`git commit --date`, or a replayed/rebased
  commit), so this is accident-prevention — did an operator actually open a grant around when this
  landed? — not a control that resists a determined actor rewriting history to fit inside a window.

**Rollback.** Both layers are additive and independently revertible: removing the two `pre-push`
blocks (leaving leak-scan and the noreply-email check) restores unenforced promotion; omitting a
`provenanceProbe` from `runDoctor` (the default, `defaultProvenanceProbe`) restores the
pre-WI-239/240 doctor byte-for-byte, since every caller that doesn't inject a real probe already gets
`provenanceFinding: null`. Neither rollback touches the other.
