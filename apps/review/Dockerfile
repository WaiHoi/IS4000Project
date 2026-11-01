# Officer review service. Build from the repo root:
#   docker build -f apps/review/Dockerfile .
#
# Every backend image shares the steps up to CMD, so BuildKit builds the
# workspace install once and reuses it. Images run TypeScript directly
# (Bun), like `pnpm dev`; the base has both runtimes because the
# Temporal worker SDK (agent workers) needs Node. Config comes from compose
# (env_file .env + .data/stack.env), never from the image: .env is excluded.
FROM node:26-slim
COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV PNPM_STORE_DIR=/pnpm-store

# TLS-inspecting networks: an optional `extra_ca` build secret is trusted
# for the install (pnpm start passes the host's NODE_EXTRA_CA_CERTS).
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=secret,id=extra_ca,required=false \
	--mount=type=cache,id=credit-pnpm-store,target=/pnpm-store \
	if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
	&& npm install -g pnpm@12.11.2 --no-audit --no-fund \
	&& pnpm fetch --store-dir /pnpm-store

COPY . .
RUN --mount=type=cache,id=credit-pnpm-store,target=/pnpm-store \
	pnpm install --offline --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=development
EXPOSE 4002
CMD ["bun", "apps/review/src/server.ts"]
