import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  ConfigError,
  decodeVpnLink,
  extractConf,
  parseClientConfig,
  withEndpoint,
} from "../src/config.js";

const CONF = `[Interface]
Address = 10.90.0.7/32
DNS = 1.1.1.1, 1.0.0.1
MTU = 1280
Table = off
PreUp = echo pre
PostUp = echo up
PreDown = echo predown
PostDown = echo down
SaveConfig = false
PrivateKey = cHJpdmF0ZS1rZXktZml4dHVyZS1ub3QtYS1yZWFsLWtleQ=
Jc = 4
Jmin = 10
Jmax = 50
H1 = 1234-5678
I1 = <b 0xdeadbeef>
HeaderProtectionKey = aGVhZGVyLXByb3RlY3Rpb24ta2V5LWZpeHR1cmUtLS0=

[Peer]
PublicKey = cHVibGljLWtleS1maXh0dXJlLW5vdC1hLXJlYWwta2V5LQ=
PresharedKey = cHJlc2hhcmVkLWtleS1maXh0dXJlLW5vdC1hLXJlYWwtaw=
AllowedIPs = 10.0.0.0/8
Endpoint = 192.0.2.10:51890
PersistentKeepalive = 25
`;

const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const keysOf = (text: string): string[] =>
  linesOf(text)
    .filter((line) => !line.startsWith("["))
    .map((line) => line.split("=")[0]!.trim().toLowerCase());

const buildLink = (payload: unknown): string => {
  const raw = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length, 0);
  return `vpn://${Buffer.concat([header, deflateSync(raw)]).toString("base64url")}`;
};

describe("parseClientConfig", () => {
  it("parses address, mtu and endpoint", () => {
    const parsed = parseClientConfig(CONF);
    expect(parsed).toMatchObject({
      address: "10.90.0.7",
      mtu: 1280,
      endpointHost: "192.0.2.10",
      endpointPort: 51890,
    });
  });

  it("strips interface-only keys", () => {
    const keys = keysOf(parseClientConfig(CONF).stripped);
    for (const dropped of [
      "address",
      "dns",
      "mtu",
      "table",
      "preup",
      "postup",
      "predown",
      "postdown",
      "saveconfig",
    ]) {
      expect(keys).not.toContain(dropped);
    }
    for (const kept of [
      "privatekey",
      "jc",
      "h1",
      "i1",
      "headerprotectionkey",
      "publickey",
      "presharedkey",
      "endpoint",
      "persistentkeepalive",
    ]) {
      expect(keys).toContain(kept);
    }
  });

  it("strips interface-only keys whatever their case", () => {
    const keys = keysOf(
      parseClientConfig(CONF.replace("MTU = 1280", "mtu=1280").replace("DNS =", "dns =")).stripped,
    );
    expect(keys).not.toContain("mtu");
    expect(keys).not.toContain("dns");
  });

  it("overrides AllowedIPs to full tunnel", () => {
    const stripped = linesOf(parseClientConfig(CONF).stripped);
    const allowed = stripped.filter((line) => /^allowedips\s*=/i.test(line));
    expect(allowed).toEqual(["AllowedIPs = 0.0.0.0/0, ::/0"]);
  });

  it("collapses several AllowedIPs lines into one", () => {
    const conf = CONF.replace(
      "AllowedIPs = 10.0.0.0/8",
      "AllowedIPs = 10.0.0.0/8\nAllowedIPs = 198.51.100.0/24",
    );
    const allowed = linesOf(parseClientConfig(conf).stripped).filter((line) =>
      /^allowedips\s*=/i.test(line),
    );
    expect(allowed).toEqual(["AllowedIPs = 0.0.0.0/0, ::/0"]);
  });

  it("adds a full-tunnel AllowedIPs when the peer has none", () => {
    const conf = CONF.replace("AllowedIPs = 10.0.0.0/8\n", "");
    const lines = linesOf(parseClientConfig(conf).stripped);
    const peerAt = lines.indexOf("[Peer]");
    expect(lines.slice(peerAt)).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
  });

  it("keeps an existing keepalive, including a 3.1 range", () => {
    const conf = CONF.replace("PersistentKeepalive = 25", "PersistentKeepalive = 25-35");
    const lines = linesOf(parseClientConfig(conf).stripped).filter((line) =>
      /^persistentkeepalive\s*=/i.test(line),
    );
    expect(lines).toEqual(["PersistentKeepalive = 25-35"]);
  });

  it("adds a keepalive to the peer when the config has none", () => {
    const conf = CONF.replace("PersistentKeepalive = 25\n", "");
    const lines = linesOf(parseClientConfig(conf).stripped);
    const peerAt = lines.indexOf("[Peer]");
    expect(lines.filter((line) => /^persistentkeepalive\s*=/i.test(line))).toEqual([
      "PersistentKeepalive = 25",
    ]);
    expect(lines.indexOf("PersistentKeepalive = 25")).toBeGreaterThan(peerAt);
  });

  it("rejects a missing endpoint", () => {
    expect(() => parseClientConfig(CONF.replace(/^Endpoint.*$/m, ""))).toThrow(ConfigError);
  });

  it("rejects a missing address", () => {
    expect(() => parseClientConfig(CONF.replace(/^Address.*$/m, ""))).toThrow(ConfigError);
  });

  it("rejects an address line without IPv4", () => {
    expect(() =>
      parseClientConfig(CONF.replace("Address = 10.90.0.7/32", "Address = fd00::7/128")),
    ).toThrow(ConfigError);
  });

  it("rejects an endpoint without a valid port", () => {
    expect(() =>
      parseClientConfig(CONF.replace("192.0.2.10:51890", "192.0.2.10:99999")),
    ).toThrow(ConfigError);
  });

  it("takes the first IPv4 of a multi-address Address line", () => {
    const conf = CONF.replace("Address = 10.90.0.7/32", "Address = 10.90.0.7/32, fd00::7/128");
    expect(parseClientConfig(conf).address).toBe("10.90.0.7");
    const v6first = CONF.replace("Address = 10.90.0.7/32", "Address = fd00::7/128, 10.90.0.8/32");
    expect(parseClientConfig(v6first).address).toBe("10.90.0.8");
  });

  it("returns null mtu when the config has none", () => {
    expect(parseClientConfig(CONF.replace(/^MTU.*$/m, "")).mtu).toBeNull();
  });

  it("parses a hostname endpoint and a bracketed IPv6 endpoint", () => {
    const host = parseClientConfig(CONF.replace("192.0.2.10:51890", "node-a.example.test:51890"));
    expect(host).toMatchObject({ endpointHost: "node-a.example.test", endpointPort: 51890 });
    const v6 = parseClientConfig(CONF.replace("192.0.2.10:51890", "[2001:db8::10]:51890"));
    expect(v6).toMatchObject({ endpointHost: "2001:db8::10", endpointPort: 51890 });
  });

  it("never quotes config content in an error reason", () => {
    const secret = "SENTINEL-SECRET-VALUE";
    const conf = `[Interface]\nPrivateKey = ${secret}\n[Peer]\nEndpoint = ${secret}\n`;
    try {
      parseClientConfig(conf);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("withEndpoint", () => {
  it("pins the peer endpoint to a resolved address", () => {
    const conf = CONF.replace("192.0.2.10:51890", "node-a.example.test:51890");
    const pinned = withEndpoint(parseClientConfig(conf).stripped, "192.0.2.10", 51890);
    expect(linesOf(pinned)).toContain("Endpoint = 192.0.2.10:51890");
    expect(pinned).not.toContain("node-a.example.test");
    const v6 = withEndpoint(parseClientConfig(conf).stripped, "2001:db8::10", 51890);
    expect(linesOf(v6)).toContain("Endpoint = [2001:db8::10]:51890");
  });
});

describe("vpn:// links", () => {
  it("decodes a vpn:// link", () => {
    const link = buildLink({
      containers: [{ awg: { last_config: JSON.stringify({ config: CONF }) } }],
    });
    expect(decodeVpnLink(link)).toMatchObject({ containers: [{ awg: {} }] });
    expect(extractConf(link)).toBe(CONF);
  });

  it("passes raw conf text through", () => {
    expect(extractConf(CONF)).toBe(CONF);
  });

  it("decodes a link with surrounding whitespace", () => {
    const link = buildLink({
      containers: [{ awg: { last_config: JSON.stringify({ config: CONF }) } }],
    });
    expect(extractConf(`  ${link}\n`)).toBe(CONF);
  });

  it("rejects a link without an embedded config", () => {
    const link = buildLink({ containers: [{ container: "amnezia-awg" }] });
    expect(() => extractConf(link)).toThrow(ConfigError);
  });

  it("rejects a corrupt link", () => {
    expect(() => extractConf("vpn://AAAA")).toThrow(ConfigError);
    expect(() => extractConf("vpn://not-base64-deflate-at-all")).toThrow(ConfigError);
  });

  it("rejects a link whose length header disagrees", () => {
    const raw = Buffer.from(JSON.stringify({ containers: [] }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(raw.length + 1, 0);
    const link = `vpn://${Buffer.concat([header, deflateSync(raw)]).toString("base64url")}`;
    expect(() => decodeVpnLink(link)).toThrow(ConfigError);
  });
});
