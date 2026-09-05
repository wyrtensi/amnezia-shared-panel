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
| `overview` / `users [--domain=<domain>]` / `keys [--device-type=<value>] [--node=<id>] [--needs-profile-warning] [--stale [--stale-days=N]]` / `nodes [--hosts]` / `audit [--limit=N]` / `policy` | State snapshots. `users` has a `mode` column with each user's **effective** key-limit mode — `per_node` (the number is per server) or `global` (one shared total across every server) — and a `*` marks a mode set on that user rather than inherited from the panel-wide `keyLimitMode`; it is what says whether the `limit` beside it is a per-server number or a pool. `users --domain=<domain>` keeps only the users whose address sits on one email domain — the shell half of the Users page's domain picker, and the way to ask "is anyone from this company still in the panel" before a `cf-domains --remove`. `@company.tld` and `company.tld` are the same filter, so a domain pasted out of the Cloudflare dashboard's "emails ending in @company.tld" works as typed; the match is on the whole domain, so `company.tld` never admits `notcompany.tld` or `mail.company.tld`. The filter runs before `--json` as well as before the table, and a domain nobody is on prints `(none)` rather than failing — with no list of existing domains in a shell, "nobody" is the answer to the question. `keys` shows each key's stored **platform** beside the free-text device label — they can disagree, and after the T14 migration a key labelled `Laptop` legitimately reads platform `—` (`unspecified`) until someone re-classifies it. `keys --device-type=<value>` filters to one platform (including `unspecified`), which is how to count what still needs re-classifying without opening `psql`. `keys --node=<id>` lists only the keys on one node — the non-destructive way to count what a `node-remove --with-keys` would take with it, without invoking that command for its refusal message. `keys --needs-profile-warning` lists the keys that pair a device whose client ignores route profiles with a split-tunnel profile; the listing adds a `route` column so each row shows the profile it was matched on. Since the create-key wizard stopped gating profiles by platform, and the key card's warning about that pair was removed with it, **any user can make this combination for themselves and nothing in the panel says so** — expect the count to grow, and treat this filter and the warning `user-create-key` prints as the only two places the pair is still visible. `keys --stale` lists the keys **nobody is using**, judged one key at a time on that key's own last handshake rather than on its owner's activity, and adds a `why` and a `stale` column so a listed row shows what it was matched on: `why=idle` is a key that has been used, last time more than 30 days ago (`--stale-days=N` moves the window); `why=never` is a key nobody has *ever* connected with **and** that is itself older than the window. A key issued this week that has not connected yet is deliberately **not** listed — it has no handshake for the same reason an abandoned key does, and flagging it would put every freshly provisioned key on the cleanup list. `--json` carries the ids plus `activity` and `staleFor` per key. `nodes` has an `address` column with the public address clients actually connect to — the node-agent's own `SERVER_PUBLIC_HOST` and, in brackets, the IPv4 address the panel resolved it to. A DNS name that resolved reads `vpn.example.com (203.0.113.10)`, one the panel could not resolve reads `vpn.example.com (unresolved)` (the same state the node card flags), a node configured with a bare IP reads just that IP, and `—` means the node runs an agent old enough not to report the field at all. `nodes --json` carries `publicHost`, `publicIp` and `publicIpResolvedAt` in full — the last is a diagnostic saying when the panel learned the address, not a freshness signal: the address is resolved once and kept. `nodes` also lists servers **in the order users see them** — `#` is that position and `-` marks a server nobody has placed, which therefore sorts last and cannot be recommended — with `rec` marking the recommended prefix and an `id` column so ids paste straight into `policy-set --nodeOrder=`. `policy` prints `(all)` for an unrestricted `allowedNodeIds` but `(none)` for an empty recommended list or server order, and ends with an `order check` line that re-validates the stored recommended-must-be-a-prefix rule: the API only checks it when accepting a write, so a row edited in SQL can violate it silently. `nodes --hosts` answers the other half of that question — how the **panel** reaches each agent (`apiBaseUrl`), classified `ip`, `docker-local` (a compose service name or `host.docker.internal`, resolved by Docker rather than public DNS), `dns` or `unknown`. A `dns` row is the finding: the panel host resolves that name before every poll, and a resolver failure is indistinguishable from an unhealthy node. This is the audit in `docs/NODE-CONNECT.md`, "Use the IP address, not a DNS name", run as one command |
| `stale-keys [--days=N] [--all]` | **Who** is holding keys nobody uses, and how many each — the shell half of the admin overview's stale-key block, and the list to work down before running the cleanup below. One row per user with at least one stale key (`--all` keeps everyone, so the finding has a denominator), worst first: `stale` (= `idle` + `never`), `keys` — how many of their keys hold a peer on a node at all, `fresh` — how many are too young to have connected yet and therefore never counted as stale, and `oldest`, how long the longest-stale one has been that way. Counted per key on purpose: a user with one live phone and five abandoned laptop keys is active by every owner-level reading, and those five peers are exactly what this is for |
| `periods` | Every background period the panel runs on: what is set, the built-in default an unset one falls back to, and the range each accepts. See [Background periods](#background-periods) |
| `global-routes` | Admin-wide route additions / exclusions per split-tunnel profile |
| `quota [--all]` | Key-limit requests (pending by default; `--all` = every state), with ids, the **target** server (its name, or `all servers`), `current → requested`, and date. Both the target and the `current → requested` numbers are reported **in that user's own key-limit mode**: under a global (shared) limit the per-server limits are dormant, so `current` is the pool and a request that named a server reads `all servers (request named …)` — approving it raises the total, not that server |
| `version` | Panel version + commit of the running control-api, the repository the image was built from, plus `awg3-client-floor` — the AmneziaVPN client release an AWG 3.1 key needs, served by the panel so the CLI and the install guide cannot disagree |
| `traffic [--days=N]` | Aggregate traffic series across all users (JSON) |
| `client-releases` | What the panel currently hands users as AmneziaVPN download links, per platform: the resolved release version, each link's kind (`store` / `installer` / `releasePage`), file name and size, plus the Android APK that backs the Google Play button. Also shows `resolvedAt` and whether the panel is serving the **offline fallback** because it could not reach GitHub |

**User management** (every command below takes a user **id or email**):

| Command | Purpose |
| --- | --- |
| `user-create <email> [name] [--admin]` | Create a user or admin |
| `user-role <id\|email> <admin\|user>` | Promote / demote (the last admin is protected) |
| `user-limit <id\|email> <n\|default> [--node-limits=<uuid>:<n>,…\|none] [--allowed-nodes=all\|none\|uuid,…] [--mode=per_node\|global\|inherit]` | Set the user's key quota. The positional value is the flat limit (`default` clears the override). `--node-limits` **replaces** the per-node limits (`none`/empty clears them; `0` means no keys on that node); `--allowed-nodes` sets node availability (`all` clears the per-user override so the global list applies, `none` allows no node). `--mode` overrides **how the number is counted** for this user (`inherit` clears the override and the panel-wide `keyLimitMode` applies again): in `global` mode the number is one total across every server, and per-server limits are kept in the database but not applied — so a `--node-limits=` written in that mode is stored dormant and the command says so. An omitted flag leaves that part unchanged, and `--allowed-nodes`/`--mode` merge into the per-user policy override instead of replacing it |
| `user-disable <id\|email>` | Offboard: disable the user and revoke their keys |
| `user-enable <id\|email>` | Reinstate a disabled user |
| `user-nodes <id\|email> <all\|none\|uuid,…>` | Per-user node availability — `all` = every node, overriding the global allowed-node list (this is how an admin sees every node while regular users are limited). It **replaces** the whole per-user policy override; use `user-limit --allowed-nodes=` to change availability alone |
| `user-routes <id\|email> [--wl-domains=] [--wl-cidrs=] [--bl-domains=] [--bl-cidrs=]` | Replace a user's custom routes (whitelist/blacklist domains + CIDRs) |
| `user-create-key <id\|email> --node=<uuid> [--device=] [--protocol=awg3] [--route=full_tunnel] [--device-type=android\|ios\|macos\|windows\|linux\|other] [--name-server=] [--name-label=] [--name-number=]` | Provision a key on behalf of a user. `--device-type` names the platform the key is for — `ios` covers both iPhone and iPad. The retired values `desktop`, `laptop`, `phone`, `tablet` and `iphone` are refused with the replacement named. `unspecified` is also accepted, for a scripted import that genuinely does not know the platform; omitting the flag stores the same thing. Pairing `--device-type=ios` with a `--route=` other than `full_tunnel` prints a warning to stderr and **still creates the key**. The observed failure is the **Default VPN** app — the listing the Russian App Store offers, because AmneziaVPN itself is hidden from it: there a route profile imports, connects, and then applies none of its rules, so the key sends every packet outside the tunnel. AmneziaVPN on iOS is a different app and was never observed failing, which is why this is a warning and not a refusal. The panel's create-key wizard no longer gates the choice at all — it cannot tell which client a device runs, so it offers every profile on every platform and this line is the only place the caveat survives. The same key also works normally if it is opened on a desktop. The `--name-*` flags (`true`/`false`) choose which parts the VPN client shows as the connection name — default server + device label, no number |
| `quota-approve <req-id> [note]` | Approve a quota request. In `per_node` mode the grant follows the request's own target: a per-server request sets that node's per-node limit, an all-servers request sets the flat override **and clears the user's per-node limits** so the granted number cannot be shadowed. In `global` mode any request raises the **total** and leaves per-server limits untouched; a request that still names a server is approved as a total raise and marked `targetCoerced` in the audit log — run `quota` first, its `target` cell shows that coercion before you approve. Approval never widens node availability, and it never changes the mode |
| `quota-reject <req-id> [note]` | Reject a quota request |

**Keys / nodes / config:**

| Command | Purpose |
| --- | --- |
| `key-purge <id> --confirm` | **Delete a revoked key from the panel** — the row itself, its traffic history and any pending jobs. Accepted only for a key in `revoked`, the one state where the node has confirmed the peer is gone; anything else is refused with `409 KEY_NOT_PURGEABLE`, because the row is what remembers the peer's label and reconcile finds an orphan by that label. Irreversible: afterwards only the audit event `admin.keys.purge` says the key ever existed, which is why it carries the owner, node, labels and dates. Without `--confirm` it prints what would be lost and does nothing |
| `stale-keys-revoke <id\|email> [--days=N] [--confirm]` | **The per-user cleanup of stale keys**, and the shell half of the panel's "Stale (N)" button. Revokes every key of that user with no handshake for more than N days (default 30) — the same set `keys --stale` lists for them. It **revokes, it never purges**: the peer is deleted from its node, the slot is freed, and the key row, its traffic history and the audit trail all stay, so the user can issue a new key straight away (`key-purge` is the irreversible one and is not reachable from here). Each key is revoked with its own call to the ordinary per-key route, in order, so every one is validated and audited separately; a key whose state moved under you is refused by the API and reported rather than forced, and the command exits non-zero if any did. Without `--confirm` it prints the exact keys — id, device, internal note, node, state, why and how long — and changes nothing. It will not touch a key used inside the window, a key too young to have connected yet, or a key in any state other than `active`/`disabled`. Pick individual keys out instead with `key-revoke <id>`, or in the panel, where every key in the dialog can be unticked |
| `key-revoke <id>` · `key-disable <id>` · `key-enable <id>` | Key lifecycle. `key-revoke` is also the **retry** for a delete that did not go through: a key left in `revoking` because its node was unreachable, or one stuck in `failed` by a panel from before that was fixed. Every call queues a fresh job, and the node-side delete is idempotent, so repeating it is safe. `docs/KEY-STATES.md` has the full state model |
| `key-internal-name <id> --name="<text>"` | Set the operator-only note on a key — who it was really issued to, what it replaced, why it exists. Up to 80 characters; `--name=` with nothing after it clears it. It is **never** returned to the key's owner and **never** part of a generated config, which is what makes it safe to write a person's name in. Distinct from the device label the user typed, which does feed the connection name their client shows. It appears in the `keys` table's `internal` column and on the key's row in the admin panel |
| `key-config <id> [--format=vpn\|conf\|qr\|qr-svg\|qr-frames] [--out=<path>] [--save] [--confirm]` | Download one key's config. `vpn` (default) and `conf` print to stdout; `qr` writes the PNG a user downloads (to `<id>.png` unless `--out` is given), `qr-svg` the SVG the panel displays, and `qr-frames` the in-app-scanner series as `<id>.frame-N.svg` (read by AmneziaVPN and DefaultVPN alike). `--save` writes the file under the name the panel serves it as — the key's own connection name, e.g. `Frankfurt Main laptop #3.vpn` — instead of printing it; `--out` still wins over it, and it is a no-op for `qr-frames`, which always writes files. `--confirm` is required to read a key you do not own, and is audited as `vpn_key.private_config_viewed` |
| `node-add --name= --api-url= --api-key-file=<path\|-> [--public-name=] [--protocol=awg3] [--max-peers=N] [--enabled-protocols=awg3,awg2] [--disabled]` | Register a node. `--api-key-file=-` reads the key from stdin; the legacy `--api-key=<key>` still works but exposes the key in `ps` and shell history |
| `node-update <id> --<field>=<value> …` | Edit a node (name, api-url, api-key-file (or api-key), public-name, protocol, max-peers, enabled, enabled-protocols). `--clear-public-ip` is a flag rather than a field: it forgets the resolved public IP and its timestamp so the worker resolves the node's host again on the next telemetry tick. The panel resolves a host **once** and keeps the answer, because a server's public address does not change under it — this is the recovery for the one case where that assumption breaks, a server moving to a new IP while keeping the same DNS name |
| `node-remove <id>` | Delete a node. Refused with `409 NODE_HAS_KEYS` while it still has keys (revoked ones count) — disable it, or use the form below |
| `node-remove <id> --with-keys --confirm=<node name>` | Delete a node **and every key ever issued on it**, in one transaction. Irreversible. Without a matching `--confirm` the command only prints what it would destroy. Note that peers already configured on a still-running node keep working — the panel cannot reach a node it is deleting, so wipe the server itself too |
| `node-reconcile <id>` | Force a node re-sync |
| `node-capacity <id> [--set=<peers>] [--confirm]` | Show or change how many peers that node accepts (`SERVER_MAX_PEERS`). Without `--set` it prints the panel's limit, the state of the last change and the applier's log. With `--set` and without `--confirm` it prints what would change and changes nothing. The node rewrites its own `.env` and recreates **only** the agent (`--no-deps`), so no tunnel drops and no peer is lost; if the agent does not come back healthy the previous value is restored automatically. 1..500 — 500 is the validated ceiling, and an unvalidated capacity above it stays a shell decision (`scripts/set-capacity.sh <n> --force` on the node). Requires the host-side applier (`infra/node/scripts/install-capacity-applier.sh`); without it the node answers 501 |
| `node-agent-update <id> [--image=<repo@sha256:…>] [--confirm]` | Replace that node's agent with the image the panel currently offers. Without `--confirm` it prints what is running, what would be installed and when that release was resolved, and changes nothing. Only a **digest** in the published repository is accepted — a tag is mutable, so what you confirmed would not be what the node installs. The node pulls the image and recreates **only** the agent (`--no-deps`), so no tunnel drops; an agent that fails its health gate is rolled back to the previous digest. One node at a time on purpose: a bad image taken by the whole fleet at once removes the panel's management path to every node simultaneously, and the panel is what you would use to notice. Requires the host-side updater (`infra/node/scripts/install-agent-updater.sh`); without it the node answers 501. It also **requires node-agent 1.1.9 or newer**: the route shipped in 1.1.3, but 1.1.3 through 1.1.8 answer `500` on both `/server/update` routes — the container could not construct the service behind them, a DI defect fixed only in 1.1.9 — so the first hop to 1.1.9 has to be made over SSH, and this command works for every version after it. That `500` is invisible from the panel: the worker's job fails on the POST, before the node is marked `requested`, so the node card's state never moves and `node-agent-log` stays silent; the reason lands in `job_outbox.last_error` and nowhere else. The panel does not record which agent version a node runs, so there is no column that answers "which nodes are still behind" — see [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) for how to read it per host, and [`NODE-CONNECT.md`](./NODE-CONNECT.md) §5 for the troubleshooting row |
| `node-agent-log <id>` | The node's own record of its last agent update: state, image, when it finished, and the updater's log — which is what explains a failure (a locally edited `compose.yaml`, a missing `.env` key, a health gate) without opening an SSH session |
| `policy-set --<field>=<value> …` | Set portal-policy fields (e.g. `--defaultKeyLimit=10`). `--nodeOrder=<id>,<id>` is the order users see servers in; `--recommendedNodeIds=<id>` badges servers as recommended and **must be the top of that order** (`none` clears either list). Send both in one call when a reorder would leave a badged server out of the top — the API validates them together and otherwise rejects the reorder, naming the server that is out of place, rather than silently un-recommending it. `--keyLimitMode=per_node\|global` is the panel-wide default for how every key limit is counted (`user-limit --mode=` overrides it for one user); there is no `inherit` here, since this **is** the value everyone inherits. `--defaultKeyLimit` is per server in `per_node` mode and the shared total in `global` mode — the number does not move, its meaning does, so switching the mode re-reads every existing limit without writing a row. `--showNodeAddress=true` also shows ordinary users the public address of each node they may use, under the node's name on their dashboard; it is **off by default**, because a node's address is operational information about the fleet and switching it on should be an operator's decision rather than something an upgrade does on their behalf. Admins always see it in `nodes` and on the node card regardless. Users get one collapsed string (the resolved IP, or the reported host when it never resolved) and never the host/IP pair or the resolution timestamp. `--video-desktop=`, `--video-android=`, `--video-ios=` attach the walkthrough video shown at the top of each audience's block in the in-panel connection guide (`none` clears one). They **merge** with the videos already set, so naming one audience does not clear the other two; until a URL is set that block shows a placeholder rather than a player. A **Google Drive share link** (the file must be readable by anyone with the link) is embedded as a Drive preview — Drive no longer serves files dependably to a plain `<video>` tag; any other http(s) URL plays as a direct file. A link the panel cannot play is refused when you type it. **These URLs are deployment settings: they live in your panel's database, never in this repository** — `scripts/tests/no-deployment-links.test.mjs` fails the build if one is committed. The eight background periods — `--telemetryPollSec=`, `--nodeMetricsSampleSec=`, `--nodeMetricsRetentionDays=`, `--peerSampleSec=`, `--maintenanceIntervalSec=`, `--agentReleaseRefreshSec=`, `--ruleFetchIntervalSec=`, `--accessReconcileSec=` — are set the same way, in seconds (days for the retention window); `=default` hands one back to the worker. Out-of-range values are refused before anything is posted. See [Background periods](#background-periods) for the ranges, the defaults and how long a change takes to apply |
| `global-routes-set --profile=ru_whitelist\|ru_blacklist [--add-domains=] [--add-cidrs=] [--exclude-domains=] [--exclude-cidrs=]` | Admin-wide route overrides for one split-tunnel profile. Each list given **replaces** that list; omitted lists stay as they were |
| `node-metrics [--json]` | Host metrics per node — memory, swap, disk, load, the agent's cgroup task count, both AWG interfaces, the agent's own round trip, and how long ago a peer last completed a handshake. Unreported values are a dash, never a zero. Below the table it prints the panel's own warnings, using the same three thresholds the admin card paints red: 200 MiB MemAvailable, 85 % disk, 80 % of the task cap |
| `checks` | Every service check: what it targets, how often it runs, and what it asserts |
| `check-results [<id>]` | Each node's verdict, with the final URL and how long it has been failing. Three statuses, and they are not interchangeable: `ok` (the probe ran and every assertion held), `failed` (the probe ran and one did not), `error` (**the node could not look**, so nothing is known about the service) |
| `check-create --name= --url= <assertion flags>` | Add a check. At least one assertion is required — a check that asserts nothing is always green and looks exactly like one that is passing |
| `check-set <id> [--name=] [--url=] [--method=] [--interval-sec=] [--enabled=true\|false] [<assertion flags>]` | Change **only** the fields you name. Assertion flags replace the whole list. `--interval-sec=` is that check's own period (60..86400), separate from the panel-wide periods in [Background periods](#background-periods); the same number is editable in minutes on the check's row in the admin panel |
| `check-delete <id> [--confirm]` | Delete a check and every node's result for it |
| `check-run <id>` | Mark it due on every node. It does **not** run anything synchronously: the panel reaches nodes on the telemetry poll, so the reading appears after the next one |
| `check-reset <id>` / `check-reset --all` | Clear stored results. **Not destructive**: the result *is* the schedule, so a cleared check is due again and every node measures it afresh on the next poll — which is what you want after changing what a check asserts |
| `node-checks <node>` | What this node runs and what it last answered, check by check |
| `node-checks <node> --all=on\|off` | Take one node in or out of checking entirely — a different statement from "it skips every check today" |
| `node-checks <node> --enable=<check>` / `--disable=<check>` | Turn one check on or off **for this node only**. A check is defined once for the fleet; whether a given node runs it is a property of the node |
| `cf-config --account= --app= --policy=` | Set Cloudflare Access IDs |
| `cf-token <token>` · `cf-token --token-file=<path\|->` | Store the Cloudflare API token (encrypted at rest). Prefer the file/stdin form: a token passed as an argument is visible in `ps` and in shell history for as long as the process lives |
| `cf-sync [--status] [--json]` | Ask the outbox to reconcile the Cloudflare Access allowlist now, instead of waiting for the hourly timer or the next panel-side user change. Refuses up front, without queueing anything, when Cloudflare is not configured (`cf-config` / `cf-token`). `--status` shows the last run as one line, including a run that refused to act (Cloudflare unconfigured, or the blast-radius cap tripped) — that finishes as `failed` with the reason, same as any other failure; `--status --json` returns the raw status object |
| `cf-domains` · `cf-domains --add=<domain>` · `cf-domains --remove=<domain>` · `cf-domains --set=<a,b,…>` · `cf-domains --set=none` | List, or edit, the domains the panel keeps as `email_domain` rules in the Access policy (see `docs/CLOUDFLARE-ACCESS.md`). With no flag it prints the current list. `--add` and `--remove` change one domain at a time; `--set` replaces the whole list. Only one of the three may be given per call — combining them is refused rather than picking a winner. A bare `--set=` (nothing after the `=`, e.g. from an unset shell variable) is **refused**, not treated as "replace with an empty list" — that would silently wipe every domain rule the panel owns on the next sync. `--set=none` is the explicit way to clear the list. The CLI does a light trim/lower-case/strip-`@` locally and posts only `cfAccessAllowedDomains`, never the rest of the policy row; the API is the judge of what counts as a domain, and a rejection (e.g. an address instead of a domain, or a bare TLD) is printed with its own reason. `--remove` of a domain not currently in the list says so and posts nothing. **Any call that drops a domain — `--remove`, `--set=none`, or a `--set` that simply stops naming one — prints what it is dropping and what dropping it costs, before the request goes out**, the same two halves the Users page's removal dialog states: nobody with an active panel account is disabled and no keys are revoked, because the very same write re-emits every active user's own address rule; but everyone on that domain **without** an active panel account loses their only route through Cloudflare, is stopped before the login page, and is no longer auto-provisioned an account on first sign-in. `users --domain=<domain>` lists who is already in the panel on one, which is the check to run first; to undo a removal, add the domain back or add those people as users by address. An accepted change arms an immediate reconcile, the same as `cf-config` (`cf-sync --status` shows it) |
| `panel-update [--status] [--json]` | Trigger the in-panel update (backup → pull → migrate → restart), or show its status. `--status` prints a readable line — the pending request, and whether the last host run finished `ok` or `FAILED` with its reason; `--status --json` returns the raw status object unchanged |
| `client-releases --refresh` | Discard the cached release snapshot and resolve it again now (admin only). The panel otherwise re-checks every 6 hours after a success, and every 15 minutes after a failure — use this after restoring egress on a host that was serving the offline fallback |

**Two config files, and only one of them keeps the key's name.** A key's
connection name — node, device label, `#N`, composed at creation — travels in the
`vpn://` payload's `description`. Every shape built from that payload carries it:
the `vpn://` text, both QR codes, and the frame series. The plain `.conf` does
not, and cannot:

- `--format=vpn` is the **file to hand a user who imports a file**. Saved as
  `<connection name>.vpn` it goes through the client's own "File with connection
  settings" flow — the picker offers `*.vpn *.ovpn *.conf *.json`, and the
  importer sniffs the file's content rather than its extension — and the
  connection appears under the name the panel gave it.
- `--format=conf` is the bare WireGuard/AmneziaWG config, for `awg-quick` and
  router firmwares. Imported into the AmneziaVPN client it always lands as
  "Server 1", "Server 2", …: `ImportController::extractWireGuardConfig` assigns
  `nextAvailableServerName()` unconditionally, the INI parser reads back only a
  fixed whitelist of WireGuard keys, and the file name is shown on the review
  screen but never used as the connection name. There is no comment or extra key
  that changes this, and inventing one would be actively harmful — the client
  sniffs the whole file for the words `containers`, `api_key` and `auth_data`
  *before* it looks for `[Interface]`, so a comment carrying one of those would
  fail the import outright. The panel therefore writes nothing into the file and
  only names the download after the connection, so the user knows what to rename
  "Server 1" to.

```sh
# the file a user should import into AmneziaVPN
amnezia-panel key-config <key-id> --format=vpn --save --confirm
# -> Frankfurt Main laptop #3.vpn
```

**Two QR codes, two scanners.** The panel offers a different code depending on
what the user will point at the screen, because the two scanners do not read the
same thing:

- **A VPN app's own "scan QR" button** does not read a `vpn://` URL at all. It
  expects the app's own frame format — a base64url blob behind an 8-byte header
  with a magic number — and silently ignores anything else, however large and
  sharp it is. That is `--format=qr-frames`, and it is the format the panel now
  ships for that scanner. A series of more than one frame is shown in the panel
  in one of two modes, animated or static. This one format serves **both**
  clients: DefaultVPN is a fork of amnezia-client and reads a byte-identical
  envelope, so the panel shows the same code under two labels rather than
  building a second format.
- **An ordinary camera app** reads the QR as text, sees the `vpn://…` URL and
  hands it to the OS, which opens the app. That is `--format=qr` (PNG, for
  download) and `--format=qr-svg` (what the panel displays). A camera app cannot
  read `qr-frames` at all, so these stay fully supported, and the config dialog
  keeps the camera code one labelled click away.

**Reproducing a "the QR does not scan" report.** First establish *which* scanner
the person used, because the two failures have nothing in common.

```sh
# what a camera app sees
amnezia-panel key-config <key-id> --format=qr --out=/tmp/key.png --confirm
amnezia-panel key-config <key-id> --format=qr-svg --confirm > /tmp/key.svg

# what an in-app scanner sees (AmneziaVPN and DefaultVPN alike)
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
# admit a whole company domain, on top of the users the panel adds automatically
docker exec "$CID" node apps/cli/dist/main.js cf-domains --add=<domain>
# cf-sync --status shows whether the last push landed
docker exec "$CID" node apps/cli/dist/main.js cf-sync --status
```

Dev example: `CONTROL_API_URL=http://127.0.0.1:3001 PANEL_ADMIN_EMAIL=admin@example.com
node apps/cli/dist/main.js overview`. Typical flow to grant more keys:
`… quota` (copy the request id) → `… quota-approve <req-id>`.

#### Clearing out stale keys

Three commands, widest to narrowest. Nothing before the last one changes
anything, so the whole audit is safe to run on a live fleet.

```sh
# who is holding keys nobody uses, worst first
amnezia-panel stale-keys
# which keys, and why each one was matched (why=idle / why=never)
amnezia-panel keys --stale
# what a cleanup for one user would take - prints and stops
amnezia-panel stale-keys-revoke someone@company.tld
# do it
amnezia-panel stale-keys-revoke someone@company.tld --confirm
```

`--days=N` (`--stale-days=N` on `keys`) moves the 30-day window on all three; a
value that is not a positive integer is refused rather than quietly restored to
the default, since that would report a different set of keys than the one about
to be revoked.

Two things this deliberately does not do. It never **purges**: revoking removes
the peer from the node, and the row, its traffic history and the audit trail all
survive, so a user who turns out to still need the key can be issued a new one
(`docs/KEY-STATES.md` has the state model, and `key-purge` — irreversible, and
legal only for a key already `revoked` — is not reachable from any of this). And
it never counts a key that is simply **new**: a key issued this week has no
handshake for exactly the same reason an abandoned one does, so a never-used key
is only ever stale once the key itself is older than the window.

To keep one key out of a cleanup, revoke the rest individually with
`key-revoke <id>` (the ids are in `stale-keys-revoke`'s dry run and in
`keys --stale --json`), or use the panel's dialog, where every key can be
unticked before confirming.

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
# version: 1.4.0   commit: abc1234   awg3-client-floor: 5.0.1.5   repo: https://github.com/wyrtensi/amnezia-shared-panel
```

`repo` is the repository the running image was built from, stamped at build
time (`APP_REPO_URL`) by `.github/workflows/release.yml` and by
`scripts/deploy.sh`, which reads the checkout's own `origin`. It is what the
version in the admin sidebar and on the update card link to — the release tag
for a tagged build, the commit for anything else. Set `APP_REPO_URL` in the
stack's `.env` to point those links elsewhere; a build stamped by neither path
falls back to the upstream repository named in `apps/control-api/src/app.ts`.

`awg3-client-floor` is the client release the panel tells users an AWG 3.1 key
needs. It is the same constant the install guide interpolates, served from the
panel rather than copied into the CLI, so the two cannot disagree. A user on an
older client sees a key that imports and then fails to connect — check this
number first.

#### Global route overrides

### Background periods

Every period the panel runs a background loop on is an **admin setting**, not a
container-level one. They live as nullable columns on `portal_policy`, so they
are edited in **Administration → policy → Background periods**, or from here:

```bash
# what is set, what an unset period falls back to, and each one's range
amnezia-panel periods
amnezia-panel periods --json      # adds min/max/unit per period

# change one (seconds, except the retention window in days)
amnezia-panel policy-set --telemetryPollSec=120
# hand one back to the worker's default
amnezia-panel policy-set --ruleFetchIntervalSec=default
```

| Period | Default | Range | What it is |
| --- | --- | --- | --- |
| `telemetryPollSec` | 60 s | 30..86400 | The server-status poll: one health + server + load + client-list fan-out to **every** node, plus the service checks that are due. The requests are not the binding cost: an active key re-handshakes about every 2 min, so nearly every poll writes it a `peer_samples` row — the poll period **is** the growth rate of that table, and maintenance loads a whole retention window of it into the worker's heap. Hence the 30 s floor |
| `nodeMetricsSampleSec` | 300 s | 30..86400 | How often a poll keeps a `node_metrics_samples` row. Never below the poll period — only a poll can write a row, so a shorter setting keeps no extra history; the API refuses the pair and names both numbers |
| `nodeMetricsRetentionDays` | 7 days | 1..3650 | How long that history is kept. Nothing else prunes the table |
| `peerSampleSec` | 300 s | 60..86400 | Floor for a peer whose state has **not** moved (one that did is always recorded). One row per key, so the table grows with keys × fleet — hence a higher floor than the poll. Never below the poll period either, for the same reason as `nodeMetricsSampleSec`: only a poll writes the row |
| `maintenanceIntervalSec` | 3600 s | 3600..604800 | Traffic roll-ups plus pruning. Every run loads **every** `peer_samples` row in the raw retention window into the worker's heap at once and walks it twice; the container runs under a 160 MB `mem_limit`. The floor is the hour this loop always ran on, and it stays there until the roll-up aggregates in SQL |
| `agentReleaseRefreshSec` | 1800 s | 300..604800 | Re-resolves the node-agent release the panel offers. Each run is three ghcr.io requests — pull token, tag list, manifest HEAD — so 300 s is 36 registry calls an hour (the 60/hour limit is `api.github.com`'s, which this loop never calls) |
| `ruleFetchIntervalSec` | 21600 s | 900..604800 | Route-rule feed download. Each run pulls the external feeds in full; they publish daily at best |
| `accessReconcileSec` | 3600 s | 300..604800 | The Cloudflare Access reconcile timer. A panel-side user change already arms an immediate run, so a faster timer only adds API calls |

**Unset means "the worker's default", and that is the upgrade guarantee.** Every
column starts null, so a panel that is upgraded keeps exactly the periods it had.
Four of these still read an environment variable when nothing is set here —
`TELEMETRY_POLL_SEC`, `NODE_METRICS_SAMPLE_SEC`, `NODE_METRICS_RETENTION_DAYS`
and `ACCESS_RECONCILE_INTERVAL_MS` (still **milliseconds**, unlike everything
else) — and for those the worker's own environment is the default, so the
`default` column above is the *built-in* number and a host configured otherwise
uses its own. A value set in the panel wins over both. The other four periods
never had a variable and are panel-only.

**When a change takes effect, precisely.** No container restart, and not
instantly either: the worker asks for each period before every wait, so a loop
that is already waiting out the old period finishes that wait first. A change
therefore applies **from the next cycle — up to one OLD period away**, plus a
few seconds of the worker's settings cache. Lowering the poll from 6 h to 1 min
can take up to 6 h to show up; the fast way to test a change is to lower the
period, wait one cycle, and read `node-metrics` or the node cards.

**Bounds are enforced three times, on purpose.** The CLI refuses an
out-of-range number locally (so you are told which number, not which field), the
control API refuses the write, and the worker clamps whatever it reads — which
is what covers a row edited in SQL or restored from a panel with different
bounds. The table has a `CHECK` per column as well. The relation between periods
— both `nodeMetricsSampleSec` and `peerSampleSec` must be `>= telemetryPollSec`,
since only a poll writes either row — is refused on the write path with both
numbers in the message and additionally clamped by the worker, because the API
cannot see a `TELEMETRY_POLL_SEC` set in that worker's environment. Refusing the
write is what stops the panel *displaying* a sample period that is not the one
running; the clamp is what stops it *running* one.

Per-check periods are separate and always were: a service check has its own
`intervalSec` (`check-set --interval-sec=`, or the minutes field on the check's
row in the admin panel).

### Service checks

A check is a **probe** (what to do) and a list of **assertions** (what must be
true of the result); all of them must hold. Both sets are open — adding a rule
is one entry in the node-agent's registry, not a migration. `docs/SERVICE-CHECKS.md`
has the full list and the rules for deriving a new one.

Assertion flags, repeatable:

```
--status-in=200,204                        the status is one of these
--contains=<text>                          the body contains it
--omits=<text>                             the body does not
--contains-all=<a>,<b>                     the body contains every one
--contains-any=<a>,<b>                     the body contains at least one
--contains-at-least=<count>:<text>         it appears at least <count> times
--bytes-at-least=<n>                       at least <n> bytes were read (cap 64 KiB)
--final-url-contains=<text>                where the request landed contains it
--final-url-omits=<text>                   it does not
--header-contains=<name>:<text>            a response header contains it
```

```bash
# The seeded Gemini check, written out: a SUCCESS marker plus an independent
# failure marker. Measured across two captures - 20 occurrences on a working
# page, 0 on a blocked one - which is why it is a count rather than "contains".
amnezia-panel check-create --name="Google Gemini" \
  --url=https://gemini.google.com/ \
  --status-in=200 \
  --contains-at-least=10:conversation-container \
  --omits=account-rejected
```

A `HEAD` probe reads no body, so a body assertion against one is refused rather
than left to fail silently in the direction that reads as "blocked".

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
| `sh scripts/set-capacity.sh <peers> [--force]` | Change this node's `SERVER_MAX_PEERS` and put it into effect. Checks the preflight RAM gate for the **new** number first and refuses if the host cannot carry it; then recreates **only** `amnezia-node-agent` (`--no-deps`, after asserting the data plane is healthy), so AWG tunnels stay up, existing peers keep passing traffic and **no peer state is touched** — it lives in the AWG containers' bind mounts, not in the agent. Above 500 peers needs `--force` (unvalidated; 1000 is the hard bound of the /22 address pool). Rollback: run it again with the previous number — a failed health gate restores it automatically. |

> `set-capacity.sh` is the one supported exception to "always deploy through
> `scripts/deploy.sh`": `deploy.sh` stops the AWG containers for its pre-deploy
> backup, which drops every tunnel — far more than a one-line `.env` change
> needs. `set-capacity.sh` still runs `preflight.sh`, takes the same deploy
> lock, and gates on health. It requires `amnezia-awg3` to be healthy, and
> `amnezia-awg2` only on a node where `PROTOCOLS_ENABLED` includes it.

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
