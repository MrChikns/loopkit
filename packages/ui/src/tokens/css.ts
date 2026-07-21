// Runtime CSS-variable generation: TypeScript is the authored
// source, generated CSS variables are the runtime output.
//
// `generateTokensCss()` reproduces `canonical/tokens.css` byte-for-byte from the
// typed token source. The equality is locked by a test, so the approved visual
// language cannot drift from the TS source without a deliberate, reviewed change.

import { radii, railWidths, typography } from './foundation.ts';
import {
  BASE_COLOR_KEYS,
  STATE_EMISSION_ORDER,
  STATE_FACETS,
  themes,
  type ThemeTokens,
} from './semantic.ts';

const HEADER =
  '/* Generated runtime tokens. Author these from one typed token source in the real package. */';

function line(name: string, value: string): string {
  return `  --${name}: ${value};`;
}

function baseLines(theme: ThemeTokens): string[] {
  return BASE_COLOR_KEYS.map((key) => line(key, theme.base[key]));
}

function stateLines(theme: ThemeTokens): string[] {
  const out: string[] = [];
  for (const state of STATE_EMISSION_ORDER) {
    for (const facet of STATE_FACETS) {
      out.push(line(`${state}-${facet}`, theme.state[state][facet]));
    }
  }
  return out;
}

/** The full runtime stylesheet: dark `:root` plus the light theme override. */
export function generateTokensCss(): string {
  const dark = themes.dark;
  const light = themes.light;

  const root = [
    ':root {',
    '  color-scheme: dark;',
    line('font-sans', typography.fontSans),
    line('font-mono', typography.fontMono),
    ...baseLines(dark),
    ...stateLines(dark),
    line('shadow', dark.shadow),
    line('r-card', radii.card),
    line('r-control', radii.control),
    line('rail-compact-width', railWidths.compact),
    line('rail-expanded-width', railWidths.expanded),
    '}',
  ];

  const lightBlock = [
    'html[data-theme="light"] {',
    '  color-scheme: light;',
    ...baseLines(light),
    ...stateLines(light),
    line('shadow', light.shadow),
    '}',
  ];

  return `${HEADER}\n${root.join('\n')}\n\n${lightBlock.join('\n')}\n`;
}
