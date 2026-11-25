import { describe, expect, it } from "vitest";
import { decodeVpnLink } from "./codec.js";
import { applyDnsToVpnLink } from "./awgDns.js";
import { buildLink, lastConfigOf } from "./fixtures.js";

describe("applyDnsToVpnLink", () => {
  it("updates payload.dns1/dns2, lastConfig.dns1/dns2, and [Interface] DNS line", () => {
    const original = buildLink({
      conf: (conf) => conf.replace("[Interface]", "[Interface]\nDNS = 1.1.1.1, 1.0.0.1"),
    });
    const updated = applyDnsToVpnLink(original, "9.9.9.9", "149.112.112.112");
    const payload = decodeVpnLink(updated);
    const lc = lastConfigOf(payload);

    expect(payload.dns1).toBe("9.9.9.9");
    expect(payload.dns2).toBe("149.112.112.112");
    expect(lc.dns1).toBe("9.9.9.9");
    expect(lc.dns2).toBe("149.112.112.112");
    expect(String(lc.config)).toContain("DNS = 9.9.9.9, 149.112.112.112");
    expect(String(lc.config)).not.toContain("1.1.1.1");
  });

  it("inserts DNS line cleanly when [Interface] lacks one and clears secondary DNS", () => {
    const original = buildLink();
    const updated = applyDnsToVpnLink(original, "8.8.8.8", null);
    const payload = decodeVpnLink(updated);
    const lc = lastConfigOf(payload);

    expect(payload.dns1).toBe("8.8.8.8");
    expect(payload.dns2).toBe("");
    expect(lc.dns1).toBe("8.8.8.8");
    expect(lc.dns2).toBe("");
    expect(String(lc.config)).toContain("DNS = 8.8.8.8");
  });

  it("rejects invalid IPv4 DNS addresses", () => {
    const original = buildLink();
    expect(() => applyDnsToVpnLink(original, "not-an-ip")).toThrow("Invalid IPv4 DNS");
    expect(() => applyDnsToVpnLink(original, "1.1.1.1", "999.0.0.1")).toThrow("Invalid IPv4 DNS");
  });
});
