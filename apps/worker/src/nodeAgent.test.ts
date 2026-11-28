import { describe, expect, it, vi } from "vitest";
import { createNodeAgentClient, protocolsFromAgent } from "./nodeAgent.js";

describe("protocolsFromAgent", () => {
  it("maps agent protocol ids to panel kinds and drops unknown ones", () => {
    expect(protocolsFromAgent(["amneziawg2", "amneziawg3", "xray"])).toEqual([
      "awg2",
      "awg3",
    ]);
  });

  it("deduplicates and returns an empty list when nothing matches", () => {
    expect(protocolsFromAgent(["amneziawg3", "amneziawg3"])).toEqual(["awg3"]);
    expect(protocolsFromAgent(["openvpn"])).toEqual([]);
  });
});

describe("node-agent client", () => {
  it("authenticates create requests without putting secrets in the URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client: {
              id: "public-key",
              config: "vpn://config",
              protocol: "amneziawg2",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = createNodeAgentClient({
      baseUrl: "http://127.0.0.1:4001",
      apiKey: "private-api-key",
      fetchImpl,
    });

    await client.createClient("ap_label", "awg2");

    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call?.[0]).toBe("http://127.0.0.1:4001/clients");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.headers).toMatchObject({
      "x-api-key": "private-api-key",
    });
    expect(call?.[0]).not.toContain("private-api-key");
  });

  it("polls health, server status, load, and complete client telemetry", async () => {
    const responses = [
      { ok: true },
      {
        id: "agent-node",
        region: "NL",
        weight: 100,
        maxPeers: 500,
        totalPeers: 1,
        protocols: ["amneziawg2"],
      },
      {
        timestamp: "2026-08-20T08:00:00.000Z",
        uptimeSec: 60,
        loadavg: [0.1, 0.2, 0.3],
        cpu: { cores: 2 },
        memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512 },
        disk: null,
        network: null,
        docker: null,
      },
      {
        total: 1,
        items: [
          {
            username: "ap_label",
            peers: [
              {
                id: "public-key",
                name: null,
                allowedIps: ["10.89.0.2/32"],
                lastHandshake: 1_777_000_000,
                traffic: { received: 120, sent: 80 },
                endpoint: "203.0.113.1:51889",
                online: true,
                expiresAt: null,
                status: "active",
                protocol: "amneziawg2",
              },
            ],
          },
        ],
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = createNodeAgentClient({
      baseUrl: "http://127.0.0.1:4001",
      apiKey: "private-api-key",
      fetchImpl,
    });

    await expect(client.getHealth()).resolves.toEqual({ ok: true });
    await expect(client.getServer()).resolves.toMatchObject({ maxPeers: 500 });
    await expect(client.getServerLoad()).resolves.toMatchObject({
      memory: { freeBytes: 512 },
    });
    await expect(client.listClients()).resolves.toMatchObject([
      {
        peers: [
          {
            online: true,
            endpoint: "203.0.113.1:51889",
            traffic: { received: 120, sent: 80 },
          },
        ],
      },
    ]);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:4001/healthz",
      "http://127.0.0.1:4001/server",
      "http://127.0.0.1:4001/server/load",
      "http://127.0.0.1:4001/clients?skip=0&limit=100",
    ]);
  });

  describe("server load CPU figures", () => {
    const loadClient = (cpu: unknown) =>
      createNodeAgentClient({
        baseUrl: "http://127.0.0.1:4001",
        apiKey: "private-api-key",
        fetchImpl: vi.fn<typeof fetch>(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                timestamp: "2026-10-10T08:00:00.000Z",
                uptimeSec: 60,
                loadavg: [0.42, 0.4, 0.37],
                cpu,
                memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512 },
                disk: null,
                network: null,
                docker: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      });

    it("keeps the utilisation a 1.1.17 agent reports", async () => {
      const cpu = {
        cores: 2,
        usedPercent: 23.4,
        iowaitPercent: 18.9,
        stealPercent: 0.5,
        perCorePercent: [30.1, 16.7],
        windowSec: 60,
      };

      await expect(loadClient(cpu).getServerLoad()).resolves.toMatchObject({ cpu });
    });

    it("accepts the nulls an agent that cannot read /proc/stat reports", async () => {
      const cpu = {
        cores: 1,
        usedPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        perCorePercent: null,
        windowSec: null,
      };

      await expect(loadClient(cpu).getServerLoad()).resolves.toMatchObject({ cpu });
    });

    it("refuses a percentage outside 0..100", async () => {
      await expect(
        loadClient({ cores: 1, usedPercent: 140 }).getServerLoad(),
      ).rejects.toThrow();
    });
  });

  describe("multi-exit egress methods and client hints", () => {
    const sampleReport = {
      daemonVersion: "1.0.0",
      observedMode: "routed" as const,
      egressState: "routed_active" as const,
      bridgeName: "br-awg-egress",
      bridgePresent: true,
      tunnelSubnetConflict: false,
      ipv4Addresses: [],
      exits: [],
      observedAt: "2026-11-25T10:00:00.000Z",
    };

    it("parses server egressReport and sends egress hint on createClient/setClientStatus/runChecks", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const client = createNodeAgentClient({
        baseUrl: "http://127.0.0.1:4001",
        apiKey: "private-api-key",
        fetchImpl: vi.fn<typeof fetch>((url, init) => {
          const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
          calls.push({ url: urlStr, init });
          if (urlStr.endsWith("/server")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  id: "n1",
                  region: "eu",
                  weight: 1,
                  maxPeers: 100,
                  totalPeers: 1,
                  protocols: ["amneziawg3"],
                  egressReport: sampleReport,
                }),
                { status: 200 },
              ),
            );
          }
          if (urlStr.endsWith("/clients")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  client: { id: "pk-1", config: "vpn://abc", protocol: "amneziawg3" },
                }),
                { status: 200 },
              ),
            );
          }
          if (urlStr.endsWith("/checks/run")) {
            return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ ok: true, report: sampleReport }), { status: 200 }));
        }),
      });

      const server = await client.getServer();
      expect(server.egressReport?.observedMode).toBe("routed");

      await client.createClient("lbl", "awg3", { exitIp: "1.1.1.1", dnsPrimary: "9.9.9.9" });
      expect(JSON.parse(calls[1]!.init?.body as string)).toMatchObject({
        clientName: "lbl",
        protocol: "amneziawg3",
        egress: { exitIp: "1.1.1.1", dnsPrimary: "9.9.9.9" },
      });

      await client.setClientStatus("pk-1", "awg3", "active", { exitIp: "1.1.1.1" });
      expect(JSON.parse(calls[2]!.init?.body as string)).toMatchObject({
        clientId: "pk-1",
        status: "active",
        egress: { exitIp: "1.1.1.1" },
      });

      await client.runChecks([], { egressIpv4: "1.1.1.1" });
      await client.runChecks([{ id: "c1", probe: {}, assertions: [] }], { egressIpv4: "1.1.1.1" });
      expect(JSON.parse(calls[3]!.init?.body as string)).toMatchObject({ egressIpv4: "1.1.1.1" });
    });

    it("putServerEgress handles 404 for legacy agents and switchEgressMode surfaces 409 error cleanly", async () => {
      const legacyClient = createNodeAgentClient({
        baseUrl: "http://127.0.0.1:4001",
        apiKey: "private-api-key",
        fetchImpl: vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 404 }))),
      });
      await expect(
        legacyClient.putServerEgress({
          schemaVersion: 1,
          blockSmtp: true,
          isolatePrivate: true,
          exits: [],
          peers: [],
        }),
      ).resolves.toBeNull();

      const conflictClient = createNodeAgentClient({
        baseUrl: "http://127.0.0.1:4001",
        apiKey: "private-api-key",
        fetchImpl: vi.fn<typeof fetch>(() =>
          Promise.resolve(
            new Response(JSON.stringify({ message: "Subnet conflict" }), { status: 409 }),
          ),
        ),
      });
      await expect(conflictClient.switchEgressMode("routed")).resolves.toEqual({
        ok: false,
        error: "Subnet conflict",
      });
    });
  });
});
