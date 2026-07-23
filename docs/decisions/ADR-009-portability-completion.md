# ADR-009 — Portability-note completion path: `loopctl portability` verb → `item.certification-amended` event

Status: accepted 2026-07-23 (operator-ratified; design red-teamed by architect review)

## Context

The portability-promotion flow (ADR-007-era harvest work, flag-gated behind
`portabilityPromotion.enabled`) nudges the operator with a `msg.out` asking which
targets a certified pattern applies to (`applies to: <targets> | none`), but the loop
is open: no event ever updates `mergeCertification.portability` from the operator's
reply, and `parsePortabilityTargets` is a naive comma split with no defined grammar.
A reply typed today lands in the general LLM reply-router and is most likely parked
as unparseable — it never becomes a certification amendment.

## Decision

Close the loop with the **verb-appends-an-event** pattern that governs every operator
write (`approve`→`item.approved`, `accept`→`item.accepted`): a thin deterministic
appender verb, backed by `amendPortability(...)` in `verbs.ts` so the console HTTP
write path shares it, appending a new event `item.certification-amended`. The fold
merges it into `mergeCertification.portability` last-writer-wins (free re-amendment
idempotency); `stepPortabilityPromotion` is unchanged — it already re-reads
`cert.portability` each beat, so the next reactor beat promotes.

Strict validation lives in **one parser**: `parsePortabilityTargets` becomes the
single validating parser returning `{ targets, none, errors }`; the verb rejects on
error (operator-facing `msg.out`), the reactor keeps its tolerant read. The fold never
validates and never throws.

**Rejected — event-only via the LLM reply-router:** puts a strict grammar behind a
non-deterministic classifier; the verb is the deterministic confirm path.
**Rejected — sniffing portability out of free-form `msg.in`:** a second reader of the
same data is the drift smell ADR-006 warns against.

## Event schema

```ts
export interface ItemCertificationAmendedData {
  /** Amendable certification field. Only 'portability' today; extensible by design. */
  field: 'portability';
  /** Canonical normalized note: `applies to: <a>, <b>` or `applies to: none`. */
  portability: string;
  /** Parsed target names (lower-cased canonical). Empty ⇒ none. */
  targets: string[];
  /** Actor stamp — 'operator' for CLI/console, bridge ids otherwise. */
  by: string;
  /** Dedup link to the msg.in trail (mirrors approve/reject). */
  inReplyTo?: string;
}
```

Example: `{"field":"portability","portability":"applies to: acme-web, acme-api","targets":["acme-web","acme-api"],"by":"operator"}`
— `none`: `{"portability":"applies to: none","targets":[]}`.

## Grammar (strict in the verb; `applies to:` marker optional on input, canonical on output)

```
reply       := WS? ("applies to:" WS?)? body WS?
body        := "none" | target-list
target-list := target (WS? "," WS? target)*
target      := [A-Za-z0-9._-]{1,64}        ; no spaces/slashes/commas inside a name
```

- Case-insensitive; names lower-cased for storage/comparison (match `targets.byName`
  behavior — verify before building; never accept a name the reactor can't resolve).
- `none` (alone, any case) ⇒ valid amendment with `targets:[]` — distinct from absent.
- Empty body ⇒ **error**, never silently `none`.
- Unknown (unregistered) target ⇒ **reject the whole amendment** with a `msg.out`
  listing unknown + registered names — interactive replies fail fast, unlike the
  reactor's tolerant batch read. All-or-nothing.
- Duplicates de-duplicated silently; self-target accepted (promotion already skips it).

## Verb

`loopctl portability <WI-NNN> "<reply body>" [--by <actor>] [--trail "<text>"]`
— precondition: item is `merged` or `accepted` (only shipped items have a
certification). On success append `[amendedEv, msgInTrail]` linked via `inReplyTo`;
on parse/unknown-target error append only the `msg.out` error and fail the verb.

## Fold semantics

New case, pure annotation (no `transition()`), fail-soft: unknown `field` or
non-string `portability` ⇒ ignored; missing prior certification ⇒ synthesize the
minimal shape with only `portability` set; last-writer-wins on re-amendment. The
nudge dedup keys on `cert.portability` being set, so any amendment (including
`none`) naturally silences it — no reactor edit.

## Required tests

Parser: happy path (marker present/absent), case-fold+trim, `none` both forms, empty
body error, malformed names (space/slash/overlong), dedup, back-compat with
merge-time lenient notes. Verb: happy path append pair + fold visibility, unknown
target rejects with no amendment event, malformed rejects, `none`, precondition
no-op on non-shipped items, re-amendment replay-determinism. Fold: no-cert
synthesis, malformed ignored, never throws. Reactor: end-to-end nudge → amend →
next beat promotes sibling on a registered target, nudge does not re-fire.
Fixtures use generic placeholder targets (`acme-web`), per the leak-scan rule.

## Files

`packages/core/src/schema.ts` (event interface + `EventDataMap` + `KNOWN_TYPES`;
rewrite `parsePortabilityTargets`), `packages/core/src/fold.ts` (new case),
`packages/core/src/verbs.ts` (`amendPortability`), `packages/core/src/cli.ts`
(`cmdPortability` + dispatch + help), `packages/core/src/beats/reactor.ts` (parser
call-site signature only; optionally name the verb in the nudge text), tests per
suite, `docs/event-model.md` + `docs/method.md` harvest paragraph.
