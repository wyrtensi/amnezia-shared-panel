# Update mechanism — as built

The panel updates itself on demand from the Administration overview: a **Panel
update** card shows the running version and an **Обновить панель** button. The
button never touches Docker directly (control-api runs *inside* compose and
cannot restart the stack from within); instead a host-side systemd worker runs
`infra/prod/update.sh`.

## Flow

```
Admin clicks "Обновить панель"
  → POST /api/admin/update  (control-api, admin only)
      → writes {spool}/request.json           (atomic: temp + rename)
  → host: panel-updater.path notices request.json
      → starts panel-updater.service (oneshot)
          → panel-updater.sh:
              flock on /run/amnezia-panel (root-only, outside the spool)
              → open request.json once, verify via /proc it is a real spool file
                (refused → result.json says so, and nothing is read as root)
              → read request id → rm request.json
              → bash infra/prod/update.sh
                  (backup DB → down → drop old image → pull → migrate → up)
              → writes {spool}/result.json  {id, finishedAt, ok, message}
  → panel: GET /api/admin/update reflects pending → lastResult
```

The button is a **live view of the spool**, so it is reload-safe and survives the
brief restart while the panel updates itself: the card keeps polling, and once the
web/api come back it reads `result.json` and reports success/failure.

Data is never reset: Postgres data, the config-encryption keyring, and AWG peer
state live in named volumes / on the node, untouched by `pull` + `up -d`.
`update.sh` runs `scripts/backup-db.sh` first and aborts the update if the backup
fails.

## Pieces

| Piece | File | Role |
| --- | --- | --- |
| API | `apps/control-api/src/updateController.ts` | Write the request file, read status. `GET/POST /api/admin/update`. |
| UI | `apps/web/components/admin/panel-update-card.tsx` | Version + button + live status on the admin overview. |
| Spool mount | `infra/prod/compose.yaml` (control-api) | `UPDATE_SPOOL_DIR=/var/run/panel-update`, bind-mounted from `UPDATE_SPOOL_HOST_DIR`. |
| Host worker | `infra/prod/panel-updater.sh` | Runs `update.sh`, writes the result. Treats the spool as untrusted: the lock is held outside it (`PANEL_UPDATER_LOCK_DIR`, default `/run/amnezia-panel`), the request is read once through a descriptor verified via `/proc`, and the result is written via `mktemp` + rename. |
| Trigger | `infra/prod/panel-updater.path` + `.service` | systemd path unit → oneshot service. |
| Updater | `infra/prod/update.sh` | Backup → down → drop old image → pull → migrate → up (disk-safe for a tiny box). |
| Installer | `infra/prod/install-updater.sh` | One-time host install of the units + spool. |

## Install (one-time, on the server)

The feature is **inert until the host worker is installed** — the card shows
"механизм обновления не установлен" and the button is disabled. To enable it, from
the repo root on the server:

```bash
sudo bash infra/prod/install-updater.sh
```

That creates the spool dir owned by the container uid (1000), installs the
systemd `panel-updater.path` + `.service` pointed at this checkout, and enables
the watcher. Then, if you changed the default spool path, set
`UPDATE_SPOOL_HOST_DIR` in `infra/prod/.env` and recreate control-api:

```bash
docker compose -f infra/prod/compose.yaml up -d control-api
```

Diagnostics: `systemctl status panel-updater.path` and
`journalctl -u panel-updater.service -n 50`.

## Design choice: host systemd worker, not a docker.sock sidecar

An earlier draft proposed a sidecar container with `/var/run/docker.sock`. The
implemented design uses a host systemd path unit instead — control-api gets **no**
Docker access (smaller RCE surface), and the request file carries only a trigger
id, never shell input. On the tiny co-located box this is the simpler, safer
option.

## Not built (possible extensions)

- **Auto-update toggle** — the current button is on-demand only. An `auto_update`
  column on `portal_policy` plus a scheduled `panel-updater.timer` would add it.
- **"Update available" check** — the card shows the running version but does not
  compare it against the latest GHCR digest. Add a registry query to
  `updateController.status()` to surface availability.
- **Backup → R2** — `scripts/backup-db.sh` writes a local gzipped dump; pushing it
  to Cloudflare R2 (creds in `secrets/`) is not wired in.

## Node updates

The panel **does** push node-agent updates, over `POST /server/update`, from the
button on the node card or `amnezia-panel node-agent-update <id> --confirm`. The
swap itself runs on the host in a port of the updater above
(`infra/node/scripts/agent-update.sh`, driven by a `.path` unit watching a
spool directory), because the agent container has only the Docker socket and
could not durably replace itself. It is opt-in per host and needs node-agent
1.1.9 or newer — earlier builds answered `500` on both `/server/update` routes,
and the first hop to 1.1.9 has to be made over SSH. The full mechanism, the
wiring step and every failure mode are in
[`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md), "Updating a node's agent from
the panel".

Two things the node card does **not** tell you:

- **It does not show the running agent version.** `GET /server` reports no
  version, so the version on the card is the release the panel has available,
  not the one installed. What a node actually runs is only readable on that
  host, as the digest in its `NODE_AGENT_IMAGE`.
- **Nothing on a node auto-updates.** Watchtower and mutable `latest` tags are
  forbidden on nodes and fail `preflight.sh`, exactly as they are on the panel
  host. A watchtower seen on a node belongs to another install sharing that
  host, not to this stack.
