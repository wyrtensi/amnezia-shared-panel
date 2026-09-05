import { describe, expect, it, vi } from "vitest";
import type { WorkerPeriodOverrides } from "@amnezia/contracts";
import { resolveWorkerPeriodDefaults } from "./config.js";
import { createWorkerPeriods, resolveWorkerPeriod } from "./periods.js";

const defaults = resolveWorkerPeriodDefaults({});

describe("resolveWorkerPeriod", () => {
  it("falls back to the worker's default when nothing is stored", () => {
    expect(resolveWorkerPeriod("telemetryPollSec", {}, defaults)).toBe(60);
    expect(resolveWorkerPeriod("maintenanceIntervalSec", {}, defaults)).toBe(
      3_600,
    );
  });

  it("treats an explicit null exactly like an unset column", () => {
    // Null is how an admin gives a period back to the worker. It must not read
    // as zero anywhere along the way.
    expect(
      resolveWorkerPeriod("telemetryPollSec", { telemetryPollSec: null }, defaults),
    ).toBe(60);
  });

  it("uses the stored value over the default", () => {
    expect(
      resolveWorkerPeriod("telemetryPollSec", { telemetryPollSec: 120 }, defaults),
    ).toBe(120);
  });

  it("keeps the environment default when the panel has set nothing", () => {
    // The upgrade guarantee: a host that has always run TELEMETRY_POLL_SEC=15
    // keeps polling every 15 s until somebody sets a period in the panel.
    const envDefaults = resolveWorkerPeriodDefaults({
      TELEMETRY_POLL_SEC: "15",
      NODE_METRICS_SAMPLE_SEC: "15",
    });
    expect(resolveWorkerPeriod("telemetryPollSec", {}, envDefaults)).toBe(15);
  });

  it.each([
    ["telemetryPollSec", 1, 30],
    ["telemetryPollSec", 999_999, 86_400],
    ["peerSampleSec", 1, 60],
    ["maintenanceIntervalSec", 5, 3_600],
    ["ruleFetchIntervalSec", 60, 900],
    ["agentReleaseRefreshSec", 1, 300],
    ["accessReconcileSec", 1, 300],
    ["nodeMetricsRetentionDays", 0, 1],
    ["nodeMetricsRetentionDays", 99_999, 3_650],
  ] as const)(
    "clamps a stored %s of %i to %i",
    (field, stored, expected) => {
      // A value that never came through the API - a hand-edited row, a dump
      // restored from a panel with different bounds - must not be able to make
      // the worker hammer the fleet.
      expect(
        resolveWorkerPeriod(field, { [field]: stored }, defaults),
      ).toBe(expected);
    },
  );

  it("raises a sample period below the poll period to the poll period", () => {
    // The control API refuses this pair on write, but it cannot see the
    // worker's environment: a poll period that arrived through
    // TELEMETRY_POLL_SEC after the sample period was saved lands here.
    const envDefaults = resolveWorkerPeriodDefaults({
      TELEMETRY_POLL_SEC: "600",
      NODE_METRICS_SAMPLE_SEC: "600",
    });
    expect(
      resolveWorkerPeriod(
        "nodeMetricsSampleSec",
        { nodeMetricsSampleSec: 60 },
        envDefaults,
      ),
    ).toBe(600);
  });

  it("leaves a sample period at or above the poll period alone", () => {
    expect(
      resolveWorkerPeriod(
        "nodeMetricsSampleSec",
        { telemetryPollSec: 60, nodeMetricsSampleSec: 60 },
        defaults,
      ),
    ).toBe(60);
  });

  it("raises the PEER sample period to the poll period as well", () => {
    // `peer_samples` rows are written by a poll too, so a peer sample period
    // below the poll period would have the panel showing 60 s while an idle
    // peer was actually recorded once an hour. The API refuses this pair on
    // write; this is the read path, which also covers an environment poll
    // period the API cannot see.
    expect(
      resolveWorkerPeriod(
        "peerSampleSec",
        { telemetryPollSec: 3_600, peerSampleSec: 60 },
        defaults,
      ),
    ).toBe(3_600);
    expect(
      resolveWorkerPeriod(
        "peerSampleSec",
        { telemetryPollSec: 60, peerSampleSec: 300 },
        defaults,
      ),
    ).toBe(300);
  });
});

describe("createWorkerPeriods", () => {
  it("picks up an edit without a restart", async () => {
    // The behaviour the whole change exists for: the same reader, asked twice,
    // reports the new period once the row has changed.
    let stored: WorkerPeriodOverrides = {};
    let clock = 0;
    const periods = createWorkerPeriods({
      read: () => Promise.resolve(stored),
      defaults,
      now: () => clock,
      cacheTtlMs: 10_000,
    });

    expect(await periods.intervalMs("telemetryPollSec")).toBe(60_000);
    stored = { telemetryPollSec: 300 };
    clock += 10_000;
    expect(await periods.intervalMs("telemetryPollSec")).toBe(300_000);
  });

  it("reads the row once per cache window, however many loops ask", async () => {
    const read = vi.fn(() => Promise.resolve({ telemetryPollSec: 120 }));
    let clock = 0;
    const periods = createWorkerPeriods({
      read,
      defaults,
      now: () => clock,
      cacheTtlMs: 10_000,
    });

    await Promise.all([
      periods.get("telemetryPollSec"),
      periods.get("maintenanceIntervalSec"),
      periods.get("ruleFetchIntervalSec"),
    ]);
    expect(read).toHaveBeenCalledOnce();

    clock += 10_000;
    await periods.get("telemetryPollSec");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good row when the read fails", async () => {
    // A background loop must not stop because the database hiccuped: the panel
    // would go quiet exactly when its telemetry matters most.
    let fail = false;
    let clock = 0;
    const onError = vi.fn();
    const periods = createWorkerPeriods({
      read: () =>
        fail
          ? Promise.reject(new Error("connection terminated"))
          : Promise.resolve({ telemetryPollSec: 120 }),
      defaults,
      onError,
      now: () => clock,
      cacheTtlMs: 10_000,
    });

    expect(await periods.get("telemetryPollSec")).toBe(120);
    fail = true;
    clock += 10_000;
    expect(await periods.get("telemetryPollSec")).toBe(120);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("falls back to the defaults when the very first read fails", async () => {
    const periods = createWorkerPeriods({
      read: () => Promise.reject(new Error("no database yet")),
      defaults,
      onError: () => undefined,
    });
    expect(await periods.get("telemetryPollSec")).toBe(60);
  });

  it("reports the retention window in days, not milliseconds", async () => {
    const periods = createWorkerPeriods({
      read: () => Promise.resolve({ nodeMetricsRetentionDays: 30 }),
      defaults,
    });
    expect(await periods.get("nodeMetricsRetentionDays")).toBe(30);
    expect(await periods.intervalMs("nodeMetricsRetentionDays")).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
  });
});
