# Node Multi-Exit Routing (Level B), `amnezia-egressd`, and Fleet Status UI — Implementation Plan

**Scope:** End-to-end backend, Go host daemon (`amnezia-egressd`), `node-agent`, `worker`, `reachability-probe`, `cli`, OS/lifecycle/backup scripts, documentation, and web UI overhaul (excluding WARP in v1, while retaining clean extensibility for future tunnel-based exits).

---

## 1. Goals & Core Product Rules

1. **Level B Multi-Exit Routing on a Single Node (`Entry IP != Exit IP`, N-to-M capable):**
   - Separate client-facing **Entry IPs** (or relay **Bridges**) from internet-facing **Exit IPs** on the same VPS without running multiple `amnezia-awg3` containers.
   - Support **1 shared Exit IP** per node, **1 dedicated Exit IP** per Entry IP, **multiple independent Entry IPs each exiting via its own IP**, or **2+ distinct Exit IPs** per Entry IP on the same host.
   - **Hot-swappable Exit IP & Live Key Reassignment:**
     - Replacing a blocked or degraded Exit IP updates host `SNAT` + flushes `conntrack` immediately with **zero client config re-issuance**.
     - Reassigning an active key between two exits on the same Entry IP or Bridge (`v1 -> v2`) switches its exit live on the host without re-importing the key (unless Entry IP or DNS changed).
   - **Strict Fail-Closed Guarantee:** if an Exit IP disappears from the host interface or is disabled, inner client traffic assigned to that exit is dropped in `forward` — it never falls back to `MASQUERADE` on another Entry IP.

2. **User-Facing Server Presentation & Deterministic `v1 / v2 / v3` Naming Rule:**
   - Regular users see each selectable exit variant as a standalone server in both `EmployeeDashboard` (`ServerStatusList` and expanded server details) and `CreateKeyWizard` (one flat server picker — no nested `Node -> Endpoint` dropdown, no internal terms such as `SNAT`, `Egress`, or `Endpoint`).
   - **Deterministic Naming Formula** (grouped per `(node_id, entry_address)`):
     - Every Entry IP on a node has a base `entryName` (for example, `"Server A"`).
     - **1 variant on that Entry IP** (self-exit or 1 assigned Exit IP): display name is `customName ?? entryName` (for example, `"Server A"` — no `v1` suffix).
     - **2+ variants on that Entry IP** (ordered by `variantOrdinal` `1, 2, 3, ...`): display name is `customName ?? "${entryName} v${variantOrdinal}"` (for example, `"Server A v1"`, `"Server A v2"`, `"Server A v3"`).
     - Renaming `entryName` updates all variants on that IP that lack an explicit `customName`; removing variants back down to 1 drops the `v1` suffix automatically.

3. **Full Bridge Compatibility (Toggleable Anytime from Node Card or Routes):**
   - Active node bridges (`vpn_bridge_routes` via `frps`/`frpc`) and per-endpoint/per-key `bridgeMode` (`inherit` | `direct` | `bridge` / `route`) remain fully compatible with multi-exit routing:
     - Whether a peer enters via **Bridge** (`bridge_ip:410xx -> frpc -> 127.0.0.1:51890`) or **Direct** (`entry_ip:51890`), `amnezia-awg3` decrypts packets with the peer's inner `10.90.x.y/32` address, and `amnezia-egressd` routes and `SNAT`s them through that peer's assigned **Exit IP**.
     - Host `frpc` (and any host SSH relay) runs in the host network namespace (outside `br-awg-egress`), so bridge tunnels are never touched by client `SNAT`.
     - Toggling a node's bridge OFF or ON from the Node Card or `/admin/policy#node-routes` changes only the outer entry address while preserving all Exit IPs, `v1/v2` variant names, DNS settings, and peer exit mappings.

4. **Per-Exit DNS & Client `AmneziaDNS` (`172.29.172.254:53`) Compatibility (`0 MB RAM`):**
   - No `amnezia-dns` (`Unbound`) container is deployed.
   - Each configured Exit IP defines `dnsPrimary` (default `1.1.1.1`), `dnsSecondary` (default `1.0.0.1`), `amneziaDnsDnat` (default `true`), and optional `enforceDnsDnat` (default `false`).
   - Exported `.vpn` / `.conf` configs carry the exit's `dns1`/`dns2` (plus `dns1/32, dns2/32` in `AllowedIPs` for split-tunnel profiles).
   - In `nftables` `prerouting` (scoped strictly to `iifname "br-awg-egress"`, running before the RFC1918 drop in `forward`), UDP/TCP queries from `10.90.0.0/22` to `172.29.172.254:53` are transparently `DNAT`ed to that peer's exit `dnsPrimary:53` and `SNAT`ed via that peer's `Exit IP`.

---

## 2. Host OS Safety & Kernel Ruleset

Designed for **Ubuntu 22.04+ / Linux 5.15+ / `nftables` 1.0.2+**, varied NIC names (`ens3`, `enp1s0`, `eth0`), `/23`–`/32` subnets, dual-stack IPv6 hosts, `ufw` / `netfilter-persistent` / `fail2ban` (`f2b-table`), co-tenant Docker networks, and constrained 512 MiB–1 GiB VPS hosts.

### 2.1 `nftables` Ruleset Template

```nft
table ip amnezia_egress {
  map peer_exit_v4 { type ipv4_addr : ipv4_addr; }
  map peer_dns_v4 { type ipv4_addr : ipv4_addr; }
  map peer_force_dns_v4 { type ipv4_addr : ipv4_addr; }
  map peer_fwmark { type ipv4_addr : mark; }
  set allowed_active_peers { type ipv4_addr; }

  chain mangle_prerouting {
    type filter hook prerouting priority -160; policy accept;
    # Inbound :51890/udp to secondary Entry IPs: set ONLY ct mark (preserve Docker DNAT routing to br-awg-egress)
    # Outbound :51890/udp reply from amnezia-awg3: restore ct mark -> meta mark so strict-uRPF hosts return via secondary IP gateway
    iifname "br-awg-egress" udp sport 51890 ct mark & 0x0000ff00 == 0x0000ae00 meta mark set ct mark
    # Forwarded inner client packets needing custom Exit gateway table 200..219
    iifname "br-awg-egress" ip saddr 10.90.0.0/22 meta mark set ip saddr map @peer_fwmark
  }

  chain prerouting {
    type nat hook prerouting priority -110; policy accept;
    # AmneziaDNS (172.29.172.254:53) zero-RAM compatibility — runs before RFC1918 drop in forward
    iifname "br-awg-egress" ip saddr 10.90.0.0/22 ip daddr 172.29.172.254 meta l4proto { udp, tcp } th dport 53 dnat ip to ip saddr map @peer_dns_v4 : 53
    iifname "br-awg-egress" ip saddr 10.90.0.0/22 meta l4proto { udp, tcp } th dport 53 dnat ip to ip saddr map @peer_force_dns_v4 : 53
  }

  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "br-awg-egress" tcp dport 25 counter drop
    iifname "br-awg-egress" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8, 100.64.0.0/10 } counter drop
    # Positive allow + unconditional drop (deterministic even when @allowed_active_peers is empty on kernel 5.15)
    iifname "br-awg-egress" ip saddr @allowed_active_peers accept
    iifname "br-awg-egress" ip saddr 10.90.0.0/22 counter drop
  }

  chain postrouting {
    type nat hook postrouting priority 90; policy accept;
    iifname "br-awg-egress" ip saddr 10.90.0.0/22 oifname != "br-awg-egress" snat ip to ip saddr map @peer_exit_v4
  }
}

table ip6 amnezia_egress_v6 {
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "br-awg-egress" counter reject with icmpv6 type admin-prohibited
  }
}
```

### 2.2 OS & Resource Safety Invariants

1. **Zero `INPUT` / Host-Process Interference:** `amnezia-egressd` creates no `input` chains, never modifies the `main` default route, `netplan`, `ufw`, or OS `ip rule` (`from <ip> lookup 100`), and matches client routing strictly via `fwmark 0xae00/0xff00` on `iifname "br-awg-egress"`. Host SSH (`:22`), HTTPS (`:443`), and `frpc` / SSH relays stay unaffected even if an admin configures an unreachable exit gateway IP.
2. **`suppress_prefixlength 0` Local-Route Shield:** `ip rule add priority 19900 fwmark 0xae00/0xff00 lookup main suppress_prefixlength 0` ensures local/Docker/tunnel subnets in `main` always take precedence over custom gateway tables `200..219`.
3. **Auto-Discovery of OS `table 100` Gateways + `onlink`:** Reads OS `ip rule` (`from <ip> lookup <table_id>`) via native netlink (no brittle text scraping) and sets `onlink` on custom gateway default routes (supporting `/32` routed IPs and `/23`–`/24` cloud subnets).
4. **Go Memory Ceiling (`GOMEMLIMIT=24MiB` + `MemoryMax=32M`):** Bounds heap growth on small 512 MiB–1 GiB VPS hosts.
5. **Lightweight Mode-Switch & Rollback Disk Gate (`256 MiB`):** `switch-egress-mode.sh` and `rollback.sh` pass `PREFLIGHT_DISK_MIN_KB=262144` because local state swaps pull zero container images, while `deploy.sh` keeps the `2 GiB` default fresh-pull floor.
6. **Zero-Blackout Transition & Implicit Self-Exit:** Panel/agent pre-warms `PUT /v1/state` and validates `nft --check -f -` before switching mode; endpoints with `egress_ip_id = NULL` automatically map to their own `endpoint.address` so multi-IP nodes without dedicated exits still exit symmetrically per Entry IP.
7. **Dual-Stack IPv6 Leak Prevention:** `amnezia_egress_v6` (`icmpv6 type admin-prohibited`) plus `ipv6RejectStub` prevent IPv6 leaks around IPv4 `SNAT`.
8. **Zero-Drop Daemon Restarts:** `SIGTERM` leaves `amnezia_egress` and `proto 99` routes intact in the kernel across agent upgrades; teardown runs only on explicit `amnezia-egressd teardown`.

---

## 3. Key Design Decisions & Edge Cases Addressed

| # | Area | Edge Case | Solution |
|---|---|---|---|
| 1 | Worker | `syncResolvedPrimaryEndpoint` updating only `ordinal = 1` orphans `v2/v3` variants. | Atomic **Entry Group** update by `(node_id, address)`. |
| 2 | DB FK | `ON DELETE RESTRICT` on `egress_ip_id` breaks `DELETE FROM nodes` cascade order. | SQL `ON DELETE SET NULL` + API-enforced `RESTRICT` / reassignment. |
| 3 | User UI | Detailed node view groups by node and shares one set of service check chips. | Flat `ServerAddressList` per variant with per-exit `ServiceCheckChips` + shared `per_node` quota note. |
| 4 | Admin UI | Selectors showing only `publicAddress` make `v1`/`v2` indistinguishable. | Format `Entry -> Exit` (`formatEndpointRoute`) across policy, users, node-routes, and audit views. |
| 5 | DB Backfill | Legacy `vpn_keys` with `endpoint_id IS NULL`. | Backfill to `ordinal = 1` in Migration `0072` + fallback in `node.sync-egress`. |
| 6 | Key Move | Moving active keys between `v1` and `v2`, or removing a variant with keys. | Live `PATCH /api/admin/keys/:id` (`endpointId`) + `reassignToEndpointId` on variant delete. |
| 7 | Probe | Probe reporting `ok: true` when exit IP does not match configured exit. | Worker-side `observedEgressIp === expectedEgressIp` check flags unswitched/mismatched egress. |
| 8 | Probe | Bridged nodes collapse all endpoints into one probe run. | Partition bridged probe targets by `(activeBridgeRouteId, effectiveEgressIp)`. |
| 9 | Admin UX | Inline Exit + Variant forms bloat node cards. | Compact topology summary on `NodeCard` + `NodeTopologyDialog` (`sm:max-w-2xl`). |
| 10 | Reconcile | Reconcile action did not resync host `nftables`. | `reconcile` enqueues both AWG peer sync and `node.sync-egress`. |
| 11 | Docker Build | `preflight.sh` rejects unpinned image tags (`latest`). | Pin Go builder stage by `@sha256` digest; pass `egressd=services/egress-daemon` build context. |
| 12 | Compose | Maintaining a separate override compose file breaks `deploy.sh` / `agent-update.sh`. | Single `infra/node/compose.yaml` (`awg3` on `br-awg-egress`, `node-agent` on `default`). |
| 13 | Cutover | Recreating `awg3` when already attached to `br-awg-egress` drops tunnels. | Live `MASQUERADE` rule toggle (`0ms` drop) whenever `awg3` is already on `br-awg-egress`. |
| 14 | `nftables` | `icmpx` fails in `table ip6` on `nftables`; empty set behavior on kernel 5.15. | Use `reject with icmpv6 type admin-prohibited` and positive `@allowed_active_peers accept` + `drop`. |
| 15 | Backup/Node | Node backup/rollback scripts hardcoded `amnezia-awg2`, failing on AWG3-only nodes. | Support AWG3-only, AWG2-only, and dual nodes + package secret-free `egress/state.json` & `egress/meta.env`. |
| 16 | DB Drift | Panel DB rollback could disagree with a node running in `routed` mode. | `PUT /v1/state` never switches mode; `mode_drift` flags `conflict` without blackholing tunnels until explicit `adopt` or mode switch. |
| 17 | Probe Keys | One service key per node cannot test 2+ exits on a `routed` host. | Provision one `awg3` service key per unique `(node_id, effective_egress_ip)`. |
| 18 | VPN DNS | `.vpn` and `.conf` exports did not carry per-exit `dnsPrimary`/`dnsSecondary`. | `applyDnsToVpnLink(vpnLink, dnsPrimary, dnsSecondary)` runs in `composeExport` before `applyRouteProfileToVpnLink`. |
| 19 | Locking | PostgreSQL forbids `FOR UPDATE` on a `LEFT JOIN` query in `renameOwnKey`. | Lock `vpn_keys` row with `FOR UPDATE` first, then read node/endpoint display names in the same transaction. |
| 20 | Telegram | `1024 B` status widget cap truncates healthy multi-exit variants prematurely. | Keep `failed`/`error` rows expanded; collapse healthy sibling variants on the same entry (`Server A (×2)`) first. |
| 21 | Dev/CI | Dev hosts on Windows/macOS lack `egressd.sock`; CI needed Go + infra coverage. | Degrade gracefully in `node-agent` when socket is absent; add Go + `infra` + `shellcheck` verification. |

---

## 4. Database Schema & Migration (`0072_node_egress_and_endpoint_variants.sql`)

1. **`node_egress_ips` (Physical Exit IPv4s per Node):**
   - `id` (`uuid PK`), `node_id` (`uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE`)
   - `ipv4` (`text NOT NULL`), `label` (`varchar(80)`), `interface_name` (`varchar(32)`), `gateway_ipv4` (`text`), `routing_table_id` (`integer`, `CHECK (200..219)`, `UNIQUE (node_id, routing_table_id)`)
   - `dns_primary` (`text NOT NULL DEFAULT '1.1.1.1'`), `dns_secondary` (`text NOT NULL DEFAULT '1.0.0.1'`), `amnezia_dns_dnat` (`boolean NOT NULL DEFAULT true`), `enforce_dns_dnat` (`boolean NOT NULL DEFAULT false`)
   - `allow_as_entry` (`boolean NOT NULL DEFAULT false`), `enabled` (`boolean NOT NULL DEFAULT true`)
   - Telemetry: `host_state`, `host_detail`, `observed_subnet_cidr`, `detected_gateway_ipv4`, `tx_bytes`, `tx_packets`, `host_observed_at`
   - `UNIQUE (node_id, ipv4)`

2. **`nodes` Extensions:**
   - `egress_mode` (`'masquerade' | 'routed'`), `egress_mode_state` (`'idle' | 'switching' | 'failed'`), `egress_mode_message`, `egress_mode_at`
   - `egress_daemon_version`, `egress_daemon_state` (`'unavailable' | 'masquerade_ready' | 'routed_active' | 'conflict' | 'degraded'`), `egress_daemon_detail`
   - `egress_block_smtp`, `egress_isolate_private`, `egress_default_ip_id` (`REFERENCES node_egress_ips(id) ON DELETE SET NULL`), `host_network_report` (`jsonb`), `egress_observed_at`

3. **`node_vpn_endpoints` Evolution (Entry Group + Exit Variant):**
   - Drop `node_vpn_endpoints_address_unique` (`UNIQUE (node_id, address)`).
   - Add `entry_name`, `custom_name`, `variant_ordinal`, `egress_ip_id` (`REFERENCES node_egress_ips(id) ON DELETE SET NULL`), `probe_observed_egress_ip`, `probe_egress_match`.
   - `UNIQUE NULLS NOT DISTINCT (node_id, address, egress_ip_id)` and `UNIQUE (node_id, address, variant_ordinal)`.

4. **`vpn_keys` Extensions & Backfill:**
   - Add `tunnel_ipv4` (`text`) and backfill `endpoint_id` for existing `awg3` keys where `endpoint_id IS NULL` to the node's `ordinal = 1` endpoint.

5. **`node_egress_service_check_results`:**
   - `PRIMARY KEY (egress_ip_id, check_id)` storing per-exit HTTP check status, latency, detail, `final_url`, `checked_at`, and `failing_since`.

---

## 5. Backup, Rollback & Disaster Recovery

1. **Four Backup Layers:**
   - **Panel DB (`scripts/backup-db.sh`, `scripts/restore-db.sh`):** Full Postgres dump (`BACKUP_KEEP_COUNT=14`); restore stops `control-api` & `worker` cleanly across `compose.yaml` + `compose.override.yaml`, runs `psql -v ON_ERROR_STOP=1`, restarts services, and prints `node-reconcile` follow-up.
   - **Host Node State (`infra/node/scripts/backup.sh`, `rollback.sh`, `deploy.sh`, `common.sh`, `preflight.sh`):** Supports AWG3-only, AWG2-only, and dual nodes (`BACKUP_KEEP_COUNT=15`); packages secret-free `egress/state.json` and `egress/meta.env` under strict allowlist validation in `validate_backup_archive()` with `PREFLIGHT_DISK_MIN_KB=262144` during rollback and atomic revert on health-gate failure.
   - **Pre-Switch & Update Snapshots (`switch-egress-mode.sh`, `agent-update.sh`):** Saves `backups/egress-state-<ts>.json` (`chmod 0600`) and snapshots `/usr/local/bin/amnezia-egressd` before upgrade with automatic rollback on failure.
   - **Live Node-Agent API (`GET|POST /server/backup`):** Includes optional `egress` state snapshot (`?skipEgress=1` opt-out, non-fatal `missing_ip` handling, `conntrack` flush, and `egressReconcileRequired` hint on legacy archives).
   - Automated backups intentionally omit `secrets/`, `.env`, and the panel encryption keyring so private credentials stay separated in the operator's vault.

2. **Post-DB-Restore `mode_drift` Protection:**
   - `PUT /v1/state` never toggles host `masquerade <-> routed` mode; only `POST /v1/switch-mode` does.
   - On `report.observedMode !== db.egressMode`, the worker raises `mode_drift` (`conflict`) while keeping routed peers synced until resolved via `POST /api/admin/nodes/:id/egress-mode/adopt` or explicit mode switch.

---

## 6. Phased Milestones & Verification Status

1. **Milestone A — Host Daemon & Node Scripts (Complete):**
   - Go daemon `services/egress-daemon`, pinned builder in `services/node-agent/Dockerfile`, single `infra/node/compose.yaml`, `awg3-entrypoint.sh`, `install-egressd.sh`, `install-host-services.sh`, `switch-egress-mode.sh`, `agent-update.sh`, `backup.sh` / `rollback.sh` / `deploy.sh` / `preflight.sh` / `common.sh`, `scripts/add-node.sh`, `services/node-agent` egress & backup routes + OpenAPI spec, and `.github/workflows/ci.yml`.
2. **Milestone B — DB, Contracts, `@amnezia/vpn-config`, Control API & CLI (Complete):**
   - Migration `0072`, `@amnezia/contracts`, `@amnezia/vpn-config` `applyDnsToVpnLink`, `@amnezia/control-api` (`endpointNaming.ts`, egress IP & variant CRUD/hot-swap/verify/adopt, live key `endpointId` reassignment, `renameOwnKey` lock fix, per-exit `listNodes` service checks), `@amnezia/cli`, `scripts/backup-db.sh` / `scripts/restore-db.sh`, and synced operational docs (`docs/OPERATIONS.md`, `docs/DEPLOY-UPDATE.md`, `infra/node/README.md`, `infra/node/CHECKLIST.md`).
3. **Milestone C — Worker, Peer Lifecycle, Per-Exit Checks & Probe (Complete):**
   - Peer `tunnel_ipv4` lifecycle in `apps/worker/src/processor.ts`, `node.sync-egress` (`mode_drift` guard), Entry-Group `syncResolvedPrimaryEndpoint`, per-exit service keys & probes, worker-side `expectedEgressIp` verification, `reachabilityWidget.ts` 1024 B smart collapsing, and `reachability.ts` alert formatting.
4. **Milestone D — Web UI Overhaul (Complete):**
   - Flat server selector (`CreateKeyWizard`), per-variant `ServiceCheckChips` (`ServerAddressList` / `EmployeeDashboard`), grouped `QuotaRequestDialog`, admin `KeyEgressBadge` & live reassignment dialog, `OverviewStatusStrip` + `OverviewAttentionShelf` + `OverviewNodeCard` v2, 5-pill diagnostic header, `NodeTopologyDialog`, per-exit reachability/service-check cards, full `ru`/`en` parity.

### Verification Summary (on `feat/node-egress-level-b`)
- Monorepo `typecheck`, `lint`, and `build` passed across all packages.
- PostgreSQL 16 (`0072`) + serialized integration suites passed: `@amnezia/contracts` (355/355), `@amnezia/vpn-config` (59/59), `@amnezia/db` (89/89), `@amnezia/worker` (726/726 across all 37 unit + DB integration suites), `@amnezia/web` (658/658 across 57 suites), `@amnezia/control-api` (`postgresRepository.integration.test.ts` 238/238; 34/35 suites / 809/810 tests with 1 Windows `chmod(0o555)` exception), `@amnezia/cli` (417/419 with 2 Windows `0o600` exceptions).
- Standalone services & Linux checks passed: `services/node-agent` (273 passed + build + `openapi:check`), `services/reachability-probe` (127/127 + build on Linux), `services/bridge-agent` (109/109 + build on Linux), `services/egress-daemon` (`go vet`, `go test -race`, `linux/amd64` build), Debian `infra/{node,bridge,prod}/tests/*.mjs` (292/292), `shellcheck -s sh -x` on `infra/node/scripts/*`.
- Local browser smoke check across `/`, `/admin`, `/admin/nodes`, and `/admin/users` passed with 0 console/page errors and 0 HTTP 4xx/5xx responses.

### Remaining Before Merge / Production Rollout
- Live Linux test VM / staging host verification of kernel `nftables` + policy routing cutover (`masquerade <-> routed`), hot-swap `SNAT` + `conntrack` flush, and `rollback.sh`.
- Full `ubuntu-latest` GitHub Actions CI run on this PR.

---

## 7. Follow-up UX, Discovery & Topology Map Enhancements (Completed on Feature Branch)

All four operator-requested usability enhancements have been implemented and verified in this PR alongside the core Level B engine:

1. **Clearer & Simpler Exit Assignment UX (Web UI):**
   - Upgraded `NodeTopologyDialog` (`apps/web/components/admin/node-topology-dialog.tsx`) with per-exit variant usage lists (`usedByVariants` / `unusedExit`), 1-click default exit selection (`makeDefault`), quick-pick Entry/Host IP chips in variant creation, visual `Entry -> Exit` flow badges with health dots, and an inline `<Select>` on each server variant row to reassign its Exit IP immediately.
2. **One-Click & CLI Onboarding of Auto-Discovered Server IPs (Web UI + `@amnezia/cli`):**
   - Added pure classification helpers (`apps/web/lib/host-ip-discovery.ts` and `apps/cli/src/hostIps.ts`) over `host_network_report.ipv4Addresses` categorizing every host IPv4 as `both`, `entry`, `exit`, or `unassigned`.
   - **Web UI:** `NodeTopologyDialog` lists all discovered server IPv4s with CIDR, NIC, auto-detected gateway/table, role badge, and 1-click `+ Exit`, `+ Entry`, and `+ Entry + Exit` actions pre-filling NIC/gateway.
   - **CLI (`@amnezia/cli`):** Added `node-host-ips` (`--unassigned`, `--json`) and `node-ip-attach` (`--ip` / `--all-unassigned`, `--role=entry|exit|both`, `--dry-run`, auto-filled NIC/gateway, documented in `docs/CLI.md`).
3. **Compact Yet Richer Admin Overview (`/admin`) with More Statuses:**
   - Expanded `OverviewStatusStrip` (`apps/web/components/admin/overview-status-strip.tsx`) with `exitsOk`, `peersOnline`, `preAlert`, and deduplicated node + per-exit `serviceFailures`, plus clickable `<Link>` attention rows.
   - Updated `OverviewNodeCard` & KPI layout in `apps/web/app/admin/page.tsx` with bridge badges, online peer counts, egress health/warning indicators, two-line legible `Entry -> Exit` rows (fixing `1280px`–`1440px` truncations), and wrapping KPI subtitles.
4. **Interactive Visual Fleet Topology Map (`FleetTopologyMap`):**
   - Implemented `apps/web/components/admin/fleet-topology-map.tsx` and mounted it on `/admin` Overview, rendering an interactive **Panel -> Bridges -> VPN Nodes -> Entry Variants -> Physical Exit IPs** flow with health-colored SVG bezier links, click-to-highlight end-to-end path inspection, and direct links to `/admin/nodes`.

