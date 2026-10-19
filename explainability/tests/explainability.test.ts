import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainAssessment, loadMemoPolicy, verifyMemo, type ExplanationProvider, type ExplainInput } from '../src/index.js';
import { mockProvider } from '../src/providers/mock-provider.js';

const POLICY = await loadMemoPolicy();

// Bundle generated from the current Phase 2 report and Phase 3 assessment.
async function fixture(): Promise<ExplainInput> {
  return JSON.parse(await readFile(new URL('../data/healthy-business/input.json', import.meta.url), 'utf8'));
}

// Adds an adverse news item to the healthy bundle: a red flag, optionally with a Phase 3 override.
async function withRedFlag(kind: 'litigation' | 'governance_issue', override: boolean): Promise<ExplainInput> {
  const input = await fixture();
  const text = 'A supplier filed a lawsuit against the bakery over disputed invoices.';
  input.phase2.evidence.push({ id: 'N9', businessId: input.assessment.businessId, source: 'news', text });
  const finding = { kind, summary: 'Adverse event reported', evidenceId: 'N9', quote: text };
  input.phase2.findings.push(finding);
  (input.assessment.redFlags ??= []).push({ ...finding, severity: override ? 'major' : 'minor' });
  if (override) input.assessment.overrides.push({ rule: 'band_cap', reason: 'Major red flag.', evidenceIds: ['N9'] });
  return input;
}

// A provider whose memo omits every claim citing `evidenceId`.
const omitting = (evidenceId: string): ExplanationProvider => ({ ...mockProvider, name: 'custom',
  async generate(input, feedback, signal) {
    const memo = await mockProvider.generate(input, feedback, signal);
    memo.claims = memo.claims.filter((claim) => claim.evidenceId !== evidenceId);
    return memo;
  } });

test('current pipeline bundle produces a cited, verified offline memo with policy recorded', async () => {
  const input = await fixture();
  const result = await explainAssessment(input);
  assert.equal(result.status, 'verified');
  assert.equal(result.provider, 'mock');
  assert.equal(result.model, null);
  assert.deepEqual(result.policy, POLICY);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.memo?.scores.composite, input.assessment.compositeScore);
  assert.match(result.renderedMemo, /final credit decision/);
});

test('incorrect scores, bands and made-up citations cannot pass a permissive critic', async () => {
  const provider: ExplanationProvider = { ...mockProvider, name: 'custom', async generate(input, feedback, signal) {
    const memo = await mockProvider.generate(input, feedback, signal);
    memo.scores.composite = 1;
    memo.riskBand = 'High';
    memo.claims[0]!.evidenceId = 'FAKE';
    return memo;
  } };
  const result = await explainAssessment(await fixture(), { provider });
  assert.equal(result.status, 'warning');
  assert.equal(result.memo, null);
  assert.equal(result.attempts.length, POLICY.maxRetries + 1);
  assert.ok(result.attempts.every((a) => a.criticPassed && !a.verificationPassed));
  assert.ok(!result.renderedMemo.includes('[FAKE]'));
});

test('critic rejection sends feedback and cannot be overridden by successful code checks', async () => {
  let feedbackReceived = false;
  let critiques = 0;
  const provider: ExplanationProvider = { ...mockProvider, name: 'custom',
    async generate(input, feedback, signal) {
      feedbackReceived ||= feedback.includes('Qualify the allegation.');
      return mockProvider.generate(input, feedback, signal);
    },
    async critique() { critiques++; return critiques === 1 ? { passed: false, issues: ['Qualify the allegation.'] } : { passed: true, issues: [] }; },
  };
  const result = await explainAssessment(await fixture(), { provider });
  assert.equal(result.status, 'verified');
  assert.equal(result.attempts.length, 2);
  assert.ok(feedbackReceived);
});

test('protected attributes and unsupported narrative metrics are blocked', async () => {
  const provider: ExplanationProvider = { ...mockProvider, name: 'custom', async generate(input, feedback, signal) {
    const memo = await mockProvider.generate(input, feedback, signal);
    memo.claims[0]!.text = 'Female owner has score 99.';
    return memo;
  } };
  const result = await explainAssessment(await fixture(), { provider, maxRetries: 0 });
  assert.equal(result.status, 'warning');
  assert.ok(result.attempts[0]!.issues.some((issue) => issue.includes('protected')));
});

test('missing policy citations are rejected', async () => {
  const result = await explainAssessment(await withRedFlag('litigation', true), { provider: omitting('N9'), maxRetries: 0 });
  assert.equal(result.status, 'warning');
  assert.ok(result.attempts[0]!.issues.some((issue) => issue.includes('Missing policy evidence citation: N9')));
});

test('bad news cannot be left out: red flags without an override must still be cited', async () => {
  // A minor red flag only produces a Phase 3 warning, so the old override-only check missed it.
  const input = await withRedFlag('governance_issue', false);
  const result = await explainAssessment(input, { provider: omitting('N9'), maxRetries: 0 });
  assert.equal(result.status, 'warning');
  assert.ok(result.attempts[0]!.issues.some((issue) => issue.includes('adverse or negative finding: N9')));
  // Negative reviews are required too.
  const reviews = await fixture();
  const review = reviews.phase2.evidence.find((e) => e.source === 'review')!;
  reviews.phase2.findings.push({ kind: 'negative_review', summary: 'Complaint', evidenceId: review.id, quote: review.text });
  const omitted = await explainAssessment(reviews, { provider: omitting(review.id), maxRetries: 0 });
  assert.ok(omitted.attempts[0]!.issues.some((issue) => issue.includes(`adverse or negative finding: ${review.id}`)));
});

test('memo policy is data: changing it changes the checks and is recorded; invalid policies are rejected', async () => {
  const provider: ExplanationProvider = { ...mockProvider, name: 'custom', async generate(input, feedback, signal) {
    const memo = await mockProvider.generate(input, feedback, signal);
    memo.claims[0]!.text = 'The franchise has operated for many years at Block 7.';
    return memo;
  } };
  const strict = await explainAssessment(await fixture(), { provider, maxRetries: 0 });
  assert.equal(strict.status, 'warning');
  const relaxed = { ...POLICY, version: 'experiment-digits', forbidDigitsInNarrative: false };
  const allowed = await explainAssessment(await fixture(), { provider, policy: relaxed });
  assert.equal(allowed.status, 'verified');
  assert.equal(allowed.policy?.version, 'experiment-digits');
  await assert.rejects(explainAssessment(await fixture(), { policy: { ...POLICY, requiredCitationKinds: ['lawsuit'] } as any }));
  const directory = await mkdtemp(join(tmpdir(), 'memo-policy-'));
  try {
    const path = join(directory, 'memo.json');
    const { maxRetries, ...missing } = POLICY;
    void maxRetries;
    await writeFile(path, JSON.stringify(missing));
    await assert.rejects(loadMemoPolicy(path), /Invalid memo policy/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('without a policy (older reports) only structural checks run', async () => {
  const input = await withRedFlag('litigation', true);
  const memo = await mockProvider.generate(input, [], new AbortController().signal);
  memo.claims[0]!.text = 'Operated for many years at Block 7.';
  assert.deepEqual(verifyMemo(input, memo), []);
  assert.ok(verifyMemo(input, memo, POLICY).length > 0);
});

test('failure and timeout produce a warning report within the retry limit', async () => {
  const provider: ExplanationProvider = { ...mockProvider, name: 'custom', generate: async () => new Promise(() => {}) };
  const result = await explainAssessment(await fixture(), { provider, timeoutMs: 5, maxRetries: 1 });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.status, 'warning');
  assert.equal(result.memo, null);
});

test('reject cross-business evidence and invalid retry configuration', async () => {
  const input = await fixture();
  input.phase2.businessId = 'OTHER';
  await assert.rejects(explainAssessment(input), /mismatch/);
  await assert.rejects(explainAssessment(await fixture(), { maxRetries: 6 }), /maxRetries/);
});

test('memo and critic SDK agents use OpenRouter structured output; models and prompt version are recorded', async () => {
  const input = await fixture();
  const goodMemo = await mockProvider.generate(input, [], new AbortController().signal);
  const { createOpenRouterProvider } = await import('../src/providers/openrouter-provider.js');
  const requests: any[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const isCritic = JSON.stringify(body.messages).includes('Independently review');
    return new Response(JSON.stringify({ id: 'offline-test', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(isCritic ? { passed: true, issues: [] } : goodMemo) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  // Separate critic model: no independence warning, and each agent calls its own model.
  const provider = createOpenRouterProvider({ apiKey: 'offline-placeholder', model: 'test/writer', criticModel: 'test/critic', fetch: fakeFetch });
  const result = await explainAssessment(input, { provider });
  assert.equal(result.status, 'verified');
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model?.writer, 'test/writer');
  assert.equal(result.model?.critic, 'test/critic');
  assert.match(result.model?.promptVersion ?? '', /^[0-9a-f]{12}$/);
  assert.ok(!result.warnings.some((w) => w.includes('same model')));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.model).sort(), ['test/critic', 'test/writer']);
  assert.ok(requests.every((r) => r.response_format.type === 'json_schema' && r.provider.require_parameters === true));
  // Same model for both: the report says the review is not independent.
  const same = createOpenRouterProvider({ apiKey: 'offline-placeholder', model: 'test/writer', fetch: fakeFetch });
  const sameResult = await explainAssessment(input, { provider: same });
  assert.equal(sameResult.model?.critic, 'test/writer');
  assert.ok(sameResult.warnings.some((w) => w.includes('same model')));
});
