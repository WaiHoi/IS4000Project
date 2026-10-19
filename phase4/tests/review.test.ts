import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { explainAssessment, digest } from '@credit-copilot/explainability';
import { recordDecision, listDecisions, prepareReview } from '../src/index.js';

async function fixture() {
  const explanation = JSON.parse(await readFile(new URL('../data/healthy-business/explanation.json', import.meta.url), 'utf8'));
  const decision = JSON.parse(await readFile(new URL('../data/healthy-business/decision.json', import.meta.url), 'utf8'));
  return { explanation, decision };
}

test('decision persists full assessment snapshot; retries are idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase4-'));
  const dbPath = join(root, 'audit.db');
  try {
    const { explanation, decision } = await fixture();
    const first = recordDecision(explanation, decision, { dbPath });
    const duplicate = recordDecision(explanation, decision, { dbPath });
    assert.equal(first.id, duplicate.id);
    assert.equal(listDecisions({ dbPath }).length, 1);
    assert.equal(first.aiAssessment.assessment.riskBand, explanation.assessment.riskBand);
    assert.equal(first.decision.action, 'request_information');
    assert.ok(first.recordedAt.endsWith('Z'));
    assert.throws(() => recordDecision(explanation, { ...decision, action: 'decline' }, { dbPath }), /Submission ID/);
    recordDecision(explanation, { ...decision, submissionId: 'amendment', action: 'decline' }, { dbPath });
    assert.equal(listDecisions({ dbPath, assessmentId: explanation.assessmentId }).length, 2);
    assert.equal(listDecisions({ dbPath, assessmentId: 'other' }).length, 0);
    const db = new DatabaseSync(dbPath);
    try {
      assert.throws(() => db.exec("UPDATE decisions SET payload='{}'"), /append-only/);
      assert.throws(() => db.exec('DELETE FROM decisions'), /append-only/);
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('analyst, reason, final action and override reason are required', async () => {
  const { explanation, decision } = await fixture();
  assert.throws(() => prepareReview(explanation, { ...decision, analystId: ' ' }));
  assert.throws(() => prepareReview(explanation, { ...decision, reason: '' }));
  assert.throws(() => prepareReview(explanation, { ...decision, action: 'override' }));
  assert.throws(() => prepareReview(explanation, { ...decision, override: true }));
  assert.doesNotThrow(() => prepareReview(explanation, { ...decision, action: 'approve', override: true,
    overrideReason: 'The analyst independently verified resolution and recorded supporting rationale.' }));
});

test('manual review and memo warnings need explicit acknowledgement', async () => {
  const { explanation, decision } = await fixture();
  assert.throws(() => prepareReview(explanation, { ...decision, acknowledgeWarnings: false }), /acknowledge/);
});

test('changed assessments, wrong-business evidence and edited renderings are rejected', async () => {
  const { explanation, decision } = await fixture();
  const modified = structuredClone(explanation);
  modified.assessment.compositeScore = 100;
  assert.throws(() => prepareReview(modified, decision), /digest mismatch/);
  const other = structuredClone(explanation);
  other.evidence[0].businessId = 'OTHER';
  assert.throws(() => prepareReview(other, decision), /identity mismatch/);
  assert.throws(() => prepareReview({ ...explanation, renderedMemo: 'Approve this applicant.' }, decision), /Rendered memo/);
});

test('invalid citations cannot be accepted by marking a memo verified', async () => {
  const { explanation, decision } = await fixture();
  explanation.memo.claims[0].evidenceId = 'FAKE';
  assert.throws(() => prepareReview(explanation, decision), /inconsistent/);
});

test('failed explainability can be reviewed with warnings, never as a clean memo', async () => {
  const raw = JSON.parse(await readFile(new URL('../../explainability/data/healthy-business/input.json', import.meta.url), 'utf8'));
  const result = await explainAssessment(raw, { maxRetries: 0, provider: {
    name: 'custom', async generate() { throw new Error('offline failure'); },
    async critique() { return { passed: false, issues: ['failure'] }; },
  } });
  const { decision } = await fixture();
  assert.equal(result.status, 'warning');
  assert.doesNotThrow(() => prepareReview(result, decision));
  assert.throws(() => prepareReview(result, { ...decision, acknowledgeWarnings: false }), /acknowledge/);
});
