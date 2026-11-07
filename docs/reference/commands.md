# Command Reference

Root scripts for driving the stack. Audience: developer or operator at a
shell. Outcome: the right command without guessing.

## Stack

| Command             | What it does                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`        | Create `.env` if needed, start infra + containers, setup, seed. `--local` = host processes; `--lite` = pipeline only |
| `pnpm cleanup`      | Remove containers, volumes and local blobs; keeps `.env` and images                                                  |
| `pnpm dev`          | Gateway + six services + worker + agent workers + web in parallel                                                    |
| `pnpm dev:services` | Gateway + four pipeline services (no research/policy/worker/web)                                                     |
| `pnpm build`        | Recursive `--if-present` build                                                                                       |

## Quality

| Command                             | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `pnpm typecheck`                    | `tsc --noEmit` in every package + `scripts/` + `e2e/`          |
| `pnpm lint`                         | `oxlint`                                                       |
| `pnpm format` / `pnpm format:check` | `oxfmt .` / `oxfmt --check .`                                  |
| `pnpm test`                         | All workspace unit suites, compose-free                        |
| `pnpm test:integration`             | All workspace integration suites; needs compose                |
| `pnpm test:e2e`                     | Playwright: the three demo flows                               |
| `pnpm test:e2e:all`                 | Every Playwright spec (13 files)                               |
| `pnpm eval:guardrails`              | Eval guardrail checks for features in the eval guardrail table |

## Database and Kafka

| Command            | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `pnpm db:wait`     | Poll `pg_isready` in the postgres container (timeout `DB_WAIT_TIMEOUT_S`, default 120)            |
| `pnpm db:init`     | Create the six service DBs (+ Temporal pair) if missing — self-provisions existing clusters       |
| `pnpm kafka:init`  | Create the seven SPEC FR-10.1 topics (3 partitions, RF 1), idempotent                             |
| `pnpm db:generate` | Generate a Drizzle migration from changed schemas                                                 |
| `pnpm db:migrate`  | Apply migrations to every service database (skips research when `RESEARCH_DATABASE_URL` is unset) |
| `pnpm db:seed`     | Seed demo users and reference data                                                                |
| `pnpm run setup`   | `db:wait && db:init && kafka:init && db:migrate && db:seed`                                       |

## Demo and fixtures

| Command                                            | What it does                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm demo:check`                                  | Scripted HTTP smoke (Maria/Sam/Tomás + monitoring/pay), needs the stack                                              |
| `pnpm demo:monitor`                                | Officer login + `POST /demo/monitoring/run`, prints counts                                                           |
| `pnpm demo:seed`                                   | Idempotent T17 fixture load (users/customers/evidence, `DEMO_MODE` + manifest hash gate), needs DB                   |
| `pnpm demo:case --persona=<key>`                   | Deterministic fixture draft + initial evidence (BreadTalk blocks on stale docs), needs DB                            |
| `pnpm demo:refresh-evidence --persona=<key>`       | Add fresh customer evidence only (never attaches), needs DB                                                          |
| `pnpm demo:submit --persona=<key>`                 | Submit the fixture draft via the real endpoint, needs the stack                                                      |
| `pnpm demo:verify --persona=<key> --phase=<phase>` | Read-only fixture checks (`pre-refresh`/`post-refresh`/`post-attach`/`post-submit`), needs DB                        |
| `pnpm demo:context-stub --persona=<key>`           | Insert a clearly labelled stub research run for a fixture case (no model keys or spend)                              |
| `pnpm demo:reset --dry-run` / `--yes`              | Guarded compose reset (volumes + roots + reseed); `--dry-run` prints the plan, `--yes` runs it — never in production |

Fixture details: [demo fixtures](../demo/fixtures.md).
