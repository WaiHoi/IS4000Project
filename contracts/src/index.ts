// Shared contract between Phase 2 (producer) and Phase 3 (consumer).
// Constants and types only, no runtime dependencies: each phase builds its own
// zod schemas from these lists, so one zod instance is never mixed with another.

export const FINDING_KINDS = [
  'positive_review', 'negative_review', 'growth',
  // Adverse kinds (red flags). Phase 3 maps each to a severity in phase3/src/config.ts.
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

/** The Phase 2 report: what Phase 2 writes and Phase 3 reads. */
export type Phase2Result = {
  schemaVersion: '1.0';
  businessId: string;
  businessName: string;
  provider: ProviderName;
  model: ModelInfo | null;
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
