// Shared contract between Phase 2 (producer) and Phase 3 (consumer).
// Constants and types only, no runtime dependencies: each phase builds its own
// zod schemas from these lists, so one zod instance is never mixed with another.

export const FINDING_KINDS = [
  'positive_review', 'negative_review', 'growth',
  // Adverse kinds (red flags). Phase 3 maps each to a severity in phase3/policy/default.json.
  'litigation', 'fraud', 'insolvency', 'regulatory_action',
  'payment_distress', 'operational_distress', 'licence_issue', 'governance_issue', 'other_adverse',
] as const;

export const ADVERSE_KINDS = [
  'litigation', 'fraud', 'insolvency', 'regulatory_action',
  'payment_distress', 'operational_distress', 'licence_issue', 'governance_issue', 'other_adverse',
] as const satisfies readonly FindingKind[];

export type FindingKind = typeof FINDING_KINDS[number];
export type AdverseKind = typeof ADVERSE_KINDS[number];
export type Source = 'review' | 'news';
export type ProviderName = 'mock' | 'openrouter' | 'custom';

export type Evidence = {
  id: string;
  businessId: string;
  source: Source;
  text: string;
  publishedAt: string;
  url?: string;
};

export type Finding = {
  kind: FindingKind;
  summary: string;
  evidenceId: string;
  quote: string;
};

/** Which model and prompts produced a result, for audit and model comparison. */
export type ModelInfo = {
  id: string;
  // Short hash of both agents' instructions and model settings: changes whenever a prompt or setting changes.
  promptVersion: string;
  temperature: number;
  maxTokens: number;
};

export type AgentResult = {
  source: Source;
  status: 'completed' | 'skipped' | 'failed';
  inputCount: number;
  findings: Finding[];
  warnings: string[];
  error?: string;
};

export type Factor = {
  name: string;
  points: number;
  evidenceIds: string[];
};

/** Phase 2 scoring rubric (phase2/policy/rubric.json), recorded in every report. */
export type Phase2Rubric = {
  version: string;
  baseline: number;
  positiveReview: number;
  negativeReview: number;
  growth: number;
  maxGrowth: number;
  redFlag: number;
  // Red-flag kinds that cost redFlag points; all adverse kinds are still reported.
  penalisedKinds: AdverseKind[];
  fullReviewCount: number;
  fullNewsCount: number;
  reviewWeight: number;
  newsWeight: number;
};

/** The Phase 2 report: what Phase 2 writes and Phase 3 reads. */
export type Phase2Result = {
  schemaVersion: '1.0';
  businessId: string;
  businessName: string;
  provider: ProviderName;
  model: ModelInfo | null;
  rubric: Phase2Rubric;
  generatedAt: string;
  status: 'complete' | 'partial' | 'unavailable';
  score: number | null;
  confidence: number;
  coverage: { reviews: number; news: number; failedSources: Source[] };
  factors: Factor[];
  findings: Finding[];
  redFlags: Finding[];
  evidence: Evidence[];
  excludedEvidence: { id: string; reason: string }[];
  dataGaps: string[];
  warnings: string[];
  agents: AgentResult[];
};

// ---- Phase 3 assessment: what Phase 3 writes and explainability reads. ----

export const SEVERITIES = ['critical', 'major', 'review', 'minor'] as const;
export type Severity = typeof SEVERITIES[number];
export type RiskBand = 'Low' | 'Medium' | 'High';
export type ReviewStatus = 'Ready' | 'Manual review required' | 'Insufficient data';

/** Phase 3 policy (phase3/policy/default.json), recorded in every assessment. */
export type Phase3Policy = {
  version: string;
  baseUnstructuredWeight: number;
  mediumThreshold: number;
  lowThreshold: number;
  severity: Record<AdverseKind, Severity>;
  reviewOnlySeverity: Record<Severity, Severity>;
};

export type RedFlag = Finding & { kind: AdverseKind; severity: Severity };

export type Override = {
  rule: 'band_cap' | 'mandatory_review' | 'analyst_review';
  reason: string;
  evidenceIds: string[];
};

export type Phase3Assessment = {
  schemaVersion: '1.0';
  businessId: string;
  businessName: string;
  policy: Phase3Policy;
  traditionalScore: number | null;
  traditionalCoverage: number;
  unstructuredScore: number | null;
  unstructuredConfidence: number;
  phase2Provider: ProviderName;
  // Older Phase 2 reports may lack temperature/maxTokens, so only id and promptVersion are required.
  phase2Model: ({ id: string; promptVersion: string } & Record<string, unknown>) | null;
  phase2Status: Phase2Result['status'];
  effectiveUnstructuredWeight: number;
  compositeScore: number | null;
  compositeBand: RiskBand | null;
  riskBand: RiskBand | null;
  reviewStatus: ReviewStatus;
  overrides: Override[];
  redFlags: RedFlag[];
  warnings: string[];
  dataGaps: string[];
  explanation: string;
};
