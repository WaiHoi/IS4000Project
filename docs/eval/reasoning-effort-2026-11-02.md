# Reasoning-effort sweep — 2026-11-02

Every agent model call now sends an explicit `reasoning_effort`
(`low` / `medium` / `high` / `xhigh`) instead of relying on the provider
default. This report records the sweep that chose each agent's effort and
whether GPT-6.1 Terra can replace GPT-6.1 Sol for the Sol-pinned agents.

**Outcome:** the case brief moves from Sol to **Terra at high effort**. Memo and
document integrity stay on Sol but drop to **low** effort. The context
analyst, case assistant, and policy exception agent drop to **low** on Terra.
The policy navigator and case review (one shared setting) stay at **medium**.
Billed sweep spend: **$8.22** of a $15 budget.

## Final pins

| Agent | Model | Effort | Env | Was |
|---|---|---|---|---|
| Credit memo | Sol | low | `ASSIST_MEMO_REASONING_EFFORT` | Sol, provider default |
| Document integrity | Sol | low | `DOCUMENT_INTEGRITY_REASONING_EFFORT` | Sol, provider default |
| External case brief | **Terra** | **high** | `AGENT_MODEL`, `AGENT_REASONING_EFFORT` | Sol, provider default |
| Context analyst | Terra | low | `CONTEXT_AGENT_REASONING_EFFORT` | Terra, provider default |
| Case assistant | Terra | low | `CASE_ASSISTANT_REASONING_EFFORT` | Terra, provider default |
| Policy exception | Terra | low | `POLICY_EXCEPTION_REASONING_EFFORT` | Terra, provider default |
| Policy navigator + case review | Terra | medium | `POLICY_AGENT_REASONING_EFFORT` (shared) | Terra, provider default |

The brief's repair call and blocking support judge pin `medium` in
`callJsonModel`, so the brief's effort setting never moves its own validator.
Every trace records `reasoningEffort`; every eval result records it in `meta`.

## Method

- **Medium was not re-run** (except one policy-navigator run, added after the
  low results conflicted). All earlier results ran on the provider default.
  On a multi-step reasoning prompt, an unset effort and an explicit `medium`
  produced the same reasoning-token counts on Terra (516/516 vs 503/513), so the
  recorded results are the medium baselines.
- **Rules were written before any paid run** (switch only if Terra matches or
  beats the recorded Sol baseline on the code gates, the column Sol won on, and
  latency; adopt `low` only if it is at least medium on pass@1 and pass^k).
  The p95 check was first written against the production timeout; the
  checked-in `pnpm eval:guardrails` thresholds are stricter and were applied
  after the integrity result (see below).
- **Order:** Terra high on the Sol consumers, xhigh only where high missed,
  Sol low where Terra could not match, then low/high on the Terra consumers.
  High was skipped where medium was already perfect: it cannot strictly improve
  pass^k.
- **Unchanged:** production prompts, tools, validators, max output tokens, cost
  caps, and timeouts. Judges stay on the model each baseline report names
  (Terra) at the provider default effort.
- **Probe multipliers (Terra, one prompt):** low ≈0.8×, high ≈2×, xhigh ≈2×
  medium output tokens. Agent runs are input-heavy, so run cost moves less.

## Results

Pass is each harness's code gate. Latency is per trial. Cost is the harness's
projected list-price cost (see Cost basis).

### Sol consumers

| Agent (cases × trials) | Run | pass@1 | pass^k | p95 | Cost | Verdict |
|---|---|---:|---:|---:|---:|---|
| Credit memo (22×2) | Sol medium (recorded) | 1.000 | 22/22 | 32.8s | — | baseline |
| | Terra high | 0.955 | 21/22 | 81.4s | $1.143 | `large-bundle-20` invalid + 120s timeout |
| | Terra xhigh (`large-bundle-20` only) | 0/2 | 0/1 | 120s | — | both trials timed out; full run skipped |
| | **Sol low** | **1.000** | **22/22** | **25.4s** | $1.009 | **adopted** (grounding 4.91 vs 5.00, completeness 2.59 vs 2.41) |
| Document integrity (35×3) | Sol medium (recorded) | 0.990 | 34/35 | — | $0.57 | baseline |
| | Terra high | 1.000 | 35/35 | 31.9s | $0.607 | quality match; **p95 over the 30s guardrail** |
| | **Sol low** | **0.990** | **34/35** | **13.1s** | $0.539 | **adopted**; same intermittent long-document miss |
| External case brief (20×3) | Sol medium (recorded) | 1.000 | 20/20 | 21.2s | $1.506 | baseline; entity 0.83 on the original 3 |
| | **Terra high** | **1.000** | **20/20** | **22.5s** | $1.684 | **adopted**; entity 1.00 on the original 3, clean safety |
| Case policy review (22×2) | Sol medium (recorded) | 1.000 | 22/22 | — | $0.092 | Sol baseline (service runs Terra) |
| | Terra medium (recorded) | 0.932 | 20/22 | — | $0.092 | production |
| | Terra high | 0.932 | 20/22 | — | $0.107 | no change |
| | Terra xhigh | 0.773 | 15/22 | — | $0.103 | 7 trials hit the 45s case timeout |
| | Terra low | 0.932 | 20/22 | — | $0.084 | gates tie; judge G/C 4.38/4.22 vs 4.96/4.62 |

### Terra consumers

| Agent (cases × trials) | Run | pass@1 | pass^k | p95 | Cost | Verdict |
|---|---|---:|---:|---:|---:|---|
| Context analyst (37×3) | medium (recorded) | 1.000 | 37/37 | 22.6s | $1.386 | baseline |
| | **low** | **1.000** | **37/37** | **21.5s** | $1.337 | **adopted**; 19 narrative drops vs 42 (0.17 vs 0.38/run) |
| Case assistant (20×3) | medium (recorded) | 1.000 | 20/20 | 11.2s | $0.249 | baseline |
| | **low** | **1.000** | **20/20** | **8.2s** | $0.215 | **adopted** |
| Policy exception (17 dev × 3) | medium (recorded) | — | 17/17 dev | 21.7s (28 cases) | $0.458 (28 cases) | baseline; only failure is held-out `pe-explain-11` |
| | **low** | **1.000** | **17/17** | **11.4s** | $0.180 | **adopted** |
| Policy navigator (43×3) | medium (recorded) | 0.930 | 37/43 | — | $0.315 | baseline |
| | medium (re-run) | 0.907 | 35/43 | 20.3s | $0.318 | held-out 12/14; production config |
| | low, run 1 | 0.938 | 39/43 | 13.7s | $0.289 | held-out 14/14 |
| | low, run 2 | 0.907 | 36/43 | 14.1s | $0.286 | held-out 12/14 — below medium |
| | high | 0.922 | 37/43 | 31.3s | $0.359 | worse, slower |

The navigator decision used a rule written before the second low run: keep
`low` only if that run was also at least the recorded medium (0.930, 37/43).
It was not, so the shared setting stays `medium`. A fresh medium run then
scored 0.907 / 35/43, so the four runs (low 39 and 36, medium 37 and 35)
are run-to-run noise around ~37/43: low is not worse, and it is faster
(p95 ~14s vs ~20s) and slightly cheaper. The rule was not changed after the
fact; switching the shared setting to `low` is a reasonable owner call.

## Why integrity is not on Terra

Terra at high matched or beat Sol on every code gate (35/35 vs 34/35, zero
safety failures), but its p95 latency (31.9s) breaks the checked-in
`integrity` guardrail (30s; `scripts/eval-guardrails.mjs`). The guardrail was
not raised. Sol at low then held Sol's baseline at 13.1s p95. If the 30s
threshold is ever revisited, Terra high is a quality-equivalent alternative;
Sol's one miss is intermittent, so treat it as a match, not a win.

## Not run

- Terra xhigh on document integrity: Terra high already matched Sol on
  quality and missed only on latency; xhigh can only add latency.
- Terra low on the Sol consumers: Terra already lost to Sol at medium on memo
  and case review, and matched at high on brief and integrity.
- High on the context analyst and case assistant (already perfect at medium).
- High on policy exception: its only miss is a held-out case, and the harness
  refuses a second live held-out run. The 11 held-out cases were not run at low.
- Sol low on case review: the service runs Terra (shared with the navigator).

## Guardrails

`pnpm eval:guardrails` after the sweep: **OK**. `context-models`,
`memo-live`, and `case-review` are **not gated** (their runs are below
`minRuns`: 111 < 150, 44 < 60, 44 < 60), not passed. The `policy-exception`
row reads the 17-case dev run.

## Cost basis

- Per-run costs are each harness's projection from token usage at OpenRouter
  list prices; they are not billed amounts and are not comparable across
  harnesses (some include judge calls, some do not; timed-out trials report no
  usage). The memo harness used a flat $1/M estimate before this sweep; it now
  prices Terra $1/$5 and Sol $2/$10 per 1M tokens, so memo costs before and
  after are not comparable.
- The sweep total is billed usage from the OpenRouter credits endpoint
  (before/after the sweep), including probes, judges, calibration, and
  embeddings. Billed usage reports with a short lag.
- Terra list price: $1 input / $5 output per 1M tokens; Sol $2 / $10.

## Caveats

- One run per configuration (navigator: two low runs). The navigator shows
  that a 2-case pass^k swing is within noise; the adopted `low` settings are
  ties at ceiling, not improvements.
- Judges are Terra (same family as the answerers) and advisory.
- The brief's entity column is the model's own confidence, not a gate. The
  20-case Sol run did not record a comparable entity mean; the comparison uses
  the original three cases.
- `temperature` is not a supported parameter for Terra or Sol on OpenRouter
  (their `supported_parameters` omit it). The runs above sent it, and it had
  no effect. The code and the `*_TEMPERATURE` settings have since been removed
  ([eval-design §6.2](eval-design.md#62-reasoning-effort-not-temperature)).
- Raw results (local, gitignored): `apps/policy/eval/results/case-review-2026-11-01T20-09-37-436Z.json`
  (high), `…T20-18-04-865Z.json` (xhigh), `…T21-48-21-551Z.json` (low);
  `apps/applications/eval/results/memo-live-2026-11-01T20-39-53-090Z.json`
  (Terra high), `…T20-42-22-973Z.json` (Terra xhigh, one case),
  `…T20-50-05-532Z.json` (Sol low); `integrity-2026-11-01T21-03-08-267Z.json`
  (Terra high), `…T22-35-49-848Z.json` (Sol low);
  `policy-exception-2026-11-01T22-24-20-253Z.json` (low, dev);
  `apps/research/eval/results/brief-2026-11-01T21-21-44-171Z.json` (Terra high);
  `context-models-2026-11-01T21-30-01-213Z.json` (low);
  `case-assistant-2026-11-01T22-26-11-726Z.json` (low);
  `apps/policy/eval/results/answers-2026-11-01T21-45-16-448Z.json` (low 1),
  `…T22-43-53-967Z.json` (low 2), `…T22-15-48-166Z.json` (high),
  `…T23-04-27-935Z.json` (medium re-run).
