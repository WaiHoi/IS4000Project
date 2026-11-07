# Versions and Development Notes

Toolchain pins and the non-obvious caveats behind them. Audience: developer
upgrading the stack or debugging the toolchain. Outcome: you know what is
pinned, what is deliberately off, and what to try first when something
misbehaves.

## Pinned versions

Pinned exact via the `catalog:` section in `pnpm-workspace.yaml`:

Node 26.9.0 (local) · Bun 1.4.4 · pnpm 12.11.2 · TypeScript 7.0.2 ·
tsx 4.23.15 · @t3-oss/env-core 0.13.11 · dotenv 18.0.8 · kafkajs 2.2.4 ·
oxlint 1.88.0 · oxfmt 0.73.0 · hono 4.13.13 (served by Bun; no
`@hono/node-server`) · @temporalio/client 1.24.0 (worker adds
`@temporalio/worker`) · react 19.3.1 · @tanstack/react-start 1.169.3 ·
@tanstack/react-router 1.170.45 · vite 8.3.4 · @vitejs/plugin-react 6.1.2 ·
tailwindcss 4.3.3 · @tailwindcss/vite 4.3.3 · nitro 3.0.260903-beta ·
@playwright/test 1.64.1.

Docker: `postgres:18-alpine` · `apache/kafka:3.9.0` ·
`temporalio/auto-setup:1.28.0` · `temporalio/ui:2.34.0` · overlay:
`oven/bun:1.4.3` · `node:26-slim`.

## Notes

- **Worker runs on Node 26; Temporal officially supports 20/22/24.**
  Node 26 passes the full unit + integration suite and all 13 Playwright specs
  but is outside the support matrix — if the worker ever acts up, Node 24 LTS
  is the first thing to try (`.nvmrc` pins the 26 we test on).
- **TS 7 kept (7.0.2).** It needed two small fixes, both correct anyway:
  `packages/core` now declares the `@types/node` it always imported, and pins
  `"types": ["node"]` (TS 7 no longer auto-discovers `@types` through pnpm's
  symlinked layout — `node:` imports failed as "absolute URI" without it).
- **oxlint offs (all documented false positives here):**
  `react/react-in-jsx-scope` (React 19 automatic runtime),
  `no-await-in-loop` (relay/consumer/monitoring loops are sequentially ordered
  by SPEC FR-6.6/FR-10.4), `unicorn/no-array-sort` (every site sorts a fresh
  copy), `unicorn/prefer-set-has` (2-item const list). Everything else in
  `.oxlintrc.json` is enforced: `eqeqeq` is error, correctness is error.
- **TS 5.9 dropped `module: "bundler"`** — web uses `module: ESNext` +
  `moduleResolution: Bundler` (equivalent for Vite typechecking).
- **tsx kills unsettled top-level await** (exit 13) — the worker idles with a
  heartbeat `setInterval`, not a pending promise.
- **dotenv 18 auto-injects `.env` from cwd on import** (the `◇ injected env`
  line) — apps additionally load root `.env` explicitly; the explicit call
  wins.
- **KafkaJS on Node 26 prints a harmless `TimeoutNegativeWarning`** from its
  internal `requestQueue` (clamped to 1ms); topics still create fine.
- **Kafka healthcheck needs the full path** `/opt/kafka/bin/kafka-topics.sh`
  (`/opt/kafka/bin` is not on `PATH` in `apache/kafka:3.9.0`).
- `pnpm approve-builds --all` was run once to persist `allowBuilds`
  (`esbuild`, `protobufjs`) in `pnpm-workspace.yaml` — fresh checkouts install
  non-interactively. If a new dep needs build scripts, re-run it.
- `apps/web/src/routeTree.gen.ts` is generated but **committed**, so a clean
  checkout passes `pnpm typecheck` without running dev/build first.
- E2E spawns dev servers via shell redirection because Node rejects raw fds in
  `spawn` stdio on Windows (EINVAL); teardown reaps the tree with
  `taskkill /T`. PIDs are recorded in `e2e/.e2e-pids.json`, logs in
  `e2e/logs/` (both gitignored).
- Demo only — do not use real PII; published passwords; no CSRF token
  (SameSite + JSON + origin allow-list); in-memory rate limits.

Related: [configuration](configuration.md) · [troubleshooting](../operations/troubleshooting.md).
