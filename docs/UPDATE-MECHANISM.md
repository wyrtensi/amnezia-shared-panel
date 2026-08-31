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
              flock → read request id → rm request.json
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
| Host worker | `infra/prod/panel-updater.sh` | Runs `update.sh`, writes the result. |
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

Node cards surface the node-agent version (`GET /server`). The node auto-updates
its own containers via the **watchtower** already running on it; the panel does
not push node updates (node-agent exposes no update endpoint, only
`/server/reboot`).
