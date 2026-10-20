# Architecture

This page explains the design. Audience: developers who change the system, and readers who want to know why the system is split this way. Outcome: you can trace one request from the browser to a booked loan and an activity feed entry.

## Components

| Component                   | Port                        | Runtime                      | State                                                      |
| --------------------------- | --------------------------- | ---------------------------- | ---------------------------------------------------------- |
| Web (TanStack Start)        | 3000                        | Bun build, Node dev          | None; calls same-origin `/api`                             |
| Gateway (Hono)              | 3001                        | Bun                          | Owns `credit_auth` (`users`)                               |
| Applications service (Hono) | 4001                        | Bun                          | Owns `credit_applications`                                 |
| Review service (Hono)       | 4002                        | Bun                          | Stateless; no database                                     |
| Loans service (Hono)        | 4003                        | Bun                          | Owns `credit_loans`                                        |
| Portfolio service (Hono)    | 4004                        | Bun                          | Owns `credit_portfolio`; runs the Kafka consumer           |
| Research service (Hono)     | 4005                        | Node via `tsx src/server.ts` | Owns `credit_research`; advisory briefs only               |
| Worker                      | —                           | Node via `tsx src/index.ts`  | Holds `credit_applications` and `credit_loans` connections |
| Postgres 18                 | 5432                        | Container                    | Five service databases plus the Temporal pair              |
| Kafka (KRaft)               | 9092 host, 29092 in compose | Container                    | Seven topics                                               |
| Temporal                    | 7233, UI on 8080            | Container                    | Workflows, updates, schedules                              |

Sources: `apps/web/vite.config.ts`, `apps/gateway/src/server.ts`, `apps/worker/package.json`, `docker-compose.yml`, `compose.services.yml`.

The runtime split is deliberate. Gateway, the four pipeline services, and the web build run on Bun. The worker and the research service run on Node: the worker uses `@temporalio/worker`, and research uses the Agents/Grafana SDKs (both Node-only — never Bun). The repository pins Node 26 in `.nvmrc` while Temporal officially supports 20/22/24. If the worker misbehaves, try Node 24 first.

## Request flow

```text
Browser
  -> Web :3000 (Nitro route rule proxies /api/** to 127.0.0.1:3001/api/**)
  -> Gateway :3001 (reads the session cookie, loads the user)
  -> signed internal call (HMAC headers, no cookies)
  -> service :4001-:4005 (checks the signature and the role)
```

The web app never calls services directly. Browser callers use the same-origin `/api` proxy. Non-browser clients can call the gateway directly. The gateway has no CORS middleware.

One route is composed, not proxied. `GET /api/applications/:id` reads the case from the applications service, then calls `GET /internal/loans/by-application/:id` on the loans service with the same signed user. A 404 on the loan lookup means no loan exists yet, so the gateway returns `loan: null`. Any other loan lookup failure returns 502 `BAD_GATEWAY`. Source: `apps/gateway/src/app.ts:112-168`.

## Pipeline flow

```text
POST /api/applications
  -> applications service writes the case + outbox row in one transaction
  -> gateway.startApplication starts Temporal applicationWorkflow
  -> worker: load, then identity/sanctions/document/bureau/bank checks in parallel
  -> worker: score (scorecard-v1) + policy (policy-v1.0)
  -> decline | auto book | mark pending_review
  -> officer decision arrives as a Temporal update from the review service
  -> booking saga writes decision, loan, and status
  -> outbox relays publish events to Kafka
  -> portfolio consumer writes the activity feed
```

The gateway never mutates decisions. It only routes the officer call to the review service, which sends a Temporal update. Booking runs in the worker.

## Trust boundary

The gateway authenticates the end user with the session cookie. It then signs the identity into HMAC headers for the downstream call. Services trust the signed headers and never read cookies.

- Canonical message: `METHOD\nPATH\nUSER_ID\nEMAIL(lowercased)\nROLE\nTS\nBODY_HASH\nREQUEST_ID`, signed with `INTERNAL_SECRET`.
- `PATH` is the exact pathname the receiving service sees, without the query string.
- Headers: `x-user-id`, `x-user-role`, `x-user-email`, `x-internal-ts`, `x-internal-signature`, `x-body-sha256` (hex SHA-256 over the exact request bytes; a body-swap fails closed with 401), `x-request-id` (replays rejected on reuse).
- Clock skew: 5 minutes. Compare is constant-time.
- Unsigned or tampered calls get 401. A valid signature with the wrong role gets 403.
- `createService` leaves `/health` public and requires the signature on `/api/*` and `/internal/*`.

Sources: `packages/service-kit/src/internal.ts`, `packages/service-kit/src/service.ts`.

Cross-applicant reads return 404, never 403, so one applicant cannot probe another applicant's cases. Officer-only routes check the role again inside the service. Demo endpoints need officer role plus `DEMO_MODE=true`: with `DEMO_MODE=false` they return 403 `DEMO_MODE_DISABLED`; with demo mode on but a non-officer caller they return 403 `FORBIDDEN`.

## Why review is stateless

Review holds no database. The queue and the decision replay state live in the applications service behind `GET /internal/review/queue` and `GET /internal/applications/:id/decision`. The officer decision itself travels as a Temporal update to the running workflow. This keeps one writer for case state and one channel for decisions. Source: `apps/review/src/app.ts`, `apps/review/src/routes/review.ts`.

## Phase 2 advisory research

Research is advisory-only: it never approves, declines, scores, prices, or sets terms. An officer runs a cited brief on a `pending_review` case with AI research consent, accepts or rejects findings (append-only), and the decision carries only the selection (`agentRunId` + `acceptedFindingIds`). Review resolves the selection server-side to the app-scoped frozen bundle, narrows it to exactly the accepted ids (§8.6: only used research is frozen), and forwards it as internal `research`; the selection is stripped and a client-built bundle is rejected. Source: `apps/review/src/routes/review.ts`, `packages/core/src/schemas.ts`.

- Case facts are a single 16-key strict schema (`packages/core/src/schemas.ts:caseFactsSchema`): applications builds it, review re-validates it against the schema at the boundary (fail-closed: unknown keys reject the request), research validates and stores it minus consent. New keys fail loudly, never silently dropped. Consent rides the request, never the stored facts or prompt.
- Runs are idempotent per application (advisory lock + active-run reuse), token-claimed, and finalized in the same transaction as their evidence/findings — no partial rows. A stale token (reaped run) writes nothing. A 90s-silence/expired reaper owns staleness.
- The bundle's `viewedAt` is the deciding officer's latest view, never any officer's. An empty accepted set is 409 `RESEARCH_SELECTION_STALE` (non-retryable: re-review or decide without); transport/5xx is 503 `RESEARCH_UNAVAILABLE` (retryable).
- Grafana observability is best-effort throughout: a degraded pipeline never fails readiness, a run, or a decision — the failure row carries the real status for operators.
- Phase 2 status: the service, flags, migrations, UI panel, and frozen-bundle decisions are live; rollout is gated on `AGENTS_ENABLED` + `AGENT_CASE_BRIEF_ENABLED` plus the model/search keys (runs fail closed with `config_error` when a key is missing).

## Why the worker holds two databases

Database-per-service forbids cross-database foreign keys and joins. But booking must write a decision in `credit_applications` and a loan with installments in `credit_loans`. The worker is the only component that connects to both writer databases, and it runs the booking as a three-transaction saga. It never touches `credit_auth` or `credit_portfolio`. Source: `apps/worker/src/db.ts`, `apps/worker/src/activities/booking.ts`.

## Outbox and consumer split

Each writer database has its own `outbox_events` table. State changes and outbox inserts share one transaction, so no event is lost on crash. The worker runs one relay loop per writer database (locks 4242 and 4243), each publishing up to 50 rows per second in `seq` order. The portfolio service owns the Kafka consumer (group `credit-activity`), which projects envelopes into `activity_feed` and dead-letters poison messages. Delivery is at-least-once; the consumer dedupes on `processed_events`. Detail: [data and events](../reference/data-and-events.md).

## Failure domains

| Failure                            | Behavior                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow start fails after submit  | Case stays `submitted` with no start stamp; the reconciler starts it                                                                     |
| Activity fails inside the workflow | Workflow calls `markFailed`, then rethrows; reconciler guards terminal states                                                            |
| Kafka is down                      | Relay loops skip ticks without burning attempts; consumer retries connect                                                                |
| Outbox row fails 10 times          | Relay marks it dead-lettered; gateway health shows the dead count                                                                        |
| Downstream service is down         | Gateway health still reports its own db/kafka/temporal status; the `services` map shows the failure but never flips the top-level status |
| Decision update is invalid         | Gateway maps it to 422 `DECISION_REJECTED`; conflicts map to 409                                                                         |

## Related

- [Lifecycle](lifecycle.md) — states, expiry, saga windows, reconciler timing
- [Data and events](../reference/data-and-events.md) — ownership, topics, payloads
- [Public and internal API](../reference/api.md) — exact routes and error codes
