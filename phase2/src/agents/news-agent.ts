import { Agent, type Model } from '@openai/agents';
import { modelOutputSchema } from '../contracts.js';
import { COMMON_INSTRUCTIONS, COMMON_MODEL_SETTINGS } from './instructions.js';

export function createNewsAgent(model: string | Model) {
  return new Agent({
    name: 'Business news analyst', model,
    instructions: `${COMMON_INSTRUCTIONS}\nAnalyse news and public business notices only.
Allowed kinds: growth, litigation, fraud, insolvency, regulatory_action.
Extract only explicitly supported business events. Keep summaries qualified when a source reports an allegation.`,
    outputType: modelOutputSchema,
    modelSettings: COMMON_MODEL_SETTINGS,
  });
}
