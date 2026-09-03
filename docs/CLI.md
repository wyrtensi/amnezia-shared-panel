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
(default `amnezia_panel`). `backups/` is git-ignored. Dumps are written `0600`
inside a `0700` directory (the script sets `umask 077` and tightens `out-dir`),
because a dump carries every user, email, role and traffic row.

### Bootstrap & admin CLI

The **first admin** is provisioned by env, not a command: the first login by any
address in `BOOTSTRAP_ADMIN_EMAILS` becomes `admin`.

`apps/cli` (binary `amnezia-panel`) is a thin admin client over the control-api.
Build with `pnpm --filter @amnezia/cli build`, then run `node apps/cli/dist/main.js
<cmd>` (or `pnpm --filter @amnezia/cli dev -- <cmd>`). It authenticates as an admin
via `CONTROL_API_URL` plus one of, in priority order:

1. **`PANEL_IDENTITY_SECRET`** (+ `CLI_ADMIN_EMAIL`, or the first `BOOTSTRAP_ADMIN_EMAILS`)
   — the CLI mints the same `x-panel-identity` token the web issues after login, so a
   **co-located operator is admin in production** without a browser. The panel host
   already holds this secret; run the CLI where it is set (e.g. inside the control-api
   container). This is the recommended production path.
2. A Cloudflare Access **service token** (`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`)
   when the CLI reaches the API **through** Cloudflare (the service token must be allowed
   by the app's policy and map to an admin).
3. `PANEL_ADMIN_EMAIL` (dev `x-dev-user-email`) — honoured only when the API runs in dev.

**Read** (add `--json` to any):

| Command | Purpose |
| --- | --- |
| `overview` / `users` / `keys [--device-type=<value>] [--needs-profile-warning]` / `nodes` / `audit [--limit=N]` / `policy` | State snapshots. `keys` shows each key's stored **platform** beside the free-text device label — they can disagree, and after the T14 migration a key labelled `Laptop` legitimately reads platform `—` (`unspecified`) until someone re-classifies it. `keys --device-type=<value>` filters to one platform (including `unspecified`), which is how to count what still needs re-classifying without opening `psql`. `keys --needs-profile-warning` lists the keys that pair a device whose client ignores route profiles with a split-tunnel profile — the combination the key card warns about, and the one an admin or a CLI call can still create; the listing adds a `route` column so each row shows the profile it was matched on |
| `global-routes` | Admin-wide route additions / exclusions per split-tunnel profile |
| `quota [--all]` | Key-limit requests (pending by default; `--all` = every state), with ids, the **target** server (its name, or `all servers`), `current → requested`, and date |
| `version` | Panel version + commit of the running control-api, plus `awg3-client-floor` — the AmneziaVPN client release an AWG 3.1 key needs, served by the panel so the CLI and the install guide cannot disagree |
| `traffic [--days=N]` | Aggregate traffic series across all users (JSON) |
| `client-releases` | What the panel currently hands users as AmneziaVPN download links, per platform: the resolved release version, each link's kind (`store` / `installer` / `releasePage`), file name and size, plus the Android APK that backs the Google Play button. Also shows `resolvedAt` and whether the panel is serving the **offline fallback** because it could not reach GitHub |

**User management** (every command below takes a user **id or email**):

| Command | Purpose |
| --- | --- |
| `user-create <email> [name] [--admin]` | Create a user or admin |
| `user-role <id\|email> <admin\|user>` | Promote / demote (the last admin is protected) |
| `user-limit <id\|email> <n\|default> [--node-limits=<uuid>:<n>,…\|none] [--allowed-nodes=all\|none\|uuid,…]` | Set the user's key quota. The positional value is the flat per-node limit (`default` clears the override). `--node-limits` **replaces** the per-node limits (`none`/empty clears them; `0` means no keys on that node); `--allowed-nodes` sets node availability (`all` clears the per-user override so the global list applies, `none` allows no node). An omitted flag leaves that part unchanged, and `--allowed-nodes` merges into the per-user policy override instead of replacing it |
| `user-disable <id\|email>` | Offboard: disable the user and revoke their keys |
| `user-enable <id\|email>` | Reinstate a disabled user |
| `user-nodes <id\|email> <all\|none\|uuid,…>` | Per-user node availability — `all` = every node, overriding the global allowed-node list (this is how an admin sees every node while regular users are limited). It **replaces** the whole per-user policy override; use `user-limit --allowed-nodes=` to change availability alone |
| `user-routes <id\|email> [--wl-domains=] [--wl-cidrs=] [--bl-domains=] [--bl-cidrs=]` | Replace a user's custom routes (whitelist/blacklist domains + CIDRs) |
| `user-create-key <id\|email> --node=<uuid> [--device=] [--protocol=awg3] [--route=full_tunnel] [--device-type=android\|ios\|macos\|windows\|linux\|other] [--name-server=] [--name-label=] [--name-number=]` | Provision a key on behalf of a user. `--device-type` names the platform the key is for — `ios` covers both iPhone and iPad. The retired values `desktop`, `laptop`, `phone`, `tablet` and `iphone` are refused with the replacement named. `unspecified` is also accepted, for a scripted import that genuinely does not know the platform; omitting the flag stores the same thing. Pairing `--device-type=ios` with a `--route=` other than `full_tunnel` prints a warning to stderr and **still creates the key** — on iPhone and iPad the client imports a route profile, connects, and then applies none of its rules, so that key sends every packet outside the tunnel. The panel does not refuse it: the same key works normally if it is opened on a desktop. The `--name-*` flags (`true`/`false`) choose which parts the VPN client shows as the connection name — default server + device label, no number |
| `quota-approve <req-id> [note]` | Approve a quota request. The grant follows the request's own target: a per-server request sets that node's per-node limit, an all-servers request sets the flat override **and clears the user's per-node limits** so the granted number cannot be shadowed. Approval never widens node availability |
| `quota-reject <req-id> [note]` | Reject a quota request |

**Keys / nodes / config:**

| Command | Purpose |
| --- | --- |
| `key-revoke <id>` · `key-disable <id>` · `key-enable <id>` | Key lifecycle |
| `key-config <id> [--format=vpn\|conf\|qr\|qr-svg\|qr-frames] [--out=<path>] [--confirm]` | Download one key's config. `vpn` (default) and `conf` print to stdout; `qr` writes the PNG a user downloads (to `<id>.png` unless `--out` is given), `qr-svg` the SVG the panel displays, and `qr-frames` the AmneziaVPN-format series as `<id>.frame-N.svg`. `--confirm` is required to read a key you do not own, and is audited as `vpn_key.private_config_viewed` |
| `node-add --name= --api-url= --api-key-file=<path\|-> [--public-name=] [--protocol=awg3] [--max-peers=N] [--enabled-protocols=awg3,awg2] [--disabled]` | Register a node. `--api-key-file=-` reads the key from stdin; the legacy `--api-key=<key>` still works but exposes the key in `ps` and shell history |
| `node-update <id> --<field>=<value> …` | Edit a node (name, api-url, api-key-file (or api-key), public-name, protocol, max-peers, enabled, enabled-protocols) |
| `node-remove <id>` | Delete a node. Refused with `409 NODE_HAS_KEYS` while it still has keys (revoked ones count) — disable it, or use the form below |
| `node-remove <id> --with-keys --confirm=<node name>` | Delete a node **and every key ever issued on it**, in one transaction. Irreversible. Without a matching `--confirm` the command only prints what it would destroy. Note that peers already configured on a still-running node keep working — the panel cannot reach a node it is deleting, so wipe the server itself too |
| `node-reconcile <id>` | Force a node re-sync |
| `policy-set --<field>=<value> …` | Set portal-policy fields (e.g. `--defaultKeyLimit=10`). `--video-desktop=`, `--video-android=`, `--video-ios=` attach the walkthrough video shown at the top of each audience's block in the in-panel connection guide (`none` clears one). They **merge** with the videos already set, so naming one audience does not clear the other two; until a URL is set that block shows a placeholder rather than a player. A **Google Drive share link** (the file must be readable by anyone with the link) is embedded as a Drive preview — Drive no longer serves files dependably to a plain `<video>` tag; any other http(s) URL plays as a direct file. A link the panel cannot play is refused when you type it. **These URLs are deployment settings: they live in your panel's database, never in this repository** — `scripts/tests/no-deployment-links.test.mjs` fails the build if one is committed |
| `global-routes-set --profile=ru_whitelist\|ru_blacklist [--add-domains=] [--add-cidrs=] [--exclude-domains=] [--exclude-cidrs=]` | Admin-wide route overrides for one split-tunnel profile. Each list given **replaces** that list; omitted lists stay as they were |
| `cf-config --account= --app= --policy=` | Set Cloudflare Access IDs |
| `cf-token <token>` · `cf-token --token-file=<path\|->` | Store the Cloudflare API token (encrypted at rest). Prefer the file/stdin form: a token passed as an argument is visible in `ps` and in shell history for as long as the process lives |
| `panel-update [--status] [--json]` | Trigger the in-panel update (backup → pull → migrate → restart), or show its status. `--status` prints a readable line — the pending request, and whether the last host run finished `ok` or `FAILED` with its reason; `--status --json` returns the raw status object unchanged |
| `client-releases --refresh` | Discard the cached release snapshot and resolve it again now (admin only). The panel otherwise re-checks every 6 hours after a success, and every 15 minutes after a failure — use this after restoring egress on a host that was serving the offline fallback |

**Two QR codes, two scanners.** The panel offers a different code depending on
what the user will point at the screen, because the two scanners do not read the
same thing:

- **AmneziaVPN's own "scan QR" button** does not read a `vpn://` URL at all. It
  expects the app's own frame format — a base64url blob behind an 8-byte header
  with a magic number — and silently ignores anything else, however large and
  sharp it is. That is `--format=qr-frames`, and it is the format the panel now
  ships for that scanner. A series of more than one frame is shown in the panel
  in one of two modes, animated or static.
- **An ordinary camera app** reads the QR as text, sees the `vpn://…` URL and
  hands it to the OS, which opens AmneziaVPN. That is `--format=qr` (PNG, for
  download) and `--format=qr-svg` (what the panel displays). A camera app cannot
  read `qr-frames` at all, so these stay fully supported and the config dialog
  opens on the camera code by default.

**Reproducing a "the QR does not scan" report.** First establish *which* scanner
the person used, because the two failures have nothing in common.

```sh
# what a camera app sees
amnezia-panel key-config <key-id> --format=qr --out=/tmp/key.png --confirm
amnezia-panel key-config <key-id> --format=qr-svg --confirm > /tmp/key.svg

# what the AmneziaVPN app's own scanner sees
amnezia-panel key-config <key-id> --format=qr-frames --out=/tmp/key --confirm
```

If a code will not scan **with a camera app** off a monitor or a laptop screen,
it is an optical problem: the first thing to try is the full-screen button in the
config dialog, which sizes the symbol against the viewport rather than a fixed
pixel width and therefore survives a high-DPI display. The panel also picks the
error-correction level from the payload's measured symbol size, so a long
full-tunnel key gets a sparser, larger-module code than a short one. Changing
that level never changes the config itself — only how much redundancy is packed
around it. The inline code is large enough on coarse-pitch screens (a 1366×768
laptop, a 24″ 1080p monitor); on a 13″ 1080p laptop with OS scaling turned off,
or on any unscaled high-DPI monitor, the full-screen view is not optional.

If a code will not scan **from inside the AmneziaVPN app**, size is irrelevant:
check that the person is looking at the "AmneziaVPN app" code and not the camera
one — the dialog opens on the camera code.

The QR is offered only for keys with the `full_tunnel` route profile.
Whitelist/blacklist profiles carry thousands of routes and are refused with
`422 QR_TOO_LARGE` for all three QR formats — that is expected, not a fault; the
CLI prints the refusal as one line and you should use `--format=conf`. The frame
series is capped the same way: a config that would need more than eight frames is
refused rather than handed over, because nobody scans eight codes.

**Co-located production example** — run inside the control-api container, which already
carries `PANEL_IDENTITY_SECRET` + `BOOTSTRAP_ADMIN_EMAILS`:

```sh
CID=$(docker compose -f infra/prod/compose.yaml ps -q control-api)
docker exec "$CID" node apps/cli/dist/main.js overview
# register the co-located node
docker exec -i "$CID" node apps/cli/dist/main.js \
  node-add --name=germany --api-url=http://amnezia-node-agent:4001 --api-key-file=- \
  < infra/node/secrets/node-agent-api-key
# wire two-way Cloudflare Access sync
docker exec "$CID" node apps/cli/dist/main.js cf-config --account=<id> --app=<id> --policy=<id>
docker exec "$CID" node apps/cli/dist/main.js cf-token <cf-api-token>
```

Dev example: `CONTROL_API_URL=http://127.0.0.1:3001 PANEL_ADMIN_EMAIL=admin@example.com
node apps/cli/dist/main.js overview`. Typical flow to grant more keys:
`… quota` (copy the request id) → `… quota-approve <req-id>`.

#### Client download links

The in-panel install guide never hardcodes a download URL: control-api resolves
the newest `amnezia-vpn/amnezia-client` release, caches it for 6 hours (15
minutes after a failed lookup, which is always retried) and serves it to every
user, so a user whose network cannot reach GitHub still gets working buttons.

```sh
amnezia-panel client-releases
amnezia-panel client-releases --refresh      # force a re-resolve now
amnezia-panel client-releases --json         # exactly what the web dialog receives
```

`state: OFFLINE FALLBACK` means the panel has never managed to reach GitHub since
it started: every non-store link then points at the releases page rather than a
direct installer. Check the host's outbound access and run `--refresh`.

The **client version floor** is a separate number and lives on `version`:

```sh
amnezia-panel version
# version: 1.4.0   commit: abc1234   awg3-client-floor: 5.0.1.5
```

`awg3-client-floor` is the client release the panel tells users an AWG 3.1 key
needs. It is the same constant the install guide interpolates, served from the
panel rather than copied into the CLI, so the two cannot disagree. A user on an
older client sees a key that imports and then fails to connect — check this
number first.

#### Global route overrides

`global-routes` / `global-routes-set` edit an admin-wide layer applied to every
split-tunnel export, on top of the profile's active feed:

1. the active feed payload;
2. **minus** the admin exclusions — CIDRs match exactly, a domain also removes
   every subdomain of it (`example.com` drops `a.b.example.com`);
3. **plus** the admin additions;
4. **plus** the owner's own custom routes — applied last on purpose, so a user
   who lists an excluded entry in `user-routes` opts back into it.

```sh
amnezia-panel global-routes
amnezia-panel global-routes-set --profile=ru_blacklist \
  --exclude-domains=example.com,ads.example.net --add-cidrs=203.0.113.0/24
```

Entries are validated exactly like per-user custom routes (bare IPs normalized
to host routes, domains lowercased, no wildcards), with a 2000-entry cap per
list. The audit log records only the resulting counts, never the entries.

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
