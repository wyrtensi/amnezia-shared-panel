import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { startFakeFrps, type Routes } from "./fakeFrps.js";

/**
 * One bridge, one frps, two VPN routes registered at once: the agent reports
 * each route's registration independently, and a restart of the agent itself
 * (the management channel) changes nothing about what frps reports.
 */

const TOKEN = "t".repeat(40);
const BRIDGE_ID = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const ROUTE_A = "awg-route-0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
const ROUTE_B = "awg-route-7c2d1e90-aaaa-4bbb-8ccc-0d1e2f3a4b5c";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

type FrpsProxy = { name: string; port: number; clientId: string; online: boolean };

const frpsBody = (proxies: FrpsProxy[]): string =>
  JSON.stringify({
    proxies: proxies.map((proxy) => ({
      name: proxy.name,
      conf: proxy.online
        ? { name: proxy.name, type: "udp", localIP: "127.0.0.1", plugin: null, remotePort: proxy.port }
        : null,
      clientID: proxy.clientId,
      todayTrafficIn: 0,
      todayTrafficOut: 0,
      curConns: 0,
      lastStartTime: "11-13 18:58:33",
      lastCloseTime: proxy.online ? "" : "11-13 18:58:36",
      status: proxy.online ? "online" : "offline",
    })),
  });

const startAgent = async (frpsUrl: string): Promise<{ base: string; stop: () => Promise<void> }> => {
  const server: Server = createServer({
    apiToken: TOKEN,
    context: {
      bridgeId: BRIDGE_ID,
      agentVersion: "0.1.0",
      applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
      frps: { baseUrl: frpsUrl, user: "fx", password: "fxpass", timeoutMs: 500, maxBytes: 64 * 1024 },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

type StatusBody = {
  frps: { reachable: boolean };
  proxies: Array<{ proxyId: string; remotePort: number | null; online: boolean; registrationMarker: string | null }>;
};

const status = async (base: string): Promise<StatusBody> => {
  const res = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
};
const byName = (body: StatusBody, name: string) => body.proxies.find((proxy) => proxy.proxyId === name);

describe("one frps, two simultaneously registered routes", () => {
  const proxies: FrpsProxy[] = [
    { name: ROUTE_A, port: 41000, clientId: "client-a", online: true },
    { name: ROUTE_B, port: 41001, clientId: "client-b", online: true },
  ];
  const routes: Routes = {
    "/api/serverinfo": { body: '{"version":"0.72.0"}' },
    "/api/proxy/udp": { body: frpsBody(proxies) },
  };
  const sync = (): void => {
    routes["/api/proxy/udp"] = { body: frpsBody(proxies) };
  };

  it("reports both routes, then only the stopped frpc changes, and a restart reports both again", async () => {
    const fake = await startFakeFrps(routes);
    closers.push(fake.close);
    let agent = await startAgent(fake.baseUrl);
    closers.push(() => agent.stop());

    const both = await status(agent.base);
    expect(both.frps.reachable).toBe(true);
    const a = byName(both, ROUTE_A)!;
    const b = byName(both, ROUTE_B)!;
    expect(a).toMatchObject({ remotePort: 41000, online: true });
    expect(b).toMatchObject({ remotePort: 41001, online: true });
    expect(a.registrationMarker).toMatch(/^[0-9a-f]{32}$/);
    expect(b.registrationMarker).toMatch(/^[0-9a-f]{32}$/);
    expect(a.registrationMarker).not.toBe(b.registrationMarker);

    // Stop only route B's frpc: frps keeps the proxy listed as offline.
    proxies[1]!.online = false;
    sync();
    const afterStop = await status(agent.base);
    expect(byName(afterStop, ROUTE_A)).toEqual(a);
    expect(byName(afterStop, ROUTE_B)).toMatchObject({ remotePort: null, online: false });

    // Restart the management agent: frps state is read fresh, A stays as it was.
    await agent.stop();
    agent = await startAgent(fake.baseUrl);
    closers.push(() => agent.stop());
    proxies[1]!.online = true;
    sync();
    const afterRestart = await status(agent.base);
    expect(byName(afterRestart, ROUTE_A)).toEqual(a);
    expect(byName(afterRestart, ROUTE_B)).toMatchObject({ remotePort: 41001, online: true });
  });
});
