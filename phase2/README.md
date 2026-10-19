# Phase 2: TypeScript agents with OpenRouter

OpenRouter is the only live provider. The Agents SDK remains the coordination
library, configured to send requests to OpenRouter Chat Completions. OpenAI
tracing is disabled; no OpenAI account or key is needed.

## Run with real AI

Install Node.js 22+, then run in a terminal:

```sh
cd phase2
npm ci
```

Edit **phase2/.env** (copy `.env.example` if missing):

```dotenv
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=your-selected-model-id
```

Choose an exact model ID from OpenRouter that supports structured outputs.
The adapter requires endpoints to honour the requested parameters. Pricing,
access and capabilities depend on the model. Existing OpenAI settings are ignored.

```sh
# Real AI through OpenRouter: one case (API usage charges may apply).
npm run demo -- --case healthy-business

# Real AI: all folders in data/.
npm run demo

# Offline keyword analysis, no AI calls or charges.
npm run demo -- --provider mock

# List case folders without making AI calls.
npm run demo -- --list
```

On Windows use `npm.cmd` if PowerShell blocks `npm.ps1`.
Full reports are saved to `output/<case>.openrouter.json` or `.mock.json`.
Missing configuration fails explicitly; failures never silently switch providers.

## Data and flow

Each folder in `data/` has `business.json`, `reviews.json`, and `news.json`.
All files are read on every run; edit them or add folders without changing code.
Use `[]` for an empty source. See [data/README.md](data/README.md) for input schemas.

Input validation (schema, consent, unique evidence IDs) is owned by intake,
before Phase 2. Phase 2 trusts its caller and does not re-validate input.

```text
Read JSON (no validation; intake has already validated)
        ↓
Match business IDs, basic redaction, quarantine, deduplicate
        ↓
Reviews agent + News agent (parallel, via OpenRouter)
        ↓
Verify evidence IDs and quotes
        ↓
Calculate score, coverage, red flags and gaps
```

For a different dataset:

```sh
npm run demo -- --data-dir "/path/to/data" --case your-business
```

## Output and scoring

The result includes provider, status, business identity, score, coverage/confidence,
factors, findings, red flags, sanitised evidence, exclusions, warnings, data gaps
and per-agent status. Higher scores mean safer businesses. No successfully
analysed evidence yields a null score and zero confidence. Partial failures retain
successful results and remove failed-source coverage. The CLI saves a report and
exits nonzero if an agent fails. Complete means processing completed, not sufficient
coverage or a safe business.

The rubric starts at 50; review sentiment adds 8, subtracts 10, or adds zero for
a tie. Growth adds 5 per article up to 10; adverse news subtracts 20 per article.
Scores are clamped to 0-100. Full count coverage is five reviews and two news
items, weighted 70%/30%. This is a demonstration heuristic, not a default probability.
Exact duplicate source text is excluded.

## Tests and build

```sh
npm test
npm run typecheck
npm run build
npm start -- --case healthy-business
```

Tests use mocks and simulated HTTP responses: no live credentials or API charges.
Live model extraction quality still requires evaluation.

## Import into another backend

Build this package, then install it from your friend's backend:

```sh
npm install /path/to/phase2
```

In server-side TypeScript:

```ts
import { analysePhase2, loadCase } from '@credit-copilot/phase2';
const input = await loadCase('your-business');
const result = await analysePhase2(input, { provider: 'openrouter' });
```

The backend manages environment loading. Only the CLI loads phase2/.env automatically.
The library defaults to mock mode if no provider is passed, avoiding unexpected
network calls; the CLI defaults to OpenRouter. You can pass a Phase2Input object
directly instead of loading files. Imports do not write files or execute the CLI.

## Ownership

- `contracts.ts`: shared input types and the agent output schema.
- `load-data.ts`: demo disk adapter (no validation).
- `pipeline.ts`: coordination, timeouts and failure states.
- `agents/`: reviews/news instructions and structured outputs.
- `providers/`: OpenRouter and mock adapters.
- `processing/`: preparation, verification and scoring.
- `config.ts`: deterministic rubric.

## Limits

No live scraping, registry verification, traditional scoring, final credit band,
memo or analyst decisions. Claims are context rather than separately verified
contradictions. Dates are retained but not used for recency weighting or trends.
Quotes prove provenance, not semantic support or the truth of an allegation.
Regex redaction and injection screening are basic. Mock matching cannot reliably
interpret negation. Use synthetic or appropriately prepared data; dataset files
are tracked. Credentials and generated reports are git-ignored.

References: [OpenRouter quickstart](https://openrouter.ai/docs/quickstart),
[structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
