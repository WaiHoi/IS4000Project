import type { Evidence, Phase2Input } from '../contracts.js';

const injection = /ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s+prompt|<\/?system>|rate\s+.*low\s+risk/i;

export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\b[STFGM]\d{7}[A-Z]\b/gi, '[ID]')
    .replace(/(?:\+65[ -]?)?\b[89]\d{3}[ -]?\d{4}\b/g, '[PHONE]');
}

export function prepareEvidence(input: Phase2Input) {
  const evidence: Evidence[] = [];
  const excludedEvidence: { id: string; reason: string }[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const item of input.evidence) {
    let reason: string | undefined;
    if (item.businessId !== input.business.id) reason = 'Business ID does not match the applicant.';
    else if (injection.test(item.text)) reason = 'Possible prompt injection; quarantined.';
    // Exact duplicates do not add evidence weight or multiple penalties.
    const clean = redact(item.text);
    const key = `${item.source}:${clean.trim().toLowerCase()}`;
    if (!reason && seen.has(key)) reason = 'Duplicate source text; excluded from scoring and coverage.';
    if (reason) {
      excludedEvidence.push({ id: item.id, reason });
      warnings.push(`${item.id}: ${reason}`);
    } else {
      seen.add(key);
      evidence.push({ ...item, text: clean });
    }
  }
  // Do not send unredacted application claims to a provider.
  const business = { ...input.business, claims: (input.business.claims ?? []).map(redact) };
  return { business, evidence, excludedEvidence, warnings };
}
