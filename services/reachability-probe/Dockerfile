# The AWG userspace client and its tool, from the same pinned 3.1 image the
# nodes run. Both are Alpine/musl builds, so they run on the alpine base below.
FROM amneziavpn/amneziawg-go:3.1.20260828@sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72 AS awg

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS runtime
WORKDIR /app

ARG APP_VERSION=development
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}

# iproute2 for `ip rule` / per-table routes; busybox ping is already there.
RUN apk add --no-cache iproute2
COPY --from=awg /usr/bin/amneziawg-go /usr/bin/awg /usr/bin/

# No runtime dependencies: dist plus package.json (for "type": "module").
COPY package.json ./
COPY --from=build /app/dist ./dist

# Runs as root inside the container on purpose: creating a tun interface and
# rules needs NET_ADMIN, which compose grants after dropping everything else.
EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
