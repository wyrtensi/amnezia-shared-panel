FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066 AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM docker:29.6.1-cli@sha256:a011361b7e7dbf51ba0db930a7b746a0bb80935ac1b2f5d892a989025c80fab6 AS dockercli

FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066 AS build
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

FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066 AS prod_deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066 AS runtime
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
