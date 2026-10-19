import type { Finding, Source } from './contracts.js';

// Rubric points and count-based coverage are prototype policy, not calibrated probabilities.
export const RUBRIC = {
  baseline: 50,
  positiveReview: 8,
  negativeReview: -10,
  growth: 5,
  maxGrowth: 10,
  redFlag: -20,
  fullReviewCount: 5,
  fullNewsCount: 2,
  reviewWeight: 0.7,
  newsWeight: 0.3,
} as const;

// Every adverse kind is reported as a red flag; Phase 3 decides its effect on the band.
export const RED_FLAG_KINDS = [
  'litigation', 'fraud', 'insolvency', 'regulatory_action',
  'payment_distress', 'operational_distress', 'licence_issue', 'governance_issue', 'other_adverse',
] as const satisfies readonly Finding['kind'][];

// Only these kinds cost RUBRIC.redFlag points in the Phase 2 score (unchanged prototype rubric).
export const PENALISED_KINDS = ['litigation', 'fraud', 'insolvency', 'regulatory_action'] as const satisfies readonly Finding['kind'][];

// Kinds each agent may report. Reviews may report distress a customer saw directly,
// but not legal or regulatory events; anything else from that source is rejected.
export const ALLOWED_KINDS: Readonly<Record<Source, readonly Finding['kind'][]>> = {
  review: ['positive_review', 'negative_review', 'payment_distress', 'operational_distress', 'other_adverse'],
  news: ['growth', ...RED_FLAG_KINDS],
};
