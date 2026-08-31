# AWG2 + AWG3 node operator checklists

## Preflight

- [ ] Confirm the host is Linux/amd64 and `/dev/net/tun` exists.
- [ ] Confirm inbound UDP 51889 (AWG2) and UDP 51890 (AWG3) are approved in the provider and host firewalls.
- [ ] Confirm TCP 4001 is not open in any public firewall.
- [ ] Set `.env` mode to `0600` and every directory under `secrets/`, `state/`, and `backups/` to `0700`.
- [ ] Generate a distinct single-line node-agent API key of at least 32 bytes in `secrets/node-agent-api-key`; set owner `root:root` and mode `0640` so the non-root service in group `0` can read the file-backed Compose secret.
- [ ] Build or load the reviewed node-agent and set `NODE_AGENT_IMAGE` to an immutable `sha256:...` image ID or `repository@sha256:digest`.
- [ ] Record the real public VPN host, a unique UUID, region, and Docker socket GID in `.env`.
- [ ] Run `sh scripts/preflight.sh` and retain its non-secret output with the change record.

## Backup

- [ ] Announce the brief VPN interruption required for a consistent filesystem snapshot.
- [ ] Run `sh scripts/backup.sh`.
- [ ] Verify the new `.tar.gz` and `.sha256` files are mode `0600` without opening or printing their contents.
- [ ] Copy the archive to approved encrypted backup storage and apply its retention policy.
- [ ] Confirm both containers returned to `healthy` with `docker compose --env-file .env ps`.

## Deploy

- [ ] Complete the preflight and backup checklists.
- [ ] Run `sh scripts/deploy.sh`; do not run raw `docker compose up` for production changes.
- [ ] Confirm `amnezia-awg2`, `amnezia-awg3`, and `amnezia-node-agent` are `healthy`.
- [ ] Confirm `docker port amnezia-node-agent 4001/tcp` returns only `127.0.0.1:4001`.
- [ ] Confirm UDP 51889 (AWG2) and UDP 51890 (AWG3) are reachable from an external test host without exposing TCP 4001.
- [ ] Confirm `GET /server` reports both `amneziawg2` and `amneziawg3` in `protocols`.
- [ ] Create two separate device keys and pass the official AmneziaVPN 5.x handshake/traffic acceptance gate before assigning production users.
- [ ] Run the 500-peer load gate before treating 500 as validated operating capacity.

## Rollback

- [ ] Select the exact known-good backup and verify its adjacent SHA-256 sidecar with `sha256sum -c <archive>.sha256`.
- [ ] Run `sh scripts/rollback.sh /absolute/path/to/amnezia-node-YYYYMMDDTHHMMSSZ.tar.gz`.
- [ ] Confirm the script reports both health gates passed and loopback-only binding remains intact.
- [ ] Re-test one known client handshake and traffic flow.
- [ ] Preserve the automatically created pre-rollback safety backup until the incident is closed.
