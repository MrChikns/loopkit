// Shared component prop fragments. The full projection/evidence data contract
// lands with the projection layer; these are the minimal shapes the
// first components need.

export type EvidenceRef = {
  id: string;
  label: string;
  href?: string;
};

export type EventAction = {
  id: string;
  label: string;
  emphasis?: 'default' | 'primary' | 'danger';
  /** Zero-JS action: render a one-button POST form with this intent text (the app's
   *  deterministic verb path). Without it the action renders as a data-attribute button
   *  for the client dispatcher — which not every page loads.
   *  `confirm` (run-controls hard-stop): when set,
   *  the form renders a `data-opsui-confirm` attribute that opsui-confirm.js intercepts —
   *  submission proceeds only after `window.confirm(confirm)` returns true. Progressive
   *  enhancement: without JS the form still submits directly (no confirm gate), so the
   *  action never silently breaks — callers that need a HARD gate should pair `confirm`
   *  with a human-reviewed server-side effect, never rely on it as the only safeguard. */
  form?: { action: string; intent: string; confirm?: string };
  /** Composer action: render a button that opens the global "drop intent" composer
   *  pre-filled with this text (via opsui-shell.js `composer-open` + `data-opsui-prefill`).
   *  Used where the verdict needs free-text detail the founder finishes typing — e.g. the
   *  acceptance desk's "Found a problem" → describe it → captured as a new repair item.
   *  Mutually exclusive with `form`; `form` takes precedence if both are set. */
  composer?: { prefill: string };
};

// Shell navigation contract. One destination the rail, bottom
// navigation, and command palette all render. Later the projection registry
// is the single source that emits these — the shell never defines
// destinations itself, it only renders the list it is handed.
export type NavDestination = {
  /** Stable id (a `ProjectionId` once the registry lands). */
  id: string;
  title: string;
  /** One-sentence operational purpose — shown in the expanded rail. */
  purpose: string;
  href: string;
  /** Pre-rendered inline SVG (the owned icon set). Falls back to an
   *  initial glyph when absent; the accessible label always comes from `title`. */
  icon?: string;
  /** Bottom-navigation ordering on mobile; null = palette-only. */
  mobilePriority?: number | null;
};

// Command-palette results, grouped by the entity kind they matched.
export type PaletteItem = {
  label: string;
  /** `data-opsui-action` payload, e.g. `projection:health` or `answer:ADR-042`. */
  action: string;
  meta?: string;
};

export type PaletteGroup = {
  heading: string;
  items: PaletteItem[];
};

export type Breadcrumb = {
  label: string;
  href?: string;
};
