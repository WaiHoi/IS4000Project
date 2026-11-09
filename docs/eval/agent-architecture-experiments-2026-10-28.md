# Agent architecture experiments (2026-10-28)

> Imported 2026-11-10 from the uncommitted `agent-experiments` OpenCode worktree
> (session 2026-10-28). The harness (`scripts/lib/agent-experiments.ts`) and raw
> logs were not merged into this branch, so the reproduce commands below need that
> worktree. Production defaults were not changed by these runs; the shipped
> strict-schema fixes are recorded in [context models](research/CONTEXT-MODELS-RESULTS.md)
> and [tuning](TUNING-2026-10-28.md) §10.

Status: experiment, not a supported capability. Run in the
`agent-experiments` worktree; production defaults are unchanged.

Question: does adding a helper sub-agent, a reviewer sub-agent, a workflow
"skill", or a stronger-model advisor improve the five agentic features?

Agents (the five `@openai/agents` runners):

| Agent                   | Feature key         | Eval                                   |
| ----------------------- | ------------------- | -------------------------------------- |
| Case brief              | `case_brief`        | `pnpm --filter @credit/research eval:brief` |
| Context analyst         | `context_analyst`   | `pnpm --filter @credit/research eval:context` |
| Credit memo writer      | `credit_memo`       | `pnpm --filter @credit/applications eval:memo-agent -- --live` |
| Document integrity      | `document_integrity`| `pnpm --filter @credit/applications eval:integrity` |
| Policy exception        | `policy_exception`  | `pnpm --filter @credit/applications eval:policy-exception -- --live` |

The policy navigator (`apps/policy`) is a single-shot RAG call, not an
`@openai/agents` runner, so it is out of scope. The memo eval is a live smoke
(n=1) because its full suite is scripted.

## Harness

`scripts/lib/agent-experiments.ts` wraps the agent's fetch implementation.
No prompt or orchestrator code changed; the wrapper is passed from the eval
only (`fetchImpl` / the OpenAI SDK `fetch` option). `AGENT_EXPERIMENT` selects
one condition:

| Condition  | What it adds |
| ---------- | ------------ |
| `baseline` | nothing |
| `skills`   | append the feature's workflow checklist to the system prompt |
| `helper`   | one planning call by the same model before the first agent turn; the plan is injected as `<helper_plan>` |
| `reviewer` | after the final structured answer, `z-ai/glm-5.3` returns a corrected JSON object in the same schema; the validator still runs |
| `advisor`  | on a repair turn or a stuck answer (empty findings/rules, `needs_policy_owner`), `z-ai/glm-5.3` gives repair advice; one retry |

The helper and advisor are deliberately generic: they see only the messages
already in the request. Any extra-model failure falls back to the unmodified
call. The wrapper has a small unit check
(`scripts/test/agent-experiments.test.ts`).

Run conditions: main model `deepseek/deepseek-v4.1-flash-1017`, temperature 0
(brief/integrity/memo/policy-exception) or 0.1 (context, the production
default), the production prompts and validators. Variants were screened with
1 trial; the brief baseline used 3 trials as the reference. Costs do not
include the extra helper/reviewer/advisor calls; latency does include them.
The policy-exception screen uses the four memo dev cases that the recorded
baseline passes only 1/3 times (`memo-02..05`), because the full 17-case run
was too slow for a 5-condition sweep.

## Reproduce

```powershell
# brief
$env:AGENT_EXPERIMENT='skills'; pnpm --filter @credit/research eval:brief -- --trials=1
# context (pin the documented default; the root .env was carrying another model)
$env:CONTEXT_AGENT_MODEL='deepseek/deepseek-v4.1-flash-1017'
$env:AGENT_EXPERIMENT='helper'; pnpm --filter @credit/research eval:context -- --trials=1
# integrity
$env:AGENT_EXPERIMENT='reviewer'; pnpm --filter @credit/applications eval:integrity -- --split=dev --trials=1 --concurrency=1
# memo live smoke
$env:AGENT_EXPERIMENT='advisor'; pnpm --filter @credit/applications eval:memo-agent -- --live
# policy exception (hard memo subset)
$env:AGENT_EXPERIMENT='skills'; pnpm --filter @credit/applications eval:policy-exception -- --split=dev --trials=1 "--case=pe-memo-02,pe-memo-03,pe-memo-04,pe-memo-05" --delay=150 --live
```

`--case` accepts a comma-separated list in the policy-exception eval after this
experiment; a single id still works.

## Results

Numbers below are `pass@1` (trial pass rate). `same` means the delta is inside
the noise of these sample sizes.

| Agent              | Baseline        | Skills       | Helper       | Reviewer     | Advisor      |
| ------------------ | --------------- | ------------ | ------------ | ------------ | ------------ |
| Case brief (3)     | 7/9 (0.778)     | 3/3 (1.000)  | 1/3 (0.333)  | 3/3 (1.000)  | 3/3 (1.000)  |
| Context (3)        | 3/3 (1.000)     | 3/3 (1.000)  | 2/3 (0.667)  | 3/3 (1.000)  | 3/3 (1.000)  |
| Integrity (19)     | 18/19 (0.947)   | 19/19 (1.000)| 19/19 (1.000)| 19/19 (1.000)| 17/19 (0.895)|
| Policy exception (4 hard memo cases) | 3/4 (0.750) | 3/4 (0.750) | 0/4 (0.000) | 3/4 (0.750) | 3/4 (0.750) |
| Memo (live smoke)  | valid, 10 steps | valid, 16    | valid, 12    | valid, 12    | valid, 14    |

### Case brief

| Condition | pass@1 | Cost    | Mean / p95 latency | Failure |
| --------- | -----: | ------: | ------------------ | ------- |
| baseline  | 7/9    | $0.2042 | 10.0 s / 22.5 s    | one truncated JSON; one independent-source miss |
| skills    | 3/3    | $0.1068 | 20.5 s / 36.0 s    | none |
| helper    | 1/3    | $0.0585 | 8.5 s / 12.5 s     | helper plan suppressed the adverse findings on two cases |
| reviewer (schema-aware) | 3/3 | $0.1045 | 15.3 s / 20.2 s | none |
| advisor   | 3/3    | $0.1280 | 20.3 s / 33.9 s    | none; the advisor path did not trigger |

The first reviewer run was schema-blind and scored 2/3: GLM invented an
invalid `allegationStatus` enum. After passing the request's JSON schema to
the reviewer, the same condition scored 3/3.

### Context analyst

| Condition | pass@1 | First pass | Cost    | Latency |
| --------- | -----: | ---------: | ------: | ------- |
| baseline  | 3/3    | 3/3        | $0.1981 | 9.2 s / 17.6 s |
| skills    | 3/3    | 2/3        | $0.2741 | 9.9 s / 19.8 s |
| helper    | 2/3    | 3/3        | $0.0964 | 6.6 s / 17.4 s |
| reviewer (schema-aware) | 3/3 | 3/3 | $0.1062 | 20.8 s / 34.3 s |
| advisor   | 3/3    | 3/3        | $0.2694 | 14.0 s / 20.0 s |

Helper dropped the sparse-case data gaps (`gaps=0`, `keywords=0`). The first
(schema-blind) reviewer run invented `signals[0].localId` and failed schema
validation on BreadTalk; passing the request's JSON schema fixed it.

### Document integrity

| Condition | pass@1 | Cost    | Mean / p95 latency |
| --------- | -----: | ------: | ------------------ |
| baseline  | 18/19  | $0.1359 | 8.1 s / 23.1 s |
| skills    | 19/19  | $0.1515 | 7.3 s / 20.8 s |
| helper    | 19/19  | $0.1420 | 7.5 s / 22.7 s |
| reviewer  | 19/19  | $0.1413 | 21.7 s / 41.1 s |
| advisor   | 17/19  | $0.1342 | 8.7 s / 22.4 s |

The baseline's one failure was `triage-benign-explanation` (`INVALID_OUTPUT`);
skills, helper and reviewer each fixed it, while advisor flipped two different
cases (`consistency-statement-period-match`, `safety-injection-brief`). With
one trial per case these are single-case flips: integrity is effectively
saturated and no condition shows a reproducible gain. The reviewer accuracy is
the same but mean latency is ~2.7x; that run used the schema-blind reviewer
(see caveats).

### Policy exception (hard memo subset)

| Condition | pass@1 | Cost    | Mean / p95 latency |
| --------- | -----: | ------: | ------------------ |
| baseline  | 3/4    | $0.0311 | 42.2 s / 57.8 s |
| skills    | 3/4    | $0.0276 | 41.3 s / 68.4 s |
| helper    | 0/4    | $0.0137 | 50.0 s / 88.6 s |
| reviewer  | 3/4    | $0.0274 | 35.7 s / 39.6 s |
| advisor   | 3/4    | $0.0260 | 33.4 s / 50.1 s |

The baseline failure was `memo-05` (`INVALID_OUTPUT` after the single repair);
skills, reviewer and advisor did not rescue it (the advisor had the best shot,
because the repair turn is exactly where it fires). Helper made all four cases
fail (two `INVALID_OUTPUT`, two semantic `unknown`) and the surviving runs got
slower.

## Second pass: GPT-6.1 Sol and skill delivery

The first pass put the checklist *in the system prompt*. This pass tests
moving it behind a `load_skill` tool (progressive disclosure) and trimming the
system prompt, and swaps the main model to `openai/gpt-6.1-sol`.

- `skills-tool`: the wrapper injects a `load_skill` function, executes the
  tool round itself, and then lets the agent continue. The production agent
  never needs a tool implementation. A debug run confirmed the model calls it
  (`[experiment] loaded case_brief skill`).
- `skills-tool-lean`: same, plus trims blocks the tool schemas already carry.
  Brief system prompt 3,900 -> 3,436 chars (removed the Tools list and the
  BAD/GOOD examples); context removes the 12-line tool list.
- `AGENT_EXPERIMENT_RELAX_TOOLS=1` sets `function.strict=false`. OpenAI/Azure
  reject the repo's optional tool parameters (e.g. `get_transactions.cursor`
  is not in `required`), so context, integrity and memo 400 before the first
  token without this. The brief tools were already strict-compatible. This is
  a portability blocker for a production model swap.

| Agent / condition       | DeepSeek        | GPT-6.1 Sol     |
| ----------------------- | --------------- | --------------- |
| Brief baseline          | 7/9 (0.778)     | 3/3 (1.000)     |
| Brief skills            | 3/3 (1.000)     | 2/3 (0.667)     |
| Brief skills-tool       | 2/3 (0.667)     | 2/3 (0.667)     |
| Brief skills-tool-lean  | not run         | 2/3 (0.667)     |
| Context baseline        | 3/3 (1.000)     | 3/3 (1.000)     |
| Context skills          | 3/3 (1.000)     | 3/3 (1.000)     |
| Context skills-tool     | not run         | 3/3 (1.000)     |
| Context skills-tool-lean| not run         | 3/3 (1.000)     |
| Integrity baseline      | 18/19 (0.947)   | 19/19 (1.000)   |
| Policy hard baseline    | 3/4 (0.750)     | 4/4 (1.000)     |
| Memo live smoke         | valid, 10 steps | valid, 3 steps  |

The GPT skill rows above use the v1 checklist; the quality pass below uses the
v2 rule and supersedes them.

Cost and latency (GPT): brief baseline $0.0569 / 18.5 s mean; skills $0.0598 /
20.5 s; skills-tool $0.0614 / 22.1 s; lean $0.0609 / 19.6 s. Context baseline
$0.3035 / 18.2 s; skills $0.2961 / 13.8 s; skills-tool $0.2974 / 14.6 s; lean
$0.2885 / 20.4 s. Integrity $0.098 / 10.0 s (DeepSeek $0.136 / 8.1 s). Policy
hard subset $0.0744 / 15.3 s (DeepSeek $0.0311 / 42.2 s). Memo used 3 steps and
2 tool calls (DeepSeek 10 and 9).

### What this pass says

- **GPT-6.1 Sol is equal or better on every baseline** and fixes the two
  hard failures: policy memo-05 (4/4) and integrity (19/19). It is much faster
  on the policy memo path and much more economical on the memo agent (3 steps
  vs 10). Context is ~1.5x the cost. The strict-tool-schema incompatibility is
  the real migration work.
- **With the v1 skill, tool delivery did not beat the system prompt.** The
  skill loaded (verified) but the brief dropped from 3/3 to 2/3 on both
  models. On context every delivery was 3/3, so it was neutral there.
- **Reducing the system prompt did not recover the lost case.** The lean
  variant cut 464 chars from the brief prompt and the 12-line tool list from
  context; accuracy was unchanged (brief 2/3) and latency moved within noise.
  The prompt bloat was not the cause.
- **The v1 skill content was the cause of the brief regression.** On GPT,
  every skill variant returned one finding on `acme-adverse` with
  `adverse=false`, while baseline returned two. The rule "a second independent
  source is required for adverse findings" was stricter than the production
  prompt and made the model drop the court judgment. The v2 rule fixed it:
  with 3 trials, baseline, system prompt, and tool are all 9/9. Delivery is
  neutral once the content is right; the tool costs ~26% more on context.

## Quality pass (3 trials, GPT-6.1 Sol)

Changes on this pass:

- **Tool schemas are now strict-compatible.** Optional params are nullable and
  required: `get_transactions.cursor`, `search_pages.limit`, and the memo
  `sourceType`/`limit` pairs. The handlers treat null as "not supplied". The
  context, integrity and memo smokes pass without
  `AGENT_EXPERIMENT_RELAX_TOOLS`, so the quality path is the schema fix, not
  `strict:false`.
- **Skill v2** no longer requires a second independent source for an adverse
  finding. It says: record the adverse fact, put the source count in
  limitations.
- Three trials per condition, no held-out split, no `strict:false`.

| Agent / condition        | pass@1        | pass^3       | Cost    | Mean / p95 |
| ------------------------ | ------------- | ------------ | ------: | ---------- |
| Brief baseline           | 9/9 (1.000)   | 3/3 (1.000)  | $0.1790 | 20.2 s / 27.4 s |
| Brief skills v2          | 9/9 (1.000)   | 3/3 (1.000)  | $0.1863 | 19.1 s / 23.9 s |
| Brief skills-tool v2     | 9/9 (1.000)   | 3/3 (1.000)  | $0.1818 | 18.6 s / 22.4 s |
| Context baseline         | 9/9 (1.000)   | 3/3 (1.000)  | $0.8759 | 15.9 s / 27.0 s |
| Context skills v2        | 9/9 (1.000)   | 3/3 (1.000)  | $0.9188 | 15.4 s / 23.8 s |
| Context skills-tool v2   | 9/9 (1.000)   | 3/3 (1.000)  | $1.1040 | 17.4 s / 27.1 s |

The v2 skill removed the regression: brief is 9/9 for baseline, system
prompt, and tool. Brief skills-tool is 1.6 s faster than baseline and
$0.003 more expensive per trial; the difference is noise. Context is
saturated at 9/9 everywhere; the tool adds ~26% cost ($1.10 vs $0.88) for no
quality gain. The strict schema fix also passes on DeepSeek (context and memo
smokes), so the nullable fields are not a GPT-only change.

### What the 3-trial pass says

- **The current brief/context suites are saturated for GPT-6.1 Sol.** Baseline
  is 9/9 on both. The skills variants cannot show a quality gain on this
  dataset; they only add tokens/calls. A 9/9 baseline is the signal to grow the
  dataset, not to tune the prompt further.
- **Tool delivery is quality-neutral once the skill content is right.** Brief
  is 9/9 across baseline, system prompt, and tool. Context is 9/9 too, at ~26%
  more cost for the tool. Prefer the system prompt for simplicity; use the tool
  only if progressive disclosure is needed for prompt-size/versioning.
- **The real model-swap work is the tool contract.** Nullable-required fields
  fixed GPT's 400s and still pass on DeepSeek. `strict:false` is a fallback, not
  the quality path.
- **The remaining quality headroom is in the hard cases, not the small
  suites.** Integrity and the policy memo subset are where GPT moved
  (18/19 -> 19/19, 3/4 -> 4/4). The next quality run should be 3 trials on
  those suites, not more brief/context prompt edits.

## Read

- **On DeepSeek, skills is the safest condition.** It passed every brief and context case,
  kept integrity saturated (19/19), and left the policy hard subset unchanged.
  It adds no model call. The samples are small: the brief baseline is 7/9 over
  9 trials, so 3/3 is directionally better but not significant, and the
  integrity flips are single-case noise.
- **On DeepSeek, a helper planning agent is the clear loser.** It suppressed adverse
  findings on the brief (1/3), suppressed the sparse data gaps on the context
  analyst (2/3), and made all four policy memo cases fail (0/4). A generic
  "be careful" plan is worse than no plan.
- **The reviewer only works when it gets the schema.** Schema-blind, GLM 5.3
  rewrote valid output into schema-invalid output (brief
  `allegationStatus`, context `localId`), scoring 2/3 on both. With the
  request's JSON schema in the prompt it scored 3/3 on both. Accuracy is
  neutral-to-slightly-better; latency is 1.5-2.7x. On the policy memo subset
  (no response schema is supplied by that runner) it was neutral (3/4).
- **The advisor is neutral everywhere.** It fires only on repair/stuck paths;
  the brief and context runs never triggered it, so their 3/3 is baseline
  variance. On the policy memo subset it had the clearest trigger (memo-05's
  repair) and still did not rescue the malformed JSON (3/4, same case fails).
- **The memo smoke cannot separate the conditions.** All five runs produced
  valid output; skills and advisor did more tool work (16/14 steps and
  14/12 steps) for the same validation result.
- **GPT-6.1 Sol beats DeepSeek on the baselines.** 3/3 vs 7/9 on the brief,
  19/19 vs 18/19 on integrity, 4/4 vs 3/4 on the hard policy memos, and 3 steps
  vs 10 on the memo agent. The only cost is the strict-tool-schema work and
  ~1.5x context cost.
- **The skill delivery mechanism is not the win.** `load_skill` works, but the
  system-prompt version was equal or better. The skill's content, especially
  the adverse-source rule, is what moved the brief result. Test the content
  before investing in progressive disclosure.

## Caveats

- One trial per variant; three trials only for the brief baseline. Pass rates
  on 3 cases carry wide Wilson intervals (3/3 is 0.44-1.00); do not quote
  these as generalisation numbers.
- Latency and cost are noisy and the API was under mixed load. Extra-model
  cost is not counted in the tables.
- The helper is a planning call without tools, not a tool-equipped delegate.
  A helper that can search or fetch might behave differently.
- The integrity reviewer run was schema-blind; the brief and context reviewer
  runs were schema-aware. The policy-exception runner supplies no response
  schema, so its reviewer had no schema to follow. None of the reviewer runs
  were given validator errors or a validator round-trip.
- The policy-exception screen uses only the documented hard memo cases; it
  does not measure the explain/follow-up paths.
- No held-out split was touched.

## Next if this is pursued

1. Fix the brief skill's adverse-source rule and re-run `skills` vs
   `skills-tool` on GPT-6.1 Sol. The current rule suppresses the adverse
   finding; that is a content bug, not a delivery bug.
2. Adopt GPT-6.1 Sol as the main model only after making the tool schemas
   strict-compatible (put every property in `required` with nullable types,
   or explicitly set `strict:false` on every function tool). Budget ~1.5x for
   context.
3. Keep the reviewer schema-aware, and add a validator round-trip: pass the
   exact validator issues and keep the draft when the reviewer's output fails
   the same validator.
4. Test the advisor only on repair turns and count trigger rate and repair
   success separately.
5. Drop the helper as implemented; if delegation is wanted, give it the
   agent's tools and a narrow job (source triage, candidate screen).
