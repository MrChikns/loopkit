// Component tokens — intentional component choices, expressed via
// foundation values. A component may consume these and semantic tokens only;
// it must never embed arbitrary values.

import { radii, railWidths, space } from './foundation.ts';

export const componentTokens = {
  card: {
    radius: radii.card,
    padding: {
      compact: `${space[5]}px`, // 12
      default: `${space[7]}px`, // 16
    },
  },
  status: {
    height: '22px',
    radius: '999px',
  },
  rail: {
    compactWidth: railWidths.compact,
    expandedWidth: railWidths.expanded,
  },
  metric: {
    minHeight: '104px',
  },
  composer: {
    minHeight: '96px',
  },
} as const;
