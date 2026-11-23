import { AWG_GENERATOR_PRESETS } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";
import { buildConfigFields, parseConfigChange, parseSettingsFile, presetRows } from "./clientConfig.js";

const custom = {
  preset: "custom",
  mtu: 1280,
  jcMin: 5,
  jcMax: 8,
  jminMin: 40,
  jminMax: 100,
  jmaxGapMin: 30,
  jmaxGapMax: 200,
  iMode: "none",
  iCount: 1,
  contentPaddingAddition: null,
  timings: null,
  randomizeKeys: true,
} as const;

describe("presetRows", () => {
  it("lists every preset with a label and description", () => {
    const rows = presetRows();
    expect(rows.map((row) => row.id)).toEqual(AWG_GENERATOR_PRESETS);
    expect(rows.every(({ label, description }) => label && description)).toBe(true);
  });
});

describe("custom settings files", () => {
  it("accepts a complete Custom settings object with a UTF-8 BOM", () => {
    expect(parseSettingsFile(`\uFEFF${JSON.stringify(custom)}`)).toEqual(custom);
  });

  it("rejects invalid JSON without echoing the input", () => {
    expect(() => parseSettingsFile("unparseable input")).toThrow("--settings-file must contain valid JSON");
  });

  it("enforces the contract's J range validation", () => {
    expect(() => parseSettingsFile(JSON.stringify({ ...custom, jcMax: 4 }))).toThrow(/jcMax.*Jc maximum/);
  });

  it("requires a Custom profile", () => {
    expect(() => parseSettingsFile(JSON.stringify({ ...custom, preset: "no_i" }))).toThrow(/"preset": "custom"/);
  });
});

describe("config-set fields", () => {
  it("changes only the randomization flag when the level already sets a Custom profile", () => {
    const change = parseConfigChange("key", ["--randomize=false"]);
    expect(buildConfigFields(change, { awgGenerator: custom, awgMtu: 1300 })).toEqual({
      awgGenerator: { ...custom, randomizeKeys: false },
    });
  });

  it("refuses to turn on randomization for an inherited profile", () => {
    const change = parseConfigChange("key", ["--randomize=true"]);
    expect(() => buildConfigFields(change, { awgGenerator: null })).toThrow(/profile already set at this level/);
  });

  it("removes the device rule when its last override is inherited", () => {
    const current = { awgDeviceRules: { linux: { awgGenerator: null, awgMtu: 1340 } } };
    const change = parseConfigChange("user", ["--device=linux", "--mtu=inherit"]);
    expect(buildConfigFields(change, current)).toEqual({ awgDeviceRules: null });
    expect(current.awgDeviceRules.linux.awgMtu).toBe(1340);
  });
});
