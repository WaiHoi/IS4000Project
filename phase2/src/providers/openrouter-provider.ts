import OpenAI from 'openai';
import { Runner, OpenAIChatCompletionsModel } from '@openai/agents';
import { createReviewsAgent } from '../agents/reviews-agent.js';
import { createNewsAgent } from '../agents/news-agent.js';
import { agentOutputSchema, type AnalysisProvider } from '../contracts.js';

export function createOpenRouterProvider(options: { model: string; apiKey?: string; fetch?: typeof fetch }): AnalysisProvider {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey?.trim()) throw new Error('Set OPENROUTER_API_KEY in phase2/.env.');
  if (!options.model.trim()) throw new Error('Set OPENROUTER_MODEL in phase2/.env to a model with structured-output support.');
  const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}) });
  const model = new OpenAIChatCompletionsModel(client, options.model);
  // The SDK manages the agent loop; all model requests go to OpenRouter.
  // OpenAI tracing is disabled so no OpenAI account or key is needed.
  const runner = new Runner({ tracingDisabled: true });
  const agents = { review: createReviewsAgent(model), news: createNewsAgent(model) };
  return {
    name: 'openrouter',
    async analyse({ source, business, evidence, signal }) {
      const result = await runner.run(agents[source], JSON.stringify({ business, evidence }), { maxTurns: 2, signal });
      if (!result.finalOutput) throw new Error('Agent returned no structured output.');
      return agentOutputSchema.parse(result.finalOutput);
    },
  };
}
