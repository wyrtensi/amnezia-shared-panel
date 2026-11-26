FROM golang:1.24.13-bookworm@sha256:98d673f18a1aac43da744209873cb79323e11706f909251bcfb131828b95559d AS egressd_build
WORKDIR /egressd
ARG APP_VERSION=development

COPY --from=egressd go.mod go.sum ./
RUN go mod download

COPY --from=egressd . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -trimpath \
  -ldflags="-s -w -X main.Version=${APP_VERSION}" \
  -o /out/amnezia-egressd ./cmd/amnezia-egressd

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d AS dockercli

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
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

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS prod_deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
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
COPY --from=egressd_build /out/amnezia-egressd /opt/node-agent/bin/amnezia-egressd
COPY --from=deploy compose.yaml /opt/node-agent/deploy/
COPY --from=deploy \
  scripts/awg3-entrypoint.sh \
  scripts/awg3-geometry.sh \
  scripts/agent-update.sh \
  scripts/capacity-apply.sh \
  scripts/cotenants.sh \
  scripts/install-agent-updater.sh \
  scripts/install-capacity-applier.sh \
  scripts/install-egressd.sh \
  scripts/install-host-services.sh \
  scripts/set-capacity.sh \
  scripts/switch-egress-mode.sh \
  scripts/common.sh \
  scripts/backup.sh \
  scripts/rollback.sh \
  scripts/preflight.sh \
  scripts/deploy.sh \
  /opt/node-agent/deploy/scripts/
COPY --from=deploy \
  systemd/amnezia-egressd.service \
  systemd/amnezia-node-capacity.service \
  systemd/amnezia-node-agent-update.service \
  /opt/node-agent/deploy/systemd/

EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
