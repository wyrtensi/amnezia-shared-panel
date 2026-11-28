# Runbook: AWG 3.1 node bridges

An optional bridge is a public host that forwards UDP to one or more AWG 3.1
nodes. Users import a config with the bridge endpoint while the AWG peer and
exit stay on the node. In **Nodes and bridges**, both sections are visible on
the same page (with optional per-bridge `panelDnsHostname` / `panelDns`
resolution checks verifying whether a dedicated panel DNS host resolves to the
bridge's IPv4) and route links take you to the corresponding cards. Manage
assignments and the server list under **Policies → Node routes** (nested under
**Server order**) or through the `bridge-*` and `user-bridge` commands in
[the CLI](../CLI.md).

Scope: only genuine AWG 3.1 artifacts follow a bridge. Native AWG 2 and an AWG3
service's 2.0 fallback stay Direct. AWG 3.1 configs need AmneziaVPN client
5.0.1.5 or newer.

**Bridge routing for exported configs**

- **Global & per-user policy (`useBridge`):** defaults to **`false`** globally
  so activating a route on a node does not silently move direct users onto a
  bridge. Enable it globally in **Policies → Node routes**
  (`amnezia-panel policy-set --useBridge=true`) or per user on the **Users**
  page (`amnezia-panel user-bridge <id|email> <true|false|inherit>`).
- **Per-address routing:** administrators can set each registered VPN IP to
  **Follow policy**, **Direct**, or **Via bridge** in **Policies → Node routes**.
  **Via bridge** uses the node's active route and falls back to Direct when no
  route is active. A key without an explicit address follows the primary
  address setting. The bridge itself is configured once on the node.
- **Admin-only per-key routing:** when an administrator creates an AWG 3.1 key
  (`user-create-key --bridge=inherit|direct|route [--bridge-route=<uuid>]` or
  the admin UI), the key can inherit the address and policy settings, stay forced
  **Direct**, or be pinned to a specific active or retiring bridge route on that
  node. Admin key tables and `amnezia-panel keys` show the effective bridge
  routing per key. Releasing a retiring route automatically resets any keys
  pinned to that route back to `inherit`.

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
   Allow each node's **outgoing** address, which is not always its public VPN
   address: a host with several IPv4 addresses may leave from its primary one.
   On each node, `ip -4 route get <bridge-ip>` shows the `src` it uses (compare
   with `curl -4 https://api.ipify.org`). `install-frpc.sh --check-tls` fails
   with `E_TLS_CHECK` when the control port is filtered for that address.
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
3. On an already provisioned node, copy `infra/node/scripts/install-frpc.sh`
   from the panel's source revision to `/opt/amnezia-panel-node/scripts/install-frpc.sh`.
   Place the bridge token (0600) and bridge CA (`ca.crt`, 0644) in
   `/etc/amnezia-node/frp/<bridge-id>/` through a trusted channel. Run the printed
   `install-frpc.sh ... --dry-run`, then the real command. The helper detects
   the local AWG publication; add `--local-ip` or `--local-udp-port` only when it asks.
   To check the certificate on a fresh connection without changing the route,
   run the printed `checkTls` command. It checks the bridge CA and IP SAN and
   prints the expiry of the certificate served by frps.
   For monitoring and opt-in rotation across all routes on a bridge, follow
   the [certificate rotation setup](../../infra/bridge/README.md#certificate-monitoring-and-automatic-rotation).
   Existing FRP services keep their original credential paths. Keep the legacy
   files in place while those services use them.
   **A node the bridge cannot reach** (its address is filtered on the bridge's
   network, so even `--check-tls` and SSH between them time out) can carry the
   frpc control connection through another host that reaches both, with
   `--control-via <ipv4>:<tcp>`. TLS still verifies the bridge certificate for
   the bridge IP and the token still authenticates, so the relay sees only TLS;
   all of the route's traffic then flows through the relay host.
   - On the node, create a key for the relay (`ssh-keygen -t ed25519 -N ''
     -f /etc/amnezia-node/frp-relay/id_ed25519`, directory 0700) and pin the
     relay's host key in `/etc/amnezia-node/frp-relay/known_hosts`.
   - On the relay host, authorize that key for forwarding to the bridge only:
     `restrict,port-forwarding,permitopen="<bridge-ip>:<control-port>",command="/bin/false" ssh-ed25519 ...`
     (`restrict` alone still runs commands; the forced command closes the shell).
     The bridge firewall must allow the relay's outgoing address on the control port.
   - On the node, run the local forward as a unit (`amnezia-frpc-relay.service`,
     `Restart=always`): `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30
     -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/amnezia-node/frp-relay/known_hosts
     -i /etc/amnezia-node/frp-relay/id_ed25519 -L 127.0.0.1:17000:<bridge-ip>:<control-port> root@<relay>`.
   - Append `--control-via 127.0.0.1:17000` to the printed `checkTls`, dry run
     and install commands.
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
   In the panel, if you already verified a handshake and a page load through this
   registration, select the confirmation and activate in one step. The test
   download and remote probe are optional tools in the route editor.
7. For keys that follow routing settings, the address mode takes precedence
   over the user's effective `useBridge` policy. The next download or
   **Refresh config** reflects the new route. Users must import that config to
   apply the change on their devices.
   In **Users** (admin only) a key's bridge badge tells the two apart: solid
   when its device connects through a bridge now (the node sees it coming from
   its own frpc, an internal address), dashed "waiting for config" when the
   next download would use the bridge but the device still runs its older
   direct config or has not connected. The filters "Through a bridge" and
   "Waiting for a bridge config" list those users. Regular users never see
   bridge information; only the downloaded config carries the bridge address.

### WyTunnel transport (optional FRP replacement, 10-tunnel pool)

In addition to `frp_tcp` (`frps` / `frpc` over TLS/TCP), bridges and routes optionally support **`wytunnel`** ([`wyrtensi/wytunnel`](https://github.com/wyrtensi/wytunnel)) — a Rust FakeTCP transport combining `oexi/phantun` (eBPF `clsact` + GSO/GRO + optional SIMD FEC), `sagan/phantun` (random ISN, optional handshake mimicry, `--fwmark`), `b1gbr0/phantun` (session recovery + eBPF-aware keepalive), and `mYmNeo/phantun` (ephemeral UDP server sockets without `SO_REUSEPORT`).

- **Persistent 10-tunnel pool (`--pool-size 10`, default):** maintains `10` pre-warmed FakeTCP streams per routed node with staggered startup jitter (`150–300 ms`), sticky client session hashing over a 6-byte binary header (`+6 B` vs `+33%` JSON+base64 in FRP), instant `0 ms` failover if a stream drops, and seamless background rotation (`--pool-rotate-interval 2700`, `--pool-rotate-drain 5`) so individual flows do not stay open forever and users feel zero interruption.
- **Deterministic host slots:** slot `N = publicUdpPort - udpPortStart` maps to FakeTCP port `14100 + N`, TUN interfaces `ptc-N` (`10.250.N.0/30` on the bridge) and `pts-N` (`10.251.N.0/30` on the node), with isolated `--no-nftables` rules compatible with dual-IP node routing and `ufw`/Docker. Only the bridge's public IPv4 is DNAT-allowed to reach `14100 + N` on the node.
- **Zero-overhead inactive FRP:** switching a node route to WyTunnel prints `systemctl disable --now amnezia-frpc@<route-id>.service` for the node. When no active FRP routes remain on a bridge, set `frps` disabled (`bridge-update <id> --frps=off` or the bridge card in the UI) and run `/opt/amnezia-bridge/scripts/toggle-frps.sh --disable` on the bridge host so `amnezia-frps.service` consumes **0 RAM / 0 CPU** without triggering `FRPS_UNREACHABLE` alerts.
- **Two migration patterns:**
  1. **Zero-downtime new route:** `amnezia-panel bridge-route-prepare <node-id> <bridge-id> --transport=wytunnel --pool-size=10 --confirm`, run the printed node and bridge WyTunnel installers, wait for `registration: online`, verify via probe or `bridge-route-test-config`, then `bridge-route-activate`.
  2. **In-place same-port cutover:** pre-install `install-wytunnel-node.sh`, run `amnezia-panel bridge-route-transport <route-id> --transport=wytunnel --confirm` and execute the printed node/bridge cutover and `disableFrpc` commands. Roll back in seconds by switching `--transport=frp_tcp` and re-enabling `frpc`.

### Panel door through a bridge (optional)

Users who cannot reach the panel's own hostname can open it through a bridge
on a sibling subdomain of `PANEL_PUBLIC_URL`. Placeholders below:
`link.example.org` is `PANEL_PUBLIC_URL`, `door.example.org` the door,
`203.0.113.10` the bridge, `203.0.113.20` the panel host.

**How login works there.** The two names must share a parent (three or more
labels each, here `example.org`). The panel keeps a request on the hostname it
came in on (`Host` / `X-Forwarded-Host`), puts that origin into the OAuth
state and sets its cookies on the parent, so after login the user lands back
on the door. Google always calls back
`<PANEL_PUBLIC_URL>/api/auth/google/callback`, so `link.example.org` must stay
reachable for those users. If it is not, point `PANEL_PUBLIC_URL` at a name
that is and add its callback to the OAuth client's redirect URIs.

**Why passthrough.** The bridge only routes TLS by SNI; the panel host
terminates it with the certificate it already has (a wildcard for the parent
covers the door). No certificate is issued for the door, so its name never
appears in Certificate Transparency, and the bridge never holds panel
traffic in clear.

1. **DNS.** An A record `door.example.org → 203.0.113.10`, DNS only (not
   proxied by a CDN).
2. **Bridge.** Install HAProxy and use
   [`infra/bridge/haproxy-panel-door.cfg.example`](../../infra/bridge/haproxy-panel-door.cfg.example)
   with your names, then open the ports:
   ```sh
   apt-get install -y haproxy
   haproxy -c -f /etc/haproxy/haproxy.cfg.new && mv /etc/haproxy/haproxy.cfg.new /etc/haproxy/haproxy.cfg
   systemctl enable --now haproxy && systemctl reload haproxy
   ufw allow 443/tcp && ufw allow 80/tcp
   ```
   It refuses every other name, and it does not touch frps, the agent or the UDP pool.
3. **Panel host.** Serve the door with the same site as the panel. With Caddy:
   ```
   *.example.org {
       tls { dns <provider> ... }         # the wildcard you already use
       @panel host link.example.org door.example.org
       handle @panel {
           reverse_proxy 127.0.0.1:5430   # keeps the original Host
       }
       handle {
           abort
       }
   }
   ```
   Back up the file, run `caddy validate --config <file> --adapter caddyfile`
   (with the DNS provider's environment loaded), then `systemctl reload caddy`.
   The original `Host` (or `X-Forwarded-Host`) must reach the web app; with any
   other proxy, forward it explicitly.
4. **Check before telling the panel:**
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' --resolve door.example.org:443:203.0.113.10 https://door.example.org/login   # 200
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://door.example.org/   # 307 -> https://door.example.org/login
   curl -s -o /dev/null -w '%{http_code}\n' https://link.example.org/login   # still 200
   ```
   From the users' network as well, not only from the panel host. A redirect
   to `link.example.org` instead of the door means the original `Host` was lost.
5. **Panel.** Set the bridge's panel domain:
   `amnezia-panel bridge-update <bridge-id> --panel-dns=door.example.org`
   (or the bridge card in **Nodes and bridges**). The card checks that the
   name resolves to the bridge and that `https://<name>/login` answers through
   the bridge IP, and the probe adds an HTTPS check of the bridge host on every
   run. Set it only once step 4 passes, or the bridge check fails and alerts.

To undo: clear the domain (`--panel-dns=none`), remove the name from the panel
host's site, stop HAProxy on the bridge and close 443/80.

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
| API | `BRIDGE_PROBE_UNAVAILABLE` | Configure and enable the probe or verify with a test config and operator attestation |
| API | `BRIDGE_PROBE_CAPABILITY_MISSING` | Upgrade the probe to a version that reports `bridge-measurement` or use operator verification |
| API | `BRIDGE_UNSUPPORTED_CAPABILITY` | The agent lacks the required `status.v1` or `update.v1` capability |
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
      configs through Direct -> Bridge -> Direct for full tunnel and Outside
      Runet (`ru_blacklist`). Check AWG 2 export compatibility.
- [ ] Retiring route: a file imported before activation still connects until the
      frpc unit is removed and the port released.
- [ ] Rollback rehearsal (section 7) on a disposable copy of the database with the
      pinned pre-bridge and candidate images: old panel and CLI against the
      migrated database, then update again and confirm saved bridge state.
