# External reachability probe

The panel can tell whether a node is reachable only from the age of its newest
peer handshake. It cannot tell you that a node has stopped working **from one
particular network** — for example, when a filter starts dropping a node's AWG
UDP traffic while TCP still answers. The reachability probe closes that gap: it
runs on a machine inside the network you care about (the *vantage point*),
brings up a real AWG tunnel to every node on a schedule, and the panel shows
the result in admin/nodes and alerts in Telegram.

Design: [superpowers/specs/2026-11-10-external-reachability-probe-design.md](superpowers/specs/2026-11-10-external-reachability-probe-design.md).

## How it works

```
panel host                                   probe host
worker ── autossh tunnel (panel side) ──────► 127.0.0.1:<port>
                                               └─ probe container (own bridge)
                                                  amneziawg-go awgp0, table 200
```

- The probe listens on the probe host's loopback only. The panel keeps an SSH
  tunnel to it (`panel-tunnel-<name>`, the same unit shape as for nodes) and
  pulls: it starts runs and reads results. The probe never calls the panel and
  holds no panel credentials.
- Each run carries the client configs of the probe's service keys. The probe
  keeps them in memory and on a tmpfs for the duration of one node, and never
  logs them.
- Per node and protocol it measures `ping`, `tcp` (port 22 banner),
  `handshake` (a real AWG tunnel), and `http` through the tunnel (the egress IP
  is shown, and noted when it is not the node's own address). A node is **available** when handshake and http
  pass for any protocol it serves.
- Every run first fetches a **control target** without the tunnel. If that
  fails, the vantage point itself is offline: every node reads `unknown`, and no
  alert is sent.

### What the probe host keeps

Nothing changes on the probe host itself. The tunnel interface, its routing
table and the source rule exist only in the probe container's network
namespace; the host's routes, rules, DNS and interfaces are untouched, and its
other services keep their direct egress. The container gets `NET_ADMIN`,
`NET_RAW` and `/dev/net/tun`, and nothing else.

### The service account

The probe's keys (one per node and protocol it serves) are owned by the panel's
service account `reachability-probe@service.invalid`. The worker creates and
revokes them itself; they never appear in user lists, quotas, traffic, online
counts, or the Cloudflare Access sync, and admin user actions on that account
are refused. They do occupy a peer slot on each node, shown as `probeKeyCount`
next to `peerCount`.

A key a node refused (a node that is gone, for example) is not retried more
often than once a day; that node reads `unknown` meanwhile.

### Bridge route candidate checks

`bridge-route-verify <route-id> --confirm` (optional AWG 3.1 node bridges)
queues a one-target run: the node's AWG 3.1 service key with the draft bridge
endpoint written in. The probe runs one run at a time and both runs use the
same service peer, so a candidate run starts only while no regular run is in
flight or waiting to be ingested, and the regular run waits while a candidate
holds the probe. Handshake and HTTP through the tunnel decide; ping and TCP are
diagnostic only. The result is stored on the route, never in node status,
history, alerts or the widget. It needs `VPN_BRIDGE_JOBS_ENABLED=true` and a
probe that reports the bridge-measurement capability (stored in
`reachability_probe.capabilities`; unknown counts as unsupported); until then
use the operator-verified path (`docs/CLI.md`).

The result is stamped with the time the run was claimed, and a run settled more
than 15 minutes after that is recorded as `PROBE_RESULT_STALE` (or
`PROBE_RUN_TIMEOUT` when unfinished), so late evidence never passes the
30-minute activation window. A second request while a check of the route is
queued or running returns that check; one for a changed registration answers
`BRIDGE_CHECK_PENDING` until it settles.

A candidate check waits while a regular run holds the probe and gives up after
about 14 minutes of retries (`PROBE_BUSY`). With a fleet run longer than
`intervalSec` the probe is almost never free, so candidate checks can starve:
raise `intervalSec`, or use operator verification.

## Statuses and alerts

| Status | Means |
|---|---|
| available (`ok`) | handshake and http passed for at least one protocol |
| unavailable (`failed`) | the control target worked, and no protocol got a working tunnel |
| unknown (`error`) | the probe could not look: control target down, no usable key yet, probe error |

Telegram, through the same chat as the quota-request notification
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), plain text:

- **one** "unavailable" message per node per incident, after `fail-threshold`
  consecutive failed runs (default 2); nothing more while it stays down;
- **one** "available again" message when it recovers;
- when every attempted node (at least two) fails with no handshake anywhere,
  **one** combined message instead, marked "the probe itself may be broken",
  and one combined recovery;
- **one** message when the probe has reported nothing for `stale-after-sec`
  (default 3 h, never less than one period plus 30 min), and one when it is
  back.

`unknown` never opens or closes an incident.

### Status widget

The same bot keeps **one** widget message (Bot API `sendWidget`) in the same
chat, pinned silently when it is sent. After each ingested run, and when the
probe goes stale, the worker only changes its data (`editMessageWidgetData`); no
new messages. Production Telegram shows widgets only in the **private chat**
with the bot, so `TELEGRAM_CHAT_ID` must be a person's id for the widget to work.

- Heading "VPN из {label}: N из M"; one row per node with checks on: ssh / vpn /
  internet ✓ ✕ or "-" (not run), devices online now (the
  probe's own keys excluded), and "люди": how long ago a person last
  completed a handshake on the node — the admin card's "last handshake", probe
  keys excluded, revoked keys included. Shown as "<1ч", whole hours ("5ч"), or
  days with one decimal ("1.1д"); yellow past 24 h, red past 48 h, a grey "-"
  where no person has ever connected. The widget counts the age on from the
  check, so it keeps moving between runs. The dot, "N из M" and the row order
  follow the handshake (vpn) level only. Unavailable nodes first, with the time
  they went down.
- Footer: last check and the expected next one, in the probe's `--time-zone`.
- A yellow banner when the newest run failed everywhere (the combined-alert
  rule); "нет данных" with dimmed rows when the probe is stale.
- A deleted widget message, another chat, a new label or a new widget template
  sends a fresh widget and unpins the old one. `probe` shows the widget's last
  update or error (`tg widget:`).

### In the user cabinet

Users see the verdict for the servers they may use, and the "Blocked" badge
on their own keys, through `GET /api/nodes` (`reachability`) and
`GET /api/keys` (`nodeReachability`), behind the `showNodeStatus` policy flag:

- `blocked` from the first `failed` verdict (the alert threshold does not
  apply), with the instant it began; the cabinet shows it in the browser's own
  time zone (the Telegram widget and alerts keep `--time-zone`);
- `ok` for an `ok` verdict;
- `unknown` (grey) for no probe, a disabled or stale probe, a node without
  checks or without a verdict, an `error` verdict, and a run that failed
  everywhere.

Nothing else leaves: no levels, details, label, host or time zone.

## Install

You need: a Linux amd64 host in the network of interest with Docker and
`/dev/net/tun`; SSH access to it from the panel host; the panel at a version
that includes this feature.

### 1. Image

Built by `.github/workflows/release-reachability-probe.yml` on a
`reachability-probe-v*` tag (`ghcr.io/<owner>/<repo>/reachability-probe`, no
`latest`; the digest is in the run summary), or locally and shipped:

```bash
docker build -t reachability-probe:local services/reachability-probe
# or run the container test first: infra/probe/tests/two-container.sh
docker save reachability-probe:local | ssh <probe-host> docker load
# pin PROBE_IMAGE to the sha256 image ID `docker load` printed on the probe host
```

### 2. Probe host

```bash
sudo install -d -m 0700 /opt/reachability-probe/secrets
# copy infra/probe/compose.yaml and infra/probe/.env.example (as .env) there
openssl rand -base64 48 | sudo tee /opt/reachability-probe/secrets/probe-api-key >/dev/null
# root-owned and 0600: with cap_drop ALL the container's root cannot read a
# 0600 file that belongs to another uid
sudo chown root:root /opt/reachability-probe/secrets/probe-api-key
sudo chmod 600 /opt/reachability-probe/secrets/probe-api-key
# .env: PROBE_IMAGE=<sha256 image id>, PROBE_PORT=<loopback port, default 4002>
cd /opt/reachability-probe && sudo docker compose up -d
curl -s http://127.0.0.1:4002/healthz            # -> {"ok":true}
```

The compose project is `reachability-probe` with its own network; it touches no
other container.

### 3. Panel host: the tunnel

Same unit as in [NODE-CONNECT.md](NODE-CONNECT.md) (option A), named
`panel-tunnel-<name>` so the port allocator in `scripts/add-node.sh` sees it.
Pick a free local port from the same range (`ss -ltn` and the `-L` of existing
`panel-tunnel-*` units), and forward it to the probe's loopback port:

```
-L 172.17.0.1:<local-port>:127.0.0.1:<PROBE_PORT> root@<probe-host>
```

Check from inside the panel:

```bash
docker compose -f infra/prod/compose.yaml exec control-api \
  wget -qO- http://host.docker.internal:<local-port>/healthz
```

### 4. Register

```bash
cat /path/to/probe-api-key | docker compose -f infra/prod/compose.yaml exec -T control-api \
  node apps/cli/dist/main.js probe-set \
    --label='<vantage point label>' \
    --api-url=http://host.docker.internal:<local-port> \
    --api-key-file=- \
    --control-url=https://<a site expected to work from the vantage point>/
```

The label is used verbatim in the admin/nodes heading ("Checks from {label}")
and in every alert text, so write it the way it reads after "from". Optional:
`--egress-url` (must answer the caller's IP as plain text; default
`https://api.ipify.org`), `--interval-sec` (default 3600), `--fail-threshold`
(2), `--stale-after-sec` (10800), `--time-zone` (IANA name for the times in
the alerts and the Telegram widget; default `UTC`).

On its next tick (within a minute) the worker creates the service keys; each
needs one provisioning round on its node, then the first run follows. Ask for a
run any time with `probe-run`, read results with `probe-results`.

### 5. Verify the host is untouched

During a run (`probe-run`, then within a minute):

```bash
# on the probe host: unchanged, the host's own address
curl -s https://api.ipify.org; ip route; ip rule
# inside the probe container while a target is being tested: the node's address
docker exec reachability-probe ip rule
```

## Operating

| Want | Do |
|---|---|
| Stop checking one node | `node-probe <node> --off` (its probe keys are revoked within a minute) |
| Check now | `probe-run` (or "Run now" on admin/nodes) |
| See why a node reads unknown | `probe-results <node>`: the detail names the reason (no key yet, key failed, control failed) |
| Pause the whole probe | `probe-set --enabled=off`. Keys stay, so `--enabled=on` resumes at once; the stale clock restarts when it is switched back on |
| Remove it | `probe-delete --confirm` (revokes every service key), then stop the tunnel unit and the compose project |

`probe` shows `last error` for contact problems (tunnel down, wrong key, probe
busy). A silent probe raises the stale alert; that is the tunnel or the probe
host, not the nodes.

Deleting a node with probe keys needs `node-remove --with-keys` like any node
with keys; the probe keys are the panel's own and are removed with it.
