# IPv6 on nodes and in the panel — possible implementation

Status: **design draft, not approved for implementation.** Written on
2026-10-10 as a possible implementation. Nothing below is built; nodes and the
panel are IPv4-only today.

Related:

- [PR #140](https://github.com/wyrtensi/amnezia-shared-panel/pull/140), shipped
  in v0.9.64: adds iplist's IPv6 list (minus Russian IPv6 from ipdeny) to the
  built-in `ru_blacklist` feed. On today's IPv4-only nodes those routes are a
  blackhole that forces clients onto IPv4 through the tunnel; with Part A
  below they would carry traffic. Parked at first, then merged after a
  Windows user with ISP IPv6 was found reaching YouTube over IPv6 past the
  tunnel. Measured 2026-10-10: 4,587 routes (3,777 IPv4 + 810 IPv6). Rollback
  in [`DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md).
- The 2026-09-03 decision to keep node addresses IPv4-only, which Part B would
  supersede.

## Goal

Two independent parts, in this order:

- **A. IPv6 inside the tunnel.** A client gets an IPv6 address in the VPN and
  its IPv6 traffic leaves through the node. The IPv6 routes from #140 then
  carry traffic instead of being a blackhole.
- **B. IPv6 node endpoint.** A client reaches the node over IPv6 (IPv6-only or
  CGNAT'd IPv4 networks).

## Hard constraint

**IPv4-only nodes must not change.** Without the opt-in flag a node runs the
same compose files, entrypoint, NAT rules and client configs, byte for byte.
A failure in the IPv6 setup must never take the IPv4 path down with it.

## Decisions taken (operator, 2026-10-10)

| Question | Decision |
|---|---|
| Order | Both parts, A first |
| Addressing in the tunnel | ULA + NAT66, mirroring today's `10.90.0.0/22` + MASQUERADE. A provider's /64 typically cannot be routed to the host by the operator, and per-client public addresses are not wanted |
| Which clients get IPv6 | Phones (AmneziaVPN Android/iOS) and every `.conf` (AmneziaWG apps on any OS). Desktop AmneziaVPN stays IPv4 (see below) |
| How a node opts in | Explicitly at deploy time, in the node `.env`, with a preflight check that the host has working IPv6. The node reports the state to the panel |
| Existing keys on a node that opts in | Get IPv6 server-side immediately; devices pick it up on their next config download. No reissue |
| Protocol | AWG 3.1 only (AGENTS.md: no new awg2-only capabilities; awg2 and legacy v1 stay IPv4) |

## Client compatibility (AmneziaVPN 5.0.3.0, read from source)

| Client | Where the tunnel address comes from | IPv6 from our config |
|---|---|---|
| AmneziaVPN Android | `client_ip`, split on commas (`client/android/.../Wireguard.kt:79`) | yes |
| AmneziaVPN iOS | `client_ip` written verbatim into `Address =` (`client/platforms/ios/WGConfig.swift:146`) | yes |
| AmneziaVPN Windows/macOS/Linux | `client_ip` becomes `deviceIpv4Address`; `deviceIpv6Address` is hardcoded to `fd58:baa6:dead::1` for every client (`client/mozilla/localsocketcontroller.cpp:140-151`) | **no**: a deliberate placeholder so the OS falls back to IPv4. A comma in `client_ip` would likely break IPv4 too |
| AmneziaWG apps (all OS, `.conf`) | `Address =` line, standard wg-quick | yes |

Consequence: a desktop AmneziaVPN key must never get an IPv6 value in
`client_ip`. The panel decides per key from `device_type` (user-declared):
`android` and `ios` get IPv6 in the `vpn://` link; `windows`, `macos`, `linux`
and `unspecified` do not. Every `.conf` export carries both addresses.

Also relevant: amnezia-client#3207 (iOS NetworkExtension pauses the tunnel with
~3,100+ routes). Real IPv6 does not change the route count; #140 does.

## Part A — design

### Node (agent + infra)

- **Flag:** `AWG3_IPV6=on` in the node `.env`. Absent or `off` = today's
  behaviour.
- **Compose:** a separate `infra/node/compose.ipv6.yaml` adds a user-defined
  network with `enable_ipv6: true` (ULA subnet for the container side) and the
  sysctls `net.ipv6.conf.all.forwarding=1`, `net.ipv6.conf.all.disable_ipv6=0`
  to `awg3`. `deploy.sh` adds `-f compose.ipv6.yaml` only when the flag is on.
  Docker publishes and masquerades the container's IPv6 out of the host
  (Docker ≥ 27 with `ip6tables` enabled — to verify per host).
- **Entrypoint (`awg3-entrypoint.sh`):**
  - with the flag, a second line `Address = fd90::1/64` (prefix to be fixed
    in the plan; one fixed ULA per protocol is enough because it is NATed);
  - the exact-match guard on `Address = 10.90.0.1/22` stays; the IPv6 line
    is checked separately, so an IPv4-only conf is untouched;
  - one-time migration: an existing conf gets the IPv6 line appended when the
    flag is first turned on;
  - `ip -6 address add fd90::1/64 dev awg0`, `ip6tables` FORWARD +
    `-t nat POSTROUTING -s fd90::/64 -j MASQUERADE`, mirrored in cleanup;
  - if any IPv6 step fails: log loudly, continue with IPv4 only, and report
    `ipv6: false`.
  - the awg image must ship `ip6tables`.
- **Agent (`amneziaWgServiceBase.ts`, `allocatePeerIp.ts`):**
  - an IPv6 allocator next to the IPv4 one (sequential within the /64);
  - the server-CIDR read keeps matching the IPv4 `Address` line and reads the
    IPv6 line separately;
  - **split the peer `AllowedIPs` line on commas** before counting used
    addresses (today a dual-stack line would be treated as free and
    reallocated);
  - peer `AllowedIPs = 10.90.x.y/32, fd90::n/128`; `userData.allowedIpv6`
    stored next to `allowedIp`;
  - disable/enable keep the `0.0.0.0/32` sentinel and restore both addresses
    from `userData` (today recovery keeps only the first entry);
  - backfill at agent start / on flag-on: every existing peer without
    `allowedIpv6` gets one;
  - `vpn://` payload: `client_ip` stays IPv4; a new field
    `client_ipv6` carries the IPv6 address (ignored by the official client,
    consumed by the panel); `.conf` text gets `Address = v4/32, v6/128`;
  - `GET /server` reports `ipv6: true|false` (optional field, so older agents
    still parse; OpenAPI regenerated).
- **DNS:** keep `1.1.1.1`/`1.0.0.1`; IPv6 resolvers are not required (DNS over
  IPv4 resolves AAAA fine).

### Panel

- Worker persists `capabilities.ipv6` from `GET /server` (jsonb, no
  migration); control-api exposes it on the node DTO; admin nodes page, CLI
  `nodes` and docs show it.
- Export (`getKeyConfig` / `vpnConfig.ts`): for `android`/`ios` keys on a node
  with `ipv6`, rewrite `client_ip` to `v4, v6` from `client_ipv6`; otherwise
  leave it. `.conf` already carries both.
- `applyRouteProfileToVpnLink`: DNS entries get `/128` when they are IPv6
  (today hardcoded `/32`).
- Docs: `docs/AGENT-HOST-SETUP.md` (if #140 is merged first, its "nodes have
  no IPv6, routes are a blackhole" paragraph becomes per-node), `docs/NODE-CONNECT.md`,
  `docs/DEPLOY-UPDATE.md`, `infra/node/README.md`.

### Tests

- Snapshot tests: with the flag off, compose, entrypoint and generated
  configs are identical to today's.
- Allocator: IPv6 pool, exhaustion, dual-stack `AllowedIPs` parsing.
- Agent: create, disable, enable, expire, backfill keep both addresses.
- Panel: export matrix by `device_type` × node `ipv6`; DNS `/128`.
- Live: a node with host IPv6, Android via adb, Windows with the AmneziaWG
  app; then confirm an IPv4-only node is unchanged.

## Part B — design (second stage)

- `SERVER_PUBLIC_HOST` may be an IPv6 literal; the endpoint is written
  `[addr]:port` by a shared helper in the three services; `hostName` stays
  bare.
- `preflight.sh`: drop the `*:*` rejection for valid IPv6 literals, keep
  rejecting junk; fix the "DNS name" advisory glob. `add-node.sh`: bracket SSH
  targets and the tunnel unit for an IPv6 `--host`.
- UDP port published on IPv6 (via the same `compose.ipv6.yaml`).
- Panel: `nodePublicAddressSchema.publicIp` accepts IPv6; `resolvePublicIp`
  returns an IPv6 literal as-is; DNS names stay A-only (no AAAA preference
  change); CLI `nodeAddress.ts` drops the IPv4-only shape check.
- Tests that pin today's IPv4-only behaviour change deliberately:
  `preflight.test.mjs:75-103`, `publicAddress.test.ts:32-55`,
  `contracts.test.ts:389-416`.

## Host prerequisites

A provider allocating an IPv6 prefix is not enough: the host needs a global
IPv6 address and default route configured in the OS (netplan), working
outbound IPv6 (`ping -6`), a Docker version with IPv6 networks and
`ip6tables`, and an `ip6tables` INPUT policy that matches the IPv4 one so
exposure does not change. Preflight checks these before the flag is honoured.

## Open questions for the plan

1. The exact ULA prefix (`fd90::/64` is a placeholder).
2. Docker version and daemon settings on each host that opts in.
3. Whether the backfill runs at agent start or only on an explicit call.
4. Whether `device_type = unspecified` should default to IPv4 (proposed) or
   ask the user.

## Code map (from the 2026-10-10 exploration)

- Agent: `services/node-agent/src/helpers/allocatePeerIp.ts`;
  `services/amneziaWgShared/amneziaWgServiceBase.ts` (server CIDR regex
  ~375, `AllowedIPs` collection ~378-381, peer write ~401, `userData` ~430,
  disable/enable/recovery ~583-615 and ~703-719, payload ~476-529);
  `amneziaWg3/amneziaWg3.service.ts` (template 27-62, endpoint 170-175);
  `services/server/server.service.ts:62-93`, `schemas/server/getServer.schema.ts`.
- Infra: `infra/node/compose.yaml` (awg3 sysctls, ports),
  `infra/node/scripts/awg3-entrypoint.sh` (conf heredoc, Address guard,
  `ip -4 address add`, iptables, cleanup), `preflight.sh:69-96`,
  `scripts/add-node.sh`.
- Panel: `apps/worker/src/nodeAgent.ts:64-80`,
  `apps/worker/src/postgresRepository.ts:1140-1190`,
  `apps/worker/src/publicAddress.ts`, `packages/contracts/src/index.ts:331-365`,
  `apps/control-api/src/vpnConfig.ts:163-176`,
  `apps/control-api/src/postgresRepository.ts:166-179`,
  `apps/cli/src/nodeAddress.ts`.
