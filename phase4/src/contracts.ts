import { z } from 'zod';
import type { ExplanationResult } from '@credit-copilot/explainability';

export const decisionInputSchema = z.object({
  submissionId: z.string().trim().min(1).max(200),
  analystId: z.string().trim().min(1).max(200),
  action: z.enum(['approve', 'decline', 'request_information']),
  reason: z.string().trim().min(1).max(5000),
  override: z.boolean().default(false),
  overrideReason: z.string().trim().max(5000).optional(),
  acknowledgeWarnings: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.override && !value.overrideReason) ctx.addIssue({ code: 'custom', message: 'An override requires an overrideReason and explicit final action.' });
  if (!value.override && value.overrideReason) ctx.addIssue({ code: 'custom', message: 'Set override=true when providing an overrideReason.' });
});
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export interface DecisionRecord {
  id: string; recordedAt: string; assessmentId: string; businessId: string;
  assessmentDigest: string; inputDigest: string;
  decision: DecisionInput;
  aiAssessment: ExplanationResult;
}
