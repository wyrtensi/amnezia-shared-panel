import { describe, expect, it } from "vitest";

import { allocatePeerIp } from "@/helpers/allocatePeerIp";

describe("allocatePeerIp", () => {
  it("skips the server address and returns the first free host in a /24", () => {
    expect(
      allocatePeerIp("10.89.0.1/24", ["10.89.0.2/32", "10.89.0.3/32"]),
    ).toBe("10.89.0.4");
  });

  it("allocates across octet boundaries in a /22", () => {
    const used = Array.from({ length: 255 }, (_, index) =>
      `10.89.0.${index + 1}/32`,
    );

    expect(allocatePeerIp("10.89.0.1/22", used)).toBe("10.89.1.0");
  });

  it("never allocates the network or broadcast address", () => {
    expect(allocatePeerIp("10.89.0.1/30", ["10.89.0.2/32"])).toBeNull();
  });

  it("ignores malformed and out-of-subnet peer entries", () => {
    expect(
      allocatePeerIp("10.89.0.1/29", [
        "not-an-ip",
        "10.90.0.2/32",
        "10.89.0.2/24",
      ]),
    ).toBe("10.89.0.2");
  });

  it("rejects IPv6 and invalid server CIDRs", () => {
    expect(() => allocatePeerIp("fd00::1/64", [])).toThrow(
      "IPv4 server CIDR",
    );
    expect(() => allocatePeerIp("10.89.0.1", [])).toThrow(
      "IPv4 server CIDR",
    );
  });
});
