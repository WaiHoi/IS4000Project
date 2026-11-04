# Eval index

All eval reports and model comparisons live here. Result JSONs are gitignored
under each app's `eval/results/`; the datasets, harnesses, and judge rubrics
stay beside the code in `apps/<app>/eval/`.

Start with the [eval design](eval-design.md) for the method, then the
[model comparison](model-comparison-2026-10-28.md) for the cross-agent
scorecard and the [reasoning-effort sweep](reasoning-effort-2026-11-02.md) for the current
model/effort pins. [Tuning](TUNING-2026-10-28.md) records the A/B changes and the
P0/P1/P2 expansion.

## Headline

Pass@1 / pass^k from the latest refreshed runs at the pinned model and
reasoning effort ([sweep](reasoning-effort-2026-11-02.md)). Terra: context (low), policy
navigator/case review (medium), exception (low), case assistant (low), brief
(high). Sol: integrity (low), memo (low). The comparison reports also include
the earlier six-model sweeps.

| Agent               |    Cases | Model (effort) | pass@1 | pass^k |   Cost | Report                                                              |
| ------------------- | -------: | -------------- | -----: | -----: | -----: | ------------------------------------------------------------------- |
| Context analyst     |       37 | Terra (low) |  1.000 |  37/37 | $1.337 | [model comparison](research/CONTEXT-MODELS-RESULTS.md)              |
| Policy navigator    |       43 | Terra (medium) |  0.907 |  35/43 | $0.318 | [model comparison](policy/ANSWER-MODELS-RESULTS.md)                 |
| Document integrity  |       35 | Sol (low) |  0.990 |  34/35 | $0.539 | [model comparison](applications/INTEGRITY-MODELS-RESULTS.md)        |
| External case brief |       20 | Terra (high) |  1.000 |  20/20 | $1.684 | [model comparison](research/BRIEF-MODELS-RESULTS.md)                |
| Policy exception    |   17 dev | Terra (low) |  1.000 |  17/17 | $0.180 | [model comparison](applications/POLICY-EXCEPTION-MODELS-RESULTS.md) |
| Credit memo (live)  |       22 | Sol (low) |  1.000 |  22/22 | $1.009 | [live report](applications/MEMO-LIVE-RESULTS.md)                    |
| Case policy review  |       22 | Terra (medium) |  0.932 |  20/22 | $0.092 | [report](policy/CASE-REVIEW-RESULTS.md)                             |
| Case assistant      |       20 | Terra (low) |  1.000 |  20/20 | $0.215 | [model comparison](research/CASE-ASSISTANT-MODELS-RESULTS.md)       |

Context and policy also have Sol runs; memo and case review have Terra
comparisons in their reports. The exception row is the dev split only: the
held-out split was last run at medium (27/28 over 28 cases) and is not re-run
after tuning. Costs are harness projections and differ by harness; the memo
harness switched from a flat $1/M estimate to list prices in this sweep.
Known residuals: one long-document integrity miss, one dual-prohibited
exception case, ~2.6/5 memo completeness, and case-review coverage ~0.70. See
each report's caveats. The credit-memo 22-case row predates prompt v3/v4 and
the deterministic composer; it is historical. A three-case v4 subset passed
3/3 with judge grounding/completeness/analysis of 4/4/4, 3/4/4, and 3/5/3;
the full rerun is pending.

## Applications

- [Adverse-action letter](applications/ADVERSE-RESULTS.md) — deterministic EN-08 gate and letter eval.
- [Generated-text validator](applications/ASSIST-RESULTS.md) — deterministic EN-03 assist validator eval.
- [Document integrity](applications/INTEGRITY-RESULTS.md) — feature eval (2026-10-26 baseline).
- [Document integrity model comparison](applications/INTEGRITY-MODELS-RESULTS.md) — six models, hard-document extension.
- [Memo agent](applications/MEMO-AGENT-RESULTS.md) — scripted mechanics (bounds, repair, validation).
- [Live credit memo](applications/MEMO-LIVE-RESULTS.md) — 22 evidence bundles, Sol/Terra, judge.
- [Policy exception](applications/POLICY-EXCEPTION-RESULTS.md) — feature baseline (2026-10-27).
- [Policy exception model comparison](applications/POLICY-EXCEPTION-MODELS-RESULTS.md) — Terra/Sol, multi-turn and prohibited-rule extension.

## Policy

- [Embedding retrieval](policy/RESULTS.md) — 60 labelled queries, 30 dev / 30 held-out.
- [Policy navigator answers](policy/ANSWER-RESULTS.md) — answer eval and held-out extension.
- [Policy navigator model comparison](policy/ANSWER-MODELS-RESULTS.md) — six models, judge calibration.
- [Case policy review](policy/CASE-REVIEW-RESULTS.md) — 22 structured case contexts, Sol/Terra.

## Research

- [External case brief](research/BRIEF-RESULTS.md) — feature eval and refresh.
- [External case brief model comparison](research/BRIEF-MODELS-RESULTS.md) — six models, 20 fixtures, judge calibration.
- [Context analyst](research/CONTEXT-RESULTS.md) — feature eval and independent-customer refresh.
- [Context analyst model comparison](research/CONTEXT-MODELS-RESULTS.md) — six models, 30 windows + 7 independent customers.
- [Case assistant model comparison](research/CASE-ASSISTANT-MODELS-RESULTS.md) — Terra/Sol, 20 questions, five eval customers, code gates.
- [Tuning](TUNING-2026-10-28.md) — preflight A/Bs, prompt v7, and the P0/P1/P2 gap work.
- [Reasoning-effort sweep](reasoning-effort-2026-11-02.md) — low/high/xhigh on Terra, Sol low fallback, current pins.

## Commands

```powershell
pnpm --filter @credit/research eval:context-models -- --trials=3
pnpm --filter @credit/policy eval:answers -- --trials=3
pnpm --filter @credit/applications eval:integrity -- --trials=3
pnpm --filter @credit/research eval:brief -- --trials=3
pnpm --filter @credit/applications eval:policy-exception -- --trials=3
pnpm --filter @credit/applications eval:memo-live -- --trials=2
pnpm --filter @credit/policy eval:case-review -- --trials=2
pnpm --filter @credit/research eval:case-assistant -- --trials=3
pnpm eval:guardrails
```

Guardrails read the newest full run per feature and fail on pass, mean/p95
latency, or cost regressions.

## Conventions

- Every report states the dataset, model/judge pins, pass definition, cost
  basis, raw result file, and caveats.
- Judges are advisory; code/validator gates decide `pass` unless a report says
  otherwise.
- Held-out cases are not retuned after they are inspected. The policy-exception
  harness enforces this with a held-out consumption marker.
