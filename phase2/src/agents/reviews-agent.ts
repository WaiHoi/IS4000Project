import { Agent, type Model } from '@openai/agents';
import { modelOutputSchema } from '../contracts.js';
import { COMMON_INSTRUCTIONS, COMMON_MODEL_SETTINGS } from './instructions.js';

export function createReviewsAgent(model: string | Model) {
  return new Agent({
    name: 'Business reviews analyst', model,
    instructions: `${COMMON_INSTRUCTIONS}\nAnalyse customer reviews only. Allowed kinds: positive_review, negative_review.
Extract each review's supported service or delivery signal. Do not turn reviewer suspicions into news allegations.`,
    outputType: modelOutputSchema,
    modelSettings: COMMON_MODEL_SETTINGS,
  });
}
