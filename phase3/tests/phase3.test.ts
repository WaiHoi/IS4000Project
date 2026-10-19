import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessPhase3, loadCase, loadPolicy } from '../src/index.js';

// Policy is data: tests use the shipped policy/default.json unless a test overrides it.
const POLICY = await loadPolicy();
const assess = (phase1: unknown, phase2: unknown, policy: unknown = POLICY) => assessPhase3(phase1, phase2, policy);

async function healthy() {
  const input = await loadCase('healthy-business');
  return { phase1: input.phase1 as any, phase2: input.phase2 as any };
}

test('full coverage blend is 70/30 and does not mutate the inputs', async () => {
  const input = await healthy();
  const before = JSON.stringify(input);
  const result = assess(input.phase1, input.phase2);
  assert.equal(result.compositeScore, 79.9);
  assert.equal(result.effectiveUnstructuredWeight, 0.3);
  assert.equal(result.riskBand, 'Low');
  assert.equal(result.reviewStatus, 'Ready');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result, assess(input.phase1, input.phase2));
});

test('no online presence falls back without a risk penalty', async () => {
  const { phase1, phase2 } = await healthy();
  // An unavailable Phase 2 result: no evidence analysed.
  Object.assign(phase2, { status: 'unavailable', score: null, confidence: 0, findings: [], redFlags: [], evidence: [] });
  const result = assess(phase1, phase2);
  assert.equal(result.compositeScore, 85);
  assert.equal(result.effectiveUnstructuredWeight, 0);
  assert.equal(result.reviewStatus, 'Ready');
});

test('thin evidence reduces its effective weight', async () => {
  const { phase1, phase2 } = await healthy();
  phase2.confidence = 0.1;
  const result = assess(phase1, phase2);
  assert.equal(result.effectiveUnstructuredWeight, 0.03);
  assert.equal(result.compositeScore, 84.49);
});

// Healthy case plus a news article reporting a lawsuit.
async function withLawsuit() {
  const { phase1, phase2 } = await healthy();
  const item = phase2.evidence.find((e: any) => e.source === 'news');
  item.text = 'A supplier filed a lawsuit against the bakery over disputed invoices.';
  phase2.findings.push({ kind: 'litigation', summary: 'Lawsuit reported', evidenceId: item.id, quote: item.text });
  return { phase1, phase2, evidenceId: item.id as string };
}

test('litigation caps Low at Medium and cannot improve a High band', async () => {
  const { phase1, phase2, evidenceId } = await withLawsuit();
  const result = assess(phase1, phase2);
  assert.equal(result.compositeBand, 'Low');
  assert.equal(result.riskBand, 'Medium');
  assert.equal(result.reviewStatus, 'Manual review required');
  assert.deepEqual(result.overrides[0]?.evidenceIds, [evidenceId]);
  assert.equal(assess({ ...phase1, score: 10 }, phase2).riskBand, 'High');
});

for (const kind of ['fraud', 'insolvency', 'regulatory_action']) {
  test(`${kind} requires manual review and withholds the automatic band`, async () => {
    const { phase1, phase2 } = await healthy();
    const item = phase2.evidence.find((e: any) => e.source === 'news');
    item.text = `A source reported ${kind}.`;
    const flag = { kind, summary: 'Reported adverse event', evidenceId: item.id, quote: item.text };
    phase2.findings = [flag];
    phase2.redFlags = []; // A missing redFlags list must not bypass policy.
    const result = assess(phase1, phase2);
    assert.equal(result.reviewStatus, 'Manual review required');
    assert.equal(result.riskBand, null);
    assert.equal(result.redFlags.length, 1);
    assert.equal(result.overrides[0]?.rule, 'mandatory_review');
  });
}

// Add one adverse finding of `kind` to the healthy case (composite 79.9, Low), citing a news or review item.
async function withFlag(kind: string, source: 'news' | 'review') {
  const { phase1, phase2 } = await healthy();
  const item = phase2.evidence.find((e: any) => e.source === source);
  item.text = `A source reported ${kind}.`;
  phase2.findings.push({ kind, summary: 'Reported adverse event', evidenceId: item.id, quote: item.text });
  return assess(phase1, phase2);
}

const expected = {
  critical: { band: null, status: 'Manual review required', rule: 'mandatory_review' },
  major: { band: 'Medium', status: 'Manual review required', rule: 'band_cap' },
  review: { band: 'Low', status: 'Manual review required', rule: 'analyst_review' },
  minor: { band: 'Low', status: 'Ready', rule: undefined },
} as const;

for (const [kind, severity] of Object.entries(POLICY.severity)) {
  test(`severity table: news-sourced ${kind} is ${severity}`, async () => {
    const result = await withFlag(kind, 'news');
    assert.equal(result.redFlags[0]?.severity, severity);
    assert.equal(result.riskBand, expected[severity].band);
    assert.equal(result.reviewStatus, expected[severity].status);
    assert.equal(result.overrides[0]?.rule, expected[severity].rule);
    if (severity === 'minor') assert.ok(result.warnings.some((w) => w.includes(kind)));
  });
}

test('review-only red flags are one severity level lower', async () => {
  for (const [kind, severity] of Object.entries(POLICY.severity)) {
    const result = await withFlag(kind, 'review');
    assert.equal(result.redFlags[0]?.severity, POLICY.reviewOnlySeverity[severity], kind);
  }
  // A customer saying the shop closed suddenly (major from news) is only a warning from a review.
  const closed = await withFlag('operational_distress', 'review');
  assert.equal(closed.riskBand, 'Low');
  assert.equal(closed.reviewStatus, 'Ready');
});

test('policy is data: changing the file changes the action and is recorded in the result', async () => {
  const result = await withFlag('litigation', 'news');
  assert.deepEqual(result.policy, POLICY); // full policy, including the severity table, is in the output
  const { phase1, phase2 } = await healthy();
  const item = phase2.evidence.find((e: any) => e.source === 'news');
  phase2.findings.push({ kind: 'litigation', summary: 'Lawsuit', evidenceId: item.id, quote: item.text });
  const relaxed = { ...POLICY, version: 'experiment-litigation-minor', severity: { ...POLICY.severity, litigation: 'minor' } };
  const outcome = assess(phase1, phase2, relaxed);
  assert.equal(outcome.riskBand, 'Low');
  assert.equal(outcome.policy.version, 'experiment-litigation-minor');
});

test('invalid policy files are rejected: missing, misspelt or unknown severities', async () => {
  const { phase1, phase2 } = await healthy();
  const { litigation, ...missing } = POLICY.severity;
  void litigation;
  assert.throws(() => assess(phase1, phase2, { ...POLICY, severity: missing }));
  assert.throws(() => assess(phase1, phase2, { ...POLICY, severity: { ...POLICY.severity, litigaton: 'major' } }));
  assert.throws(() => assess(phase1, phase2, { ...POLICY, severity: { ...POLICY.severity, fraud: 'severe' } }));
  assert.throws(() => assess(phase1, phase2, { ...POLICY, reviewOnlySeverity: { critical: 'major' } }));
  const directory = await mkdtemp(join(tmpdir(), 'phase3-policy-'));
  try {
    const path = join(directory, 'policy.json');
    await writeFile(path, JSON.stringify({ ...POLICY, severity: missing }));
    await assert.rejects(loadPolicy(path), /Invalid policy/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing financials never invent a combined score', async () => {
  const { phase1, phase2 } = await healthy();
  const result = assess({ ...phase1, score: null, coverage: 0 }, phase2);
  assert.equal(result.compositeScore, null);
  assert.equal(result.riskBand, null);
  assert.equal(result.effectiveUnstructuredWeight, 0);
  assert.equal(result.reviewStatus, 'Insufficient data');
});

test('partial Phase 2 and incomplete financials require review', async () => {
  const { phase1, phase2 } = await healthy();
  assert.equal(assess({ ...phase1, coverage: 0.5 }, phase2).reviewStatus, 'Manual review required');
  assert.equal(assess(phase1, { ...phase2, status: 'partial' }).reviewStatus, 'Manual review required');
  phase2.agents[0].status = 'failed';
  assert.equal(assess(phase1, phase2).reviewStatus, 'Manual review required');
});

test('score boundaries and policy changes are explicit', async () => {
  const { phase1, phase2 } = await healthy();
  for (const [score, band] of [[0, 'High'], [39.99, 'High'], [40, 'Medium'], [69.99, 'Medium'], [70, 'Low'], [100, 'Low']] as const) {
    const result = assess({ ...phase1, score }, phase2, { ...POLICY, baseUnstructuredWeight: 0 });
    assert.equal(result.riskBand, band);
  }
  assert.throws(() => assess(phase1, phase2, { ...POLICY, baseUnstructuredWeight: 2 }));
  assert.throws(() => assess(phase1, phase2, { ...POLICY, lowThreshold: 20 }));
});

test('reject identity mismatch, invalid scales and inconsistent unavailable results', async () => {
  const { phase1, phase2 } = await healthy();
  assert.throws(() => assess({ ...phase1, businessId: 'OTHER' }, phase2), /do not match/);
  assert.throws(() => assess({ ...phase1, score: 101 }, phase2));
  assert.throws(() => assess({ ...phase1, score: Number.NaN }, phase2));
  assert.throws(() => assess(phase1, { ...phase2, confidence: -1 }));
  assert.throws(() => assess(phase1, { ...phase2, status: 'unavailable' }));
});

test('reject unsupported flags rather than silently dropping adverse evidence', async () => {
  const lawsuit = await withLawsuit();
  lawsuit.phase2.findings.at(-1).quote = 'Fabricated quote';
  assert.throws(() => assess(lawsuit.phase1, lawsuit.phase2), /Unsupported adverse/);
  const { phase1, phase2: other } = await healthy();
  other.evidence[0].businessId = 'OTHER';
  assert.throws(() => assess(phase1, other), /another business/);
});

test('file loader rereads edits and rejects malformed JSON and path traversal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase3-'));
  try {
    await mkdir(join(directory, 'editable'));
    const { phase1, phase2 } = await healthy();
    const phase1Path = join(directory, 'editable', 'phase1.json');
    await writeFile(phase1Path, JSON.stringify(phase1));
    await writeFile(join(directory, 'editable', 'phase2.json'), JSON.stringify(phase2));
    let data = await loadCase('editable', directory);
    assert.equal(assess(data.phase1, data.phase2).compositeScore, 79.9);
    await writeFile(phase1Path, JSON.stringify({ ...phase1, score: 50 }));
    data = await loadCase('editable', directory);
    assert.equal(assess(data.phase1, data.phase2).compositeScore, 55.4);
    await writeFile(phase1Path, 'invalid');
    await assert.rejects(loadCase('editable', directory), /valid JSON/);
    await assert.rejects(loadCase('../bad', directory), /Invalid case/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
