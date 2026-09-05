import { describe, expect, it } from "vitest";

import {
  CLIENT_PLATFORMS,
  clampWorkerPeriod,
  clientReleaseSchema,
  composeKeyDisplayName,
  isPollBoundSampleField,
  POLL_BOUND_SAMPLE_FIELDS,
  POLL_BOUND_SAMPLE_LABELS,
  sampleBelowPoll,
  WORKER_PERIOD_FIELDS,
  WORKER_PERIOD_FIELD_NAMES,
  workerPeriodOverridesSchema,
  createKeyRequestSchema,
  customRoutesSchema,
  DEVICE_TYPE_ORDER,
  deviceTypeSchema,
  deviceSupportsRouteProfiles,
  globalRoutesSchema,
  GUIDE_AUDIENCES,
  keyLimitModeSchema,
  keyNameDisplaySchema,
  LEGACY_DEVICE_TYPE_REPLACEMENT,
  MAX_GLOBAL_CIDRS,
  MAX_GLOBAL_DOMAINS,
  MAX_ORDERED_NODES,
  MAX_RECOMMENDED_NODES,
  nodeOrderSchema,
  recommendedNodeIdsSchema,
  installGuideVideosSchema,
  installVideoEmbed,
  isIpLiteral,
  isIpv4Literal,
  isPublishableAgentImage,
  nodeAgentUpdateRequestSchema,
  nodeAgentUpdateStatusSchema,
  MIN_AWG3_CLIENT_VERSION,
  nodeHostMetricsSchema,
  nodeRunsCheck,
  nodeKeyLimitsSchema,
  nodePublicAddressSchema,
  portalPolicyOverrideSchema,
  portalPolicySchema,
  quotaRequestSchema,
  replaceLegacyDeviceType,
  RETIRED_STORED_DEVICE_TYPES,
  ROUTE_DOMAINS_UNSUPPORTED,
  ROUTE_PROFILE_UNSUPPORTED_DEVICES,
  rulesRefreshStatusSchema,
  CHECK_ASSERTION_TYPES,
  checkAssertionSchema,
  describeAssertion,
  serviceCheckSchema,
  serviceCheckUserStateSchema,
  unsupportedAssertionTypes,
  type CheckAssertion,
  setUserLimitRequestSchema,
  toUserCheckState,
  updateCustomRoutesRequestSchema,
  updateGlobalRoutesRequestSchema,
  updateServiceCheckRequestSchema,
  accessDomainListSchema,
  accessDomainSchema,
  normalizeAccessDomain,
} from "./index.js";

describe("createKeyRequestSchema", () => {
  it("normalizes optional device data and applies safe defaults", () => {
    const parsed = createKeyRequestSchema.parse({
      nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
      deviceLabel: "  Main laptop  ",
    });

    expect(parsed).toEqual({
      nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
      protocol: "awg3",
      deviceType: "unspecified",
      deviceLabel: "Main laptop",
      routeProfile: "full_tunnel",
      nameDisplay: { server: true, label: true, number: false },
    });
  });

  it("rejects an empty device label instead of storing meaningless metadata", () => {
    const result = createKeyRequestSchema.safeParse({
      nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
      deviceLabel: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported protocols and devices", () => {
    expect(
      createKeyRequestSchema.safeParse({
        nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
        protocol: "wireguard",
      }).success,
    ).toBe(false);
    expect(
      createKeyRequestSchema.safeParse({
        nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
        deviceType: "router",
      }).success,
    ).toBe(false);
  });
});

describe("quotaRequestSchema", () => {
  it("accepts a concrete increase request with a meaningful reason", () => {
    expect(
      quotaRequestSchema.parse({
        requestedLimit: 8,
        reason: "Need separate test phones for Android releases.",
      }),
    ).toEqual({
      requestedLimit: 8,
      reason: "Need separate test phones for Android releases.",
    });
  });

  it("treats the reason as optional (any short note, or none, is accepted)", () => {
    expect(quotaRequestSchema.parse({ requestedLimit: 8 })).toEqual({
      requestedLimit: 8,
    });
    expect(
      quotaRequestSchema.safeParse({ requestedLimit: 8, reason: "more" }).success,
    ).toBe(true);
  });

  it("targets one server when a node id is given", () => {
    const nodeId = "11111111-1111-4111-8111-111111111111";
    expect(quotaRequestSchema.parse({ requestedLimit: 3, nodeId })).toEqual({
      requestedLimit: 3,
      nodeId,
    });
  });

  it("treats an omitted or explicitly null node as every server", () => {
    expect(quotaRequestSchema.parse({ requestedLimit: 3 }).nodeId).toBe(
      undefined,
    );
    expect(
      quotaRequestSchema.parse({ requestedLimit: 3, nodeId: null }).nodeId,
    ).toBeNull();
  });

  it("rejects a node id that is not a uuid", () => {
    expect(
      quotaRequestSchema.safeParse({ requestedLimit: 3, nodeId: "node-a" })
        .success,
    ).toBe(false);
  });

  it("rejects an out-of-range limit or an over-long reason", () => {
    expect(quotaRequestSchema.safeParse({ requestedLimit: 0 }).success).toBe(
      false,
    );
    expect(
      quotaRequestSchema.safeParse({ requestedLimit: 2000 }).success,
    ).toBe(false);
    expect(
      quotaRequestSchema.safeParse({
        requestedLimit: 8,
        reason: "x".repeat(1001),
      }).success,
    ).toBe(false);
  });
});

describe("portalPolicySchema", () => {
  it("fills every policy field so authorization never depends on UI defaults", () => {
    expect(portalPolicySchema.parse({})).toEqual({
      allowKeyCreation: true,
      allowNodeSelection: true,
      allowedProtocols: ["awg3"],
      allowRouteProfileSelection: true,
      allowCustomRoutes: true,
      allowConfigRedownload: true,
      allowQrDownload: true,
      allowConfDownload: true,
      allowSelfRevoke: true,
      showPublicKey: false,
      showLastUsed: true,
      showTraffic: true,
      showNodeStatus: true,
      showNodeAddress: false,
      showInstallReminder: true,
      // No recordings until an admin adds them; the guide reads without one.
      installGuideVideos: {},
      keyLimitMode: "per_node",
    });
  });

  it("defaults the key limit mode to per-node so existing deployments keep their behaviour", () => {
    expect(portalPolicySchema.parse({}).keyLimitMode).toBe("per_node");
    expect(portalPolicySchema.parse({ keyLimitMode: "global" }).keyLimitMode).toBe(
      "global",
    );
    expect(portalPolicySchema.safeParse({ keyLimitMode: "total" }).success).toBe(
      false,
    );
    // zod's `.partial()` makes a key optional but does not strip its default,
    // so the override schema materializes the mode exactly like every other
    // defaulted policy field. "Inherit" is an override object that never went
    // through this schema with the key absent, not a parse result.
    expect(portalPolicySchema.partial().parse({}).keyLimitMode).toBe("per_node");
    expect(
      portalPolicySchema.partial().parse({ keyLimitMode: "global" }).keyLimitMode,
    ).toBe("global");
  });

  it("enables every self-service capability out of the box", () => {
    const policy = portalPolicySchema.parse({});
    for (const field of [
      "allowKeyCreation",
      "allowNodeSelection",
      "allowRouteProfileSelection",
      "allowCustomRoutes",
      "allowConfigRedownload",
      "allowQrDownload",
      "allowConfDownload",
      "allowSelfRevoke",
      "showLastUsed",
      "showTraffic",
    ] as const) {
      expect(policy[field], field).toBe(true);
    }
    // The public key and the node's address stay hidden until an admin turns
    // them on. Unlike T8's showNodeStatus (default true), a node's address is
    // operational information about the fleet, so an upgrade must not start
    // showing it to every user on an existing deployment.
    expect(policy.showPublicKey).toBe(false);
    expect(policy.showNodeAddress).toBe(false);
  });

  it("keeps the install reminder on unless an operator turns it off", () => {
    // Not an `allow*` and not a capability: it interrupts a regular user after
    // each of their first keys to say the AmneziaVPN client must be installed
    // or updated. Default ON because the failure it prevents is silent — an
    // old client starts, looks healthy, and never reads an AWG 3.1 key — so an
    // upgrade must not remove the warning from a panel that never set it.
    expect(portalPolicySchema.parse({}).showInstallReminder).toBe(true);
    expect(
      portalPolicySchema.parse({ showInstallReminder: false })
        .showInstallReminder,
    ).toBe(false);
    // Per-user override comes free from `.partial()`, like every other flag.
    expect(
      portalPolicySchema.partial().parse({ showInstallReminder: false })
        .showInstallReminder,
    ).toBe(false);
  });
});

describe("nodePublicAddressSchema", () => {
  it("accepts a DNS host with a resolved IPv4", () => {
    expect(
      nodePublicAddressSchema.parse({
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
        publicIpResolvedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toEqual({
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.10",
      publicIpResolvedAt: "2026-09-03T00:00:00.000Z",
    });
  });

  it("accepts an unreported node (all null) and an unresolved host", () => {
    expect(
      nodePublicAddressSchema.parse({
        publicHost: null,
        publicIp: null,
        publicIpResolvedAt: null,
      }),
    ).toEqual({ publicHost: null, publicIp: null, publicIpResolvedAt: null });
    expect(
      nodePublicAddressSchema.parse({
        publicHost: "vpn.example.com",
        publicIp: null,
        publicIpResolvedAt: null,
      }),
    ).toEqual({
      publicHost: "vpn.example.com",
      publicIp: null,
      publicIpResolvedAt: null,
    });
  });

  it("rejects a publicIp that is not an IP literal", () => {
    expect(
      nodePublicAddressSchema.safeParse({
        publicHost: "vpn.example.com",
        publicIp: "vpn.example.com",
        publicIpResolvedAt: null,
      }).success,
    ).toBe(false);
  });

  it("classifies an IPv6 literal as an IP but refuses to store one as publicIp", () => {
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(
      nodePublicAddressSchema.safeParse({
        publicHost: "v6.example.com",
        publicIp: "2001:db8::1",
        publicIpResolvedAt: "2026-09-03T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("isIpLiteral", () => {
  it("recognises IPv4 and IPv6 literals", () => {
    expect(isIpLiteral("203.0.113.10")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
  });

  it("treats DNS names and junk as non-literals", () => {
    expect(isIpLiteral("vpn.example.com")).toBe(false);
    expect(isIpLiteral("")).toBe(false);
    expect(isIpLiteral("203.0.113.10:51820")).toBe(false);
  });

  it("narrows to IPv4 only for what may be stored as publicIp", () => {
    expect(isIpv4Literal("203.0.113.10")).toBe(true);
    expect(isIpv4Literal("2001:db8::1")).toBe(false);
    expect(isIpv4Literal("vpn.example.com")).toBe(false);
  });
});

describe("customRoutesSchema", () => {
  it("normalizes bare IPs, trims, lowercases, and defaults both profiles", () => {
    const parsed = customRoutesSchema.parse({
      ru_blacklist: {
        cidrs: [" 1.2.3.4 ", "10.0.0.0/8", "2001:db8::"],
        domains: ["Example.COM", " sub.example.org "],
      },
    });
    expect(parsed.ru_blacklist.cidrs).toEqual([
      "1.2.3.4/32",
      "10.0.0.0/8",
      "2001:db8::/128",
    ]);
    expect(parsed.ru_blacklist.domains).toEqual([
      "example.com",
      "sub.example.org",
    ]);
    // The omitted profile is filled with empty lists.
    expect(parsed.ru_whitelist).toEqual({ cidrs: [], domains: [] });
  });

  it("rejects malformed CIDRs and domains", () => {
    expect(() =>
      customRoutesSchema.parse({ ru_whitelist: { cidrs: ["10.0.0.0/33"] } }),
    ).toThrow();
    expect(() =>
      customRoutesSchema.parse({ ru_whitelist: { domains: ["*.example.com"] } }),
    ).toThrow();
  });
});

describe("keyNameDisplaySchema", () => {
  it("defaults to server + label with the number switched off", () => {
    expect(keyNameDisplaySchema.parse({})).toEqual({
      server: true,
      label: true,
      number: false,
    });
  });

  it("keeps every explicit choice, including all-off", () => {
    expect(
      keyNameDisplaySchema.parse({ server: false, label: false, number: false }),
    ).toEqual({ server: false, label: false, number: false });
  });

  it("rejects non-boolean parts", () => {
    expect(keyNameDisplaySchema.safeParse({ server: "yes" }).success).toBe(false);
  });
});

describe("composeKeyDisplayName", () => {
  const all = { server: true, label: true, number: true };

  it("joins the enabled parts in a fixed order with single spaces", () => {
    expect(
      composeKeyDisplayName({
        serverName: "Frankfurt",
        label: "Main laptop",
        keyNumber: 3,
        display: all,
      }),
    ).toBe("Frankfurt Main laptop #3");
  });

  it("reproduces the historical name for keys pinned to server + number", () => {
    expect(
      composeKeyDisplayName({
        serverName: "Frankfurt",
        label: "Main laptop",
        keyNumber: 3,
        display: { server: true, label: false, number: true },
      }),
    ).toBe("Frankfurt #3");
  });

  it("uses the new default of server + label", () => {
    expect(
      composeKeyDisplayName({
        serverName: "Frankfurt",
        label: "Main laptop",
        keyNumber: 3,
        display: { server: true, label: true, number: false },
      }),
    ).toBe("Frankfurt Main laptop");
  });

  it("skips enabled parts that have no value", () => {
    expect(
      composeKeyDisplayName({
        serverName: "Frankfurt",
        label: null,
        keyNumber: null,
        display: all,
      }),
    ).toBe("Frankfurt");
    expect(
      composeKeyDisplayName({
        serverName: "Frankfurt",
        label: "   ",
        keyNumber: 2,
        display: all,
      }),
    ).toBe("Frankfurt #2");
  });

  it("falls back to server, then label, then number when nothing is enabled", () => {
    const off = { server: false, label: false, number: false };
    expect(
      composeKeyDisplayName({
        serverName: "Frankfurt",
        label: "Laptop",
        keyNumber: 3,
        display: off,
      }),
    ).toBe("Frankfurt");
    expect(
      composeKeyDisplayName({ serverName: "", label: "Laptop", keyNumber: 3, display: off }),
    ).toBe("Laptop");
    expect(
      composeKeyDisplayName({ serverName: "", label: "", keyNumber: 3, display: off }),
    ).toBe("#3");
  });

  it("never returns an empty connection name", () => {
    expect(
      composeKeyDisplayName({
        serverName: "  ",
        label: null,
        keyNumber: null,
        display: { server: true, label: true, number: true },
      }),
    ).toBe("VPN");
  });
});

describe("globalRoutesSchema", () => {
  it("defaults both profiles to empty add/exclude lists", () => {
    expect(globalRoutesSchema.parse({})).toEqual({
      ru_whitelist: {
        add: { cidrs: [], domains: [] },
        exclude: { cidrs: [], domains: [] },
      },
      ru_blacklist: {
        add: { cidrs: [], domains: [] },
        exclude: { cidrs: [], domains: [] },
      },
    });
  });

  it("normalizes entries exactly like the per-user custom routes do", () => {
    const parsed = globalRoutesSchema.parse({
      ru_whitelist: {
        add: { cidrs: [" 1.2.3.4 "], domains: ["Example.COM"] },
        exclude: { cidrs: ["2001:db8::"], domains: [" sub.example.org "] },
      },
    });

    expect(parsed.ru_whitelist.add.cidrs).toEqual(["1.2.3.4/32"]);
    expect(parsed.ru_whitelist.add.domains).toEqual(["example.com"]);
    expect(parsed.ru_whitelist.exclude.cidrs).toEqual(["2001:db8::/128"]);
    expect(parsed.ru_whitelist.exclude.domains).toEqual(["sub.example.org"]);
    expect(parsed.ru_blacklist).toEqual({
      add: { cidrs: [], domains: [] },
      exclude: { cidrs: [], domains: [] },
    });
  });

  it("rejects malformed CIDRs and wildcard domains", () => {
    expect(
      globalRoutesSchema.safeParse({
        ru_whitelist: { add: { cidrs: ["10.0.0.0/33"] } },
      }).success,
    ).toBe(false);
    expect(
      globalRoutesSchema.safeParse({
        ru_blacklist: { exclude: { domains: ["*.example.com"] } },
      }).success,
    ).toBe(false);
  });

  it("caps each list well above the per-user limits", () => {
    const cidrs = Array.from(
      { length: MAX_GLOBAL_CIDRS },
      (_, index) => `10.${Math.floor(index / 256)}.${index % 256}.0/24`,
    );
    expect(
      globalRoutesSchema.safeParse({ ru_whitelist: { add: { cidrs } } }).success,
    ).toBe(true);
    expect(
      globalRoutesSchema.safeParse({
        ru_whitelist: { add: { cidrs: [...cidrs, "203.0.113.0/24"] } },
      }).success,
    ).toBe(false);

    const domains = Array.from(
      { length: MAX_GLOBAL_DOMAINS + 1 },
      (_, index) => `host${index}.example.com`,
    );
    expect(
      globalRoutesSchema.safeParse({ ru_blacklist: { exclude: { domains } } })
        .success,
    ).toBe(false);
  });

  // Stored rows written before route rules became addresses-only must keep
  // parsing, or a deployment holding them could not read its own overrides.
  it("still parses a stored payload that carries domains", () => {
    expect(
      globalRoutesSchema.safeParse({
        ru_whitelist: { add: { domains: ["example.com"] } },
      }).success,
    ).toBe(true);
  });
});

describe("route rules refuse site names on write", () => {
  it("lets the admin update through when every list is addresses only", () => {
    expect(
      updateGlobalRoutesRequestSchema.safeParse({
        ru_whitelist: { add: { cidrs: ["1.2.3.4"] } },
      }).success,
    ).toBe(true);
  });

  it("refuses a global add or exclude list that carries a domain", () => {
    for (const section of ["add", "exclude"] as const) {
      const result = updateGlobalRoutesRequestSchema.safeParse({
        ru_blacklist: { [section]: { domains: ["example.com"] } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(ROUTE_DOMAINS_UNSUPPORTED);
      expect(result.error?.issues[0]?.path).toEqual([
        "ru_blacklist",
        section,
        "domains",
      ]);
    }
  });

  it("refuses a per-user list that carries a domain, and says where to go", () => {
    const result = updateCustomRoutesRequestSchema.safeParse({
      ru_whitelist: { cidrs: ["1.2.3.4"], domains: ["example.com"] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(ROUTE_DOMAINS_UNSUPPORTED);
    expect(result.error?.issues[0]?.path).toEqual(["ru_whitelist", "domains"]);
    // The refusal has to name the way that does work, or it is just a wall.
    expect(ROUTE_DOMAINS_UNSUPPORTED).toContain("full-traffic key");
    expect(ROUTE_DOMAINS_UNSUPPORTED).toContain("AmneziaVPN app");
  });

  it("lets a per-user update through once the domains are cleared", () => {
    expect(
      updateCustomRoutesRequestSchema.safeParse({
        ru_whitelist: { cidrs: ["1.2.3.4"], domains: [] },
      }).success,
    ).toBe(true);
  });
});

describe("nodeKeyLimitsSchema", () => {
  const nodeId = "2c65d1c2-e077-4d14-bba2-03e67ecba9fe";

  it("accepts a map of node id to limit, zero included", () => {
    expect(nodeKeyLimitsSchema.parse({ [nodeId]: 0 })).toEqual({ [nodeId]: 0 });
    expect(nodeKeyLimitsSchema.parse({ [nodeId]: 1_000 })).toEqual({
      [nodeId]: 1_000,
    });
  });

  it("rejects a non-uuid node id and an out-of-range limit", () => {
    expect(nodeKeyLimitsSchema.safeParse({ "not-a-uuid": 3 }).success).toBe(false);
    expect(nodeKeyLimitsSchema.safeParse({ [nodeId]: -1 }).success).toBe(false);
    expect(nodeKeyLimitsSchema.safeParse({ [nodeId]: 1_001 }).success).toBe(false);
    expect(nodeKeyLimitsSchema.safeParse({ [nodeId]: 1.5 }).success).toBe(false);
  });
});

describe("setUserLimitRequestSchema", () => {
  const nodeId = "2c65d1c2-e077-4d14-bba2-03e67ecba9fe";

  it("keeps the optional fields absent so 'unchanged' stays distinguishable", () => {
    const parsed = setUserLimitRequestSchema.parse({ keyLimitOverride: 3 });
    expect(parsed).toEqual({ keyLimitOverride: 3 });
    expect("allowedNodeIds" in parsed).toBe(false);
    expect("nodeKeyLimits" in parsed).toBe(false);
  });

  it("keeps null apart from an empty list for node availability", () => {
    expect(
      setUserLimitRequestSchema.parse({
        keyLimitOverride: null,
        allowedNodeIds: null,
      }).allowedNodeIds,
    ).toBeNull();
    expect(
      setUserLimitRequestSchema.parse({
        keyLimitOverride: null,
        allowedNodeIds: [],
      }).allowedNodeIds,
    ).toEqual([]);
  });

  it("accepts a full payload and rejects a missing flat override", () => {
    expect(
      setUserLimitRequestSchema.parse({
        keyLimitOverride: 4,
        allowedNodeIds: [nodeId],
        nodeKeyLimits: { [nodeId]: 2 },
      }),
    ).toEqual({
      keyLimitOverride: 4,
      allowedNodeIds: [nodeId],
      nodeKeyLimits: { [nodeId]: 2 },
    });
    expect(setUserLimitRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a per-user key limit mode, null to clear it, or nothing to leave it alone", () => {
    expect(
      setUserLimitRequestSchema.parse({ keyLimitOverride: 3, keyLimitMode: "global" })
        .keyLimitMode,
    ).toBe("global");
    expect(
      setUserLimitRequestSchema.parse({ keyLimitOverride: 3, keyLimitMode: null })
        .keyLimitMode,
    ).toBeNull();
    expect(
      setUserLimitRequestSchema.parse({ keyLimitOverride: 3 }).keyLimitMode,
    ).toBeUndefined();
    expect(
      setUserLimitRequestSchema.safeParse({ keyLimitOverride: 3, keyLimitMode: "x" })
        .success,
    ).toBe(false);
    expect(keyLimitModeSchema.options).toEqual(["per_node", "global"]);
  });
});

describe("rulesRefreshStatusSchema", () => {
  it("accepts the idle state and a completed run", () => {
    expect(
      rulesRefreshStatusSchema.parse({
        status: "idle",
        queuedAt: null,
        completedAt: null,
        lastError: null,
      }).status,
    ).toBe("idle");
    expect(
      rulesRefreshStatusSchema.safeParse({
        status: "completed",
        queuedAt: "2026-09-01T10:00:00.000Z",
        completedAt: "2026-09-01T10:00:05.000Z",
        lastError: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a status the worker can never report", () => {
    expect(
      rulesRefreshStatusSchema.safeParse({
        status: "running",
        queuedAt: null,
        completedAt: null,
        lastError: null,
      }).success,
    ).toBe(false);
  });
});

// T14: the device type names a PLATFORM. This literal is duplicated on purpose
// in apps/cli/src/args.ts (the CLI ships with no dependencies), and both copies
// are pinned to this same array — change one, change the other.
describe("deviceTypeSchema", () => {
  it("names platforms, not form factors", () => {
    expect(deviceTypeSchema.options).toEqual([
      "android",
      "ios",
      "macos",
      "windows",
      "linux",
      "other",
      "unspecified",
    ]);
  });

  it("offers exactly six choices, in the order the operator asked for", () => {
    expect([...DEVICE_TYPE_ORDER]).toEqual([
      "android",
      "ios",
      "macos",
      "windows",
      "linux",
      "other",
    ]);
  });

  it("never offers the stored default as a choice", () => {
    expect(DEVICE_TYPE_ORDER).not.toContain("unspecified");
  });

  // This is the assertion the "Планшет" bug needed: whatever the UI and the CLI
  // offer must survive the request schema the route parses.
  it("accepts every offered choice through the create-key request", () => {
    for (const device of DEVICE_TYPE_ORDER) {
      const result = createKeyRequestSchema.safeParse({
        nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
        deviceType: device,
      });
      expect(result.success, device).toBe(true);
    }
  });

  it("rejects every retired device type instead of coercing it", () => {
    for (const legacy of Object.keys(LEGACY_DEVICE_TYPE_REPLACEMENT)) {
      const result = createKeyRequestSchema.safeParse({
        nodeId: "2c65d1c2-e077-4d14-bba2-03e67ecba9fe",
        deviceType: legacy,
      });
      expect(result.success, legacy).toBe(false);
    }
  });
});

describe("replaceLegacyDeviceType", () => {
  it("keeps the platform it knew and refuses to invent one it did not", () => {
    expect(replaceLegacyDeviceType("iphone")).toBe("ios");
    expect(replaceLegacyDeviceType("laptop")).toBe("unspecified");
    expect(replaceLegacyDeviceType("desktop")).toBe("unspecified");
    expect(replaceLegacyDeviceType("phone")).toBe("unspecified");
    expect(replaceLegacyDeviceType("tablet")).toBe("unspecified");
  });

  it("is null for anything that was never a device type", () => {
    expect(replaceLegacyDeviceType("router")).toBeNull();
    expect(replaceLegacyDeviceType("")).toBeNull();
  });

  it("is null for a current value, so callers cannot double-map", () => {
    for (const device of deviceTypeSchema.options) {
      expect(replaceLegacyDeviceType(device), device).toBeNull();
    }
  });

  it("only ever produces a current device type", () => {
    for (const replacement of Object.values(LEGACY_DEVICE_TYPE_REPLACEMENT)) {
      expect(deviceTypeSchema.options).toContain(replacement);
    }
  });

  it("lists as storable only the values the old DB enum could hold", () => {
    // "tablet" was offered by the wizard but never existed in the enum, so no
    // stored row can hold it and the migration must not mention it.
    expect([...RETIRED_STORED_DEVICE_TYPES]).toEqual([
      "desktop",
      "laptop",
      "iphone",
      "phone",
    ]);
    for (const value of RETIRED_STORED_DEVICE_TYPES) {
      expect(LEGACY_DEVICE_TYPE_REPLACEMENT).toHaveProperty(value);
    }
  });
});

describe("clientReleaseSchema", () => {
  const asset = {
    url: "https://github.com/amnezia-vpn/amnezia-client/releases/download/x/y.exe",
    kind: "installer" as const,
    fileName: "y.exe",
    sizeBytes: 91_991_200,
  };
  const release = {
    version: "9.9.9.9",
    releaseUrl: "https://github.com/amnezia-vpn/amnezia-client/releases/tag/9.9.9.9",
    publishedAt: "2026-08-21T14:47:49.000Z",
    fallback: false,
    resolvedAt: "2026-09-02T09:00:00.000Z",
    downloads: CLIENT_PLATFORMS.map((platform) => ({
      platform,
      primary: asset,
      alternate: null,
    })),
  };

  it("accepts a fully resolved release", () => {
    expect(clientReleaseSchema.safeParse(release).success).toBe(true);
  });

  it("accepts the version-free fallback shape", () => {
    expect(
      clientReleaseSchema.safeParse({
        ...release,
        version: null,
        publishedAt: null,
        fallback: true,
        downloads: CLIENT_PLATFORMS.map((platform) => ({
          platform,
          primary: {
            url: "https://github.com/amnezia-vpn/amnezia-client/releases/latest",
            kind: "releasePage" as const,
            fileName: null,
            sizeBytes: null,
          },
          alternate: null,
        })),
      }).success,
    ).toBe(true);
  });

  it("covers exactly the supported platforms", () => {
    expect([...CLIENT_PLATFORMS].sort()).toEqual([
      "android",
      "ios",
      "linux",
      "macos",
      "windows",
    ]);
    // One entry per platform — the UI maps the array directly.
    expect(
      clientReleaseSchema.safeParse({ ...release, downloads: [] }).success,
    ).toBe(false);
  });

  it("rejects an asset kind the resolver can never produce", () => {
    expect(
      clientReleaseSchema.safeParse({
        ...release,
        downloads: [
          { platform: "windows", primary: { ...asset, kind: "torrent" }, alternate: null },
          ...release.downloads.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL download target", () => {
    expect(
      clientReleaseSchema.safeParse({
        ...release,
        downloads: [
          { platform: "windows", primary: { ...asset, url: "javascript:alert(1)" }, alternate: null },
          ...release.downloads.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("pins the AmneziaWG 3.1 client floor from AGENTS.md", () => {
    expect(MIN_AWG3_CLIENT_VERSION).toBe("5.0.1.5");
  });
});

// D9: the one fact behind the wizard's greyed-out route profiles, the key
// card's warning and the CLI's warning. Kept here, beside deviceTypeSchema,
// because three callers need the same answer and apps/web holds no facts.
describe("deviceSupportsRouteProfiles", () => {
  it("says the Apple mobile platform cannot use route profiles", () => {
    // "ios" covers iPhone AND iPad — one value, so iPad is covered by
    // construction rather than by a guess.
    expect(deviceSupportsRouteProfiles("ios")).toBe(false);
  });

  it("says every other declared device type can", () => {
    for (const device of deviceTypeSchema.options) {
      if (device === "ios") continue;
      expect(deviceSupportsRouteProfiles(device), device).toBe(true);
    }
  });

  it("treats an unknown device type as supported", () => {
    // A retired value can still arrive from a browser tab left open across a
    // deploy, and future values may appear before this rule is revisited.
    // Nothing is disabled without a recorded observation.
    expect(deviceSupportsRouteProfiles("laptop")).toBe(true);
    expect(deviceSupportsRouteProfiles("")).toBe(true);
  });

  it("lists only what has actually been observed to fail", () => {
    expect([...ROUTE_PROFILE_UNSUPPORTED_DEVICES]).toEqual(["ios"]);
    // Every entry must be a real device type, or the wizard would grey out
    // nothing while looking like it does.
    for (const device of ROUTE_PROFILE_UNSUPPORTED_DEVICES) {
      expect(deviceTypeSchema.safeParse(device).success, device).toBe(true);
    }
  });
});

describe("installGuideVideos", () => {
  it("is empty by default, so a panel with no recordings still works", () => {
    const policy = portalPolicySchema.parse({});
    expect(policy.installGuideVideos).toEqual({});
    for (const audience of GUIDE_AUDIENCES) {
      expect(policy.installGuideVideos[audience] ?? null).toBeNull();
    }
  });

  it("covers exactly the audiences the guide is organised into", () => {
    expect([...GUIDE_AUDIENCES]).toEqual(["desktop", "android", "ios"]);
    expect(Object.keys(installGuideVideosSchema.shape).sort()).toEqual(
      [...GUIDE_AUDIENCES].sort(),
    );
  });

  it("accepts an http(s) recording per audience", () => {
    const parsed = portalPolicySchema.parse({
      installGuideVideos: {
        desktop: "https://videos.example.com/desktop.mp4",
        ios: "https://videos.example.com/ios.mp4",
      },
    });
    expect(parsed.installGuideVideos.desktop).toBe(
      "https://videos.example.com/desktop.mp4",
    );
    expect(parsed.installGuideVideos.android ?? null).toBeNull();
  });

  it("rejects a scheme that would execute instead of play", () => {
    expect(
      portalPolicySchema.safeParse({
        installGuideVideos: { desktop: "javascript:alert(1)" },
      }).success,
    ).toBe(false);
  });
});

describe("installVideoEmbed", () => {
  it("turns a Drive share link into its embeddable preview", () => {
    expect(
      installVideoEmbed(
        "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/view?usp=sharing",
      ),
    ).toEqual({
      kind: "drive",
      src: "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/preview",
    });
  });

  it("accepts the older open?id= share shape", () => {
    expect(
      installVideoEmbed("https://drive.google.com/open?id=1ExampleDriveFileIdForTests"),
    ).toEqual({
      kind: "drive",
      src: "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/preview",
    });
  });

  it("drops everything after the id, so no query rides into the frame", () => {
    const embed = installVideoEmbed(
      "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/view?x=1#y",
    );
    expect(embed?.src).toBe(
      "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/preview",
    );
  });

  it("keeps a self-hosted file as a real video element", () => {
    expect(installVideoEmbed("https://cdn.example.com/guide.mp4")).toEqual({
      kind: "file",
      src: "https://cdn.example.com/guide.mp4",
    });
  });

  it("is null for anything that cannot be played", () => {
    // A mistyped setting shows the placeholder rather than a broken frame.
    expect(installVideoEmbed(null)).toBeNull();
    expect(installVideoEmbed("")).toBeNull();
    expect(installVideoEmbed("not a url")).toBeNull();
    expect(installVideoEmbed("javascript:alert(1)")).toBeNull();
    // A Drive URL with no recoverable file id.
    expect(installVideoEmbed("https://drive.google.com/drive/my-drive")).toBeNull();
  });
});

// A trap worth pinning, because it reads the other way round: zod's .partial()
// makes every key optional but leaves its .default() in place, so parsing an
// empty override yields every defaulted field rather than nothing. Callers that
// persist the parse result must therefore keep only the fields the caller named
// -- see the set-policy route -- or "absent means inherit" quietly stops being
// true. Pinned so nobody reads the schema and assumes otherwise.
describe("the portal policy override schema", () => {
  it("materialises defaults rather than staying empty", () => {
    const parsed = portalPolicyOverrideSchema.parse({});
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  it("still carries a value the caller did name", () => {
    expect(portalPolicyOverrideSchema.parse({ allowKeyCreation: false })).toMatchObject(
      { allowKeyCreation: false },
    );
  });
});

// S8: a user may ask for a bigger number, never for a different KIND of limit.
// The mode decides how every limit in the panel is read, so "the UI does not
// offer it" is not the guarantee -- this is.
describe("a quota request cannot carry a key limit mode", () => {
  it("refuses a smuggled keyLimitMode", () => {
    const result = quotaRequestSchema.safeParse({
      requestedLimit: 5,
      keyLimitMode: "global",
    });
    expect(result.success).toBe(false);
  });

  it("still accepts the three fields the panel sends", () => {
    expect(
      quotaRequestSchema.safeParse({
        requestedLimit: 5,
        nodeId: null,
        reason: "need more",
      }).success,
    ).toBe(true);
  });
});

describe("recommendedNodeIdsSchema", () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("accepts a list of node uuids, including the empty list", () => {
    expect(recommendedNodeIdsSchema.parse([])).toEqual([]);
    expect(recommendedNodeIdsSchema.parse([id(1), id(2)])).toEqual([
      id(1),
      id(2),
    ]);
  });

  it("rejects non-uuid entries and null", () => {
    expect(() => recommendedNodeIdsSchema.parse(["node-1"])).toThrow();
    expect(() => recommendedNodeIdsSchema.parse(null)).toThrow();
  });

  it("caps the list so a policy row cannot grow without bound", () => {
    const tooMany = Array.from({ length: MAX_RECOMMENDED_NODES + 1 }, (_, n) =>
      id(n),
    );
    expect(() => recommendedNodeIdsSchema.parse(tooMany)).toThrow();
    expect(
      recommendedNodeIdsSchema.parse(tooMany.slice(0, MAX_RECOMMENDED_NODES)),
    ).toHaveLength(MAX_RECOMMENDED_NODES);
  });
});

describe("nodeOrderSchema", () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("accepts an ordered list of node uuids, including the empty list", () => {
    expect(nodeOrderSchema.parse([])).toEqual([]);
    // Order is the payload: it must survive parsing exactly as sent.
    expect(nodeOrderSchema.parse([id(2), id(1)])).toEqual([id(2), id(1)]);
  });

  it("rejects non-uuid entries and null", () => {
    expect(() => nodeOrderSchema.parse(["node-1"])).toThrow();
    expect(() => nodeOrderSchema.parse(null)).toThrow();
  });

  it("caps the list at MAX_ORDERED_NODES", () => {
    const tooMany = Array.from({ length: MAX_ORDERED_NODES + 1 }, (_, n) =>
      id(n),
    );
    expect(() => nodeOrderSchema.parse(tooMany)).toThrow();
    expect(
      nodeOrderSchema.parse(tooMany.slice(0, MAX_ORDERED_NODES)),
    ).toHaveLength(MAX_ORDERED_NODES);
  });
});

describe("isPublishableAgentImage", () => {
  const repo = "ghcr.io/owner/repo/node-agent";
  const digest = `sha256:${"a".repeat(64)}`;

  it("accepts a digest reference for exactly the trusted repository", () => {
    expect(isPublishableAgentImage(`${repo}@${digest}`, repo)).toBe(true);
  });

  it("rejects a tag, because a tag is mutable", () => {
    // The whole point of pinning: what the admin confirmed must be what the
    // node installs, and a tag can point somewhere else by then.
    expect(isPublishableAgentImage(`${repo}:1.1.2`, repo)).toBe(false);
    expect(isPublishableAgentImage(`${repo}:latest`, repo)).toBe(false);
  });

  it("rejects another repository, however similar", () => {
    expect(isPublishableAgentImage(`ghcr.io/evil/repo/node-agent@${digest}`, repo)).toBe(
      false,
    );
    // A prefix match would accept this; the comparison is on the whole name.
    expect(isPublishableAgentImage(`${repo}-evil@${digest}`, repo)).toBe(false);
    expect(isPublishableAgentImage(`evil.io/${repo}@${digest}`, repo)).toBe(false);
  });

  it("rejects a bare image id, which names no repository at all", () => {
    expect(isPublishableAgentImage(digest, repo)).toBe(false);
  });

  it("rejects a malformed or short digest", () => {
    expect(isPublishableAgentImage(`${repo}@sha256:abc`, repo)).toBe(false);
    expect(isPublishableAgentImage(`${repo}@sha512:${"a".repeat(64)}`, repo)).toBe(
      false,
    );
    // Uppercase hex is not what any registry emits, and accepting it would
    // mean two spellings of one digest.
    expect(isPublishableAgentImage(`${repo}@sha256:${"A".repeat(64)}`, repo)).toBe(
      false,
    );
  });

  it("rejects anything carrying a scheme, whitespace or a second @", () => {
    expect(isPublishableAgentImage(`https://${repo}@${digest}`, repo)).toBe(false);
    expect(isPublishableAgentImage(` ${repo}@${digest}`, repo)).toBe(false);
    expect(isPublishableAgentImage(`${repo}@${digest} rm -rf /`, repo)).toBe(false);
    expect(isPublishableAgentImage(`${repo}@${digest}@${digest}`, repo)).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isPublishableAgentImage("", repo)).toBe(false);
  });
});

describe("nodeAgentUpdateRequestSchema", () => {
  it("carries the image the panel resolved", () => {
    const image = `ghcr.io/owner/repo/node-agent@sha256:${"b".repeat(64)}`;
    expect(nodeAgentUpdateRequestSchema.parse({ image })).toEqual({ image });
  });

  it("rejects an empty image", () => {
    expect(() => nodeAgentUpdateRequestSchema.parse({ image: "" })).toThrow();
  });
});

describe("nodeAgentUpdateStatusSchema", () => {
  it("accepts a node that has never been asked to update", () => {
    expect(
      nodeAgentUpdateStatusSchema.parse({
        state: "idle",
        image: null,
        log: "",
        updatedAt: null,
      }),
    ).toMatchObject({ state: "idle", image: null });
  });

  it("rejects a state outside the known set", () => {
    expect(() =>
      nodeAgentUpdateStatusSchema.parse({
        state: "rebooting",
        image: null,
        log: "",
        updatedAt: null,
      }),
    ).toThrow();
  });
});

describe("nodeHostMetricsSchema", () => {
  it("accepts a fully reported node and keeps big counters as strings", () => {
    const parsed = nodeHostMetricsSchema.parse({
      observedAt: "2026-09-02T10:00:00.000Z",
      agentLatencyMs: 12,
      uptimeSec: 86400,
      cpuCores: 1,
      load: [0.1, 0.2, 0.3],
      memTotalBytes: "1007681536",
      memAvailableBytes: "361267200",
      swapTotalBytes: "2147483648",
      swapUsedBytes: "325058560",
      diskTotalBytes: "10522067968",
      diskAvailableBytes: "1277952000",
      diskUsedPercent: 86,
      agentPidsCurrent: 12,
      agentPidsMax: 128,
      awg3: { up: true, peers: 2 },
      awg2: null,
      publicHost: "203.0.113.10",
      listenPorts: [51890],
      endpoint: {
        status: "reachable",
        lastHandshakeAt: "2026-09-02T09:59:30.000Z",
      },
    });

    // Byte counters cross Number.MAX_SAFE_INTEGER on a large disk and are
    // carried as decimal strings for the same reason traffic is.
    expect(parsed.memAvailableBytes).toBe("361267200");
    expect(parsed.endpoint.status).toBe("reachable");
  });

  it("accepts an older agent that reports nothing beyond the timestamp", () => {
    // Every field a node might not know is nullable, so an agent that predates
    // this feature still produces a valid snapshot instead of failing the poll.
    expect(
      nodeHostMetricsSchema.safeParse({
        observedAt: "2026-09-02T10:00:00.000Z",
        agentLatencyMs: null,
        uptimeSec: null,
        cpuCores: null,
        load: null,
        memTotalBytes: null,
        memAvailableBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
        diskTotalBytes: null,
        diskAvailableBytes: null,
        diskUsedPercent: null,
        agentPidsCurrent: null,
        agentPidsMax: null,
        awg3: null,
        awg2: null,
        publicHost: null,
        listenPorts: null,
        endpoint: { status: "unknown", lastHandshakeAt: null },
      }).success,
    ).toBe(true);
  });

  it("rejects values a host cannot actually report", () => {
    const base = {
      observedAt: "2026-09-02T10:00:00.000Z",
      agentLatencyMs: null,
      uptimeSec: null,
      cpuCores: null,
      load: null,
      memTotalBytes: null,
      memAvailableBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
      diskTotalBytes: null,
      diskAvailableBytes: null,
      diskUsedPercent: null,
      agentPidsCurrent: null,
      agentPidsMax: null,
      awg3: null,
      awg2: null,
      publicHost: null,
      listenPorts: null,
      endpoint: { status: "unknown" as const, lastHandshakeAt: null },
    };

    expect(
      nodeHostMetricsSchema.safeParse({ ...base, diskUsedPercent: 101 }).success,
    ).toBe(false);
    expect(
      nodeHostMetricsSchema.safeParse({ ...base, cpuCores: 0 }).success,
    ).toBe(false);
    expect(
      nodeHostMetricsSchema.safeParse({ ...base, listenPorts: [0] }).success,
    ).toBe(false);
    expect(
      nodeHostMetricsSchema.safeParse({ ...base, listenPorts: [65536] }).success,
    ).toBe(false);
    // A two-entry load average is a parsing bug on the node, not a shorter list.
    expect(
      nodeHostMetricsSchema.safeParse({ ...base, load: [0.1, 0.2] }).success,
    ).toBe(false);
  });
});

describe("toUserCheckState", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  const fresh = new Date("2026-09-02T11:00:00.000Z");
  const staleAfterSec = 3 * 43_200; // three missed 12-hour runs

  it.each([
    ["ok", "works"],
    ["failed", "unavailable"],
    // "error" means the node could not perform the check. Nothing is known
    // about the service, so the user is told "unknown", not "unavailable".
    ["error", "unknown"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(toUserCheckState({ status, checkedAt: fresh, now, staleAfterSec })).toBe(
      expected,
    );
  });

  it("is unknown when the check has never run", () => {
    expect(
      toUserCheckState({ status: null, checkedAt: null, now, staleAfterSec }),
    ).toBe("unknown");
  });

  it("is unknown when the last result is older than the stale window", () => {
    // A stale green light is worse than no light: it says "works" about a
    // measurement nobody has taken since yesterday.
    const old = new Date("2026-08-30T12:00:00.000Z");
    expect(
      toUserCheckState({ status: "ok", checkedAt: old, now, staleAfterSec }),
    ).toBe("unknown");
  });

  it("keeps a result at exactly the stale boundary", () => {
    const boundary = new Date(now.getTime() - staleAfterSec * 1_000);
    expect(
      toUserCheckState({ status: "ok", checkedAt: boundary, now, staleAfterSec }),
    ).toBe("works");
  });
});

// The three states belong to service checks and to nothing else. These two
// tests are the guard rail: the first pins the scope of the enum, the second
// keeps it from being unified with the endpoint enum, which shares the word
// "unknown" by coincidence of English and by nothing else.
describe("the three states are scoped to service checks", () => {
  it("has exactly the three service-check states and no node state", async () => {
    expect(serviceCheckUserStateSchema.options).toEqual([
      "works",
      "unavailable",
      "unknown",
    ]);
    const contracts = await import("./index.js");
    expect("toUserNodeState" in contracts).toBe(false);
    expect("userStateSchema" in contracts).toBe(false);
  });

  it("does not share its enum with endpoint reachability", () => {
    // The endpoint enum lives inside nodeHostMetricsSchema and says
    // reachable/stale/unknown. If someone ever "simplifies" the two into one
    // type, one of these two assertions fails.
    const endpointStates =
      nodeHostMetricsSchema.shape.endpoint.shape.status.options;
    expect(endpointStates).toEqual(["reachable", "stale", "unknown"]);
    expect(endpointStates).not.toEqual(serviceCheckUserStateSchema.options);
  });
});

describe("serviceCheckSchema", () => {
  const probe = { kind: "http" as const, url: "https://gemini.google.com/" };
  const base = {
    name: "Gemini",
    probe,
    assertions: [{ type: "bodyContains" as const, value: "conversation-container" }],
  };

  it("defaults the period, the method and the timeout", () => {
    const parsed = serviceCheckSchema.parse(base);
    expect(parsed.intervalSec).toBe(43_200);
    expect(parsed.enabled).toBe(true);
    expect(parsed.probe).toMatchObject({ method: "GET", timeoutMs: 10_000 });
  });

  it("refuses a check with no assertion at all", () => {
    // Always green, and it looks exactly like a check that is passing.
    expect(
      serviceCheckSchema.safeParse({ ...base, assertions: [] }).success,
    ).toBe(false);
  });

  it("refuses a body assertion against a HEAD probe", () => {
    // HEAD reads no body, so this could only ever fail - and it would fail in
    // the direction that reads as "the service is blocked from this node".
    const result = serviceCheckSchema.safeParse({
      ...base,
      probe: { ...probe, method: "HEAD" },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/reads no body/);
  });

  it("allows a HEAD probe that only asserts on status or headers", () => {
    expect(
      serviceCheckSchema.safeParse({
        ...base,
        probe: { ...probe, method: "HEAD" },
        assertions: [{ type: "statusIn", statuses: [200] }],
      }).success,
    ).toBe(true);
  });

  it("refuses a URL that would make the node probe itself or its network", () => {
    // A check runs on the node with the node's own network. A loopback or
    // internal target turns an admin-supplied string into an SSRF primitive
    // against the node's own services.
    for (const url of [
      "http://localhost/",
      "https://app.localhost/",
      "https://metadata.internal/",
      "ftp://example.com/",
      "file:///etc/passwd",
    ]) {
      expect(
        serviceCheckSchema.safeParse({ ...base, probe: { ...probe, url } })
          .success,
        url,
      ).toBe(false);
    }
  });

  it("keeps an update partial but never empty", () => {
    expect(updateServiceCheckRequestSchema.safeParse({}).success).toBe(false);
    expect(
      updateServiceCheckRequestSchema.parse({ enabled: false }).enabled,
    ).toBe(false);
  });

  it("does not materialize defaults on a partial update", () => {
    // zod's `.partial()` makes a key optional but keeps its `.default()`, so a
    // partial built from the defaulted schema turns "set enabled=false" into
    // "set enabled=false AND reset the interval AND reset the expected
    // statuses". That silent full-replace has already cost this repo one
    // production bug, so the update schema is built from a defaultless shape.
    expect(
      Object.keys(updateServiceCheckRequestSchema.parse({ enabled: false })),
    ).toEqual(["enabled"]);
  });
});

describe("check assertions are an open set", () => {
  it("every declared type is a variant of the union, and the reverse", () => {
    // The list is what the node-agent's registry is checked against, so a type
    // in one and not the other is how a check silently stops being evaluated.
    const variants = new Set(
      checkAssertionSchema.options.map(
        (option) => option.shape.type.value as string,
      ),
    );
    expect([...variants].sort()).toEqual([...CHECK_ASSERTION_TYPES].sort());
  });

  it("describes every type, so no card or CLI can print an empty line", () => {
    const samples: CheckAssertion[] = [
      { type: "statusIn", statuses: [200, 204] },
      { type: "bodyContains", value: "a" },
      { type: "bodyOmits", value: "b" },
      { type: "bodyContainsAll", values: ["a", "b"] },
      { type: "bodyContainsAny", values: ["a", "b"] },
      { type: "bodyOccurrencesAtLeast", value: "a", count: 20 },
      { type: "bodyBytesAtLeast", count: 1_000 },
      { type: "finalUrlContains", value: "/ok" },
      { type: "finalUrlOmits", value: "unsupported-country" },
      { type: "headerContains", name: "content-type", value: "text/html" },
    ];
    expect(samples.map((sample) => sample.type).sort()).toEqual(
      [...CHECK_ASSERTION_TYPES].sort(),
    );
    for (const sample of samples) {
      expect(describeAssertion(sample).length, sample.type).toBeGreaterThan(5);
    }
  });

  it("keeps the count primitive the two Gemini captures actually needed", () => {
    // 20 occurrences on the working page against 0 on the blocked one is the
    // measured separator, and "contains" cannot express it.
    expect(
      checkAssertionSchema.safeParse({
        type: "bodyOccurrencesAtLeast",
        value: "conversation-container",
        count: 20,
      }).success,
    ).toBe(true);
  });
});

describe("unsupportedAssertionTypes", () => {
  const check = {
    assertions: [
      { type: "bodyContains" as const, value: "a" },
      { type: "bodyOccurrencesAtLeast" as const, value: "b", count: 2 },
    ],
  };

  it("names the types an older node cannot run", () => {
    expect(
      unsupportedAssertionTypes(check, {
        probeKinds: ["http"],
        assertionTypes: ["statusIn", "bodyContains"],
      }),
    ).toEqual(["bodyOccurrencesAtLeast"]);
  });

  it("claims nothing about an agent that does not report capabilities", () => {
    // Silence is not evidence of absence. The node's own `error` result is the
    // authority, and it collapses to "unknown" for a user, never "unavailable".
    expect(unsupportedAssertionTypes(check, null)).toEqual([]);
  });

  it("accepts a node that advertises more than this panel knows", () => {
    // A newer agent in a mixed fleet must not fail validation here.
    expect(
      unsupportedAssertionTypes(check, {
        probeKinds: ["http", "dns"],
        assertionTypes: [...CHECK_ASSERTION_TYPES, "dnsAnswerOmits"],
      }),
    ).toEqual([]);
  });
});

describe("nodeRunsCheck", () => {
  const check = "11111111-1111-4111-8111-111111111111";

  it("runs everything on a node with nothing turned off", () => {
    expect(nodeRunsCheck({}, check)).toBe(true);
    expect(
      nodeRunsCheck({ checksEnabled: true, disabledCheckIds: [] }, check),
    ).toBe(true);
  });

  it("runs nothing on a node taken out of checking", () => {
    expect(nodeRunsCheck({ checksEnabled: false }, check)).toBe(false);
  });

  it("skips only the check a node opts out of", () => {
    expect(nodeRunsCheck({ disabledCheckIds: [check] }, check)).toBe(false);
    expect(nodeRunsCheck({ disabledCheckIds: ["other"] }, check)).toBe(true);
  });

  it("treats a missing flag as taking part", () => {
    // A node row written before these columns existed, or a payload that
    // omits them. Defaulting to "does not run" would silently stop checking a
    // whole fleet on an upgrade.
    expect(nodeRunsCheck({ checksEnabled: null, disabledCheckIds: null }, check)).toBe(
      true,
    );
  });

  it("is the same rule the worker and the panel both apply", () => {
    // The worker decides what to DISPATCH, the panel decides what to SHOW. If
    // they disagreed, a user would see a chip for a check their node never
    // runs - a verdict frozen at whatever it said last.
    const node = { checksEnabled: true, disabledCheckIds: [check] };
    expect(nodeRunsCheck(node, check)).toBe(false);
    expect(nodeRunsCheck(node, "22222222-2222-4222-8222-222222222222")).toBe(true);
  });
});

describe("normalizeAccessDomain", () => {
  it("trims, lower-cases and strips leading @", () => {
    expect(normalizeAccessDomain("  @Company.TLD ")).toBe("company.tld");
    expect(normalizeAccessDomain("@@company.tld")).toBe("company.tld");
  });
  it("returns an empty string when nothing is left", () => {
    expect(normalizeAccessDomain("   ")).toBe("");
    expect(normalizeAccessDomain("@")).toBe("");
  });
});

describe("accessDomainSchema", () => {
  it("accepts a hostname and an xn-- label", () => {
    expect(accessDomainSchema.parse("@Company.TLD")).toBe("company.tld");
    expect(accessDomainSchema.parse("xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
  });
  it("refuses an address, a bare TLD and a non-hostname", () => {
    for (const bad of ["someone@company.tld", "org", "com pany.tld", "a/b.tld", "*.tld", "-lead.tld", "trail-.tld", "укр.tld"]) {
      expect(() => accessDomainSchema.parse(bad)).toThrow();
    }
  });
});

describe("accessDomainListSchema", () => {
  it("de-duplicates after normalising and keeps order", () => {
    expect(accessDomainListSchema.parse(["@B.tld", "a.tld", "b.tld"])).toEqual(["b.tld", "a.tld"]);
  });
  it("refuses more than 50 entries", () => {
    expect(() => accessDomainListSchema.parse(Array.from({ length: 51 }, (_, i) => `d${i}.tld`))).toThrow();
  });
});

describe("worker polling periods", () => {
  it("names every period the worker runs on, in a stable order", () => {
    // The CLI, the admin form and the docs all iterate this list, so a period
    // added to the table without a home in the UI shows up here first.
    expect(WORKER_PERIOD_FIELD_NAMES).toEqual([
      "telemetryPollSec",
      "nodeMetricsSampleSec",
      "nodeMetricsRetentionDays",
      "peerSampleSec",
      "maintenanceIntervalSec",
      "agentReleaseRefreshSec",
      "ruleFetchIntervalSec",
      "accessReconcileSec",
    ]);
  });

  it("pins the bounds the CLI keeps its own copy of", () => {
    // apps/cli ships dependency-free and re-states the table in args.ts. Its
    // test compares the two tables directly (this package is a devDependency
    // there), so this literal is the one place a bound is written out: changing
    // a number here is a deliberate act that fails this test first.
    expect(WORKER_PERIOD_FIELDS).toEqual({
      telemetryPollSec: { min: 30, max: 86_400, fallback: 60, unit: "sec" },
      nodeMetricsSampleSec: { min: 30, max: 86_400, fallback: 300, unit: "sec" },
      nodeMetricsRetentionDays: { min: 1, max: 3_650, fallback: 7, unit: "day" },
      peerSampleSec: { min: 60, max: 86_400, fallback: 300, unit: "sec" },
      maintenanceIntervalSec: {
        min: 3_600,
        max: 604_800,
        fallback: 3_600,
        unit: "sec",
      },
      agentReleaseRefreshSec: {
        min: 300,
        max: 604_800,
        fallback: 1_800,
        unit: "sec",
      },
      ruleFetchIntervalSec: {
        min: 900,
        max: 604_800,
        fallback: 21_600,
        unit: "sec",
      },
      accessReconcileSec: {
        min: 300,
        max: 604_800,
        fallback: 3_600,
        unit: "sec",
      },
    });
  });

  it("gives every period a default inside its own bounds", () => {
    // A default outside the bounds would mean the value an unset period
    // actually runs on is one the panel refuses to let anyone type.
    for (const [field, spec] of Object.entries(WORKER_PERIOD_FIELDS)) {
      expect(spec.fallback, field).toBeGreaterThanOrEqual(spec.min);
      expect(spec.fallback, field).toBeLessThanOrEqual(spec.max);
      expect(spec.min, field).toBeLessThan(spec.max);
    }
  });

  it("accepts a value at each bound, and null everywhere", () => {
    for (const field of WORKER_PERIOD_FIELD_NAMES) {
      const { min, max } = WORKER_PERIOD_FIELDS[field];
      expect(workerPeriodOverridesSchema.parse({ [field]: min })).toEqual({
        [field]: min,
      });
      expect(workerPeriodOverridesSchema.parse({ [field]: max })).toEqual({
        [field]: max,
      });
      // Null is how an admin hands a period back to the worker's default, so it
      // has to survive the schema rather than read as "not named".
      expect(workerPeriodOverridesSchema.parse({ [field]: null })).toEqual({
        [field]: null,
      });
    }
  });

  it("refuses a value outside the bounds, and a fractional one", () => {
    for (const field of WORKER_PERIOD_FIELD_NAMES) {
      const { min, max } = WORKER_PERIOD_FIELDS[field];
      expect(() =>
        workerPeriodOverridesSchema.parse({ [field]: min - 1 }),
      ).toThrow();
      expect(() =>
        workerPeriodOverridesSchema.parse({ [field]: max + 1 }),
      ).toThrow();
      expect(() =>
        workerPeriodOverridesSchema.parse({ [field]: min + 0.5 }),
      ).toThrow();
    }
  });

  it("refuses a one-second telemetry poll", () => {
    // The floor exists so nobody can point the whole fleet at itself: every
    // poll is a four-request fan-out to every node.
    expect(() =>
      workerPeriodOverridesSchema.parse({ telemetryPollSec: 1 }),
    ).toThrow();
    expect(workerPeriodOverridesSchema.parse({ telemetryPollSec: 30 })).toEqual({
      telemetryPollSec: 30,
    });
  });

  it("clamps a stored value into range and leaves null alone", () => {
    expect(clampWorkerPeriod("telemetryPollSec", 1)).toBe(30);
    expect(clampWorkerPeriod("telemetryPollSec", 10_000_000)).toBe(86_400);
    expect(clampWorkerPeriod("telemetryPollSec", 120)).toBe(120);
    expect(clampWorkerPeriod("telemetryPollSec", null)).toBeNull();
    expect(clampWorkerPeriod("telemetryPollSec", undefined)).toBeNull();
    expect(clampWorkerPeriod("telemetryPollSec", Number.NaN)).toBeNull();
  });

  it("reports a sample period below the poll period, and only that", () => {
    expect(sampleBelowPoll("nodeMetricsSampleSec", 60, 30)).toEqual({
      field: "nodeMetricsSampleSec",
      telemetryPollSec: 60,
      sampleSec: 30,
    });
    expect(sampleBelowPoll("nodeMetricsSampleSec", 60, 60)).toBeNull();
    expect(sampleBelowPoll("nodeMetricsSampleSec", 60, 300)).toBeNull();
  });

  it("binds the peer sample period to the poll period too", () => {
    // `peer_samples` rows are written by a poll exactly as metrics rows are, so
    // --telemetryPollSec=3600 --peerSampleSec=60 is the same lie: the panel
    // would show 60 s while an idle peer was recorded once an hour.
    expect(POLL_BOUND_SAMPLE_FIELDS).toEqual([
      "nodeMetricsSampleSec",
      "peerSampleSec",
    ]);
    expect(sampleBelowPoll("peerSampleSec", 3_600, 60)).toEqual({
      field: "peerSampleSec",
      telemetryPollSec: 3_600,
      sampleSec: 60,
    });
    expect(sampleBelowPoll("peerSampleSec", 60, 300)).toBeNull();
  });

  it("recognises exactly the poll-bound sample fields", () => {
    // The worker's read-path clamp branches on this, so a period added to the
    // contract must not silently join or leave the rule.
    for (const field of WORKER_PERIOD_FIELD_NAMES) {
      expect(isPollBoundSampleField(field), field).toBe(
        field === "nodeMetricsSampleSec" || field === "peerSampleSec",
      );
    }
    // Every poll-bound field has a name to show an admin, or the API's refusal
    // would read "The undefined (60 s) cannot be shorter...".
    for (const field of POLL_BOUND_SAMPLE_FIELDS) {
      expect(POLL_BOUND_SAMPLE_LABELS[field], field).toBeTruthy();
    }
  });
});
