/**
 * Worker periods, read once from the environment.
 *
 * These live in their own module rather than inline in `main.ts` so they can be
 * tested without booting the worker: every one of them decides either how often
 * the panel talks to the fleet or how fast one of its tables grows, and a
 * silently-wrong value there is invisible until the disk fills.
 */

import { DEFAULT_METRICS_SAMPLE_SEC } from "./nodeMetrics.js";

export type WorkerPeriods = {
  /** How often the telemetry poll runs. */
  telemetryPollMs: number;
  /** How often a poll is allowed to keep a host-metrics history row. */
  metricsSampleMs: number;
  /** How long `node_metrics_samples` rows are kept. */
  metricsRetentionDays: number;
};

// Defaults, also the numbers documented in the .env examples. The sample period
// is imported rather than repeated: the repository falls back to the same
// constant when no option is passed, and two copies of it would disagree the
// first time one is changed.
const DEFAULT_TELEMETRY_POLL_SEC = 60;
const DEFAULT_METRICS_RETENTION_DAYS = 7;

const positiveInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export const resolveWorkerPeriods = (
  env: NodeJS.ProcessEnv,
): WorkerPeriods => {
  const telemetryPollSec = positiveInteger(
    env,
    "TELEMETRY_POLL_SEC",
    DEFAULT_TELEMETRY_POLL_SEC,
  );
  const metricsSampleSec = positiveInteger(
    env,
    "NODE_METRICS_SAMPLE_SEC",
    DEFAULT_METRICS_SAMPLE_SEC,
  );
  // Only a poll can write a sample, so a sample period below the poll period is
  // not a faster history - it is the same history with a setting that lies
  // about it. Refusing at boot is the only place this can still be noticed.
  if (metricsSampleSec < telemetryPollSec) {
    throw new Error(
      "NODE_METRICS_SAMPLE_SEC must be at least TELEMETRY_POLL_SEC",
    );
  }
  return {
    telemetryPollMs: telemetryPollSec * 1_000,
    metricsSampleMs: metricsSampleSec * 1_000,
    metricsRetentionDays: positiveInteger(
      env,
      "NODE_METRICS_RETENTION_DAYS",
      DEFAULT_METRICS_RETENTION_DAYS,
    ),
  };
};
