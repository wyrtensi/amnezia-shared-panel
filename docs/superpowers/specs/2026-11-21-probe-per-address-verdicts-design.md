# Reachability probe: every address is its own server

Status: approved in conversation 2026-11-21. Builds on
`docs/REACHABILITY-PROBE.md`, `docs/AWG-GENERATOR.md` and
`2026-11-21-probe-recheck-on-config-change-design.md`.

## Intent

A node can have several public IPv4 addresses, and users treat each address as
a separate server: a key is issued for one address, and its config is built
from that address's generator profile and that address's route (direct, or
through the node's bridge when the bridge is active for that address).

The probe already measures each address on its route, but it also keeps a
separate **node check** built from the address written in the probe's own
service key when it was issued. That check drives the node verdict, the node
alerts, the widget row of most nodes and some key cards. After a node's
primary address changes it measures the old address; after a change to the
primary address's profile or path it measures the same address a second time.
It also assumes one node is one address.

## Goals

- The probe checks only addresses. Each enabled address with checks on is
  measured once per run on its current route, with the config its users get:
  built from that address's effective configuration profile (its own
  generator settings, or the node's when it inherits them), and rendered for
  that address directly, or for the node's bridge when the bridge is active
  for that address. Bridged addresses share a measurement only when those
  built configs are identical. The address stored in the service key is never
  used for a node that has registered addresses.
- The node verdict is a summary of its addresses: available when at least one
  address answers, unavailable when every measured address failed, unknown
  otherwise.
- Alerts are per address, for direct and bridged addresses alike. Addresses of
  one node that open (or close) an incident in the same run share one
  message. A run that fails everywhere and looks like a probe problem still
  sends one combined message instead, and one combined recovery.
- The widget has one row per address for every node with registered
  addresses, bridged nodes included.
- A key card shows the verdict of the address its key uses.

## Non-goals

- AWG 2.0: it has no per-address configs. Its check keeps using the service
  key as issued (AWG 2 users' configs hold that address too).
- Nodes without registered addresses (no `node_vpn_endpoints` row, e.g. a
  hostname-only node) and AWG 3 service keys that are not AWG 3.1 artifacts:
  they keep today's node check from the service key, node alerts and a node
  widget row.
- Bridge alerts (the bridge as a whole, `bridge_reachability_state`) keep their
  meaning; they read the bridged address measurements instead of a node check.
- No change to how the probe service measures, to the probe API or image.

## Behaviour

### Targets (worker `loadTargets`)

For an AWG 3 service key that is an AWG 3.1 artifact on a node with
registered addresses:

- The candidate addresses are those `enabled` with `reachabilityEnabled`.
  None: one AWG 3 target with `unavailableReason` "no address with checks on"
  (unknown, never an alert).
- An address's route: through the bridge when the node has an active route and
  the address's `bridgeMode` is `bridge`, or `inherit` while the portal default
  `useBridge` is on; otherwise direct. This is the rule user exports use
  (`resolveKeyBridgeInfo` with `endpointBridgeMode`).
- A direct address gets its own target: the service config projected with that
  address's effective generator profile, rendered with the address as host and
  the service key's port. Target id
  `<node>:awg3:r<rev>:direct:<sha256(endpoint id, endpoint revision, address, port, projection fingerprint)>`
  (the existing `:direct:` identity).
- Bridged addresses with the same projected config share one target rendered
  with the bridge's public IPv4 and the route's UDP port; each group is its own
  target, id `<node>:awg3:r<rev>:bridge:<sha256(fingerprint, bridge host and port, [endpoint id, revision]...)>`.
  Its outcome is written to every address in the group.
- A bridged address that cannot be measured (probe without
  `bridge-measurement`, bridge host not renderable) gets an unknown outcome
  with today's reasons, never an alert.
- Opt-in direct diagnostics of bridged addresses (`probeDirectWhenBridged`)
  stay as they are and never affect a verdict.
- There is no node target for AWG 3 any more on such a node: no
  `<node>:awg3:r<rev>` or `:c<fingerprint>` id, no `reusesNodeTarget`,
  `mayReuseLegacy` or `usesLegacyIdentity`. Over the run limit
  (`PROBE_RUN_MAX_TARGETS`), address targets measured longest ago go first,
  then diagnostics.

AWG 2, legacy nodes and non-3.1 artifacts build their node target as today.

### Verdicts (worker `ingestRun`)

- Each address target's outcome is classified as today (`classifyTarget`,
  `obsolete` for a slot reported under another revision) and becomes the
  address verdict, stored in `node_vpn_endpoints.probe_*`.
- The node verdict is `nodeStatus` over its address outcomes plus, for a node
  without an active bridge route, its AWG 2 outcome (the any-protocol rule of a
  direct node). A bridged node is not judged on AWG 2, as today.
- `node_reachability_results` keeps one AWG 3 row per node, the node's path
  evidence: on a node with an active bridge route, the best outcome among its
  bridged address groups, and unknown ("no address uses the bridge") when no
  address goes through it or the probe cannot measure it; on a direct node,
  the best address outcome. Best is ok, then failed, then unknown, ties by
  ordinal; levels, egress and the failing-since rule as today. A direct
  address therefore never vouches for a bridge: route verification
  (`awg_path`), the bridge overview counters and the TLS rotation gate keep
  reading this row and see bridge evidence only. (Builder check: an active
  route that no address uses read direct evidence before and reads unknown
  now, which blocks the rotation gate for it; my call, the safe side.)
- `node_reachability_state` and history keep the node summary. On a node whose
  AWG 3 verdict comes from addresses it never opens an incident. An incident it
  already has open (from before this change) is closed with one "available
  again" message when the summary turns `ok`, and only then.

### Address incidents and alerts

- Each address with checks on keeps its own incident in
  `node_vpn_endpoints` (`probe_consecutive_failures`, `probe_failing_since`,
  `probe_alerted_at`, and a new `probe_alert_kind`: `node` or `mass`, reusing
  `reachability_alert_kind`). The rules are today's node rules: opens after
  `failThreshold` consecutive failed runs, one recovery message, `error` keeps
  everything as it was.
- Down message for one address:
  `Адрес <name> (<address>) недоступен из <label>`, the levels line, `с <time>`;
  a bridged address adds `через мост <bridge> (<bridge ip>:<port>)` after the
  address, as node alerts do today. Several addresses of one node opening in
  the same run share one message that names the node and lists them. The same
  for recovery (`снова доступен` / `снова доступны`).
- Mass failure: computed over every measured unit of the run (address targets
  and legacy node targets) with today's rule (control passed, at least two
  attempted, all failed with no handshake anywhere or only the egress check
  failing everywhere, and no healthy direct address). In a mass run no
  per-address or node message is sent; the incidents that open are marked
  `mass` and one combined message lists them. When at least two `mass`
  incidents recover in one run, one combined recovery is sent for them.
- These rules are computed in the pure `ingestRun` from the previous address
  states, so they are unit-testable; the repository only reads and writes the
  rows. The old per-address path in the repository (`advanceBridgeIncident` for
  endpoints, `trackIncident`, `reusesNodeTarget` dedup) goes away.
- An open address incident survives a change to what is measured (generator
  profile, bridge mode, route assignment, a new primary address): the streak
  restarts and the incident stays open, so it ends with one recovery message,
  as node incidents do today. The control-api address update stops clearing
  `probe_alerted_at` / `probe_alert_kind` for those changes. Disabling an
  address or turning its checks off (or the node's) closes its incident
  without a message: the administrator took it out of service. (Builder
  check; my call.)
- Upgrade: no incident state is migrated. A node that is down at the upgrade
  can send one duplicate message (its addresses' own down or recovery next to
  the node's); production had no open incident when this was written.
  (Builder check; my call.)

### Bridge verdict

The bridge's external AWG evidence is the outcomes of the bridged address
groups on that bridge (instead of the bridged node checks). Bridge host checks
and bridge alerts are unchanged.

### Widget

One row per enabled address with checks on for every node with registered
addresses (bridged nodes too): the address name, its levels, status,
failing-since, devices online and the last person handshake on that address
(existing per-address counts). Legacy nodes keep their node row. "N из M"
counts rows. Row order and the size limit are unchanged.

### User cabinet and admin

- A key card for AWG 3 reads the verdict of the path its key actually takes
  on its address (`endpointId`, or the primary address when it has none):
  - the key's effective route (`resolveKeyBridgeInfo`, per-key mode and the
    owner's policy included) is the route the probe measured for that
    address: the address verdict;
  - the key goes through the active bridge but the address was measured
    direct: the node's bridge path row above (unknown when there is none);
  - the key goes direct but the address was measured through the bridge, or
    the key is pinned to a route that is no longer active: unknown, as today.
  AWG 2 reads the node's AWG 2 result as today. (Builder check; my call: it
  mirrors today's rule with the address in place of the node.)
- Server badges already use address verdicts; the node badge is the summary.
- Admin node cards and `probe-results` show the summary and the per-address
  rows as today.

## Approaches considered

1. **Address-only targets, node verdict derived** (chosen): one measurement per
   address, nothing read from the service key's stored address, verdicts and
   alerts per address.
2. Keep the node check but point it at the primary address's current route:
   still one node, one address; rejected by the administrator ("для каждого
   айпи ноды, не смотреть что одна нода — один адрес").
3. Keep both and suppress duplicates: keeps two identities for one
   measurement, which is the source of the old-address and double-check bugs.

## Constraints

- The ingest's lock order (probe row, node rows, reachability rows) and
  revision fencing stay as they are.
- No names, IPs or hostnames of real installations in code, tests or docs.
  Comments in English. Commits to `main`, author wyrtensi, no Co-Authored-By.

## Left to the builder

The exact multi-address message wording, helper names and how the pure
`ingestRun` input carries previous address states.
