// Semantic tokens — meaning, per theme. The single typed source for the generated CSS variables
// (see ./css.ts). Values are preserved from the canonical visual prototype
// (canonical/tokens.css) and only change here, deliberately.

export type ThemeName = 'dark' | 'light';

// Base semantic surface/text/accent tokens, emitted in this order.
export const BASE_COLOR_KEYS = [
  'bg',
  'surface',
  'surface-2',
  'sunken',
  'overlay',
  'line',
  'line-strong',
  'text',
  'text-2',
  'text-3',
  'inverse',
  'accent',
  'accent-hover',
  'accent-soft',
] as const;

export type BaseColorKey = (typeof BASE_COLOR_KEYS)[number];

// Operational states, emitted in this order (distinct from precedence order,
// see ../states/state-precedence.ts). Each contributes fg/bg/border/tab vars.
export const STATE_EMISSION_ORDER = [
  'success',
  'warning',
  'critical',
  'info',
  'progress',
  'neutral',
] as const;

export const STATE_FACETS = ['fg', 'bg', 'border', 'tab'] as const;
export type StateFacet = (typeof STATE_FACETS)[number];

type BaseColors = Record<BaseColorKey, string>;
type StateColors = Record<
  (typeof STATE_EMISSION_ORDER)[number],
  Record<StateFacet, string>
>;

export type ThemeTokens = {
  colorScheme: ThemeName;
  base: BaseColors;
  state: StateColors;
  shadow: string;
};

export const darkTheme: ThemeTokens = {
  colorScheme: 'dark',
  base: {
    bg: '#090c11',
    surface: '#10151c',
    'surface-2': '#151c25',
    sunken: '#0c1117',
    overlay: 'rgba(4, 7, 11, 0.76)',
    line: '#25303d',
    'line-strong': '#3b4858',
    text: '#f4f7fb',
    'text-2': '#aab6c5',
    'text-3': '#7e8b9c',
    inverse: '#071019',
    accent: '#78a9ff',
    'accent-hover': '#94bbff',
    'accent-soft': '#172640',
  },
  state: {
    success: { fg: '#79e2a5', bg: '#10271c', border: '#286b45', tab: '#79e2a5' },
    warning: { fg: '#ffd078', bg: '#2b210e', border: '#806222', tab: '#ffd078' },
    critical: { fg: '#ff9a9a', bg: '#321619', border: '#913b43', tab: '#ff9a9a' },
    info: { fg: '#8fc7ff', bg: '#11253a', border: '#2d689a', tab: '#8fc7ff' },
    progress: { fg: '#8de2f2', bg: '#10272d', border: '#2d7180', tab: '#8de2f2' },
    neutral: { fg: '#c1cad6', bg: '#1a212b', border: '#465363', tab: '#c1cad6' },
  },
  shadow: '0 16px 42px rgba(0, 0, 0, 0.28)',
};

export const lightTheme: ThemeTokens = {
  colorScheme: 'light',
  base: {
    bg: '#edf1f5',
    surface: '#ffffff',
    'surface-2': '#f7f9fb',
    sunken: '#f1f4f7',
    overlay: 'rgba(245, 248, 251, 0.84)',
    line: '#d5dde6',
    'line-strong': '#aebbc9',
    text: '#17202b',
    'text-2': '#536174',
    'text-3': '#718094',
    inverse: '#ffffff',
    accent: '#155eef',
    'accent-hover': '#004ee8',
    'accent-soft': '#e8f0ff',
  },
  state: {
    success: { fg: '#146c3a', bg: '#eaf8ef', border: '#78c596', tab: '#8ed3aa' },
    warning: { fg: '#7a4d00', bg: '#fff5d8', border: '#ddb353', tab: '#efca70' },
    critical: { fg: '#a51d2d', bg: '#fff0f1', border: '#e68b94', tab: '#eea0a8' },
    info: { fg: '#145b9d', bg: '#edf6ff', border: '#87bce9', tab: '#9cc9ee' },
    progress: { fg: '#0b6373', bg: '#e9f8fb', border: '#7bc5d1', tab: '#91d3dc' },
    neutral: { fg: '#4c596a', bg: '#f1f4f7', border: '#b9c4cf', tab: '#c8d1da' },
  },
  shadow: '0 12px 34px rgba(28, 43, 61, 0.10)',
};

export const themes: Record<ThemeName, ThemeTokens> = {
  dark: darkTheme,
  light: lightTheme,
};
