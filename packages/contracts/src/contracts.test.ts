import { describe, expect, it } from "vitest";

import {
  composeKeyDisplayName,
  createKeyRequestSchema,
  customRoutesSchema,
  globalRoutesSchema,
  keyNameDisplaySchema,
  MAX_GLOBAL_CIDRS,
  MAX_GLOBAL_DOMAINS,
  nodeKeyLimitsSchema,
  portalPolicySchema,
  quotaRequestSchema,
  setUserLimitRequestSchema,
  updateGlobalRoutesRequestSchema,
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
    });
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
    // The public key stays hidden until an admin turns it on.
    expect(policy.showPublicKey).toBe(false);
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

  it("is the request schema used by the admin update endpoint", () => {
    expect(updateGlobalRoutesRequestSchema).toBe(globalRoutesSchema);
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
});
