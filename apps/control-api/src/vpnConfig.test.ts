import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  applyRouteProfileToVpnLink,
  decodeVpnLink,
  extractConfFromVpnLink,
  MAX_TUNNEL_ROUTES,
  setVpnDescription,
  WARN_TUNNEL_ROUTES,
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
    });

    const decoded = decodeVpnLink(modifiedLink);
    const lastConfig = JSON.parse(
      decoded.containers?.[0]?.awg?.last_config ?? "{}",
    ) as {
      allowed_ips?: string[];
      sites?: unknown;
      split_tunnel_sites?: unknown;
    };
    expect(lastConfig.allowed_ips).toEqual([
      "104.244.42.0/24",
      "157.240.0.0/16",
      "1.1.1.1/32",
      "1.0.0.1/32",
    ]);

    // Neither site field is written: the AmneziaVPN client reads neither, so a
    // key that carried them looked routed by name and was not.
    expect(lastConfig.sites).toBeUndefined();
    expect(lastConfig.split_tunnel_sites).toBeUndefined();
  });

  it("applies ru_blacklist CIDRs when the config has no allowed_ips field yet", () => {
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
    });

    const conf = extractConfFromVpnLink(modified);
    expect(conf).toContain("AllowedIPs = 100.64.0.0/10, 1.1.1.1/32, 1.0.0.1/32");
    expect(conf).not.toContain("0.0.0.0/0");
  });

  it("keeps the full tunnel when a profile payload carries no CIDRs", () => {
    // A feed that failed to fetch has nothing AllowedIPs can express.
    // Applying such a payload would leave the peer routing its DNS servers and
    // nothing else, so the untouched full-tunnel link has to come back.
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

    expect(
      applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", { cidrs: [] }),
    ).toBe(vpnLink);
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
      }),
    ).toBe(vpnLink);
  });

  it("says so in the log before and when a feed outgrows the client", () => {
    // The budget is invisible until keys stop filtering, so both crossings
    // have to reach an operator: the headroom mark while there is still time
    // to shrink the feed, and the ceiling when keys start coming out as full
    // tunnels regardless.
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
    const cidrsOfLength = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `10.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}/32`,
      );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Comfortably inside the budget: nothing to report.
      applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", {
        cidrs: cidrsOfLength(10),
      });
      expect(warn).not.toHaveBeenCalled();

      applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", {
        cidrs: cidrsOfLength(WARN_TUNNEL_ROUTES + 1),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("approaching");

      applyRouteProfileToVpnLink(vpnLink, "ru_blacklist", {
        cidrs: cidrsOfLength(MAX_TUNNEL_ROUTES + 1),
      });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]?.[0])).toContain("full tunnel");
    } finally {
      warn.mockRestore();
    }
  });
});
