import type { ExplainInput, Memo, MemoPolicy } from './contracts.js';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word list from the policy; a trailing * matches any word ending. Basic screening, not a
// complete protected-attribute detector.
function wordList(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  const parts = terms.map((term) => term.endsWith('*') ? `${escape(term.slice(0, -1))}\\w*` : escape(term));
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

/** Evidence IDs the memo must cite: policy overrides always; with a policy, also every required-kind finding and red flag. */
export function requiredCitations(input: ExplainInput, policy?: MemoPolicy | null): string[] {
  const required = new Set(input.assessment.overrides.flatMap((override) => override.evidenceIds));
  if (policy) {
    const kinds = new Set<string>(policy.requiredCitationKinds);
    for (const item of [...input.phase2.findings, ...(input.assessment.redFlags ?? [])]) {
      if (kinds.has(item.kind)) required.add(item.evidenceId);
    }
  }
  return [...required];
}

/**
 * Deterministic memo checks. Narrative rules come from the memo policy (policy/memo.json);
 * without a policy (older reports) only the structural checks run.
 */
export function verifyMemo(input: ExplainInput, memo: Memo, policy?: MemoPolicy | null): string[] {
  const issues: string[] = [];
  const assessment = input.assessment;
  if (memo.businessId !== assessment.businessId) issues.push('Memo business ID does not match.');
  for (const [field, value] of Object.entries({ traditional: assessment.traditionalScore,
    unstructured: assessment.unstructuredScore, composite: assessment.compositeScore })) {
    if (memo.scores[field as keyof Memo['scores']] !== value) issues.push(`Incorrect ${field} score.`);
  }
  if (memo.riskBand !== assessment.riskBand) issues.push('Incorrect final risk band.');
  if (memo.reviewStatus !== assessment.reviewStatus) issues.push('Incorrect review status.');
  const evidence = new Map(input.phase2.evidence.map((item) => [item.id, item]));
  for (const claim of memo.claims) {
    const source = evidence.get(claim.evidenceId);
    if (!source || !source.text.includes(claim.quote)) issues.push(`Invalid citation or quote: ${claim.evidenceId}.`);
  }
  if (policy) {
    // Numeric metrics belong only in validated structured fields. Source quotes can
    // contain numbers; the generated claim prose and limitations cannot introduce them.
    const forbidden = wordList(policy.forbiddenNarrativeTerms);
    const protectedTerms = wordList(policy.protectedTerms);
    for (const text of [...memo.claims.map((claim) => claim.text), ...memo.limitations]) {
      if ((policy.forbidDigitsInNarrative && /\d/.test(text)) || forbidden?.test(text)) {
        issues.push('Keep metrics, bands and decisions out of free-form narrative.');
      }
      if (protectedTerms?.test(text)) issues.push('Potential protected attribute in memo narrative.');
      if (/\[[^\]]+\]/.test(text)) issues.push('Citations must use structured evidenceId fields, not inline IDs.');
    }
  }
  // Policy evidence and adverse findings must not disappear from the memo.
  const overrideIds = new Set(assessment.overrides.flatMap((override) => override.evidenceIds));
  for (const evidenceId of requiredCitations(input, policy)) {
    if (!memo.claims.some((claim) => claim.evidenceId === evidenceId)) {
      issues.push(overrideIds.has(evidenceId) ? `Missing policy evidence citation: ${evidenceId}.`
        : `Missing citation for adverse or negative finding: ${evidenceId}.`);
    }
  }
  return [...new Set(issues)];
}

export function renderMemo(input: ExplainInput, memo: Memo | null): string {
  const a = input.assessment;
  const lines = [
    `Assessment: ${input.assessmentId}`,
    `Traditional score: ${a.traditionalScore ?? 'Unavailable'}. Unstructured score: ${a.unstructuredScore ?? 'Unavailable'}. Composite score: ${a.compositeScore ?? 'Unavailable'}.`,
    `Final risk band: ${a.riskBand ?? 'Withheld'}. Review status: ${a.reviewStatus}.`,
    ...a.overrides.map((override) => `Policy: ${override.reason} [${override.evidenceIds.join(', ')}]`),
  ];
  if (memo) lines.push(...memo.claims.map((claim) => `${claim.text} [${claim.evidenceId}]`), ...memo.limitations);
  else lines.push('A verified narrative could not be produced. Review the source evidence and validation warnings.');
  lines.push(...a.dataGaps.map((gap) => `Data gap: ${gap}`), 'The analyst makes the final credit decision.');
  return lines.join('\n');
}
