/**
 * The worker's DEFAULT periods -- what every background loop and sampling floor
 * falls back to when the panel has not been told otherwise.
 *
 * These are no longer the last word. Since `portal_policy` grew a nullable
 * column per period (see WORKER_PERIOD_FIELDS in @amnezia/contracts), an admin
 * sets any of them in the panel or from the CLI and the worker picks the new
 * value up on its next cycle -- see `periods.ts`. What this module produces is
 * the value used when the stored one is null, which is why an upgraded panel
 * keeps running exactly as it did: every column starts null.
 *
 * They live in their own module rather than inline in `main.ts` so they can be
 * tested without booting the worker: every one of them decides either how often
 * the panel talks to the fleet or how fast one of its tables grows, and a
 * silently-wrong value there is invisible until the disk fills.
 *
 * Only the four periods that already had an environment variable still read
 * one. The rest default to the constant in the contract: adding a new
 * environment variable for a setting that is now editable in the panel would be
 * a second way to say the same thing, and the two would disagree.
 */

import {
  WORKER_PERIOD_FIELDS,
  type WorkerPeriodField,
} from "@amnezia/contracts";

/** Every period in its own unit -- seconds, except the retention window in days. */
export type WorkerPeriodDefaults = Record<WorkerPeriodField, number>;

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

export const resolveWorkerPeriodDefaults = (
  env: NodeJS.ProcessEnv,
): WorkerPeriodDefaults => {
  const telemetryPollSec = positiveInteger(
    env,
    "TELEMETRY_POLL_SEC",
    WORKER_PERIOD_FIELDS.telemetryPollSec.fallback,
  );
  const nodeMetricsSampleSec = positiveInteger(
    env,
    "NODE_METRICS_SAMPLE_SEC",
    WORKER_PERIOD_FIELDS.nodeMetricsSampleSec.fallback,
  );
  // Only a poll can write a sample, so a sample period below the poll period is
  // not a faster history - it is the same history with a setting that lies
  // about it. Refusing at boot is the only place an ENVIRONMENT pair can still
  // be noticed; the stored pair is refused by the control API on write and
  // clamped by `periods.ts` on read.
  if (nodeMetricsSampleSec < telemetryPollSec) {
    throw new Error(
      "NODE_METRICS_SAMPLE_SEC must be at least TELEMETRY_POLL_SEC",
    );
  }
  // Historically expressed in milliseconds, and it stays that way: an operator
  // upgrading must not find their ACCESS_RECONCILE_INTERVAL_MS reinterpreted as
  // seconds and the reconcile running a thousand times too often. Seconds is
  // what the stored column and every other period speak, so it is converted
  // here, rounded up so a sub-second value can never become a zero period.
  const accessReconcileMs = positiveInteger(
    env,
    "ACCESS_RECONCILE_INTERVAL_MS",
    WORKER_PERIOD_FIELDS.accessReconcileSec.fallback * 1_000,
  );
  return {
    telemetryPollSec,
    nodeMetricsSampleSec,
    nodeMetricsRetentionDays: positiveInteger(
      env,
      "NODE_METRICS_RETENTION_DAYS",
      WORKER_PERIOD_FIELDS.nodeMetricsRetentionDays.fallback,
    ),
    accessReconcileSec: Math.max(1, Math.ceil(accessReconcileMs / 1_000)),
    // No environment variable of their own: these were hard-coded constants
    // until they became panel settings, and inventing a variable for each one
    // now would add a knob nobody has ever set.
    peerSampleSec: WORKER_PERIOD_FIELDS.peerSampleSec.fallback,
    maintenanceIntervalSec: WORKER_PERIOD_FIELDS.maintenanceIntervalSec.fallback,
    agentReleaseRefreshSec: WORKER_PERIOD_FIELDS.agentReleaseRefreshSec.fallback,
    ruleFetchIntervalSec: WORKER_PERIOD_FIELDS.ruleFetchIntervalSec.fallback,
  };
};
