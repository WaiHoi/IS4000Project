import { ADVERSE_KINDS, type Finding, type Source } from './contracts.js';

// Scoring weights are data, not code: see policy/rubric.json (loaded with loadRubric).

// Every adverse kind (shared with Phase 3) is reported as a red flag; Phase 3 decides its effect on the band.
export const RED_FLAG_KINDS = ADVERSE_KINDS;

// Kinds each agent may report. Reviews may report distress a customer saw directly,
// but not legal or regulatory events; anything else from that source is rejected.
// A guardrail that shapes the agent prompts, so it stays in code rather than policy.
export const ALLOWED_KINDS: Readonly<Record<Source, readonly Finding['kind'][]>> = {
  review: ['positive_review', 'negative_review', 'payment_distress', 'operational_distress', 'other_adverse'],
  news: ['growth', ...RED_FLAG_KINDS],
};
