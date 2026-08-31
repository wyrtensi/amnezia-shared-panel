import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyRouteProfileToVpnLink,
  decodeVpnLink,
  extractConfFromVpnLink,
  setVpnDescription,
} from "./vpnConfig.js";

const encode = (value: unknown): string => {
  const raw = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length, 0);
  return `vpn://${Buffer.concat([header, deflateSync(raw)]).toString("base64url")}`;
};

describe("vpn config extraction and split tunneling", () => {
  it("extracts the exact AWG config embedded by the node-agent", () => {
    const vpnLink = encode({
      containers: [
        {
          awg: {
            last_config: JSON.stringify({ config: "[Interface]\nPrivateKey = x\n" }),
          },
        },
      ],
    });

    expect(extractConfFromVpnLink(vpnLink)).toBe(
      "[Interface]\nPrivateKey = x\n",
    );
  });

  it("rejects malformed and incomplete payloads", () => {
    expect(() => extractConfFromVpnLink("vpn://bad")).toThrow();
    expect(() => extractConfFromVpnLink(encode({ containers: [] }))).toThrow(
      /embedded config/i,
    );
  });

  it("sets the client-visible server name (description)", () => {
    const vpnLink = encode({
      description: "old name",
      containers: [
        { awg: { last_config: JSON.stringify({ config: "[Interface]\n" }) } },
      ],
    });
    const named = setVpnDescription(vpnLink, "Frankfurt #3");
    expect(decodeVpnLink(named).description).toBe("Frankfurt #3");
  });

  it("returns the link unchanged when it cannot be decoded or name is empty", () => {
    expect(setVpnDescription("vpn://bad", "X")).toBe("vpn://bad");
    const link = encode({ description: "keep", containers: [] });
    expect(setVpnDescription(link, "")).toBe(link);
  });

  it("leaves full_tunnel config unchanged", () => {
    const vpnLink = encode({
      containers: [
        {
          awg: {
            last_config: JSON.stringify({
              config: "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n",
            }),
          },
        },
      ],
    });

    const result = applyRouteProfileToVpnLink(vpnLink, "full_tunnel");
    expect(result).toBe(vpnLink);
  });

  it("applies ru_whitelist CIDRs and domains to vpn payload and conf", () => {
    const originalConfig =
      "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 1.2.3.4:51889\n";
    const vpnLink = encode({
      dns1: "1.1.1.1",
      dns2: "1.0.0.1",
      containers: [
        {
          container: "amnezia-awg",
          awg: {
            last_config: JSON.stringify({
              config: originalConfig,
              allowed_ips: ["0.0.0.0/0", "::/0"],
            }),
          },
        },
      ],
    });

    const rulePayload = {
      cidrs: ["104.244.42.0/24", "157.240.0.0/16"],
      domains: ["instagram.com", "x.com"],
    };

    const modifiedLink = applyRouteProfileToVpnLink(
      vpnLink,
      "ru_whitelist",
      rulePayload,
    );

    const conf = extractConfFromVpnLink(modifiedLink);
    expect(conf).toContain("AllowedIPs = 104.244.42.0/24, 157.240.0.0/16, 1.1.1.1/32, 1.0.0.1/32");
    expect(conf).not.toContain("0.0.0.0/0");

    const decoded = decodeVpnLink(modifiedLink);
    const lastConfig = JSON.parse(
      decoded.containers?.[0]?.awg?.last_config ?? "{}",
    ) as { allowed_ips?: string[]; sites?: string[] };
    expect(lastConfig.allowed_ips).toEqual([
      "104.244.42.0/24",
      "157.240.0.0/16",
      "1.1.1.1/32",
      "1.0.0.1/32",
    ]);
    expect(lastConfig.sites).toEqual(["instagram.com", "x.com"]);
  });

  it("applies ru_blacklist CIDRs the same way as whitelist", () => {
    const originalConfig =
      "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n";
    const vpnLink = encode({
      dns1: "1.1.1.1",
      dns2: "1.0.0.1",
      containers: [
        {
          container: "amnezia-awg",
          awg: { last_config: JSON.stringify({ config: originalConfig }) },
        },
      ],
    });

    const modified = applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", {
      cidrs: ["100.64.0.0/10"],
      domains: ["rutracker.org"],
    });

    const conf = extractConfFromVpnLink(modified);
    expect(conf).toContain("AllowedIPs = 100.64.0.0/10, 1.1.1.1/32, 1.0.0.1/32");
    expect(conf).not.toContain("0.0.0.0/0");
  });
});
