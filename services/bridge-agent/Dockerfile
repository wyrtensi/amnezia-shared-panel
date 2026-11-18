# bridge-agent image. Published on its own tag (bridge-agent-vX.Y.Z) by
# .github/workflows/release-bridge-agent.yml; its version is the one in this
# package's package.json, which ships next to dist/ because the agent reads it
# at start.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS prod_deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
WORKDIR /app

ENV NODE_ENV=production

# The panel reads this label from the registry to decide whether an image
# speaks an API version it supports (see apps/worker/src/bridgeAgentRelease.ts).
# Keep it equal to BRIDGE_API_VERSION in src/types.ts (a test pins that).
LABEL io.amnezia.bridge-agent.api-version="1"

COPY --from=prod_deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Non-root by default. The compose service in infra/bridge/compose.yaml
# overrides this to 0:0 on purpose: the agent refuses a token or dashboard
# credential file that group or others can read, and those files are 0600
# root-owned on the host. There the container drops every capability, has a
# read-only root filesystem and no-new-privileges.
USER 10001

# The agent listens on loopback only (host network in compose); the check reads
# the same setting the agent does. /healthz is unauthenticated and carries no data.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "const l=(process.env.BRIDGE_AGENT_LISTEN||'127.0.0.1:7600');const i=l.lastIndexOf(':');const h=l.slice(0,i);fetch('http://'+(h.includes(':')&&!h.startsWith('[')?'['+h+']':h)+':'+l.slice(i+1)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
