# Update mechanism — design (deferred)

Parked while authorization (Cloudflare Access) is built first. This captures the
agreed design so we can pick it up later.

## Goal

Update the panel (and, where possible, the Amnezia server containers) safely:
- **Button** to update on demand (default), plus an **auto-update toggle**.
- **Data must never reset** on update (DB, config keyring, AWG peer state).
- **Backups** before every update (DB dump → local + Cloudflare R2).
- Runs in **any Docker environment**, multi-arch (amd64 + arm64).

## Agreed architecture

Single multi-arch image on **GHCR** + an **isolated updater** sidecar. The web
process NEVER runs Docker commands (that would be an RCE surface) — it only
writes a request file that the updater picks up.

1. **Release CI** (`.github/workflows/release.yml`): on a `v*` tag, build the app
   image for amd64+arm64 and push `ghcr.io/wyrtensi/amnezia-shared-panel:<ver>` + `:latest`.
   The image already runs web / control-api / worker via different `command`s
   (as `infra/dev` does), so it's one image, not three.

2. **Prod compose** (`infra/prod/compose.yaml`): pulls the GHCR image (tag via
   `PANEL_IMAGE_TAG`, default `latest`). Postgres data, the config-encryption
   keyring, and AWG state live in **named volumes** so `pull` + `up -d` never
   touches them. Includes the updater sidecar.

3. **Updater sidecar** (`infra/prod/updater/`): a tiny container with
   `/var/run/docker.sock`, the compose file, and a shared `panel-control` volume
   mounted. Loop:
   - watch `panel-control/update.request` (written by control-api on button press);
   - on request → `backup-db.sh` (→ R2) → `docker compose pull` → run migrations
     → `docker compose up -d` → write `panel-control/update.status`.
   - honor an `auto` schedule when auto-update is enabled.
   The request file carries only a trigger + optional target tag — never shell
   input — so there is no command injection path.

4. **Control-api + UI**:
   - `GET /api/admin/version` (exists: APP_VERSION / GIT_SHA build args).
   - `GET /api/admin/update` → current version + latest available (compare the
     running image digest against `ghcr.io/.../latest` via the registry API) + last
     updater status.
   - `POST /api/admin/update` → write the request file (admin only).
   - Auto-update toggle stored in `portal_policy` (new `auto_update` column).
   - Admin "Обновление" card: version, "доступно обновление", "Обновить" button,
     auto toggle.

5. **Node updates**: node cards show the node-agent version (from `GET /server`).
   The node itself auto-updates its containers via **watchtower** already running
   on it (per node constraints) — the panel surfaces the version but does not push
   node updates directly (node-agent has no update endpoint, only `/server/reboot`).

## Backups

`scripts/backup-db.sh` already does an atomic gzipped `pg_dump`. Extend the updater
to also push the dump to **Cloudflare R2** (S3-compatible; creds in
`secrets/cloudflare.md`). AWG peer state is in host volumes and is captured by the
node-agent `GET /server/backup`.

## Cannot be verified in dev

The real update cycle needs a **published GHCR image** and a **production deploy**;
the dev stack builds images locally. Build it, verify structurally (compose config,
script lint), then exercise the full cycle on the server.

## Blocking decision (when resumed)

Confirmed approach = custom isolated updater sidecar (above). Off-the-shelf
Watchtower alone is insufficient because it does not run DB migrations, which must
run with each image update to keep data consistent.
