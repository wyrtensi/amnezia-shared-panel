import { describe, expect, it } from "vitest";

import {
  AWG_GENERATOR_STANDARD_J,
  awgClientMtuSchema,
  awgGeneratorPresets,
  awgGeneratorSettingsSchema,
  resolveAwgClientSettings,
} from "./awgGenerator.js";

const timings = {
  rekeyAfterTime: { min: 100, max: 150 },
  rekeyTimeout: { min: 4, max: 8 },
  rejectAfterTime: { min: 200, max: 300 },
  keepaliveTimeout: { min: 10, max: 18 },
  maxHandshakeAttempts: { min: 12, max: 16 },
};

describe("AWG generator settings", () => {
  it("provides an independently editable, valid starting point for every preset", () => {
    const presets = awgGeneratorPresets();
    expect(presets.map(({ id }) => id)).toEqual([
      "issued",
      "dns_response",
      "dns_response_random_ttl",
      "dns_response_randomized",
      "dns_query",
      "stun",
      "no_i",
      "randomized",
      "amnezia_default",
      "dns_query_aaaa",
      "dns_query_aaaa_full",
      "dns_query_https",
      "dns_query_https_full",
      "dns_query_burst",
      "dns_query_burst_full",
      "dns_query_stun",
      "dns_query_stun_full",
      "stun_dns_response",
      "stun_dns_response_full",
      "noise",
      "noise_full",
      "custom",
    ]);
    for (const { id, settings } of presets) {
      expect(awgGeneratorSettingsSchema.parse(settings).preset).toBe(id);
    }
    presets[0]!.settings.mtu = 1400;
    expect(awgGeneratorPresets()[0]!.settings.mtu).toBe(1280);
  });

  it.each([
    { jcMin: 9, jcMax: 8 },
    { jminMin: 75, jminMax: 74 },
    { jmaxGapMin: 0 },
    { jmaxGapMin: 50, jmaxGapMax: 40 },
    { iCount: 6 },
    { mtu: 1280.5 },
    { mtu: 1421 },
    { contentPaddingAddition: { min: 20, max: 10 } },
    { randomTrailers: false },
    { S4: 20 },
    { timings: { ...timings, maxHandshakeAttempts: { min: 1, max: 65_536 } } },
    { timings: { ...timings, rejectAfterTime: { min: 150, max: 250 } } },
    { timings: { ...timings, keepaliveTimeout: { min: 10, max: 195 } } },
  ])("rejects an invalid edit to the profile %#", (invalid) => {
    const base = awgGeneratorPresets().find(({ id }) => id === "custom")!.settings;
    expect(awgGeneratorSettingsSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
  });

  it("accepts valid custom timing ranges", () => {
    const base = awgGeneratorPresets().find(({ id }) => id === "custom")!.settings;
    expect(awgGeneratorSettingsSchema.parse({ ...base, timings }).timings).toEqual(timings);
  });

  it.each([
    ["issued", { jcMin: 2 }],
    ["dns_response", { iMode: "noise" }],
    ["dns_response_random_ttl", { iCount: 2 }],
  ] as const)("validates the fixed fields of %s while allowing MTU changes", (id, change) => {
    const base = awgGeneratorPresets().find((preset) => preset.id === id)!.settings;
    expect(awgGeneratorSettingsSchema.safeParse({ ...base, mtu: 1340 }).success).toBe(true);
    expect(awgGeneratorSettingsSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });

  it("allows an edited numeric range with the randomized preset", () => {
    const base = awgGeneratorPresets().find(({ id }) => id === "randomized")!.settings;
    expect(awgGeneratorSettingsSchema.safeParse({ ...base, jcMin: 5, jcMax: 8 }).success).toBe(true);
  });

  it("refuses randomization on the custom preset and ignores it nowhere else", () => {
    const custom = awgGeneratorPresets().find(({ id }) => id === "custom")!.settings;
    expect(awgGeneratorSettingsSchema.safeParse({ ...custom, randomizeKeys: true }).success).toBe(false);
    expect(awgGeneratorSettingsSchema.safeParse({ ...custom, randomizeKeys: false }).success).toBe(true);
    const stun = awgGeneratorPresets().find(({ id }) => id === "stun")!.settings;
    expect(awgGeneratorSettingsSchema.parse({ ...stun, randomizeKeys: false }).randomizeKeys).toBe(false);
  });

  it("keeps settings saved before the switch valid and without the flag", () => {
    const saved: Record<string, unknown> = { ...awgGeneratorPresets().find(({ id }) => id === "dns_query")!.settings };
    delete saved.randomizeKeys;
    const parsed = awgGeneratorSettingsSchema.parse(saved);
    expect(parsed.randomizeKeys).toBeUndefined();
  });

  it("turns randomization on for every preset but issued and custom", () => {
    for (const { id, settings } of awgGeneratorPresets()) {
      const expected = id === "custom" ? false : id === "issued" ? undefined : true;
      expect(settings.randomizeKeys, id).toBe(expected);
    }
  });

  it.each([
    ["dns_query_aaaa", "dns_query_aaaa", 1],
    ["dns_query_https", "dns_query_https", 1],
    ["dns_query_burst", "dns_query", 3],
    ["dns_query_stun", "dns_query_stun", 2],
    ["stun_dns_response", "stun_dns_response", 2],
    ["noise", "noise", 3],
  ] as const)("offers %s in a J-only and a full variant", (id, iMode, iCount) => {
    const presets = awgGeneratorPresets();
    const only = presets.find((preset) => preset.id === id)!.settings;
    const full = presets.find((preset) => preset.id === `${id}_full`)!.settings;
    for (const settings of [only, full]) {
      expect(awgGeneratorSettingsSchema.safeParse(settings).success).toBe(true);
      expect(settings).toMatchObject({ iMode, iCount, ...AWG_GENERATOR_STANDARD_J });
    }
    expect(only.contentPaddingAddition).toBeNull();
    expect(only.timings).toBeNull();
    expect(full.contentPaddingAddition).toEqual({ min: 1, max: 39 });
    expect(full.timings).toEqual(presets.find((preset) => preset.id === "randomized")!.settings.timings);
  });
});

describe("resolveAwgClientSettings", () => {
  const stun = awgGeneratorPresets().find(({ id }) => id === "stun")!.settings;
  const issued = awgGeneratorPresets().find(({ id }) => id === "issued")!.settings;

  it("takes each value from the nearest level that sets it", () => {
    expect(resolveAwgClientSettings({
      key: { awgMtu: 1360 },
      user: { awgGenerator: stun },
      device: { awgGenerator: issued, awgMtu: 1300 },
      address: { awgMtu: 1340 },
      node: { awgGenerator: issued, awgMtu: 1400 },
    })).toEqual({ awgGenerator: stun, profileFrom: "user", mtu: 1360, mtuFrom: "key" });
    expect(resolveAwgClientSettings({ device: { awgMtu: 1300 }, node: { awgGenerator: stun } }))
      .toEqual({ awgGenerator: stun, profileFrom: "node", mtu: 1300, mtuFrom: "device" });
  });

  it("falls back to the resolved profile's stored MTU, then 1280", () => {
    expect(resolveAwgClientSettings({ node: { awgGenerator: { ...stun, mtu: 1400 } } }))
      .toMatchObject({ profileFrom: "node", mtu: 1400, mtuFrom: "profile" });
    expect(resolveAwgClientSettings({ key: null, address: { awgGenerator: null, awgMtu: null } }))
      .toEqual({ awgGenerator: null, profileFrom: null, mtu: 1280, mtuFrom: "default" });
  });

  it("accepts only client MTUs from 1280 to 1420", () => {
    expect(awgClientMtuSchema.safeParse(1280).success).toBe(true);
    expect(awgClientMtuSchema.safeParse(1420).success).toBe(true);
    expect(awgClientMtuSchema.safeParse(1279).success).toBe(false);
    expect(awgClientMtuSchema.safeParse(1421).success).toBe(false);
    expect(awgClientMtuSchema.safeParse(1300.5).success).toBe(false);
  });
});
