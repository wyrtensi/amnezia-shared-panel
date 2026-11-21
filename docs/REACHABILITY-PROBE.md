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
- Every registered address of a node is a server of its own. For AWG 3 the
  probe measures each enabled address with checks on, once per run, on that
  address's route and with that address's configuration profile (see
  "Addresses"). AWG 2, and a node without registered addresses, are measured
  per node from the service key as issued.
- Each measurement checks `ping`, `tcp` (port 22 banner), `handshake` (a real
  AWG tunnel), and `http` through the tunnel (the egress IP is shown, and
  noted when it is not the node's own address). An address is **available**
  when handshake and http pass; a node is available when at least one of its
  addresses (or, on a direct node, its AWG 2) is.
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

Each AWG 3 key carries a client profile (its own Jc, Jmin, Jmax and I-packet
order) like every new user key, so without a generator preset the probe
measures the way new user keys connect. Keys issued before profiles existed
got one in the upgrade that added this (migration 0066, which also queues a
run); the profile is client-side, so the keys were not reissued.

### After a configuration change

Every run builds each node's and each address's target from the current
settings (generator profile, bridge mode, address). A change to what is
measured on a node with checks on queues a run once it is saved, so it is
checked right away instead of at the next scheduled run:

- the node's or an enabled address's generator profile or client MTU;
- an address added, enabled or disabled, or an enabled address's bridge mode;
- checks turned back on for the node or an address;
- the node's bridge route assignment;
- the portal's bridge default (it moves every address that inherits it on a
  node with an active bridge route: those addresses and the node's bridge
  path read `unknown` until the run);
- the node agent reporting a new primary address.

The worker starts that run at its next tick, about a minute later, or right
after a run in flight; the result shows once the run finishes. When checks
were turned back on, the run waits for the new probe key to provision.
Until then the affected address reads `unknown`. Renames and other edits
queue nothing, nor do user, key or device-type settings, which the probe does
not measure (it checks what an address's ordinary users get; see "Levels" in
[AWG-GENERATOR.md](AWG-GENERATOR.md)). Nothing is queued while the probe is
disabled. Each queued
run checks every node, like a scheduled one.

### Request fields and capabilities

Per target, `expectedEgressIp` is a string (compared with the observed egress
address; a difference is a note, not a failure), an explicit `null` (a bridged
path with no known origin exit IP: the observed address is reported in
`egressIp` and never compared), or omitted (the endpoint host is the
comparison, as before). The result shape is the same in all three cases; an
original Direct request replays unchanged. Handshake and HTTP decide
availability; ping and tcp stay diagnostic.

`GET /capabilities` (same `x-api-key` as the other routes) answers
`{ "apiVersion": 1, "capabilities": ["bridge-measurement", "bridge-host-check", "stealth-probe"] }`. Older probes may report a subset. A legacy probe
answers 404 and also drops an explicit `null`, so the panel never sends one to
it. The worker reads the endpoint at most every 10 minutes (on the reachability
tick) into `reachability_probe.capabilities` / `capabilities_checked_at`: a 404
stores an empty list (legacy), an unreachable probe or an error keeps the old
record and is not asked again for 5 minutes. The panel treats bridge measurement as supported only for a record
younger than 30 minutes that lists `bridge-measurement`; unknown, stale and
legacy all mean unsupported, and Direct measurements are unaffected. Deploy
the new probe image before relying on bridged measurements.

### Addresses

Each enabled address with checks on is measured on the path its users take,
with the config they get:

- **Route.** Through the node's bridge when the node has an active bridge
  route and the address's bridge mode is `bridge`, or `inherit` while the
  portal default sends addresses through the bridge; direct otherwise.
- **Config.** The service key's AWG 3.1 artifact projected with the address's
  effective configuration profile (its own generator settings, or the node's
  when it inherits them), rendered for the address itself or for the bridge's
  public IPv4 and the route's UDP port (the same renderer as user exports).
  The address stored in the service key when it was issued is not used.
- Bridged addresses whose built configs are identical share one measurement;
  each distinct profile is measured on its own. Every address of the group
  gets that verdict.
- A bridged address is unknown (`error`, never an alert) when the probe lacks
  the bridge-measurement capability or the artifact cannot be rendered for the
  bridge; the direct config is never sent in its place. An address with
  checks off is not measured; a node whose addresses all have checks off
  reads unknown ("no address with checks on").
- `expectedEgressIp` is the node's origin exit IP (`nodes.public_ip`), or an
  explicit `null` on a bridged path when unknown.
- With an active bridge, direct AWG 2 checks are skipped by default.
  `probe-set --probe-direct-when-bridged=on` adds a direct check of every
  bridged address and the node's AWG 2; those are diagnostic (the node's
  `direct` status reads available when any of them works) and never change a
  verdict. A batch already sent may finish with its original targets.
- The node's AWG 3 row (`node_reachability_results`) is its path evidence:
  while a bridge route is active, the best bridged measurement (unknown when
  no address goes through the bridge), otherwise the best address. A direct
  address therefore never vouches for a bridge in route verification or the
  TLS rotation gate.
- A failing bridge never changes the assignment: exports keep using the active
  route until an administrator changes it.

**Endpoint revision.** An address target id is
`<node>:awg3:r<revision>:direct:<digest>` or `…:bridge:<digest>`; the digest
covers the address, its own revision and the effective profile, the prefix
the node's bridge assignment revision (`nodes.vpn_endpoint_revision`). A node
target (no registered address) is `<node>:awg3:r<revision>`; AWG 2 stays
`<node>:awg2`. Changing the
assignment (Direct or another bridge) bumps the revision and, in the same
transaction under the node row lock, deletes the node's AWG 3.1 result and
turns its verdict to unknown. An open incident is kept, so it ends with one
recovery message; the failure streak restarts, so the old path's failures do
not count towards an alert about the new one. The ingest claims the run, then
locks the probed node rows `FOR SHARE` and classifies against the targets and
verdicts read under that lock. A result measured for an earlier revision is
unknown: it is not stored, not counted and never causes a message, while that
run's AWG 2 result is kept.

### Bridge status and alerts

The panel tracks management API access and the FRP bridge-to-node route state
separately from external reachability. A bridge with active probed routes uses
the actual AWG results already collected through FRP. With the
`bridge-host-check` capability, a standalone bridge can also be checked using
its configured HTTPS login host, dialing the bridge IP and verifying the
certificate for the configured hostname, or
lightweight network diagnostics when HTTPS evidence is unavailable.

The admin UI and `probe-results` show the separate results. Use
`bridge-probe <bridge-id> --off` to pause alerts for that bridge and
`probe-results --bridges --json` to list bridge results in scripts.

Low-impact mode is on by default. It paces scheduled runs and omits routine
ping and SSH checks before bridged AWG traffic. The probe uses the same
negotiation and client parameters as the dedicated key it was issued.

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
`reachability_probe.capabilities`; unknown, stale or legacy counts as
unsupported); until then
use the operator-verified path (`docs/CLI.md`).

The result is stamped with the time the run was claimed, and a run settled more
than 15 minutes after that is recorded as `PROBE_RESULT_STALE` (or
`PROBE_RUN_TIMEOUT` when unfinished), so late evidence never passes the
30-minute activation window. While the probe API is unreachable, a claim older
than those 15 minutes is given up as `PROBE_RUN_TIMEOUT` on the panel clock, so
an outage cannot hold the probe. A queued check whose route now reports another
registration marker ends as `MARKER_CHANGED` without taking the probe. A second
request while a check of the route is queued or running returns that check; one
for a changed registration answers `BRIDGE_CHECK_PENDING` until it settles.

A candidate check waits while a regular run holds the probe and gives up after
about 14 minutes of retries (`PROBE_BUSY`). With a fleet run longer than
`intervalSec` the probe is almost never free, so candidate checks can starve:
raise `intervalSec`, or use operator verification.

## Statuses and alerts

| Status | Means |
|---|---|
| available (`ok`) | an address: handshake and http passed; a node: at least one of its addresses (or its direct AWG 2) is available |
| unavailable (`failed`) | the control target worked, and no tunnel worked (for a node: on any address) |
| unknown (`error`) | the probe could not look: control target down, no usable key yet, probe error |

Telegram, through the same chat as the quota-request notification
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, which accepts a single numeric chat
id or comma-separated numeric chat ids; every chat gets the alerts and the
status widget), plain text:

- **one** "unavailable" message per address per incident, after
  `fail-threshold` consecutive failed runs (default 2); nothing more while it
  stays down. A bridged address names its bridge
  (`Адрес <name> (<ip>) через мост <bridge> (<ip>:<port>)`). Addresses of one
  node that go down in the same run share one message;
- **one** "available again" message when it recovers, shared the same way;
- a node without registered addresses keeps one incident of its own, with the
  same rules;
- when every attempted node (at least two) fails with no handshake anywhere,
  **one** combined message instead, listing the addresses, marked "the probe
  itself may be broken", and one combined recovery;
- an open address incident stays open across a profile, bridge mode, route,
  portal bridge default or primary address change (its streak restarts);
  disabling the address or turning its checks off closes it without a
  message;
- **one** message when the probe has reported nothing for `stale-after-sec`
  (default 3 h, never less than one period plus 30 min), and one when it is
  back.

`unknown` never opens or closes an incident.

### Status widget

The same bot keeps **one shared** widget (Bot API `sendWidget` with
`is_shared`) and shows it in every chat of `TELEGRAM_CHAT_ID`: the first chat
gets it from `sendWidget`, the others the same widget from `sendSharedWidget`.
Each copy is pinned silently when it is sent. After each ingested run, and when
the probe goes stale, the worker changes the data of every copy at once
(`editSharedWidgetData`, the widget's `public_data`); an open copy picks the
change up within the shared widget's refresh period (30 s by default). It sends
new messages only in the cases listed below. Production Telegram shows widgets
only in the **private chat** with the bot, so every id in `TELEGRAM_CHAT_ID`
must be a person's id (who has started the bot) for the widget to work there.
When Telegram refuses shared widgets for the bot (`INPUT_MEDIA_WIDGET_NOT_ALLOWED`,
seen in production in November 2026), each chat gets a widget of its own
instead and every refresh edits each one (`editMessageWidgetData`); the worker
tries sharing again after a restart and moves to it once Telegram allows it.

- Heading "VPN из {label}: N из M"; one row per address with checks on for
  every node the latest run judged by its addresses, bridged nodes included
  (an address waiting for its check after a change reads unknown). A node
  without registered addresses, with every address's checks off, serving
  only AWG 2 or with a legacy probe key keeps one node row.
  Each row shows that address's own levels: ssh / vpn /
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
- A new label or a new widget template sends a new shared widget to every
  chat and unpins the old copies. So does taking a chat off `TELEGRAM_CHAT_ID`:
  the old widget is no longer edited, so the copy left in that chat stops
  changing. A chat added to the list gets a copy of the current widget. A run
  that sends a node unavailable/back alert sends a new copy to each chat whose
  copy is more than a day old (or has no recorded send time), so it
  stays near the newest messages; runs without an alert never resend.
- Telegram does not report a copy someone deleted (the shared widget outlives
  its messages): that chat gets a new copy on the next rule above.
- A chat that refuses (for example, the person never started the bot) does not
  hold up the others; it is tried again on the next refresh and shows in the
  error. `probe` shows the widget's last update or error (`tg widget:`).

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

A server badge and an AWG 3.1 **key card** read the verdict of the path the
user's key takes on its address (the key's own address, or the primary one):
the address's verdict when the key takes the route the address was measured
on; the node's bridge path row when the key goes through the bridge where the
address was measured direct (a per-user bridge setting); unknown when it goes
direct where only the bridge was measured, or is pinned to a route that is no
longer active. An AWG 2 key card, and any key on a node without registered
addresses, read the result of their own protocol on the node. A missing
result, an `error` one or a stale one is `unknown`, and `blocked` carries its
own failing-since. An AWG 3.1 key is therefore not shown healthy because AWG 2
or another address works.

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

### Update the probe image

The probe keeps nothing between runs, so an update only has to land between
two runs: `probe` on the panel shows no run in flight, and no bridge route
check is running (a restart fails one with `PROBE_RUN_LOST`).

```bash
# on the probe host; compose never pulls (pull_policy: never), so pull first
docker pull --platform linux/amd64 ghcr.io/<owner>/<repo>/reachability-probe@sha256:<digest>
cp -p .env .env.bak-$(date -u +%Y%m%dT%H%M%SZ)
# .env: PROBE_IMAGE=ghcr.io/<owner>/<repo>/reachability-probe@sha256:<digest>
docker compose config -q && docker compose up -d
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' reachability-probe | grep APP_VERSION
curl -s http://127.0.0.1:4002/healthz            # -> {"ok":true}
```

A locally built image goes over with `docker save | ssh <probe-host> docker
load` and is pinned by the image ID instead. Then `probe-run` on the panel and
check `probe-results`: every node has a fresh result. To roll back, put the previous `PROBE_IMAGE` from the
`.env.bak-*` file back and run `docker compose up -d`; keep the previous image
on the host until the new one has done a few runs.
