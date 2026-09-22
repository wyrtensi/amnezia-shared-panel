FROM node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2 AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM docker:29.8.1-cli@sha256:6602978e2be3c20e530e33773b8cadcef5fe998a71a534ee24516f1176973cdf AS dockercli

FROM node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2 AS build
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

FROM node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2 AS prod_deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2 AS runtime
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
