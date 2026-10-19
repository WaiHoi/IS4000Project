import { ALLOWED_KINDS } from '../config.js';
import type { Evidence, Finding, Source } from '../contracts.js';

export function verifySignals(findings: Finding[], evidence: Evidence[], source: Source) {
  const registry = new Map(evidence.map((item) => [item.id, item]));
  const accepted: Finding[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const item = registry.get(finding.evidenceId);
    const key = `${finding.kind}:${finding.evidenceId}`;
    if (!item || item.source !== source || !ALLOWED_KINDS[source].includes(finding.kind) ||
        !finding.quote.trim() || !item.text.includes(finding.quote)) {
      warnings.push(`Rejected unsupported ${finding.kind} finding citing ${finding.evidenceId}.`);
    } else if (!seen.has(key)) {
      seen.add(key);
      accepted.push(finding);
    }
  }
  return { findings: accepted, warnings };
}
