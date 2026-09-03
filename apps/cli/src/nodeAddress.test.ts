import { describe, expect, it } from "vitest";
import { formatNodeAddress } from "./nodeAddress.js";

describe("formatNodeAddress", () => {
  it("shows a dash when the agent has not reported an address", () => {
    // Same empty-cell dash the other tables use (formatDeviceType, quota reason).
    expect(formatNodeAddress(null, null)).toBe("—");
  });

  it("shows the resolved IP beside a DNS name", () => {
    expect(formatNodeAddress("vpn.example.com", "203.0.113.10")).toBe(
      "vpn.example.com (203.0.113.10)",
    );
  });

  it("does not repeat an IP literal in brackets", () => {
    expect(formatNodeAddress("203.0.113.10", "203.0.113.10")).toBe(
      "203.0.113.10",
    );
  });

  it("marks a DNS name the panel could not resolve", () => {
    // The state the node card shows as its own warning badge. Without this
    // branch it is indistinguishable from a healthy IP-literal node.
    expect(formatNodeAddress("vpn.example.com", null)).toBe(
      "vpn.example.com (unresolved)",
    );
  });

  it("does not cry unresolved for an IP literal", () => {
    // publicIp is only written for a name that resolved; an IPv4 host needs no
    // lookup, so a null ip here is normal, not a fault.
    expect(formatNodeAddress("203.0.113.10", null)).toBe("203.0.113.10");
  });

  it("treats the host as the authority", () => {
    expect(formatNodeAddress(null, "203.0.113.10")).toBe("—");
  });
});
