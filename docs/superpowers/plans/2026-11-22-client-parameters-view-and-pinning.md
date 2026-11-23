# Client parameters view, per-user device profiles, pinning and CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin sees the real client parameters of a key or node address, gives a user per-device-type profiles, pins a key's effective profile to its owner, and does all of it from the CLI as well.

**Architecture:** A new `userDevice` level in the contracts resolver, fed from `users.awg_device_rules`; a whitelisted parameter reader in vpn-config; read endpoints in control-api that run the export projection without recording an export; a server-side pin action; admin dialogs reusing the existing generator, MTU and device-rule editors; CLI commands over the same API.

**Tech Stack:** TypeScript, zod, drizzle + PG16 (hand-written migrations), Fastify, Next.js + Radix (static-markup vitest), the CLI's own HTTP client.

**Spec:** `docs/superpowers/specs/2026-11-22-client-parameters-view-and-pinning-design.md`

## Global Constraints

- Admin only: no owner-facing response or page gains any of this.
- Parameters are a whitelist: `Jc Jmin Jmax S1 S2 S3 S4 H1 H2 H3 H4 I1 I2 I3 I4 I5 ContentPaddingAddition RekeyAfterTime RekeyTimeout RejectAfterTime KeepaliveTimeout MaxHandshakeAttempts MTU`; S and H have scope `server`.
- Level order `key > userDevice > user > device > address > node`; `userDevice` is manual (not probe-checked).
- A pin writes both fields as concrete values (`issued` preset for no profile, the resolved MTU number).
- Migrations additive; stored settings stay valid. No real names or addresses; English comments; commits to `main` by wyrtensi; ru and en strings.

## Review Focus

1. The parameters view equals the next download for the same key (same projection, same revision), and viewing records no export and changes no `configUpdatedAt`.
2. No secret (PrivateKey, PresharedKey, HeaderProtectionKey, Address, Endpoint, DNS) appears in any parameters response.
3. Every resolver call site (export, refresh token, admin key list, create-key gate, inherited) passes the owner's device rules, so the list, the export and the refresh agree.
4. Pin `device` merges into the owner's rules inside one transaction and leaves other types untouched; pin on an `unspecified` key or a service-account owner is refused.
5. CLI `config-set --device` at an address keeps the other rules of that address.

---

### Task 1: Contracts — level, schemas, parameter types

**Files:** `packages/contracts/src/awgGenerator.ts`, `packages/contracts/src/index.ts`; tests `packages/contracts/src/awgGenerator.test.ts`, `packages/contracts/src/index.test.ts` (or the file that already tests `deviceRuleFor`).

**Produces:**
- `AWG_CONFIG_LEVELS = ["key", "userDevice", "user", "device", "address", "node"]`.
- `setUserClientConfigRequestSchema` = `setAwgClientConfigRequestSchema` fields + `awgDeviceRules: awgDeviceRulesSchema.nullable().optional()` (at least one field).
- `pinClientConfigRequestSchema = z.strictObject({ target: z.enum(["user", "device"]) })`.
- `AWG_CLIENT_PARAMETER_NAMES` (the whitelist, in order), `awgClientParameterSchema = { name, value: string | null, scope: "client" | "server" }`, `adminClientParametersSchema = { exported: AwgClientParameter[], issued: AwgClientParameter[], settings: { profileFrom, mtuFrom, preset: string | null, mtu, deviceType, ownerId: string | null } }`.

- [ ] Failing tests: `resolves the owner's device rule above the owner`; `a key's own setting still wins over the owner's device rule`; `the user config request accepts device rules and rejects an empty body`; `the pin request accepts user and device only`.
- [ ] Implement; run `pnpm --filter @amnezia/contracts test`.

### Task 2: vpn-config — parameter reader

**Files:** `packages/vpn-config/src/awgClientInterface.ts` (export `readAwg31ClientParameters(vpnLink: string): AwgClientParameter[] | null`), index export; test `apps/control-api/src/awgGenerator.test.ts` or a new `packages/vpn-config/src/awgClientParameters.test.ts`.

- [ ] Failing tests: `reads every whitelisted parameter in order with server scope for S and H`; `returns null value for a parameter the config does not carry`; `never returns a private, preshared or header protection key` (fixture with all of them, assert on the JSON); `returns null for a 2.0 artifact`.
- [ ] Implement over `readAwg31` (the effective copy the projection writes).

### Task 3: DB — users.awg_device_rules

**Files:** `packages/db/migrations/0070_user_device_rules.sql`, `meta/_journal.json`, `packages/db/src/schema.ts` (`awgDeviceRules: jsonb("awg_device_rules").$type<AwgDeviceRules>()` on users).

- [ ] Migration adds the nullable column; journal entry idx 70. `pnpm --filter @amnezia/db test` (journal/schema tests).

### Task 4: control-api — resolver wiring, set-config, pin

**Files:** `apps/control-api/src/postgresRepository.ts`, `apps/control-api/src/repository.ts`; tests `postgresRepository.integration.test.ts` (DB), `defaultService.test.ts`.

**Produces:** `resolveKeyClientSettings` takes `owner: (StoredAwgLevel & { awgDeviceRules: unknown }) | null` and sets `userDevice: deviceRuleFor(owner.awgDeviceRules, key.deviceType)`; every call site selects `users.awgDeviceRules`. `StoredKeyConfig` gains `awgSettingsFrom?: { profileFrom, mtuFrom }` and `deviceType?: string`. `manual` includes `userDevice`. `users/set-config` parses `setUserClientConfigRequestSchema` and writes `awgDeviceRules`; audit metadata adds the device types set. `keys/pin-config` action (generic admin action route) per the spec, `409 PIN_UNAVAILABLE`, audit `admin.keys.pin-config`. Admin users list returns `awgDeviceRules`. New `findServiceKeyConfig(nodeId: string, endpointId: string | null): Promise<{ keyId, encrypted, protocol, awgClientProfile, settings: ResolvedAwgClientSettings } | null>` (service account's newest non-revoked awg3 key on the node, address + node levels only).

- [ ] Failing integration tests: `exports a key with the owner's device rule for its type`; `the admin key list reports userDevice and not probe-checked`; `set-config stores and clears a user's device rules`; `pins a key's effective profile and MTU to the owner`; `pins to the owner's rule for the key's type and keeps other types`; `pins the issued preset and the default MTU as concrete values`; `refuses a pin for an unspecified device type and for a 2.0 key`; `finds the node's service key with address settings`.
- [ ] Implement.

### Task 5: control-api — parameters endpoints

**Files:** `apps/control-api/src/defaultService.ts` (`getKeyClientParameters(actor, keyId)`, `getNodeClientParameters(actor, nodeId, endpointId | null)`), `apps/control-api/src/app.ts` (`GET /api/admin/keys/:id/client-parameters`, `GET /api/admin/nodes/:id/client-parameters?endpointId=`), service interface; tests `defaultService.test.ts`, `app.test.ts`.

- [ ] Failing tests: `the parameters view equals the exported config` (project via the export path, compare every whitelisted line); `viewing parameters records no export`; `answers 403 to a non-admin`, `404 for an unknown key`, `409 for a 2.0 key`, `404 SAMPLE_KEY_NOT_FOUND` without a service key; `the node view applies the address settings when named`.
- [ ] Implement: reuse the export's `projectKeyClientConfig` with the same options; `issued` from the decrypted saved artifact.

### Task 6: Web — parameters dialog, pins, user device rules

**Files:** new `apps/web/components/admin/client-parameters-dialog.tsx` (+ test), `apps/web/components/admin/awg-client-settings.tsx` (user dialog: device rules editor + "Now in effect" list), `apps/web/components/admin/awg-device-rules-editor.tsx` (generic over the inherited source), `apps/web/app/admin/users/page.tsx` (key row "Parameters" action, user dialog wiring), `apps/web/components/admin/node-config-dialog.tsx` / `node-public-endpoints.tsx` (node and address "Parameters"), `apps/web/lib/i18n/messages.ts`; tests next to each.

**Produces:** `ClientParametersDialog({ target: { kind: "key", id } | { kind: "node", id, endpointId: string | null } | null, onClose, onPinned? })`; `ClientParametersTable({ data })` (pure, testable); `useAwgSourceLabel` knows `userDevice`.

- [ ] Failing tests: `renders exported values grouped with server scope marked`; `shows the issued value only where it differs`; `offers both pins for a typed key and only the user pin for an unspecified one`; `the pin confirm names what it replaces`; `the user dialog lists keys with profile, MTU and source`; `the user dialog saves device rules`; labels for `userDevice` in ru and en.
- [ ] Implement with existing components (Dialog, Badge, Button, Tooltip, the copy pattern of `admin-config-dialog.tsx`), tokens only; monospace wrap for I templates; loading, error and no-service-key states.

### Task 7: CLI

**Files:** `apps/cli/src/main.ts`, `apps/cli/src/args.ts`, new `apps/cli/src/clientConfig.ts` (pure formatting and request building) + `clientConfig.test.ts`, `apps/cli/src/main.test.ts`.

- [ ] Failing tests: `config-presets lists every preset`; `config-show key prints profile, MTU and sources`; `config-set node --preset sends the full preset settings`; `config-set address --device=android --mtu=1300 keeps other rules`; `config-set user --device --clear removes one rule`; `config-set --settings-file rejects --preset`; `config-set key --device is an error`; `config-params key prints the table and --json the response`; `config-pin --to=device posts the pin`; `user-create-key --preset --mtu sends awgGenerator and awgMtu`.
- [ ] Implement; usage text.

### Task 8: Docs, suite, review, release

- [ ] `docs/AWG-GENERATOR.md` (levels, user device rules, parameters view, pin), `docs/CLI.md` (new commands), `README.md`/`README.ru.md` (feature list), `docs/OPERATIONS.md` where client settings are described; check every doc that lists the levels.
- [ ] Full suite with a local PG (integration tests), lint, typecheck, build; final reviewer; one fix pass; commit, push, CI, tag next `v0.15.x`, deploy, probe-run check.
