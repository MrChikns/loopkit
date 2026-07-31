# ADR-015 — Verified knowledge promotion: the playbook becomes a projection of ratified, gate-proven knowledge events

**Status:** proposed

## Context

The plane already runs a two-layer memory, but only one layer is wired end-to-end. The
**episodic** layer is the ledger — every build, gate run, merge, crash, and diagnosis is an
immutable event. The **distilled baseline** layer is the playbook (`.ai/loops/playbook.md`,
default 40 lines), injected verbatim into every worker prompt as `REPO PLAYBOOK`
(`dispatch.ts:4233–4246`, `buildPrompt` arg 7). This is the industry-standard shape — an
episodic log plus a small distilled baseline read on every task (CLAUDE.md + auto-memory,
Devin Knowledge, Codex Memories, Copilot Memory).

Two gaps make our baseline layer inert:

1. **The playbook is hand-curated with no producer.** The config doc-comment (`config.ts:584`)
   promises "a watcher appends `# candidate:` lines for ratification," but no such watcher,
   step, or verb exists. Every line in the playbook was typed by a human. Execution-proven
   knowledge — a gate command that actually passed, a repo convention a worker rediscovered
   the hard way, a constraint a crash taught us — is *in the ledger* but never flows to the
   baseline. The two layers do not connect.

2. **Our one working distillation loop deliberately never touches the baseline.** Tier
   calibration (`stepTierCalibration`) learns from outcomes and writes `tier.recalibrated` —
   but it is ledger-only, because a numeric acceptance-window is safe to auto-tune. Free-text
   *knowledge* is not: it is exactly the thing the memory-safety literature says you cannot
   auto-promote.

The research frontier is **verification-gated promotion**, and it is unambiguous about the
danger:

- Admit knowledge only after successful *execution*, not after a plausible-sounding claim
  (Voyager admits a skill only once it runs; SKILL.nb, arXiv 2606.08049, treats memories as
  executable artifacts validated by deterministic acceptance checks).
- The extractor must not vouch for its own trace — the "self-confirmation trap" (EDV,
  arXiv 2606.24428) — so distillation wants a **third-party** distiller, not the building
  agent grading itself.
- Most decisively: on **real coding-agent traces**, GovMem (arXiv 2607.02579) found **zero**
  candidates safe for automatic promotion, because correlated traces manufacture false
  confidence. Their conclusion — keep a human or deterministic gate in the loop — is a
  negative result we should respect rather than re-derive in production.
- Shipped practice agrees: Copilot Memory re-validates each memory **against the current
  codebase at read time** and expires it after 28 days; the dominant safe promotion form is
  a **reviewable diff with default-reject curation**.

So the design constraint writes itself: connect the two layers, but gate the connection the
way the plane already gates *code* — proven before it lands, ratified by the operator, and
rebuildable from an append-only source of truth. This ADR does for **knowledge** exactly what
ADR-014 did for **commits**: the only thing an agent cannot forge is the plane's own ledger,
so make the ledger — not a hand-edited file — the source of truth, and make the file a
projection of it.

## Decision

**The playbook stops being a source file and becomes a pure, rebuildable projection of
ratified knowledge events. Knowledge is extracted from gate-proven merges, curated by a
default-reject strict auditor, ratified by the operator through the existing approve/reject
verbs, materialized by the reactor, and revalidated at read time before it is ever injected.**
No knowledge line reaches a worker prompt without having (a) come from a merge that passed
the gate, (b) survived a strict-auditor rejection pass, (c) been approved by a human, and
(d) passed a cheap deterministic freshness check at injection time.

This is one new closed loop mapped onto machinery the plane already has — the ADR-009
promotion/dedup pattern, the ADR-007 approve/reject verbs, and the calibration step's
ledger-only discipline — plus exactly one genuinely new capability: a reactor step that
materializes a file.

Everything below specifies **proposed** behavior: none of the new steps, events,
configuration, or guarantees is implemented yet. Slices land dormant behind a default-off
`knowledge.enabled` flag; the present tense is the ADR describing the design, not the
running system.

### The event-model, left to right

```
   [merged, gate-proven item]          reactor: knowledge-harvest          reactor: knowledge-harvest
   mergeGateCommand / mergeChangedFiles      (LLM, strict auditor)             (deterministic dedup)
   mergeCertification.couldBreak ─────►  extract ≤N candidate lessons  ─────►  drop dups/contradictions
            │                            default-REJECT: most merges                    │
            │                            yield ZERO candidates                          ▼
            │                                                            knowledge.candidate  (parked
            ▼                                                            as a decision item, WI-NNN)
   ══════════════════════════════════════════════════════════════════════════════════════│═══════
        OPERATOR (the one door)                                                            ▼
                                                                    console decision desk / notifier
                                                                    "Promote this lesson? [approve|reject]"
                                                                              │
                     ┌────────────────────────────────────────┬─────────────┘
                     ▼ approve                                 ▼ reject
              item.approved                              item.rejected
              knowledge.ratified                         (terminal; candidate dies,
              (the durable promotion fact)                never re-harvested — dedup stamp)
                     │
   ══════════════════│══════════════════════════════════════════════════════════════════════════
        reactor: playbook-materialize (deterministic projection)
                     ▼
        fold all knowledge.ratified − knowledge.expired ─► rank by recency×usefulness ─► top maxLines
                     │                                                                   │
                     ▼                                                                   ▼
        REVALIDATE each: does its cited file/command still exist?   ─── stale ──►  knowledge.expired
                     │ fresh                                                        (evicted ≠ deleted)
                     ▼
        write .ai/loops/playbook.md   (GENERATED banner; idempotent content-hash write)
                     │
   ══════════════════│══════════════════════════════════════════════════════════════════════════
        dispatch: build a worker prompt
                     ▼
        read playbook.md ─► inject as REPO PLAYBOOK (unchanged path, dispatch.ts:4233)
```

Read this as the plane's standard event-model: events flow left to right into projections;
the operator is a single vertical gate the flow must cross; nothing downstream of the gate
can be reached without an `item.approved`.

### Event contract (new types)

Names follow the existing `domain.past-tense` convention (`gate.passed`, `tier.recalibrated`,
`item.certification-amended`). A new `knowledge.*` domain, registered in `EventDataMap` +
`KNOWN_TYPES`. Unknown types already fold forward-compatibly, so a legacy ledger is untouched.

```ts
/**
 * knowledge.candidate — a distilled lesson extracted from ONE gate-proven merge by the
 * strict-auditor harvest step. Carried on its OWN work item (WI-NNN, source-stamped
 * `knowledge:<sourceWi>:<contentHash>` for once-per-(source, lesson) dedup, mirroring
 * stepPortabilityPromotion's `portability:<id>:<targetId>` stamp). Parked as a decision
 * the same beat — a candidate is never queued as build work; it is a question for the
 * operator.
 */
export interface KnowledgeCandidateData {
  /** The one-line lesson, in imperative playbook voice. Hard-capped (≤ playbook line budget). */
  lesson: string;
  /** Stable content hash of `lesson` (normalized) — the dedup + eviction key. */
  contentHash: string;
  /** Which merged item this was harvested from. Provenance, not decoration. */
  sourceWi: string;
  /** The command that PROVED sourceWi's build — copied from item.merged.gateCommand. */
  gateCommand?: string;
  /** Verbatim excerpt of the gate evidence the lesson is grounded in (capped). */
  gateEvidenceExcerpt?: string;
  /** How the lesson was produced. Only 'strict-auditor' in v1; extensible. */
  method: 'strict-auditor';
  /** Model that did the extraction (attributability, mirrors DiagnosisRecordedData.model). */
  model: string;
  /**
   * A deterministic freshness anchor the materialize step re-checks at read time: a repo
   * path and/or a command the lesson depends on. If the path no longer exists (or the
   * command's tool is gone), the lesson is stale and evicted. Absent ⇒ TTL-only freshness.
   */
  verifyPath?: string;
  verifyCommand?: string;
}

/**
 * knowledge.ratified — the durable promotion fact. Appended by the reactor's apply-verbs
 * step WHEN an operator approves a knowledge candidate (item.approved on an item whose
 * latest park was a knowledge candidate). This is the event the playbook projection folds
 * over — NOT item.approved directly, so "approved a knowledge item" and "approved an
 * ordinary build" stay distinct facts (ADR-014's discipline: don't conflate two truths
 * onto one event).
 */
export interface KnowledgeRatifiedData {
  contentHash: string;
  lesson: string;
  sourceWi: string;
  /** Carried through so the projection can revalidate + rank without re-reading the candidate. */
  verifyPath?: string;
  verifyCommand?: string;
  ratifiedBy: string;   // 'operator'
}

/**
 * knowledge.expired — a previously-ratified lesson removed from the injected set. Producers:
 * (1) the materialize step's read-time revalidation when verifyPath/Command no longer
 * resolves (`reason: 'stale'`); (2) an explicit operator retraction (`reason: 'retracted'`);
 * (3) the budget ranking (`reason: 'budget-evicted'`). EVICTED ≠ DELETED: the event is
 * appended (the ledger never mutates); the lesson simply drops out of the projection's fold.
 * A later re-ratification of the SAME contentHash resurrects it — last-writer-wins between
 * ratified/expired, keyed on contentHash.
 */
export interface KnowledgeExpiredData {
  contentHash: string;
  reason: 'stale' | 'retracted' | 'budget-evicted';
  /** For 'stale': which anchor failed. */
  failedAnchor?: string;
}

/**
 * playbook.materialized — the projection receipt. Appended by the materialize step ONLY when
 * it actually rewrote the file (content changed), so the ledger records every baseline change
 * with its provenance. Report/audit only; nothing folds behavior off it.
 */
export interface PlaybookMaterializedData {
  path: string;
  linesWritten: number;
  contentHash: string;      // hash of the whole rendered file
  ratifiedCount: number;    // total live ratified lessons
  evictedForBudget: number; // ratified-but-not-injected (over maxLines)
}
```

No `knowledge.rejected` type: an operator rejecting a candidate is the **existing**
`item.rejected` (ADR-007) on the candidate's work item — terminal, and its source-stamp keeps
the same lesson from being re-harvested. Reusing it keeps one "close this" event, per the
ADR-009 rejection of second parsers.

### Where each step runs — deterministic vs LLM vs projection

| Stage | Location | Kind | Notes |
|---|---|---|---|
| **Harvest / extract** | new `stepKnowledgeHarvest` in `reactor.ts`, slotted after `stepPortabilityPromotion` — both harvest from merged items; runs before route so a fresh candidate is a routable item this beat | **LLM**, capped | Same shape as `stepMergeJudge`: fold → filter eligible (`state==='merged'`, has `mergeGateCommand`, not already harvested by source-stamp) → sensitivity-scoped provider (fail-closed) → per-beat cap (e.g. 5) → append. Prompt is the strict auditor (below). |
| **Curate (default-reject)** | inside the harvest prompt | **LLM** | The strict-auditor prompt (per the default-reject curation norm; cf. arXiv 2603.15666) instructs: *most merges teach nothing generalizable; emit `[]` unless a lesson is (a) execution-proven by this merge's gate, (b) durable beyond this one item, (c) not already obvious from the repo's contributing guide.* Default output is the empty set. |
| **Dedup / contradiction** | tail of `stepKnowledgeHarvest` | **Deterministic** | `contentHash` set from all prior `knowledge.candidate` + `knowledge.ratified`, exactly like `promotedPairs` in `stepPortabilityPromotion`. A candidate whose normalized hash exists is dropped; a candidate that *negates* a live ratified lesson is flagged in the park reason for the operator, never auto-resolved. |
| **Park for ratification** | end of harvest step | **Deterministic** | Each surviving candidate gets its own `WI-NNN` via `item.captured` (source-stamped) + `item.parked{ parkKind:'decision' }` — the same shape as the decision-park branch of `stepPortabilityPromotion`. This routes it to the console decision desk + the decision-park notifier. |
| **Ratify** | **operator**, then `stepApplyVerbs` | **Human gate**, then deterministic | Operator runs `approve`/`reject` (ADR-007). `stepApplyVerbs` gains a small clause: when it processes an `item.approved` on an item whose park was a knowledge candidate, it **also appends `knowledge.ratified`** in the same locked append. Per **GovMem's negative result, there is NO auto-approve path for knowledge in v1** — `stepAutoApprove` already skips `parkKind:'decision'`, and knowledge parks inherit that. |
| **Materialize** | new `stepPlaybookMaterialize`, slotted near end, after apply-verbs (so this beat's fresh ratifications land) | **Deterministic projection** | The one new capability. Folds `knowledge.ratified − knowledge.expired`, revalidates, ranks, writes the file idempotently, appends `playbook.materialized` only on change. Mirrors `render-lane-matrix.ts`'s "GENERATED — do not hand-edit" banner + full-file rewrite. |
| **Inject** | `dispatch.ts:4233` | unchanged | Dispatch keeps reading the file. **Zero dispatch change** — the file is still a file; it is just now written by the plane instead of a human. |

### Read-time safety

The materialize step is where the memory-safety literature's read-time discipline lives —
cheap, deterministic, on every beat that has anything to write:

- **Freshness by anchor, then TTL.** For each ratified lesson, if it carries `verifyPath`,
  the step checks the path still exists in the target repo; if `verifyCommand`, it checks the
  command's leading binary resolves. A failed anchor appends `knowledge.expired{reason:'stale'}`
  and drops the lesson. This is Copilot Memory's "validate against the current codebase at
  read time," done deterministically rather than with an LLM. A lesson with **no** anchor
  falls back to a TTL (default 60 days, config) measured from its `knowledge.ratified` ts —
  expired the same way. A stale lesson is re-surfaceable: nothing stops a future merge
  re-harvesting the pattern if it is still true.
- **The line budget is a ranking, not a filter on the ledger.** All ratified-and-fresh
  lessons are ranked by **recency × usefulness**, where usefulness is a cheap ledger-derived
  signal (how many later merges touch the same `verifyPath`/area, i.e. how live the touched
  surface is), and only the **top `maxLines`** are written to the file. Lessons past the
  cutoff get `knowledge.expired{reason:'budget-evicted'}` **only in the projection sense** —
  evicted ≠ deleted: the ratified event stays in the ledger forever, and if a higher-ranked
  lesson later expires, a budget-evicted one rises back into the file next beat. This is the
  direct mitigation for context bloat against a hard 40-line cap.
- **Idempotent write.** The step hashes the rendered file and rewrites only on change (no-op
  beats write nothing and append no `playbook.materialized`), so the beat stays quiet and the
  git working tree is not churned every 30s.

### What is explicitly NOT in v1

- **No automatic promotion.** GovMem found zero real-trace candidates safe to auto-promote;
  every knowledge line crosses the human gate. The harvest step's *output* is a parked
  question, never a ratified fact. Whether a future tier of "obvious mechanical" lessons
  could auto-ratify (the way tier calibration arms itself on agreement evidence) is open
  work, not a promise here.
- **No cross-repo / global memory.** Lessons are per-plane (harvested from this ledger's
  merges, materialized to this repo's playbook). The `sourceWi`/target fields make
  cross-target promotion *possible* later (it would reuse the ADR-009 machinery), but v1
  promotes only into the harvesting plane's own baseline.
- **No semantic retrieval.** Injection stays the whole (budgeted) file in every prompt,
  unchanged from today. Per-task retrieval of the *relevant* lessons is a real future win but
  a different, larger design; v1's job is to make the baseline *earned and fresh*, not
  *selected*.
- **No richer contradiction resolution.** The dedup step flags a negating candidate for the
  operator; it does not auto-retract the conflicting live lesson.

### Implementation slices

Each is independently shippable and lands dormant behind a default-off flag
(`knowledge.enabled`, default `false`, mirroring `portabilityPromotion.enabled`), so an unset
flag is byte-for-byte today's behaviour.

**Slice 1 — Event contract + fold + materialize the projection (the spine, no LLM).**
The one durable API lands first and is testable with hand-authored `knowledge.ratified`
fixtures — no model needed.
- *Files:* `schema.ts` (4 new interfaces, `EventDataMap`, `KNOWN_TYPES`, `validateEvent`
  cases); `fold.ts` (fold `knowledge.ratified`/`knowledge.expired` into a per-hash
  `KnowledgeFact` map, last-writer-wins on contentHash); `config.ts` (`knowledge` block:
  `enabled`, `ttlDays`, reuse `playbook.maxLines`); new `reactor.ts`
  `stepPlaybookMaterialize` + wire into the step list after apply-verbs; a
  `renderPlaybook(fold)` helper (mirror `render-lane-matrix.ts`).
- *Tests:* fold merges ratified/expired correctly (LWW on hash, resurrection); revalidation
  drops a lesson whose `verifyPath` is absent; budget ranking evicts the lowest-ranked past
  `maxLines`; idempotent write (no `playbook.materialized` on unchanged content); GENERATED
  banner present; **flag-off = no file written, no events, byte-identical old behaviour.**

**Slice 2 — Ratification wiring through the existing verbs (deterministic, human gate).**
- *Files:* `reactor.ts` `stepApplyVerbs` clause — on `item.approved` for a
  knowledge-candidate item, also append `knowledge.ratified`; on `item.rejected`, nothing new
  (terminal + source-stamp already blocks re-harvest); `verbs.ts` a `retract` path appending
  `knowledge.expired{reason:'retracted'}`; confirm `stepAutoApprove` skips these (it already
  skips `parkKind:'decision'`).
- *Tests:* approve a candidate → exactly one `knowledge.ratified` with the right hash;
  reject → terminal, no ratified; auto-approve never fires on a knowledge park; retract
  appends expired and the lesson drops from the next materialize.

**Slice 3 — The strict-auditor harvest step (the one LLM stage).**
- *Files:* new `reactor.ts` `stepKnowledgeHarvest` (clone `stepMergeJudge`'s
  eligibility/cap/sensitivity-provider skeleton); a `buildKnowledgeAuditPrompt(rec,
  gateEvidence)`; source-stamp dedup (clone `promotedPairs`); park-as-decision emit; wire
  into the step list after `stepPortabilityPromotion`.
- *Tests:* a merge with `mergeGateCommand` + a real diff yields ≥0 candidates;
  **default-reject: a trivial merge yields `[]`**; a second harvest of the same merge
  produces no duplicate (source-stamp); a candidate's park is `parkKind:'decision'` and
  carries `sourceWi`+`gateCommand` provenance; provider-unavailable → skip, never a
  fabricated candidate (mirror the judge's `unavailable` posture); per-beat cap respected.

**Slice 4 (optional) — Migrate the existing hand-curated playbook into the ledger.**
Today's `.ai/loops/playbook.md` is hand-authored; once Slice 1 makes the file a projection,
a one-time `loopctl knowledge import` reads current non-comment lines and appends a
`knowledge.ratified{method:'imported'}` per line (operator-run, so the human gate is honored
by the act of running it), after which the file is never hand-edited again.
- *Tests:* import is idempotent (re-run appends nothing new by hash); post-import materialize
  reproduces the operator's curated set.

### Risks & mitigations

| Research failure mode | Design decision that answers it |
|---|---|
| **Self-confirmation trap** (EDV): extractor grades its own trace | Harvest is a **separate reactor step**, not the building worker; it reads the *merged* record, and the operator — a third party — is the ratifier. The building agent never promotes its own lesson. |
| **False promotion from correlated traces** (GovMem: zero auto-safe on real traces) | **No auto-promotion in v1.** Every lesson crosses `item.approved`. `stepAutoApprove` is explicitly excluded (parkKind:'decision'). |
| **Unproven knowledge** (Voyager / SKILL.nb: admit only after execution) | Eligibility requires a **gate-proven merge** (`mergeGateCommand` present); the lesson carries the `gateCommand` + evidence excerpt as provenance. No candidate from an unmerged or gate-less item. |
| **Memory poisoning** (a bad line injected into every prompt) | Two gates before injection (strict-auditor reject + human approve) plus **provenance on every line** (`sourceWi`, gate evidence) so a bad lesson is traceable and retractable (`knowledge.expired{retracted}`). The ledger is the forge-proof source (ADR-014 principle). |
| **Staleness / drift** (Copilot: read-time validation + 28-day TTL) | Read-time **deterministic revalidation** of `verifyPath`/`verifyCommand` on every materialize beat + TTL fallback; a stale lesson auto-expires from the projection. |
| **Context bloat** (a hard 40-line prompt budget) | Budget is a **ranking cutoff**, not a ledger cap: rank by recency×usefulness, inject top `maxLines`, budget-evict the rest (recoverable next beat). |
| **Duplication / contradiction** | Deterministic `contentHash` dedup (clone of `promotedPairs`); a negating candidate is flagged in its park reason for the operator, never auto-merged. |
| **Silent producer failure** (the thing today's phantom watcher already is) | The harvest step is a first-class step with a `StepResult.detail`; provider-unavailable skips visibly (judge posture), and `playbook.materialized` records every projection change — no silent baseline mutation. |

## Consequences

**What this buys, once implemented.** The two memory layers would finally connect:
execution-proven knowledge would flow from the episodic ledger into the distilled baseline,
but only through the same proven → ratified → rebuildable discipline the plane already
applies to code. The playbook would stop being a hand-typed file nobody maintains and become
a projection with provenance on every line and an expiry on every stale one. The phantom
`# candidate:` watcher promised in `config.ts:584` would be replaced by a real, ledger-native
mechanism.

**What this does not buy, stated honestly.**
- **The operator becomes the throughput bottleneck for knowledge**, by design (GovMem). If
  nobody ratifies, the baseline stops growing — which is the correct failure (a
  stale-but-safe baseline), not a dangerous one. Decision-desk fatigue is a real cost; the
  strict-auditor's default-reject is what keeps candidate volume low enough to matter.
- **Usefulness ranking is a heuristic, not proof.** "How live is the touched surface" is a
  cheap ledger signal, not a measurement that a lesson actually helped a build. Binding a
  lesson to observed prompt-outcome lift is open work.
- **Read-time revalidation is accident-prevention, not adversarial-proof** — same honesty as
  ADR-014's break-glass timestamps: a `verifyPath` that still exists does not prove the
  lesson is still *true*, only that its anchor did not obviously rot.

**Rollback, as designed.** Each slice is additive and independently revertible.
`knowledge.enabled=false` (the default) would make every new step a no-op before it reads the
ledger, exactly as `portabilityPromotion.enabled=false` does; the materialize step writing
nothing leaves `.ai/loops/playbook.md` as whatever a human last committed. Removing the
`stepApplyVerbs` knowledge clause restores plain approve/reject. No rollback touches
dispatch's injection path, which is unchanged throughout.
