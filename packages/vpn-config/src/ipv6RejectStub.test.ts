import { describe, expect, it } from "vitest";

import { decodeVpnLink, type AmneziaPayload } from "./codec.js";
import { buildLink } from "./fixtures.js";
import {
  DEFAULT_AWG3_SERVER_IPV4_CIDR,
  DEFAULT_IPV6_REJECT_STUB_PREFIX,
  deriveStubPeerIpv6,
  deriveStubServerIpv6,
  formatIpv6,
  isValidUla64Prefix,
  normalizeUla64Prefix,
  parseIpv6,
  readBaseClientIpv4,
  withIpv6RejectStubAddress,
} from "./ipv6RejectStub.js";

const lastConfigOf = (payload: AmneziaPayload) =>
  JSON.parse(String(payload.containers?.[0]?.awg?.last_config)) as Record<string, unknown>;

describe("normalizeUla64Prefix / isValidUla64Prefix", () => {
  it("normalizes valid RFC 4193 ULA /64 prefixes to RFC 5952 form", () => {
    expect(normalizeUla64Prefix(DEFAULT_IPV6_REJECT_STUB_PREFIX)).toBe("fd6b:7c2e:4a91:9f::/64");
    expect(normalizeUla64Prefix("  FD6B:7C2E:4A91:009F:0000:0000:0000:0000/64 ")).toBe(
      "fd6b:7c2e:4a91:9f::/64",
    );
    expect(normalizeUla64Prefix("fd00:0:0:1::/64")).toBe("fd00:0:0:1::/64");
    expect(normalizeUla64Prefix("fd12::/64")).toBe("fd12::/64");
    expect(isValidUla64Prefix("fd6b:7c2e:4a91:9f::/64")).toBe(true);
  });

  it("rejects non-ULA, non-/64, non-zero host bits, zones, and malformed inputs", () => {
    const invalid = [
      "",
      "2001:db8::/64",
      "fc00:1234:5678:9abc::/64", // fc00::/8 is not locally assigned fd00::/8
      "fe80::/64",
      "fd6b:7c2e:4a91:9f::/48",
      "fd6b:7c2e:4a91:9f::/128",
      "fd6b:7c2e:4a91:9f::1/64", // host bit set
      "fd6b:7c2e:4a91:9f:0:0:0:1/64",
      "fd6b:7c2e:4a91:9f::%eth0/64",
      "fd6b:7c2e::10.0.0.1/64",
      "fd6b:::9f::/64",
      "not-a-cidr",
    ];
    for (const candidate of invalid) {
      expect(normalizeUla64Prefix(candidate), candidate).toBeNull();
      expect(isValidUla64Prefix(candidate), candidate).toBe(false);
    }
  });

  it("round-trips RFC 5952 zero compression rules", () => {
    const parsed = parseIpv6("fd6b:0000:0000:009f:0000:0000:0000:0001");
    expect(parsed).not.toBeNull();
    expect(formatIpv6(parsed as bigint)).toBe("fd6b:0:0:9f::1");
  });
});

describe("deriveStubServerIpv6 / deriveStubPeerIpv6", () => {
  it("derives deterministic server and peer ULAs from AWG 3.1 IPv4 leases", () => {
    expect(deriveStubServerIpv6()).toBe("fd6b:7c2e:4a91:9f::1");
    expect(deriveStubPeerIpv6("10.90.0.2")).toBe("fd6b:7c2e:4a91:9f::2");
    expect(deriveStubPeerIpv6("10.90.0.2/32")).toBe("fd6b:7c2e:4a91:9f::2");
    expect(deriveStubPeerIpv6("10.90.0.255")).toBe("fd6b:7c2e:4a91:9f::ff");
    expect(deriveStubPeerIpv6("10.90.1.5")).toBe("fd6b:7c2e:4a91:9f::105");
    expect(deriveStubPeerIpv6("10.90.3.254")).toBe("fd6b:7c2e:4a91:9f::3fe");
  });

  it("supports custom ULA /64 prefixes", () => {
    expect(deriveStubServerIpv6("fd11:2233:4455:6677::/64")).toBe("fd11:2233:4455:6677::1");
    expect(
      deriveStubPeerIpv6("10.90.0.16", DEFAULT_AWG3_SERVER_IPV4_CIDR, "fd11:2233:4455:6677::/64"),
    ).toBe("fd11:2233:4455:6677::10");
  });

  it("rejects network, server, broadcast, out-of-subnet, and invalid addresses", () => {
    expect(deriveStubPeerIpv6("10.90.0.0")).toBeNull();
    expect(deriveStubPeerIpv6("10.90.0.1")).toBeNull();
    expect(deriveStubPeerIpv6("10.90.3.255")).toBeNull();
    expect(deriveStubPeerIpv6("10.90.4.1")).toBeNull();
    expect(deriveStubPeerIpv6("10.8.1.7")).toBeNull();
    expect(deriveStubPeerIpv6("0.0.0.0")).toBeNull();
    expect(deriveStubPeerIpv6("10.90.0.2", DEFAULT_AWG3_SERVER_IPV4_CIDR, "2001:db8::/64")).toBeNull();
  });
});

describe("readBaseClientIpv4 / withIpv6RejectStubAddress", () => {
  const awg3Link = () =>
    buildLink({
      conf: (conf) => conf.replace("Address = 10.8.1.7/32", "Address = 10.90.0.7/32"),
    });

  it("extracts base IPv4 from client_ip or embedded Address", () => {
    expect(readBaseClientIpv4(buildLink())).toBe("10.8.1.7");
    expect(readBaseClientIpv4(buildLink({ protocolVersion: "2" }))).toBeNull();
    expect(readBaseClientIpv4("not-a-link")).toBeNull();
  });

  it("injects dual-stack Address and client_ip for mobile vpn:// exports idempotently", () => {
    const link = awg3Link();
    const updated = withIpv6RejectStubAddress(link, "fd6b:7c2e:4a91:9f::7", {
      includeClientIp: true,
    });
    const last = lastConfigOf(decodeVpnLink(updated));
    // Fixture's client_ip is 10.8.1.7 while embedded Address is 10.90.0.7/32
    expect(last.client_ip).toBe("10.8.1.7, fd6b:7c2e:4a91:9f::7");
    expect(String(last.config)).toContain("Address = 10.90.0.7/32, fd6b:7c2e:4a91:9f::7/128");
    expect(withIpv6RejectStubAddress(updated, "fd6b:7c2e:4a91:9f::7", { includeClientIp: true })).toBe(
      updated,
    );
  });

  it("injects Address without touching IPv4 client_ip when includeClientIp is false (.conf path)", () => {
    const link = buildLink();
    const updated = withIpv6RejectStubAddress(link, "fd6b:7c2e:4a91:9f::7/128", {
      includeClientIp: false,
    });
    const last = lastConfigOf(decodeVpnLink(updated));
    expect(last.client_ip).toBe("10.8.1.7");
    expect(String(last.config)).toContain("Address = 10.8.1.7/32, fd6b:7c2e:4a91:9f::7/128");
  });

  it("preserves CRLF line endings and replaces a previous IPv6 address instead of duplicating", () => {
    const crlf = buildLink({
      conf: (conf) =>
        conf
          .replace("Address = 10.8.1.7/32", "Address = 10.8.1.7/32, fd00::99/128")
          .replace(/\n/g, "\r\n"),
    });
    const updated = withIpv6RejectStubAddress(crlf, "fd6b:7c2e:4a91:9f::7", {
      includeClientIp: true,
    });
    const conf = String(lastConfigOf(decodeVpnLink(updated)).config);
    expect(conf).toContain("Address = 10.8.1.7/32, fd6b:7c2e:4a91:9f::7/128\r\nDNS =");
    expect(conf).not.toContain("fd00::99");
  });

  it("leaves AWG 2.0, legacy, unreadable, and invalid-IPv6 inputs byte-for-byte unchanged", () => {
    const v2 = buildLink({ protocolVersion: "2" });
    const legacy = buildLink({ protocolVersion: null });
    const v3 = buildLink();
    expect(withIpv6RejectStubAddress(v2, "fd6b:7c2e:4a91:9f::7", { includeClientIp: true })).toBe(v2);
    expect(withIpv6RejectStubAddress(legacy, "fd6b:7c2e:4a91:9f::7", { includeClientIp: true })).toBe(
      legacy,
    );
    expect(withIpv6RejectStubAddress(v3, "not-an-ip", { includeClientIp: true })).toBe(v3);
    expect(withIpv6RejectStubAddress("vpn://bad", "fd6b:7c2e:4a91:9f::7", { includeClientIp: true })).toBe(
      "vpn://bad",
    );
  });
});
