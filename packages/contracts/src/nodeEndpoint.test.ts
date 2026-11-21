import { describe, expect, it } from "vitest";
import {
  awgDeviceRuleSchema,
  awgDeviceRulesSchema,
  awgGeneratorPresets,
  createKeyRequestSchema,
  deviceRuleFor,
  nodeEndpointDefaultName,
  setAwgClientConfigRequestSchema,
  updateNodeRequestSchema,
} from "./index.js";

const nodeId = "c0d2b125-0a96-479c-9a46-38e32dd86d70";
const endpointId = "64b36c19-e1b3-4f5c-9ca4-87832af3ce32";

describe("node listener selection", () => {
  it("keeps the chosen listener in an AWG 3.1 key request", () => {
    expect(createKeyRequestSchema.parse({ nodeId, endpointId }).endpointId).toBe(endpointId);
  });

  it("rejects listener selection for legacy AWG 2 keys", () => {
    expect(createKeyRequestSchema.safeParse({ nodeId, endpointId, protocol: "awg2" }).success)
      .toBe(false);
  });

  it("accepts a standalone update of a listener name", () => {
    const publicEndpoint = { action: "update", id: endpointId, name: "Second link" };
    expect(updateNodeRequestSchema.parse({ publicEndpoint })).toEqual({ publicEndpoint });
  });

  it("rejects a private listener destination", () => {
    const publicEndpoint = { action: "add", address: "127.0.0.1" };
    expect(updateNodeRequestSchema.safeParse({ publicEndpoint }).success).toBe(false);
  });
});

describe("nodeEndpointDefaultName", () => {
  it("names the first address like the node and numbers the others", () => {
    expect(nodeEndpointDefaultName("amsterdam", 1)).toBe("amsterdam");
    expect(nodeEndpointDefaultName("amsterdam", 2)).toBe("amsterdam-2");
    expect(nodeEndpointDefaultName("amsterdam", 3)).toBe("amsterdam-3");
  });

  it("stays within 120 characters, suffix included", () => {
    const long = "n".repeat(130);
    expect(nodeEndpointDefaultName(long, 1)).toHaveLength(120);
    expect(nodeEndpointDefaultName(long, 2)).toHaveLength(120);
    expect(nodeEndpointDefaultName(long, 2).endsWith("-2")).toBe(true);
  });
});

describe("AWG client settings per device type", () => {
  const stun = awgGeneratorPresets().find(({ id }) => id === "stun")!.settings;

  it("deviceRuleFor ignores unspecified and invalid rules", () => {
    const rules = { ios: { awgGenerator: stun, awgMtu: 1340 }, android: { awgMtu: 1360 } };
    expect(deviceRuleFor(rules, "ios")).toEqual({ awgGenerator: stun, awgMtu: 1340 });
    expect(deviceRuleFor(rules, "android")).toEqual({ awgGenerator: null, awgMtu: 1360 });
    expect(deviceRuleFor(rules, "windows")).toBeNull();
    expect(deviceRuleFor({ unspecified: { awgMtu: 1360 } }, "unspecified")).toBeNull();
    expect(deviceRuleFor({ ios: { awgMtu: 9000 } }, "ios")).toBeNull();
    expect(deviceRuleFor(null, "ios")).toBeNull();
  });

  it("awgDeviceRuleSchema refuses an empty rule", () => {
    expect(awgDeviceRuleSchema.safeParse({}).success).toBe(false);
    expect(awgDeviceRuleSchema.safeParse({ awgGenerator: null, awgMtu: null }).success).toBe(false);
    expect(awgDeviceRulesSchema.safeParse({ unspecified: { awgMtu: 1300 } }).success).toBe(false);
    expect(awgDeviceRulesSchema.parse({ macos: { awgMtu: 1300 } })).toEqual({ macos: { awgGenerator: null, awgMtu: 1300 } });
  });

  it("needs a profile or an MTU to set, null meaning inherit", () => {
    expect(setAwgClientConfigRequestSchema.safeParse({}).success).toBe(false);
    expect(setAwgClientConfigRequestSchema.parse({ awgMtu: null })).toEqual({ awgMtu: null });
    expect(setAwgClientConfigRequestSchema.safeParse({ awgMtu: 1500 }).success).toBe(false);
    expect(setAwgClientConfigRequestSchema.safeParse({ awgMtu: 1300, extra: true }).success).toBe(false);
  });
});
