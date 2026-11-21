import { awgGeneratorPresets, type AwgGeneratorPreset } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";

import { awg31Link, I_SIGNATURES, readCopies } from "./awg31.fixture.js";
import { applyAwgGeneratorSettings } from "@amnezia/vpn-config";
import { applyRouteProfileToVpnLink, decodeVpnLink, extractConfFromVpnLink } from "./vpnConfig.js";

const seed = { keyId: "synthetic-key-id", profileRevision: 3 };
const preset = (id: AwgGeneratorPreset) => awgGeneratorPresets().find((entry) => entry.id === id)!.settings;
const copies = (link: string) => readCopies(link, decodeVpnLink);

describe("applyAwgGeneratorSettings", () => {
  it("keeps the issued profile while setting MTU in every existing copy", () => {
    const original = awg31Link({ outer: (awg) => { awg.mtu = 1376; } });
    const before = copies(original);
    const after = copies(applyAwgGeneratorSettings(original, preset("issued"), seed));
    expect(after.lastConfig).toEqual({ ...before.lastConfig, config: after.conf, mtu: "1280" });
    expect(after.awg).toEqual({ ...before.awg, last_config: after.awg.last_config, mtu: 1280 });
    expect(after.conf).toContain("MTU = 1280\n");
    expect(after.conf.replace(/^MTU = 1280\n/m, "")).toBe(before.conf);
  });

  it.each(["issued", "dns_response"] as const)("canonicalizes duplicate MTU lines with the %s preset", (id) => {
    const original = awg31Link({
      crlf: true,
      conf: (conf) => conf.replace("[Interface]", "[Interface]\r\nMTU = 1300\r\nmtu = 1360"),
      outer: (awg) => { awg.mtu = 1376; },
    });
    const { awg, lastConfig, conf } = copies(applyAwgGeneratorSettings(original, { ...preset(id), mtu: 1340 }, seed));
    expect(conf.match(/^MTU\s*=.*$/gmi)).toEqual(["MTU = 1340"]);
    expect(conf).toContain("MTU = 1340\r\n");
    expect(lastConfig.mtu).toBe("1340");
    expect(awg.mtu).toBe(1340);
  });

  it("rejects duplicate generator fields other than MTU", () => {
    const original = awg31Link({ conf: (conf) => conf.replace("[Interface]", "[Interface]\njc = 4") });
    expect(() => applyAwgGeneratorSettings(original, preset("dns_response"), seed))
      .toThrow(/^AWG generator settings require a valid AWG 3\.1 config$/);
  });

  it("writes the tested DNS response shape and clears the unused I slots everywhere", () => {
    const original = awg31Link({ slots: ["I1", "I3", "I5"] });
    const { awg, lastConfig, line } = copies(applyAwgGeneratorSettings(original, preset("dns_response"), seed));
    const expected = {
      Jc: "4",
      Jmin: "40",
      Jmax: "70",
      I1: "<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>",
      I2: "",
      I3: "",
      I4: "",
      I5: "",
      RandomTrailers: "on",
    };
    expect(awg).toMatchObject(expected);
    expect(lastConfig).toMatchObject(expected);
    for (const [key, value] of Object.entries(expected)) expect(line(key)).toBe(value || null);
  });

  it("preserves object-form last_config through generated and routed conf export", () => {
    const original = awg31Link({
      outer: (awg) => { awg.last_config = JSON.parse(String(awg.last_config)); },
    });
    const generated = applyAwgGeneratorSettings(original, preset("dns_response"), seed);
    const routed = applyRouteProfileToVpnLink(generated, "ru_blacklist", { cidrs: ["203.0.113.0/24"] });
    const after = copies(routed);
    expect(typeof after.awg.last_config).toBe("object");
    expect(after.lastConfig.Jc).toBe("4");
    expect(after.line("Jc")).toBe("4");
    expect(after.line("AllowedIPs")).toBe("203.0.113.0/24, 1.1.1.1/32, 1.0.0.1/32");
    expect(after.line("PrivateKey")).toBe(copies(original).line("PrivateKey"));
    expect(extractConfFromVpnLink(routed)).toBe(after.conf);
  });

  it("adds missing J and I settings to an older AWG 3.1 layout", () => {
    const removeSlots = (record: Record<string, unknown>) => {
      for (const key of ["I1", "I2", "I3", "I4", "I5"]) delete record[key];
    };
    const original = awg31Link({
      j: null,
      slots: [],
      outer: removeSlots,
      inner: removeSlots,
      payload: (payload) => { delete payload.defaultContainer; },
      conf: (conf) => conf.replace("[Interface]", "[interface]\nmtu = 1376"),
    });
    const { awg, lastConfig, conf, line } = copies(applyAwgGeneratorSettings(original, preset("dns_response"), seed));
    expect(awg.Jc).toBe("4");
    expect(lastConfig.Jmin).toBe("40");
    expect(line("Jmax")).toBe("70");
    expect(awg.I1).toBe(line("I1"));
    expect(awg.I1).toMatch(/^<r 2>/);
    expect(conf.match(/^mtu\s*=/gmi)).toHaveLength(1);
    expect(conf).toContain("MTU = 1280\n");
  });

  it("keeps the DNS packet length and refreshes the TTL window", () => {
    const original = awg31Link();
    const settings = preset("dns_response_random_ttl");
    const render = (profileRevision: number) => applyAwgGeneratorSettings(original, settings, { ...seed, profileRevision });
    const initial = render(3);
    expect(render(3)).toBe(initial);
    const match = /^<r 2><b 0x(858000010001000000000669636c6f756403636f6d0000010001c00c000100010000(?:0f|10|11))><r 1><b 0x(00044d583737)>$/;
    const first = match.exec(copies(initial).line("I1") ?? "");
    expect(first).not.toBeNull();
    expect(2 + first![1]!.length / 2 + 1 + first![2]!.length / 2).toBe(44);
    expect(copies(render(4)).line("I1")).toMatch(match);
    expect(copies(render(4)).line("I1")).not.toBe(copies(initial).line("I1"));
  });

  it("inserts missing interface options and preserves peer and handshake data", () => {
    const mtu = 1337;
    const original = awg31Link({ crlf: true });
    const before = copies(original);
    const { awg, lastConfig, conf, line } = copies(applyAwgGeneratorSettings(original, {
      ...preset("custom"),
      mtu,
      contentPaddingAddition: { min: 1, max: 11 },
      timings: {
        rekeyAfterTime: { min: 95, max: 140 },
        rekeyTimeout: { min: 4, max: 8 },
        rejectAfterTime: { min: 200, max: 260 },
        keepaliveTimeout: { min: 9, max: 19 },
        maxHandshakeAttempts: { min: 12, max: 16 },
      },
    }, seed));
    expect(lastConfig.mtu).toBe("1337");
    expect(line("MTU")).toBe("1337");
    expect(line("I1")).toBe(I_SIGNATURES.I1);
    expect(line("I2")).toBe(I_SIGNATURES.I2);
    const expected = {
      ContentPaddingAddition: "1-11",
      RekeyAfterTime: "95-140",
      RekeyTimeout: "4-8",
      RejectAfterTime: "200-260",
      KeepaliveTimeout: "9-19",
      MaxHandshakeAttempts: "12-16",
      RandomTrailers: "on",
    };
    expect(awg).toMatchObject(expected);
    expect(lastConfig).toMatchObject(expected);
    for (const [key, value] of Object.entries(expected)) expect(line(key)).toBe(value);
    for (const key of ["S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4", "HeaderProtectionKey"]) {
      expect(awg[key]).toBe(before.awg[key]);
      expect(lastConfig[key]).toBe(before.lastConfig[key]);
      expect(line(key)).toBe(before.line(key));
    }
    expect(line("PrivateKey")).toBe(before.line("PrivateKey"));
    expect(lastConfig.client_priv_key).toBe(before.lastConfig.client_priv_key);
    expect(conf.split("[Peer]")[1]).toBe(before.conf.split("[Peer]")[1]);
    expect(conf.split("\n").slice(0, -1).every((part) => part.endsWith("\r"))).toBe(true);
  });

  it("rewrites an existing empty option on a CRLF line", () => {
    const original = awg31Link({
      crlf: true,
      conf: (conf) => conf.replace("[Peer]", "ContentPaddingAddition = \r\n\r\n[Peer]"),
    });
    const { conf } = copies(applyAwgGeneratorSettings(original, {
      ...preset("custom"),
      contentPaddingAddition: { min: 1, max: 11 },
    }, seed));
    expect(conf).toContain("ContentPaddingAddition = 1-11\r\n");
  });

  it("clears inherited padding and timing ranges without changing the node trailer mode", () => {
    const inherited = { ContentPaddingAddition: "1-39", RekeyTimeout: "4-8", RandomTrailers: "off" };
    const original = awg31Link({
      conf: (conf) => conf.replace("RandomTrailers = on", "RandomTrailers = off\nContentPaddingAddition = 1-39\nRekeyTimeout = 4-8"),
      outer: (awg) => Object.assign(awg, inherited),
      inner: (lastConfig) => Object.assign(lastConfig, inherited),
    });
    const { awg, lastConfig, line } = copies(applyAwgGeneratorSettings(original, preset("dns_response"), seed));
    for (const key of ["ContentPaddingAddition", "RekeyTimeout"]) {
      expect(awg).not.toHaveProperty(key);
      expect(lastConfig).not.toHaveProperty(key);
      expect(line(key)).toBeNull();
    }
    expect(awg.RandomTrailers).toBe("off");
    expect(lastConfig.RandomTrailers).toBe("off");
    expect(line("RandomTrailers")).toBe("off");
    expect(line("PersistentKeepalive")).toBe("25-35");
  });

  it("draws a stable set of junk values and DNS-query, STUN and noise templates", () => {
    const original = awg31Link();
    const settings = preset("randomized");
    const initial = applyAwgGeneratorSettings(original, settings, seed);
    expect(applyAwgGeneratorSettings(original, settings, seed)).toBe(initial);
    expect(applyAwgGeneratorSettings(original, settings, { ...seed, profileRevision: 4 })).not.toBe(initial);
    const { line } = copies(initial);
    expect(Number(line("Jc"))).toBeGreaterThanOrEqual(3);
    expect(Number(line("Jc"))).toBeLessThanOrEqual(10);
    expect(Number(line("Jmax")) - Number(line("Jmin"))).toBeGreaterThanOrEqual(30);
    expect(Number(line("Jmax")) - Number(line("Jmin"))).toBeLessThanOrEqual(200);
    const templates = [line("I1"), line("I2"), line("I3")];
    expect(templates.some((value) => value?.includes("<b 0x0100>"))).toBe(true);
    expect(templates.some((value) => value?.includes("<b 0x2112a442>"))).toBe(true);
    expect(templates.some((value) => /^<r \d+>$/.test(value ?? ""))).toBe(true);
  });

  it("changes a custom J draw on consecutive revisions even in a two-value range", () => {
    const original = awg31Link();
    const settings = {
      ...preset("custom"),
      jcMin: 3,
      jcMax: 4,
      jminMin: 40,
      jminMax: 40,
      jmaxGapMin: 30,
      jmaxGapMax: 30,
    };
    let previous: string | null = null;
    for (let profileRevision = 0; profileRevision < 8; profileRevision += 1) {
      const link = applyAwgGeneratorSettings(original, settings, { ...seed, profileRevision });
      const current = copies(link).line("Jc");
      expect(["3", "4"]).toContain(current);
      expect(current).not.toBe(previous);
      previous = current;
    }
  });

  it("reports invalid saved settings without leaking configuration values", () => {
    const settings = { ...preset("custom"), secret: "synthetic-sensitive-input" };
    expect(() => applyAwgGeneratorSettings(awg31Link(), settings, seed)).toThrow(/^The saved AWG generator settings are invalid$/);
  });

  it("reports an ineligible config without leaking the artifact", () => {
    expect(() => applyAwgGeneratorSettings(awg31Link({ protocolVersion: "2" }), preset("issued"), seed))
      .toThrow(/^AWG generator settings require a valid AWG 3\.1 config$/);
  });
});
