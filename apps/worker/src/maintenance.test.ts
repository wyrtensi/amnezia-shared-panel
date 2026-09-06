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
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
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
    // Default 30-day window, same as offboardedUserRetentionDays's default.
    expect(repository.deleteCompletedJobsBefore).toHaveBeenCalledWith(
      new Date("2026-07-21T12:00:00.000Z"),
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
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
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
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    await createMaintenanceRunner({
      repository,
      now: () => now,
      offboardedUserRetentionDays: 10,
      // The gate defaults to off; naming it explicitly is what this test is
      // actually about (the window), not the gate itself -- see the dedicated
      // gate tests below.
      autoPurgeOffboardedUsers: true,
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
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
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
      autoPurgeOffboardedUsers: true,
    })();

    expect(repository.purgeOffboardedUsers).toHaveBeenCalledWith(
      new Date("2026-07-21T12:00:00.000Z"),
    );
  });

  // The toggle that decides whether the automatic sweep may delete an account
  // at all. Off by default -- see the contract's `autoPurgeOffboardedUsers`.
  describe("the automatic-purge gate", () => {
    const buildRepository = (): MaintenanceRepository => ({
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    });

    it("does not call purgeOffboardedUsers when the gate is off (the default)", async () => {
      const repository = buildRepository();
      const now = new Date("2026-08-20T12:00:00.000Z");

      await createMaintenanceRunner({ repository, now: () => now })();

      expect(repository.purgeOffboardedUsers).not.toHaveBeenCalled();
      // The rest of the pass still runs -- this is a gate on one step, not a
      // reason to skip the others.
      expect(repository.deleteNodeMetricsSamplesBefore).toHaveBeenCalled();
      expect(repository.deleteCompletedJobsBefore).toHaveBeenCalled();
      expect(repository.rearmStuckRevokes).toHaveBeenCalled();
    });

    it("calls purgeOffboardedUsers when the gate is explicitly on", async () => {
      const repository = buildRepository();
      const now = new Date("2026-08-20T12:00:00.000Z");

      await createMaintenanceRunner({
        repository,
        now: () => now,
        autoPurgeOffboardedUsers: true,
      })();

      expect(repository.purgeOffboardedUsers).toHaveBeenCalledTimes(1);
    });

    it("treats a throwing gate resolver as off, never as on", async () => {
      const repository = buildRepository();
      const now = new Date("2026-08-20T12:00:00.000Z");

      // Deleting an account is irreversible, so a failed read of the setting
      // must never be mistaken for "on" -- the only safe direction is "do not
      // delete".
      await createMaintenanceRunner({
        repository,
        now: () => now,
        autoPurgeOffboardedUsers: () =>
          Promise.reject(new Error("settings row unreachable")),
      })();

      expect(repository.purgeOffboardedUsers).not.toHaveBeenCalled();
    });
  });

  // job_outbox is never pruned otherwise -- every key create/revoke/rotate,
  // node reconcile, agent update and capacity change leaves a row forever.
  it("passes the resolved completed-job retention window to deleteCompletedJobsBefore", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    await createMaintenanceRunner({
      repository,
      now: () => now,
      completedJobRetentionDays: 5,
    })();

    expect(repository.deleteCompletedJobsBefore).toHaveBeenCalledWith(
      new Date("2026-08-15T12:00:00.000Z"),
    );
  });

  it("falls back to the default window when the completed-job resolver throws", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.resolve({ rearmed: 0 })),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    await createMaintenanceRunner({
      repository,
      now: () => now,
      completedJobRetentionDays: () =>
        Promise.reject(new Error("settings row unreachable")),
    })();

    expect(repository.deleteCompletedJobsBefore).toHaveBeenCalledWith(
      new Date("2026-07-21T12:00:00.000Z"),
    );
  });

  // A revoke that exhausted its retries is left `failed` while the key stays
  // `revoking` (see failJob) -- nothing else ever retries it. This sweep has
  // to run BEFORE purgeOffboardedUsers: a key it re-arms this run cannot be
  // `revoked` in time for THIS run's purge (separate transactions), so purge
  // must still see the OLD, still-blocking state when it runs.
  it("re-arms stuck revokes once per pass, before purgeOffboardedUsers", async () => {
    const calls: string[] = [];
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => {
        calls.push("rearmStuckRevokes");
        return Promise.resolve({ rearmed: 2 });
      }),
      purgeOffboardedUsers: vi.fn(() => {
        calls.push("purgeOffboardedUsers");
        return Promise.resolve({ deleted: [] });
      }),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    await createMaintenanceRunner({
      repository,
      now: () => now,
      autoPurgeOffboardedUsers: true,
    })();

    expect(repository.rearmStuckRevokes).toHaveBeenCalledTimes(1);
    expect(repository.purgeOffboardedUsers).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["rearmStuckRevokes", "purgeOffboardedUsers"]);
  });

  it("does not let a failing re-arm stop the rest of the maintenance run", async () => {
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() =>
        Promise.reject(new Error("database unreachable")),
      ),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");

    // Must not throw, and every other step of the pass still has to run --
    // a stuck revoke sweep is a nice-to-have, not something that should take
    // metrics pruning and the offboarded-user purge down with it.
    await expect(
      createMaintenanceRunner({
        repository,
        now: () => now,
        autoPurgeOffboardedUsers: true,
      })(),
    ).resolves.toBeUndefined();

    expect(repository.deleteNodeMetricsSamplesBefore).toHaveBeenCalled();
    expect(repository.deleteCompletedJobsBefore).toHaveBeenCalled();
    expect(repository.purgeOffboardedUsers).toHaveBeenCalled();
  });

  it("reports a failing re-arm's error instead of letting it vanish silently", async () => {
    const rearmError = new Error("database unreachable");
    const repository: MaintenanceRepository = {
      loadSamplesSince: vi.fn(() => Promise.resolve([])),
      replaceRollups: vi.fn(() => Promise.resolve()),
      deleteSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteRollupsBefore: vi.fn(() => Promise.resolve()),
      deleteNodeMetricsSamplesBefore: vi.fn(() => Promise.resolve()),
      deleteCompletedJobsBefore: vi.fn(() => Promise.resolve()),
      rearmStuckRevokes: vi.fn(() => Promise.reject(rearmError)),
      purgeOffboardedUsers: vi.fn(() => Promise.resolve({ deleted: [] })),
    };
    const now = new Date("2026-08-20T12:00:00.000Z");
    const onError = vi.fn();

    // Before this fix the error was swallowed with nothing logged -- a sweep
    // that fails on every run was invisible to an operator watching
    // `docker logs worker`. It must still not stop the rest of the pass.
    await expect(
      createMaintenanceRunner({
        repository,
        now: () => now,
        onError,
        autoPurgeOffboardedUsers: true,
      })(),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(rearmError);
    expect(repository.purgeOffboardedUsers).toHaveBeenCalled();
  });
});
