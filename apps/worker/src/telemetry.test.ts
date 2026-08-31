import { describe, expect, it, vi } from "vitest";
import {
  createTelemetryPoller,
  shouldStoreSample,
  type PeerObservation,
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

describe("node telemetry poll", () => {
  it("records health, capacity, load, and peer telemetry in one snapshot", async () => {
    const repository: TelemetryRepository = {
      listTelemetryNodes: vi.fn(() =>
        Promise.resolve([
          {
            id: "node-1",
            baseUrl: "http://node",
            apiKey: "secret",
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
    };
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => agent,
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
  });

  it("keeps the last snapshot and records a sanitized polling failure", async () => {
    const repository: TelemetryRepository = {
      listTelemetryNodes: vi.fn(() =>
        Promise.resolve([
          { id: "node-1", baseUrl: "http://node", apiKey: "secret", keys: [] },
        ]),
      ),
      recordNodeSnapshot: vi.fn(() => Promise.resolve()),
      recordNodeFailure: vi.fn(() => Promise.resolve()),
    };
    const poll = createTelemetryPoller({
      repository,
      createNodeAgent: () => ({
        getHealth: vi.fn(() => Promise.reject(new Error("line one\nline two"))),
        getServer: vi.fn(),
        getServerLoad: vi.fn(),
        listClients: vi.fn(),
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
});
