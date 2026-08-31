# CLI & command reference

Every command an operator or developer runs, for both halves of the system:

- **[Panel (control plane)](#panel--control-plane)** — the `pnpm` monorepo that
  runs web + control-api + worker + postgres.
- **[Node (data plane)](#node--data-plane)** — a Linux box running AmneziaWG 3.1
  (`awg3`) plus the node-agent the panel talks to.

`<...>` are placeholders — never paste real secrets, IPs, or domains into a doc.
The panel and a node update **independently**; a panel release never touches a
node and vice-versa.

---

## Panel — control plane

Monorepo root holds the workspaces `apps/web` (`@amnezia/web`), `apps/control-api`
(`@amnezia/control-api`), `apps/worker` (`@amnezia/worker`), `apps/cli`
(`@amnezia/cli`), `packages/contracts`, `packages/db`. Package manager `pnpm`,
Node ≥ 24. Two Compose stacks build one shared image from `infra/dev/Dockerfile`:
`infra/dev/compose.yaml` (local/dev) and `infra/prod/compose.yaml` (production,
tiny-host, pulls the image from GHCR).

### Dev — run locally

| Command | Dir | Purpose |
| --- | --- | --- |
| `pnpm install` | root | Install all workspace deps |
| `pnpm dev` | root | web + control-api + worker together in watch mode |
| `pnpm --filter @amnezia/web dev` | root | Just the web dev server (`next dev`) |
| `pnpm --filter @amnezia/control-api dev` | root | Just the control-api (`tsx watch`) |
| `pnpm --filter @amnezia/worker dev` | root | Just the worker (`tsx watch`) |
| `docker compose --env-file .env up --build` | `infra/dev` | Whole containerized dev stack; app at `http://127.0.0.1:3000` |

Local auth: the dev stack sets `ALLOW_DEV_IDENTITY=true` + `DEV_USER_EMAIL`
(default `admin@example.com`), so the web injects `x-dev-user-email` and you need
neither Cloudflare Access nor the Google login to sign in.

### Build / test / lint / typecheck

Run from the repo root; each fans out to every workspace (`pnpm -r --if-present`):

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build all workspaces |
| `pnpm test` | Run all test suites |
| `pnpm test:coverage` | Tests with coverage |
| `pnpm lint` | ESLint everywhere |
| `pnpm typecheck` | `tsc --noEmit` everywhere |

Scope to one package with `pnpm --filter <name> <script>`, e.g.
`pnpm --filter @amnezia/web build`. CI (`.github/workflows/ci.yml`) runs
`lint → typecheck → build → db:migrate → test`; run those four before pushing.

### Database (Drizzle + Postgres)

Schema `packages/db/src/schema.ts`, migrations `packages/db/migrations/`.

| Command | Dir | Purpose |
| --- | --- | --- |
| `pnpm --filter @amnezia/db db:generate` | root | Generate a new SQL migration from schema changes |
| `pnpm --filter @amnezia/db db:migrate` | root | Apply forward-only migrations (needs `DATABASE_URL`) |

In a Compose stack a one-shot `migrate` service runs the compiled migrator
(`node dist/migrate.js`) to completion before control-api/web start — you rarely
call it by hand. Migrations are **forward-only**; undoing a destructive one means
a DB restore, not a down-migration.

### Deploy / update (production)

The live host runs `infra/prod` and **pulls** the published image
(`PANEL_IMAGE=ghcr.io/<owner>/amnezia-shared-panel:latest`). A release is cut by
tagging the public repo `vX.Y.Z`, which builds + pushes the image via
`.github/workflows/release.yml` (the tag is stamped into `GET /api/admin/version`).

| Command | Where | Purpose |
| --- | --- | --- |
| `bash infra/prod/update.sh` | server, repo root | **The update.** Backup DB → down → drop old image → pull → migrate → up → ps (data-safe; volumes untouched) |
| `docker compose -f infra/prod/compose.yaml ps` | server | Service status / health |
| `docker compose -f infra/prod/compose.yaml logs -f --tail 100 <svc>` | server | Follow logs for `web`/`control-api`/`worker`/`postgres` |
| `docker compose -f infra/prod/compose.yaml up -d <svc>` | server | Recreate one service (e.g. after editing `.env`) |

The **in-panel "Update" button** (Administration → Overview) does the same
`update.sh` via a host systemd worker, so admins never touch SSH. Install it once:

| Command | Where | Purpose |
| --- | --- | --- |
| `sudo bash infra/prod/install-updater.sh` | server, root | Install the `panel-updater.{service,path}` watcher + spool (one-time) |
| `systemctl status panel-updater.path` | server | Check the update watcher is armed |
| `journalctl -u panel-updater.service -n 50` | server | Read the last updater run |

Mechanism: `POST /api/admin/update` writes a trigger file to a spool the
control-api can write but that carries no Docker socket; a `systemd` path unit
sees it and runs `update.sh`. See [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md).

The dev-stack git-pull runbook (rebuild instead of pull) lives in
[`DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md); `scripts/deploy.sh [--build]` is its
safe wrapper (backup → pull/build → migrate → up).

### Ops — backup / restore

| Command | Dir | Purpose |
| --- | --- | --- |
| `scripts/backup-db.sh [out-dir]` | root | Timestamped gzipped `pg_dump` (default `./backups`) |
| `scripts/restore-db.sh <dump.sql.gz>` | root | Restore a dump into the running postgres |
| `COMPOSE_DIR=infra/prod bash scripts/backup-db.sh` | root | Back up the **prod** DB (what `update.sh` runs first) |

Overridable env: `COMPOSE_DIR` (default `infra/dev`), `POSTGRES_USER`/`POSTGRES_DB`
(default `amnezia_panel`). `backups/` is git-ignored.

### Bootstrap & admin CLI

The **first admin** is provisioned by env, not a command: the first login by any
address in `BOOTSTRAP_ADMIN_EMAILS` becomes `admin`.

`apps/cli` (binary `amnezia-panel`) is a thin admin client over the control-api.
Build with `pnpm --filter @amnezia/cli build`, then run `node apps/cli/dist/main.js
<cmd>` (or `pnpm --filter @amnezia/cli dev -- <cmd>`). It authenticates as an admin
via `CONTROL_API_URL` plus either `PANEL_ADMIN_EMAIL` (dev `x-dev-user-email`) or a
Cloudflare Access service token (`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`).

**Read** (add `--json` to any):

| Command | Purpose |
| --- | --- |
| `overview` / `users` / `keys` / `nodes` / `audit [--limit=N]` / `policy` | State snapshots |
| `quota` | Pending key-limit requests, with their ids and `current → requested` |

**User management** (every command below takes a user **id or email**):

| Command | Purpose |
| --- | --- |
| `user-create <email> [name] [--admin]` | Create a user or admin |
| `user-role <id\|email> <admin\|user>` | Promote / demote (the last admin is protected) |
| `user-limit <id\|email> <n\|default>` | Set the key-limit override (`default` clears it) |
| `user-disable <id\|email>` | Offboard: disable the user and revoke their keys |
| `user-enable <id\|email>` | Reinstate a disabled user |
| `quota-approve <req-id> [note]` | Approve a quota request (applies the new limit) |
| `quota-reject <req-id> [note]` | Reject a quota request |

**Keys / nodes / config:**

| Command | Purpose |
| --- | --- |
| `key-revoke <id>` · `key-disable <id>` · `key-enable <id>` | Key lifecycle |
| `node-reconcile <id>` | Force a node re-sync |
| `policy-set --<field>=<value> …` | Set portal-policy fields (e.g. `--defaultKeyLimit=10`) |
| `cf-config --account= --app= --policy=` | Set Cloudflare Access IDs |
| `cf-token <token>` | Store the Cloudflare API token (encrypted at rest) |

Example: `CONTROL_API_URL=http://127.0.0.1:3001 PANEL_ADMIN_EMAIL=admin@example.com
node apps/cli/dist/main.js overview`. Typical flow to grant more keys:
`… quota` (copy the request id) → `… quota-approve <req-id>`.

### Direct-login (server-side Google) operator notes

The direct path (a DNS-only host with the panel's own Google login, for users who
can't reach Cloudflare) is env + edge only — see
[`INSTALL.md` §3.5](./INSTALL.md). Its env lives in `infra/prod/.env`
(`PANEL_IDENTITY_SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `PANEL_PUBLIC_URL`,
`AUTH_ALLOWED_DOMAINS`); after editing, `docker compose -f infra/prod/compose.yaml
up -d web control-api`. Pre-create a user who is not on an allowed domain in
Administration → Users (or `amnezia-panel user-create <email>`).

---

## Node — data plane

A node runs three containers from `infra/node/compose.yaml` (project
`amnezia-node`): `amnezia-awg2` (UDP 51889), `amnezia-awg3` (UDP 51890, the
primary), and `amnezia-node-agent` (loopback `127.0.0.1:4001`). The awg3 image is
a pinned `amneziavpn/amneziawg-go:3.1.x` userspace daemon (no host kernel module).
The node-agent shells into the container as `docker exec amnezia-awg3 sh -lc
'<cmd>'` — every `awg` command below runs **inside** the container that way.

> **Never run raw `docker compose up` in production** — use `scripts/deploy.sh`,
> which preflights, takes a pre-deploy backup, and gates on health. Peer changes
> never restart the interface (see the syncconf note), so day-to-day the VPN is
> never interrupted.

### Install / provision (`infra/node`)

Operator scripts under `infra/node/scripts/` wrap Compose with preflight + backup
+ health gates. Typical first bring-up (details in
[`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) and `infra/node/README.md`):

| Command | Purpose |
| --- | --- |
| `install -m 600 .env.example .env` | Seed the node `.env` (0600) |
| `install -d -m 700 secrets state/amnezia-awg2 state/amnezia-awg3 backups` | Create the state/secret/backup layout |
| `(umask 077; openssl rand -base64 48 > secrets/node-agent-api-key)` | Generate the node-agent API key (≥ 32 bytes) |
| `stat -c '%g' /var/run/docker.sock` | Read the Docker socket GID → `DOCKER_GID` in `.env` |
| `sh scripts/build-node-agent.sh` | Build + pin the node-agent image; prints the `sha256:` for `.env` |
| `sh scripts/preflight.sh` | Gate: amd64, Docker/TUN, image pins, perms, port conflicts, disk/RAM |
| `sh scripts/deploy.sh` | **Production deploy**: preflight → pull/verify images → backup → up → health |

`PROTOCOLS_ENABLED` selects protocols (`amneziawg3` for a 3.1-only node). The awg3
entrypoint randomises the obfuscation headers and writes `awg0.conf` with
`HeaderProtectionKey` + `RandomTrailers = on` — the markers that prove genuine
3.1 (a 2.0 config can't carry them).

### AmneziaWG (`awg`) — inside the awg3 container

Run as `docker exec amnezia-awg3 sh -lc '<cmd>'`:

| `<cmd>` | Purpose |
| --- | --- |
| `awg show awg0` | Human-readable interface + peer status (handshakes) |
| `awg show awg0 dump` | Machine dump — per-peer handshake/traffic/endpoint |
| `awg syncconf awg0 <(awg-quick strip /opt/amnezia/awg/awg0.conf)` | **Apply peer add/remove/enable/disable live, without dropping users** |
| `awg genkey` / `awg pubkey` / `awg genpsk` | Key material (server/client keys, PSK / header-protection key) |

Peer add = append a `[Peer]` block to `awg0.conf` then `syncconf`; disable = set
that peer's `AllowedIPs = 0.0.0.0/32` then `syncconf` (keys preserved); delete =
drop the block then `syncconf`. The node-agent does this for you; the interface is
never restarted for a peer change.

### Docker (host)

| Command | Purpose |
| --- | --- |
| `docker compose --project-directory <node-dir> --env-file .env -f compose.yaml ps` | Stack status / health |
| `docker compose … logs -f --tail 200 <svc>` | Follow a service (`awg3`, `node-agent`, `awg2`) |
| `docker compose … stop --timeout 30 node-agent awg2 awg3` | Graceful stop (backup/rollback consistency) |
| `docker compose … start awg3` | Start a specific service back up |
| `docker port amnezia-node-agent 4001/tcp` | Confirm the agent is bound **only** to `127.0.0.1:4001` |
| `docker logs amnezia-awg3` | Raw container logs (bounded: 10 MB × 3) |

### Node-agent (the HTTP API the panel calls)

The agent is Fastify on `127.0.0.1:4001`, authenticated with `x-api-key`; it has
**no CLI** — the panel's control-api drives it. Key env (`infra/node/.env`):
`FASTIFY_API_KEY`, `PROTOCOLS_ENABLED`, `SERVER_ID`, `SERVER_PUBLIC_HOST`,
`DOCKER_GID`. API surface (full list in `services/node-agent/README.md`):

- `GET /clients`, `POST /clients` (create → returns `vpn://` config), `PATCH
  /clients`, `POST /clients/qr`, `DELETE /clients`
- `GET /server`, `GET /server/load`, `GET|POST /server/backup`, `POST /server/reboot`
- `GET /healthz`, `GET /metrics`, `GET /docs` (unauthenticated)

Register the node in the panel (Administration → Nodes) with its `apiBaseUrl` and
the API key; see [`NODE-CONNECT.md`](./NODE-CONNECT.md).

### Health / logs / backup

| Command | Purpose |
| --- | --- |
| `docker compose --env-file .env ps` | All three containers should read `healthy` |
| `docker exec amnezia-awg3 sh -lc 'awg show awg0 dump'` | Verify handshakes / per-peer traffic by hand |
| `docker port amnezia-node-agent 4001/tcp` → `127.0.0.1:4001` | Confirm loopback-only (no public exposure) |
| `ss -H -lun 'sport = :51890'` | Check the awg3 UDP port isn't hijacked by a stale forward |
| `sh scripts/backup.sh` | Consistent snapshot (briefly stops the stack — announce first) |
| `sha256sum -c <archive>.sha256` | Verify a backup before restoring |
| `sh scripts/rollback.sh <abs-path>.tar.gz` | Validated restore with a safety backup + health gates |

> A **backup briefly interrupts the VPN** to snapshot a consistent
> `awg0.conf` + `clientsTable`; peer edits do not. Keep TCP 4001 loopback-only —
> the agent mounts the Docker socket, so exposing it is host-level access.

---

See also: [`INSTALL.md`](./INSTALL.md) (end-to-end runbook),
[`HOSTING.md`](./HOSTING.md), [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md),
[`NODE-CONNECT.md`](./NODE-CONNECT.md), [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md).
