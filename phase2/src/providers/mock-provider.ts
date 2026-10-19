import type { AnalysisProvider, Finding } from '../contracts.js';

// Offline smoke-test provider, not an AI model. It reads the supplied records;
// there are no business-specific outputs or embedded evidence fixtures here.
export const mockProvider: AnalysisProvider = {
  name: 'mock',
  async analyse({ source, evidence }) {
    const rules: { kind: Finding['kind']; pattern: RegExp; summary: string }[] = source === 'review' ? [
      { kind: 'positive_review', pattern: /excellent|great service|highly recommend/i, summary: 'Positive customer feedback' },
      { kind: 'negative_review', pattern: /poor service|never arrived|not delivered/i, summary: 'Negative customer feedback' },
      { kind: 'payment_distress', pattern: /refund (was )?never|deposit (is )?gone/i, summary: 'Customer reports unpaid refund or deposit' },
      { kind: 'operational_distress', pattern: /closed (down|suddenly)/i, summary: 'Customer reports sudden closure' },
    ] : [
      { kind: 'growth', pattern: /second outlet|new branch|major contract/i, summary: 'Growth event reported' },
      { kind: 'litigation', pattern: /lawsuit|court proceedings/i, summary: 'Litigation reported; verify the source' },
      { kind: 'fraud', pattern: /fraud|scam/i, summary: 'Fraud allegation reported; verify the source' },
      { kind: 'insolvency', pattern: /insolvency|liquidation/i, summary: 'Insolvency reported; verify the source' },
      { kind: 'regulatory_action', pattern: /regulatory action|enforcement action/i, summary: 'Regulatory action reported; verify the source' },
      { kind: 'payment_distress', pattern: /unpaid (wages|suppliers|staff)|bounced cheque/i, summary: 'Payment distress reported; verify the source' },
      { kind: 'operational_distress', pattern: /retrench|ceased operations|closing down/i, summary: 'Operational distress reported; verify the source' },
      { kind: 'licence_issue', pattern: /licence (suspended|revoked|lapsed)/i, summary: 'Licence issue reported; verify the source' },
      { kind: 'governance_issue', pattern: /director (resigned|disqualified)/i, summary: 'Governance issue reported; verify the source' },
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
