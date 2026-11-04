# Web app (TanStack Start + Vite dev server), published on :3000. Build from
# the repo root:
#   docker build -f apps/web/Dockerfile .
#
# Same workspace install steps as every backend image, so BuildKit reuses
# them. Config comes from compose: the /api proxy target is GATEWAY_URL
# (compose sets http://gateway:3001 because 127.0.0.1 is the web container).
# No host mounts — like the backend images, code edits need a rebuild; use
# `pnpm start --local` for hot reload on the host.
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
EXPOSE 3000
# The committed vite.config binds 127.0.0.1 for host dev; publish all
# interfaces in the container.
CMD ["pnpm", "--filter", "@credit/web", "exec", "vite", "dev", "--host", "0.0.0.0"]
