# AmneziaWG host + control-plane setup guide

This runbook is written for a future AI agent (and its human operator) who must
stand up an AmneziaWG VPN node and wire it into the Amnezia Panel control plane.
It is grounded in the assets that already exist in this repository; every command
and path below comes from the tree. Do not invent flags or endpoints — if a step
cannot be completed the straightforward way, stop and report the blocker rather
than improvising a detour.

All paths are relative to the project root `D:\amnezia-panel` unless stated
otherwise. The node scripts run on a Linux/amd64 host; the control plane runs
wherever Docker Compose is available.

Canonical references this guide is built from:

- `README.md`, `AGENTS.md`
- `infra/node/README.md`, `infra/node/CHECKLIST.md`, `infra/node/compose.yaml`,
  `infra/node/.env.example`, `infra/node/scripts/*.sh`
- `infra/dev/README.md`, `infra/dev/compose.yaml`, `infra/dev/.env.example`,
  `infra/dev/ROUTE-PROFILES-POC.md`
- `services/node-agent/README.md`, `services/node-agent/Dockerfile`
- `apps/control-api/.env.example`, `apps/worker/.env.example`, `apps/web/.env.example`
- `packages/contracts/src/index.ts` (node/key request schemas)

---

## 1. Overview and architecture

The system has two independently deployed halves.

### Control plane (one deployment, central)

| Component | Role | Dev bind |
| --- | --- | --- |
| `apps/control-api` | Authenticated central REST API. Every capability is API-first; the web app never bypasses it. | `127.0.0.1:3001` |
| `apps/worker` | Provisioning jobs, telemetry polling, retention/maintenance, routing-rule feeds. Reaches nodes over the node-agent HTTP API. | (no public port) |
| `apps/web` | Employee + administrator UI. Server-side proxy to the control API. | `127.0.0.1:3000` |
| `postgres` | State store (schema/migrations in `packages/db`). | not published |

The worker holds the node-agent API keys (encrypted at rest) and is the only
component that talks to a node. The control-api and web app never call a node
directly.

### VPN node (one deployment per server)

| Container | Image (pinned) | Endpoint |
| --- | --- | --- |
| `amnezia-awg3` | `amneziavpn/amneziawg-go:3.1.20260814@sha256:4450…1b7a` | UDP **51890**, subnet **10.90.0.0/22** (server `10.90.0.1/22`) |
| `amnezia-awg2` | `amneziavpn/amneziawg-go:0.2.19@sha256:3c78…77c44` | UDP **51889**, subnet **10.89.0.0/22** (server `10.89.0.1/22`) |
| `amnezia-node-agent` | built locally from `services/node-agent` (reviewed fork of `kyoresuas/amnezia-api`) | TCP **`127.0.0.1:4001` only**, `PROTOCOLS_ENABLED=amneziawg2,amneziawg3` |

**AmneziaWG 3.1 is the primary protocol** for all new nodes and new keys (header
protection, ranged headers, random trailers; requires the official AmneziaVPN
client 5.0.1.5+). AmneziaWG 2.0 is retained **only** for backward compatibility
with peers already issued on existing nodes — including the operator's own
connection. Do not build new features against 2.0 and never remove its code
paths, but a brand-new node may run AWG 3.1 alone if no legacy peers exist. On the
production node assets, both run side by side in separate containers.

The two AWG containers run the userspace `amneziawg-go` daemon, so each holds only
`NET_ADMIN` + `/dev/net/tun` (no `SYS_MODULE`, no privileged mode). The node-agent
needs the Docker socket to drive the approved AWG tooling; treat its compromise as
host-level compromise.

### The private-transport boundary

The node-agent is published on the node **only** at `127.0.0.1:4001`. TCP 4001 is
deliberately not exposed on any non-loopback address and must never be opened in
the host firewall. The control plane reaches it over an approved private transport
(Part B), not over the public internet.

```
  Control-plane host                              VPN node (Linux/amd64)
 ┌───────────────────────────┐                  ┌────────────────────────────┐
 │ web → control-api → PG     │                  │  amnezia-node-agent        │
 │ worker ───────────────┐    │   SSH tunnel     │   127.0.0.1:4001 (loopback)│
 │  host.docker.internal │────┼─────────────────▶│                            │
 │        :4001          │    │  (private only)  │  amnezia-awg3  UDP 51890   │
 └───────────────────────┘    │                  │  amnezia-awg2  UDP 51889   │
                              └──                 └────────────────────────────┘
```

---

## 2. Prerequisites

### VPN node host

- **Linux/amd64** (`preflight.sh` hard-fails on anything else). `/dev/net/tun`
  must exist and `/var/run/docker.sock` must be reachable.
- **Docker Engine (Linux containers, amd64) + Docker Compose v2.** GNU `tar`,
  `sha256sum`, `stat`, `df`, `awk`, `sed`, `grep`, `ss`, `openssl` on `PATH`.
- **Resource gates enforced by preflight:** at least **3 GiB free disk** on the
  `infra/node` filesystem (`>= 3145728` KiB) and **available RAM scaled to the
  node's capacity** — `358400 KiB * SERVER_MAX_PEERS / 500`, never below 192 MiB.
  A 500-peer node therefore still needs 350 MiB, while a 100-peer node needs the
  192 MiB floor, which is what lets a 512 MB VPS host a small node (the resident
  stack measures ~117 MiB: node-agent ~109, awg3 ~4, awg2 ~4).
- **Firewall:** inbound UDP **51889** and **51890** approved at the provider and
  host; TCP **4001 closed** on every public interface.
- **Fixed image pins** (immutable, `pull_policy: never` for the built image):
  - AWG2: `amneziavpn/amneziawg-go:0.2.19@sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44`
  - AWG3: `amneziavpn/amneziawg-go:3.1.20260814@sha256:4450928744b051589bb3ba5cf6dd0cd8d7dc470b9432dc32d03d5ff5ede11b7a`
  - node-agent: built locally; `NODE_AGENT_IMAGE` must be an immutable
    `sha256:<64-hex>` image ID or a `repository@sha256:<digest>` reference.
  - Mutable `latest` tags and Watchtower are forbidden (preflight scans the
    compose file and the node-agent Dockerfile and fails if it finds either).

### Control-plane host

- Docker + Docker Compose v2 (the dev stack builds one shared image and runs
  postgres 16 pinned by digest).
- `openssl` (to mint the config-encryption key and postgres password).
- Outbound SSH to the node host to open the private tunnel.

---

## Part A — Install the VPN node

> **There is a scripted path for all of Part A and Part B.**
> `scripts/add-node.sh --host <ip> --name <panel name>` installs Docker, deploys
> `infra/node`, ships the image, opens the tunnel, and registers the node, in one
> idempotent command driven by `scripts/add-node.env`. See
> [`NODE-CONNECT.md` §0](./NODE-CONNECT.md). Follow the manual steps below when a
> rollout deviates from it, or to understand what the script is doing.

Run everything from `infra/node` on the target Linux/amd64 host. The scripts are
local-only: they never SSH anywhere and never mutate a remote host. Follow
`infra/node/CHECKLIST.md` alongside this section.

**Copying `infra/node` to the host:** preserve root ownership. The AWG
entrypoints are mounted into the containers at mode 0700, so a copy that carries
your workstation's uid (a plain `tar -c`, or `scp` as a non-root user) makes them
unreadable and both AWG containers crash-loop with `can't open
/usr/local/libexec/awg2-entrypoint.sh: Permission denied`. Use
`tar --owner=0 --group=0 --numeric-owner`, or `chown -R root:root` after copying.

> **Ask first:** per `AGENTS.md`, before registering a node ask the human operator
> what the node should be **named in the panel** (e.g. "Hetzner DE").
> Do not hardcode a display name. Keep that answer for Part B.

### A.1 Prepare the layout, secret, and node-agent image

From `infra/node`:

```sh
install -m 600 .env.example .env
install -d -m 700 secrets state/amnezia-awg2 state/amnezia-awg3 backups
(umask 077; openssl rand -base64 48 > secrets/node-agent-api-key)
chown root:root secrets/node-agent-api-key
chmod 640 secrets/node-agent-api-key
chmod 700 scripts/*.sh
sh scripts/build-node-agent.sh
```

`build-node-agent.sh` builds `services/node-agent` for `linux/amd64`, verifies the
platform, and prints the immutable image ID:

```
Node-agent image built and verified. Set NODE_AGENT_IMAGE=sha256:<64-hex> in infra/node/.env.
```

The node-agent API key lives **only** in `secrets/node-agent-api-key`. Never place
it in `.env`, on a command line, or in any log/handoff. It is mounted as a Compose
file secret and validated to be a single line of ≥32 printable ASCII bytes.

### A.2 Fill `.env`

Edit `infra/node/.env` (mode `0600`). Every value is validated by preflight:

| Variable | How to set it | Preflight rule |
| --- | --- | --- |
| `NODE_AGENT_IMAGE` | Paste the `sha256:…` ID printed by `build-node-agent.sh` — or, when the image was shipped with `docker save`/`docker load`, the ID `docker load` printed **on this host** (newer engines re-encode the config, so it differs from the sending host's ID). | Must be `sha256:<64hex>` or `repo@sha256:<digest>`, present locally, linux/amd64. |
| `DOCKER_GID` | `stat -c '%g' /var/run/docker.sock` | Must be an integer equal to the socket's GID. |
| `DOCKER_API_VERSION` | Leave `1.44` unless your Engine differs. | — |
| `SERVER_PUBLIC_HOST` | Real public IPv4 or DNS name for generated configs. | Cannot be empty / `0.0.0.0` / `127.0.0.1` / `localhost` / `vpn.example.com` / contain a scheme, path, port, or space. |
| `SERVER_ID` | A unique UUID (`uuidgen`). | Must be a UUID and not the placeholder. |
| `SERVER_NAME` | Human-readable name. | required |
| `SERVER_REGION` | Region / AZ label. | required |
| `SERVER_WEIGHT` | Routing weight. | integer `1..1000` |
| `SERVER_MAX_PEERS` | Client cap. Also scales the preflight RAM gate, so set it to the capacity the host can carry rather than the ceiling. | integer `1..500` (500 is the unvalidated ceiling) |

The compose file forces the node-agent container to
`PROTOCOLS_ENABLED=amneziawg2,amneziawg3` and `FASTIFY_ROUTES=0.0.0.0:4001`, but
publishes the port only as `127.0.0.1:4001:4001`, so the agent stays loopback-only.

### A.3 Preflight (non-deploying)

```sh
sh scripts/preflight.sh
```

It verifies Linux/amd64, Docker/Compose, TUN + socket, immutable image references,
strict file permissions, the fixed Compose configuration, port conflicts on
51889/51890/4001, the 3 GiB disk and capacity-scaled RAM gates, and JSON-validates any
existing `clientsTable`. Retain its (non-secret) output with the change record.

### A.4 Deploy

```sh
sh scripts/deploy.sh
```

`deploy.sh` re-runs preflight, then (under a lock) pulls and digest-verifies the
two pinned AWG images, verifies the local node-agent image, takes a pre-deploy
backup **if** AWG2 state already exists, runs
`docker compose up --detach --no-build --remove-orphans`, and gates on health for
`amnezia-awg2`, `amnezia-awg3`, and `amnezia-node-agent` in turn. It fails closed —
persistent state is never removed on failure — and asserts the agent is bound
exclusively to `127.0.0.1:4001`.

**Re-deploying a node that has served peers.** The node-agent rewrites
`awg0.conf` and `clientsTable` with the default umask whenever a client changes,
so they come back `0644` while preflight requires exactly `0600` — and the
re-deploy stops with `state file permissions must be 0600`. Restore the mode
(`find state -type f -exec chmod 600 {} +`) and re-run; never relax the gate.
The 0700 `state/` directory still gates access, so this breaks the update path
rather than exposing key material.

**AWG3 container specifics.** The AWG images are minimal toolkits whose default
command is `/bin/sh`; `scripts/awg2-entrypoint.sh` and `scripts/awg3-entrypoint.sh`
supply the service lifecycle. On first start (state absent) the entrypoint
generates server keys, a PSK, unique `H1..H4`, and the config. The AWG3 entrypoint
additionally generates a base64 `HeaderProtectionKey`, sets `RandomTrailers = on`,
and **refuses to start** if the header-protection key is missing. Both entrypoints
initialize state only when the *entire* state set is absent and refuse partial
state (e.g. config present but keys/`clientsTable` missing). The active `I1` value
is intentionally identical on server and generated clients — leaving it absent on
the server breaks the handshake.

### A.5 Verify

```sh
docker compose --env-file .env ps
docker port amnezia-node-agent 4001/tcp          # must print only 127.0.0.1:4001

# Both protocols must be reported by the agent (loopback + x-api-key). Do not
# paste this output anywhere shared — it echoes server identity.
curl -s -H "x-api-key: $(cat secrets/node-agent-api-key)" http://127.0.0.1:4001/server
```

`GET /server` must list both `amneziawg2` and `amneziawg3` in `protocols`.
Complete the `CHECKLIST.md` "Deploy" gate: create two device keys and pass the
official AmneziaVPN 5.x handshake/traffic acceptance test before assigning
production users, and run the 500-peer load gate before treating 500 as validated
capacity.

### A.6 Backup and rollback (node-local)

```sh
sh scripts/backup.sh                              # brief VPN interruption for a consistent snapshot
sh scripts/rollback.sh /absolute/path/to/amnezia-node-YYYYMMDDTHHMMSSZ.tar.gz
```

`backup.sh` briefly stops node-agent + AWG2 + AWG3, writes a mode-`0600`
`.tar.gz` plus a `.sha256` sidecar into `backups/` covering
`state/amnezia-awg2` and (once initialized) `state/amnezia-awg3`, then restarts
only the services that were running. The archive contains VPN private material —
copy it only to approved encrypted storage. `rollback.sh` takes one explicit
archive path, rejects unsafe archive members/links, validates AWG2 (and AWG3 when
present) config + key material + `clientsTable`, takes a safety backup, restores
with strict permissions, and requires all health gates; if the restored state
fails, it puts the pre-rollback state back.

---

## Part B — Connect the node to the control plane

The node-agent is loopback-only, so the control-plane worker cannot reach
`4001` across the network directly. Use the approved private transport: an SSH
tunnel from the control-plane host to the node.

### B.1 Open the SSH tunnel (on the control-plane host)

```sh
ssh -N -L 0.0.0.0:4001:127.0.0.1:4001 root@<node-public-host>
```

This forwards the control-plane host's `4001` to the node's loopback `4001`.
Binding the local end to `0.0.0.0` is what lets the dockerized worker reach it
through Docker's `host.docker.internal` gateway (the worker service in
`infra/dev/compose.yaml` has `extra_hosts: ["host.docker.internal:host-gateway"]`).

> Security note: `0.0.0.0:4001` is now reachable on the control-plane host's
> interfaces, so that host must itself be trusted and firewalled. This does **not**
> open 4001 on the *node* — the node still exposes 4001 only on its own loopback,
> per `infra/node/README.md`. Keep the tunnel supervised (systemd unit,
> `autossh`, etc.) so it re-establishes; the worker treats a dropped tunnel as a
> node health failure (see Troubleshooting).

### B.2 Register the node in the panel

Preferred path — the admin UI (`apps/web/app/admin/nodes/page.tsx`): open
**Админ → VPN-ноды → Добавить ноду** and fill:

- **Название** — the display name the operator gave you (Part A note).
- **Адрес node-agent** — `http://host.docker.internal:4001` (the default the form
  prefills, correct for the dockerized worker).
- **API-ключ** — the exact contents of `infra/node/secrets/node-agent-api-key`
  (≥32 chars). It is stored encrypted and never shown again.
- **Лимит peer** — `maxPeers` (1..500).

The UI submits `POST /api/admin/nodes` with `protocol: "awg2"`, `enabled: true`,
and `capabilities: { peerLifecycle: true, telemetry: true, backup: true }`.

Scriptable equivalent on a **production** panel — the bundled admin CLI, run
inside the `control-api` container, which already holds `PANEL_IDENTITY_SECRET`
and `BOOTSTRAP_ADMIN_EMAILS`. It mints the same `x-panel-identity` token the web
issues after a Google login, so no Cloudflare service token is involved:

```sh
docker compose exec -T -e CONTROL_API_URL=http://127.0.0.1:3001 control-api \
  node /app/apps/cli/dist/main.js node-add \
  --name="<node display name>" \
  --api-url=http://host.docker.internal:<tunnel port> \
  --api-key="<contents of secrets/node-agent-api-key>" \
  --protocol=awg3 --max-peers=500 --enabled-protocols=awg3
```

See [`apps/cli/README.md`](../apps/cli/README.md) for the identity chain and the
rest of the node commands (`node-update`, `node-remove`, `node-reconcile`).

Raw HTTP equivalent (dev identity injected via the `x-dev-user-email` header;
works only against a dev API — see Part C):

```sh
curl -s -X POST http://127.0.0.1:3001/api/admin/nodes \
  -H "content-type: application/json" \
  -H "x-dev-user-email: <your-admin-email>" \
  -d '{
    "name": "<node display name>",
    "apiBaseUrl": "http://host.docker.internal:4001",
    "apiKey": "<contents of secrets/node-agent-api-key>",
    "protocol": "awg2",
    "maxPeers": 500,
    "capabilities": { "peerLifecycle": true, "telemetry": true, "backup": true }
  }'
```

Contract (`createNodeRequestSchema` in `packages/contracts/src/index.ts`):
`name` (1..120), `apiBaseUrl` (http/https URL), `apiKey` (32..4096),
`enabled` (default `true`), `protocol` (`awg2` | `awg3`, default `awg2`),
`maxPeers` (1..500, default 500), `capabilities` (map of string→bool).

`protocol` here is only the fallback kind. The **authoritative** protocol set is
`supportedProtocols`, which the worker syncs from the node's `GET /server` — so an
AWG3-primary node registered with `protocol: "awg2"` still offers AWG 3.1 to the
key wizard once telemetry runs.

### B.3 Verify the link recovers

The worker polls telemetry every 60 s (`apps/worker/src/main.ts`) and, on success,
`recordNodeSnapshot` (`apps/worker/src/postgresRepository.ts`) clears `lastError`,
stamps `lastHealthAt`/`lastSyncAt`, and rewrites `capabilities` from the live
`GET /server` + `GET /server/load` — including `awg2`/`awg3` availability,
`reportedMaxPeers`, `reportedTotalPeers`, and `healthz`/`serverStatus`/`serverLoad`
flags. In the admin nodes table this shows as:

- **Состояние** → "Норма" (no `lastError`),
- **Протоколы** → `AWG2` + `AWG3` badges (from `supportedProtocols`),
- **Проверка** → a recent `lastHealthAt` timestamp,
- **Ёмкость** → `peerCount / maxPeers`.

Use the **Сверка** (reconcile) button, or wait one poll cycle, if the row is still
stale right after registration.

---

## Part C — Run the control plane (dev stack)

The local control plane is `infra/dev` (postgres + migrate + control-api + worker
+ web), one shared image built from `infra/dev/Dockerfile`.

### C.1 Configure `infra/dev/.env`

Copy the example and replace every placeholder:

```sh
cd infra/dev
cp .env.example .env
```

`infra/dev/.env.example` fields:

| Variable | Set to |
| --- | --- |
| `POSTGRES_PASSWORD` | a long random password |
| `DATABASE_URL` | `postgres://amnezia_panel:<same password>@postgres:5432/amnezia_panel` (host is the compose service name `postgres`) |
| `CONFIG_ENCRYPTION_KEYS_JSON` | `{"1":"<base64 of 32 random bytes>"}` — generate with `openssl rand -base64 32` |
| `CONFIG_ENCRYPTION_ACTIVE_VERSION` | `1` (must exist in the keyring) |
| `DEV_USER_EMAIL` | **your** email — this becomes your dev identity and (via the compose default) your admin allowlist |

The control-api and worker share this `.env` (both need identical
`DATABASE_URL` and `CONFIG_ENCRYPTION_*`; the worker encrypts/decrypts node API
keys with the same keyring). The compose file wires
`BOOTSTRAP_ADMIN_EMAILS: ${DEV_USER_EMAIL:-admin@example.com}` into the control-api
and `DEV_USER_EMAIL` + `DEV_IDENTITY_ENABLED=true` into the web app.

### C.2 Bring it up

```sh
docker compose --env-file .env up --build
```

`migrate` runs `@amnezia/db db:migrate` to completion first, then control-api
(`127.0.0.1:3001`), worker, and web (`127.0.0.1:3000`) start. Postgres is not
published to the host; control-api and web bind loopback only.

Open **http://127.0.0.1:3000**.

### C.3 Identity model and becoming admin

- **Production:** identity comes from **Cloudflare Access**. `control-api/main.ts`
  builds `createCloudflareAccessAdapter({ issuer: CF_ACCESS_ISSUER, audience:
  CF_ACCESS_AUDIENCE })` and verifies the `Cf-Access-Jwt-Assertion` on every
  request (both env vars are required in prod).
- **Development:** the control-api trusts an `x-dev-user-email` header
  (`getDevelopmentIdentity`), which the web proxy injects from `DEV_USER_EMAIL`
  when `DEV_IDENTITY_ENABLED=true`. This dev adapter is unavailable when the
  control-api runs in production mode.

**Becoming admin:** on first request the control repository auto-provisions the
identity and, if the (lower-cased) email is in `BOOTSTRAP_ADMIN_EMAILS`, promotes
it to `admin`. Because the dev compose seeds `BOOTSTRAP_ADMIN_EMAILS` from
`DEV_USER_EMAIL`, setting `DEV_USER_EMAIL` to your own address in
`infra/dev/.env` and opening the UI makes you an administrator. The admin nav
(overview, users, nodes, routing) then appears.

---

## Part D — Day-2 operations

### Creating keys (AWG 3.1 default)

Employees create keys through the wizard (`apps/web/components/employee/create-key-wizard.tsx`),
which **preselects AWG 3.1 whenever the chosen node reports it**
(`preferredProtocol` prefers `awg3`; the AWG3 card shows "Требуется AmneziaVPN
5.0.1.5+"). `POST /api/keys` enqueues provisioning; the worker calls the
node-agent `POST /clients` (mapping `awg3 → amneziawg3`) and returns an importable
`vpn://` config.

> If you call `POST /api/keys` directly instead of using the wizard, pass
> `"protocol": "awg3"` explicitly — the raw `createKeyRequestSchema` default is
> still `awg2` for backward compatibility, while the UI layer is what enforces the
> AWG 3.1-first preference.

### Route profiles and rule feeds

Profiles (`packages/contracts` `routeProfileSchema`): `full_tunnel` (always
available), `ru_whitelist` (foreign via VPN, RU direct), `ru_blacklist` (only
RKN-blocked via VPN). Non-full-tunnel profiles apply their active rule set to
`AllowedIPs` **at export time**; the official client can't refresh routing on an
imported config, so a rules change flags the key `rulesOutdated` and the user
re-downloads.

Feeds work **out of the box**: with no feed configuration at all the worker uses
the built-in RoscomVPN / Re:filter sources for both split-tunnel profiles, so a
fresh install fetches real rules without an operator pasting anything. The worker
env (`apps/worker/.env.example`) only overrides that:

- `RULE_FEEDS` — JSON array of `{ profile, sources:[{ url, format }] }`, formats
  `json` | `cidr-lines` | `domain-lines` (multiple sources per profile are merged
  and de-duplicated). Leave it empty to keep the built-in defaults; set
  `RULE_FEEDS=[]` to run with no feeds at all. A malformed value fails the worker
  at startup instead of quietly reverting to the defaults. Legacy single
  `ru_whitelist` JSON feed: `ROSCOMVPN_RULES_URL`.
  `domain-lines` entries must be **bare ASCII/punycode hostnames** (`.рф` →
  `xn--p1ai`); raw Unicode, wildcards (`*.`), and leading dots are dropped as
  invalid. A feed with more than 15 % invalid entries is quarantined whole, so
  a wrong URL or format fails safe rather than shipping garbage.
- **Gates default open.** The fetcher activates fetched versions by default; set
  `RU_WHITELIST_POC_APPROVED=false` / `RU_BLACKLIST_POC_APPROVED=false` to hold a
  profile's auto-fetched versions quarantined for operator review (`!== "false"`
  is treated as approved). Fetchers run every 6 h.
- **No bundled starter list.** Rule versions come from the feeds or from an
  explicit operator upload (`POST /api/admin/rules/global/import` with a
  `profile`, `version` and at least one entry). There is nothing to fall back on,
  so a misconfigured feed leaves a profile unavailable instead of silently
  serving a stub list.
- **Global route overrides** (`global_route_overrides`, admin-wide) are layered on
  the active feed at export time: feed − admin exclusions + admin additions +
  the owner's own custom routes. Excluding a domain also excludes its
  subdomains; the user's own routes are applied last and can therefore re-add an
  excluded entry. Edit them from the admin UI or with
  `amnezia-panel global-routes-set` (see [`CLI.md`](./CLI.md)).

See `infra/dev/ROUTE-PROFILES-POC.md` for the per-profile validation checklist
(fetch/import → confirm `available: true` → export → import into AmneziaVPN
5.0.1.5+ → verify split routing both directions → repeat for AWG2 and AWG3).

### Key rotation

Rotation re-issues a key with the **current** rules and a fresh config
(`POST /api/keys/:id/rotate`, admin can rotate any key; users rotate their own).
This is how RoscomVPN keys were re-issued against the current rule set.

### Backups, rollback, disk hygiene

- Node state: `sh scripts/backup.sh` (accepts the brief interruption) and copy the
  `.tar.gz` + `.sha256` off-box to encrypted storage; verify with
  `sha256sum -c <archive>.sha256`. Restore with `sh scripts/rollback.sh <abs path>`.
- Container logs are capped (`json-file`, `max-size: 10m`, `max-file: "3"`) on
  every node service. Watch `infra/node/backups/` growth against the 3 GiB
  preflight gate and prune old archives per your retention policy after copying
  them to encrypted storage.
- Control-plane telemetry retention is bounded by
  `TELEMETRY_RAW_RETENTION_DAYS` (7), `TELEMETRY_HOURLY_RETENTION_DAYS` (90),
  `TELEMETRY_DAILY_RETENTION_DAYS` (730); maintenance runs hourly.

### Hard safety rules (do not violate)

- **Never stop `amnezia-awg2` on a live node.** Existing peers — including the
  operator's own connection on the current node — depend on it. AWG 2.0 stays for
  backward compatibility; keep the awg2 code paths.
- **AWG3 rollout is additive.** AWG3 is added alongside AWG2, never replacing it.
  Backups predating the AWG3 rollout have no `state/amnezia-awg3`; the scripts
  handle that (`has_awg3=0`) — do not force AWG3 state into an old restore.
- **Never touch another tenant's containers or an update automation.** On a shared
  host do not stop, remove, or reconfigure containers you did not deploy (e.g. a
  client's own `amnezia-awg2`, `shadowbox`, or `watchtower`). The node deployment
  is scoped to the `amnezia-node` compose project; preflight refuses to adopt a
  container owned by another compose project.
- **Never expose 4001.** Do not publish it on a non-loopback address or open it in
  the node firewall; reach it only through the Part B private transport.
- **Never print or commit secrets** — API keys, `vpn://` configs, QR payloads,
  private keys, backups. Redact them from any command output, log, or handoff.

---

## Troubleshooting

### Node shows `lastError` / "fetch failed" (tunnel down)

Symptom: the admin nodes row leaves "Норма" and shows an error; provisioning jobs
fail. The worker's node client (`apps/worker/src/nodeAgent.ts`) uses `fetch` with a
15 s timeout — a dropped SSH tunnel surfaces as a connect/`fetch failed` error.

Fix: confirm the tunnel is up on the control-plane host
(`ss -ltn 'sport = :4001'` should show a listener), and that it binds `0.0.0.0`
(not `127.0.0.1`) so `host.docker.internal` can reach it. Re-open it:
`ssh -N -L 0.0.0.0:4001:127.0.0.1:4001 root@<node>`. On the node, confirm the
agent is healthy and loopback-bound: `docker port amnezia-node-agent 4001/tcp`
must print `127.0.0.1:4001`. The worker retries telemetry every 60 s and clears
`lastError` once `GET /server` succeeds again (or press **Сверка**).

### `401` from the node-agent

`Node-agent request failed with status 401` means the registered `apiKey` doesn't
match `secrets/node-agent-api-key` on the node. Re-enter the key via the node's
**edit** dialog (leave blank to keep the current one) or `PATCH /api/admin/nodes/:id`
with a fresh `apiKey`. The key is compared in constant time and must be ≥32 chars.

### node-agent build / OpenAPI issues

- Build only via `sh scripts/build-node-agent.sh` (it pins Node 22 + Docker CLI
  bases and tags `amnezia-panel/node-agent:1.0.0-local`). Deployment never builds
  implicitly (`pull_policy: never`); if preflight says "NODE_AGENT_IMAGE is not
  present locally", you skipped the build or pasted the wrong ID.
- Ensure `NODE_AGENT_IMAGE` is a real `sha256:<64hex>` from
  `docker image inspect --format '{{.Id}}' amnezia-panel/node-agent:1.0.0-local`,
  not a tag.
- For contract changes inside `services/node-agent`, regenerate with
  `npm run openapi:generate` and validate with `npm run openapi:check` (per its
  README); the portable contract lives at `services/node-agent/openapi/openapi.json`.

### Provisioning stuck in `provisioning`

Check, in order: the **worker** container is running (`docker compose ... ps` in
`infra/dev`); the **node is healthy** and reachable (tunnel + `GET /server`); the
**apiKey is correct** (401 above); and `CONFIG_ENCRYPTION_*` match between
control-api and worker (a keyring mismatch prevents the worker from decrypting the
stored node key). Read worker logs for the redacted background error line.

### Common gotchas

- **`DOCKER_GID` mismatch** — preflight fails unless `.env` `DOCKER_GID` equals
  `stat -c '%g' /var/run/docker.sock`.
- **Placeholder `SERVER_PUBLIC_HOST` / `SERVER_ID`** — preflight rejects
  `vpn.example.com` and the placeholder UUID; set real values.
- **Permissions** — `.env` must be `0600`; `secrets/node-agent-api-key` must be
  `0640` owned `root:root`; state files, if present, must be `0600`.
- **Port already in use** — 51889/51890 (UDP) or 4001 (TCP) held by a non-Amnezia
  process fails preflight; free the port or stop the conflicting service.
- **AWG3 won't start** — a missing `HeaderProtectionKey` makes the awg3 entrypoint
  refuse to start; do not hand-edit `state/amnezia-awg3/awg0.conf`. Re-initialize
  only by removing the *entire* AWG3 state set (never partial) so the entrypoint
  regenerates it.
- **Handshake fails on new keys** — usually the `I1` mismatch: it must be present
  and identical on server and client. Don't strip `I1` from the server config.
- **`latest` / Watchtower detected** — preflight scans `compose.yaml` and the
  node-agent `Dockerfile`; remove any mutable tag or Watchtower reference.
