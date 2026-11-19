import { describe, expect, it } from "vitest";
import {
  DEFAULT_IPV6_REJECT_STUB_PREFIX,
  isValidUla64Prefix,
  normalizeUla64Prefix,
  updateNodeIpv6RejectStubRequestSchema,
} from "./ipv6RejectStub.js";

describe("ipv6RejectStub contracts", () => {
  it("normalizes canonical ULA /64 prefixes on update requests", () => {
    const parsed = updateNodeIpv6RejectStubRequestSchema.parse({
      enabled: true,
      prefix: " FD6B:7C2E:4A91:009F::/64 ",
    });
    expect(parsed).toEqual({
      enabled: true,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
    });
  });

  it("allows omitting prefix and rejects non-ULA or host-bit prefixes", () => {
    expect(
      updateNodeIpv6RejectStubRequestSchema.parse({ enabled: false }),
    ).toEqual({ enabled: false });

    expect(isValidUla64Prefix("2001:db8::/64")).toBe(false);
    expect(isValidUla64Prefix("fd6b:7c2e:4a91:9f::1/64")).toBe(false);
    expect(normalizeUla64Prefix("fc00::/64")).toBeNull();
    expect(
      updateNodeIpv6RejectStubRequestSchema.safeParse({
        enabled: true,
        prefix: "2001:db8::/64",
      }).success,
    ).toBe(false);
  });
});
