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
                (built 0644 in the spool's parent, renamed in)
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
| Host worker | `infra/prod/panel-updater.sh` | Runs `update.sh`, writes the result. Treats the spool as untrusted: the lock is held outside it (`PANEL_UPDATER_LOCK_DIR`, default `/run/amnezia-panel`), the request is read once through a descriptor verified via `/proc`, and the result is built in the spool's parent (`PANEL_UPDATER_STAGING_DIR`, root-only, same filesystem), made `0644` so control-api (uid 1000) can read it, and renamed in. |
| Trigger | `infra/prod/panel-updater.path` + `.service` | systemd path unit → oneshot service. |
| Updater | `infra/prod/update.sh` | Backup → down → drop old image → pull → migrate → up (disk-safe for a tiny box). |
| Installer | `infra/prod/install-updater.sh` | One-time host install of the units + spool. |

## Install (one-time, on the server)

The feature is **inert until the host worker is installed** — the card shows
"механизм обновления не установлен" and the button is disabled. control-api
decides this by whether it can write to the spool: docker creates a missing
bind-mount source as root, so before the installer runs the spool exists but is
not writable by uid 1000. To enable it, from the repo root on the server:

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

## Updater units start through `/bin/bash` (and how to repair hosts installed earlier)

All three host updaters (`panel-updater.service`, `amnezia-node-agent-update.service`,
`amnezia-bridge-agent-update.service`) run `ExecStart=/bin/bash <absolute script>`.
An older unit that executed the script directly fails with `status=203/EXEC` as
soon as the checkout has the script at mode `0644` (git tracks it as `100644`); the
level-triggered `.path` unit then re-fires, ends in `unit-start-limit-hit`, and the
panel keeps showing the request as pending. The installers now check `/bin/bash`, a
readable script and `bash -n` before touching the host, and refuse to install when a
drop-in (`<unit>.service.d/*.conf`) or another unit file overrides `ExecStart`
(they name the unit, and ask systemd for the effective command after the reload).

Hosts installed before this change need the installed unit repaired. Do **not**
re-run the installer to do it (that would re-render template defaults); use
`scripts/repair-updater-units.sh`. It is self-contained, reads the units installed on
the host, and rewrites only the `ExecStart=` line, so custom checkout paths, spool,
lock directory and the approved image repository stay as they are. Re-running an
installer while a request is pending re-arms the watcher and fires that request, so
use the repair tool for repairs, not the installer.

### Per-host procedure

Run from the panel checkout, once per host (every panel host and every managed VPN
host, including co-located panel/node hosts such as Caminia; a co-located host has
both a panel and a node updater and the tool judges each one independently):

```bash
# 1. Inventory, changes nothing, no root needed
ssh root@<host> 'bash -s -- --dry-run' < scripts/repair-updater-units.sh
#    (--json for a machine-readable table)

# 2. Repair idle units
ssh root@<host> 'bash -s' < scripts/repair-updater-units.sh
```

Per unit the report records the effective `ExecStart`, enablement and state of the
watcher (`.path`), whether an operation is running, and whether a request is
pending (id, age, status). Outcomes:

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `repaired` / `would-repair` | Idle unit: `systemd-analyze verify`, install, `daemon-reload`, clear the failed state (`reset-failed` of service and watcher), watcher back to its previous enablement (enabled: started and `waiting`; disabled: stays disabled and stopped). No update is triggered. | Nothing; confirm in the second run. |
| `current` | Already `/bin/bash`, watcher healthy. A second run is always this. | Nothing. |
| `deferred-running` | An operation is running (service active or lock held). Nothing is changed. | Run the tool again when it has finished. |
| `deferred-pending` | A request is queued (or, for bridges, an interrupted run's journal exists), found either at inventory time or just before rearming (then the unit is already repaired and only the watcher is left untouched). The watcher stays exactly as it is, because rearming a level-triggered path unit would start that request. The report names the request id, age and status. | Decide explicitly. To resume: confirm the request is still wanted (age, status; a bridge `picked_up` or a journal means a run was interrupted), start the service once by hand (`systemctl start <unit>.service`) or let the watcher fire it, wait for the result, then run the tool again. To cancel: remove the request file from the spool (for a bridge also check the journal and results first) and run the tool again. The tool never deletes requests, results or journals. |
| `not-installed` | The opt-in updater was never set up on this host. Its disabled status is preserved. | Normal enablement step shown in the note (`install-updater.sh` / `install-agent-updater.sh` / `install-bridge.sh`). |
| `blocked` | An `ExecStart` override (drop-in under `/etc`, `/run`, `/usr/lib` `systemd/system/<unit>.service.d`, or systemd not reporting an effective command), more than one `ExecStart` line, a `-`/`@`/`+`/`!` prefix or a continued line, a script other than the expected `panel-updater.sh` / `agent-update.sh` / `bridge-agent-update.sh`, whitespace in the script path, a missing or unreadable script, a Bash syntax error, or a partial install. Nothing is changed. | Fix the cause named in the note, run again. |
| `failed` | `systemd-analyze verify` rejected the corrected unit (nothing changed), the reload or the effective command check failed, or the watcher did not come back to `waiting`. | Read the note and `journalctl -u <unit>`. |

Exit status: `0` nothing left to do, `2` at least one unit deferred, `3` at least
one blocked or failed, `1` usage.

An enabled watcher that is not active (also after a deferral that happened between
reset-failed and start) is started by the next run; a disabled one is never touched.
A watcher stuck in `unit-start-limit-hit` on an idle host is recovered by the same
run (reset-failed plus start). By hand: `systemctl reset-failed <unit>.service
<unit>.path && systemctl start <unit>.path`. Do that only when no request is
pending: a retained request starts immediately when the watcher is rearmed.

### Fleet outcome table (fill in per host)

| Host | Updater | Outcome (verified / intentionally disabled / deferred / unreachable) | Request id, age, status (if deferred) | Date, operator |
| --- | --- | --- | --- | --- |
| | panel / node-agent / bridge-agent | | | |

`verified` = a repair run reported `repaired` or `current` and a second `--dry-run`
reports `current`; `intentionally disabled` = `not-installed`, or an installed
updater whose watcher is deliberately disabled; `deferred` = running or pending,
revisit; `unreachable` = SSH failed, revisit. The fleet-wide application of this
procedure is an explicit operator step and is not part of a code change.

## Acknowledgement deadline (queued request nobody picked up)

`GET /api/admin/update` carries additive fields next to `enabled`, `version`, `pending` and `lastResult`:

| Field | Meaning |
|---|---|
| `acknowledgement` | `pending` (queued, inside the deadline), `acknowledged` (host started that request id, or its result is present), `unacknowledged` (queued past the deadline with no host start and no result for that id); `null` when nothing is queued or running |
| `requestAgeSeconds` | Age of the queued request (null if its `requestedAt` cannot be parsed, which reads as `unacknowledged`) |
| `acknowledgementDeadlineSeconds` | The deadline in force: `UPDATE_ACK_DEADLINE_SECONDS`, default 120 |
| `diagnosticHint` | `UPDATE_NOT_ACKNOWLEDGED` while unacknowledged (same code as the bridge-agent update view), else null |
| `running` | `{id, startedAt}` when the host started a request and no result for it exists yet (the request file is already consumed) |

`panel-updater.sh` writes `started.json` (`{id, startedAt}`, staged outside the spool and renamed in, id restricted to `[A-Za-z0-9-]`) after it takes the lock and before it consumes `request.json`. Records are matched by request id only, so a stale `started.json` or `result.json` never acknowledges a newer request. A host still running the previous script writes no marker: its request is then reported `unacknowledged` after the deadline even if it was taken, until the host checkout is updated; the result file still resolves it.

An unacknowledged request is a status, not an action: the request stays in the spool, `POST /api/admin/update` keeps answering `alreadyPending`, and nothing is re-queued. Next step shown in the card: `systemctl status panel-updater.path panel-updater.service` on the host, then `scripts/repair-updater-units.sh --dry-run` (see above); once the watcher is healthy it fires the queued request itself.

Node agents report the same vocabulary in `GET /server/update` (`acknowledgement`, `requestAgeSeconds`, `diagnosticHint`; deadline `NODE_AGENT_UPDATE_ACK_DEADLINE_SECONDS`, default 120). A node's `requested` state past the deadline reads `unacknowledged` while `state` stays `requested`; consuming the trigger is the start signal (`acknowledged`). The panel does not store or display these node fields yet. Bridge-agent updates use `pickup_timeout` / `acknowledgementOverdueSince` with `UPDATE_NOT_ACKNOWLEDGED` (see `docs/OPERATIONS.md`).

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
