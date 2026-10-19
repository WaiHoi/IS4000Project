import { z } from 'zod';
import { ADVERSE_KINDS, FINDING_KINDS, type Evidence, type Finding, type ModelInfo, type Phase2Rubric, type ProviderName, type Source } from '@credit-copilot/contracts';

// Kinds and report types shared with Phase 3 live in ../contracts. Re-exported so
// Phase 2 modules and consumers keep importing from here.
export { FINDING_KINDS, ADVERSE_KINDS } from '@credit-copilot/contracts';
export type {
  AdverseKind, AgentResult, Evidence, Factor, Finding, FindingKind, ModelInfo, Phase2Result, Phase2Rubric, ProviderName, Source,
} from '@credit-copilot/contracts';

// Scoring rubric is data (policy/rubric.json), not code. Validated before any scoring.
const points = z.number().finite();
const count = z.number().int().min(1);
const weight = z.number().min(0).max(1);
export const rubricSchema = z.object({
  version: z.string().trim().min(1),
  baseline: points, positiveReview: points, negativeReview: points,
  growth: points, maxGrowth: points, redFlag: points,
  penalisedKinds: z.array(z.enum(ADVERSE_KINDS)),
  fullReviewCount: count, fullNewsCount: count,
  reviewWeight: weight, newsWeight: weight,
}).strict().refine((value) => Math.abs(value.reviewWeight + value.newsWeight - 1) < 1e-9, {
  message: 'reviewWeight and newsWeight must add up to 1.',
});

// Input is validated by intake (schema, consent, unique evidence IDs) before Phase 2.
// Phase 2 trusts these shapes and only screens content (see processing/prepare-evidence.ts).
export interface Business {
  id: string;
  name: string;
  claims?: string[];
}

export interface Phase2Input {
  business: Business;
  evidence: Evidence[];
}

// Model output is untrusted, so it is still schema-checked.
const id = z.string().trim().min(1).max(200);
export const findingSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  summary: z.string().trim().min(1).max(1000),
  evidenceId: id,
  quote: z.string().trim().min(1).max(20000),
}).strict();

// Compile-time check: the schema produces exactly the shared Finding type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const findingMatchesContract: Same<z.infer<typeof findingSchema>, Finding> = true;
const rubricMatchesContract: Same<z.infer<typeof rubricSchema>, Phase2Rubric> = true;
void findingMatchesContract; void rubricMatchesContract;

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
export type AgentOutput = z.infer<typeof agentOutputSchema>;

export interface AgentRequest {
  source: Source;
  business: Business;
  evidence: Evidence[];
  signal: AbortSignal;
}

export interface AnalysisProvider {
  name: ProviderName;
  model?: ModelInfo;
  analyse(request: AgentRequest): Promise<AgentOutput>;
}
