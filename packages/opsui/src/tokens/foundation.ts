// Foundation tokens.
// Values without product meaning. Theme-invariant. Components must never
// consume raw palette values directly; they go through the semantic layer.

export const typography = {
  fontSans:
    'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontMono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
} as const;

// One spacing scale only. Values in CSS pixels.
export const space = {
  0: 0,
  1: 4,
  2: 6,
  3: 8,
  4: 10,
  5: 12,
  6: 14,
  7: 16,
  8: 18,
  9: 24,
  10: 32,
} as const;

export type SpaceStep = keyof typeof space;

export const radii = {
  card: '14px',
  control: '9px',
} as const;

export const railWidths = {
  compact: '76px',
  expanded: '278px',
} as const;

// Motion communicates relationship, never decoration.
export const motion = {
  fast: '120ms',
  standard: '180ms',
  deliberate: '240ms',
  easing: 'cubic-bezier(.2,.8,.2,1)',
} as const;
