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
  });
});
