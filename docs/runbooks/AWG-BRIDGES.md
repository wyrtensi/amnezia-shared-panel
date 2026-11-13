# Runbook: AWG 3.1 node bridges

An optional bridge is a public host that forwards UDP to one or more AWG 3.1
nodes: users import a config whose endpoint is the bridge, the AWG peer and exit
stay on the node. A node is either **Direct** or assigned to one bridge route;
assignments are managed in the panel (Policies -> Node routes, and the Bridges
tab) and through the same API from the CLI (`docs/CLI.md`, `bridge-*` commands).

Scope: only genuine AWG 3.1 artifacts follow a bridge. Native AWG 2 and an AWG3
service's 2.0 fallback stay Direct. AWG 3.1 configs need AmneziaVPN client
5.0.1.5 or newer.

Example values below use the documentation range (`203.0.113.10`, node
`198.51.100.20`). Never paste tokens, keys or QR payloads into tickets or logs.

Detail lives next to the scripts; this runbook is the order of operations and links
there instead of repeating it:

- bridge host, agent service, updater and its error codes: [`infra/bridge/README.md`](../../infra/bridge/README.md)
- node side (`install-frpc.sh`) exit codes: header of [`infra/node/scripts/install-frpc.sh`](../../infra/node/scripts/install-frpc.sh)
- every CLI command and API error code: [`docs/CLI.md`](../CLI.md)
- management tunnels (same pattern as node tunnels): [`docs/NODE-CONNECT.md`](../NODE-CONNECT.md)

Settings on the panel (`infra/prod/.env`, documented in `infra/prod/.env.example`):

| Variable | Meaning |
| --- | --- |
| `VPN_BRIDGE_JOBS_ENABLED` | Gate for **queuing** bridge jobs (agent polling, probe route checks, agent updates). Default `false`; a gated request fails with `BRIDGE_JOBS_DISABLED`. Registry, reservation, activation and exports are not jobs and are never gated, but bridge observations come only from the polling job: with the gate off the observations go stale, so **only Direct keeps working**; activation and release refuse with `BRIDGE_OBSERVATION_STALE`, and outstanding agent updates never reach a terminal state (the update tracker runs inside the poll job) |
| `VPN_BRIDGE_OBSERVATION_STALE_MS` | Age after which the last bridge-agent observation counts as stale (default 300000). Stale means Unknown: activation and release refuse |
| `VPN_BRIDGE_MANAGEMENT_HOSTS` | Hosts a bridge's management URL may name (default `host.docker.internal`) |
| `BRIDGE_AGENT_IMAGE_REPOSITORY` | Approved bridge-agent image repository; only its resolved digest is ever offered |
| `UPDATE_ACK_DEADLINE_SECONDS` | How long a queued panel or node update may stay unacknowledged before the panel reports the next step (see `docs/UPDATE-MECHANISM.md`) |

---

## 1. Mixed-version gate and deployment sequence

A pre-bridge worker claims **any** job type and can mark an unknown bridge job
complete. So the stack and the gate move in this order:

1. Back up the database with its encryption material (`scripts/backup-db.sh`) and
   verify the backup restores (`docs/OPERATIONS.md`).
2. Keep `VPN_BRIDGE_JOBS_ENABLED=false` (the default). Deploy the new panel
   stack as one set: API, worker and web from the same bridge-capable image.
   Migrations are additive.
3. Verify the new worker and that Direct paths work: `amnezia-panel nodes`, a
   key download, the reachability widget.
4. Bring the bridge-agent and, if you use it, the probe online. Check the probe
   reports the `bridge-measurement` capability before relying on its bridge
   results (a legacy probe leaves bridged paths Unknown; operator verification
   below still works).
5. Set `VPN_BRIDGE_JOBS_ENABLED=true` and recreate `control-api` and `worker`.
   From then on the worker polls enrolled bridges every minute.

Never run a pre-bridge worker with the gate on.

## 2. Add a bridge

1. Register it (metadata only, nothing is installed):
   `amnezia-panel bridge-add --name="Frankfurt" --ipv4=203.0.113.10 --confirm`
   (or the admin UI). It prints the host setup command and a `--dry-run` variant.
2. Place the trust material on the bridge host through an authenticated channel,
   directly into protected files, never as arguments: `/etc/amnezia-bridge/frp/token`
   (0600), `server.key` (0600), `server.crt` (0644, signed by the bridge CA, bridge
   IPv4 as a SAN). Table in `infra/bridge/README.md`.
3. Copy `infra/bridge/` to `/opt/amnezia-bridge/` and run the printed command,
   **dry run first**: `sh /opt/amnezia-bridge/install-bridge.sh --bridge-id <id> ... --dry-run`.
   It installs frps, the bridge-agent (digest-pinned image) and the update units,
   and prints firewall rules without applying them. Exit 60 = frps only, rerun with
   an image.
4. Apply the firewall: control TCP port only from the trusted node addresses, the
   UDP pool open to clients, TCP 7500 and 7600 closed to the internet. Confirm
   from outside that 7500 and 7600 do not answer.
5. On the **panel host** run `scripts/add-bridge-tunnel.sh --bridge-id <id> --bridge-host 203.0.113.10 --host-key-fingerprint SHA256:<printed by the installer>`
   (`--dry-run` first). It prints the enrollment command; run it. The key travels
   on stdin from the bridge host's token file.
6. `amnezia-panel bridges`: the bridge shows management `ok`, the agent version and
   frps version. `BRIDGE_IDENTITY_MISMATCH` / `BRIDGE_AGENT_UNREACHABLE` hints are in
   the table at the end.

## 3. Prepare a node route, validate forwarding, activate

1. Check eligibility (counts only): the node's AWG 3.1 key artifacts must render
   with the new endpoint; the UI shows the aggregate and blocks activation when
   some cannot.
2. Reserve a port: `amnezia-panel bridge-route-prepare <node-id> <bridge-id> --confirm`
   (optionally `--port=<udp>`). It prints the node-host commands.
3. Place the bridge token (0600) and bridge CA (`ca.crt`, 0644) on the node host as
   `/etc/amnezia-node/frp/token` and `ca.crt` through a trusted channel. Run the
   printed `install-frpc.sh ... --dry-run`, then the real command. The helper
   detects the local AWG publication; add `--local-ip` or `--local-udp-port` only
   when it asks. Existing nodes get the script by re-running `scripts/add-node.sh`.
4. Wait for the bridge-agent's next observation: `amnezia-panel bridges --json`
   shows the route `registration: online` with a registration marker.
5. Verify with real AWG traffic, one of:
   - Probe: `amnezia-panel bridge-route-verify <route-id> --confirm` (needs the gate
     on and a probe with `bridge-measurement`; result in `bridge-routes`).
   - Operator: `amnezia-panel bridge-route-test-config <route-id> --key=<your key id> --out=./test.vpn`,
     import it in an AmneziaVPN client, confirm a handshake and a page load, then
     `amnezia-panel bridge-route-verify <route-id> --operator-verified --registration=<marker> --confirm`.
6. Activate within 30 minutes of the verification, against a fresh observation:
   `amnezia-panel bridge-route-activate <route-id> --confirm`. A previous
   route becomes **retiring** and keeps forwarding; Direct is not a route and
   does not become retiring.
7. Users get the new endpoint on their next download or **Refresh config**; files
   already imported keep the endpoint they were exported with.

## 4. Switch back to Direct

`amnezia-panel bridge-route-direct <node-id> --confirm`. The next export is Direct
again. The route becomes retiring and keeps forwarding for configs already
imported. A node's endpoint revision changes on every switch; a stale revision is
`BRIDGE_REVISION_CONFLICT`: read again and retry.

## 5. Retire a route and a bridge

1. Leave the retiring route in place until users have moved to refreshed configs
   (the migration window is the operator's decision; the panel does not guess).
2. On the node host remove only that route's unit:
   `sh /opt/amnezia-panel-node/scripts/install-frpc.sh --remove --route-id <route-id>`
   (the printed `remove` command).
3. Release the port after the bridge-agent no longer reports that route's
   registration: `amnezia-panel bridge-route-release <route-id> --confirm`
   (`BRIDGE_OBSERVATION_STALE` while the bridge state is unknown keeps it; a
   canceled draft is released the same way).
4. Lost bridge host (cannot be reached, no observation will ever arrive): stand up
   any host with bridge-agent and frps using the **same `BRIDGE_ID`**, enroll it,
   and let one poll observe the routes absent; then release them. A future audited
   abandon / forced-release action is a follow-up and is not implemented.
5. A bridge is deleted only when it holds no draft, active or retiring route:
   `amnezia-panel bridge-delete <bridge-id> --confirm`. Removing a node needs its
   routes released first.

## 6. bridge-agent update and rollback

Independent of the panel and frps; only the agent container is replaced.

- `amnezia-panel bridge-agent-update <bridge-id>` shows installed and offered digest;
  `--confirm` requests it (needs the gate on and `update.v1` on the agent; an older
  agent is updated once by hand: rerun `install-bridge.sh` with the new digest).
- `amnezia-panel bridge-agent-log <bridge-id>` follows it: `queued -> sent -> acknowledged -> running -> succeeded`,
  or `rolled_back` (previous agent restored and verified), `rollback_failed` (needs
  attention), `failed`. Contact may be lost while the agent restarts; that is
  an observation, the operation keeps its slot until the agent confirms its fate.
- The host updater, health gate, pin file and codes are in `infra/bridge/README.md`.
  frps and UDP forwards are never restarted.
- After a `rollback_failed`: on the host read `journalctl -u amnezia-bridge-agent-update.service`,
  reinstall the image from `image.pin` with `install-bridge.sh`.

## 7. Rollback preflight and panel rollback

Reverting to a release without bridge support is safe only when nothing depends
on bridge-aware code. The migrated database stays (migrations are additive; bridge
rows, retired reservations and host forwarding remain for already-imported configs).

1. Run the preflight (read-only, admin):
   `amnezia-panel bridge-rollback-preflight` (`--json`; API
   `GET /api/admin/vpn-bridges/rollback-preflight`). It lists nodes with an active
   bridge assignment, outstanding bridge-agent updates, bridge jobs still pending
   or processing in the outbox, the gate state, `readyForPreBridgeRollback` and
   `blockingReasons`.
2. **Drain with the gate still ON.** Follow outstanding bridge-agent updates in
   `bridge-agent-log` until terminal: the update tracker runs inside the poll job,
   so they never finish once the gate is off. Queue no new update.
3. Set `VPN_BRIDGE_JOBS_ENABLED=false` and recreate `control-api` **and** `worker`:
   each process reads its own copy of the variable, and the preflight reports only
   the control-api's. Jobs are the candidate probe check, the bridge-agent poll and
   the bridge-agent update. With the gate off only Direct works: observations go
   stale, so activation and release refuse. No new bridge job is queued; wait for
   pending jobs to drain.
4. Put every listed node back to Direct (`bridge-route-direct`) **while the
   bridge-aware panel is still running**. Keep the retiring routes and the frpc/frps
   mappings: configs users already imported depend on them.
5. Run the preflight again until it says `ready ... yes` (`blockingReasons` empty). Ready needs the gate off, no active assignment, no outstanding update and no pending or processing bridge job; failed jobs do not block.
6. Take a database backup, then set `PANEL_IMAGE` in `infra/prod/.env` to the
   verified pinned pre-bridge image (by digest) and recreate the stack; the old
   migrator ignores the newer migrations it does not know.
7. To return to the bridge build, set the candidate image back; the saved bridge
   state is still in the database. Re-enable the gate last (section 1, step 5).

A recovery build that must keep active assignments needs the bridge-aware exporter
and worker; never run the pre-bridge application with an active assignment.

## 8. Failure messages

| Where | Message | Meaning and next step |
| --- | --- | --- |
| API | `BRIDGE_POOL_EXHAUSTED` | No free UDP port in the bridge range; release a route or use another bridge |
| API | `BRIDGE_PORT_TAKEN`, `BRIDGE_PORT_OUT_OF_RANGE` | Chosen port is held or outside the range |
| `install-frpc.sh` 30-34 | missing, ambiguous, IPv6-only or mismatched local AWG publication, or AWG not healthy | Fix the node's AWG container publication; use `--local-ip` / `--local-udp-port` as the message says |
| `install-frpc.sh` 40 | control TCP unreachable | Bridge firewall or control port; the node address must be allowed |
| `install-frpc.sh` 41 | frp authentication or TLS verification failed | Token or CA mismatch, or the bridge IP is not a SAN |
| `install-frpc.sh` 42 | frps refused the UDP registration | Port outside the pool or already registered |
| `bridges` management `stale` / `down` | no fresh observation | Check the tunnel unit `panel-tunnel-bridge-<id>`, the agent container and the gate; activation and release refuse meanwhile |
| API | `BRIDGE_ROUTE_UNVERIFIED` | No success within 30 minutes bound to the current registration; verify again |
| API | `BRIDGE_REVISION_CONFLICT` | Someone changed the node's endpoint; read and retry |
| API | `BRIDGE_UNSUPPORTED_CAPABILITY` | Probe lacks `bridge-measurement` (use operator verification), or the agent lacks `status.v1` / `update.v1` |
| API | `BRIDGE_JOBS_DISABLED` | The gate is off; intended during deployment and rollback |
| Probe result | `AWG_HANDSHAKE_FAILED` or no AWG handshake | The failing hop is unknown from the panel: a failed path check. Check registration, firewall UDP pool, node AWG listener; the active assignment never changes without activation |

Remaining codes and hints print with the CLI error; the full list is in
`docs/CLI.md`.

## 9. Lab acceptance checklist (not run in CI, not automatable here)

Run once on real hosts before the first production bridge and record dates and
build identifiers next to each box. The agent update and rollback items are in
`infra/bridge/README.md` ("Lab verification"); do those too.

- [ ] Two bridges, two nodes: enroll both, prepare routes, verify and activate; the
      bridge list shows ports held and remaining capacity.
- [ ] Two nodes on one bridge on separate ports carrying traffic at once.
- [ ] Stop one frpc: only that route's registration changes; the other keeps
      passing traffic. Start it again: registration returns without frps restart.
- [ ] Stop the management tunnel: the bridge turns stale, forwarding and active
      clients keep working, exports keep using the stored active route.
- [ ] Bridge-agent replacement (update and a bad candidate) with real AWG traffic
      on two routes: frps `MainPID` and both registration markers unchanged.
- [ ] Latency, loss and throughput through the bridge versus Direct, recorded.
- [ ] AWG 3.1 client import and handshake with AmneziaVPN 5.0.1.5 and a current
      build on Windows, macOS, Linux, Android and iOS: original and refreshed
      files through Direct -> Bridge -> Direct; full tunnel and the file-only
      `ru_blacklist` profile; AWG 2 export unchanged.
- [ ] Retiring route: a file imported before activation still connects until the
      frpc unit is removed and the port released.
- [ ] Rollback rehearsal (section 7) on a disposable copy of the database with the
      pinned pre-bridge and candidate images: old panel and CLI against the
      migrated database, then update again and confirm saved bridge state.
