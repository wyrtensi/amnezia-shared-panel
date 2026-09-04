import { describe, expect, it } from "vitest";

import { shouldStoreMetricsSample, toNodeMetricsRow } from "./nodeMetrics.js";
import type { NodeSnapshot } from "./telemetry.js";

const observedAt = new Date("2026-09-02T10:00:00.000Z");

const server = {
  id: "server-id",
  region: "NL",
  weight: 100,
  maxPeers: 500,
  totalPeers: 2,
  protocols: ["amneziawg3"],
  publicHost: "203.0.113.10",
  listenPorts: [51890],
};

const fullLoad = {
  timestamp: observedAt.toISOString(),
  uptimeSec: 86_400,
  loadavg: [0.1, 0.2, 0.3] as [number, number, number],
  cpu: { cores: 1 },
  memory: {
    totalBytes: 1_007_681_536,
    freeBytes: 98_304_000,
    usedBytes: 909_377_536,
    availableBytes: 361_267_200,
  },
  swap: { totalBytes: 2_147_483_648, usedBytes: 325_058_560 },
  agent: { pidsCurrent: 12, pidsMax: 128 },
  awg: {
    amneziawg2: null,
    amneziawg3: { up: true, peers: 2 },
  },
  disk: {
    totalBytes: 10_522_067_968,
    usedBytes: 9_244_115_968,
    availableBytes: 1_277_952_000,
    usedPercent: 86,
  },
  network: { rxBytes: 1, txBytes: 2 },
  docker: null,
};

/** What an agent built before T8 answers: none of the new keys at all. */
const oldAgentLoad = {
  timestamp: observedAt.toISOString(),
  uptimeSec: 3_600,
  loadavg: [0, 0, 0] as [number, number, number],
  cpu: { cores: 2 },
  memory: { totalBytes: 1_000, freeBytes: 400, usedBytes: 600 },
  disk: null,
  network: null,
  docker: null,
};

const snapshotOf = (load: unknown): NodeSnapshot =>
  ({
    nodeId: "node-1",
    observedAt,
    agentLatencyMs: 12,
    server,
    load,
    peers: [],
    publicHost: "203.0.113.10",
    publicIp: null,
  }) as unknown as NodeSnapshot;

describe("toNodeMetricsRow", () => {
  it("maps a fully reported node, byte counters as bigint", () => {
    const row = toNodeMetricsRow(snapshotOf(fullLoad));

    expect(row).toMatchObject({
      nodeId: "node-1",
      observedAt,
      agentLatencyMs: 12,
      uptimeSec: 86_400,
      cpuCores: 1,
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      memTotalBytes: 1_007_681_536n,
      memAvailableBytes: 361_267_200n,
      swapTotalBytes: 2_147_483_648n,
      swapUsedBytes: 325_058_560n,
      diskAvailableBytes: 1_277_952_000n,
      diskUsedPercent: 86,
      agentPidsCurrent: 12,
      agentPidsMax: 128,
      awg3Up: true,
      awg3Peers: 2,
      publicHost: "203.0.113.10",
      listenPorts: [51890],
    });
  });

  it("keeps a protocol the node does not serve as null, not as a down interface", () => {
    // "This node has no awg2" and "this node's awg2 is down" are different
    // facts and the card says different things about them.
    const row = toNodeMetricsRow(snapshotOf(fullLoad));

    expect(row.awg2Up).toBeNull();
    expect(row.awg2Peers).toBeNull();
  });

  it("maps an agent that predates the new fields to nulls, never to zeros", () => {
    // A zero here reads as a measurement - "this host has no swap", "the disk
    // is empty" - and would be indistinguishable from one on the node card.
    const row = toNodeMetricsRow(snapshotOf(oldAgentLoad));

    expect(row.memAvailableBytes).toBeNull();
    expect(row.swapTotalBytes).toBeNull();
    expect(row.swapUsedBytes).toBeNull();
    expect(row.agentPidsCurrent).toBeNull();
    expect(row.agentPidsMax).toBeNull();
    expect(row.awg3Up).toBeNull();
    expect(row.diskTotalBytes).toBeNull();
    // What it does report still maps.
    expect(row.memTotalBytes).toBe(1_000n);
    expect(row.cpuCores).toBe(2);
  });
});

describe("shouldStoreMetricsSample", () => {
  const at = (iso: string) => new Date(iso);

  it("always stores the first sample", () => {
    expect(
      shouldStoreMetricsSample(at("2026-09-02T10:00:00.000Z"), null, 300_000),
    ).toBe(true);
  });

  it("stores at exactly the period and not before it", () => {
    const previous = at("2026-09-02T10:00:00.000Z");

    expect(
      shouldStoreMetricsSample(at("2026-09-02T10:05:00.000Z"), previous, 300_000),
    ).toBe(true);
    expect(
      shouldStoreMetricsSample(at("2026-09-02T10:04:59.000Z"), previous, 300_000),
    ).toBe(false);
  });

  it("actually uses the period it is given", () => {
    // The same 4:59 gap that is too soon at five minutes is due at one minute.
    // If this passes with the previous case, the interval is a parameter and
    // not a constant hiding behind one.
    const previous = at("2026-09-02T10:00:00.000Z");

    expect(
      shouldStoreMetricsSample(at("2026-09-02T10:04:59.000Z"), previous, 60_000),
    ).toBe(true);
  });
});
