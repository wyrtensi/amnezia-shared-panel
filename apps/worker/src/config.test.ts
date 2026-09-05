import { WORKER_PERIOD_FIELDS } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";
import { resolveWorkerPeriodDefaults } from "./config.js";

describe("resolveWorkerPeriodDefaults", () => {
  it("uses the documented defaults on an empty environment", () => {
    expect(resolveWorkerPeriodDefaults({})).toEqual({
      telemetryPollSec: 60,
      nodeMetricsSampleSec: 300,
      nodeMetricsRetentionDays: 7,
      peerSampleSec: 300,
      maintenanceIntervalSec: 3_600,
      agentReleaseRefreshSec: 1_800,
      ruleFetchIntervalSec: 21_600,
      accessReconcileSec: 3_600,
    });
  });

  it("agrees with the contract's own fallbacks", () => {
    // The panel shows `fallback` as "the default", and the worker is what
    // actually applies it. The two disagreeing would make the admin form lie
    // about what an unset period does.
    const defaults = resolveWorkerPeriodDefaults({});
    for (const [field, spec] of Object.entries(WORKER_PERIOD_FIELDS)) {
      expect(defaults[field as keyof typeof defaults], field).toBe(
        spec.fallback,
      );
    }
  });

  it("reads every environment override that still has one", () => {
    expect(
      resolveWorkerPeriodDefaults({
        TELEMETRY_POLL_SEC: "30",
        NODE_METRICS_SAMPLE_SEC: "60",
        NODE_METRICS_RETENTION_DAYS: "14",
        ACCESS_RECONCILE_INTERVAL_MS: "900000",
      }),
    ).toMatchObject({
      telemetryPollSec: 30,
      nodeMetricsSampleSec: 60,
      nodeMetricsRetentionDays: 14,
      accessReconcileSec: 900,
    });
  });

  it("keeps ACCESS_RECONCILE_INTERVAL_MS in milliseconds", () => {
    // Reinterpreting it as seconds on upgrade would run the reconcile a
    // thousand times too often on every panel that already sets it.
    expect(
      resolveWorkerPeriodDefaults({ ACCESS_RECONCILE_INTERVAL_MS: "1" }),
    ).toMatchObject({ accessReconcileSec: 1 });
  });

  it("refuses a sample period shorter than the poll period", () => {
    // A sample can only be written by a poll, so a sample period below the poll
    // period cannot produce more rows - it would only make the setting look
    // like it did something.
    expect(() =>
      resolveWorkerPeriodDefaults({
        TELEMETRY_POLL_SEC: "120",
        NODE_METRICS_SAMPLE_SEC: "60",
      }),
    ).toThrow(/NODE_METRICS_SAMPLE_SEC must be at least TELEMETRY_POLL_SEC/);
  });

  it("accepts a sample period equal to the poll period", () => {
    expect(
      resolveWorkerPeriodDefaults({
        TELEMETRY_POLL_SEC: "120",
        NODE_METRICS_SAMPLE_SEC: "120",
      }),
    ).toMatchObject({ telemetryPollSec: 120, nodeMetricsSampleSec: 120 });
  });

  it("compares the overridden sample period against the DEFAULT poll period", () => {
    // The floor has to hold when only one of the two is set, otherwise the
    // check passes exactly when it is least likely to be thought about.
    expect(() =>
      resolveWorkerPeriodDefaults({ NODE_METRICS_SAMPLE_SEC: "30" }),
    ).toThrow(/NODE_METRICS_SAMPLE_SEC must be at least TELEMETRY_POLL_SEC/);
  });

  it.each(["0", "-5", "abc", "1.5"])("refuses %j as a period", (raw) => {
    expect(() => resolveWorkerPeriodDefaults({ TELEMETRY_POLL_SEC: raw })).toThrow(
      /TELEMETRY_POLL_SEC must be a positive integer/,
    );
  });

  it.each(["", "   "])("treats %j as unset", (raw) => {
    // `TELEMETRY_POLL_SEC=` in an .env file is how an operator un-sets a knob.
    // Refusing it would make an empty line in the template a boot failure.
    expect(
      resolveWorkerPeriodDefaults({ TELEMETRY_POLL_SEC: raw }),
    ).toMatchObject({ telemetryPollSec: 60 });
  });

  it("refuses a retention window that would keep samples forever", () => {
    expect(() =>
      resolveWorkerPeriodDefaults({ NODE_METRICS_RETENTION_DAYS: "0" }),
    ).toThrow(/NODE_METRICS_RETENTION_DAYS must be a positive integer/);
  });

  it("does not apply the panel's bounds to an environment value", () => {
    // The panel refuses a poll below 30 s, but an existing host that set
    // TELEMETRY_POLL_SEC=5 years ago must keep booting: tightening the
    // environment would turn an upgrade into an outage, which is a worse
    // failure than the period the operator chose on purpose.
    expect(
      resolveWorkerPeriodDefaults({
        TELEMETRY_POLL_SEC: "5",
        NODE_METRICS_SAMPLE_SEC: "5",
      }),
    ).toMatchObject({ telemetryPollSec: 5, nodeMetricsSampleSec: 5 });
  });
});
