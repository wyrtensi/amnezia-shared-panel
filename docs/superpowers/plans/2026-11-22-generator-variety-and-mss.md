# Generator variety, independent redraws and MSS clamping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-key client values differ independently and validly across keys, refreshes and servers; nodes clamp TCP MSS on the AWG 3.1 interface.

**Architecture:** `applyAwgGeneratorSettings` (packages/vpn-config) gets a revision-seeded draw, new DNS/STUN template builders and a per-key spread step applied before rendering; presets and I modes are added in packages/contracts; the refresh path in control-api searches revisions until the config changes; the node entrypoint adds mangle-table rules.

**Tech Stack:** TypeScript, zod, vitest, POSIX sh + node:test for node scripts.

**Spec:** `docs/superpowers/specs/2026-11-22-generator-variety-and-mss-design.md`

## Global Constraints

- Stored profiles stay valid; preset ids and I modes are only added.
- Every DNS packet passes an RFC 1035/2181/6891 parse and every STUN packet an RFC 5389 header/attribute parse in tests, for all presets over many keys and revisions.
- Randomization off: one set for every key; `amnezia_default` exact stock.
- No real names or addresses; English comments; commits to `main` by wyrtensi.

## Review Focus

1. A refresh changes the config of every randomized preset, and values do not all move by +1 together.
2. Timing sub-ranges keep RejectAfterTime.min > RekeyAfterTime.max and > KeepaliveTimeout.max + RekeyTimeout.max for every key.
3. `varied` never carries CPA or timings; `varied_full` does.
4. Narrow `*_full` presets keep their I count.
5. The node entrypoint removes what it adds on restart (no duplicate mangle rules).

---

### Task 1: Independent redraws
- Files: `packages/vpn-config/src/awgGenerator.ts` (draw), `apps/control-api/src/defaultService.ts` (`nextClientProfile` searches up to 8 revisions); tests in `apps/control-api/src/awgGenerator.test.ts`, `apps/control-api/src/defaultService.test.ts`.
- [ ] Failing tests: `redraws values independently on a refresh` (over 40 keys, the Jmin delta between revisions is not +1 for every key); `still changes a two-value range on refresh` (eligible and changed via the refresh path).
- [ ] Implement; update pinned draw expectations that move with the new seed.

### Task 2: Valid DNS and STUN variety
- Files: `packages/vpn-config/src/awgGenerator.ts`; test helper `apps/control-api/src/awgPackets.fixture.ts` (template expander, DNS and STUN parsers); tests in `awgGenerator.test.ts`.
- [ ] Failing tests: `every DNS packet parses as RFC 1035/2181/6891` (all DNS modes, 200 keys, labels, TLD set, OPT, pointer, TTL, public first octet); `every STUN packet is a valid Binding Request of 20-44 bytes without FINGERPRINT`; `keys differ in TLD, label count, OPT and STUN size`.
- [ ] Implement builders; `stun_dns_response` uses the random response; `mixed` includes it.

### Task 3: Per-key spread and presets
- Files: `packages/contracts/src/awgGenerator.ts` (presets `varied`, `varied_full`, `dns_response_randomized_full`; I mode `varied`; amnezia_default stock J; custom may randomize), `packages/vpn-config/src/awgGenerator.ts` (spread), `apps/web/lib/i18n/messages.ts` labels; tests in contracts and control-api.
- [ ] Failing tests: `draws the I count per key for mixed and varied only`; `spreads CPA and timings per key inside the configured ranges with every invariant`; `amnezia_default is exact stock with randomization off and varies J with it on`; `varied has no CPA or timings and varied_full has them`; `keys of varied take different I shapes`; `custom accepts randomization`.
- [ ] Implement.

### Task 4: UI
- Files: `apps/web/components/admin/node-generator-settings.tsx` (CPA switch starts 1-39; custom switch enabled, default off).
- [ ] Failing tests in `node-generator-settings.test.tsx`; implement.

### Task 5: Node MSS clamp
- Files: `infra/node/scripts/awg3-entrypoint.sh`; test `infra/node/tests/awg3-entrypoint.test.mjs`.
- [ ] Failing tests: the runtime block adds both clamp rules, `cleanup_interface` deletes them, the generated config's PostUp/PostDown carry them.
- [ ] Implement.

### Task 6: Docs, suite, review, release
- [ ] `docs/AWG-GENERATOR.md`: presets, refresh, spread, STUN/DNS, Custom randomization, rollback SQL, probe note for `varied`; node docs for the clamp.
- [ ] Full suite, lint, typecheck, build; final reviewer; fix pass; commit, push, CI, tag next `v0.15.x`, deploy panel; node rollout left to the administrator.
