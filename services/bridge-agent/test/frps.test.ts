import { afterEach, describe, expect, it } from "vitest";

import { fetchServerVersion, fetchUdpProxies, FrpsError, registrationMarker, type FrpsClientOptions } from "../src/frps.js";
import { fixture, startFakeFrps } from "./fakeFrps.js";

const ROUTE = "awg-route-0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const options = (baseUrl: string, extra: Partial<FrpsClientOptions> = {}): FrpsClientOptions => ({
  baseUrl,
  user: "fx",
  password: "fxpass",
  timeoutMs: 500,
  maxBytes: 64 * 1024,
  ...extra,
});

const start = async (routes: Parameters<typeof startFakeFrps>[0], extra: Partial<FrpsClientOptions> = {}) => {
  const fake = await startFakeFrps(routes);
  close = fake.close;
  return options(fake.baseUrl, extra);
};

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FrpsError) return error.code;
    throw error;
  }
  return "no error";
};

describe("frps v0.72.0 responses (real captures)", () => {
  it("parses the version", async () => {
    const opts = await start({ "/api/serverinfo": { body: fixture("serverinfo-online.json") } });
    expect(await fetchServerVersion(opts)).toBe("0.72.0");
  });

  it("parses an online UDP proxy: name, port, status, marker", async () => {
    const opts = await start({ "/api/proxy/udp": { body: fixture("proxy-udp-online.json") } });
    const proxies = await fetchUdpProxies(opts);
    expect(proxies).toEqual([
      {
        proxyId: ROUTE,
        remotePort: 41000,
        online: true,
        registrationMarker: registrationMarker("eb3b06a39226af3c", "11-13 18:58:33"),
      },
    ]);
    expect(proxies[0]?.registrationMarker).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reports an offline proxy: no conf means no port, still has a marker", async () => {
    const opts = await start({ "/api/proxy/udp": { body: fixture("proxy-udp-offline.json") } });
    expect(await fetchUdpProxies(opts)).toEqual([
      {
        proxyId: ROUTE,
        remotePort: null,
        online: false,
        registrationMarker: registrationMarker("eb3b06a39226af3c", "11-13 18:58:33"),
      },
    ]);
  });

  it("exposes only the required fields and never the raw clientID or traffic", async () => {
    const opts = await start({ "/api/proxy/udp": { body: fixture("proxy-udp-online.json") } });
    const proxies = await fetchUdpProxies(opts);
    expect(Object.keys(proxies[0] ?? {}).sort()).toEqual(["online", "proxyId", "registrationMarker", "remotePort"]);
    expect(JSON.stringify(proxies)).not.toContain("eb3b06a39226af3c");
    expect(JSON.stringify(proxies)).not.toContain("127.0.0.1");
  });

  it("drops a non-UDP proxy even if listed", async () => {
    const opts = await start({ "/api/proxy/udp": { body: fixture("proxy-tcp-online.json") } });
    expect(await fetchUdpProxies(opts)).toEqual([]);
  });

  it("sends basic auth with the dashboard credentials", async () => {
    const fake = await startFakeFrps({ "/api/serverinfo": { body: fixture("serverinfo-online.json") } });
    close = fake.close;
    await fetchServerVersion(options(fake.baseUrl));
    expect(fake.seenAuth).toEqual([`Basic ${Buffer.from("fx:fxpass").toString("base64")}`]);
  });
});

describe("registration marker", () => {
  it("is stable for the same registration and changes with clientID or lastStartTime", () => {
    const base = registrationMarker("abc", "11-13 18:58:33");
    expect(registrationMarker("abc", "11-13 18:58:33")).toBe(base);
    expect(registrationMarker("abd", "11-13 18:58:33")).not.toBe(base);
    expect(registrationMarker("abc", "11-13 18:58:34")).not.toBe(base);
  });

  it("is a lowercase 32-char hex string, accepted by the panel's bridgeRegistrationMarkerSchema (1-200 chars, no control chars)", () => {
    const marker = registrationMarker("abc", "11-13 18:58:33") ?? "";
    expect(marker).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is null when frps gave no clientID or start time, rather than a weak value", () => {
    expect(registrationMarker(undefined, "11-13 18:58:33")).toBeNull();
    expect(registrationMarker("abc", "")).toBeNull();
  });
});

describe("upstream failures", () => {
  it("401 -> FRPS_AUTH_FAILED", async () => {
    const opts = await start({ "/api/serverinfo": { body: "{}" } });
    expect(await code(fetchServerVersion({ ...opts, password: "wrong" }))).toBe("FRPS_AUTH_FAILED");
  });

  it("other non-2xx -> FRPS_HTTP_ERROR", async () => {
    const opts = await start({ "/api/serverinfo": { status: 500, body: "boom" } });
    expect(await code(fetchServerVersion(opts))).toBe("FRPS_HTTP_ERROR");
  });

  it("no answer -> FRPS_TIMEOUT", async () => {
    const opts = await start({ "/api/serverinfo": { hang: true } }, { timeoutMs: 150 });
    expect(await code(fetchServerVersion(opts))).toBe("FRPS_TIMEOUT");
  });

  it("nothing listening -> FRPS_UNREACHABLE", async () => {
    const fake = await startFakeFrps({});
    const base = fake.baseUrl;
    await fake.close();
    expect(await code(fetchServerVersion(options(base)))).toBe("FRPS_UNREACHABLE");
  });

  it.each([
    ["not JSON", "<html>"],
    ["wrong shape", '{"proxies": "x"}'],
    ["missing required field", JSON.stringify({ proxies: [{ name: "a", conf: null, status: "online" }] })],
    ["unknown status", JSON.stringify({ proxies: [{ name: "a", conf: null, lastStartTime: "", status: "weird" }] })],
    ["remotePort of the wrong type", JSON.stringify({ proxies: [{ name: "a", conf: { remotePort: "41000" }, lastStartTime: "", status: "online" }] })],
  ])("malformed (%s) -> FRPS_MALFORMED_RESPONSE", async (_label, body) => {
    const opts = await start({ "/api/proxy/udp": { body } });
    expect(await code(fetchUdpProxies(opts))).toBe("FRPS_MALFORMED_RESPONSE");
  });

  it("serverinfo without a version -> FRPS_MALFORMED_RESPONSE", async () => {
    const opts = await start({ "/api/serverinfo": { body: '{"bindPort": 7000}' } });
    expect(await code(fetchServerVersion(opts))).toBe("FRPS_MALFORMED_RESPONSE");
  });

  it("an oversized body is rejected as malformed", async () => {
    const big = JSON.stringify({ proxies: [], padding: "x".repeat(2000) });
    const opts = await start({ "/api/proxy/udp": { body: big } }, { maxBytes: 500 });
    expect(await code(fetchUdpProxies(opts))).toBe("FRPS_MALFORMED_RESPONSE");
  });
});
