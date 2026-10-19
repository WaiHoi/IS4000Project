import type { Evidence, Finding, Source } from '../contracts.js';

export function verifySignals(findings: Finding[], evidence: Evidence[], source: Source) {
  const registry = new Map(evidence.map((item) => [item.id, item]));
  const accepted: Finding[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const item = registry.get(finding.evidenceId);
    const reviewKind = ['positive_review', 'negative_review'].includes(finding.kind);
    const key = `${finding.kind}:${finding.evidenceId}`;
    if (!item || item.source !== source || reviewKind !== (source === 'review') ||
        !finding.quote.trim() || !item.text.includes(finding.quote)) {
      warnings.push(`Rejected unsupported ${finding.kind} finding citing ${finding.evidenceId}.`);
    } else if (!seen.has(key)) {
      seen.add(key);
      accepted.push(finding);
    }
  }
  return { findings: accepted, warnings };
}
