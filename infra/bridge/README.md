# Bridge host (frps)

`install-frps.sh` installs the single frp server of an AWG 3.1 node bridge.
The panel prints the exact command (and a `--dry-run` variant) when you add a
bridge: `bridge-add` in the CLI, `setupCommands` in the API.

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
sudo sh /opt/amnezia-bridge/install-frps.sh --bridge-id <id> --control-port 7000 --udp-start 41000 --udp-end 41031 [--dry-run]
```

Run `--dry-run` first: it reads the real listeners and unit state, prints
`PLAN:` lines and the firewall rules, and changes nothing. A repeat with the
same inputs is a no-op; a different bridge id, control port or pool on a host
that already has a config stops with the conflicting field (exit 20).

On the node side, `install-frpc.sh` normally needs no overrides. If Docker
publishes the AWG port on a specific IPv4 address, append
`--local-ip <that address>`; `--local-udp-port <udp>` must equal the observed
host port. Both are checked against `docker port amnezia-awg3`.

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
50 frps did not start or listen. The node-side helper
`infra/node/scripts/install-frpc.sh` documents its own codes in its header.

## Tests

`node --test infra/bridge/tests/*.mjs` (PATH stubs, no real frp binary runs).
