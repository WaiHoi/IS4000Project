import type { Policy, RiskBand } from './contracts.js';

export function classify(score: number | null, policy: Policy): RiskBand | null {
  if (score === null) return null;
  return score >= policy.lowThreshold ? 'Low' : score >= policy.mediumThreshold ? 'Medium' : 'High';
}
