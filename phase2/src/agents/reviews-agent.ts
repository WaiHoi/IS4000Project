import { Agent, type Model } from '@openai/agents';
import { modelOutputSchema } from '../contracts.js';
import { ALLOWED_KINDS } from '../config.js';
import { COMMON_INSTRUCTIONS, COMMON_MODEL_SETTINGS } from './instructions.js';

export function createReviewsAgent(model: string | Model) {
  return new Agent({
    name: 'Business reviews analyst', model,
    instructions: `${COMMON_INSTRUCTIONS}\nAnalyse customer reviews only.
Allowed kinds: ${ALLOWED_KINDS.review.join(', ')}.
Extract each review's supported service or delivery signal. Use an adverse kind only when the reviewer
describes something they experienced directly (for example the shop closed, or a refund was never paid),
in addition to negative_review. Do not turn reviewer suspicions or rumours into allegations.`,
    outputType: modelOutputSchema,
    modelSettings: COMMON_MODEL_SETTINGS,
  });
}
