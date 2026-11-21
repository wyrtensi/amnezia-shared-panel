# Client MTU on its own, profiles per user, key and device type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Client MTU becomes an inheritable setting of its own, and administrators can set a configuration profile and MTU per user, per key and per device type on each address, with a convenient admin-only UI.

**Architecture:** One pure resolver in `@amnezia/contracts` walks the levels key → user → address device rule → address → node and returns the effective profile and MTU with the level each came from. `projectAwgClientConfig` takes the MTU separately and applies it after the profile, so draws never depend on it. Every caller that resolves a profile today (exports, config refresh and its token, the admin key list, the probe, the bridge candidate check) goes through the resolver. New nullable columns hold the settings; a migration copies each saved profile's MTU into the new MTU column of its level.

**Tech Stack:** TypeScript, zod, drizzle + PostgreSQL 16, Fastify, Next.js (Radix UI components), vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-config-profile-per-user-and-key-design.md`

## Global Constraints

- MTU range 1280-1420, default 1280 (`AWG_DEFAULT_CLIENT_MTU`); null = inherit at every level.
- Profile precedence: key, user, address device rule for the key's device type, address, node, none. MTU: the same levels, then the resolved profile's stored `mtu`, then 1280.
- `unspecified` matches no device rule. Device types: android, ios, macos, windows, linux, other.
- AWG 3.1 only: settings on an AWG 2.0 key are refused (409 `AWG_GENERATOR_UNSUPPORTED`); a user's settings do not touch their AWG 2.0 keys.
- Admin only: no user-facing response (`/api/keys`, `/api/me`, config views) carries user, key or device-rule settings. The probe's service account cannot get user or key settings (refused like other admin edits of it).
- The probe measures an address's ordinary config (address and node levels only). Node/address MTU changes reset that evidence and queue a run like a profile change; device rules, user and key settings queue nothing.
- Draws (Jc, Jmin, Jmax, I-packets) come from the stored profile alone; the resolved MTU never enters the seed.
- UI: shared components (`Select`, `Switch`, `Dialog`, `Badge`, `Button`, the profile editor) and theme tokens; every inheriting control names its source and value; one-click reset to inherit; works at phone width, light and dark.
- No real names, IPs or hostnames in code, tests or docs; English comments; commits to `main` by wyrtensi, no Co-Authored-By.

## Review Focus

1. Mixed levels: a key that sets only its MTU on an address with an iOS rule whose owner has a user profile gets the user's profile and the key's MTU; every export path and the refresh token agree.
2. Changing an MTU at any level leaves every other client value of a randomized key byte-for-byte the same.
3. Upgrade: a node at profile MTU 1400 with an address that has its own profile at 1280 exports 1400 and 1280 respectively before and after the migration; nodes without a profile stay 1280.
4. A user, key or device rule never changes what the probe sends; a node or address MTU change does, and queues a run.
5. A non-admin request carrying `awgGenerator`/`awgMtu` on key creation is refused, and no owner-facing response leaks the new fields.

---

### Task 1: Resolver, schemas and MTU applied separately

**Files:**
- Modify: `packages/contracts/src/awgGenerator.ts`, `packages/contracts/src/index.ts`, `packages/vpn-config/src/awgGenerator.ts`
- Test: `packages/contracts/src/awgGenerator.test.ts`, `packages/vpn-config/src/awgGenerator.test.ts`

**Interfaces (produces):**
```ts
// awgGenerator.ts
export const AWG_DEFAULT_CLIENT_MTU = 1280;
export const awgClientMtuSchema: z.ZodNumber; // int 1280..1420, reused by the settings schema's `mtu`
export type AwgConfigLevelName = "key" | "user" | "device" | "address" | "node";
export type AwgConfigLevel = { awgGenerator?: AwgGeneratorSettings | null; awgMtu?: number | null };
export type ResolvedAwgClientSettings = {
  awgGenerator: AwgGeneratorSettings | null;
  profileFrom: AwgConfigLevelName | null;
  mtu: number;
  mtuFrom: AwgConfigLevelName | "profile" | "default";
};
export const resolveAwgClientSettings: (
  levels: Partial<Record<AwgConfigLevelName, AwgConfigLevel | null | undefined>>,
) => ResolvedAwgClientSettings;
// index.ts (after deviceTypeSchema)
export const awgDeviceRuleSchema; // strictObject { awgGenerator: settings|null default null, awgMtu: mtu|null default null }, refine: one of them set
export const awgDeviceRulesSchema; // partialRecord(deviceType without "unspecified", awgDeviceRuleSchema)
export type AwgDeviceRules = z.infer<typeof awgDeviceRulesSchema>;
export const deviceRuleFor: (rules: unknown, deviceType: string) => AwgConfigLevel | null; // tolerant parse, null on invalid/unspecified
export const setAwgClientConfigRequestSchema; // strictObject { awgGenerator?: settings|null, awgMtu?: mtu|null }, refine: at least one field
// vpn-config: projectAwgClientConfig options gain `mtu?: number`
```

- [ ] Failing contract tests (`describe("resolveAwgClientSettings")`): `takes each value from the nearest level that sets it` (key mtu 1360 + user profile stun + node mtu 1400 → stun from user, 1360 from key); `falls back to the resolved profile's stored MTU, then 1280` (node profile with mtu 1400 → 1400/"profile"; nothing → 1280/"default"); `deviceRuleFor ignores unspecified and invalid rules`; `awgDeviceRuleSchema refuses an empty rule`.
- [ ] Failing vpn-config tests: `applies the MTU given apart from the profile` (issued preset mtu 1280 + `mtu: 1400` → `MTU = 1400` in conf and last_config); `keeps every drawn value when only the MTU changes` (randomized preset, same key: export with mtu 1300 vs 1400 differs only in MTU lines); `applies the MTU without a profile` (generator null, mtu 1380 → 1380).
- [ ] Implement; `pnpm --filter @amnezia/contracts test && pnpm --filter @amnezia/vpn-config test` PASS; build both.
- [ ] Commit.

### Task 2: Columns and the MTU migration

**Files:**
- Create: `packages/db/migrations/0069_awg_client_settings.sql`; Modify: `meta/_journal.json` (idx 69, when 1795400000008), `packages/db/src/schema.ts`
- Test: `packages/db/src/migrations.test.ts`, `apps/worker/src/awgClientSettingsMigration.integration.test.ts`

**Interfaces (produces):** `nodes.awgMtu`, `nodeVpnEndpoints.awgMtu`, `nodeVpnEndpoints.awgDeviceRules` (jsonb `AwgDeviceRules`), `users.awgGenerator`, `users.awgMtu`, `vpnKeys.awgGenerator`, `vpnKeys.awgMtu`; MTU columns `integer` with `CHECK (awg_mtu BETWEEN 1280 AND 1420)`.

- [ ] Failing tests: text case `adds the settings columns nullable with range checks`; integration `gives every node and address with a saved profile its profile's MTU` (node profile mtu 1400 → 1400; its address with own profile mtu 1280 → 1280; inheriting address → null; node without profile → null), running only the backfill statement as in the 0068 test.
- [ ] Implement (backfill `coalesce((awg_generator->>'mtu')::int, 1280)` where `awg_generator IS NOT NULL`); db tests, build, `db:migrate` on the test database.
- [ ] Commit.

### Task 3: Exports and config refresh through the resolver

**Files:**
- Modify: `apps/control-api/src/repository.ts` (`StoredKeyConfig`: `awgGenerator` resolved, `awgMtu: number`), `apps/control-api/src/postgresRepository.ts` (`findKeyConfig`, `refreshOwnConfigProfile`, refresh status), `apps/control-api/src/defaultService.ts` (`composeExport`, `nextClientProfile`, refresh status), `apps/control-api/src/awgClientProfile.ts` (`configRefreshToken(keyId, nonce, revision, generator?, mtu?)`)
- Test: `apps/control-api/src/postgresRepository.integration.test.ts` (new describe "AWG client settings per user, key and device type"), `apps/control-api/src/defaultService.test.ts`

**Interfaces:** consumes Task 1 and 2. A private repository helper `resolveKeyClientSettings(row)` builds the levels from key, owner, `deviceRuleFor(endpoint.awgDeviceRules, key.deviceType)`, endpoint and node columns; AWG 2.0 keys resolve to `{ awgGenerator: null, mtu: 1280 }` and are not projected (as today).

- [ ] Failing integration tests: `exports the key's own MTU over the address profile`; `exports the user's profile on every node, over an iOS rule`; `exports the address's iOS rule only to iOS keys`; `changes the refresh token when the effective MTU changes`; `keeps exporting AWG 2.0 keys as issued with user settings present`.
- [ ] Implement; control-api suite PASS against the test database.
- [ ] Commit.

### Task 4: Admin API — node, address, user and key settings

**Files:**
- Modify: `packages/contracts/src/index.ts` (`createNodeRequestSchema` + `awgMtu`, endpoint update + `awgMtu`/`awgDeviceRules`, `createKeyRequestSchema` + `awgGenerator`/`awgMtu`, `adminNodeEndpointSchema` + `awgMtu`/`awgDeviceRules`), `apps/control-api/src/postgresRepository.ts` (node update, `changeNodePublicEndpoint`, `createProvisioningKey`, `adminAction` `users/set-config` and `keys/set-config`, `adminList("keys")` + `awgGenerator`, `awgMtu`, `config: ResolvedAwgClientSettings & { probeChecked: boolean }`, endpoint read model), `apps/control-api/src/app.ts` only if a route is needed (admin actions reuse `/api/admin/:resource/:id/:action`)
- Test: `apps/control-api/src/postgresRepository.integration.test.ts`, `apps/control-api/src/app.test.ts` (non-admin refusal)

**Rules:** node `awgMtu` change = like a generator change: reset evidence of addresses with `awg_mtu IS NULL`, queue a run. Address `awgMtu` change = like an address generator change (revision + 1, evidence reset, queue). `awgDeviceRules` = full replace, audit only. `users/set-config`, `keys/set-config` accept `setAwgClientConfigRequestSchema`; refuse service-account users and their keys (404 like other admin edits), AWG 2.0 keys (409). Key creation: non-admin callers sending either field → 403 like `bridgeMode`. Audit `admin.users.set-config`, `vpn_key.config_set` with `{ preset, awgMtu }`; creation audit adds the same. `probeChecked` = `profileFrom` and `mtuFrom` are neither `key`, `user` nor `device`.

- [ ] Failing tests: `saves a node MTU, resets inheriting addresses and queues a run`; `saves an address MTU like an address profile change`; `stores device rules without queueing a run`; `sets and clears a user's settings`; `sets a key's settings and refuses it on AWG 2.0 and probe keys`; `issues a key with its own profile and MTU from the admin panel and the cabinet`; `refuses the settings from a non-admin on key creation`; `lists each key's effective settings and where they come from`; `leaves owner-facing key and me responses without the settings`.
- [ ] Implement; control-api suite PASS.
- [ ] Commit.

### Task 5: Probe and bridge candidate projections

**Files:**
- Modify: `apps/worker/src/reachabilityRepository.ts` (`projectServiceConfig` takes the node's `awgMtu` and resolves `[address, node]` levels; cache key includes the MTU; node rows select `awgMtu`), `apps/worker/src/bridgeCandidateCheck.ts`
- Test: `apps/worker/src/reachabilityBridge.integration.test.ts`, `apps/worker/src/bridgeCandidateCheck.test.ts`

- [ ] Failing tests: `measures an address with its node's MTU and its own MTU over it`; `ignores user and key settings and device rules of the probe's node`; bridge candidate `uses the node MTU in the candidate config`.
- [ ] Implement; worker suite PASS.
- [ ] Commit.

### Task 6: Admin UI

**Files:**
- Create: `apps/web/components/admin/awg-mtu-field.tsx`, `apps/web/components/admin/awg-client-settings-editor.tsx` (profile editor + MTU field with inherited source, reset to inherit), `apps/web/components/admin/awg-device-rules-editor.tsx`
- Modify: `apps/web/components/admin/node-generator-settings.tsx` (MTU leaves `GeneratorEditor`; node/address scope shows the MTU field; address scope shows device rules), `apps/web/app/admin/nodes/page.tsx` (save handlers), `apps/web/app/admin/users/page.tsx` (`UserDetail` settings block + dialog, `CreateKeyDialog` fields, `AdminKeyRow` effective settings line, "own settings, not checked by the probe" badge and action), `apps/web/components/employee/create-key-wizard.tsx` (admin-only fields), `apps/web/lib/i18n/messages.ts` (ru + en)
- Test: `apps/web/components/admin/*.test.tsx`, `apps/web/lib/i18n/messages.test.ts`

- [ ] Failing tests: `shows the inherited MTU and its source and resets to inherit`; `keeps the preset when only the MTU changes` (moved from `GeneratorEditor`); `lists one row per device type with a rule and adds one for a free type`; `marks a key with its own or its owner's settings as not checked by the probe`; `offers profile and MTU in the cabinet wizard to administrators only`; messages parity test for the new keys.
- [ ] Implement with shared components and theme tokens; web tests, lint, typecheck, `next build` PASS; check the pages at phone width and in dark mode in the dev server.
- [ ] Commit.

### Task 7: Docs, full suite, review, release, deploy

- [ ] `docs/AWG-GENERATOR.md`: MTU on its own, precedence, user/key/device settings, REST payloads, migration note, rollback note (drop the new columns' effect: older releases ignore them). `docs/REACHABILITY-PROBE.md`: MTU change queues a run; user/key/device settings are not measured.
- [ ] Full suite against a disposable PostgreSQL, lint, typecheck, build; final reviewer; one fix pass.
- [ ] Commit, push, CI green, tag the next `v0.15.x`, pin its digest, `bash infra/prod/update.sh` between probe runs; verify: migration kept every node at 1280, exports unchanged for an existing key, a probe run all ok, no alerts.
