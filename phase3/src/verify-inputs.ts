import { ADVERSE_KINDS, type AdverseKind, type Policy, type RedFlag, type UnstructuredResult } from './contracts.js';

const isAdverse = (kind: string): kind is AdverseKind => (ADVERSE_KINDS as readonly string[]).includes(kind);

// Protect the integration boundary: never silently remove an unsupported red flag.
export function verifyRedFlags(input: UnstructuredResult, policy: Policy): RedFlag[] {
  const evidence = new Map(input.evidence.map((item) => [item.id, item]));
  if (evidence.size !== input.evidence.length) throw new Error('Phase 2 contains duplicate evidence IDs.');
  if (input.evidence.some((item) => item.businessId !== input.businessId)) {
    throw new Error('Phase 2 contains evidence for another business.');
  }
  const flags = new Map<string, RedFlag>();
  // Derive adverse flags from both collections: an omitted redFlags entry cannot bypass policy.
  for (const finding of [...input.findings, ...input.redFlags]) {
    const { kind } = finding;
    if (!isAdverse(kind)) continue;
    const item = evidence.get(finding.evidenceId);
    if (!item || !item.text.includes(finding.quote)) {
      throw new Error(`Unsupported adverse finding citing ${finding.evidenceId}; rerun Phase 2 verification.`);
    }
    const base = policy.severity[kind];
    const severity = item.source === 'review' ? policy.reviewOnlySeverity[base] : base;
    flags.set(`${kind}:${finding.evidenceId}`, { ...finding, kind, severity });
  }
  return [...flags.values()];
}
