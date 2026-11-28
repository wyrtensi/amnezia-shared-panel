import { describe, expect, it } from "vitest";
import {
  awgDeviceRuleSchema,
  awgDeviceRulesSchema,
  awgGeneratorPresets,
  createKeyRequestSchema,
  deviceRuleFor,
  nodeEndpointDefaultName,
  pinClientConfigRequestSchema,
  selectDefaultNodeEndpoint,
  adminClientParametersSchema,
  AWG_CLIENT_PARAMETER_NAMES,
  awgClientParameterScope,
  setUserClientConfigRequestSchema,
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

  it("accepts and validates exit auto-rotation fields on add and update", () => {
    const exitA = "11111111-1111-4111-8111-111111111111";
    const exitB = "22222222-2222-4222-8222-222222222222";
    const addPayload = {
      action: "add" as const,
      address: "93.184.216.34",
      egressIpId: exitA,
      egressAutoRotateEnabled: true,
      egressAutoRotatePoolIds: [exitA, exitB],
    };
    expect(updateNodeRequestSchema.parse({ publicEndpoint: addPayload })).toEqual({
      publicEndpoint: addPayload,
    });
    const toggleOnly = {
      action: "update" as const,
      id: endpointId,
      egressAutoRotateEnabled: false,
      egressAutoRotatePoolIds: [],
    };
    expect(updateNodeRequestSchema.parse({ publicEndpoint: toggleOnly })).toEqual({
      publicEndpoint: toggleOnly,
    });
    expect(
      updateNodeRequestSchema.safeParse({
        publicEndpoint: {
          action: "update",
          id: endpointId,
          egressAutoRotatePoolIds: ["not-a-uuid"],
        },
      }).success,
    ).toBe(false);
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

describe("selectDefaultNodeEndpoint", () => {
  const primary = { id: "primary", ordinal: 1, enabled: true };
  const backup = { id: "backup", ordinal: 2, enabled: true };
  const third = { id: "third", ordinal: 3, enabled: true };

  it("uses the first policy rank for each address and falls back to ordinal", () => {
    const endpoints = [third, primary, backup];
    expect(selectDefaultNodeEndpoint(endpoints, ["backup", "primary", "backup"], null)).toBe(backup);
    expect(selectDefaultNodeEndpoint(endpoints, [], null)).toBe(primary);
    expect(endpoints).toEqual([third, primary, backup]);
  });

  it("skips disabled and disallowed addresses even if they rank first", () => {
    const disabled = { ...backup, enabled: false };
    const endpoints = [primary, disabled, third];
    const order = ["backup", "primary", "third"];
    expect(selectDefaultNodeEndpoint(endpoints, order, new Set(["backup", "third"]))).toBe(third);
    expect(selectDefaultNodeEndpoint(endpoints, order, new Set())).toBeUndefined();
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
  it("the user config request accepts device rules and rejects an empty body", () => {
    const rules = { ios: { awgMtu: 1340 } };
    expect(setUserClientConfigRequestSchema.parse({ awgDeviceRules: rules }))
      .toEqual({ awgDeviceRules: { ios: { awgGenerator: null, awgMtu: 1340 } } });
    expect(setUserClientConfigRequestSchema.parse({ awgDeviceRules: null })).toEqual({ awgDeviceRules: null });
    expect(setUserClientConfigRequestSchema.parse({ awgMtu: 1300 })).toEqual({ awgMtu: 1300 });
    expect(setUserClientConfigRequestSchema.safeParse({}).success).toBe(false);
    expect(setUserClientConfigRequestSchema.safeParse({ awgDeviceRules: { unspecified: { awgMtu: 1300 } } }).success).toBe(false);
    expect(setUserClientConfigRequestSchema.safeParse({ awgMtu: 1300, extra: 1 }).success).toBe(false);
    expect(setAwgClientConfigRequestSchema.safeParse({ awgDeviceRules: { ios: { awgMtu: 1340 } } }).success).toBe(false);
  });

  it("the pin request accepts user and device only", () => {
    expect(pinClientConfigRequestSchema.parse({ target: "user" })).toEqual({ target: "user" });
    expect(pinClientConfigRequestSchema.parse({ target: "device" })).toEqual({ target: "device" });
    expect(pinClientConfigRequestSchema.safeParse({ target: "key" }).success).toBe(false);
    expect(pinClientConfigRequestSchema.safeParse({}).success).toBe(false);
    expect(pinClientConfigRequestSchema.safeParse({ target: "user", extra: 1 }).success).toBe(false);
  });

  it("lists the client parameters in order, the server-side ones scoped server", () => {
    expect(AWG_CLIENT_PARAMETER_NAMES.slice(0, 7)).toEqual(["Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4"]);
    expect(AWG_CLIENT_PARAMETER_NAMES.at(-1)).toBe("MTU");
    expect(AWG_CLIENT_PARAMETER_NAMES).toHaveLength(23);
    expect(AWG_CLIENT_PARAMETER_NAMES.filter((name) => awgClientParameterScope(name) === "server"))
      .toEqual(["S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4"]);
    expect(adminClientParametersSchema.safeParse({
      exported: [{ name: "Jc", value: "5", scope: "client" }],
      issued: [{ name: "S1", value: null, scope: "server" }],
      settings: { profileFrom: "userDevice", mtuFrom: "profile", preset: null, mtu: 1280, deviceType: "ios", ownerId: null },
    }).success).toBe(true);
  });
});
