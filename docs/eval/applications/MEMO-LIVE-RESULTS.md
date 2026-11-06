# Live credit-memo eval — 2026-10-28 (historical)

> **Not the shipped memo.** This run predates prompt v5 and the deterministic
> composer: it scored raw `runMemoAgent` content, while production now composes
> `request`, `financial_analysis`, `debt_service`, `collateral_security`, and
> `policy_compliance` deterministically, with an optional tone rewrite for the
> first four. Treat the numbers below as historical model-quality evidence, not
> a current pass rate. Rerun with `--live` before quoting a current number. The current number is the
> [full v5 rerun (2026-11-05)](#full-v5-rerun-2026-11-05) below.

The scripted `memo-agent-eval.ts` covers mechanics only (bounds, repair,
validation, language). This is the missing model-quality eval: 22 evidence
bundles through the production `runMemoAgent`, `createAgentsMemoRunner`, and
`validateGeneratedText`, with a Terra judge.

```powershell
pnpm --filter @credit/applications eval:memo-live -- --trials=2 --budget-usd=8
```

Raw: `apps/applications/eval/results/memo-live-2026-10-28T14-10-49-640Z.json`
(local, gitignored).

## Dataset

22 cases: happy SME, individual applicant, sparse bundle, 20+ item bundle,
conflicting declared/bank facts, hostile injection in a document, missing
policy section, EWS/prior/default context, zero and negative values, long
document, decision-language temptation in case facts, duplicate evidence refs,
policy quote present/absent, no evidence, unavailable docs, stale signal,
multi-document, adverse external report, mixed score factors, and a
micro-loan/short-term case.

Pass is code-first: accepted, validator ok, full citation and section coverage,
no decision language, no injection echo, and 1..max tool calls. The judge scores
1–5 grounding and completeness on the first accepted trial per model+case; it is
advisory.

## Results

| Model | pass@1 | pass^2 | Judge grounding | Judge completeness | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|---:|
| **GPT-6.1 Sol** | **1.000** | **22/22** | **5.00** | 2.41 | **21.5s / 32.8s** | **$0.267** |
| GPT-6.1 Terra | 0.932 | 20/22 | **5.00** | 2.62 | 36.2s / 50.8s | $0.433 |

Terra's three failed trials are `INVALID_OUTPUT`: one `conflicting-facts` and
both `no-evidence` trials. Sol had none.

The pass gate also requires at least one claim when the bundle has items (a
zero-claim memo cannot pass on section bookkeeping alone). A Sol 1-trial rerun
after that gate change is still 22/22, judge completeness 2.64
(`memo-live-2026-10-28T14-51-52-328Z.json`).

**Pin: Sol.** Perfect structural pass, 1.6× cheaper, and 1.7× faster. The
`ASSIST_MEMO_MODEL` default is now `openai/gpt-6.1-sol`.

## Production fix exposed by the eval

The `@openai/agents` SDK forces `strict: true` on zod-declared tools. OpenAI
strict mode rejects a function schema whose optional properties are absent from
`required` (HTTP 400 `invalid_function_parameters`), so the live memo agent
could not call `list_evidence` or `search_evidence` with the old zod schemas.
Both tools now use plain JSON schemas with `strict: false`; runtime validation
still runs in `runMemoEvidenceTool`, so bad arguments remain tool errors in the
payload. This mirrors the earlier context `get_transactions` cursor fix.

## Judge completeness

Both models score 5/5 on grounding but ~2.4/5 on completeness: claims are
supported, yet the memo omits available documents, factors, or application
detail. A prompt A/B asking for exhaustive coverage was reverted: it raised
happy-path completeness but produced an invalid large-bundle draft, so it was
not a safe trade. Treat this as a known quality gap, not a pass/fail gate.

## Caveats

- Judge and generator share the OpenAI family; one judge call per model+case, no
  human calibration. Judge columns are advisory.
- Agent cost is token-project-based because the orchestrator drops the
  provider-billed cost; failed-trial usage is not recorded, so totals understate
  failures.
- The run used `memo-agent-v1` and scored raw agent prose. Prompt v3/v4 and
  the deterministic composer changed both, so the table is historical; see the
  header note.
- The scripted 9-case mechanics suite still runs separately and is not replaced
  by this eval.

## Prompt v5 style-rewrite subset (2026-11-05)

Not comparable to the 22-case run above. Two representative cases, one trial,
Sol low, Terra judge. Prompt v5 adds findings + a deterministic BASE SECTIONS
payload for `request`, `financial_analysis`, `debt_service`, and
`collateral_security`; the agent may rewrite tone only, and code falls back to
the deterministic text if any figure, citation ref, or security meaning drifts.
The judge now sees open items and questions and scores cross-source analysis
separately.

| Case | pass | Judge G / C / A | Cross-source claims | Findings tool |
|---|---:|---:|---:|---|
| `happy-sme` | 1.000 | 3 / 3 / 4 | 2 | used |
| `individual-applicant` | 1.000 | 3 / 4 / 4 | 1 | used |

The 22-case rerun is still pending; do not quote this subset as a full pass
rate. Raw: `memo-live-2026-11-05T08-56-06-675Z.json` (happy),
`…T08-59-55-476Z.json` (individual). A `conflicting-facts` trial also passed,
but its judge call failed (network); see `…T08-59-55-472Z.json`.

## Reasoning-effort sweep (2026-11-02)

Production now pins **Sol at `low`** (`ASSIST_MEMO_REASONING_EFFORT`). Same
22 bundles × 2 trials, Terra judge; see the [reasoning-effort sweep](../reasoning-effort-2026-11-02.md).

| Run | pass@1 | pass^2 | Judge G / C | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|
| Sol medium (above) | 1.000 | 22/22 | 5.00 / 2.41 | 21.5s / 32.8s | — |
| **Sol low** | **1.000** | **22/22** | 4.91 / 2.59 | **16.4s / 25.4s** | $1.009 |
| Terra high | 0.955 | 21/22 | 5.00 / 2.90 | 52.8s / 81.4s | $1.143 |
| Terra xhigh (`large-bundle-20` only) | 0/2 | — | — | 120s timeouts | — |

Terra high fails `large-bundle-20` (one `INVALID_OUTPUT`, one 120s timeout);
xhigh timed out on both trials, so the full xhigh run was skipped. The memo
harness now prices tokens at list price (Terra $1/$5, Sol $2/$10 per 1M); the
costs in the table above this section used a flat $1/M estimate and are not
comparable. Raw: `memo-live-2026-11-01T20-50-05-532Z.json` (Sol low),
`…T20-39-53-090Z.json` (Terra high), `…T20-42-22-973Z.json` (Terra xhigh).

## Full v5 rerun (2026-11-05)

All 22 bundles through the shipped path: `buildCreditMemo` + `runMemoAgent` +
`composeCreditMemo`, then `validateGeneratedText`. Generator GPT-6.1 Sol at
the pinned `low` effort (prompt/agent `memo-agent-v5`), judge GPT-6.1 Terra,
2 trials. Pass is the code gate (valid composed memo, no decision or echo
hits); the judge is advisory. This run also includes the new deterministic
fraud-review risk claim (none of the 22 bundles carries a fraud review).

| Model | pass@1 | pass^2 | Grounding | Completeness | Analysis | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Sol (low) | 42/44 (0.955) | 21/22 | 4.17 | 4.33 | 3.44 | 30.5s / 43.2s | $2.310 |

Both failures are `no-evidence` (2/2): with an empty bundle the model writes
open items whose `sourceRef` is not a bundle ref, schema validation rejects it,
and the run fails closed (`INVALID_OUTPUT`). No demo flow has an empty bundle.
Judge completeness is up from about 2.6/5 on the historical run, mostly because
code now composes the metric sections; judge grounding is down from 5.00 to
4.17 over the same comparison (advisory; the code gate still passes).

Raw: `apps/applications/eval/results/memo-live-2026-11-05T14-05-18-269Z.json`
(local, gitignored). Cost basis: agent cost projected from tokens at
OpenRouter list prices (Sol $2/$10 per M in/out, `PRICE_PER_M`), judge from
OpenRouter usage; failed trials record no usage, so the total understates
them. Judge and generator are the same model family; 18 of 22 cases were
judged.
