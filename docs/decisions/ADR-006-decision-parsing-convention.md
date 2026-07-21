# ADR-006 — Decision-source parsing is a convention, not a plugin interface

**Status:** active

The console's Knowledge page renders `kind: "decision-log"` sources into decision
cards by recognizing a small set of documented markdown shapes — an id-carrying
heading (`## PREFIX-NNN — Title`, or a date-headed variant with a `**ID:**`
metadata line), an optional `Status:` line, an optional date. WI-058 extended the
same parser to cover one-decision-per-file (ADR-style) directories, wired via a
glob `path` in a source object, with the id token generalized from `D-NNN` to any
uppercase-led `PREFIX-NNN`.

There is deliberately no pluggable-parser API here — no registration hook, no
per-repo custom parser, no config field selecting a parser implementation. An
operator whose decisions are already written in one of the documented shapes
points a source at them and gets cards; an operator whose format doesn't match
keeps a plain `"markdown"` card instead.

**Why a convention instead of a plugin interface:** a plugin API is a durable
public contract — once shipped, loopkit owes every adopter backward compatibility
on parser registration, versioning, and failure semantics across parser
implementations it doesn't control. Loopkit doesn't need that yet; it has one
proven shape (a single append-only log) and one adjacent shape (per-file ADRs)
that both fit a single small parser. A second parser per operator — bespoke code
reading someone else's decision format — is exactly the kind of local workaround
that makes an event-sourced view rot: a second reader of the same underlying
"what did we decide and why" data, drifting from the first as each is patched
independently.

The convention is intentionally narrow but documented plainly
([`docs/knowledge.md`](../knowledge.md) §"The decision-log convention") so an
operator can tell at a glance whether their format fits, and reshape their log to
fit it if it's close. This is cheaper for everyone than a plugin surface: no API
to learn, no version to pin, just a markdown shape to match.

**Revisit only if** a real adopter's decision-record format genuinely can't be
expressed in either documented shape (not "prefers different formatting" —
"structurally can't be parsed without new rules"), and the gap recurs across more
than one adopter. At that point the honest move is probably a third documented
shape, not a plugin API — keep raising the bar before introducing a durable
contract.
