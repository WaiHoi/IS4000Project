# Explainability phase

Standalone TypeScript stage between Phase 3 and Phase 4:

```text
Phase 3 assessment + Phase 2 evidence
                  ↓
Memo agent → critic agent → deterministic checks
                  ↑           ↓
             bounded retry    verified memo or warning report
```

## Install and test offline

Use Node.js **22.13+** on Windows or macOS. From the project root:

```sh
# Shared contracts (Phase 2 report and Phase 3 assessment types) must be built first.
cd contracts
npm ci
npm run build
cd ../explainability
npm ci
npm run demo -- --case healthy-business --provider mock
npm test
npm run typecheck
npm run build
```

Mock mode uses a template writer and a stub critic. It exercises the flow but
does not perform real AI interpretation. Reports are saved in
`output/healthy-business.mock.json`. On Windows use `npm.cmd` if PowerShell blocks npm.

## Real memo and critic agents through OpenRouter

Edit **explainability/.env**, copying `.env.example` if needed:

```dotenv
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=your-selected-model-id
# Optional: a different model for the critic, for a more independent review.
OPENROUTER_CRITIC_MODEL=another-model-id
```

Choose models with structured-output support, then:

```sh
npm run demo -- --case healthy-business
```

The CLI defaults to OpenRouter. The OpenAI Agents SDK manages two specialists,
but all model requests go to OpenRouter; no OpenAI key or tracing is used. This
package loads its own `.env`, not `phase2/.env`. No credentials are copied between
folders. Real mode incurs API usage charges. By default at most three memo
attempts are made (`maxRetries` in the memo policy). Each attempt can call both
writer and critic. There is no silent mock fallback.

If `OPENROUTER_CRITIC_MODEL` is unset, the critic uses the writer's model and the
report warns that its review is not independent. Each report records the writer
model, critic model and a `promptVersion` hash of both agents' instructions and
settings (`model`), so results can be traced and compared.

## Data and integration

Each case is a JSON bundle in `data/<case>/input.json`:

```text
{
  assessmentId: "a unique ID for this assessment",
  assessment: <full Phase 3 result>,
  phase2: <full Phase 2 result with findings and accepted evidence>
}
```

The included files are editable snapshots from actual offline Phase 2/3 runs.
To use a different bundle:

```sh
npm run demo -- --input /path/to/input.json --provider mock
```

For a backend, build the package and install it with
`npm install /path/to/explainability`, then:

```ts
import { explainAssessment } from '@credit-copilot/explainability';

const report = await explainAssessment({
  assessmentId, assessment: phase3Result, phase2: phase2Result,
}, { provider: 'openrouter' });
```

The backend loads its own environment. Library calls default to mock unless a
provider is explicit. Imports have no model calls, CLI execution or file writes.
Neither scores nor credit policy are recalculated in this stage.

## Verification and failure handling

Memo output is structured: exact scores, final risk band, review status, cited
qualitative claims and limitations. Code checks IDs, contiguous source quotes,
metric equality, required citations and basic protected-attribute terms. Numeric
metrics, bands and decisions cannot be added to free-form narrative; the renderer
uses validated structured values. The critic separately checks semantic support
and inappropriate reasoning. Both must pass.

**Bad news cannot be left out.** Every Phase 3 override's evidence must be cited,
and so must every Phase 2 finding or Phase 3 red flag whose kind is in the policy's
`requiredCitationKinds` (by default negative reviews and all red-flag kinds), even
a minor red flag that only produced a warning.

### Memo policy (data, not code)

The rules are in [`policy/memo.json`](policy/memo.json): `maxRetries`,
`requiredCitationKinds`, `forbidDigitsInNarrative`, `forbiddenNarrativeTerms` and
`protectedTerms` (whole words; a trailing `*` matches any ending, e.g. `pregnan*`).
Edit the file (bump `version`) or pass a copy with `--policy`. The policy is
validated before any AI call and copied into every report (`policy`). Phase 4
re-checks a verified memo with the recorded policy; reports from before policy
recording get structural checks only.

Failed checks feed back into the next attempt. On exhaustion or provider failure,
`status` is `warning`, `memo` is null, and a deterministic assessment summary is
returned. The analyst sees warnings instead of an unchecked draft. CLI exit code
is nonzero for warning results, even though a report was saved. Attempt records
retain check outcomes; this is not a full model trace system.

`verified` means the configured checks passed, not that allegations are true or
the credit recommendation is correct. An LLM critic can miss errors; regex checks
are not comprehensive fairness/PII screening. Source quotes establish provenance,
not truth. Mock reports explicitly warn that no AI review occurred.

The report includes the assessment ID, canonical assessment digest, assessment
snapshot, cited evidence, rendered memo, attempts and warnings. The digest binds
the report to a version of the assessment; it is not a digital signature.

## Files

- `contracts.ts`: memo, critic, memo-policy and inter-phase schemas. Phase 2 and
  Phase 3 types come from the shared [`../contracts`](../contracts/README.md)
  package; compile-time checks fail if those outputs stop matching.
- `policy/memo.json`: memo rules (loaded with `loadMemoPolicy` in `policy.ts`).
- `pipeline.ts`: generation, critique, bounded retries and digest.
- `verify-memo.ts`: deterministic checks and rendering.
- `providers/openrouter-provider.ts`: real memo and critic agents.
- `providers/mock-provider.ts`: offline template and critic stub.
- `cli.ts`: file-based local testing.

Keep `contracts.ts` compatible with Phase 3's public result. Phase 4 imports this
package's schemas to validate the same explainability output.

See [COMMANDS.md](COMMANDS.md). SDK transport follows
[OpenAI model-provider guidance](https://developers.openai.com/api/docs/guides/agents/models)
and [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
