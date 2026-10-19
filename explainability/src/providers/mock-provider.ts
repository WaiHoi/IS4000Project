import type { ExplanationProvider } from '../contracts.js';

export const mockProvider: ExplanationProvider = {
  name: 'mock',
  async generate(input) {
    const a = input.assessment;
    // Use source text as a quote; the narrative deliberately avoids invented facts.
    const claims = input.phase2.findings.map((finding) => ({
      text: 'The supplied source contains a business signal requiring analyst interpretation.',
      evidenceId: finding.evidenceId, quote: finding.quote,
    }));
    const mustCite = [...a.overrides.flatMap((override) => override.evidenceIds), ...(a.redFlags ?? []).map((flag) => flag.evidenceId)];
    for (const evidenceId of mustCite) {
      if (!claims.some((claim) => claim.evidenceId === evidenceId)) {
        const evidence = input.phase2.evidence.find((item) => item.id === evidenceId);
        if (evidence) claims.push({ text: 'A cited business event requires analyst verification.', evidenceId, quote: evidence.text });
      }
    }
    return { businessId: a.businessId, scores: { traditional: a.traditionalScore,
      unstructured: a.unstructuredScore, composite: a.compositeScore }, riskBand: a.riskBand,
      reviewStatus: a.reviewStatus, claims,
      limitations: ['Offline template only; no AI interpretation was performed.'] };
  },
  async critique() { return { passed: true, issues: [] }; },
};
