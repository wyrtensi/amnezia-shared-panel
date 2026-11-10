# Reachability probe deployment

The probe runs on a remote vantage point and checks every node the way a client
there would: ping and TCP/22 to the endpoint (informational), then a real AWG
tunnel and an egress request through it. The panel worker starts runs and pulls
results over an SSH tunnel to the probe's loopback port. Source:
[`services/reachability-probe`](../../services/reachability-probe).

## What it touches

Nothing on the host. Each tunnel lives in the container's own network
namespace: `amneziawg-go awgp0`, an address, `ip rule add from <addr> lookup
200` and a default route in table 200. The main routing table is never changed,
so the API, the control request and the AWG UDP itself leave through `eth0`.
One tunnel at a time; teardown always runs.

## Install

1. Get an image and pin it by sha256: either the GHCR digest from the
   `Release reachability-probe image` run, or build locally and
   `docker save | ssh <host> docker load`, then use the loaded image ID.
2. On the probe host, in `/opt/reachability-probe`: copy `compose.yaml` and
   `.env.example` (as `.env`), set `PROBE_IMAGE`.
3. Create the API key, owned by root and mode 0600 (with `cap_drop: ALL` the
   container's root cannot read a 0600 file owned by another uid):

   ```sh
   # as root
   install -d -m 0700 secrets
   (umask 077; openssl rand -hex 32 > secrets/probe-api-key)
   ```

   The same key goes to the panel (`probe-set --api-key-file=-`); never paste it
   into a chat, a log or a ticket.
4. Capture `ip route`, `ip rule` and `/etc/resolv.conf` on the host, then
   `docker compose up -d` and confirm `docker compose ps` shows `healthy`.
5. After the first run, compare the host's `ip route`, `ip rule` and
   `/etc/resolv.conf` with the capture: they must be identical.

## API

All but `/healthz` require `x-api-key`.

| Method | Path | Result |
|---|---|---|
| GET | `/healthz` | `{ok: true}` |
| POST | `/runs` | `{runId, control: {url}, egress: {url}, targets: [{targetId, protocol, config, expectedEgressIp?}]}` → `202 {runId}`; `409` while a run is in progress; `400` on a bad body (≤ 500 targets, config ≤ 16 KiB) |
| GET | `/runs/latest` | `{runId, startedAt, finishedAt \| null, control, results[]}` or `404` before the first run |

Responses and logs never contain the configs: they grant VPN access.

## Test

`infra/probe/tests/two-container.sh` builds the image, runs it with the same
hardening as `compose.yaml` against a server container running the node's awg3
entrypoint, and checks handshake, egress, teardown and that neither the probe's
main table nor the host's routes and rules changed. It needs Docker with
`/dev/net/tun`, `jq` and `curl`, and cleans up only what it created.
