# Bridge host (frps)

`install-bridge.sh` sets up a whole AWG 3.1 node bridge host: it runs
`install-frps.sh` (the single frp server) and then installs the bridge-agent as
the Docker Compose service in `compose.yaml`. The panel prints the exact command
(and a `--dry-run` variant) when you add a bridge: `bridge-add` in the CLI,
`setupCommands` in the API. `install-frps.sh` keeps its own interface and can
still be run alone.

## Install location

The bridge has no deployer. Copy this directory to the host once (and again
after updates; the tests directory is not needed):

```sh
rsync -a --exclude tests infra/bridge/ root@<bridge-host>:/opt/amnezia-bridge/
# or: scp -r infra/bridge root@<bridge-host>:/opt/amnezia-bridge
```

Nodes need nothing extra: `scripts/add-node.sh` copies `infra/node`
(including `scripts/install-frpc.sh`) to `/opt/amnezia-panel-node/`; re-run it
to sync an existing node.

## Run

```sh
sudo sh /opt/amnezia-bridge/install-bridge.sh --bridge-id <id> --control-port 7000 --udp-start 41000 --udp-end 41031 \
  --agent-image <name@sha256:digest> [--dry-run]
```

The image is the bridge-agent image published with the release (Task 6a builds
it); pass it with `--agent-image` or `BRIDGE_AGENT_IMAGE`. It must be pinned by
digest: a tag is refused (exit 2). Without an image the frps is installed, the
output says `bridge-agent NOT installed` and the script exits 60: run it again
with the image. The agent step runs after, and never rolls back or restarts, a
working frps.

Run `--dry-run` first: it reads the real listeners and unit state, prints
`PLAN:` lines and the firewall rules, and changes nothing. A repeat with the
same inputs is a no-op; a different bridge id, control port or pool on a host
that already has a config stops with the conflicting field (exit 20).

On the node side, `install-frpc.sh` normally needs no overrides. If Docker
publishes the AWG port on a specific IPv4 address, append
`--local-ip <that address>`; `--local-udp-port <udp>` must equal the observed
host port. Both are checked against `docker port amnezia-awg3`.

## The bridge-agent service

`compose.yaml` runs one service (`amnezia-bridge-agent`) with
`docker compose --project-name amnezia-bridge-agent --env-file /etc/amnezia-bridge/agent/agent.env -f /opt/amnezia-bridge/compose.yaml`.
The fixed parts are interface requirements for the image:

- `network_mode: host`, no published ports: the agent listens on
  `127.0.0.1:7600` only (`BRIDGE_AGENT_LISTEN`), which only a host-network
  container exposes to the host's SSH forwarding.
- It runs as uid 0 with all capabilities dropped, a read-only root filesystem and
  `no-new-privileges`: the agent refuses token and dashboard-credential files that
  group or others can read, and `install-frps.sh` requires `dashboard.env` to stay
  `0600` and root-owned, so the container must read both as root.
- Mounted read-only: `/etc/amnezia-bridge/agent/api-token` and
  `/etc/amnezia-bridge/frp/dashboard.env`. The image must ship `package.json`
  next to `dist/` (the agent reads its version from it).
- Environment from the env file: `BRIDGE_ID`, `BRIDGE_APPLIED_CONTROL_PORT`,
  `BRIDGE_APPLIED_UDP_START`, `BRIDGE_APPLIED_UDP_END`, plus the fixed token and
  dashboard paths and `BRIDGE_FRPS_URL=http://127.0.0.1:7500`.

`/etc/amnezia-bridge/agent/api-token` (mode 0600) is generated on the host the
first time and never again; its value is never printed or passed as an argument.
`agent.env` holds no secret. When the agent listens on `127.0.0.1:<port>` and
`GET /healthz` answers, the installer prints only the bridge id, the listener,
the token file path and the host's ed25519 SSH fingerprint.

## Management tunnel and enrollment

The panel reaches the agent over a supervised SSH forward on the panel host, the
same pattern as the node tunnels (`docs/NODE-CONNECT.md`). On the **panel host**:

```sh
sudo sh scripts/add-bridge-tunnel.sh --bridge-id <id> --bridge-host <bridge ipv4> \
  --host-key-fingerprint SHA256:<printed by the installer> [--ssh-key <panel->bridge key>] [--dry-run]
```

It scans the bridge's ed25519 host key, requires the fingerprint to match what the
installer printed, writes a dedicated known_hosts file and an autossh unit
`panel-tunnel-bridge-<id>` with `StrictHostKeyChecking=yes`, allocating the local
port from the same pool as the node tunnels, then checks the agent's `/healthz`
through it. The panel host's key must be authorized for the bridge host. It prints
the management URL (`http://host.docker.internal:<port>`) and the enrollment
command, which pipes the token from the bridge host into the CLI's stdin:

```sh
cd /opt/amnezia-panel/infra/prod && \
ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/amnezia-panel/bridge-known-hosts/<id> \
    -o GlobalKnownHostsFile=/dev/null -i <panel->bridge key> root@<bridge ip> \
    cat /etc/amnezia-bridge/agent/api-token | \
  docker compose exec -T -e CONTROL_API_URL=http://127.0.0.1:3001 control-api \
    node /app/apps/cli/dist/main.js bridge-enroll <id> \
    --api-url=http://host.docker.internal:<port> --api-key-file=- --confirm
```

`-T` keeps the piped token on the CLI's stdin inside the container; the script
prints this command with your values filled in. With a workstation CLI the
equivalent is `... | amnezia-panel bridge-enroll ... --api-key-file=- --confirm`.

The management URL must be allowed by `VPN_BRIDGE_MANAGEMENT_HOSTS`.

## Lab verification (real hosts)

Automated tests cover the scripts with stubs and the agent, poller and read model
with fakes. Before the first production bridge, run once on real hosts: two node
routes registered on one bridge (two `install-frpc.sh` units); stop one frpc and
check only that route's registration changes in `bridges --json`; stop the
management tunnel unit and check the bridge turns `down`/`stale` while the active
route's clients still pass traffic; restart the bridge-agent
(`docker restart amnezia-bridge-agent`) and check both routes report again. Keep
public management-port checks (TCP 7600 and 7500 must not be reachable from the
internet; TCP 7000 only from trusted node addresses) separate from the user UDP probe.

## What it does

- Pins frp v0.72.0 (linux amd64 or arm64), downloads it from the official
  GitHub release and checks the SHA-256 digests hard-coded in the script
  (`sha256sum -c`) before extracting to `/opt/amnezia-frp/0.72.0/frps`.
- Writes `/etc/amnezia-bridge/frp/frps.toml` to a temp file, runs
  `frps verify`, then moves it into place and enables `amnezia-frps.service`.
  If validation or start fails, the previous config stays or is restored.
- frps settings: token auth from a file, `transport.tls.force = true`,
  `allowPorts` = the UDP pool, dashboard on `127.0.0.1:7500` only.

## Files you provide (trusted channel, before the first run)

| File | Mode | Content |
| --- | --- | --- |
| `/etc/amnezia-bridge/frp/token` | 0600 | the shared bridge token (also copied to each trusted node as `/etc/amnezia-node/frp/token`) |
| `/etc/amnezia-bridge/frp/server.key` | 0600 | frps TLS private key |
| `/etc/amnezia-bridge/frp/server.crt` | 0644 | frps certificate signed by the bridge CA, with the bridge IPv4 as a SAN |

The bridge CA certificate goes to each node as `/etc/amnezia-node/frp/ca.crt`
(0644); frpc verifies the frps certificate against it. Secrets never appear in
command arguments, configs or script output.

The installer creates `/etc/amnezia-bridge/frp/dashboard.env` once (mode 0600,
`FRPS_DASHBOARD_USER` and `FRPS_DASHBOARD_PASSWORD`, random). frps reads it as
its unit environment file, and the bridge-agent uses the same credentials with
basic auth against `http://127.0.0.1:7500/api/serverinfo` and
`/api/proxy/udp`.

## Firewall (the script prints these, it changes none)

- Control TCP port: allow only the trusted node source addresses.
- UDP pool: open to VPN clients.
- TCP 7500: keep closed (loopback only).

## Exit codes

0 success or no-op, 2 bad arguments, 11 protected file missing or unsafe,
12 download or checksum failure, 13 `frps verify` rejected the config,
20 conflict with the existing install, 21 a needed local port is already bound,
50 frps did not start or listen. `install-bridge.sh` adds 60 (no agent image: frps installed, agent not), 61 (docker or compose missing), 62 (token or env file unsafe), 63 (pull or compose start failed), 64 (agent not listening on loopback or `/healthz` failing). The node-side helper
`infra/node/scripts/install-frpc.sh` documents its own codes in its header.

## Tests

`node --test infra/bridge/tests/*.mjs scripts/tests/add-bridge-tunnel.test.mjs` (PATH stubs, no real frp binary or Docker runs).
