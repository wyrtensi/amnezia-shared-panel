import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  readBridgeAgentIdentity,
  readBridgeAgentStatus,
  requestBridgeAgent,
} from "@amnezia/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The shared bridge-agent HTTP client (in @amnezia/contracts, which has no
// Node types), exercised here against a real local HTTP server.

const BRIDGE_ID = "6f1d2c1e-7d0f-4a8e-9f0a-3c3d5e8b1a01";
const MARKER = "0123456789abcdef0123456789abcdef";

const status = () => ({
  bridgeId: BRIDGE_ID,
  agentVersion: "0.1.0",
  apiVersion: 1,
  observedAt: "2026-11-13T10:00:00.000Z",
  frps: { reachable: true, version: "0.72.0" },
  applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
  proxies: [
    { proxyId: "awg-route-a", remotePort: 41000, online: true, registrationMarker: MARKER },
  ],
  errors: [],
});

describe("requestBridgeAgent against a local HTTP server", () => {
  const TOKEN = "t".repeat(40);
  let server: Server;
  let baseUrl: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;
  const seenAuth: Array<string | undefined> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const json = (code: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  it("sends the bearer token and reads a status", async () => {
    handler = (req, res) => {
      expect(req.url).toBe("/v1/status");
      json(200, status())(req, res);
    };
    const outcome = await readBridgeAgentStatus(BRIDGE_ID, { baseUrl: `${baseUrl}/`, apiKey: TOKEN });
    expect(outcome.kind).toBe("ok");
    expect(seenAuth.at(-1)).toBe(`Bearer ${TOKEN}`);
  });

  it("reads an identity", async () => {
    handler = json(200, {
      bridgeId: BRIDGE_ID,
      agentVersion: "0.1.0",
      apiVersion: 1,
      capabilities: ["status.v1"],
    });
    expect(await readBridgeAgentIdentity(BRIDGE_ID, { baseUrl, apiKey: TOKEN })).toMatchObject({
      kind: "ok",
      identity: { agentVersion: "0.1.0" },
    });
  });

  it("maps a 401 without reading the body as data", async () => {
    handler = json(401, { error: { code: "UNAUTHORIZED" } });
    expect(await requestBridgeAgent("/v1/status", { baseUrl, apiKey: TOKEN })).toEqual({
      kind: "response",
      status: 401,
      body: null,
    });
  });

  it("times out a stalled agent", async () => {
    handler = () => undefined;
    expect(
      await requestBridgeAgent("/v1/status", { baseUrl, apiKey: TOKEN, timeoutMs: 150 }),
    ).toEqual({ kind: "failed", code: "AGENT_TIMEOUT" });
  });

  it("refuses an oversized body and a non-JSON body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(2_048));
    };
    expect(
      await requestBridgeAgent("/v1/status", { baseUrl, apiKey: TOKEN, maxBytes: 1_024 }),
    ).toEqual({ kind: "failed", code: "AGENT_MALFORMED_RESPONSE" });
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    };
    expect(await requestBridgeAgent("/v1/status", { baseUrl, apiKey: TOKEN })).toEqual({
      kind: "failed",
      code: "AGENT_MALFORMED_RESPONSE",
    });
  });

  it("never follows a redirect with the token", async () => {
    let redirected = false;
    handler = (req, res) => {
      if (req.url === "/elsewhere") {
        redirected = true;
        json(200, status())(req, res);
        return;
      }
      res.writeHead(302, { location: `${baseUrl}/elsewhere` });
      res.end();
    };
    expect(await requestBridgeAgent("/v1/status", { baseUrl, apiKey: TOKEN })).toEqual({
      kind: "failed",
      code: "AGENT_UNREACHABLE",
    });
    expect(redirected).toBe(false);
  });

  it("reports an unreachable agent", async () => {
    expect(
      await requestBridgeAgent("/v1/status", { baseUrl: "http://127.0.0.1:1", apiKey: TOKEN }),
    ).toEqual({ kind: "failed", code: "AGENT_UNREACHABLE" });
  });
});
