import { describe, expect, it } from "vitest";

import {
  createKeyRequestSchema,
  customRoutesSchema,
  portalPolicySchema,
  quotaRequestSchema,
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
      allowCustomRoutes: false,
      allowConfigRedownload: true,
      allowQrDownload: true,
      allowConfDownload: true,
      allowSelfRevoke: true,
      showPublicKey: false,
      showLastUsed: true,
      showTraffic: true,
    });
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
