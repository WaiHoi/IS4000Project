# Phase 2: TypeScript agents with OpenRouter

OpenRouter is the only live provider. The Agents SDK remains the coordination
library, configured to send requests to OpenRouter Chat Completions. OpenAI
tracing is disabled; no OpenAI account or key is needed.

## Run with real AI

Install Node.js 22+, then run in a terminal:

```sh
# Shared contracts (finding kinds, report types) must be built first.
cd contracts
npm ci
npm run build
cd ../phase2
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

### Scoring rubric (data, not code)

The weights are in [`policy/rubric.json`](policy/rubric.json). With the defaults:
the score starts at 50; review sentiment adds 8, subtracts 10, or adds zero for a
tie. Growth adds 5 per article up to 10; each article with a `penalisedKinds` red
flag (litigation, fraud, insolvency, regulatory_action) subtracts 20. Scores are
clamped to 0-100. Full count coverage is five reviews and two news items,
weighted 70%/30%. This is a demonstration heuristic, not a default probability.

Change the scoring by editing that file (bump `version`), or try a copy without
changing the default:

```sh
npm run demo -- --case healthy-business --rubric ./my-rubric.json
```

The rubric is validated before any AI call: missing or unknown fields, unknown
red-flag kinds, or review/news weights that do not add up to 1 are rejected. The
full rubric is copied into every report (`rubric`), so each score shows which
weights produced it. In code, pass `{ rubric }` to `analysePhase2`, or omit it to
use the default file.

### Red flags

All adverse kinds are reported in `redFlags`; Phase 3 maps each to a severity:
litigation, fraud, insolvency, regulatory_action, payment_distress,
operational_distress, licence_issue, governance_issue and other_adverse. Which
agent may report which kind is a guardrail in `src/config.ts`. Reviews may report
payment_distress, operational_distress and other_adverse when the customer saw it
directly; other red flags come from news only. Exact duplicate source text is excluded.

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

- `contracts.ts`: Phase 2 input types and agent output schemas; finding kinds and
  report types come from the shared [`../contracts`](../contracts/README.md) package.
- `load-data.ts`: demo disk adapter (no validation).
- `pipeline.ts`: coordination, timeouts and failure states.
- `agents/`: reviews/news instructions and structured outputs.
- `providers/`: OpenRouter and mock adapters.
- `processing/`: preparation, verification and scoring.
- `policy/rubric.json`: scoring weights (loaded with `loadRubric`).
- `config.ts`: red-flag kinds and which agent may report each.

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
