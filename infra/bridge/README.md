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

The panel's setup command already carries `--agent-image <repo>@sha256:<digest>`:
the Control API puts the newest compatible image of the approved bridge-agent
repository there (`BRIDGE_AGENT_IMAGE_REPOSITORY` on the panel; its worker
resolves the tag to a digest). When none is available the command has no
`--agent-image` and the UI and `bridge-add` say so; you can also pass the image
by hand with `--agent-image` or `BRIDGE_AGENT_IMAGE`. The image must be pinned by
digest (a tag is refused, exit 2) and come from the approved repository: exactly
`--agent-repository` / `BRIDGE_AGENT_IMAGE_REPOSITORY` when given, else any
`ghcr.io/<path>/bridge-agent`. Without an image the frps is installed, the
output says `bridge-agent NOT installed` and the script exits 60: run it again
with the image. The agent step runs after, and never rolls back or restarts, a
working frps.

With an image the installer first checks the host prerequisites (docker, the
compose plugin, systemd and systemctl, curl, sha256sum, and bash and flock for the
updater) and refuses with exit 61 before it touches anything, then runs frps,
creates the update spool, pulls the digest, starts the service and, once
`/healthz` answers, writes the **pin file** `/etc/amnezia-bridge/agent/image.pin`
(mode 0600: `BRIDGE_AGENT_IMAGE_REPOSITORY` and `BRIDGE_AGENT_IMAGE`). The pin
records the repository and the digest that was last verified running. Which file
is authoritative: `agent.env` holds the image Compose RUNS; `image.pin` holds the
last known-good one (the rollback target). The setup command passes
`--agent-repository`, so the pin records the repository the panel approved. The
bridge-agent updater takes the approved repository from its own unit and the
digest from the panel's request, never from the pin's repository line, and uses the pin only
to restore the previous image (see "bridge-agent updates" below).

## The bridge-agent image

`services/bridge-agent/Dockerfile` builds it (multi-stage, pinned bases, `dist`
plus `package.json`, healthcheck on the unauthenticated `/healthz`; non-root by
default and run as root by `compose.yaml`, see below). It carries the label
`io.amnezia.bridge-agent.api-version`, which the panel checks against the API
versions it supports. Its version is the `services/bridge-agent/package.json`
version, released independently of the panel and the node-agent: push the tag
`bridge-agent-vX.Y.Z` (it must equal that version; the workflow refuses a
mismatch) and `.github/workflows/release-bridge-agent.yml` builds and pushes
`ghcr.io/<owner>/<repo>/bridge-agent:X.Y.Z` (no `latest`, tags only, no GitHub
Release). Set `BRIDGE_AGENT_IMAGE_REPOSITORY=ghcr.io/<owner>/<repo>/bridge-agent`
in `infra/prod/.env`; the worker offers the newest tag at or above 0.1.0 whose
API version label is supported (an image without the label is judged by the
version alone).

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
  `BRIDGE_APPLIED_UDP_START`, `BRIDGE_APPLIED_UDP_END`,
  `BRIDGE_AGENT_IMAGE_REPOSITORY` (the approved repository: `--agent-repository`,
  else the image's own), plus the fixed token and dashboard paths,
  `BRIDGE_FRPS_URL=http://127.0.0.1:7500` and the update spool path.
- The only read-write mount is the update spool's `requests/` directory; its
  `results/` directory is mounted read-only. No Docker socket.

`/etc/amnezia-bridge/agent/api-token` (mode 0600) is generated on the host the
first time and never again; its value is never printed or passed as an argument.
`agent.env` holds no secret. When the agent listens on `127.0.0.1:<port>` and
`GET /healthz` answers, the installer prints only the bridge id, the listener,
the token file path and the host's ed25519 SSH fingerprint.

## bridge-agent updates (host updater)

The panel's **Update agent** (Bridges tab) and `bridge-agent-update --confirm`
reach the agent's `POST /v1/update`; the agent never touches Docker. The host's
systemd updater does the replacement:

| Piece | Where | Owner |
| --- | --- | --- |
| Request spool | `/var/lib/amnezia-bridge/update/requests/<operation id>.json` | written by the agent (its one read-write mount), read and removed by the updater |
| Results | `/var/lib/amnezia-bridge/update/results/<operation id>.json` | written by the updater, read-only to the agent (so a replaced agent still answers `GET /v1/update`) |
| Journal | `/var/lib/amnezia-bridge/updater/journal` (+ the previous pin) | updater only, root, never mounted |
| Lock | `/run/amnezia-bridge-updater` (flock on the directory) | updater only |
| Units | `amnezia-bridge-agent-update.path` / `.service` (`ExecStart=/bin/bash /opt/amnezia-bridge/bridge-agent-update.sh`) | installed and enabled by `install-bridge.sh` after the pin exists |

`amnezia-bridge-agent-update.path` starts the service while a `*.json` request
or a journal exists. `bridge-agent-update.sh`, under the lock:

1. Re-validates the request independently: the file name and body name the same
   operation id, the repository equals the unit's `BRIDGE_AGENT_UPDATE_REPO`
   (never the pin's repository line), the digest is a full `sha256`, `notAfter`
   is a valid time. A refused request ends `failed` with a fixed code.
2. Reads the clock; past `notAfter` the intent ends `expired` and is never
   claimed. Otherwise it **claims** it (result `queued`, journal), reads the
   clock again, and only then starts (`picked_up`). The agent reports a result
   verbatim and judges only an unclaimed request by the clock, so an `expired`
   answer is never followed by a start. An operation id that has any result is
   never applied again (replays are removed).
3. `staging`: needs a known-good pin (`image.pin`) to roll back to, then
   `docker pull --platform linux/amd64 <repo>@<digest>`. No image is ever removed.
4. `replacing`: rewrites `BRIDGE_AGENT_IMAGE` in `agent.env` (whole file, renamed)
   and runs `docker compose --project-name amnezia-bridge-agent ... up --detach
   --no-deps --no-build bridge-agent`. frps (a host service) is never touched.
5. `health_check`: the container `amnezia-bridge-agent` runs exactly the
   requested reference and image id, `/v1/identity` names the enrolled bridge id
   (from `agent.env`) and, when the previous agent advertised it, lists the
   `update.v1` capability (a candidate without it is rolled back), and an authenticated `/v1/status` answers for it with
   `frps.reachable=true` (30 attempts, 2 s apart). The token is passed to curl on
   stdin, never as an argument.
6. Pass: the pin moves to the candidate, result `succeeded`. Fail: `agent.env` and
   the pin are restored to the previous known-good image, the agent is recreated
   the same way and checked the same way: `rolled_back` (error code = why the
   candidate failed) or, if the previous image fails too, `rollback_failed`.
   A request for the digest that already runs recreates nothing and succeeds only
   if the checks pass (else `failed CURRENT_AGENT_UNHEALTHY`).

An interrupted run (crash, reboot, the unit's 900 s timeout) leaves the journal and
the request, so the unit starts again: before the replacement the operation ends
`failed UPDATE_INTERRUPTED`; after it the running agent is checked and either
accepted or rolled back. Nothing is applied twice.

Error codes in results are fixed (`DIGEST_INVALID`, `REPOSITORY_NOT_APPROVED`,
`OPERATION_MISMATCH`, `NOT_AFTER_INVALID`, `UPDATER_NOT_CONFIGURED`,
`NO_KNOWN_GOOD_PIN`, `PULL_FAILED`, `IMAGE_PLATFORM_MISMATCH`,
`CANDIDATE_START_FAILED`, `HEALTH_IMAGE_MISMATCH`, `HEALTH_AGENT_UNREACHABLE`,
`HEALTH_IDENTITY_MISMATCH`, `HEALTH_CAPABILITY_MISSING`, `HEALTH_STATUS_FAILED`, `HEALTH_FRPS_UNREACHABLE`,
`ROLLBACK_START_FAILED`, `ROLLBACK_VERIFICATION_FAILED`, `UPDATE_INTERRUPTED`,
...); details, including docker output, are only in
`journalctl -u amnezia-bridge-agent-update.service`.

Check on the host: `systemctl status amnezia-bridge-agent-update.path`,
`ls /var/lib/amnezia-bridge/update/requests`, `cat /var/lib/amnezia-bridge/update/results/<id>.json`.
Re-running `install-bridge.sh` reinstalls the image given on its command line: after
an update, pass the image from `image.pin`.

If systemd reports a start-limit-hit for the updater (repeated failing starts),
clear it with `systemctl reset-failed amnezia-bridge-agent-update.service amnezia-bridge-agent-update.path`
and re-check the path unit.

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

**bridge-agent update and rollback with real traffic** (not automated; the
updater is tested with stubs and was exercised against real Docker with a local
registry and a fake frps dashboard only). With two node routes active on one
bridge and an AWG client connected through each:

- [ ] Before: record `systemctl show amnezia-frps -p MainPID -p ActiveEnterTimestamp`
      and both routes' registration markers (`bridges --json`).
- [ ] Keep traffic running through both routes (for example `ping -i 0.2` through
      the tunnel, or a long download) for the whole procedure.
- [ ] Upgrade to a new approved digest from the panel. Expect the operation to
      pass `acknowledged`/`running` (contact may be lost while the agent is
      replaced) and end `succeeded`; `docker inspect amnezia-bridge-agent` shows the
      new digest; `image.pin` and `agent.env` carry it.
- [ ] Request a deliberately bad candidate (an approved-repository digest whose
      container does not answer, prepared for the lab only). Expect `rolled_back`
      with a `HEALTH_*` code, the previous digest running, `image.pin` unchanged.
- [ ] Optional (the automated tests cover it): a failed rollback needs the
      previous image to fail too without touching frps, for example remove it
      locally (`docker image rm <previous>`) and block registry egress while the bad
      candidate is checked. Expect `rollback_failed ROLLBACK_START_FAILED`, then
      reinstall the pinned image with `install-bridge.sh`.
- [ ] After each step: frps `MainPID` and `ActiveEnterTimestamp` unchanged, both
      registration markers unchanged, no traffic gap on either route beyond the
      agent's own management contact.
- [ ] Interrupt an update during `replacing` (`systemctl kill -s KILL
      amnezia-bridge-agent-update.service`): the unit starts again from the journal
      and ends `rolled_back UPDATE_INTERRUPTED` or `succeeded`, never applies twice.

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
50 frps did not start or listen. `install-bridge.sh` adds 60 (no agent image: frps installed, agent not), 61 (a host prerequisite missing: docker, compose, systemd/systemctl, curl, sha256sum, bash, flock, or the updater files), 62 (token or env file unsafe), 63 (pull or compose start failed), 64 (agent not listening on loopback or `/healthz` failing), 65 (the updater units could not be installed or enabled; the agent runs). The node-side helper
`infra/node/scripts/install-frpc.sh` documents its own codes in its header.

## Tests

`node --test infra/bridge/tests/*.mjs scripts/tests/add-bridge-tunnel.test.mjs` (PATH stubs, no real frp binary, Docker or systemd runs).
`bridge-agent-update.test.mjs` drives the real updater with stub `docker`, `curl`,
`systemctl` and `date`; `bridge-agent-update-contract.test.mjs` pins the agent's
update states to the panel's contract and the updater's codes and fields.
