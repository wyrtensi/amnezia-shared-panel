# AWG generator key randomization switch and new presets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per node/address "Randomize user keys" switch on the generator settings, plus twelve new presets built from four new signature modes.

**Architecture:** `randomizeKeys` is an optional boolean on `awgGeneratorSettingsSchema` (contracts). `applyAwgGeneratorSettings` (vpn-config) picks the draw seed from it: key id + revision when on or absent, settings only when off; fixed presets widen J to the standard ranges when on. Exports and the probe already call this one function, so nothing else changes server-side. The web editor gets the switch and the new presets.

**Tech Stack:** TypeScript, zod 4, vitest, Next.js (React), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-21-awg-generator-key-randomization-design.md`

## Global Constraints

- Settings saved without `randomizeKeys` keep today's output byte for byte.
- `custom` with `randomizeKeys: true` is invalid; `issued` ignores the flag.
- Standard J ranges when widening a fixed preset: Jc 3-10, Jmin 40-100, Jmax gap 30-200 (`defaultParameters`).
- "Full" presets add `contentPaddingAddition {1,39}` and the `randomized` preset's timing ranges.
- No names, IPs or hostnames of real installations in code, tests or docs. Comments in English. Commits to `main`, author wyrtensi, no Co-Authored-By.

## Review Focus

1. Old saved settings (no flag) must render exactly as before — pin with an equality test against an output captured from the flag-less call.
2. Off must give identical I1-I5/J for two different key ids and ignore revision; on must differ between keys.
3. A fixed preset (`dns_response_random_ttl`) with the switch on must keep its I1 shape while J varies by key.
4. Editing MTU must keep the preset and the switch; editing any other field turns it into Custom and switches randomization off.
5. Every new preset must pass `awgGeneratorSettingsSchema` and produce a valid AWG 3.1 config (I-slot count = `iCount`, unused slots cleared).

---

### Task 1: Contract — flag, modes, presets

**Files:**
- Modify: `packages/contracts/src/awgGenerator.ts`
- Test: `packages/contracts/src/awgGenerator.test.ts`

**Interfaces:**
- Produces: `AWG_GENERATOR_I_MODES` += `"dns_query_aaaa" | "dns_query_https" | "dns_query_stun" | "stun_dns_response"`; `AWG_GENERATOR_PRESETS` += `dns_query_aaaa, dns_query_aaaa_full, dns_query_https, dns_query_https_full, dns_query_burst, dns_query_burst_full, dns_query_stun, dns_query_stun_full, stun_dns_response, stun_dns_response_full, noise, noise_full` (insert before `custom`); `awgGeneratorSettingsSchema` field `randomizeKeys: z.boolean().optional()`; exported `AWG_GENERATOR_STANDARD_J = { jcMin: 3, jcMax: 10, jminMin: 40, jminMax: 100, jmaxGapMin: 30, jmaxGapMax: 200 }`.

- [ ] **Step 1: Failing tests** — `it("refuses randomization on the custom preset")`: `safeParse({ ...custom, randomizeKeys: true }).success === false`, with `randomizeKeys: false` true. `it("lists the new presets, each valid, J-only without CPA/timers and full with CPA 1-39 and timers")`: for each new id, settings parse; `_full` has `contentPaddingAddition {min:1,max:39}` and non-null `timings`; J-only has both null; iMode/iCount: aaaa→`dns_query_aaaa`/1, https→`dns_query_https`/1, burst→`dns_query`/3, dns_query_stun→`dns_query_stun`/2, stun_dns_response→`stun_dns_response`/2, noise→`noise`/3. `it("keeps flag-less settings valid")`.
- [ ] **Step 2:** `pnpm --filter @amnezia/contracts test` → new tests FAIL.
- [ ] **Step 3:** Implement; presets get `randomizeKeys: true` in their `settings` except `issued` (omit) and `custom` (`false`).
- [ ] **Step 4:** tests PASS, `pnpm --filter @amnezia/contracts build`.

### Task 2: Projection — seed choice, widening, new packets

**Files:**
- Modify: `packages/vpn-config/src/awgGenerator.ts` (`signaturePackets`, `applyAwgGeneratorSettings`)
- Test: `apps/control-api/src/awgGenerator.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `AWG_GENERATOR_STANDARD_J`.
- Produces: unchanged signature `applyAwgGeneratorSettings(vpnLink, settings, { keyId, profileRevision })`.

Templates: AAAA/HTTPS query = the `dnsQuery` bytes with QTYPE `0x001c` / `0x0041` instead of `0x0001`. `dns_query_stun` = slot 0 query (A), slot 1 STUN. `stun_dns_response` = slot 0 STUN, slot 1 the `dns_response_random_ttl` packet. Slots beyond `iCount` empty as today.

Seed: off → `draw` uses `JSON.stringify(["shared", profile])` and revision 0; on/absent → today's key seed. On + preset in `fixedPresets` → replace J fields with `AWG_GENERATOR_STANDARD_J` before drawing (I mode unchanged).

- [ ] **Step 1: Failing tests** — `it("gives every key the same values when randomization is off")` (two key ids, revisions 1 and 5 → identical output, settings `{ ...preset("dns_query"), randomizeKeys: false }`); `it("gives keys different values when it is on")` (8 key ids on `dns_query` → more than one distinct Jc/Jmin pair); `it("widens J for a fixed preset when on and keeps its packet")` (`dns_response_random_ttl` + `randomizeKeys: true`: I1 matches `/^<r 2><b 0x8580/`, Jc within 3-10 and not identical across 8 keys); `it("renders settings saved before the flag exactly as before")` (flag absent vs today's expected strings for `dns_response` → `Jc 4, Jmin 40, Jmax 70`, and `dns_query` output equal to `{...preset, randomizeKeys: undefined}`); `it("emits the new signature packets")` (aaaa I1 contains `<b 0x001c><b 0x0001>`, https `<b 0x0041><b 0x0001>`, burst I1-I3 all queries + I4 null, dns_query_stun I1 query + I2 STUN + I3 null, stun_dns_response I1 STUN + I2 `^<r 2><b 0x8580`, noise I1-I3 `^<r \d+>$`).
- [ ] **Step 2:** `pnpm --filter @amnezia/vpn-config build && pnpm --filter @amnezia/control-api exec vitest run src/awgGenerator.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; worker `reachabilityBridge.integration.test.ts` parity tests still pass against a disposable PostgreSQL.

### Task 3: Editor — switch, presets, MTU

**Files:**
- Modify: `apps/web/components/admin/node-generator-settings.tsx`, `apps/web/lib/i18n/messages.ts`
- Test: `apps/web/components/admin/node-generator-settings.test.tsx` (create; vitest + Testing Library as the other admin component tests)

Switch "Рандомизация ключей пользователей" / "Randomize user keys" under the preset, hint "Вкл: у каждого ключа свои значения в стиле профиля. Выкл: у всех ключей одинаковые." / "On: every key gets its own values in the preset's style. Off: all keys get the same values."; hidden for `issued`, disabled and off for `custom`. MTU edits keep the preset; other edits set `preset: "custom", randomizeKeys: false` (keep the `randomized` exception). Labels for the 4 modes and 12 presets in ru and en (`generator.<id>`, J-only shares the mode label; `_full` adds " + CPA и тайминги" / " + CPA and timings").

- [ ] **Step 1: Failing tests** — `renders the switch on for a preset and off+disabled for custom`; `keeps the preset when only MTU changes`; `turns a preset into custom with randomization off when Jc changes`; `hides the switch for issued`.
- [ ] **Step 2:** `pnpm --filter @amnezia/web exec vitest run components/admin/node-generator-settings.test.tsx` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `pnpm lint && pnpm typecheck`.

### Task 4: Docs, release, deploy

**Files:** `docs/AWG-GENERATOR.md` (switch section, new preset rows, mode list in the Custom row).

- [ ] Full suite against disposable PostgreSQL (`DATABASE_URL`/`TEST_DATABASE_URL`, `db:migrate`, `pnpm -r --workspace-concurrency=1 --if-present test`), `pnpm build`.
- [ ] Commit to `main`, push, CI green, tag `v0.15.14`, wait for the GHCR image, pin its digest in the panel's `PANEL_IMAGE` (backup `.env`), `bash infra/prod/update.sh`, verify `APP_VERSION=v0.15.14`, services healthy, a probe run ingests for all addresses.
