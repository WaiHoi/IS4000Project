import { z } from 'zod';
import {
  ADVERSE_KINDS, FINDING_KINDS, SEVERITIES, type Phase2Result, type Phase3Assessment, type Phase3Policy,
} from '@credit-copilot/contracts';

const id = z.string().trim().min(1);
const score = z.number().min(0).max(100).nullable();
export const traditionalResultSchema = z.object({
  businessId: id,
  score,
  coverage: z.number().min(0).max(1),
  missingFields: z.array(z.string()).default([]),
}).passthrough().superRefine((value, ctx) => {
  if ((value.score === null) !== (value.coverage === 0)) {
    ctx.addIssue({ code: 'custom', message: 'An unavailable traditional score must have zero coverage; an available score must have positive coverage.' });
  }
});

// Finding kinds, the Phase 2 report and the Phase 3 assessment types are shared via ../contracts.
export { ADVERSE_KINDS, SEVERITIES } from '@credit-copilot/contracts';
export type { AdverseKind, Severity, RiskBand, Override, RedFlag } from '@credit-copilot/contracts';

const findingSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  summary: z.string().min(1), evidenceId: id, quote: z.string().trim().min(1),
});
export const unstructuredResultSchema = z.object({
  schemaVersion: z.literal('1.0'),
  businessId: id,
  businessName: z.string().min(1),
  provider: z.enum(['mock', 'openrouter', 'custom']),
  // Optional so older Phase 2 reports without model information still load.
  model: z.object({ id: z.string(), promptVersion: z.string() }).passthrough().nullable().default(null),
  status: z.enum(['complete', 'partial', 'unavailable']),
  score,
  confidence: z.number().min(0).max(1),
  findings: z.array(findingSchema),
  redFlags: z.array(findingSchema),
  evidence: z.array(z.object({
    id, businessId: id, source: z.enum(['review', 'news']), text: z.string().min(1),
  }).passthrough()),
  warnings: z.array(z.string()),
  dataGaps: z.array(z.string()),
  agents: z.array(z.object({ source: z.enum(['review', 'news']),
    status: z.enum(['completed', 'skipped', 'failed']) }).passthrough()),
}).passthrough().superRefine((value, ctx) => {
  if (value.status === 'unavailable' && (value.score !== null || value.confidence !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'Unavailable Phase 2 results must have null score and zero confidence.' });
  }
  if (value.status !== 'unavailable' && (value.score === null || value.confidence === 0)) {
    ctx.addIssue({ code: 'custom', message: 'Available Phase 2 results require a score and positive confidence.' });
  }
});

// Compile-time check: every report Phase 2 can produce is accepted by this schema.
// If the shared Phase2Result changes incompatibly, typecheck fails here.
const acceptsPhase2Report: (report: Phase2Result) => z.input<typeof unstructuredResultSchema> = (report) => report;
void acceptsPhase2Report;

// Policy is data (policy/default.json), not code. Records keyed by an enum must list
// every kind: a missing or misspelt red-flag kind rejects the whole policy.
const severity = z.enum(SEVERITIES);
export const policySchema = z.object({
  version: z.string().trim().min(1),
  baseUnstructuredWeight: z.number().min(0).max(1),
  mediumThreshold: z.number().min(0).max(100),
  lowThreshold: z.number().min(0).max(100),
  // critical: no band + manual review; major: cap at Medium + manual review;
  // review: manual review, band unchanged; minor: warning only.
  severity: z.record(z.enum(ADVERSE_KINDS), severity),
  // Severity used instead when a flag is supported only by customer reviews.
  reviewOnlySeverity: z.record(severity, severity),
}).strict().refine((value) => value.mediumThreshold < value.lowThreshold, {
  message: 'Medium threshold must be below Low threshold.',
});

export type TraditionalResult = z.infer<typeof traditionalResultSchema>;
export type UnstructuredResult = z.infer<typeof unstructuredResultSchema>;
export type Policy = z.infer<typeof policySchema>;
// The assessment shape is the shared contract read by explainability.
export type AssessmentResult = Phase3Assessment;

// Compile-time check: the policy file schema produces exactly the shared policy type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const policyMatchesContract: Same<Policy, Phase3Policy> = true;
void policyMatchesContract;
