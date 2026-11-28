import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { identity, status, type AgentContext } from "../src/status.js";
import { readWytunnelInstances } from "../src/wytunnel.js";

const ROUTE_A = "11111111-2222-4333-8444-555555555555";
const ROUTE_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const cleanupDirs: string[] = [];
const cleanupServers: Server[] = [];

afterEach(async () => {
  while (cleanupServers.length) {
    const srv = cleanupServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (cleanupDirs.length) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

const startMockSocket = async (socketPath: string, body: Record<string, unknown>): Promise<void> => {
  const srv = createHttpServer((_req, res) => {
    const payload = JSON.stringify(body);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise<void>((resolve) => srv.listen(socketPath, resolve));
  cleanupServers.push(srv);
};

describe("readWytunnelInstances", () => {
  it("returns undefined when run directory does not exist", async () => {
    expect(await readWytunnelInstances("/nonexistent/wytunnel/dir")).toBeUndefined();
  });

  it("discovers pool, degraded, and empty-JSON sockets fail-closed with stable markers", async () => {
    // Keep Unix socket paths under macOS's 104-byte sockaddr_un limit.
    const dir = mkdtempSync(join("/tmp", "wt-"));
    cleanupDirs.push(dir);
    const routeC = "cccccccc-dddd-4eee-8fff-000000000000";

    writeFileSync(
      join(dir, `client-${ROUTE_A}.meta.json`),
      JSON.stringify({ remotePort: 41004, startedAt: "2026-11-28T05:00:00Z" }),
    );
    await startMockSocket(join(dir, `client-${ROUTE_A}.sock`), {
      version: "0.1.0",
      mode: "pool",
      ebpfMode: "userspace_fallback",
      uptimeSec: 3600,
      activeSessions: 14,
      healthyStreams: 10,
      targetStreams: 10,
      drainingStreams: 0,
      poolRttMs: 50.25,
      rxPackets: 12000,
      txPackets: 11800,
      fecRecovered: 0,
      fecLostGroups: 0,
      keepaliveResets: 0,
      failoversTotal: 1,
      rotationsTotal: 4,
    });

    writeFileSync(
      join(dir, `client-${ROUTE_B}.meta.json`),
      JSON.stringify({ remotePort: 41005, startedAt: "2026-11-28T05:01:00Z" }),
    );
    await startMockSocket(join(dir, `client-${ROUTE_B}.sock`), {
      version: "0.1.0",
      mode: "pool",
      healthyStreams: 0,
      targetStreams: 10,
      poolRttMs: null,
    });

    writeFileSync(
      join(dir, `client-${routeC}.meta.json`),
      JSON.stringify({ remotePort: 41006, startedAt: "2026-11-28T05:02:00Z" }),
    );
    await startMockSocket(join(dir, `client-${routeC}.sock`), {});

    const instances = await readWytunnelInstances(dir, 500);
    if (!instances) throw new Error("expected instances array");
    expect(instances).toHaveLength(3);

    const a = instances.find((i) => i.routeId === ROUTE_A)!;
    expect(a.online).toBe(true);
    expect(a.remotePort).toBe(41004);
    expect(a.registrationMarker).toMatch(/^[0-9a-f]{32}$/);
    expect(a.telemetry).toMatchObject({
      mode: "pool",
      healthyStreams: 10,
      targetStreams: 10,
      poolRttMs: 50.25,
      rotationsTotal: 4,
      failoversTotal: 1,
    });

    const b = instances.find((i) => i.routeId === ROUTE_B)!;
    expect(b.online).toBe(false);
    expect(b.registrationMarker).toBeNull();
    expect(b.telemetry?.healthyStreams).toBe(0);

    const c = instances.find((i) => i.routeId === routeC)!;
    expect(c.online).toBe(false);
    expect(c.registrationMarker).toBeNull();
  });
});

describe("optional frps disabled mode", () => {
  it("reports frps.enabled=false with zero errors and exposes wytunnel capability", async () => {
    const ctx: AgentContext = {
      bridgeId: "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22",
      agentVersion: "0.2.0",
      applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
      frps: null,
      now: () => new Date("2026-11-28T06:00:00.000Z"),
      sampleWytunnel: async () => [
        {
          routeId: ROUTE_A,
          remotePort: 41004,
          online: true,
          registrationMarker: "a".repeat(32),
          telemetry: { mode: "pool", healthyStreams: 10, targetStreams: 10, poolRttMs: 49.5 },
        },
      ],
    };

    expect(identity(ctx).capabilities).toContain("wytunnel.v1");
    const res = await status(ctx);
    expect(res.frps).toEqual({ enabled: false, reachable: false, version: null });
    expect(res.errors).toEqual([]);
    expect(res.proxies).toEqual([]);
    expect(res.wytunnel).toHaveLength(1);
    expect(res.wytunnel?.[0]?.online).toBe(true);
  });
});
