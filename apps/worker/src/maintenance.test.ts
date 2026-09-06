import { describe, expect, it, vi } from "vitest";
import {
  aggregateTrafficSamples,
  createMaintenanceRunner,
  type MaintenanceRepository,
} from "./maintenance.js";

describe("traffic rollups", () => {
  it("counts post-reset counters as fresh traffic without negative deltas", () => {
    const result = aggregateTrafficSamples(
      [
        { keyId: "key-1", sampledAt: new Date("2026-08-20T08:00:00Z"), receivedBytes: 100n, sentBytes: 200n },
        { keyId: "key-1", sampledAt: new Date("2026-08-20T08:05:00Z"), receivedBytes: 150n, sentBytes: 250n },
        { keyId: "key-1", sampledAt: new Date("2026-08-20T08:10:00Z"), receivedBytes: 10n, sentBytes: 5n },
      ],
      "hour",
    );

    expect(result).toEqual([
      {
        keyId: "key-1",
        period: "hour",
        bucketStart: new Date("2026-08-20T08:00:00.000Z"),
        receivedBytes: 60n,
        sentBytes: 55n,
      },
    ]);
  });

  it("assigns deltas to UTC day buckets", () => {
    const result = aggregateTrafficSamples(
      [
        { keyId: "key-1", sampledAt: new Date("2026-08-20T23:55:00Z"), receivedBytes: 100n, sentBytes: 100n },
        { keyId: "key-1", sampledAt: new Date("2026-08-21T00:05:00Z"), receivedBytes: 125n, sentBytes: 140n },
      ],
      "day",
    );

    expect(result[0]).toMatchObject({
      bucketStart: new Date("2026-08-21T00:00:00.000Z"),
      receivedBytes: 25n,
      sentBytes: 40n,
    });
  });
});

describe("retention and rollup maintenance", () => {
  it("rebuilds recent rollups before deleting expired raw and aggregate data", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");
    const run = createMaintenanceRunner({ repository, now: () => now });

    await run();

    expect(repository.loadSamplesSince).toHaveBeenCalledWith(
      new Date("2026-08-13T12:00:00.000Z"),
    );
    expect(repository.replaceRollups).toHaveBeenNthCalledWith(1, "hour", []);
    expect(repository.replaceRollups).toHaveBeenNthCalledWith(2, "day", []);
    expect(repository.deleteSamplesBefore).toHaveBeenCalledWith(
      new Date("2026-08-13T12:00:00.000Z"),
    );
    expect(repository.deleteRollupsBefore).toHaveBeenCalledWith(
      "hour",
      new Date("2026-05-22T12:00:00.000Z"),
    );
    expect(repository.deleteRollupsBefore).toHaveBeenCalledWith(
      "day",
      new Date("2024-08-20T12:00:00.000Z"),
    );
    expect(repository.deleteNodeMetricsSamplesBefore).toHaveBeenCalledWith(
      new Date("2026-08-13T12:00:00.000Z"),
    );
  });

  // node_metrics_samples grows one row per node per sample period forever, and
  // nothing else prunes it. Until this ran, the only thing keeping the table
  // small was how recently the feature had been deployed.
  it("prunes host-metric history at the configured retention window", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    await createMaintenanceRunner({
      repository,
      now: () => now,
      nodeMetricsRetentionDays: 14,
    })();

    expect(repository.deleteNodeMetricsSamplesBefore).toHaveBeenCalledWith(
      new Date("2026-08-06T12:00:00.000Z"),
    );
    // The traffic-sample window is a separate setting and must not follow it.
    expect(repository.deleteSamplesBefore).toHaveBeenCalledWith(
      new Date("2026-08-13T12:00:00.000Z"),
    );
  });

  // A disabled account has to survive long enough to be reinstated, so the
  // runner resolves a retention window and hands purgeOffboardedUsers the
  // cutoff derived from it -- the same shape as the metrics-retention window
  // above (a plain number or a resolver, resolved once per run).
  it("passes the resolved offboarded-user retention window to purgeOffboardedUsers", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    await createMaintenanceRunner({
      repository,
      now: () => now,
      offboardedUserRetentionDays: 10,
    })();

    expect(repository.purgeOffboardedUsers).toHaveBeenCalledWith(
      new Date("2026-08-10T12:00:00.000Z"),
    );
  });

  it("falls back to the default window when the offboarded-user resolver throws", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    // A resolver that throws (settings row unreachable) must not stop the
    // maintenance pass, and must not degrade to a window of 0 (purges every
    // disabled account, reinstatable or not) or Infinity (never purges any) --
    // it falls back to the contract's default, 30 days.
    await createMaintenanceRunner({
      repository,
      now: () => now,
      offboardedUserRetentionDays: () =>
        Promise.reject(new Error("settings row unreachable")),
    })();

    expect(repository.purgeOffboardedUsers).toHaveBeenCalledWith(
      new Date("2026-07-21T12:00:00.000Z"),
    );
  });
});
