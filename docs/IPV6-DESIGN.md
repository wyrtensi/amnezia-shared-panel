# IPv6 in the panel and AWG 3.1 nodes — possible implementation plan

Status: **plan for a possible implementation as of 10.10.2026; not a shipped feature**.
This document records a proposed implementation, its compatibility requirements
and implementation order as of that date. It does not authorize a production
rollout.

## Scope and delivery

If implemented, complete both parts before a release or production code deployment:

- **A: IPv6 inside the tunnel.** A qualified client uses an assigned IPv6
  address through an AWG 3.1 node with verified IPv6 egress. Keep the existing
  IPv4 endpoint, keys, IPv4 addresses, MTU and protocol geometry.
- **B: IPv6 endpoint transport.** A client reaches a new or fully empty node
  using an IPv6 literal. This requires separate client compatibility,
  explicit opt-in, external IPv6 connectivity and a verified MTU budget.

Part A does not require Part B to be enabled on a node. IPv6 remains optional
for every node and client; adding the feature must not require the whole
fleet to acquire IPv6. Keep AWG 2.0 and existing legacy IPv4 peers working.
New protocol features target AWG 3.1.

Do not publish intermediate panel or agent releases or deploy production code
until A, B, Control API, worker, node-agent, infrastructure, CLI, UI and the
release gates below are complete. Host OS IPv6 configuration is a separate
operation and does not prove that VPN IPv6 works. Test in an isolated Linux
lab. A production container restart needs separate operator approval;
never turn an IPv6 operation into an automatic VPN restart.

## Why IPv6 must not be added to every configuration

Treat three independent fields separately:

- `Address` assigns an address inside the tunnel.
- Client-side `AllowedIPs` selects traffic to route through the tunnel.
- `Endpoint` selects the outer network transport used to reach the node.

Adding a usable-looking IPv6 `Address` without working node egress can change
address selection and leave requests waiting on a broken IPv6 path.
An IPv6-only `Endpoint` can prevent the entire VPN from connecting on an
IPv4-only client network. Unsupported parsers can also reject dual addresses.
Do not promise that every OS or application will fall back to IPv4 promptly.

| Node and client situation | Required behavior |
|---|---|
| IPv6 is not requested, including on a node without IPv6 | Keep the existing IPv4 configuration and node eligibility. No IPv6 prerequisites or additional probes. |
| Host has IPv6 but the feature was not enabled | Keep IPv4 behavior. Detecting a host address must not enable the feature. |
| Node has verified IPv6 egress; client network is IPv4-only | Part A can carry inner IPv6 over the unchanged IPv4 endpoint on a qualified client. Native IPv6 at the client ISP is not required for this transport. |
| Node is ready but the client or backend is unqualified | Keep its compatible IPv4 export. A file extension does not prove client compatibility. |
| IPv6 observation is missing, stale, failed or from an old agent | Do not add an unconfirmed IPv6 address to a fresh export. Keep the existing IPv4 path operational. |
| Node uses an IPv6-only endpoint; client network has no IPv6 | The VPN cannot connect through that endpoint. Require explicit transport opt-in; do not offer it to legacy/default requests. Removing an inner IPv6 address cannot fix outer reachability. |

Changing a fresh export does not change a configuration already imported into
a device. During an IPv6 outage, an existing dual-stack configuration may
still encounter IPv6 failures or delays. Preserve its IPv4 peer and routing;
do not claim immediate client fallback.

Keep existing IPv4 DNS defaults. DNS over IPv4 can return AAAA records;
IPv6-only resolvers are not required for Part A.

## Existing full-tunnel contract

Every full-tunnel export retains both default routes:

```ini
AllowedIPs = 0.0.0.0/0, ::/0
```

The equivalent JSON `allowed_ips` retains both entries. The existing `::/0`
is not evidence that the node offers IPv6 egress. Preserve it on opt-out,
failure and rollback; removing it can create a new path outside the tunnel.

Full tunnel must not acquire blacklist, global, custom or DNS-only routes in
place of its defaults. Preserve private/public keys, PSK, HeaderProtectionKey,
IPv4 lease, peer identity, expiry and enabled state. Part A preserves the
existing endpoint, MTU and AWG geometry.

Previously imported IPv4 configurations must keep connecting after backfill
without key reissue or mandatory reimport. A compatible device receives its
new IPv6 address through a later export/import. Do not mass-rewrite encrypted
base configurations or generate replacement keys.

Client application split-tunnel and kill-switch settings can alter local
routing. Record these settings in acceptance tests; panel defaults alone do
not prove the actual OS routes or leak behavior.

For split profiles, preserve existing IPv6 CIDRs, exclusions and additions.
DNS host routes use IPv4 `/32` or IPv6 `/128` after validation. Preserve route
budgets and the existing empty/oversized-feed fallback to both default routes.

## Per-node opt-in, readiness and API

Planned defaults are `AWG3_IPV6=off` and a separate
`AWG3_IPV6_CONTROL=off`. Absence is off; reject other flag values.
Ordinary registration, key provisioning, updates, capacity, backup, metrics,
health and server selection must work on IPv4-only nodes.
Check IPv6 prerequisites only when explicitly enabling the feature. A missing
IPv6 route then fails that operation while the ordinary IPv4 node remains usable.

Distinguish `unsupported`, `off`, `pending`, `applying`, `backfilling`,
`ready`, `degraded`, `failed` and `restart_required`.
An old agent is unsupported for this feature, not globally unhealthy.
An IPv6-only failure must not exclude a working IPv4 node from ordinary use.

All mutations start in typed, admin-authorized Control API endpoints:

- `GET /api/admin/nodes/:nodeId/ipv6`: desired and observed state.
- `PUT /api/admin/nodes/:nodeId/ipv6`: request a desired generation.
- `POST /api/admin/nodes/:nodeId/ipv6/reconcile`: reconcile that generation.

These are planned contracts, not currently available commands. Persist desired
state, durable operations, idempotency, audit and outbox in one transaction.
The worker applies requests through the agent. UI and CLI use this API;
neither writes node state directly. Reusing an idempotency key with a different
request is a conflict. Reject conflicting operations and stale observations.

Separate `networkReady`, `peersReady`, `tunnelReady` and
`endpointConfigured`. Tunnel readiness requires the requested generation,
enabled state, network readiness and peer readiness. A locally configured
endpoint does not prove that clients can reach it.

Only feature-enabled or in-flight nodes receive an independent lightweight
snapshot poll. Planned poll interval is 60 seconds, freshness limit 120
seconds, deadline 5 seconds and concurrency 4, with one request per node.
Use receipt time and validated probe age rather than trusting agent clocks.
Refresh a peer lease only from its actual matching report. Fence replies by
generation, poll revision and runtime instance.

## Address lifecycle and safe application

Use a project ULA tunnel `/64` and a distinct ULA Docker bridge `/64`, with
NAT66 from tunnel to container uplink and IPv6 NAT from container to host.
Prefixes must be canonical, nonoverlapping and validated against relevant
host and Docker networks. A provider prefix is not a tunnel allocation.

Allocate per-peer `/128` leases using 128-bit `BigInt` arithmetic and a first
free gap; do not scan an entire `/64` or convert an address to `Number`.
Parse every comma-separated peer `AllowedIPs` entry. Reserve server/network
addresses and leases of existing, disabled and expired peers.

Backfill is an explicit, idempotent generation operation. Preserve all
identities and IPv4 leases. Disabled or expired runtime peers retain the
existing disabled sentinel; metadata reserves both addresses for later
enablement. Feature-off retains leases, and re-enable reuses them.
Changing an occupied tunnel prefix needs a separate migration.

Serialize lifecycle mutations, backfill, coherent snapshots and backups
through the same queue and host lock. Corrupt or unexpectedly missing peer
state is an error with zero writes, not an empty pool. Use a durable journal
to recover interrupted multi-file changes without rerolling identities.

Keep mutable effective settings in versioned, validated runtime state.
Use a strict parser, not shell `source` or `eval`. Block incompatible agent
downgrades while IPv6 state or reservations remain, including after off.
Declare new metadata in actual backup/import HTTP schemas. Use a queued,
non-disruptive private backup; existing backup procedures that stop VPN
containers are unsuitable for live IPv6 changes.

## Supported node networking

The initial opt-in baseline is rootful Linux Docker Engine 28.1 or newer
(host API at least 1.49) and Compose 2.36 or newer, with TUN and systemd on
the currently supported Linux/amd64 installer path. Other distributions,
architectures, Docker Desktop, rootless Docker and other init systems need
separate qualification. Existing opt-out installations keep their prior
requirements.

Add a separate IPv6-only bridge. Preserve the original IPv4 network, gateway,
interface and NAT path; validate actual per-family routes instead of inferring
them from Compose ordering. All installer, updater, capacity and maintenance
entry points must share the same manifest/environment selection.

On a previously enabled node, feature-off retains provisioned network
attachments and control mounts until separately approved maintenance.
Removing an overlay must not silently recreate the VPN container.

A supported host applier changes only managed network state. It applies the
IPv6 address, checks DAD, routes and scoped forwarding/NAT rules, then the
agent persists assignments in its mutation queue. `awg syncconf` does not
apply interface addresses, MTU, routes or firewall rules.

Handle IPv6 errors after successful IPv4 initialization. Cleanup removes
only the IPv6 changes owned by the operation. Never remove the working
interface, flush global firewall rules, reset IPv4 or exit the container
because IPv6 failed. Permit necessary ICMPv6/PMTUD without opening peer-to-peer
or control-network access. Do not publish the node-agent port on IPv6.

If the supported bridge/NAT/client path is unavailable, report the blocker.
Do not substitute monkey-patching or optimistic readiness.

## Client qualification and endpoint transport

AWG 3.1 requires official AmneziaVPN 5.0.1.5 or newer, but that version floor
does not establish IPv6 compatibility. Record the actual app build, OS,
architecture, backend, import format and AWG engine version.

The source review of official 5.0.3.0 identifies these export rules:

| Client path | Planned behavior |
|---|---|
| Official Android | Candidate for Part A and adapted Part B; qualify the actual VPN/QR import path. |
| Official iOS/iPadOS | Candidate for Part A and adapted Part B VPN/QR. Raw `.conf` import is a separate path; do not enable Part B there without independent proof. |
| Official Windows/Linux/macOS service backend | Keep IPv4/full tunnel. Do not insert comma-separated addresses or promise assigned tunnel IPv6 or an IPv6 endpoint. |
| macOS Network Extension build | Separate explicit profile and signed-build qualification; an OS label does not select it. |
| Standalone AWG 3.1 clients/tools | Qualify each concrete parser, engine and `.conf`/QR path. Stock WireGuard or AWG 2.x is not a substitute. |

In particular, importing a `.conf` into the same official desktop service
backend does not bypass its controller. See the
[official desktop controller](https://github.com/amnezia-vpn/amnezia-client/blob/5.0.3.0/client/mozilla/localsocketcontroller.cpp),
[Android adapter](https://github.com/amnezia-vpn/amnezia-client/blob/5.0.3.0/client/android/wireguard/src/main/kotlin/org/amnezia/vpn/protocol/wireguard/Wireguard.kt)
and [iOS adapter](https://github.com/amnezia-vpn/amnezia-client/blob/5.0.3.0/client/platforms/ios/WGConfig.swift).
Source support is a candidate for device testing, not a passed E2E result.

Planned client profiles are `auto`, `amnezia_vpn`, `amnezia_macos_ne` and
`awg31_conf`. Default to conservative existing behavior. Persist
`clientProfile` and `allowIpv6Endpoint` with key intent; the latter defaults
to false. An export profile override changes only the download candidate,
not the bound node, key or transport.

Exclude IPv6-only endpoint nodes from legacy automatic selection unless the
client explicitly opts in and the profile/format and transport are qualified.
Repeat checks in both API and worker before any peer write, including forced
node selection and retries. Do not infer client ISP connectivity from its OS.
Do not move existing peers or invent an IPv4 endpoint fallback.

Part B initially supports only a new or completely empty node. Check all
protocols, disabled reservations and pending provisioning jobs under a durable
provisioning barrier: a shared public-host setting can affect legacy services.
Reject endpoint/MTU changes on populated nodes pending a separate migration.
Bootstrap disabled, verify runtime state, then enable provisioning through
the API.

Keep canonical endpoint hosts bare. A `.conf` endpoint uses
`[2001:db8::10]:51890` (documentation address only). Final native payloads
require client-specific host formatting; test the whole import and native
serialization path to avoid missing or doubled brackets.

For Part B, validate outer IPv6 overhead, AWG padding/junk/handshake budgets,
path MTU and the minimum IPv6 tunnel MTU of 1280. Read back actual interface
MTU and emit it consistently in JSON and `.conf` before creating peers.
Do not change Part A's existing MTU or geometry. On stale status or
feature-off, retain a previously verified Part B endpoint and MTU; an inner
address fallback must not reset the outer transport.

## Library and runtime requirements

Use declared dependencies and current lockfiles, with clean builds in the
pinned panel Node 24 and agent Node 22 images. Local installed packages or
TypeScript declarations do not prove runtime compatibility.

Zod syntax validation and `ipaddr.js` parsing need explicit family, zone,
mapped-address, ULA, canonical prefix and overlap checks. Use strings for
128-bit addresses on the HTTP/JSON wire; raw `BigInt` is not JSON serializable.
Declare new fields in Zod and every Fastify request/response/backup schema:
validation and serialization can otherwise silently drop metadata.
Verify real HTTP roundtrips, PostgreSQL transactions and idempotency fences.

Preserve the Qt-compatible length/zlib/base64url encoding, nested JSON,
protocol markers and all AWG 3.1 fields in VPN links. Test QR capacity and
scanning with synthetic configurations. Record client/server engine pairs;
server-only packet-budget fixes do not update client binaries.

## Implementation order and release gates

| Step | Deliverable |
|---|---|
| 0 | Confirm the supported baseline and use only synthetic fixtures. |
| 1 | Pin full-tunnel, existing-key and IPv4-only regression contracts before changing behavior. |
| 2 | Typed desired/observed state, client intent, DB migrations, authorization, idempotency, audit and outbox. |
| 3 | Opt-in infrastructure, shared Compose selection, supported applier and failure isolation. |
| 4 | Dual-family parser, allocator and disabled/expired reservations. |
| 5 | Serialized agent lifecycle, explicit backfill, recovery, coherent snapshots and backup contracts. |
| 6 | Agent artifacts that preserve identities, routing and actual verified transport MTU. |
| 7 | Worker application, freshness, generation fencing and mixed-fleet provisioning guards. |
| 8 | Conditional Control API export enrichment and client/format compatibility. |
| 9 | Part B empty-node bootstrap, endpoint formatting and transport/MTU validation. |
| 10 | API-backed CLI/UI, operational docs and lab E2E acceptance. |
| 11 | Complete release gate, followed by a separately authorized production rollout. |

Required evidence before release:

- A mixed fleet in one panel: host without IPv6, dual-stack host with opt-out,
  ready node, old agent and degraded node. Ordinary IPv4 operations continue;
  optional IPv6 failures do not become global health failures.
- A full-tunnel configuration imported before backfill keeps IPv4 handshakes
  and traffic after backfill, feature-off and failure injection. Both default
  routes remain in every export format.
- Qualified clients on Windows, macOS, Linux, Android and iOS/iPadOS receive
  only their supported exports. Verify actual imports, OS routes, DNS, IPv4
  and IPv6 HTTP, reconnect, roaming, rekey and both traffic directions.
- Part A over an IPv4-only client network; Part B excluded from default and
  incompatible requests, with explicit opt-in required. Verify that an
  IPv4-only network is never described as a working Part B path. Also test
  ISP IPv6 and actual leak behavior with client settings recorded.
- Host, container and peer IPv6 egress, both NAT hops, DAD, PMTUD, firewall
  isolation and actual interface/transport MTU. Configuration lines or a
  zero installer exit code alone are insufficient.
- Faults: no IPv6 route, missing tools, partial rules, broken NAT, interrupted
  backfill, corrupt state, delayed snapshots and offline nodes. IPv4 state
  and leases remain intact; errors and readiness remain truthful.
- Linux shell/Compose and pinned image checks, real PostgreSQL integration,
  API roundtrips and client/server engine tests. A Windows skip or a library
  smoke check does not satisfy these gates.

Keep these tests pending until their actual environment has run them.
Complete source review and documentation do not mean the feature is ready.

## Public documentation and operational data

Public docs, code, fixtures, PRs and releases contain no live server names,
host addresses, provider prefixes, SSH details, account names, private
workstation paths or deployment-specific facts. Use RFC 5737/RFC 3849 examples
and clearly identified project ULA defaults where examples are needed.

Keep credentials, VPN configurations, QR payloads and backups out of logs and
public documentation. Store deployment records privately outside the
repository. Never force-add private planning or operational files.

Related operational documentation:

- [Node connection and rollout](NODE-CONNECT.md).
- [Host setup](AGENT-HOST-SETUP.md).
- [Deployment and updates](DEPLOY-UPDATE.md).
- [Panel and node CLI](CLI.md).

These runbooks describe current operations; update their IPv6 procedures
when implementation is complete, without presenting planned endpoints as
available today.
