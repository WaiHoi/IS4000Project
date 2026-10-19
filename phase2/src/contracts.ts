import { z } from 'zod';

// Input is validated by intake (schema, consent, unique evidence IDs) before Phase 2.
// Phase 2 trusts these shapes and only screens content (see processing/prepare-evidence.ts).
export type Source = 'review' | 'news';

export interface Business {
  id: string;
  name: string;
  claims?: string[];
}

export interface Evidence {
  id: string;
  businessId: string;
  source: Source;
  text: string;
  publishedAt: string;
  url?: string;
}

export interface Phase2Input {
  business: Business;
  evidence: Evidence[];
}

// Model output is untrusted, so it is still schema-checked.
const id = z.string().trim().min(1).max(200);
export const findingSchema = z.object({
  kind: z.enum(['positive_review', 'negative_review', 'growth', 'litigation', 'fraud', 'insolvency', 'regulatory_action']),
  summary: z.string().trim().min(1).max(1000),
  evidenceId: id,
  quote: z.string().trim().min(1).max(20000),
}).strict();

// Strict check applied in code to whatever the model returns.
export const agentOutputSchema = z.object({ findings: z.array(findingSchema).max(500) }).strict();

// Schema sent to the model. No length or size bounds: Gemini rejects schemas with
// large maxLength/maxItems as "too many states". No optional fields, for structured-output compatibility.
export const modelOutputSchema = z.object({
  findings: z.array(z.object({
    kind: findingSchema.shape.kind,
    summary: z.string(),
    evidenceId: z.string(),
    quote: z.string(),
  }).strict()),
}).strict();
export type Finding = z.infer<typeof findingSchema>;
export type AgentOutput = z.infer<typeof agentOutputSchema>;
export type ProviderName = 'mock' | 'openrouter' | 'custom';

export interface AgentRequest {
  source: Source;
  business: Business;
  evidence: Evidence[];
  signal: AbortSignal;
}

export interface AnalysisProvider {
  name: ProviderName;
  analyse(request: AgentRequest): Promise<AgentOutput>;
}

export interface AgentResult {
  source: Source;
  status: 'completed' | 'skipped' | 'failed';
  inputCount: number;
  findings: Finding[];
  warnings: string[];
  error?: string;
}

export interface Factor {
  name: string;
  points: number;
  evidenceIds: string[];
}

export interface Phase2Result {
  schemaVersion: '1.0';
  businessId: string;
  businessName: string;
  provider: ProviderName;
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
}
