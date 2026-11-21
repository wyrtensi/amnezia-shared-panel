import { awgGeneratorPresets, type AwgGeneratorPreset } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";

import { awg31Link, I_SIGNATURES, readCopies } from "./awg31.fixture.js";
import { expandTemplate, packetKind, parseDns, parseStun, seededBytes } from "./awgPackets.fixture.js";
import { applyAwgGeneratorSettings, projectAwgClientConfig } from "@amnezia/vpn-config";
import { applyRouteProfileToVpnLink, decodeVpnLink, extractConfFromVpnLink } from "./vpnConfig.js";

const seed = { keyId: "synthetic-key-id", profileRevision: 3 };
const preset = (id: AwgGeneratorPreset) => awgGeneratorPresets().find((entry) => entry.id === id)!.settings;
const copies = (link: string) => readCopies(link, decodeVpnLink);
// The exact preset values for every key (randomization off).
const fixed = (id: AwgGeneratorPreset) => ({ ...preset(id), randomizeKeys: false });
// Settings stored before the randomization switch existed.
const savedBeforeSwitch = (id: AwgGeneratorPreset) => {
  const settings: Record<string, unknown> = { ...preset(id) };
  delete settings.randomizeKeys;
  return settings;
};

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
    const { awg, lastConfig, line } = copies(applyAwgGeneratorSettings(original, fixed("dns_response"), seed));
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
    const generated = applyAwgGeneratorSettings(original, fixed("dns_response"), seed);
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
    const { awg, lastConfig, conf, line } = copies(applyAwgGeneratorSettings(original, fixed("dns_response"), seed));
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

  it("draws a stable set of junk values and a valid DNS, STUN and noise mix", () => {
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
    const kinds = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const out = copies(applyAwgGeneratorSettings(awg31Link({ slots: ["I1", "I2", "I3"] }), settings, { keyId: `mix-${index}`, profileRevision: 1 }));
      for (const template of [out.line("I1"), out.line("I2"), out.line("I3")].filter(Boolean) as string[]) {
        const kind = packetKind(template);
        if (kind === "dns") kinds.add(parseDns(expandTemplate(template, seededBytes(index + 1))).response ? "response" : "query");
        else kinds.add(kind);
      }
    }
    expect(kinds).toEqual(new Set(["query", "response", "stun", "noise"]));
  });
  it("keeps backward compatibility with legacy randomized settings that stored iMode=dns_query", () => {
    const original = awg31Link({ slots: ["I1", "I2", "I3"] });
    const mixed = copies(applyAwgGeneratorSettings(original, preset("randomized"), seed));
    const legacy = copies(applyAwgGeneratorSettings(original, { ...preset("randomized"), iMode: "dns_query" }, seed));
    for (const slot of ["I1", "I2", "I3"]) expect(legacy.line(slot)).toBe(mixed.line(slot));
  });
  it("emits a valid RFC 1035/2181 randomized DNS response without CPA or timers", () => {
    const original = awg31Link({
      conf: (conf) => `${conf.replace("[Peer]", "ContentPaddingAddition = 1-39\nRekeyTimeout = 4-8\n\n[Peer]")}`,
    });
    const settings = preset("dns_response_randomized");
    const parsed = copies(applyAwgGeneratorSettings(original, settings, { ...seed, profileRevision: 1 }));
    const response = parseDns(expandTemplate(parsed.line("I1") ?? "", seededBytes(7)));
    expect(response.response).toBe(true);
    expect(response.answer?.ttl).toBeGreaterThanOrEqual(256);
    expect(response.answer?.ttl).toBeLessThanOrEqual(32767);
    expect(parsed.line("I2")).toBeNull();
    expect(parsed.line("ContentPaddingAddition")).toBeNull();
    expect(parsed.line("RekeyTimeout")).toBeNull();
    expect(Number(parsed.line("Jc"))).toBeGreaterThanOrEqual(3);
    expect(Number(parsed.line("Jc"))).toBeLessThanOrEqual(10);
  });
  it("supports single DNS-query, single STUN, no-I, and stock AmneziaVPN presets", () => {
    const original = awg31Link({ slots: ["I1", "I2", "I3"] });

    const dnsQueryOut = copies(applyAwgGeneratorSettings(original, preset("dns_query"), seed));
    expect(parseDns(expandTemplate(dnsQueryOut.line("I1") ?? "", seededBytes(1))).response).toBe(false);
    expect(dnsQueryOut.line("I2")).toBeNull();
    expect(dnsQueryOut.line("ContentPaddingAddition")).toBeNull();

    const stunOut = copies(applyAwgGeneratorSettings(original, preset("stun"), seed));
    expect(parseStun(expandTemplate(stunOut.line("I1") ?? "", seededBytes(1))).size).toBeGreaterThanOrEqual(20);
    expect(stunOut.line("I2")).toBeNull();
    expect(stunOut.line("ContentPaddingAddition")).toBeNull();

    const noIOut = copies(applyAwgGeneratorSettings(original, preset("no_i"), seed));
    for (const slot of ["I1", "I2", "I3", "I4", "I5"]) {
      expect(noIOut.line(slot)).toBeNull();
      expect(noIOut.awg[slot]).toBe("");
      expect(noIOut.lastConfig[slot]).toBe("");
    }

    const stockOut = copies(applyAwgGeneratorSettings(original, { ...preset("amnezia_default"), randomizeKeys: false }, seed));
    expect(stockOut.line("Jc")).toBe("4");
    expect(stockOut.line("Jmin")).toBe("10");
    expect(stockOut.line("Jmax")).toBe("50");
    expect(stockOut.line("ContentPaddingAddition")).toBe("10-100");
    expect(stockOut.line("RekeyAfterTime")).toBe("100-120");
    expect(stockOut.line("RejectAfterTime")).toBe("180-210");
    expect(stockOut.line("I1")).toMatch(/^<r 2><b 0x8580/);
    expect(stockOut.line("I2")).toBeNull();
  });

  it("draws both values of a two-value range across revisions, independently", () => {
    // A refresh that lands on the same config moves to the next revision in
    // defaultService, so a single revision may repeat the previous value.
    const original = awg31Link();
    const settings = {
      ...savedBeforeSwitch("custom"),
      jcMin: 3,
      jcMax: 4,
      jminMin: 40,
      jminMax: 40,
      jmaxGapMin: 30,
      jmaxGapMax: 30,
    };
    const drawn = Array.from({ length: 16 }, (_, profileRevision) =>
      copies(applyAwgGeneratorSettings(original, settings, { ...seed, profileRevision })).line("Jc"));
    expect(new Set(drawn)).toEqual(new Set(["3", "4"]));
    expect(drawn.some((value, index) => index > 0 && value === drawn[index - 1])).toBe(true);
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

describe("per-key randomization switch", () => {
  const original = awg31Link({ slots: ["I1", "I2", "I3"] });
  const keyIds = Array.from({ length: 8 }, (_, index) => `synthetic-key-${index}`);
  const render = (settings: unknown, keyId: string, profileRevision = 1) =>
    copies(applyAwgGeneratorSettings(original, settings, { keyId, profileRevision }));
  const jValues = (settings: unknown) =>
    new Set(keyIds.map((keyId) => {
      const { line } = render(settings, keyId);
      return `${line("Jc")}/${line("Jmin")}/${line("Jmax")}`;
    }));
  const legacy = (id: AwgGeneratorPreset) => {
    const settings: Record<string, unknown> = { ...preset(id) };
    delete settings.randomizeKeys;
    return settings;
  };

  it("redraws values independently on a refresh", () => {
    const settings = { ...preset("randomized"), randomizeKeys: true };
    const keys = Array.from({ length: 40 }, (_, index) => `synthetic-refresh-${index}`);
    const movedByOne = keys.filter((keyId) => {
      const before = render(settings, keyId, 1);
      const after = render(settings, keyId, 2);
      const values = (copy: ReturnType<typeof render>) =>
        [Number(copy.line("Jc")), Number(copy.line("Jmin")), Number(copy.line("Jmax")) - Number(copy.line("Jmin"))];
      const [a, b] = [values(before), values(after)];
      return a.every((value, index) => b[index] === value + 1);
    });
    expect(movedByOne.length).toBeLessThan(4);
  });

  it("gives every key the same values when randomization is off", () => {
    const settings = { ...preset("dns_query"), randomizeKeys: false };
    const first = applyAwgGeneratorSettings(original, settings, { keyId: keyIds[0]!, profileRevision: 1 });
    expect(applyAwgGeneratorSettings(original, settings, { keyId: keyIds[1]!, profileRevision: 5 })).toBe(first);
  });

  it("gives keys different values when randomization is on", () => {
    expect(jValues({ ...preset("dns_query"), randomizeKeys: true }).size).toBeGreaterThan(1);
  });

  it("widens J for a fixed preset when on and keeps its DNS response packet", () => {
    const settings = { ...preset("dns_response_random_ttl"), randomizeKeys: true };
    expect(jValues(settings).size).toBeGreaterThan(1);
    for (const keyId of keyIds) {
      const { line } = render(settings, keyId);
      expect(line("I1")).toMatch(/^<r 2><b 0x8580/);
      expect(Number(line("Jc"))).toBeGreaterThanOrEqual(3);
      expect(Number(line("Jc"))).toBeLessThanOrEqual(10);
      const gap = Number(line("Jmax")) - Number(line("Jmin"));
      expect(gap).toBeGreaterThanOrEqual(30);
      expect(gap).toBeLessThanOrEqual(200);
    }
  });

  it("renders settings saved before the switch exactly as before", () => {
    // Fixed presets gave every key 4/40/70; ranged presets drew per key.
    expect(jValues(legacy("dns_response"))).toEqual(new Set(["4/40/70"]));
    expect(jValues({ ...preset("dns_response"), randomizeKeys: false })).toEqual(new Set(["4/40/70"]));
    for (const keyId of keyIds) {
      expect(applyAwgGeneratorSettings(original, legacy("dns_query"), { keyId, profileRevision: 2 }))
        .toBe(applyAwgGeneratorSettings(original, { ...preset("dns_query"), randomizeKeys: true }, { keyId, profileRevision: 2 }));
    }
    expect(jValues(legacy("dns_query")).size).toBeGreaterThan(1);
  });

  it("pins the output of settings saved before the switch", () => {
    // For seed { keyId: "synthetic-key-id", profileRevision: 3 }. Moved on
    // purpose on 2026-11-22 (revision-seeded draws, varied DNS); any other change here
    // moves every stored key's config.
    const at = (id: AwgGeneratorPreset) => copies(applyAwgGeneratorSettings(original, legacy(id), seed));
    const dnsQuery = at("dns_query");
    expect([dnsQuery.line("Jc"), dnsQuery.line("Jmin"), dnsQuery.line("Jmax")]).toEqual(["8", "100", "139"]);
    expect(dnsQuery.line("I1")).toBe(
      "<r 2><b 0x01000001000000000001><b 0x07><rc 7><b 0x01><rc 1><b 0x04><rc 4><b 0x02727500><b 0x00010001>" +
        "<b 0x0000290200000080000000>",
    );
    const randomized = at("randomized");
    expect([randomized.line("Jc"), randomized.line("Jmin"), randomized.line("Jmax")]).toEqual(["10", "54", "197"]);
    const ttl = at("dns_response_random_ttl");
    expect([ttl.line("Jc"), ttl.line("Jmin"), ttl.line("Jmax")]).toEqual(["4", "40", "70"]);
    expect(ttl.line("I1")).toBe(
      "<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c00010001000010><r 1><b 0x00044d583737>",
    );
  });

  it("ignores the switch for the issued preset", () => {
    const on = applyAwgGeneratorSettings(original, { ...preset("issued"), randomizeKeys: true }, seed);
    expect(on).toBe(applyAwgGeneratorSettings(original, preset("issued"), seed));
  });

  it("emits the new signature packets in their slots", () => {
    const one = (id: AwgGeneratorPreset) => render(preset(id), keyIds[0]!);
    const dns = (template: string | null) => parseDns(expandTemplate(template ?? "", seededBytes(3)));
    const stun = (template: string | null) => parseStun(expandTemplate(template ?? "", seededBytes(3)));
    const aaaa = one("dns_query_aaaa");
    expect(dns(aaaa.line("I1")).qtype).toBe(28);
    expect(aaaa.line("I2")).toBeNull();
    expect(dns(one("dns_query_https").line("I1")).qtype).toBe(65);
    const burst = one("dns_query_burst");
    for (const slot of ["I1", "I2", "I3"]) expect(dns(burst.line(slot)).qtype).toBe(1);
    expect(burst.line("I4")).toBeNull();
    const dnsStun = one("dns_query_stun");
    expect(dns(dnsStun.line("I1")).response).toBe(false);
    expect(stun(dnsStun.line("I2")).size).toBeGreaterThanOrEqual(20);
    expect(dnsStun.line("I3")).toBeNull();
    const stunDns = one("stun_dns_response");
    expect(stun(stunDns.line("I1")).size).toBeGreaterThanOrEqual(20);
    expect(dns(stunDns.line("I2")).response).toBe(true);
    const noise = one("noise");
    for (const slot of ["I1", "I2", "I3"]) expect(noise.line(slot)).toMatch(/^<r \d+>$/);
    expect(one("noise_full").line("ContentPaddingAddition")).not.toBeNull();
    expect(one("noise_full").line("RekeyAfterTime")).not.toBeNull();
    expect(one("noise").line("ContentPaddingAddition")).toBeNull();
  });
});

describe("client MTU apart from the profile", () => {
  const original = awg31Link({ slots: ["I1", "I2", "I3"] });
  const project = (generator: unknown, mtu?: number) => copies(projectAwgClientConfig(original, {
    protocol: "awg3",
    keyId: "synthetic-key-mtu",
    clientProfile: null,
    generator: generator as ReturnType<typeof preset> | null,
    ...(mtu === undefined ? {} : { mtu }),
  }));

  it("applies the MTU given apart from the profile", () => {
    const { conf, lastConfig } = project(preset("issued"), 1400);
    expect(conf).toContain("MTU = 1400\n");
    expect(lastConfig.mtu).toBe("1400");
  });

  it("keeps every drawn value when only the MTU changes", () => {
    const low = project(preset("randomized"), 1300);
    const high = project(preset("randomized"), 1400);
    expect(high.conf).not.toBe(low.conf);
    expect(high.conf.replace("MTU = 1400", "MTU = 1300")).toBe(low.conf);
    expect(project(preset("randomized")).conf.replace("MTU = 1280", "MTU = 1300")).toBe(low.conf);
  });

  it("applies the MTU without a profile", () => {
    expect(project(null, 1380).conf).toContain("MTU = 1380\n");
    expect(project(null).conf).toContain("MTU = 1280\n");
  });
});

describe("signature packet validity and variety", () => {
  const original = awg31Link({ slots: ["I1", "I2", "I3", "I4", "I5"] });
  const WITH_PACKETS: AwgGeneratorPreset[] = [
    "dns_response_randomized", "dns_query", "stun", "randomized",
    "dns_query_aaaa", "dns_query_aaaa_full", "dns_query_https", "dns_query_https_full",
    "dns_query_burst", "dns_query_burst_full", "dns_query_stun", "dns_query_stun_full",
    "stun_dns_response", "stun_dns_response_full", "varied", "varied_full",
  ];
  const packetsOf = (id: AwgGeneratorPreset, keyId: string, profileRevision = 1) => {
    const { line } = copies(applyAwgGeneratorSettings(original, { ...preset(id), randomizeKeys: true }, { keyId, profileRevision }));
    return ["I1", "I2", "I3", "I4", "I5"].map(line).filter((value): value is string => Boolean(value));
  };
  const keys = (count: number) => Array.from({ length: count }, (_, index) => `synthetic-packet-${index}`);

  it("parses every DNS packet as RFC 1035/2181/6891 and every STUN packet as RFC 5389", () => {
    const counts = { dns: 0, stun: 0, noise: 0 };
    for (const id of WITH_PACKETS) {
      for (const [index, keyId] of keys(60).entries()) {
        for (const template of packetsOf(id, keyId, index % 4)) {
          const kind = packetKind(template);
          counts[kind] += 1;
          const bytes = expandTemplate(template, seededBytes(index + 1));
          try {
            if (kind === "dns") parseDns(bytes);
            if (kind === "stun") parseStun(bytes);
          } catch (error) {
            throw new Error(`${id} ${keyId}: ${(error as Error).message} in ${template}`, { cause: error });
          }
        }
      }
    }
    expect(counts.dns).toBeGreaterThan(500);
    expect(counts.stun).toBeGreaterThan(100);
  });

  it("gives keys different DNS names, OPT records and STUN sizes", () => {
    const parsed = keys(200).map((keyId, index) => parseDns(expandTemplate(packetsOf("dns_query", keyId)[0] ?? "", seededBytes(index + 1))));
    expect(new Set(parsed.map(({ labels }) => labels.at(-1))).size).toBeGreaterThanOrEqual(4);
    expect(new Set(parsed.map(({ labels }) => labels.length))).toEqual(new Set([2, 3, 4]));
    expect(parsed.some(({ edns }) => edns === null)).toBe(true);
    expect(parsed.some(({ edns }) => edns !== null)).toBe(true);
    const stunSizes = keys(200).map((keyId, index) =>
      parseStun(expandTemplate(packetsOf("stun", keyId)[0] ?? "", seededBytes(index + 1))).size);
    expect(new Set(stunSizes).size).toBeGreaterThanOrEqual(4);
    expect(Math.min(...stunSizes)).toBe(20);
    const octets = keys(200).map((keyId, index) =>
      parseDns(expandTemplate(packetsOf("dns_response_randomized", keyId)[0] ?? "", seededBytes(index + 1))).answer?.ipv4[0]);
    expect(new Set(octets).size).toBeGreaterThanOrEqual(5);
  });

  it("draws the query type of a varied DNS query from A, AAAA and HTTPS", () => {
    const qtypes = keys(200).flatMap((keyId, index) => packetsOf("varied", keyId)
      .filter((template) => packetKind(template) === "dns" && !template.includes("<b 0x8180"))
      .map((template) => parseDns(expandTemplate(template, seededBytes(index + 1))).qtype));
    expect(new Set(qtypes)).toEqual(new Set([0x0001, 0x001c, 0x0041]));
  });

  it("sends the random DNS response in stun_dns_response and can mix it into randomized", () => {
    for (const [index, keyId] of keys(20).entries()) {
      const [stun, response] = packetsOf("stun_dns_response", keyId);
      expect(packetKind(stun ?? "")).toBe("stun");
      const parsed = parseDns(expandTemplate(response ?? "", seededBytes(index + 1)));
      expect(parsed.response).toBe(true);
      expect(parsed.labels).not.toEqual(["icloud", "com"]);
    }
    const mixedResponses = keys(80).flatMap((keyId) => packetsOf("randomized", keyId))
      .filter((template) => template.includes("<b 0x8180"));
    expect(mixedResponses.length).toBeGreaterThan(0);
  });
});

describe("per-key spread", () => {
  const original = awg31Link({ slots: ["I1", "I2", "I3", "I4", "I5"] });
  const keys = (count: number) => Array.from({ length: count }, (_, index) => `synthetic-spread-${index}`);
  const out = (settings: unknown, keyId: string) =>
    copies(applyAwgGeneratorSettings(original, settings, { keyId, profileRevision: 1 }));
  const slots = (copy: ReturnType<typeof out>) =>
    ["I1", "I2", "I3", "I4", "I5"].map(copy.line).filter((value): value is string => Boolean(value));
  const range = (value: string | null) => {
    const [min, max] = (value ?? "").split("-").map(Number);
    return { min: min ?? Number.NaN, max: max ?? Number.NaN };
  };
  const on = (id: AwgGeneratorPreset) => ({ ...preset(id), randomizeKeys: true });
  const off = (id: AwgGeneratorPreset) => ({ ...preset(id), randomizeKeys: false });

  it("draws the I count per key for mixed and varied only", () => {
    expect(new Set(keys(60).map((keyId) => slots(out(on("randomized"), keyId)).length))).toEqual(new Set([1, 2, 3]));
    for (const keyId of keys(20)) {
      expect(slots(out(on("dns_query_burst_full"), keyId))).toHaveLength(3);
      expect(slots(out(on("dns_query_stun_full"), keyId))).toHaveLength(2);
      expect(slots(out(on("dns_query_aaaa_full"), keyId))).toHaveLength(1);
      expect(slots(out(off("randomized"), keyId))).toHaveLength(3);
    }
  });

  it("spreads CPA and timings per key inside the configured ranges with every invariant", () => {
    const full = preset("randomized");
    const cpas = new Set<string>();
    for (const id of ["randomized", "noise_full", "dns_query_stun_full", "varied_full"] as const) {
      for (const keyId of keys(60)) {
        const copy = out(on(id), keyId);
        const cpa = range(copy.line("ContentPaddingAddition"));
        cpas.add(`${cpa.min}-${cpa.max}`);
        expect(cpa.min).toBeGreaterThanOrEqual(1);
        expect(cpa.max).toBeLessThanOrEqual(39);
        expect(cpa.min).toBeLessThanOrEqual(cpa.max);
        const t = {
          rekeyAfter: range(copy.line("RekeyAfterTime")),
          rekeyTimeout: range(copy.line("RekeyTimeout")),
          rejectAfter: range(copy.line("RejectAfterTime")),
          keepalive: range(copy.line("KeepaliveTimeout")),
          handshakes: range(copy.line("MaxHandshakeAttempts")),
        };
        const configured = full.timings!;
        const within = (value: { min: number; max: number }, bounds: { min: number; max: number }) =>
          value.min >= bounds.min && value.max <= bounds.max && value.min <= value.max;
        expect(within(t.rekeyAfter, configured.rekeyAfterTime)).toBe(true);
        expect(within(t.rekeyTimeout, configured.rekeyTimeout)).toBe(true);
        expect(within(t.rejectAfter, configured.rejectAfterTime)).toBe(true);
        expect(within(t.keepalive, configured.keepaliveTimeout)).toBe(true);
        expect(within(t.handshakes, configured.maxHandshakeAttempts)).toBe(true);
        expect(t.rejectAfter.min).toBeGreaterThan(t.rekeyAfter.max);
        expect(t.rejectAfter.min).toBeGreaterThan(t.keepalive.max + t.rekeyTimeout.max);
      }
    }
    expect(cpas.size).toBeGreaterThan(10);
    for (const keyId of keys(10)) {
      const copy = out(off("randomized"), keyId);
      expect(copy.line("ContentPaddingAddition")).toBe("1-39");
      expect(copy.line("RekeyAfterTime")).toBe("95-150");
    }
  });

  it("keeps amnezia_default exact stock with randomization off and varies J with it on", () => {
    for (const keyId of keys(10)) {
      const copy = out(off("amnezia_default"), keyId);
      expect([copy.line("Jc"), copy.line("Jmin"), copy.line("Jmax")]).toEqual(["4", "10", "50"]);
      expect(copy.line("ContentPaddingAddition")).toBe("10-100");
      expect(copy.line("RekeyAfterTime")).toBe("100-120");
      expect(copy.line("RejectAfterTime")).toBe("180-210");
    }
    const drawn = keys(40).map((keyId) => out(on("amnezia_default"), keyId));
    expect(new Set(drawn.map((copy) => copy.line("Jmin"))).size).toBeGreaterThan(3);
    expect(new Set(drawn.map((copy) => copy.line("Jmax"))).size).toBeGreaterThan(3);
  });

  it("gives keys of varied different I shapes, without CPA or timings, and varied_full with them", () => {
    const shapes = new Set<string>();
    for (const [index, keyId] of keys(60).entries()) {
      const copy = out(on("varied"), keyId);
      expect(copy.line("ContentPaddingAddition")).toBeNull();
      expect(copy.line("RekeyAfterTime")).toBeNull();
      const templates = slots(copy);
      shapes.add(templates.map((template) => {
        const kind = packetKind(template);
        return kind === "dns" ? (parseDns(expandTemplate(template, seededBytes(index + 1))).response ? "response" : "query") : kind;
      }).join("+"));
    }
    expect(shapes.size).toBeGreaterThanOrEqual(4);
    expect(out(on("varied_full"), "synthetic-full").line("ContentPaddingAddition")).not.toBeNull();
    const shared = new Set(keys(10).map((keyId) => slots(out(off("varied"), keyId)).join("|")));
    expect(shared.size).toBe(1);
  });

  it("randomizes a custom profile when asked", () => {
    const custom = { ...preset("custom"), jcMin: 3, jcMax: 10, randomizeKeys: true };
    expect(new Set(keys(20).map((keyId) => out(custom, keyId).line("Jc"))).size).toBeGreaterThan(1);
  });
});
