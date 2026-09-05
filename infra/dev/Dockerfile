FROM node:24.11.1-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY apps/control-api/package.json apps/control-api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Slim the image: drop dev dependencies (typescript, eslint, vitest, tsx,
# drizzle-kit, tailwind, @types, ...). Everything runs from compiled dist / the
# built .next, so only prod deps are needed at runtime. Migrations run from the
# compiled packages/db/dist/migrate.js (no tsx).
# Reinstall with only prod dependencies: this drops dev deps (typescript, eslint,
# vitest, tsx, drizzle-kit, tailwind, @types, ...) AND, unlike `pnpm prune`,
# rebuilds the workspace symlink farm intact — so `node <pkg>/dist/main.js`
# resolves its deps. Everything runs from compiled dist / the built .next.
# CI=true lets pnpm remove the dev-dep modules non-interactively (no TTY in build).
RUN CI=true pnpm install --prod --frozen-lockfile
# Drop the Next.js build cache — `next start` serves the built output and never
# reads .next/cache (only `next build`/`next dev` do). ~150 MB of pure waste.
RUN rm -rf apps/web/.next/cache

FROM node:24.11.1-alpine AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
# Build-time version stamp, surfaced by GET /api/admin/version (see scripts/deploy.sh).
ARG APP_VERSION=dev
ARG GIT_SHA=
ARG BUILD_TIME=
# Where this build's code lives, so the admin UI can link its version at the
# matching release/commit. Empty here on purpose: the release workflow and
# scripts/deploy.sh each stamp the repository they actually built from, and a
# build that goes through neither falls back to the default in control-api.
ARG APP_REPO_URL=
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV APP_REPO_URL=$APP_REPO_URL
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app

USER node
