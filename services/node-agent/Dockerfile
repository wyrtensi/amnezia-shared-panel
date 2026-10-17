FROM node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562 AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM docker:29.9.1-cli@sha256:b6c5e5c3ef14e9e28a6d563e40e89f13bb3bed0c9e74c4e15ffbf52f975e6e4e AS dockercli

FROM node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562 AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.build.json eslint.config.mjs nodemon.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build \
  && rm -rf ./dist \
  && cp -R ./build ./dist \
  && rm -rf ./build

FROM node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562 AS prod_deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562 AS runtime
WORKDIR /app

ARG APP_VERSION=development

ENV NODE_ENV=production
ENV ENV=production
ENV APP_VERSION=${APP_VERSION}

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

RUN useradd -r -u 10001 -g root appuser
USER 10001

COPY --from=prod_deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The compose file this image expects. The host-side updater compares a node's
# compose.yaml against the one shipped by the image it is running and the one
# shipped by the image it is about to install - the only way to tell a file
# nobody touched from one an operator edited on purpose. It is also the
# authority on which environment variables this agent reads, so the updater
# reports new ones from here rather than from a second file. `deploy` is a named
# build context (infra/node) because compose.yaml lives outside this build's
# context; .github/workflows/release-node-agent.yml and
# infra/node/scripts/build-node-agent.sh both pass it.
COPY --from=deploy compose.yaml /opt/node-agent/deploy/

EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
