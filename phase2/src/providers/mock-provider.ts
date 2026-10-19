import type { AnalysisProvider, Finding } from '../contracts.js';

// Offline smoke-test provider, not an AI model. It reads the supplied records;
// there are no business-specific outputs or embedded evidence fixtures here.
export const mockProvider: AnalysisProvider = {
  name: 'mock',
  async analyse({ source, evidence }) {
    const rules: { kind: Finding['kind']; pattern: RegExp; summary: string }[] = source === 'review' ? [
      { kind: 'positive_review', pattern: /excellent|great service|highly recommend/i, summary: 'Positive customer feedback' },
      { kind: 'negative_review', pattern: /poor service|never arrived|not delivered/i, summary: 'Negative customer feedback' },
    ] : [
      { kind: 'growth', pattern: /second outlet|new branch|major contract/i, summary: 'Growth event reported' },
      { kind: 'litigation', pattern: /lawsuit|court proceedings/i, summary: 'Litigation reported; verify the source' },
      { kind: 'fraud', pattern: /fraud|scam/i, summary: 'Fraud allegation reported; verify the source' },
      { kind: 'insolvency', pattern: /insolvency|liquidation/i, summary: 'Insolvency reported; verify the source' },
      { kind: 'regulatory_action', pattern: /regulatory action|licence suspended/i, summary: 'Regulatory action reported; verify the source' },
    ];
    const findings: Finding[] = [];
    for (const item of evidence) {
      for (const rule of rules) {
        if (rule.pattern.test(item.text)) findings.push({
          kind: rule.kind, summary: rule.summary, evidenceId: item.id, quote: item.text,
        });
      }
    }
    return { findings };
  },
};
