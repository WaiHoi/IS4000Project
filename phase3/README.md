# Phase 3 — combine scores and apply review policy

Standalone TypeScript package. No API key, LLM, frontend, server or Python needed.
The default score direction is 0–100, higher means safer.

## Run (Windows/macOS)

Install Node.js 22+, then:

```sh
# Shared contracts (finding kinds, Phase 2 report types) must be built first.
cd contracts
npm ci
npm run build
cd ../phase3
npm ci
npm run demo
```

Demo input is read from `data/<case>/phase1.json` and `phase2.json`. Results go to
`output/<case>.json`. The included snapshots were generated from the actual
Phase 2 mock provider; they are fictional examples, not lending evidence.

```sh
npm run demo -- --case litigation
npm run demo -- --list
npm test
npm run typecheck
npm run build
npm start -- --case healthy-business
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

## Run with your real Phase 2 result

After Phase 2 has generated an OpenRouter report, from the `phase3/` folder:

```sh
npm run demo -- --phase1 ./data/healthy-business/phase1.json --phase2 ../phase2/output/healthy-business.openrouter.json
```

The inputs must have the same business ID. The external-file mode writes
`output/external.json`. Re-running the same case replaces its report; this is a
local testing utility, not a durable audit store. No model requests are made by
Phase 3, regardless of which provider produced the supplied Phase 2 file.

## Phase 1 contract

Your friend's traditional scorer must return at least:

```json
{
  "businessId": "DEMO-BAKERY-01",
  "score": 85,
  "coverage": 1,
  "missingFields": []
}
```

Use a null score and zero coverage when financial data is insufficient to produce
a score. Coverage is the fraction of available financial-factor weight, not a
probability of correctness. Additional fields are accepted. The old Python scorer
needs an adapter to add business identity and map its fields into this contract.

## Phase 2 contract

Pass the existing Phase 2 result directly. Required fields include schema version,
business identity, provider, status, score, confidence, findings, red flags,
evidence, warnings, gaps and agent statuses. Extra Phase 2 fields are preserved
through parsing but are not all copied into the assessment. Keep the full Phase 2
report alongside this result to provide source drill-down in the frontend.

Adverse findings are checked against same-business news evidence and exact quotes.
Unsupported flags reject the input; they are never silently discarded. Flags are
derived from both `findings` and `redFlags`, preventing an omitted redFlags entry
from bypassing policy. As with Phase 2, quote matching checks provenance, not
whether the allegation is true. Score/coverage inputs are trusted computed outputs
from your backend, not intended to be entered by unauthenticated clients.

## Rules

```text
effective weight = 0.30 × Phase 2 confidence
composite = (1 − weight) × traditional + weight × unstructured
```

- Composite scores are rounded to two decimals before classification.
- Low: 70+; Medium: 40 to below 70; High: below 40.
- No alternative evidence: weight zero, retain the traditional score.
- No traditional score: no composite score or automatic band; request information.
- Red flags follow the `severity` table in `policy/default.json`. Phase 2's AI
  reports only the kind; the table decides the action:

  | Severity | Kinds | Action |
  |---|---|---|
  | critical | fraud, insolvency, regulatory_action | No automatic band; manual review (composite kept for explanation) |
  | major | litigation, payment_distress, licence_issue, operational_distress | Low capped at Medium (High stays High); manual review |
  | review | other_adverse | Manual review; band unchanged |
  | minor | governance_issue | Warning only |

  A flag supported only by customer reviews uses `reviewOnlySeverity` instead
  (by default one level lower: critical → major, major → minor). Edit the JSON to
  change policy; no code changes are needed.
- Partial/failed Phase 2 analysis or incomplete financial coverage: manual review.
- Mock-derived results are explicitly labelled in warnings.

Review status is separate from risk band. `Ready` means ready for analyst review,
not approved. All credit decisions remain with the analyst. Critical flags can
require manual review even when financial data is missing; data gaps still appear.
There is no automatic approve/decline or trained default probability.

## Import into the backend

Build the folder, then from the consuming backend run `npm install /path/to/phase3`.

```ts
import { assessPhase3, loadPolicy } from '@credit-copilot/phase3';

const policy = await loadPolicy(); // policy/default.json, or loadPolicy('/path/to/policy.json')
const result = assessPhase3(traditionalResult, phase2Result, policy);
```

`assessPhase3` is synchronous, pure and deterministic, with no environment loading,
filesystem access, network calls or hidden dependency on the Phase 2 package.
Load the policy once with `loadPolicy` and pass it in.
Your workflow calls Phase 2 first and passes the result into Phase 3.

`result` includes input scores/coverage, actual blend weight, composite score and
band, final band, review status, cited policy overrides, warnings, data gaps and
the policy snapshot. Phase 4 can consume this to display an assessment and record
the analyst's decision.

## Policy configuration

Policy is data, not code. The default is [`policy/default.json`](policy/default.json):
blend weight, band thresholds, the red-flag `severity` table and
`reviewOnlySeverity`. Change policy by editing that file, or copy it and pass the
copy with `--policy`:

```sh
npm run demo -- --case healthy-business --policy ./my-policy.json
```

- Every policy file must be complete. It is validated before any assessment:
  every red-flag kind must have a severity, unknown or misspelt kinds and
  severities are rejected, and Medium must be below Low.
- Change `version` whenever you change values. The full policy, including the
  severity table, is copied into every assessment, so each result shows exactly
  which policy produced it.
- Red-flag kinds come from the shared [`../contracts`](../contracts/README.md)
  package. Adding a kind there makes every policy file without it invalid, so the
  new kind cannot be silently ignored.

Weights and thresholds are prototype choices to evaluate on held-out data, not
validated credit policy.

## Files and ownership

- `contracts.ts`: integration contracts and runtime validation.
- `assess.ts`: blending and review policy orchestration.
- `classify.ts`: threshold classification.
- `verify-inputs.ts`: adverse evidence checks.
- `policy/default.json`: default policy (weights, thresholds, severity table).
- `load-data.ts`: case and policy file loading (`loadPolicy`).
- `cli.ts`: file-based testing adapter.
- `index.ts`: public import interface.
- `tests/`: boundaries, missing data, caps, critical findings and file integration.

See [COMMANDS.md](COMMANDS.md) for commands and [data/README.md](data/README.md)
for adding input cases.
