import { describe, expect, it, vi } from "vitest";
import {
  createTelemetryPoller,
  shouldStoreSample,
  type PeerObservation,
  type TelemetryNode,
  type TelemetryRepository,
} from "./telemetry.js";

const observedAt = new Date("2026-08-20T08:05:00.000Z");
const observation: PeerObservation = {
  keyId: "key-1",
  online: true,
  endpoint: "203.0.113.1:51889",
  latestHandshakeAt: new Date("2026-08-20T08:04:30.000Z"),
  receivedBytes: 120n,
  sentBytes: 80n,
  observedAt,
};

describe("telemetry sampling", () => {
  it("stores a sample after five minutes even when state is unchanged", () => {
    expect(
      shouldStoreSample(observation, {
        ...observation,
        observedAt: new Date("2026-08-20T08:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it.each([
    ["online status", { online: false }],
    ["endpoint", { endpoint: "203.0.113.2:51889" }],
    ["handshake", { latestHandshakeAt: new Date("2026-08-20T08:03:00.000Z") }],
  ])("stores a sample immediately when %s changes", (_name, change) => {
    expect(
      shouldStoreSample(observation, {
        ...observation,
        ...change,
        observedAt: new Date("2026-08-20T08:04:59.000Z"),
      }),
    ).toBe(true);
  });

  it("does not store an unchanged sample before five minutes", () => {
    expect(
      shouldStoreSample(observation, {
        ...observation,
        observedAt: new Date("2026-08-20T08:00:01.000Z"),
      }),
    ).toBe(false);
  });
});

const serverLoad = {
  timestamp: observedAt.toISOString(),
  uptimeSec: 60,
  loadavg: [0.1, 0.2, 0.3] as [number, number, number],
  cpu: { cores: 2 },
  memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512 },
  disk: null,
  network: null,
  docker: null,
};

const telemetryNode: TelemetryNode = {
  id: "node-1",
  baseUrl: "http://node",
  apiKey: "secret",
  keys: [],
  publicHost: null,
  publicIp: null,
  agentUpdateState: "idle" as const,
};

const stubAgent = (publicHost?: string) => ({
  getHealth: vi.fn(() => Promise.resolve({ ok: true as const })),
  getServer: vi.fn(() =>
    Promise.resolve({
      id: "server-id",
      region: "NL",
      weight: 100,
      maxPeers: 500,
      totalPeers: 0,
      protocols: ["amneziawg3"],
      publicHost,
    }),
  ),
  getServerLoad: vi.fn(() => Promise.resolve(serverLoad)),
  listClients: vi.fn(() => Promise.resolve([])),
  getAgentUpdate: vi.fn(() => Promise.resolve(null)),
});

const stubRepository = (nodes: TelemetryNode[]): TelemetryRepository => ({
  listTelemetryNodes: vi.fn(() => Promise.resolve(nodes)),
  recordNodeSnapshot: vi.fn(() => Promise.resolve()),
  recordNodeFailure: vi.fn(() => Promise.resolve()),
});

const lastSnapshot = (repository: TelemetryRepository) =>
  vi.mocked(repository.recordNodeSnapshot).mock.calls.at(-1)?.[0];

describe("node telemetry poll", () => {
  it("records health, capacity, load, and peer telemetry in one snapshot", async () => {
    const repository: TelemetryRepository = {
      listTelemetryNodes: vi.fn(() =>
        Promise.resolve([
          {
            ...telemetryNode,
            keys: [
              { keyId: "key-1", publicKey: "public-key", nodeLabel: "ap_label" },
            ],
          },
        ]),
      ),
      recordNodeSnapshot: vi.fn(() => Promise.resolve()),
      recordNodeFailure: vi.fn(() => Promise.resolve()),
    };
    const agent = {
      getHealth: vi.fn(() => Promise.resolve({ ok: true as const })),
      getServer: vi.fn(() =>
        Promise.resolve({
          id: "server-id",
          region: "NL",
          weight: 100,
          maxPeers: 500,
          totalPeers: 1,
          protocols: ["amneziawg2"],
          publicHost: "VPN.Example.com",
        }),
      ),
      getServerLoad: vi.fn(() =>
        Promise.resolve({
          timestamp: observedAt.toISOString(),
          uptimeSec: 60,
          loadavg: [0.1, 0.2, 0.3] as [number, number, number],
          cpu: { cores: 2 },
          memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512 },
          disk: null,
          network: null,
          docker: null,
        }),
      ),
      listClients: vi.fn(() =>
        Promise.resolve([
          {
            username: "ap_label",
            peers: [
              {
                id: "public-key",
                name: null,
                allowedIps: ["10.89.0.2/32"],
                lastHandshake: 1_787_213_070,
                traffic: { received: 120, sent: 80 },
                endpoint: "203.0.113.1:51889",
                online: true,
                expiresAt: null,
                status: "active",
                protocol: "amneziawg2",
              },
            ],
          },
        ]),
      ),
      getAgentUpdate: vi.fn(() => Promise.resolve(null)),
    };
    const resolvePublicIp = vi.fn((host: string) =>
      Promise.resolve(host === "vpn.example.com" ? "203.0.113.10" : null),
    );
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => agent,
      resolvePublicIp,
      now: () => observedAt,
    });

    await poll();

    expect(repository.recordNodeSnapshot).toHaveBeenCalledOnce();
    const snapshot = vi.mocked(repository.recordNodeSnapshot).mock.calls[0]?.[0];
    expect(snapshot).toMatchObject({
      nodeId: "node-1",
      observedAt,
      peers: [observation],
    });
    expect(snapshot?.server).toMatchObject({ maxPeers: 500, totalPeers: 1 });
    expect(snapshot?.load.memory).toEqual({
      totalBytes: 1024,
      freeBytes: 512,
      usedBytes: 512,
    });
    expect(repository.recordNodeFailure).not.toHaveBeenCalled();
    expect(resolvePublicIp).toHaveBeenCalledWith("vpn.example.com");
    expect(snapshot).toMatchObject({
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.10",
    });
  });

  it("does not resolve again once the node's address is known", async () => {
    // A node's public address is fixed for the life of the server, so a DNS
    // query per node per minute would buy nothing. Steady state is zero.
    const resolvePublicIp = vi.fn(() => Promise.resolve("203.0.113.10"));
    const repository = stubRepository([
      {
        ...telemetryNode,
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
      },
    ]);
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => stubAgent("vpn.example.com"),
      resolvePublicIp,
      now: () => observedAt,
    });

    await poll();

    expect(resolvePublicIp).not.toHaveBeenCalled();
    // The host is still recorded every tick; only the lookup is skipped, and a
    // null IP tells the repository there is nothing new to write.
    expect(lastSnapshot(repository)).toMatchObject({
      publicHost: "vpn.example.com",
      publicIp: null,
    });
  });

  it("resolves again when the node starts reporting a different host", async () => {
    // The server did not move, but the operator repointed it: that is the one
    // case where the stored address is genuinely out of date.
    const resolvePublicIp = vi.fn(() => Promise.resolve("203.0.113.11"));
    const repository = stubRepository([
      {
        ...telemetryNode,
        publicHost: "old.example.com",
        publicIp: "203.0.113.10",
      },
    ]);
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => stubAgent("vpn.example.com"),
      resolvePublicIp,
      now: () => observedAt,
    });

    await poll();

    expect(resolvePublicIp).toHaveBeenCalledWith("vpn.example.com");
    expect(lastSnapshot(repository)).toMatchObject({
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.11",
    });
  });

  it("retries the lookup while it keeps failing", async () => {
    // Nothing is stored yet, so there is no good value to protect: the next
    // tick simply tries again. That is the only retry this needs.
    const resolvePublicIp = vi.fn(() => Promise.resolve(null));
    const repository = stubRepository([
      { ...telemetryNode, publicHost: "vpn.example.com", publicIp: null },
    ]);
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => stubAgent("vpn.example.com"),
      resolvePublicIp,
      now: () => observedAt,
    });

    await poll();
    await poll();

    expect(resolvePublicIp).toHaveBeenCalledTimes(2);
    expect(lastSnapshot(repository)).toMatchObject({
      publicHost: "vpn.example.com",
      publicIp: null,
    });
  });

  it("stores nulls for an agent that does not report a public host", async () => {
    const repository = stubRepository([telemetryNode]);
    const resolvePublicIp = vi.fn(() => Promise.resolve("203.0.113.10"));
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => stubAgent(),
      resolvePublicIp,
      now: () => observedAt,
    });

    await poll();

    expect(resolvePublicIp).not.toHaveBeenCalled();
    expect(repository.recordNodeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ publicHost: null, publicIp: null }),
    );
  });

  it("keeps the last snapshot and records a sanitized polling failure", async () => {
    const repository = stubRepository([telemetryNode]);
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => ({
        getHealth: vi.fn(() => Promise.reject(new Error("line one\nline two"))),
        getServer: vi.fn(),
        getServerLoad: vi.fn(),
        listClients: vi.fn(),
        getAgentUpdate: vi.fn(),
      }),
      now: () => observedAt,
    });

    await poll();

    expect(repository.recordNodeSnapshot).not.toHaveBeenCalled();
    expect(repository.recordNodeFailure).toHaveBeenCalledWith(
      "node-1",
      observedAt,
      "line one line two",
    );
  });

  it("does not ask an idle node about an update it never requested", async () => {
    const repository = stubRepository([telemetryNode]);
    const agent = stubAgent();
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => agent,
      now: () => observedAt,
    });

    await poll();

    // Steady state is a fleet with nothing to update, and this runs every
    // minute against every node: an unconditional extra request would be a
    // permanent cost for an event that happens a few times a year.
    expect(agent.getAgentUpdate).not.toHaveBeenCalled();
    expect(repository.recordNodeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentUpdate: undefined }),
    );
  });

  it("carries the outcome of an update in flight back to the panel", async () => {
    const repository = stubRepository([
      { ...telemetryNode, agentUpdateState: "requested" },
    ]);
    const status = {
      available: true,
      repository: "ghcr.io/owner/repo/node-agent",
      state: "succeeded" as const,
      image: `ghcr.io/owner/repo/node-agent@sha256:${"a".repeat(64)}`,
      log: "pulled\nrecreated\n",
      updatedAt: "2026-09-03T12:00:00.000Z",
      message: "updated",
    };
    const agent = { ...stubAgent(), getAgentUpdate: vi.fn(() => Promise.resolve(status)) };
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => agent,
      now: () => observedAt,
    });

    await poll();

    expect(repository.recordNodeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentUpdate: status }),
    );
  });

  it("leaves the stored state alone when the node in flight cannot answer", async () => {
    const repository = stubRepository([
      { ...telemetryNode, agentUpdateState: "running" },
    ]);
    const agent = {
      ...stubAgent(),
      getAgentUpdate: vi.fn(() => Promise.reject(new Error("connection reset"))),
    };
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => agent,
      now: () => observedAt,
    });

    await poll();

    // A node is deliberately unreachable in the middle of replacing its own
    // agent. That must not turn the whole poll into a recorded node failure -
    // and it must not be confused with the node answering "I do not serve that
    // route", which is what null means and which ends the wait.
    expect(repository.recordNodeFailure).not.toHaveBeenCalled();
    expect(repository.recordNodeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentUpdate: undefined }),
    );
  });

  it("ends the wait when the node's agent does not serve the route", async () => {
    const repository = stubRepository([
      { ...telemetryNode, agentUpdateState: "running" },
    ]);
    const agent = { ...stubAgent(), getAgentUpdate: vi.fn(() => Promise.resolve(null)) };
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => agent,
      now: () => observedAt,
    });

    await poll();

    expect(repository.recordNodeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentUpdate: null }),
    );
  });
});
