# External reachability probe — design

Status: approved for implementation, 2026-11-10.

## Problem

The panel knows whether a node is reachable only indirectly: from the age of
the newest peer handshake (`endpoint.status`). It cannot tell an operator that a
node has become unreachable **from a particular network** — for example, when a
national filter starts dropping a node's address or its AWG UDP traffic while
the rest of the world still reaches it. Operators find out from user
complaints, late.

A TCP or ICMP check is not enough: a filter can drop AWG UDP while TCP/22 still
answers. The only conclusive test is a real AWG tunnel brought up from that
network.

## Goal

A **probe** runs on a machine inside the network of interest (the *vantage
point*). On a schedule and on demand it brings up a real AWG client to every
node the panel knows, and the panel:

- shows the result per node, per protocol and per level in admin/nodes;
- keeps the latest result, `failingSince`, and a short history;
- sends one Telegram message per node per incident, one when it recovers, one
  combined message when every node fails at once, and one when the probe itself
  goes silent.

The vantage point is configuration, not code. Its display label (used in UI
headings and alert texts, e.g. "Checks from {label}"), its address, the control
target, the period and the thresholds are all settings stored by the panel and
managed through the Control API. Nothing in code, migrations, defaults or
fixtures names a specific country or host.

## Non-goals

- Several vantage points. The schema holds exactly one probe; widening it later
  is a migration, not a redesign.
- Acting on the result (disabling a node, moving users).
- Checking external services *from* a node — that is service checks.

## Anti-goals (a failure even if it "works")

1. **The probe host is affected.** The host's routes, rules, DNS and interfaces
   never change; other services on it keep their direct egress. The AWG client
   exists only inside the probe container's network namespace.
2. **Alert spam**: a repeat per run, flapping, a burst of per-node alerts when
   the probe itself is broken.
3. **A false "unreachable"** when the vantage point lost its own connectivity or
   the probe crashed. `error` never means "blocked".
4. **Service keys look like people**: in user lists, quotas, traffic, online
   counts, the Access allowlist, or the handshake-based reachability signal.
5. **Leaking** the probe's API key or service-key configs (each grants VPN
   access).

## Architecture

```
panel host                                    probe host (vantage point)
┌──────────────────────────┐   SSH tunnel    ┌───────────────────────────────┐
│ worker ── reachability ──┼──(autossh, ────►│ 127.0.0.1:<port> (host lo)    │
│   task    client         │   panel side)   │   │ docker publish            │
│   │                      │                 │ ┌─▼ container, own bridge ───┐│
│   ├─ ingest results      │                 │ │ probe API (x-api-key)      ││
│   ├─ alert state machine │                 │ │ amneziawg-go awgp0 (tun)   ││
│   └─ job_outbox ─► Telegram                │ │ table 200 + rule from addr ││
│ control-api: settings,   │                 │ └────────────────────────────┘│
│   results, run-now, keys │                 └───────────────────────────────┘
└──────────────────────────┘                        │ UDP/TCP/ICMP ─► nodes
```

The channel is the node-agent model: the probe listens on loopback only, and the
panel host keeps a supervised SSH tunnel to it (a `panel-tunnel-<name>` unit, so
`scripts/add-node.sh`'s port allocator sees it). The panel pulls; the probe
never calls the panel and holds no panel credentials.

### Why the panel pushes configs

The worker already holds the keyring that decrypts `vpn_keys.config*`. It sends
each target's client config inside the run request, just as it sends service
check definitions to a node-agent. The probe keeps them in memory and on a
tmpfs only for the duration of one target, so it stores no secrets at rest and
needs no access to the Control API.

## Probe service (`services/reachability-probe`)

TypeScript on Node 24, no runtime dependencies (node:http, node:https, node:net,
node:child_process). Outside the pnpm workspace, like `services/node-agent`.

Image: `node:24-alpine` pinned by digest, `iproute2` added, and the static
`amneziawg-go` plus `awg` binaries copied from the pinned
`amneziavpn/amneziawg-go:3.1.x` image (Alpine/musl, verified). Runs as root
inside the container with `cap_drop: ALL`, `cap_add: [NET_ADMIN, NET_RAW]`,
`/dev/net/tun`, `read_only`, tmpfs `/tmp` and `/var/run/amneziawg`,
`no-new-privileges`, pids and memory limits, its own bridge network.

### API (all but `/healthz` require `x-api-key`, compared in constant time)

| Method | Path | Body / result |
|---|---|---|
| GET | `/healthz` | `{ok: true}` |
| POST | `/runs` | `{runId, control: {url}, egress: {url}, targets: [{targetId, protocol, config}]}` → `202 {runId}`; `409` while a run is in progress |
| GET | `/runs/latest` | `{runId, startedAt, finishedAt \| null, control, results[]}` or `404` before the first run |

A run is asynchronous: a fleet of N nodes × protocols takes minutes, longer than
any sensible HTTP timeout. The latest run lives in memory only.

### One run

1. **Control**: HTTPS GET of `control.url` with no tunnel, 10 s. If it fails,
   the run still finishes but every target is reported with `control: failed`
   and is not attempted — nothing can be concluded about any node.
2. For each target, **sequentially** (two clients can be issued the same tunnel
   address on different nodes; one interface at a time avoids the clash):
   - parse the config: `Address`, `MTU`, peer `Endpoint` host and port; write a
     stripped copy (no `Address`/`DNS`/`MTU`/hooks) to tmpfs, mode 0600;
   - **ping** the endpoint host: `ping -c 3 -W 2`. Informational only.
   - **tcp**: connect to the endpoint host on port 22, read the first line,
     pass if it starts with `SSH-`. 5 s. Informational only.
   - **handshake**: `amneziawg-go awgp0`, `awg setconf awgp0 <stripped>`,
     `ip addr add <Address> dev awgp0`, `ip link set mtu <MTU> up dev awgp0`,
     `ip rule add from <addr> lookup 200`, `ip route add default dev awgp0 table
     200`. Poll `awg show awgp0 latest-handshakes` for up to 15 s. The client's
     `PersistentKeepalive` makes it send a handshake as soon as the peer is set.
   - **http**: HTTPS GET of `egress.url` with the socket bound to the tunnel
     address (`localAddress`), 10 s. Pass if the body is an IP equal to the
     endpoint host's address.
   - teardown, always: delete the rule, flush table 200, delete the link,
     delete the tmpfs file.

The container's main routing table is never changed, so the control request,
the published API and the AWG UDP itself all leave through `eth0`. Only sockets
bound to the tunnel address match the rule. The host is untouched by
construction: everything above happens in the container's network namespace.

Each level reports `{ok: boolean | null, detail, latencyMs}`; `null` means not
attempted. A target whose setup threw (bad config, missing tun) is reported as
`error` with a reason.

## Panel

### Settings and state (one row, `reachability_probe`)

| Column | Meaning |
|---|---|
| `label` | the vantage point label used in headings and alerts. Required. |
| `api_base_url`, `credentials_*` | probe address; API key encrypted like node credentials |
| `enabled` | master switch |
| `control_url` | required; a site expected to work from the vantage point |
| `egress_url` | returns the caller's IP as plain text; default `https://api.ipify.org` |
| `interval_sec` | default 3600 |
| `fail_threshold` | consecutive failed runs before an incident; default 2 |
| `stale_after_sec` | silence before "probe is silent"; default 10800 |
| `run_requested_at` | "Run now" marker |
| `current_run_id`, `current_run_started_at` | the run in flight |
| `last_result_at`, `last_ingested_run_id` | the newest ingested run |
| `last_error`, `last_error_at` | why the last contact failed |
| `stale_alerted_at` | the open "probe is silent" incident |

No row means the feature is off. Settings are DB plus typed endpoints and CLI,
not env vars (the panel's convention for operator-editable values).

### Results

- `node_reachability_results`, PK `(node_id, protocol)`: `status`, `levels`
  (jsonb), `egress_ip`, `detail`, `run_id`, `checked_at`.
- `node_reachability_state`, PK `node_id`: `status`, `consecutive_failures`,
  `failing_since`, `alerted_at`, `alert_kind` (`node` | `mass`), `checked_at`,
  `detail`.
- `node_reachability_history`: one row per node per ingested run (`status`,
  `detail`, `checked_at`), pruned by the maintenance task after 30 days.
- `nodes.reachability_enabled boolean default true`: per-node opt-out, the same
  shape as `checks_enabled`.

All cascade on node delete.

### Status rules (pure functions, unit-tested)

Per `(node, protocol)`:
- `ok` — handshake and http passed;
- `failed` — the control passed and handshake or http failed;
- `error` — the control failed, the target could not be set up, the node has no
  service key for that protocol yet, or the probe never reported the target.

Per node: `ok` if any protocol is `ok`; else `failed` if any is `failed`; else
`error`.

State transition for a node, given its previous state:
- `ok`: `consecutive_failures = 0`, `failing_since = null`. If an incident was
  open (`alerted_at` set) → a recovery message; close it.
- `failed`: `consecutive_failures += 1`; `failing_since` set on the first
  failure, carried otherwise. When the counter reaches `fail_threshold` and no
  incident is open → open one (`alerted_at = now`) and queue an unavailable
  message.
- `error`: status and detail are recorded; the counter, `failing_since` and any
  open incident are left as they were. `error` neither opens nor closes an
  incident.

"Run now" runs count like scheduled runs: two consecutive failed runs are an
incident whichever way they were started.

**Mass failure.** If, in one run, the control passed, at least two nodes were
attempted, and every attempted node has `failed` with no handshake on any
protocol, the per-node unavailable messages this run would queue are replaced
by one combined message listing the nodes, marked "the probe itself may be
broken". Those nodes get `alert_kind = mass`. Nodes that already had an open
incident are not repeated. When several `mass` nodes recover in the same run,
one combined recovery message is sent; otherwise recoveries are per node.

**Stale probe.** If no run has been ingested for `stale_after_sec` (measured
from `last_result_at`, or from the row's creation before the first result) and
no stale incident is open → one "probe is silent" message, `stale_alerted_at =
now`. The next ingested run closes it with one "probe is back" message. A stale
probe changes no node state.

### Telegram

Through `job_outbox`, sent by the existing worker processor and notifier (plain
text, no `parse_mode`). The state transition and the outbox insert happen in one
transaction. Deduplication keys carry the incident identity, because completed
outbox rows keep their key forever:

- `notify.reachability:down:<nodeId>:<incident opened at ISO>`
- `notify.reachability:up:<nodeId>:<incident opened at ISO>`
- `notify.reachability:mass-down:<runId>` / `mass-up:<runId>`
- `notify.reachability:stale:<stale opened at ISO>` / `stale-back:<same>`

Texts use the label as stored, e.g.:

```
node-a (192.0.2.10) is unreachable from {label}
handshake: no, tcp/22: no, ping: no
since 2026-01-01 10:00 UTC
```

The shipped templates use the same language as the existing quota-request
notification in `apps/worker/src/telegram.ts`, with the label interpolated.

### Worker task (`reachability`), every 60 s

1. Load the probe row; nothing to do if absent or disabled.
2. `GET /runs/latest`. A finished run newer than `last_ingested_run_id` is
   ingested in one transaction: results, history, node states, outbox jobs,
   `last_result_at`. A run whose id is not `current_run_id` is ignored.
3. Stale check (above).
4. Start a run when none is in flight and either `interval_sec` has passed
   since `current_run_started_at` or `run_requested_at` is newer than it. The
   targets are every node with `reachability_enabled`, including disabled ones,
   × each protocol it serves, with the decrypted config of its service key.
   A run in flight for longer than 30 minutes is abandoned.
5. Any failure to reach the probe is recorded in `last_error` and nothing else.

### Service account and keys

- `users.service_account boolean default false`. Exactly one such user, created
  on first key sync, email under the reserved `.invalid` TLD so it can never
  log in through any identity provider.
- One predicate, `isServiceAccount`, excludes it from: admin users list and
  actions (refused with 409), admin keys list, the admin overview counts,
  traffic series and node traffic periods, the handshake-based
  `endpoint.status`, Access allowlist sync, Access reconcile deactivation, and
  the offboarded-user purge.
- Probe keys still count towards a node's `maxPeers` — they occupy a real peer
  slot — and the admin node view shows them as a separate count.
- Key sync is owned by the worker, in one place: before starting each run it
  ensures, for every node with `reachability_enabled` and every protocol it
  serves, one live key owned by the service account, via the normal `vpn_keys`
  insert plus `vpn-key.provision` outbox job, without user policy, quota or the
  `enabled` filter. Keys for protocols a node no longer serves, and keys of
  nodes with `reachability_enabled = false`, are revoked through the normal
  `vpn-key.revoke` job. New nodes are picked up without an operator step; a key
  still provisioning makes its target `error` for that run.
- Deleting a node revokes and removes its probe keys like any other key.

### Control API (all admin-only, audited)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/reachability` | settings (no secret), probe health, per-node state + per-protocol results |
| PUT | `/api/admin/reachability/probe` | create or replace settings; `apiKey` required on create, optional after |
| DELETE | `/api/admin/reachability/probe` | remove the probe (results kept until node delete) |
| POST | `/api/admin/reachability/run` | set `run_requested_at` |
| GET | `/api/admin/reachability/history?nodeId=` | history rows |
| PATCH | `/api/admin/nodes/:id` | gains `reachabilityEnabled` |

Contracts live in `packages/contracts`.

### UI (admin/nodes)

A card next to "Service checks", titled from the label ("Checks from {label}").
Probe health line (last result, stale, last error), "Run now". Per
node: status badge, last check, failing since, per-protocol levels
(ping / tcp / handshake / http with egress IP), a per-node switch for
`reachabilityEnabled`. `error` is shown as "unknown", never as "unavailable".

### CLI

`probe`, `probe-set`, `probe-delete`, `probe-run`,
`probe-results [<node>]`, `node-probe <node> --on|--off`.

## Deployment shape

- `infra/probe/compose.yaml`: one service, its own project and bridge network,
  `127.0.0.1:<port>` published, API key as a Docker secret.
- Image built by a `release-reachability-probe.yml` workflow on tag
  `reachability-probe-v*`, or locally and shipped with `docker save | docker
  load`, pinned by digest like the node-agent.
- Panel side: a `panel-tunnel-<name>` autossh unit to the probe's loopback port;
  the worker reaches it at `http://host.docker.internal:<port>`.
- Runbook: `docs/REACHABILITY-PROBE.md`.

## Verification

- Unit: status rules, state transitions, one alert per incident, recovery, mass
  failure and its recovery, control failure → `error` and no alert, stale and
  back, dedup keys distinct across incidents, config parsing and stripping.
- Integration (Postgres): ingest transaction, service-account exclusion at every
  listed site, key sync including disabled nodes.
- Container: a local two-container test — an AWG 3.1 server and the probe on
  separate networks — proving a handshake and egress through the tunnel, and that
  the probe container's main routing table is unchanged.

## Risks

- `amneziawg-go` 3.1 as a client for an `awg2` node is unverified; every node
  currently serves only awg3.
- The egress check compares to the endpoint's address. A node whose egress IP
  differs from its endpoint would read as failed; the panel shows the egress IP
  so the operator can see why.
- The panel's tunnel to the probe crosses the same filtered network. A blocked
  tunnel shows up as "probe is silent", not as node failures.
