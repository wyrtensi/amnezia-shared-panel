import { describe, expect, it } from "vitest";
import {
  computeEndpointDisplayName,
  detectExitSubnetProximityWarning,
  createNodeEgressIpRequestSchema,
  swapNodeEgressIpRequestSchema,
  updateNodeEgressModeRequestSchema,
  nodePublicEndpointMutationSchema,
} from "./index.js";

describe("egress contracts", () => {
  it("computes deterministic variant display names", () => {
    expect(
      computeEndpointDisplayName({
        entryName: "Amsterdam",
        variantOrdinal: 1,
        siblingCount: 1,
      }),
    ).toBe("Amsterdam");

    expect(
      computeEndpointDisplayName({
        entryName: "Amsterdam",
        variantOrdinal: 2,
        siblingCount: 2,
      }),
    ).toBe("Amsterdam v2");

    expect(
      computeEndpointDisplayName({
        entryName: "Amsterdam",
        customName: "Amsterdam Stealth",
        variantOrdinal: 1,
        siblingCount: 2,
      }),
    ).toBe("Amsterdam Stealth");
  });

  it("detects real CIDR overlap and /24 proximity warnings unless allowAsEntry=true", () => {
    // /23 overlap across 198.51.100.x and 198.51.101.x
    expect(
      detectExitSubnetProximityWarning({
        exitIpv4: "198.51.100.10",
        observedSubnetCidr: "198.51.100.10/23",
        entryAddresses: ["198.51.101.20"],
      }),
    ).toContain("198.51.100.0/23");

    // /32 host route shares /24 with another Entry IP
    expect(
      detectExitSubnetProximityWarning({
        exitIpv4: "203.0.113.20",
        observedSubnetCidr: "203.0.113.20/32",
        entryAddresses: ["203.0.113.10"],
      }),
    ).toContain("/24");

    // Excluded when allowAsEntry=true or distinct /24
    expect(
      detectExitSubnetProximityWarning({
        exitIpv4: "203.0.113.20",
        observedSubnetCidr: "203.0.113.20/32",
        entryAddresses: ["203.0.113.10"],
        allowAsEntry: true,
      }),
    ).toBeNull();

    expect(
      detectExitSubnetProximityWarning({
        exitIpv4: "203.0.113.20",
        observedSubnetCidr: "203.0.113.20/24",
        entryAddresses: ["198.51.100.10"],
      }),
    ).toBeNull();
  });

  it("validates public exit IPv4 and endpoint remove/variant mutations", () => {
    expect(() =>
      createNodeEgressIpRequestSchema.parse({ ipv4: "10.0.0.5" }),
    ).toThrow();

    const parsed = createNodeEgressIpRequestSchema.parse({
      ipv4: "1.1.1.1",
      dnsPrimary: "9.9.9.9",
      enforceDnsDnat: true,
    });
    expect(parsed.dnsPrimary).toBe("9.9.9.9");
    expect(parsed.amneziaDnsDnat).toBe(true);

    expect(() =>
      swapNodeEgressIpRequestSchema.parse({ ipv4: "192.168.1.5" }),
    ).toThrow();

    expect(
      updateNodeEgressModeRequestSchema.parse({ mode: "routed", blockSmtp: true }),
    ).toEqual({ mode: "routed", blockSmtp: true });

    const rm = nodePublicEndpointMutationSchema.parse({
      action: "remove",
      id: "11111111-1111-4111-8111-111111111111",
      reassignToEndpointId: "22222222-2222-4222-8222-222222222222",
    });
    expect(rm.action).toBe("remove");
  });
});
