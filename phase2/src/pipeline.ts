import { agentOutputSchema, type AgentResult, type AnalysisProvider, type Phase2Input, type Phase2Result, type Source } from './contracts.js';
import { prepareEvidence } from './processing/prepare-evidence.js';
import { verifySignals } from './processing/verify-signals.js';
import { aggregate } from './processing/aggregate.js';
import { mockProvider } from './providers/mock-provider.js';

export interface Phase2Options {
  provider?: 'mock' | 'openrouter' | AnalysisProvider;
  model?: string;
  timeoutMs?: number;
}

// Expects input already validated by intake (schema, consent, unique evidence IDs).
export async function analysePhase2(input: Phase2Input, options: Phase2Options = {}): Promise<Phase2Result> {
  const prepared = prepareEvidence(input);
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('timeoutMs must be an integer from 1 to 300000.');
  let provider: AnalysisProvider;
  if (typeof options.provider === 'object') provider = options.provider;
  else if (options.provider === 'openrouter') {
    // Mock mode does not initialise the SDK, read keys, or send any network calls.
    const { createOpenRouterProvider } = await import('./providers/openrouter-provider.js');
    provider = createOpenRouterProvider({ model: options.model ?? process.env.OPENROUTER_MODEL ?? '' });
  } else if (options.provider === undefined || options.provider === 'mock') provider = mockProvider;
  else throw new Error('Provider must be openrouter or mock.');

  async function runSource(source: Source): Promise<AgentResult> {
    const evidence = prepared.evidence.filter((item) => item.source === source);
    if (!evidence.length) return { source, status: 'skipped', inputCount: 0, findings: [], warnings: [] };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Agent timeout'));
        }, timeoutMs);
      });
      const raw = await Promise.race([
        provider.analyse({ source, business: prepared.business, evidence, signal: controller.signal }), timeout,
      ]);
      const output = agentOutputSchema.parse(raw);
      const verified = verifySignals(output.findings, evidence, source);
      return { source, status: 'completed', inputCount: evidence.length, ...verified };
    } catch (error) {
      // Log the cause to stderr for debugging (status and message only, never request bodies or keys).
      const status = (error as { status?: unknown })?.status;
      // OpenRouter puts the upstream provider's reason in error.metadata.raw.
      const raw = (error as { error?: { metadata?: { raw?: unknown } } })?.error?.metadata?.raw;
      const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)) +
        (raw ? ` | provider: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}` : '');
      console.error(`[phase2] ${source} agent failed${status ? ` (HTTP ${status})` : ''}: ${message.slice(0, 500)}`);
      // Do not expose SDK request payloads, keys, or unredacted provider errors in reports.
      return { source, status: 'failed', inputCount: evidence.length, findings: [], warnings: [],
        error: controller.signal.aborted ? 'Agent timed out.' : 'Agent failed or returned invalid structured output. Check provider configuration and retry.' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const agents = await Promise.all([runSource('review'), runSource('news')]);
  const summary = aggregate(agents, prepared.evidence);
  const incomplete = agents.some((agent) => agent.status === 'failed' || agent.warnings.length > 0);
  return {
    schemaVersion: '1.0', businessId: input.business.id, businessName: input.business.name,
    provider: provider.name, generatedAt: new Date().toISOString(),
    status: summary.score === null ? 'unavailable' : incomplete ? 'partial' : 'complete',
    ...summary,
    evidence: prepared.evidence,
    excludedEvidence: prepared.excludedEvidence,
    warnings: [
      ...(provider.name === 'mock' ? ['Mock mode: keyword matching only; no AI model was called.'] : []),
      ...prepared.warnings, ...agents.flatMap((agent) => agent.warnings),
      ...agents.filter((agent) => agent.error).map((agent) => `${agent.source}: ${agent.error}`),
    ],
    agents,
  };
}
