import { createHash } from 'node:crypto';
import { explainInputSchema, memoSchema, memoPolicySchema, critiqueSchema, type ExplanationProvider, type ExplanationResult, type Memo, type MemoPolicy } from './contracts.js';
import { loadMemoPolicy } from './policy.js';
import { mockProvider } from './providers/mock-provider.js';
import { verifyMemo, renderMemo } from './verify-memo.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

export async function explainAssessment(raw: unknown, options: {
  provider?: 'mock' | 'openrouter' | ExplanationProvider; model?: string; criticModel?: string;
  // Memo policy; defaults to policy/memo.json. maxRetries overrides the policy's value.
  policy?: MemoPolicy; maxRetries?: number; timeoutMs?: number;
} = {}): Promise<ExplanationResult> {
  const input = explainInputSchema.parse(raw);
  const policy = memoPolicySchema.parse(options.policy ?? await loadMemoPolicy());
  if (input.assessment.businessId !== input.phase2.businessId || input.phase2.evidence.some((e) => e.businessId !== input.assessment.businessId)) {
    throw new Error('Business identity mismatch between assessment and Phase 2 evidence.');
  }
  if (new Set(input.phase2.evidence.map((e) => e.id)).size !== input.phase2.evidence.length) throw new Error('Duplicate evidence IDs.');
  const maxRetries = options.maxRetries ?? policy.maxRetries;
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('maxRetries must be from 0 to 5.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid timeoutMs.');
  let provider: ExplanationProvider = mockProvider;
  if (typeof options.provider === 'object') provider = options.provider;
  else if (options.provider === 'openrouter') {
    const { createOpenRouterProvider } = await import('./providers/openrouter-provider.js');
    provider = createOpenRouterProvider({ model: options.model ?? process.env.OPENROUTER_MODEL ?? '',
      criticModel: options.criticModel ?? process.env.OPENROUTER_CRITIC_MODEL });
  } else if (options.provider && options.provider !== 'mock') throw new Error('Unsupported provider.');
  const attempts: ExplanationResult['attempts'] = [];
  let feedback: string[] = [];
  let verified: Memo | null = null;
  async function timed<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, timeoutMs);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
  for (let number = 1; number <= maxRetries + 1; number++) {
    let criticPassed = false;
    let verificationPassed = false;
    try {
      const memo = memoSchema.parse(await timed((signal) => provider.generate(input, feedback, signal)));
      // Code checks run even when the critic rejects the draft.
      const issues = verifyMemo(input, memo, policy);
      verificationPassed = issues.length === 0;
      const critique = critiqueSchema.parse(await timed((signal) => provider.critique(input, memo, signal)));
      criticPassed = critique.passed && critique.issues.length === 0;
      feedback = [...issues, ...critique.issues];
      if (!criticPassed && !critique.issues.length) feedback.push('Critic rejected the draft.');
      attempts.push({ number, issues: feedback, criticPassed, verificationPassed });
      if (criticPassed && verificationPassed) { verified = memo; break; }
    } catch {
      feedback = ['Memo generation or critique failed, timed out, or returned invalid structured output.'];
      attempts.push({ number, issues: feedback, criticPassed, verificationPassed });
    }
  }
  return { schemaVersion: '1.0', assessmentId: input.assessmentId, assessmentDigest: digest(input.assessment),
    businessId: input.assessment.businessId, provider: provider.name, model: provider.model ?? null, policy,
    status: verified ? 'verified' : 'warning',
    assessment: input.assessment, memo: verified, renderedMemo: renderMemo(input, verified),
    evidence: input.phase2.evidence, attempts,
    warnings: [ ...(provider.name === 'mock' ? ['Mock memo and critic; no AI review performed.'] : []),
      ...(provider.model && provider.model.writer === provider.model.critic
        ? ['Critic uses the same model as the writer, so its review is not independent. Set OPENROUTER_CRITIC_MODEL to a different model.'] : []),
      ...(!verified ? ['Memo checks did not pass within the retry limit. Analyst must inspect source evidence.'] : []) ] };
}
