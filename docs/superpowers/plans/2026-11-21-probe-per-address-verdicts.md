# Probe per-address verdicts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The probe measures only addresses, each on its own route with its own configuration profile; node verdicts, alerts, widget rows and key cards follow the addresses.

**Architecture:** `loadTargets` emits one AWG 3 target per direct address and one per bridged config group, carrying the addresses it judges; no AWG 3 node target remains on nodes with registered addresses. The pure `ingestRun` turns target outcomes into address verdicts and address incidents (from previous address states), a node summary, a node path row and grouped messages. The repository reads and writes rows only. Legacy nodes (no address rows, non-3.1 artifacts) and AWG 2 keep the node target.

**Tech Stack:** TypeScript, drizzle + PostgreSQL 16, vitest, Next.js.

**Spec:** `docs/superpowers/specs/2026-11-21-probe-per-address-verdicts-design.md`

## Global Constraints

- Address route = bridge when the node has an active route and the address's `bridgeMode` is `bridge`, or `inherit` with portal `useBridge` on; otherwise direct.
- Address config = service config projected with the address's effective generator settings (`endpoint.awgGenerator ?? node.awgGenerator`), rendered for the address (direct) or the bridge host/port (bridged). Bridged addresses share a target only when the projected configs are identical.
- Node verdict = `nodeStatus` over address outcomes plus the AWG 2 outcome when the node has no active route.
- Incident rules = today's node rules (`failThreshold`, one down, one up, `error` changes nothing, mass marks `mass`).
- Lock order unchanged: probe row, node rows (`FOR SHARE`), then reachability rows.
- No real names, IPs or hostnames in code, tests or docs; English comments; commits to `main` by wyrtensi, no Co-Authored-By.

## Review Focus

1. A node whose primary address changed: no target goes to the service key's stored host; the node verdict, widget and alerts follow the new address.
2. A bridged address group whose result is missing, obsolete or for another profile never writes a verdict to addresses outside its group or to a later revision.
3. A node with one bridged and one direct address: the direct address's success never fills the node's AWG 3 path row while a bridge route is active (rotation gate safety).
4. Several addresses of one node going down in one run produce exactly one message; a mass run produces exactly one combined message and no per-address ones.
5. An open address incident survives a profile or bridge-mode change and closes with one recovery; disabling the address closes it silently.

---

### Task 1: Address alert kind column

**Files:**
- Create: `packages/db/migrations/0067_endpoint_probe_alert_kind.sql`; Modify: `packages/db/migrations/meta/_journal.json`, `packages/db/src/schema.ts` (`nodeVpnEndpoints`)
- Test: `packages/db/src/migrations.test.ts`

**Interfaces:**
- Produces: `nodeVpnEndpoints.probeAlertKind: reachabilityAlertKindEnum("probe_alert_kind")`, nullable, no default.

- [ ] Failing test `describe("0067_endpoint_probe_alert_kind")` → `it("adds the column nullable without a default, typed by the alert kind enum")` reading the SQL text like the other migration cases.
- [ ] Migration: `ALTER TABLE "node_vpn_endpoints" ADD COLUMN "probe_alert_kind" "reachability_alert_kind";`, journal idx 67 `when` 1795400000006; schema field.
- [ ] `pnpm --filter @amnezia/db test` PASS, build, `db:migrate` on the test database.

### Task 2: Address-only AWG 3 targets

**Files:**
- Modify: `apps/worker/src/reachability.ts` (target type, `measuredViaBridge`), `apps/worker/src/reachabilityRepository.ts` (`loadTargets`, `directNodeTargets`, `bridgedNodeTargets`, `projectServiceConfig`), `apps/worker/src/reachabilityTask.ts` (dispatch ordering and `reportUncompared`)
- Test: `apps/worker/src/reachabilityBridge.integration.test.ts`, `apps/worker/src/reachabilityTask.test.ts`

**Interfaces:**
- Produces in `reachability.ts`:
  ```ts
  export type TargetAddress = { id: string; ordinal: number; address: string; name: string; checkedAt: Date | null };
  // on ReachabilityTarget, replacing directEndpoint / bridgedEndpointIds / supplementalBridge:
  addresses?: TargetAddress[]; // set on every AWG 3 address target; absent on node targets
  ```
  `measuredViaBridge(t) = t.protocol === "awg3" && t.bridgePath !== null && !t.diagnostic`.
- Ids: direct `${reachabilityTargetId(node,"awg3",rev)}:direct:<sha256>` (existing digest), bridged `${…}:bridge:<sha256(fingerprint, via, [id, revision]…)>`; diagnostics keep `${node}:awg3:direct:…`.
- A node with address rows but none enabled with checks on: one AWG 3 target, no `addresses`, `unavailableReason: "no address with checks on"`.
- Dispatch order: node and address targets by oldest `checkedAt` (min over `addresses`, null first), then diagnostics, cut at `PROBE_RUN_MAX_TARGETS`. `reportUncompared` = bridge measurement supported and `addresses !== undefined`.

- [ ] Failing tests (integration, real dispatch through `probe.tick()`):
  - `it("sends no target to the service key's stored host once the primary address changed")`: key issued for 192.0.2.10, primary address row moved to 192.0.2.30 (revision 1) → exactly one AWG 3 target, host 192.0.2.30, id contains `:direct:`.
  - `it("measures every address once on its own route with its own profile")`: addresses A direct (inherits node `dns_query`), B bridge (own `stun`), C bridge (inherits) on a node with an active route → three targets: A to its IP, B and C via the bridge host/port as two separate targets (different projections), no `${node}:awg3:r1` target.
  - `it("reports an address without checks as unknown and sends nothing for it")`.
  - Update existing cases that assert `${node.id}:awg3:rN` / `:c` ids on nodes with address rows to the address ids (match by `:direct:` / `:bridge:` and host). Cases on nodes without address rows stay as they are.
- [ ] Implement; delete `reusesNodeTarget`, `mayReuseLegacy`, `usesLegacyIdentity`, `supplementalBridge`, `bridgedEndpointIds` and `directEndpoint` paths.
- [ ] `pnpm --filter @amnezia/worker exec vitest run src/reachabilityBridge.integration.test.ts src/reachabilityTask.test.ts` (with `TEST_DATABASE_URL`) — the new cases PASS; ingest-dependent assertions may fail until Task 4 and are listed in the ledger.

### Task 3: Pure verdicts, incidents and messages

**Files:**
- Modify: `apps/worker/src/reachability.ts` (`ingestRun`, formatters)
- Test: `apps/worker/src/reachability.test.ts`

**Interfaces:**
- Consumes: Task 2 `addresses`.
- Produces:
  ```ts
  export type AddressState = { consecutiveFailures: number; failingSince: Date | null; alertedAt: Date | null; alertKind: "node" | "mass" | null };
  export type AddressOutcome = { endpointId: string; status: ReachabilityStatus; levels: ProbeLevels | null; detail: string | null; state: AddressState };
  // IngestInput += previousAddresses: ReadonlyMap<string, AddressState>
  // IngestOutput: endpointOutcomes → addressOutcomes: AddressOutcome[]; outcomes keep one AWG 3 "path" outcome per node (spec rule) plus AWG 2.
  ```
- Rules: address outcome from its target (a target without a result writes nothing for its addresses; an unavailable target writes `error` with its reason); incidents per spec; node state summary never opens an incident for an address node, closes an open one once on `ok`; mass detection over node summaries as today; one message per node per run for its opened addresses and one for its recovered ones; mass → one combined message (names `"<name> (<address>)"`, legacy nodes by node name), combined recovery for ≥2 `mass` recoveries.
- Texts: one address `Адрес <name> (<address>)[ через мост <bridge> (<ip>:<port>)] недоступен из <label>` + levels line + `с <time>`; several `<node>: недоступны адреса из <label>` then one line per address with the same parts; recovery `снова доступен` / `<node>: снова доступны адреса …`.

- [ ] Failing unit tests: `opens one message for two addresses of a node failing in the same run`; `names the bridge for a bridged address`; `keeps the node summary available while one address answers`; `never opens a node incident on an address node and closes an old one once`; `sends one combined message in a mass run and none per address`; `combines the recovery of two mass incidents`; `error keeps an address incident as it was`; `writes nothing for an address whose target returned no result`; `path row: bridged node takes the best bridged group, never a direct address`.
- [ ] Implement; `pnpm --filter @amnezia/worker exec vitest run src/reachability.test.ts` PASS.

### Task 4: Repository ingest and bridge verdict

**Files:**
- Modify: `apps/worker/src/reachabilityRepository.ts` (`ingest`, bridge verdict gathering), `apps/worker/src/reachabilityTask.ts` (decide wiring)
- Test: `apps/worker/src/reachabilityBridge.integration.test.ts`, `apps/worker/src/postgresRepository.integration.test.ts`

**Interfaces:**
- Consumes: Task 3. `IngestContext += previousAddresses`, read under the node locks from `node_vpn_endpoints` of the locked nodes.
- Writes `probe_status/levels/checked_at/consecutive_failures/failing_since/alerted_at/alert_kind/detail` per `AddressOutcome`; results row from the path outcome; bridge AWG evidence from outcomes of targets with `measuredViaBridge`.

- [ ] Failing integration tests: `alerts each down address of a node once, bridged ones naming the bridge`; `follows the new primary address in the node verdict and the widget`; `a direct address never verifies the node's bridge path row`; plus the Task 2 cases now passing end to end.
- [ ] Implement; remove the repository's per-endpoint incident code.
- [ ] Worker suite PASS against a disposable PostgreSQL.

### Task 5: Widget rows per address

**Files:**
- Modify: `apps/worker/src/reachabilityRepository.ts` (`loadWidgetSnapshot`)
- Test: `apps/worker/src/reachabilityWidgetSender.test.ts` or the repository integration test that covers the snapshot

- [ ] Failing test `lists every checked address of a bridged node as its own row`; one-address nodes show the address name.
- [ ] Implement (drop the `!bridged && length >= 2` condition; legacy nodes keep the node row); PASS.

### Task 6: Cabinet key cards and incident resets

**Files:**
- Modify: `apps/control-api/src/postgresRepository.ts` (key view path selection, address update, node checks-off), `apps/worker/src/postgresRepository.ts` (`syncResolvedPrimaryEndpoint` restarts the streak)
- Test: `apps/control-api/src/bridgeReadModel.integration.test.ts` / `postgresRepository.integration.test.ts`, `apps/worker/src/postgresRepository.integration.test.ts`

- [ ] Failing tests: `a key card reads its own address verdict, direct or bridged`; `a bridged key on an address measured direct reads the node bridge path`; `a direct key on an address measured through the bridge reads unknown`; `a profile or bridge mode change keeps an open address incident and restarts the streak`; `disabling an address or its checks closes the incident silently`.
- [ ] Implement; control-api and worker suites PASS.

### Task 7: Docs, full suite, release, deploy

- [ ] `docs/REACHABILITY-PROBE.md`: statuses and alerts, bridged nodes, widget, cabinet sections rewritten for addresses; `docs/AWG-GENERATOR.md` reachability section.
- [ ] Full suite against disposable PostgreSQL, lint, typecheck, build; final reviewer; fix pass.
- [ ] Commit, push, CI green, tag the next `v0.15.x`, pin its digest, `bash infra/prod/update.sh` between probe runs, verify a run: every address has a fresh verdict, node verdicts unchanged, no alert sent.
