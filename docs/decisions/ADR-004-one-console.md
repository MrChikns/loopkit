# ADR-004 — One console shape; target-specific surfaces are extensions

**Status:** active

The console is a single codebase rendering the plane's fold — never a per-target
fork kept "in sync" by hand. New console features land here first. Surfaces that
belong to a specific target's product (its uptime probes, its business metrics)
do not enter the framework console; they are the target's own extensions. The
operational consequence: an operator gets exactly one shape everywhere, and the
console improves for every target at once.
