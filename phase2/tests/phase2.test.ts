import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysePhase2, loadCase, listCases, type AnalysisProvider } from '../src/index.js';

test('all on-disk cases run; every accepted finding has a matching quote', async () => {
  const cases = await listCases();
  assert.ok(cases.length >= 1);
  for (const name of cases) {
    const input = await loadCase(name);
    const result = await analysePhase2(input);
    assert.equal(result.businessId, input.business.id);
    assert.equal(result.provider, 'mock');
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    for (const finding of result.findings) {
      assert.ok(result.evidence.find((e) => e.id === finding.evidenceId)?.text.includes(finding.quote));
    }
  }
});

test('healthy rubric', async () => {
  const healthy = await analysePhase2(await loadCase('healthy-business'));
  assert.equal(healthy.score, 68);
  assert.equal(healthy.confidence, 1);
  assert.equal(healthy.status, 'complete');
});

test('fabricated quote, unknown citation, wrong source and duplicate findings', async () => {
  const provider: AnalysisProvider = { name: 'custom', async analyse({ source, evidence }) {
    if (source !== 'review') return { findings: [] };
    const item = evidence[0]!;
    const valid = { kind: 'positive_review' as const, summary: 'Positive', evidenceId: item.id, quote: item.text };
    return { findings: [valid, valid,
      { ...valid, quote: 'Made up text' },
      { ...valid, evidenceId: 'FAKE' },
      { ...valid, kind: 'fraud' as const },
    ] };
  } };
  const result = await analysePhase2(await loadCase('healthy-business'), { provider });
  assert.equal(result.findings.length, 1);
  assert.equal(result.redFlags.length, 0);
  assert.equal(result.agents[0]?.warnings.length, 3);
  assert.equal(result.status, 'partial');
});

test('reviews may report customer-seen distress; new red flags are reported but not penalised', async () => {
  const provider: AnalysisProvider = { name: 'custom', async analyse({ source, evidence }) {
    const item = evidence[0]!;
    const finding = { summary: 'Adverse', evidenceId: item.id, quote: item.text };
    return { findings: source === 'review'
      ? [{ ...finding, kind: 'operational_distress' as const }, { ...finding, kind: 'litigation' as const }]
      : [{ ...finding, kind: 'governance_issue' as const }] };
  } };
  const result = await analysePhase2(await loadCase('healthy-business'), { provider });
  assert.deepEqual(result.redFlags.map((flag) => flag.kind).sort(), ['governance_issue', 'operational_distress']);
  assert.equal(result.agents[0]?.warnings.length, 1); // litigation is not allowed from reviews
  assert.equal(result.score, 50); // only the original four kinds cost Phase 2 points
});

test('agent failures preserve successful results and remove failed-source coverage', async () => {
  const provider: AnalysisProvider = { name: 'custom', async analyse({ source }) {
    if (source === 'news') throw new Error('Do not expose secret provider request');
    return { findings: [] };
  } };
  const result = await analysePhase2(await loadCase('healthy-business'), { provider });
  assert.equal(result.status, 'partial');
  assert.equal(result.confidence, 0.7);
  assert.equal(result.coverage.news, 0);
  assert.deepEqual(result.coverage.failedSources, ['news']);
  assert.ok(!JSON.stringify(result).includes('secret provider request'));
});

test('timeouts are bounded and do not silently fall back to mock', async () => {
  const provider: AnalysisProvider = { name: 'custom', analyse: async () => new Promise(() => {}) };
  const result = await analysePhase2(await loadCase('healthy-business'), { provider, timeoutMs: 10 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.provider, 'custom');
  assert.ok(result.agents.every((agent) => agent.status === 'failed' && agent.error === 'Agent timed out.'));
});

test('invalid agent output is a failure, not successful zero findings', async () => {
  const provider = { name: 'custom', async analyse() { return { findings: [{ bad: true }] }; } } as unknown as AnalysisProvider;
  const result = await analysePhase2(await loadCase('healthy-business'), { provider });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.confidence, 0);
});

test('loader rejects case names that escape the data directory', async () => {
  await assert.rejects(loadCase('../healthy-business'), /Case name/);
});

test('loader rereads edited files rather than cached or embedded data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase2-'));
  try {
    const directory = join(root, 'editable');
    await mkdir(directory);
    const input = await loadCase('healthy-business');
    await writeFile(join(directory, 'business.json'), JSON.stringify(input.business));
    await writeFile(join(directory, 'reviews.json'), JSON.stringify(input.evidence.filter((e) => e.source === 'review')));
    await writeFile(join(directory, 'news.json'), '[]');
    assert.equal((await analysePhase2(await loadCase('editable', root))).score, 58);
    await writeFile(join(directory, 'reviews.json'), '[]');
    assert.equal((await analysePhase2(await loadCase('editable', root))).score, null);
    await writeFile(join(directory, 'news.json'), '{broken json');
    await assert.rejects(loadCase('editable', root), /news.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenRouter adapter validates configuration without API calls', async () => {
  const { createOpenRouterProvider } = await import('../src/providers/openrouter-provider.js');
  const previousKey = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    assert.throws(() => createOpenRouterProvider({ model: 'test-model' }), /OPENROUTER_API_KEY/);
    process.env.OPENROUTER_API_KEY = 'offline-test-placeholder-not-a-real-key';
    assert.throws(() => createOpenRouterProvider({ model: '' }), /OPENROUTER_MODEL/);
    const provider = createOpenRouterProvider({ model: 'test-model' });
    assert.equal(provider.name, 'openrouter');
    assert.equal(typeof provider.analyse, 'function');
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('SDK requests use OpenRouter chat completions and the findings schema', async () => {
  const { createOpenRouterProvider } = await import('../src/providers/openrouter-provider.js');
  const requests: { url: string; body: any }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      id: 'test-completion', object: 'chat.completion', created: 1, model: 'example/model',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ findings: [] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const provider = createOpenRouterProvider({ model: 'example/model', apiKey: 'offline-placeholder', fetch: fakeFetch });
  const result = await analysePhase2(await loadCase('healthy-business'), { provider });
  assert.equal(result.status, 'complete');
  assert.equal(result.provider, 'openrouter');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.body.model, 'example/model');
    assert.equal(request.body.provider.require_parameters, true);
    assert.equal(request.body.response_format.type, 'json_schema');
    assert.equal(request.body.response_format.json_schema.strict, true);
  }
});
