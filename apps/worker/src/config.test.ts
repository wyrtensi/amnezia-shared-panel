import { describe, expect, it } from "vitest";
import { resolveWorkerPeriods } from "./config.js";

describe("resolveWorkerPeriods", () => {
  it("uses the documented defaults on an empty environment", () => {
    expect(resolveWorkerPeriods({})).toEqual({
      telemetryPollMs: 60_000,
      metricsSampleMs: 300_000,
      metricsRetentionDays: 7,
    });
  });

  it("reads all three overrides", () => {
    expect(
      resolveWorkerPeriods({
        TELEMETRY_POLL_SEC: "30",
        NODE_METRICS_SAMPLE_SEC: "60",
        NODE_METRICS_RETENTION_DAYS: "14",
      }),
    ).toEqual({
      telemetryPollMs: 30_000,
      metricsSampleMs: 60_000,
      metricsRetentionDays: 14,
    });
  });

  it("refuses a sample period shorter than the poll period", () => {
    // A sample can only be written by a poll, so a sample period below the poll
    // period cannot produce more rows - it would only make the setting look
    // like it did something.
    expect(() =>
      resolveWorkerPeriods({
        TELEMETRY_POLL_SEC: "120",
        NODE_METRICS_SAMPLE_SEC: "60",
      }),
    ).toThrow(/NODE_METRICS_SAMPLE_SEC must be at least TELEMETRY_POLL_SEC/);
  });

  it("accepts a sample period equal to the poll period", () => {
    expect(
      resolveWorkerPeriods({
        TELEMETRY_POLL_SEC: "120",
        NODE_METRICS_SAMPLE_SEC: "120",
      }),
    ).toMatchObject({ telemetryPollMs: 120_000, metricsSampleMs: 120_000 });
  });

  it("compares the overridden sample period against the DEFAULT poll period", () => {
    // The floor has to hold when only one of the two is set, otherwise the
    // check passes exactly when it is least likely to be thought about.
    expect(() =>
      resolveWorkerPeriods({ NODE_METRICS_SAMPLE_SEC: "30" }),
    ).toThrow(/NODE_METRICS_SAMPLE_SEC must be at least TELEMETRY_POLL_SEC/);
  });

  it.each(["0", "-5", "abc", "1.5"])("refuses %j as a period", (raw) => {
    expect(() => resolveWorkerPeriods({ TELEMETRY_POLL_SEC: raw })).toThrow(
      /TELEMETRY_POLL_SEC must be a positive integer/,
    );
  });

  it.each(["", "   "])("treats %j as unset", (raw) => {
    // `TELEMETRY_POLL_SEC=` in an .env file is how an operator un-sets a knob.
    // Refusing it would make an empty line in the template a boot failure.
    expect(resolveWorkerPeriods({ TELEMETRY_POLL_SEC: raw })).toMatchObject({
      telemetryPollMs: 60_000,
    });
  });

  it("refuses a retention window that would keep samples forever", () => {
    expect(() =>
      resolveWorkerPeriods({ NODE_METRICS_RETENTION_DAYS: "0" }),
    ).toThrow(/NODE_METRICS_RETENTION_DAYS must be a positive integer/);
  });
});
