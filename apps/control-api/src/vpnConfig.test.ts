import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyRouteProfileToVpnLink,
  decodeVpnLink,
  extractConfFromVpnLink,
  setVpnDescription,
} from "./vpnConfig.js";
import { MAX_TUNNEL_ROUTES } from "./routeComplement.js";

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

  it("routes everything EXCEPT the ru_whitelist CIDRs", () => {
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
    expect(conf).toContain("AllowedIPs = ");
    // The whole space would defeat the profile; the default route must be gone.
    expect(conf).not.toContain("0.0.0.0/0,");

    const decoded = decodeVpnLink(modifiedLink);
    const lastConfig = JSON.parse(
      decoded.containers?.[0]?.awg?.last_config ?? "{}",
    ) as { allowed_ips?: string[]; sites?: string[] };
    const allowedIps = lastConfig.allowed_ips ?? [];

    // The listed CIDRs bypass the tunnel, so they are exactly what AllowedIPs
    // must NOT carry.
    expect(allowedIps).not.toContain("104.244.42.0/24");
    expect(allowedIps).not.toContain("157.240.0.0/16");

    // Everything else does go through it, IPv6 included. The DNS servers are
    // not named separately: the complement already covers them, and naming one
    // would drag a resolver the operator bypassed back into the tunnel.
    expect(allowedIps).toContain("::/0");
    expect(allowedIps).not.toContain("1.1.1.1/32");

    const covered = allowedIps
      .filter((cidr) => !cidr.includes(":"))
      .reduce((sum, cidr) => sum + 2 ** (32 - Number(cidr.split("/")[1])), 0);
    // Exactly the full space minus the two bypassed blocks.
    expect(covered).toBe(2 ** 32 - 2 ** 8 - 2 ** 16);

    expect(lastConfig.sites).toEqual(["instagram.com", "x.com"]);
  });

  it("routes ONLY the ru_blacklist CIDRs", () => {
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

    const modifiedLink = applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", {
      cidrs: ["104.244.42.0/24", "157.240.0.0/16"],
      domains: [],
    });

    const decoded = decodeVpnLink(modifiedLink);
    const lastConfig = JSON.parse(
      decoded.containers?.[0]?.awg?.last_config ?? "{}",
    ) as { allowed_ips?: string[] };
    expect(lastConfig.allowed_ips).toEqual([
      "104.244.42.0/24",
      "157.240.0.0/16",
      "1.1.1.1/32",
      "1.0.0.1/32",
    ]);
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

  it("keeps the full tunnel when a profile payload carries no CIDRs", () => {
    // A domains-only feed, or one that failed to fetch, has nothing AllowedIPs
    // can express: the client builds its site list from its own settings and
    // ignores anything a config carries. Applying such a payload would leave
    // the peer routing its DNS servers and nothing else, so the untouched
    // full-tunnel link has to come back instead.
    const vpnLink = encode({
      dns1: "1.1.1.1",
      dns2: "1.0.0.1",
      containers: [
        {
          container: "amnezia-awg",
          awg: {
            last_config: JSON.stringify({
              config:
                "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n",
              allowed_ips: ["0.0.0.0/0", "::/0"],
            }),
          },
        },
      ],
    });

    for (const profile of ["ru_blacklist", "ru_whitelist"] as const) {
      expect(
        applyRouteProfileToVpnLink(vpnLink, profile, {
          cidrs: [],
          domains: ["example.com", "example.org"],
        }),
      ).toBe(vpnLink);
    }
  });

  it("keeps the full tunnel when a grown feed no longer fits AllowedIPs", () => {
    // Feeds grow. A blacklist cannot shorten itself — dropping entries would
    // send that traffic outside the tunnel — so past the budget it has to
    // degrade to the full tunnel rather than become a config that the Android
    // client discards on arrival, leaving the key connected to nothing.
    const vpnLink = encode({
      dns1: "1.1.1.1",
      dns2: "1.0.0.1",
      containers: [
        {
          container: "amnezia-awg",
          awg: {
            last_config: JSON.stringify({
              config:
                "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n",
              allowed_ips: ["0.0.0.0/0", "::/0"],
            }),
          },
        },
      ],
    });

    const oversized = Array.from(
      { length: MAX_TUNNEL_ROUTES + 1 },
      (_, index) =>
        `10.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}/32`,
    );

    expect(
      applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", {
        cidrs: oversized,
        domains: [],
      }),
    ).toBe(vpnLink);

    // The whitelist has a lever the blacklist lacks: it widens its gap merging
    // until the inverse fits, so the same feed still produces a usable config.
    const whitelisted = applyRouteProfileToVpnLink(vpnLink, "ru_whitelist", {
      cidrs: oversized,
      domains: [],
    });
    expect(whitelisted).not.toBe(vpnLink);
    const lastConfig = JSON.parse(
      decodeVpnLink(whitelisted).containers?.[0]?.awg?.last_config ?? "{}",
    ) as { allowed_ips?: string[] };
    expect(lastConfig.allowed_ips?.length ?? 0).toBeLessThanOrEqual(
      MAX_TUNNEL_ROUTES,
    );
  });
});
