import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { awg31Link, I_SIGNATURES, readCopies } from "./awg31.fixture.js";
import { selectAwgClientProfile } from "./awgClientProfile.js";
import {
  type AmneziaPayload,
  applyAwgClientProfile,
  applyRouteProfileToVpnLink,
  decodeVpnLink,
  inspectAwg31ClientConfig,
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

describe("AWG 3.1 client profile", () => {
  const profile = { version: 1, revision: 1, jc: 4, jmin: 45, jmax: 175, cpsOrder: 1 } as const;
  const PROFILE_FIELDS = new Set(["Jc", "Jmin", "Jmax", "I1", "I2", "I3"]);

  /** Everything except the fields a profile may change, plus the conf lines. */
  const fixedParts = (link: string) => {
    const { awg, lastConfig, conf } = readCopies(link, decodeVpnLink);
    const strip = (record: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => !PROFILE_FIELDS.has(key) && key !== "last_config" && key !== "config",
        ),
      );
    const payload = decodeVpnLink(link);
    return {
      payload: { ...payload, containers: undefined },
      container: payload.containers?.[0]?.container,
      awg: strip(awg),
      lastConfig: strip(lastConfig),
      conf: conf
        .split("\n")
        .filter((line) => !/^(Jc|Jmin|Jmax|I[1-3]) = /.test(line)),
    };
  };

  it("reads the effective junk parameters of a true 3.1 artifact", () => {
    expect(inspectAwg31ClientConfig(awg31Link())).toEqual({ jc: 8, jmin: 62, jmax: 260 });
  });

  it.each([
    ["a 2.0 artifact", { protocolVersion: "2" }],
    ["an artifact without the protocol marker", { protocolVersion: null }],
    ["a 3.1 artifact without J fields", { j: null }],
    [
      "duplicate J lines",
      { conf: (text: string) => text.replace("Jc = 8", "Jc = 8\nJc = 9") },
    ],
    [
      "copies that disagree on Jc",
      {
        outer: (awg: Record<string, unknown>) => {
          awg.Jc = "9";
        },
      },
    ],
    [
      "copies that disagree on an I slot",
      {
        inner: (lastConfig: Record<string, unknown>) => {
          lastConfig.I3 = "<b 0x01>";
        },
      },
    ],
    [
      "several AWG containers",
      {
        payload: (payload: AmneziaPayload) => {
          payload.containers?.push({ ...payload.containers[0], container: "amnezia-awg" });
        },
      },
    ],
    [
      "a default container that is not the AWG one",
      {
        payload: (payload: AmneziaPayload) => {
          payload.defaultContainer = "amnezia-openvpn";
        },
      },
    ],
  ])("leaves %s alone, byte for byte", (_name, options) => {
    const link = awg31Link(options);
    expect(inspectAwg31ClientConfig(link)).toBeNull();
    expect(applyAwgClientProfile(link, profile)).toBe(link);
    // Whatever was saved: an artifact the profile cannot apply to stays exportable.
    expect(applyAwgClientProfile(link, { garbage: true })).toBe(link);
  });

  it("treats an undecodable link as ineligible", () => {
    expect(inspectAwg31ClientConfig("vpn://bad")).toBeNull();
    expect(applyAwgClientProfile("vpn://bad", profile)).toBe("vpn://bad");
  });

  it("changes only Jc/Jmin/Jmax and the I order, the same way in all three copies", () => {
    const base = awg31Link();
    const out = applyAwgClientProfile(base, profile);
    expect(fixedParts(out)).toEqual(fixedParts(base));
    const { awg, lastConfig, line } = readCopies(out, decodeVpnLink);
    for (const [key, value] of [
      ["Jc", "4"],
      ["Jmin", "45"],
      ["Jmax", "175"],
      // Two populated slots and order 1: swapped.
      ["I1", I_SIGNATURES.I2],
      ["I2", I_SIGNATURES.I1],
    ] as const) {
      expect(awg[key]).toBe(value);
      expect(lastConfig[key]).toBe(value);
      expect(line(key)).toBe(value);
    }
    // Empty slots stay empty keys and gain no conf line.
    expect(awg.I3).toBe("");
    expect(lastConfig.I3).toBe("");
    expect(line("I3")).toBeNull();
    expect(inspectAwg31ClientConfig(out)).toEqual({ jc: 4, jmin: 45, jmax: 175 });
  });

  it("reorders three populated slots by the saved index", () => {
    const base = awg31Link({ slots: ["I1", "I2", "I3"] });
    const seen = new Set<string>();
    for (let cpsOrder = 0; cpsOrder < 6; cpsOrder += 1) {
      const { line } = readCopies(applyAwgClientProfile(base, { ...profile, cpsOrder }), decodeVpnLink);
      const order = [line("I1"), line("I2"), line("I3")];
      expect([...order].sort()).toEqual(
        [I_SIGNATURES.I1, I_SIGNATURES.I2, I_SIGNATURES.I3].sort(),
      );
      seen.add(order.join("|"));
    }
    expect(seen.size).toBe(6);
  });

  it.each([
    ["a single entry", ["I1"] as const],
    ["a set with a gap", ["I1", "I3"] as const],
    ["a set that uses I4", ["I1", "I2", "I3", "I4"] as const],
    ["a set that uses I5", ["I1", "I5"] as const],
  ])("keeps the I slots of %s as they are", (_name, slots) => {
    const base = awg31Link({ slots: [...slots] });
    const before = readCopies(base, decodeVpnLink);
    const after = readCopies(applyAwgClientProfile(base, { ...profile, cpsOrder: 5 }), decodeVpnLink);
    for (const key of ["I1", "I2", "I3", "I4", "I5"]) {
      expect(after.line(key)).toBe(before.line(key));
      expect(after.awg[key]).toBe(before.awg[key]);
      expect(after.lastConfig[key]).toBe(before.lastConfig[key]);
    }
    expect(after.line("Jc")).toBe("4");
  });

  it("keeps CRLF line endings", () => {
    const base = awg31Link({ crlf: true });
    const out = applyAwgClientProfile(base, profile);
    const conf = extractConfFromVpnLink(out);
    expect(conf).toContain("Jc = 4\r\n");
    expect(conf.split("\n").slice(0, -1).every((line) => line.endsWith("\r"))).toBe(true);
    expect(inspectAwg31ClientConfig(out)).toEqual({ jc: 4, jmin: 45, jmax: 175 });
  });

  it("gives the same bytes on every export of the same profile", () => {
    const base = awg31Link();
    expect(applyAwgClientProfile(base, profile)).toBe(applyAwgClientProfile(base, profile));
  });

  it("keeps all three copies in step across the full range of draws", () => {
    const base = awg31Link({ slots: ["I1", "I2", "I3"] });
    for (let n = 0; n < 300; n += 1) {
      const drawn = selectAwgClientProfile(n + 1);
      const out = applyAwgClientProfile(base, drawn);
      expect(inspectAwg31ClientConfig(out)).toEqual({
        jc: drawn.jc,
        jmin: drawn.jmin,
        jmax: drawn.jmax,
      });
    }
  });

  it("refuses an invalid saved profile on an eligible artifact, without echoing it", () => {
    expect(() =>
      applyAwgClientProfile(awg31Link(), { ...profile, jc: 99, secret: "PrivateKey" }),
    ).toThrow(/^The saved AWG client profile is invalid$/);
  });

  it("survives the ru_blacklist route overlay on top", () => {
    const routed = applyRouteProfileToVpnLink(
      applyAwgClientProfile(awg31Link(), profile),
      "ru_blacklist",
      { cidrs: ["203.0.113.0/24", "198.51.100.0/24"] },
    );
    expect(inspectAwg31ClientConfig(routed)).toEqual({ jc: 4, jmin: 45, jmax: 175 });
    const { lastConfig, line } = readCopies(routed, decodeVpnLink);
    const expected = ["203.0.113.0/24", "198.51.100.0/24", "1.1.1.1/32", "1.0.0.1/32"];
    expect(lastConfig.allowed_ips).toEqual(expected);
    expect(line("AllowedIPs")).toBe(expected.join(", "));
  });
});
