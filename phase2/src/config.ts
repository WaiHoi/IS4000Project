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

export const RED_FLAG_KINDS = ['litigation', 'fraud', 'insolvency', 'regulatory_action'] as const;
