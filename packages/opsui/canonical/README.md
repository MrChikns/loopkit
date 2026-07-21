# Canonical design-system package

Contents:

- `canonical/tokens.css` — canonical visual tokens.
- `canonical/semantic-states.json` — machine-readable operational state meanings and precedence.
- `canonical/projection-registry.example.json` — example of the one registry that should drive routes, navigation, command palette, and projection metadata.
- `canonical/component-registry.example.json` — example of the one registry for schema-driven component rendering and allowed actions.

Reproduce the visual language through the shared `@loopkit/opsui` package rather than hand-rolling per-page markup.
