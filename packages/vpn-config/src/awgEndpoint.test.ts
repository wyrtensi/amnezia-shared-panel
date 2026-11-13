import { describe, expect, it } from "vitest";

import { decodeVpnLink, encodeVpnPayload, type AmneziaPayload } from "./codec.js";
import {
  AwgEndpointRenderError,
  inspectAwgArtifact,
  inspectAwgVpnLink,
  renderAwgEndpoint,
  renderAwgEndpointVpnLink,
} from "./awgEndpoint.js";
import { buildArtifact, buildLink, readEndpointCopies } from "./fixtures.js";

const lastConfigOf = (payload: AmneziaPayload) =>
  JSON.parse(String(payload.containers?.[0]?.awg?.last_config)) as Record<string, unknown>;

const withConf = (edit: (conf: string) => string) => buildArtifact({ conf: edit });

describe("codec", () => {
  it("round-trips a payload through the vpn:// envelope", () => {
    const payload = buildArtifact();
    expect(decodeVpnLink(encodeVpnPayload(payload))).toEqual(payload);
  });

  it("rejects malformed links", () => {
    expect(() => decodeVpnLink("http://x")).toThrow("vpn://");
    expect(() => decodeVpnLink("vpn://AA")).toThrow("too short");
  });
});

describe("inspectAwgArtifact", () => {
  it("reads the endpoint of an AWG 3.1 artifact", () => {
    expect(inspectAwgArtifact(buildArtifact())).toEqual({
      kind: "awg31",
      endpoint: { host: "node.example.test", port: 51820 },
    });
  });

  it("reads an IPv4 endpoint", () => {
    expect(inspectAwgArtifact(buildArtifact({ host: "203.0.113.9", port: 443 }))).toEqual({
      kind: "awg31",
      endpoint: { host: "203.0.113.9", port: 443 },
    });
  });

  it("reads a bracketed IPv6 endpoint and tolerates CRLF", () => {
    const payload = withConf((conf) =>
      conf.replace(/^Endpoint = .*$/m, "Endpoint = [2001:db8::1]:4443").replace(/\n/g, "\r\n"),
    );
    expect(inspectAwgArtifact(payload)).toEqual({
      kind: "awg31",
      endpoint: { host: "2001:db8::1", port: 4443 },
    });
  });

  it("marks a 2.0 artifact (native AWG 2 and the AWG3 fallback share the marker)", () => {
    expect(inspectAwgArtifact(buildArtifact({ protocolVersion: "2" })).kind).toBe("awg20");
  });

  it("marks the legacy layout without a marker as unknown", () => {
    expect(
      inspectAwgArtifact(buildArtifact({ protocolVersion: null, container: "amnezia-awg" })).kind,
    ).toBe("unknown");
  });

  it("marks an unrecognised marker as unknown", () => {
    expect(inspectAwgArtifact(buildArtifact({ protocolVersion: "4" })).kind).toBe("unknown");
  });

  it("marks payloads with no AWG container as unknown", () => {
    expect(inspectAwgArtifact({ containers: [{ container: "amnezia-xray" }] }).kind).toBe("unknown");
    expect(inspectAwgArtifact({}).kind).toBe("unknown");
  });

  it("marks an unreadable embedded config as unknown", () => {
    const payload = buildArtifact();
    (payload.containers?.[0]?.awg as Record<string, unknown>).last_config = "{not json";
    expect(inspectAwgArtifact(payload).kind).toBe("unknown");
    expect(inspectAwgVpnLink("vpn://garbage").kind).toBe("unknown");
    expect(inspectAwgVpnLink("nope").kind).toBe("unknown");
  });

  it("is ambiguous with two AWG containers", () => {
    const payload = buildArtifact();
    payload.containers = [...(payload.containers ?? []), structuredClone(payload.containers?.[0]) as never];
    expect(inspectAwgArtifact(payload).kind).toBe("ambiguous");
  });

  it("is ambiguous with two Endpoint lines in [Peer]", () => {
    const payload = withConf((conf) => conf.replace("PersistentKeepalive", "Endpoint = other.example.test:1\nPersistentKeepalive"));
    expect(inspectAwgArtifact(payload).kind).toBe("ambiguous");
  });

  it("is ambiguous with no [Peer] section or no Endpoint line", () => {
    expect(inspectAwgArtifact(withConf((c) => c.replace("[Peer]", "[Other]"))).kind).toBe("ambiguous");
    expect(inspectAwgArtifact(withConf((c) => c.replace(/^Endpoint = .*\n/m, ""))).kind).toBe("ambiguous");
  });

  it("ignores an Endpoint line outside [Peer] and rejects two Peer sections", () => {
    expect(
      inspectAwgArtifact(withConf((c) => c.replace("PrivateKey", "Endpoint = decoy.example.test:9\nPrivateKey"))).kind,
    ).toBe("awg31");
    expect(inspectAwgArtifact(withConf((c) => `${c}\n[Peer]\nPublicKey = x\n`)).kind).toBe("ambiguous");
  });

  it("is ambiguous when the Endpoint value does not parse", () => {
    expect(
      inspectAwgArtifact(withConf((c) => c.replace(/^Endpoint = .*$/m, "Endpoint = 2001:db8::1:443"))).kind,
    ).toBe("ambiguous");
    expect(
      inspectAwgArtifact(withConf((c) => c.replace(/^Endpoint = .*$/m, "Endpoint = host:99999"))).kind,
    ).toBe("ambiguous");
  });
});

describe("renderAwgEndpoint", () => {
  const bridge = { host: "198.51.100.20", port: 41234 };

  it("rewrites every endpoint location and nothing else", () => {
    const original = buildArtifact();
    const frozen = structuredClone(original);
    const out = renderAwgEndpoint(original, bridge);

    expect(original).toEqual(frozen);
    expect(readEndpointCopies(out)).toEqual({
      top: "198.51.100.20",
      awgPort: "41234",
      lastHost: "198.51.100.20",
      lastPort: 41234,
      endpointLines: ["Endpoint = 198.51.100.20:41234"],
    });
    expect(inspectAwgArtifact(out)).toEqual({ kind: "awg31", endpoint: bridge });

    // Reverting just the five values reproduces the original byte for byte.
    const back = renderAwgEndpoint(out, { host: "node.example.test", port: 51820 });
    expect(JSON.stringify(back)).toBe(JSON.stringify(original));
  });

  it("keeps key order, other sections and profile parameters", () => {
    const original = buildArtifact();
    const out = renderAwgEndpoint(original, bridge);
    expect(Object.keys(out)).toEqual(Object.keys(original));
    expect(Object.keys(out.containers?.[0]?.awg ?? {})).toEqual(
      Object.keys(original.containers?.[0]?.awg ?? {}),
    );
    expect(Object.keys(lastConfigOf(out))).toEqual(Object.keys(lastConfigOf(original)));

    const strip = (text: string) => text.replace(/^Endpoint = .*$/m, "");
    expect(strip(String(lastConfigOf(out).config))).toBe(strip(String(lastConfigOf(original).config)));
    expect(lastConfigOf(out).config).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(lastConfigOf(out).config).toContain("DNS = 1.1.1.1, 1.0.0.1");
    expect(lastConfigOf(out).config).toContain("I1 = <b 0xc70000000108aaaaaaaaaaaaaaaa><r 16>");
    expect(out.containers?.[0]?.awg?.I1).toBe(original.containers?.[0]?.awg?.I1);
    expect(out.dns1).toBe("1.1.1.1");
  });

  it("keeps the stored last_config formatting (indent 2, compact or object)", () => {
    const compact = buildArtifact();
    const awg = compact.containers?.[0]?.awg as Record<string, unknown>;
    awg.last_config = JSON.stringify(JSON.parse(String(awg.last_config)));
    const outCompact = renderAwgEndpoint(compact, bridge).containers?.[0]?.awg?.last_config as string;
    expect(outCompact).not.toContain("\n  ");
    expect(outCompact).toBe(JSON.stringify(JSON.parse(outCompact)));

    const objectForm = buildArtifact();
    const oAwg = objectForm.containers?.[0]?.awg as Record<string, unknown>;
    oAwg.last_config = JSON.parse(String(oAwg.last_config));
    const outObject = renderAwgEndpoint(objectForm, bridge).containers?.[0]?.awg?.last_config as unknown;
    expect(typeof outObject).toBe("object");
    expect((outObject as Record<string, unknown>).port).toBe(41234);

    const indented = renderAwgEndpoint(buildArtifact(), bridge).containers?.[0]?.awg?.last_config as string;
    expect(indented.startsWith("{\n  \"")).toBe(true);
  });

  it("keeps CRLF line endings and the original spacing of the Endpoint line", () => {
    const payload = withConf((c) => c.replace(/^Endpoint = .*$/m, "Endpoint=  node.example.test:51820  ").replace(/\n/g, "\r\n"));
    const conf = String(lastConfigOf(renderAwgEndpoint(payload, bridge)).config);
    expect(conf).toContain("Endpoint=  198.51.100.20:41234  \r\nPersistentKeepalive");
  });

  it("brackets an IPv6 host and accepts a DNS name", () => {
    const v6 = renderAwgEndpoint(buildArtifact(), { host: "2001:db8::5", port: 443 });
    expect(readEndpointCopies(v6).endpointLines).toEqual(["Endpoint = [2001:db8::5]:443"]);
    expect(inspectAwgArtifact(v6)).toEqual({ kind: "awg31", endpoint: { host: "2001:db8::5", port: 443 } });
    expect(readEndpointCopies(v6).lastHost).toBe("2001:db8::5");
    const named = renderAwgEndpoint(buildArtifact(), { host: "bridge.example.test", port: 65535 });
    expect(readEndpointCopies(named).awgPort).toBe("65535");
  });

  it("round-trips through the codec", () => {
    const link = buildLink();
    const out = renderAwgEndpointVpnLink(link, bridge);
    expect(out.startsWith("vpn://")).toBe(true);
    expect(inspectAwgVpnLink(out)).toEqual({ kind: "awg31", endpoint: bridge });
    const back = renderAwgEndpointVpnLink(out, { host: "node.example.test", port: 51820 });
    expect(back).toBe(link);
  });

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return error instanceof AwgEndpointRenderError ? error.code : `other:${String(error)}`;
    }
    return undefined;
  };

  it("throws typed errors for unsupported and ambiguous artifacts", () => {
    expect(codeOf(() => renderAwgEndpoint(buildArtifact({ protocolVersion: "2" }), bridge))).toBe("UNSUPPORTED_PROTOCOL");
    expect(codeOf(() => renderAwgEndpoint(buildArtifact({ protocolVersion: null }), bridge))).toBe("UNSUPPORTED_ARTIFACT");
    expect(codeOf(() => renderAwgEndpoint({}, bridge))).toBe("UNSUPPORTED_ARTIFACT");
    expect(codeOf(() => renderAwgEndpointVpnLink("vpn://garbage", bridge))).toBe("UNSUPPORTED_ARTIFACT");
    expect(codeOf(() => renderAwgEndpoint(withConf((c) => c.replace("[Peer]", "[X]")), bridge))).toBe("AMBIGUOUS_ARTIFACT");
    const two = buildArtifact();
    two.containers = [...(two.containers ?? []), structuredClone(two.containers?.[0]) as never];
    expect(codeOf(() => renderAwgEndpoint(two, bridge))).toBe("AMBIGUOUS_ARTIFACT");
  });

  it("rejects an invalid endpoint, including values that could inject config lines", () => {
    for (const host of ["", "a b", "x\nPrivateKey = y", "bad/host", "host:1"]) {
      expect(codeOf(() => renderAwgEndpoint(buildArtifact(), { host, port: 443 }))).toBe("INVALID_ENDPOINT");
    }
    for (const port of [0, 65536, 1.5, -1, Number.NaN]) {
      expect(codeOf(() => renderAwgEndpoint(buildArtifact(), { host: "h.example.test", port }))).toBe("INVALID_ENDPOINT");
    }
  });

  it("never puts artifact content in an error message", () => {
    const payload = buildArtifact({ protocolVersion: "2" });
    try {
      renderAwgEndpoint(payload, bridge);
      expect.unreachable();
    } catch (error) {
      const text = (error as Error).message;
      expect(text).not.toMatch(/synthetic|example\.test|PrivateKey/);
    }
  });
});
