import { classify } from './classify.js';
import { policySchema, traditionalResultSchema, unstructuredResultSchema, type AssessmentResult, type RedFlag, type Severity } from './contracts.js';
import { verifyRedFlags } from './verify-inputs.js';

/**
 * Pure, deterministic Phase 3. No model calls, filesystem access or decisions.
 * The policy (weights, thresholds, severity table) is data: load it with loadPolicy().
 */
export function assessPhase3(phase1Input: unknown, phase2Input: unknown, policyInput: unknown): AssessmentResult {
  const traditional = traditionalResultSchema.parse(phase1Input);
  const unstructured = unstructuredResultSchema.parse(phase2Input);
  const policy = policySchema.parse(policyInput);
  if (traditional.businessId !== unstructured.businessId) throw new Error('Phase 1 and Phase 2 business IDs do not match.');
  const redFlags = verifyRedFlags(unstructured, policy);
  const warnings = [...unstructured.warnings];
  const dataGaps = [...traditional.missingFields.map((field) => `Missing financial information: ${field}`), ...unstructured.dataGaps];
  const effectiveWeight = traditional.score !== null && unstructured.score !== null
    ? policy.baseUnstructuredWeight * unstructured.confidence : 0;
  // Classify the reported score, rounded to two decimals, avoiding displayed-score/band disagreement.
  const composite = traditional.score === null ? null : Number((
    (1 - effectiveWeight) * traditional.score + effectiveWeight * (unstructured.score ?? 0)
  ).toFixed(2));
  const compositeBand = classify(composite, policy);
  const result: AssessmentResult = {
    schemaVersion: '1.0', businessId: traditional.businessId, businessName: unstructured.businessName, policy,
    traditionalScore: traditional.score, traditionalCoverage: traditional.coverage,
    unstructuredScore: unstructured.score, unstructuredConfidence: unstructured.confidence,
    phase2Provider: unstructured.provider, phase2Model: unstructured.model, phase2Status: unstructured.status,
    effectiveUnstructuredWeight: Number(effectiveWeight.toFixed(6)), compositeScore: composite,
    compositeBand, riskBand: compositeBand, reviewStatus: traditional.score === null ? 'Insufficient data' : 'Ready',
    overrides: [], redFlags, warnings, dataGaps, explanation: '',
  };
  if (traditional.score === null) {
    dataGaps.push('No traditional score is available; request financial information.');
  } else if (traditional.coverage < 1) {
    warnings.push('Traditional score uses incomplete financial information; analyst review is required.');
    result.reviewStatus = 'Manual review required';
  }
  if (unstructured.score === null) warnings.push('No alternative-data score; using the traditional score only.');
  if (unstructured.provider === 'mock') warnings.push('Phase 2 used mock extraction; this is a demonstration assessment.');
  if (unstructured.status === 'partial' || unstructured.agents.some((agent) => agent.status === 'failed')) {
    warnings.push('Phase 2 analysis is incomplete; review failures and rejected findings before deciding.');
    if (traditional.score !== null) result.reviewStatus = 'Manual review required';
  }
  // Severity comes from the policy's severity table, never from the model.
  const at = (severity: Severity) => redFlags.filter((flag) => flag.severity === severity);
  const kinds = (flags: RedFlag[]) => [...new Set(flags.map((flag) => flag.kind))].join(', ');
  const ids = (flags: RedFlag[]) => [...new Set(flags.map((flag) => flag.evidenceId))];
  const major = at('major');
  if (major.length) {
    if (result.riskBand === 'Low') result.riskBand = 'Medium';
    result.overrides.push({ rule: 'band_cap', evidenceIds: ids(major),
      reason: `Major red flag (${kinds(major)}): band cannot be safer than Medium; verify the source.` });
    result.reviewStatus = 'Manual review required';
  }
  const critical = at('critical');
  if (critical.length) {
    result.riskBand = null;
    result.reviewStatus = 'Manual review required';
    result.overrides.push({ rule: 'mandatory_review', evidenceIds: ids(critical),
      reason: `Critical red flag (${kinds(critical)}) requires manual review; no automatic final band.` });
  }
  const review = at('review');
  if (review.length) {
    result.reviewStatus = 'Manual review required';
    result.overrides.push({ rule: 'analyst_review', evidenceIds: ids(review),
      reason: `Unclassified adverse finding (${kinds(review)}): analyst must assess it; band unchanged.` });
  }
  const minor = at('minor');
  if (minor.length) warnings.push(`Minor red flag (${kinds(minor)}) cited in ${ids(minor).join(', ')}: noted, no band change.`);
  result.explanation = composite === null ? 'Insufficient financial data to calculate a composite score.' :
    `Composite ${composite} = ${(1 - effectiveWeight).toFixed(4)} × traditional ${traditional.score} + ` +
    `${effectiveWeight.toFixed(4)} × unstructured ${unstructured.score ?? 'unavailable (zero weight)'}. ` +
    `Composite band: ${compositeBand}. Final band: ${result.riskBand ?? 'withheld'}.`;
  result.explanation += ` Review status: ${result.reviewStatus}. The analyst makes the final decision.`;
  return result;
}
