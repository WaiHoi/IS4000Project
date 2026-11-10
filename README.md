# Creditworthiness Pipeline

End-to-end credit pipeline: apply → verify → gather data → score → policy
decision → human review → price & book → monitor. The pipeline is
deterministic and uses labelled mocks. AI adds advisory research and drafting
only: it never approves, declines, scores, prices, sets terms, or books.

Start with [docs/index.md](docs/index.md). Architecture:
[docs/explanation/architecture.md](docs/explanation/architecture.md).

## Prereqs

- Node ≥ 22 (`.nvmrc` pins 26.9.0 — the worker runs on Node 26; see
  [versions and notes](docs/reference/versions.md))
- Bun 1.4.4
- pnpm 12 (pinned by `packageManager`)
- Docker Desktop (Compose v2)

## Quickstart

```powershell
pnpm install
pnpm start
```

`pnpm start` creates `.env` from `.env.example`, generates blank secrets,
starts Docker (Postgres, Kafka, Temporal, ClamAV), runs setup/migrations/seed,
then starts every service and the web app as containers. The first start
builds the images; later starts reuse the cache.

- `pnpm start --local` — infra in Docker, everything else on the host with hot reload.
- `pnpm start --lite` — deterministic pipeline only (no AI, no API keys).
- `pnpm start --stub` — standalone mode: the full AI stack, but web search
  (Tavily) and the ACRA registry return canned demo data, so no
  `TAVILY_API_KEY` or outbound web access is needed. The LLM still runs
  through OpenRouter. Stub pages exist for the BreadTalk and Envy demo cases;
  other entities return no results.

Features follow your `.env`; there are no flags to set by hand:

- **No API keys:** deterministic pipeline, documents, integrity/fraud panel,
  template credit memo and adverse-action letter.
- **`OPENROUTER_API_KEY`:** every advisory AI feature (memo writer, case
  assistant, context analyst, policy navigator and case review, policy
  exceptions, document integrity analysis and triage) plus the policy corpus.
- **`TAVILY_API_KEY` as well:** the external case brief (or use `--stub`).
- **Auto-research on referral:** on when an OpenRouter key is present; opt out
  with `AGENT_AUTO_TRIGGER_ENABLED=false`.

Open http://localhost:3000, log in with password `demo1234`, and check
`GET http://127.0.0.1:3001/api/health` → `{status:"ok"}`.

When done: Ctrl+C, then `pnpm cleanup` to wipe containers, volumes and local
blobs (keeps `.env`).

## Modes and data

| Mode               | Command             | External services                                                  |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| Live integration   | `pnpm start`        | OpenRouter (LLMs), Tavily (web search/extract), data.gov.sg (ACRA) |
| Standalone (stubs) | `pnpm start --stub` | OpenRouter only; Tavily and ACRA served from canned fixtures       |
| Deterministic only | `pnpm start --lite` | None                                                               |

In every mode the bank, bureau and customer data are labelled mocks
(`packages/core/src/mockBank.ts`, `mockBureau.ts`) and seeded fixtures.

**Dataset inclusion rules.** The submission includes all code and the
synthetic data it needs: `fixtures/demo/manifest.json` (demo personas, accounts,
documents), the mock bank/bureau, the policy corpus
(`packages/core/src/policy-corpus.ts`), stub web pages
(`apps/research/src/agents/case-brief/stub.ts`) and eval datasets
(`apps/*/eval/`), plus a few reference eval result JSONs under
`apps/applications/eval/results/`. It excludes `.env` (your keys),
`node_modules`, `.data/` (document blobs, generated stack files) and new eval
result JSONs (gitignored); `pnpm install` and `pnpm start` recreate what is
needed. The BreadTalk and Envy company names and UENs are real public
entities, but their stub news pages and registry details are synthetic
paraphrases marked "(synthetic fixture)". All people and accounts are
fictional. Do not add real PII.

## Demo users

| Email                        | Role      | Demo path                                        |
| ---------------------------- | --------- | ------------------------------------------------ |
| `maria@example.com`          | applicant | auto-approve ($12k/48m → booked, 777/A)          |
| `alex@example.com`           | applicant | refer → officer declines                         |
| `sam@example.com`            | applicant | auto-decline (`SCORE_TOO_LOW`)                   |
| `tomas@cafe-aurora.example`  | applicant | SME refer → officer counter-offers $50k → booked |
| `lena@bakery.example`        | applicant | SME auto-approve                                 |
| `officer@example.com`        | officer   | review queue, decisions, demo controls           |
| `senior.officer@example.com` | officer   | same                                             |

## Demo paths

| Scenario   | Expected result                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Maria      | `booked` at $12,000 / 48 months, score 777 / grade A, loan with no alerts                        |
| Tomás      | `pending_review` (`AMOUNT_ABOVE_AUTO_LIMIT` + `SECTOR_REVIEW`); officer approves $50k → `booked` |
| Sam        | `declined` (`SCORE_TOO_LOW`), no loan                                                            |
| Monitoring | age Tomás's loan 40 days → `payment_overdue` alert → acknowledge → pay → no open alerts          |

Full click-through, request values, and reset:
[getting started](docs/getting-started.md#4-run-the-four-scenarios).

## Verify

- `pnpm demo:check` — HTTP smoke over Maria, Sam, Tomás and monitoring (stack required).
- `pnpm demo:monitor` — one officer monitoring run.
- `pnpm test:e2e` — Playwright: Maria auto-approve, BreadTalk approve, Envy decline; starts what is down and stops what it started.
- `pnpm test:e2e:all` — all 13 specs.
- `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm lint` — see [commands](docs/reference/commands.md).

## Documentation

- [Getting started](docs/getting-started.md) — run, verify, reset.
- [Architecture](docs/explanation/architecture.md) — request flow, trust boundary, failure domains.
- [Lifecycle](docs/explanation/lifecycle.md) — status machines, booking saga, alerts.
- [Configuration](docs/reference/configuration.md) — environment variables, ports, secrets.
- [Commands](docs/reference/commands.md) — every root script.
- [Versions and notes](docs/reference/versions.md) — pins and toolchain caveats.
- [Troubleshooting](docs/operations/troubleshooting.md) — symptom → fix.
- [Document workflow](docs/explanation/document-workflow.md) — uploads, OCR, ClamAV, v1 limits.
- [Demo fixtures](docs/demo/fixtures.md) — CLI fixture workflow.
- [API](docs/reference/api.md) and [data/events](docs/reference/data-and-events.md).
- [Evals](docs/eval/index.md) — reports, model comparisons, costs.

Demo only — every person, account and figure is fictional. Do not use real
PII. Passwords are published; there is no CSRF token (SameSite + JSON + origin
allow-list); rate limits are in-memory.
