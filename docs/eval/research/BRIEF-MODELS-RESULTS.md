# External case-brief model comparison — 2026-10-28

Six models through the production case-brief agent, frozen Tavily fixture, and
production `validateAndBuild` pipeline. The model comparison used 3 cases × 3
trials = 54 runs; tuning later extended the suite to 20 cases. GLM 5.3 and Kimi
K3.1 Pro were dropped; GPT-6.1 Terra added.

```powershell
pnpm --filter @credit/research eval:brief -- --trials=3
# per-model sweep: BRIEF_EVAL_MODEL=<model> BRIEF_EVAL_JUDGE_MODEL=openai/gpt-6.1-terra
```

Raw results: `apps/research/eval/results/brief-2026-10-28T05-*.json` (local, gitignored).

## Results

`pass` is code-only: expected adverse/registry/collision outcome, zero
forbidden/protected/PII, no injection leak, and citation validity. The support
judge is pinned to GPT-6.1 Terra for every answerer; `entity` is the model's
own entity-match confidence (a quality signal, not a pass gate).

| Model | pass@1 | pass^3 | Support | Citation | Official | Indep. | Entity | Safety | Mean | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Sol | **1.000** | **3/3** | 1.00 | 1.00 | 1.00 | 1.33 | **0.83** | clean | 18.2s | $0.177 |
| GPT-6.1 Terra | **1.000** | **3/3** | 1.00 | 1.00 | 1.00 | 1.33 | 0.20 | clean | 15.3s | $0.190 |
| Claude Opus 5.5 | 0.889 | 2/3 | 0.94 | 1.00 | 1.00 | 1.22 | 0.78 | 1 raw forbidden hit | 25.8s | $0.358 |
| DeepSeek V4.1 Flash 1017 | 0.667 | 2/3 | 1.00 | 1.00 | 0.67 | 1.00 | 0.67 | 1 raw forbidden hit | 10.4s | $0.198 |
| Meta Muse Wonder | 0.111 | 0/3 | 0.11 | 0.78 | 0.11 | 0.11 | 0.11 | clean | 21.4s | $0.225 |
| Gemini 4 Argon | 0.000 | 0/3 | — | — | — | — | — | n/a | 5.3s | $0.000 |

Gemini failed all 9 trials with `400 Provider returned error` before any
output; it is a provider/schema incompatibility, not a measured quality zero.
Exclude it from the ranking.

## Judge's reading

- **GPT-6.1 Sol (best):** finds the adverse/registry facts, cites the official
  source, keeps the collision/name-only limitations explicit, and links the
  registration number from the source URL. Entity confidence 0.83 is the best
  in the suite.
- **GPT-6.1 Terra:** passes every code gate and is slightly cheaper/faster,
  but entity confidence is 0.20: it treats the filing as name-only and does
  not use the registration number present in the URL/record. For a brief whose
  job is entity disambiguation, that is a real quality gap.
- **Opus:** 8/9, with a strong entity score (0.78), but one raw forbidden hit
  and higher cost. Second-best transcripts.
- **DeepSeek:** 6/9; misses the official-source requirement in one case and
  has one forbidden hit. Good cost/latency, not as reliable.
- **Muse:** 1/9. It writes findings but often emits no `evidence` array, so
  the validator drops every finding; one clean trial only.
- **Gemini:** cannot run the brief path (400).

## Tuning follow-up (2026-10-28)

A brief-preflight ablation was worse (entity 0.72 vs 0.83, cost $0.27 vs
$0.18), so the mandatory server-side adverse/registry preflight stays. Prompt
`v7` added the registration-number rule; on the same 3 cases × 3 trials Sol
kept 9/9 pass and entity match rose from 0.833 to **1.000**. See
`docs/eval/TUNING-2026-10-28.md`.

## Extended suite (20 cases)

The suite now has 20 fixture entities: the original three plus no-hit,
adverse-only, individual applicant, low-tier-only, long page, two adverse
findings, conflicting registry records, stale registry, and boundary as-of
cases. The 17 fixtures added since the original three (15 since the 5-case
predecessor) were authored after prompt `v7` and were not used for tuning; they
are held-out by construction, not by a formal split field.

Sol, preflight on, prompt `v7`, 20 cases × 3 trials:

- **60/60 pass, 20/20 pass^3**, $1.506, 17.4s mean / 21.2s p95.
- `lowtier-only` was revalidated 1 trial after the secondary-directory fixture
  and official-source gate were added (1/1 pass).
- Judge calibration: **19/20 agreement (0.95)** on the 20 hand-labelled
  claim/quote pairs in `eval/judges/brief-calibration.json`.
- Every entity resolves with no collision leak; no PII, raw-source, injection,
  or forbidden-language hits in any trial.
- The no-hit and adverse-only cases return zero/one findings without inventing
  a registry filing.

Raw: `brief-2026-10-28T14-13-13-512Z.json` (20-case, 3 trials);
`brief-2026-10-28T12-43-00-996Z.json` (5-case predecessor).

## Verdict

**Superseded 2026-11-02:** Terra at high effort matches Sol and is now pinned (see the sweep section below).

**GPT-6.1 Sol wins the case brief** (at the provider-default effort): perfect pass@3, best entity grounding,
clean safety, and lower cost than Opus. Terra is the cheap tie on the code
gates but its weak entity matching makes it the wrong default for this agent.

## Caveats

- The comparison is 3 hand-built entities; the extended suite has 20. The 17
  fixtures added since the original three (15 since the 5-case run) are held-out
  by construction, not a formal split; this is not a population sample.
- `conflict`/`multiadverse`/`stale` assert category and entity presence, not a
  two-record contradiction or a staleness verdict. The preflight may extract
  only the first hit, so these are directional.
- The low-tier-only case checks that a secondary directory is fetched but not
  promoted to a registry finding; it is not an official-register test.
- The support judge is pinned to Terra, so Terra's own runs have
  self-preference bias; the code pass does not depend on the judge. The 20-label
  calibration (0.95) is on Sol's judge, not Terra's.
- Raw results are gitignored; costs are projected list prices.

## Reasoning-effort sweep (2026-11-02)

The case brief now runs **Terra at `high`** (`AGENT_MODEL`,
`AGENT_REASONING_EFFORT`), superseding the Sol verdict above. 20 cases × 3
trials, preflight on, prompt `v7`, Terra support judge; see the [reasoning-effort sweep](../reasoning-effort-2026-11-02.md).

| Run | pass@1 | pass^3 | Entity (original 3) | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|
| Sol medium (above) | 1.000 | 20/20 | 0.83 | 17.4s / 21.2s | $1.506 |
| **Terra high** | **1.000** | **20/20** | **1.00** | 17.3s / 22.5s | $1.684 |

At medium, Terra's weak entity matching (0.20) was the reason Sol won; at high
it resolves all three original entities at 1.00. Overall entity mean is 0.75
because the no-hit fixtures correctly report 0. Repair and the support judge
stay pinned at `medium`. Raw: `brief-2026-11-01T21-21-44-171Z.json`.

## UBS demo cases and two-page adverse preflight (2026-11-05)

Change: the server preflight now extracts up to two `adverse_media` pages on
distinct registrable domains (registry keeps one; total preflight extracts
`min(3, AGENT_MAX_FETCHES)`), and the prompt (v8, agent 1.1.0) tells the model
to cite every page that states the same adverse fact. Before, one extracted
page meant a news-only adverse finding was always single-source and capped at
`low` by the unchanged validator rule (one official or two independent
sources).

Dataset: the 20-case suite plus two frozen demo cases with real company
identities and synthetic paraphrased page text: `demo-envy-two-source-adverse`
(two independent news pages, no official adverse page; expects a
high-confidence adverse finding) and `demo-breadtalk-clean` (one benign
business article; expects no adverse finding). Model GPT-6.1 Terra (high),
support judge GPT-6.1 Terra. Pass definition unchanged (code-only).

| Run (in order) | Cases | pass@1 | pass^3 | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|
| Envy v8, first fixture (second page reports a different fact) | 1 | 0/3 | 0/1 | — | $0.195 |
| Envy v8, edited fixture | 1 | 3/3 | 1/1 | 47.6s / 62.5s | $0.188 |
| Envy v7 preflight + prompt, edited fixture (A/B, run after) | 1 | 0/2 | — | — | $0.092 |
| Full suite, v8 draft | 22 | 66/66 (1.000) | 22/22 | 21.5s / 38.9s | $2.004 |
| Envy, v8 draft, rerun after review | 1 | 2/3 | 0/1 | — | $0.205 |
| Full suite, final v8 (claim-wording rule) | 22 | 66/66 (1.000) | 22/22 | 22.6s / 44.5s | $2.070 |
| Envy, final v8, extra trials | 1 | 5/5 | — | — | $0.274 |

The draft v8 rerun failed once because the model wrote “Two news reports
said…”, which the support judge rejected; the final v8 adds one rule (write
the claim as the fact itself, with a BAD/GOOD example). Envy on final v8:
8/8 across two runs.

Raw results: `apps/research/eval/results/brief-2026-11-05T15-03-30-028Z.json`
(final full suite), `brief-2026-11-05T15-08-46-970Z.json` (Envy extra
trials), `brief-2026-11-05T14-34-24-722Z.json` (draft rerun),
`brief-2026-11-05T13-22-25-173Z.json` (v7 A/B), and the earlier
`brief-2026-11-05T13-20-25-465Z.json` / `13-47-25-091Z.json`; local,
gitignored.

Caveats: the Envy fixture's second page was edited once after the first run so
that it reports the same charge as the first page, as real coverage did; with
two different adverse facts the model correctly cites each page separately and
neither finding reaches `high`. The live demo still depends on what Tavily
returns for the real company; this fixture proves the mechanism, not the live
search. Preflight now spends three of the four default extracts, leaving one
for model drill-down. The two demo cases were authored alongside v8 (in-sample,
dev); there is no held-out split for this harness. Cost basis for these rows:
the harness's projected ceiling ($5/$10 per M tokens, `projectCostUsd`), not
billed cost. Raw first-fixture run: `brief-2026-11-05T13-14-11-436Z.json`.
