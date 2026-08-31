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
});
