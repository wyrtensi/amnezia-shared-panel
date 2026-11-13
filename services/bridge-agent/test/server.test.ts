import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import type { AgentContext } from "../src/status.js";
import { fixture, startFakeFrps, type Routes } from "./fakeFrps.js";

const TOKEN = "t".repeat(40);
const BRIDGE_ID = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const ROUTE = "awg-route-0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

const online: Routes = {
  "/api/serverinfo": { body: fixture("serverinfo-online.json") },
  "/api/proxy/udp": { body: fixture("proxy-udp-online.json") },
};

const boot = async (routes: Routes, timeoutMs = 500): Promise<string> => {
  const fake = await startFakeFrps(routes);
  closers.push(fake.close);
  const context: AgentContext = {
    bridgeId: BRIDGE_ID,
    agentVersion: "0.1.0",
    applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
    frps: { baseUrl: fake.baseUrl, user: "fx", password: "fxpass", timeoutMs, maxBytes: 64 * 1024 },
    now: () => new Date("2026-11-13T12:00:00.000Z"),
  };
  const server: Server = createServer({ apiToken: TOKEN, context });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const get = (base: string, path: string, token: string | null = TOKEN, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: token === null ? {} : { authorization: `Bearer ${token}` } });

describe("auth", () => {
  it.each(["/v1/identity", "/v1/status", "/v1/nothing"])("%s without a token is 401", async (path) => {
    const base = await boot(online);
    const res = await get(base, path, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
  });

  it("a wrong token (same length or different) is 401", async () => {
    const base = await boot(online);
    expect((await get(base, "/v1/status", "x".repeat(40))).status).toBe(401);
    expect((await get(base, "/v1/status", "short")).status).toBe(401);
  });

  it("a non-Bearer scheme is 401", async () => {
    const base = await boot(online);
    const res = await fetch(`${base}/v1/status`, { headers: { authorization: `Basic ${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it("does not call frps for an unauthenticated request", async () => {
    const fake = await startFakeFrps(online);
    closers.push(fake.close);
    const server = createServer({
      apiToken: TOKEN,
      context: {
        bridgeId: BRIDGE_ID,
        agentVersion: "0.1.0",
        applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
        frps: { baseUrl: fake.baseUrl, user: "fx", password: "fxpass", timeoutMs: 500, maxBytes: 1024 },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await get(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "/v1/status", null);
    expect(fake.seenAuth).toEqual([]);
  });
});

describe("GET /healthz", () => {
  it("is unauthenticated and returns only {ok:true}", async () => {
    const base = await boot({});
    const res = await get(base, "/healthz", null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /v1/identity", () => {
  it("returns the bridge identity and capabilities", async () => {
    const base = await boot(online);
    const res = await get(base, "/v1/identity");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bridgeId: BRIDGE_ID,
      agentVersion: "0.1.0",
      apiVersion: 1,
      capabilities: ["status.v1"],
    });
  });
});

describe("GET /v1/status", () => {
  it("combines version, applied ports and the filtered UDP proxies", async () => {
    const base = await boot(online);
    const body = (await (await get(base, "/v1/status")).json()) as { proxies: Array<{ registrationMarker: string }> };
    expect(body).toEqual({
      bridgeId: BRIDGE_ID,
      agentVersion: "0.1.0",
      apiVersion: 1,
      observedAt: "2026-11-13T12:00:00.000Z",
      frps: { reachable: true, version: "0.72.0" },
      applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
      proxies: [{ proxyId: ROUTE, remotePort: 41000, online: true, registrationMarker: body.proxies[0]?.registrationMarker }],
      errors: [],
    });
    expect(body.proxies[0]?.registrationMarker).toMatch(/^[0-9a-f]{32}$/);
  });

  it("frps timeout: still 200, reachable=false, bounded error", async () => {
    const base = await boot({ "/api/serverinfo": { hang: true }, "/api/proxy/udp": { hang: true } }, 150);
    const res = await get(base, "/v1/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frps: unknown; proxies: unknown[]; errors: Array<{ code: string }> };
    expect(body.frps).toEqual({ reachable: false, version: null });
    expect(body.proxies).toEqual([]);
    expect(body.errors.map((e) => e.code)).toEqual(["FRPS_TIMEOUT", "FRPS_TIMEOUT"]);
  });

  it("malformed upstream: FRPS_MALFORMED_RESPONSE, no upstream text echoed", async () => {
    const base = await boot({
      "/api/serverinfo": { body: fixture("serverinfo-online.json") },
      "/api/proxy/udp": { body: "SECRET-LOOKING-GARBAGE" },
    });
    const body = (await (await get(base, "/v1/status")).json()) as {
      frps: { reachable: boolean; version: string | null };
      errors: Array<{ code: string; message: string }>;
    };
    expect(body.frps).toEqual({ reachable: false, version: "0.72.0" });
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.code).toBe("FRPS_MALFORMED_RESPONSE");
    expect(JSON.stringify(body)).not.toContain("SECRET-LOOKING-GARBAGE");
  });

  it("wrong dashboard credentials: FRPS_AUTH_FAILED without leaking them", async () => {
    // The fake accepts fx:fxpass; the agent is configured with a wrong password.
    const fake = await startFakeFrps(online);
    closers.push(fake.close);
    const server = createServer({
      apiToken: TOKEN,
      context: {
        bridgeId: BRIDGE_ID,
        agentVersion: "0.1.0",
        applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
        frps: { baseUrl: fake.baseUrl, user: "fx", password: "bad-password-123", timeoutMs: 500, maxBytes: 1024 },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const text = await (await get(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "/v1/status")).text();
    expect(JSON.parse(text).errors[0].code).toBe("FRPS_AUTH_FAILED");
    expect(text).not.toContain("bad-password-123");
  });

  it("marker changes when the proxy re-registers (new lastStartTime)", async () => {
    const original = JSON.parse(fixture("proxy-udp-online.json")) as { proxies: Array<{ lastStartTime: string }> };
    const first = await boot({ ...online });
    const markerA = ((await (await get(first, "/v1/status")).json()) as { proxies: Array<{ registrationMarker: string }> }).proxies[0]?.registrationMarker;
    original.proxies[0]!.lastStartTime = "11-13 19:30:01";
    const second = await boot({ ...online, "/api/proxy/udp": { body: JSON.stringify(original) } });
    const markerB = ((await (await get(second, "/v1/status")).json()) as { proxies: Array<{ registrationMarker: string }> }).proxies[0]?.registrationMarker;
    expect(markerA).toBeDefined();
    expect(markerB).not.toBe(markerA);
  });
});

describe("routing", () => {
  it("405 for a non-GET on a known path, 404 for an unknown path", async () => {
    const base = await boot(online);
    expect((await get(base, "/v1/status", TOKEN, { method: "POST" })).status).toBe(405);
    expect((await get(base, "/v1/other")).status).toBe(404);
  });
});
