# Updating the panel from git (and restarting the stack)

This is the operator runbook for **updating the control plane** — pulling new
code from git, rebuilding the image, applying database migrations, and recreating
the Docker containers. It covers what "deploy an update" means for this repo, a
safe mechanism to run it, how to check the running version, roll back, and how the
**VPN node** is updated on a separate track.

> The straightforward-path rule applies: if an update cannot complete as written
> (a migration fails, a build breaks), **stop and report** rather than forcing
> containers up against a half-migrated database.

## What "update" means here

The control plane is the **`infra/dev` Compose stack** (`infra/dev/compose.yaml`):
`postgres`, a one-shot `migrate`, and three long-running services —
`control-api`, `worker`, `web` — all built into **one shared image**
(`amnezia-panel/app:dev`, from `infra/dev/Dockerfile`, build context = repo root).
It is a pnpm monorepo, so a code change anywhere in `apps/*` or `packages/*`
lands in that single image.

Updating the stack is therefore four steps, in order:

1. **`git pull`** the checkout on the control-plane host.
2. **Rebuild** the shared image (`docker compose build`).
3. **Apply migrations** (`packages/db` — the `migrate` service runs them).
4. **Recreate** the app containers so they run the new image
   (`docker compose up -d`).

Step 3 is not separate work you run by hand: `migrate` is a one-shot service that
`control-api`/`web` wait on (`depends_on … service_completed_successfully`), so a
single `up -d` runs migrations to completion **first**, then recreates the app
services. Postgres keeps its named volume (`postgres-data`) across the whole
thing, so state survives.

## The recommended mechanism: an operator-run command

Run the update from a shell on the control-plane host (interactively, or from
cron / a systemd timer / your CI runner's deploy step). The whole thing is four
commands from `infra/dev`:

```sh
cd /opt/amnezia-panel/infra/dev          # the checkout on the control-plane host

git -C ../.. fetch --tags                # get new commits/tags
git -C ../.. pull --ff-only              # fast-forward only; never a surprise merge

docker compose --env-file .env build     # rebuild amnezia-panel/app:dev from new code
docker compose --env-file .env up -d     # migrate runs, then control-api/worker/web recreate
```

`up -d` recreates only the containers whose image or config changed, so after a
`build` the three app services restart onto the new image while `postgres` stays
up. Match the `--env-file .env` invocation the rest of the repo uses (see
[`AGENT-HOST-SETUP.md` Part C](./AGENT-HOST-SETUP.md)).

### Optional convenience wrapper

If you want one command, add a small **operator-owned** script and call it — it is
just the sequence above with a guard rail or two. Create
`scripts/deploy.sh` in the repo (operator convenience; nothing in the app calls
it):

```sh
#!/usr/bin/env sh
# Update the control-plane stack from git. Run on the control-plane host only.
set -eu
cd "$(dirname "$0")/.."                   # repo root

echo "Current: $(git rev-parse --short HEAD)"
git fetch --tags
git pull --ff-only
echo "Now at:  $(git rev-parse --short HEAD)"

cd infra/dev
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Then `chmod +x scripts/deploy.sh` and run `sh scripts/deploy.sh`. You may also
expose it as a root `package.json` script (`"deploy": "sh scripts/deploy.sh"` →
`pnpm run deploy`) if you prefer the pnpm entry point — but keep the logic in the
shell script, not in application code (see the next section for why).

`set -e` makes the script **fail closed**: if `git pull` or the image build fails,
it stops before touching running containers; if a migration fails, `up -d` exits
non-zero and leaves the previous app containers in place.

## Why this is a CLI/cron action and NOT a web button

**Do not add a "Update / Deploy" button to the panel UI that runs these commands.**
`git pull` + `docker compose build/up` are **host shell commands**. Wiring them to
an HTTP handler means the web/control-api process can execute arbitrary host
operations — and to recreate containers it would need the **Docker socket**, which
[`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) already flags as **host-level
compromise**. A single injection, a bug in an admin route, or a stolen session
would then become **remote code execution and container escape** on the
control-plane host. The deploy path must stay **outside the request path**:

- **Keep it operator-driven** — an SSH shell, a cron job, a systemd timer, or your
  CI runner's deploy step. The credential to deploy is "can log into the host,"
  not "has an admin session in the panel."
- **If you ever want a UI/remote trigger**, it must go through a **separate,
  locked-down** deployer — a CI pipeline (e.g. a self-hosted GitHub Actions
  runner) or a tiny signed-webhook service that runs the script — with its **own**
  authentication, authorization, and audit trail, and **no** coupling to the panel
  process. The panel may at most *link* to that system; it must never *be* it.

This mirrors the node-side rule against privileged automation
([`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md): "Never … touch an update
automation"; Watchtower/`latest` are refused there for the same reason).

## Check the running version

```sh
git -C /opt/amnezia-panel rev-parse --short HEAD   # commit the checkout is on
git -C /opt/amnezia-panel log -1 --oneline         # + subject line
git -C /opt/amnezia-panel describe --tags --always # nearest release tag
docker compose -f infra/dev/compose.yaml --env-file infra/dev/.env ps  # services up
```

Tag releases (`git tag -a v0.2.0 -m …`) so "what is in production" is a name, not
a bare SHA — it also makes rollback (below) a checkout of a known-good tag.

## Before you update: confirm the host has not skipped a migration

Drizzle applies a journal entry from `packages/db/migrations/meta/_journal.json`
only when its recorded timestamp is **newer** than the newest one already in
`drizzle.__drizzle_migrations` on that database — never by file name or
content hash. If a journal entry was ever committed with a timestamp **older**
than one already applied (an out-of-order edit to the journal), a host that
never ran that entry keeps skipping it on every future update, silently, even
while a later migration's generated snapshot already assumes its columns
exist — at which point regenerating a migration can no longer re-add what was
skipped, because the generator no longer sees it as missing.

Check before updating to a release with new migrations:

```sql
select count(*) from drizzle.__drizzle_migrations;
```

and compare the count against the number of entries in
`packages/db/migrations/meta/_journal.json` for the commit you are deploying —
or check directly for a column a specific migration adds. For example,
migration `0027` adds `nodes.capacity_state`:

```sql
select column_name from information_schema.columns
  where table_name = 'nodes' and column_name = 'capacity_state';
```

If a migration the count implies should be applied is missing, do not deploy
past it yet: apply that migration's SQL by hand first (from
`packages/db/migrations/`), confirm the column now exists, and only then
continue with the steps below.

## After v0.9.21: re-issue every `ru_whitelist` key

v0.9.21 inverted the `ru_whitelist` profile. Before it, the profile put its
feed's CIDRs straight into `AllowedIPs`, which tunnelled the Russian services on
that list and sent everything else in the clear — the exact inverse of what the
panel promises. Configs are built at download time, so every export **after**
this release is correct.

Every config exported **before** it is still wrong, sitting in a user's client,
and the panel will not say so. `rulesOutdated` is computed as "the active rule
set for this profile is a different version than the one this key was exported
from": it watches the feed's version, not the logic that turns the feed into
routes. The inversion moved no feed version, so a `ru_whitelist` key issued
before v0.9.21 reads as current and will keep reading as current until the
RoscomVPN list happens to change on one of its six-hourly refreshes.

`ru_blacklist` was luckier — that profile's default source changed from Re:filter
`ipsum.lst` to iplist in the same release, which did move the version, so those
keys flagged themselves.

So after deploying v0.9.21 or later onto a host that ran anything older:

1. list the keys on that profile — the panel has no filter for it, so
   `amnezia-panel keys --json` and select on `routeProfile == "ru_whitelist"`;
2. either ask each owner to download their config again (a fresh download alone
   fixes it — the key material does not have to change), or rotate the keys
   (`POST /api/keys/:id/rotate`, admin can rotate any key), which forces a new
   config and invalidates the old one.

Rotation is the safer of the two if it matters that the old, inside-out config
stops working: a re-download leaves the previously imported config valid on
whatever device still holds it.

## Zero-downtime caveats

There are **no strong zero-downtime guarantees** on this single-host Compose
stack:

- `up -d` **recreates** `control-api`, `worker`, and `web` — a **brief restart
  gap** (seconds) while each new container boots and its healthcheck passes. There
  is no blue-green or rolling second replica.
- Migrations run **before** the new app starts, but old app containers may still
  be serving for a moment during recreate. Prefer **backward-compatible
  (additive) migrations** so an old container and a new schema can briefly
  coexist; avoid destructive column drops/renames in the same release that needs
  overlap.
- **The VPN data plane is unaffected.** The panel is a control plane; restarting
  it does **not** drop anyone's VPN — active keys keep working on the node, which
  is a separate deployment. Provisioning of *new* keys pauses only for the seconds
  the `worker`/`control-api` are recreating.

For a clean update, pick a low-traffic window; the restart is short but not
invisible.

## Rollback

Roll the **code** back to a known-good commit/tag and rebuild:

```sh
cd /opt/amnezia-panel
git checkout <previous-tag-or-sha>        # e.g. v0.1.0
cd infra/dev
docker compose --env-file .env build
docker compose --env-file .env up -d
```

Caveat — **migrations are forward-only.** Checking out older code does **not**
un-apply a migration. A rollback is safe only to a commit whose schema the current
database still satisfies:

- Additive migrations (new nullable column/table) → old code ignores them → safe
  to roll back.
- A migration that **dropped or renamed** something the old code needs → rolling
  the code back will break against the migrated DB. In that case restore from a
  postgres backup taken before the update, or roll **forward** with a fix instead.

So: back up postgres before a release that includes a destructive migration, and
keep releases tagged so you always have a named target.

## Updating the VPN node (separate track)

**A control-plane `git pull` does not update the VPN node.** The node
(`<NODE_HOST>`) is an independent deployment (`infra/node`) with **immutable,
digest-pinned** images and its own lifecycle — mutable `latest` tags and
Watchtower are explicitly forbidden and fail preflight. Update it only via its own
scripts, and never as a side effect of a panel update:

- Rebuild the node-agent with `sh scripts/build-node-agent.sh`, pin the new
  `NODE_AGENT_IMAGE=sha256:…`, then `sh scripts/deploy.sh` (re-runs preflight,
  digest-verifies the AWG images, health-gates each container). Full steps:
  [`AGENT-HOST-SETUP.md` Part A](./AGENT-HOST-SETUP.md).
- **Never stop `amnezia-awg2`/`amnezia-awg3` on a live node** and never touch
  another tenant's containers — the hard safety rules in
  [`AGENT-HOST-SETUP.md` Part D](./AGENT-HOST-SETUP.md) apply to every node
  update.

Keep the two clocks separate: the panel (control plane) and each node (data
plane) are versioned and deployed independently.

## Direction: an `amnezia-panel` CLI update/version command

This runbook pairs with a future admin-CLI surface. The `apps/cli` tool already
ships as `amnezia-panel` ([`apps/cli/README.md`](../apps/cli/README.md)); the
natural additions are:

- **`amnezia-panel version`** — print the running build (git SHA / tag) and, from
  the API, the control-api and DB migration versions, so "what is deployed" is one
  command instead of the `git`/`docker` incantations above.
- **`amnezia-panel update`** — a thin wrapper over the **same** operator-side
  `git pull` + `docker compose build && up -d` flow (run on the host, outside the
  request path), so the mechanism has one blessed entry point.

This is a **direction, not a shipped feature** — today, update is the operator
command / `scripts/deploy.sh` above.

## Backups and data persistence (data is never reset)

Updating **never** wipes data: all state lives in **named volumes and host
files**, not in the images. `docker compose pull|build && up -d` recreates
containers but leaves volumes intact.

- **Panel database** → the `postgres-data` volume. Additive, forward-only
  migrations only add/alter, never drop your data.
- **Secrets & the encryption keyring** → host `.env` / `secrets/` (not in the
  image). The keyring **must stay identical across versions** — changing it makes
  encrypted secrets (node API keys, the Cloudflare token) unreadable.
- **VPN node / AWG server keys + peers** → the node's `./state/amnezia-awg2|3`
  volumes. Updating the AWG image keeps the same state → same server keys, peers
  reconnect; only a brief interface blip for that node's clients.

**Scripts** (operator/updater-run):

```bash
scripts/backup-db.sh [dir]          # gzipped pg_dump into ./backups (git-ignored)
scripts/restore-db.sh <dump.sql.gz> # restore a dump
scripts/deploy.sh [--build]         # backup → pull/build → migrate → up (safe)
```

`scripts/deploy.sh` **backs up the DB before every update** and refuses any
destructive flag (`down`, `-v`, `--volumes`, `prune`). For the VPN node, snapshot
its server state via the node-agent's `GET /server/backup` (import with the
matching endpoint) plus the `infra/node/scripts/backup.sh` / `rollback.sh`.

Hard invariants the updater keeps: **never** `docker compose down -v` /
`--volumes` / `volume prune` / `system prune -a`; keyring stable; AWG containers
untouched by a control-plane update.

## Planned: in-panel "Update" button + auto toggle

The panel already exposes its build version (`GET /api/admin/version`, shown in
the admin sidebar). The planned flow keeps the app process out of the deploy:
a **button** records an update request, and a **separate privileged updater**
(a small sidecar with the Docker socket, or host cron/systemd) runs
`scripts/deploy.sh` — pulling **multi-arch images published to a registry** so it
runs on any Docker host/arch. An **auto-update toggle** (off by default) lets the
updater apply on a schedule. This is the safe realization of a one-click update;
it is an infra step to wire per environment, not shipped yet.

## Related documents

- [`docs/OPERATIONS.md`](./OPERATIONS.md) — day-2 operations: proving a node
  change will not reset users' keys, moving the data plane to a new engine
  build, disk and swap on a live host, and the panel → node tunnels.
- [`docs/AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — node + control-plane
  install; node-agent build/deploy and the node safety rules.
- [`docs/HOSTING.md`](./HOSTING.md) — production topology and the public edge.
- [`apps/cli/README.md`](../apps/cli/README.md) — the `amnezia-panel` admin CLI.
