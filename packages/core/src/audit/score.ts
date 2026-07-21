/**
 * score.ts — Pure autonomy-tier scoring for `loopctl audit <target>`.
 *
 * Tiers are ORDERED and cumulative (each tier requires every check below it to also
 * pass) — a target can't skip straight to "actively building" without a readable ledger,
 * matching the onboarding sequence a target actually goes through. Pure formula, no LLM.
 */

import { AuditCheckResult } from './checks.js';

export type AutonomyTier = 0 | 1 | 2 | 3 | 4 | 5;

export interface AutonomyScore {
  tier: AutonomyTier;
  label: string;
  passed: number;
  total: number;
}

const TIER_LABELS: Record<AutonomyTier, string> = {
  0: 'Tier 0 — not onboarded',
  1: 'Tier 1 — ledger initialized',
  2: 'Tier 2 — automated dispatch armed',
  3: 'Tier 3 — budget-bounded',
  4: 'Tier 4 — actively building',
  5: 'Tier 5 — actively building & tracked',
};

export function scoreAutonomyTier(checks: AuditCheckResult[]): AutonomyScore {
  const byId = new Map(checks.map(c => [c.id, c.passed]));
  const has = (id: string): boolean => byId.get(id) === true;

  let tier: AutonomyTier = 0;
  if (has('ledger-present') && has('ledger-readable')) tier = 1;
  if (tier >= 1 && has('gates-configured')) tier = 2;
  if (tier >= 2 && has('budget-defined')) tier = 3;
  if (tier >= 3 && (has('recent-commits') || has('recent-events'))) tier = 4;
  if (tier >= 4 && has('recent-commits') && has('recent-events')) tier = 5;

  return {
    tier,
    label: TIER_LABELS[tier],
    passed: checks.filter(c => c.passed).length,
    total: checks.length,
  };
}
