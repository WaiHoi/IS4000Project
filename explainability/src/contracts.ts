import { z } from 'zod';
import {
  ADVERSE_KINDS, FINDING_KINDS, SEVERITIES, type Phase2Result, type Phase3Assessment,
} from '@credit-copilot/contracts';

const id = z.string().trim().min(1).max(200);
const score = z.number().min(0).max(100).nullable();
const band = z.enum(['Low', 'Medium', 'High']).nullable();
const reviewStatus = z.enum(['Ready', 'Manual review required', 'Insufficient data']);

// A versioned boundary projection of Phase 3's assessment (shared type in ../contracts).
export const assessmentSchema = z.object({
  schemaVersion: z.literal('1.0'), businessId: id, businessName: z.string().min(1),
  traditionalScore: score, unstructuredScore: score, compositeScore: score,
  riskBand: band, compositeBand: band, reviewStatus,
  effectiveUnstructuredWeight: z.number().min(0).max(1),
  warnings: z.array(z.string()), dataGaps: z.array(z.string()),
  overrides: z.array(z.object({ rule: z.string(), reason: z.string(), evidenceIds: z.array(id) })),
  // Optional (no default, so the assessment digest of older assessments is unchanged).
  // Severity is optional too: assessments from before the severity table have none.
  redFlags: z.array(z.object({ kind: z.enum(ADVERSE_KINDS), evidenceId: id, severity: z.enum(SEVERITIES).optional() }).passthrough()).optional(),
}).passthrough();

export const evidenceSchema = z.object({ id, businessId: id, source: z.enum(['review', 'news']), text: z.string().min(1) });
const phase2Schema = z.object({ businessId: id, evidence: z.array(evidenceSchema),
  findings: z.array(z.object({ kind: z.enum(FINDING_KINDS), summary: z.string(), evidenceId: id, quote: z.string().min(1) }).passthrough()),
}).passthrough();
export const explainInputSchema = z.object({
  assessmentId: id,
  assessment: assessmentSchema,
  phase2: phase2Schema,
}).strict();

// Compile-time checks: every assessment Phase 3 and every report Phase 2 can produce is accepted.
// If a shared type changes incompatibly, typecheck fails here.
const acceptsAssessment: (value: Phase3Assessment) => z.input<typeof assessmentSchema> = (value) => value;
const acceptsPhase2Report: (value: Phase2Result) => z.input<typeof phase2Schema> = (value) => value;
void acceptsAssessment; void acceptsPhase2Report;

// Memo policy is data (policy/memo.json), not code. Validated before any AI call.
export const memoPolicySchema = z.object({
  version: z.string().trim().min(1),
  maxRetries: z.number().int().min(0).max(5),
  // Every Phase 2 finding of these kinds must be cited by a memo claim, so bad news cannot be left out.
  requiredCitationKinds: z.array(z.enum(FINDING_KINDS)),
  forbidDigitsInNarrative: z.boolean(),
  forbiddenNarrativeTerms: z.array(z.string().trim().min(1)),
  // Whole words; a trailing * matches any ending (e.g. "pregnan*").
  protectedTerms: z.array(z.string().trim().min(1)),
}).strict();

export const memoSchema = z.object({
  businessId: id,
  scores: z.object({ traditional: score, unstructured: score, composite: score }).strict(),
  riskBand: band,
  reviewStatus,
  claims: z.array(z.object({ text: z.string().trim().min(1).max(2000), evidenceId: id,
    quote: z.string().trim().min(1).max(20000) }).strict()).max(100),
  limitations: z.array(z.string().trim().min(1).max(2000)).max(30),
}).strict();
export const critiqueSchema = z.object({ passed: z.boolean(), issues: z.array(z.string().min(1)) }).strict();
export type Memo = z.infer<typeof memoSchema>;
export type ExplainInput = z.infer<typeof explainInputSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type Critique = z.infer<typeof critiqueSchema>;
export type MemoPolicy = z.infer<typeof memoPolicySchema>;

/** Which models and prompts produced a memo, for audit and model comparison. */
export interface ExplainModelInfo {
  writer: string;
  critic: string;
  // Short hash of both agents' instructions and model settings.
  promptVersion: string;
}
export interface ExplanationProvider {
  name: 'mock' | 'openrouter' | 'custom';
  model?: ExplainModelInfo;
  generate(input: ExplainInput, feedback: string[], signal: AbortSignal): Promise<Memo>;
  critique(input: ExplainInput, memo: Memo, signal: AbortSignal): Promise<Critique>;
}
export interface Attempt {
  number: number;
  issues: string[];
  criticPassed: boolean;
  verificationPassed: boolean;
}
export interface ExplanationResult {
  schemaVersion: '1.0'; assessmentId: string; assessmentDigest: string; businessId: string;
  provider: ExplanationProvider['name']; model: ExplainModelInfo | null; policy: MemoPolicy | null;
  status: 'verified' | 'warning';
  assessment: Assessment; memo: Memo | null; renderedMemo: string;
  evidence: ExplainInput['phase2']['evidence']; attempts: Attempt[]; warnings: string[];
}

export const explanationResultSchema = z.object({
  schemaVersion: z.literal('1.0'), assessmentId: id, assessmentDigest: z.string().regex(/^[a-f0-9]{64}$/), businessId: id,
  provider: z.enum(['mock', 'openrouter', 'custom']),
  // Optional so explanation reports from before model/policy recording still load.
  model: z.object({ writer: z.string(), critic: z.string(), promptVersion: z.string() }).strict().nullable().default(null),
  policy: memoPolicySchema.nullable().default(null),
  status: z.enum(['verified', 'warning']),
  assessment: assessmentSchema, memo: memoSchema.nullable(), renderedMemo: z.string().min(1),
  evidence: z.array(evidenceSchema), warnings: z.array(z.string()),
  attempts: z.array(z.object({ number: z.number().int().positive(), issues: z.array(z.string()),
    criticPassed: z.boolean(), verificationPassed: z.boolean() })).min(1),
}).strict();
