import { explanationResultSchema, digest, verifyMemo, renderMemo, type ExplainInput } from '@credit-copilot/explainability';
import { decisionInputSchema } from './contracts.js';

export function prepareReview(rawExplanation: unknown, rawDecision: unknown) {
  const explanation = explanationResultSchema.parse(rawExplanation);
  const decision = decisionInputSchema.parse(rawDecision);
  if (new Set(explanation.evidence.map((item) => item.id)).size !== explanation.evidence.length) throw new Error('Duplicate evidence IDs.');
  if (explanation.businessId !== explanation.assessment.businessId ||
    explanation.evidence.some((item) => item.businessId !== explanation.businessId)) throw new Error('Business identity mismatch.');
  if (digest(explanation.assessment) !== explanation.assessmentDigest) throw new Error('Assessment digest mismatch; review the correct assessment version.');
  const input: ExplainInput = { assessmentId: explanation.assessmentId, assessment: explanation.assessment,
    phase2: { businessId: explanation.businessId, evidence: explanation.evidence, findings: [] } };
  if (explanation.status === 'verified') {
    const last = explanation.attempts.at(-1)!;
    if (!explanation.memo || !last.criticPassed || !last.verificationPassed || last.issues.length ||
      // Re-check with the memo policy recorded in the report (null for older reports: structural checks only).
      verifyMemo(input, explanation.memo, explanation.policy).length) throw new Error('Verified memo metadata or citations are inconsistent.');
  } else if (explanation.memo !== null) throw new Error('Warning reports must not expose an unverified memo.');
  if (renderMemo(input, explanation.memo) !== explanation.renderedMemo) throw new Error('Rendered memo does not match the validated report.');
  const needsAcknowledgement = explanation.status === 'warning' || explanation.provider === 'mock' ||
    explanation.warnings.length > 0 || explanation.assessment.warnings.length > 0 || explanation.assessment.reviewStatus !== 'Ready';
  if (needsAcknowledgement && !decision.acknowledgeWarnings) throw new Error('The analyst must acknowledge assessment and memo warnings.');
  return { explanation, decision };
}
