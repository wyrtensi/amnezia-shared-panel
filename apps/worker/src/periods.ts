/**
 * The live value of every worker period.
 *
 * Periods used to be read once at boot, so changing one meant editing the
 * worker's environment and recreating a container. They are now nullable
 * columns on `portal_policy`, and this module is what turns a stored value into
 * the number a loop actually waits on:
 *
 *   stored value (null = unset)  ->  clamped to the contract's bounds
 *                                ->  or the worker's own default when unset
 *
 * Nothing here holds state that a restart would change: every getter resolves
 * from the current row, so an edit takes effect without a restart. What it does
 * hold is a short cache, because eight loops asking the same singleton row is
 * eight round trips for one answer. The cache is the ONLY latency this module
 * adds; the rest of the delay an admin sees is the loop finishing the wait it
 * had already started, which no design can shorten without waking sleeping
 * timers -- see `runPeriodicTask`.
 *
 * The read is deliberately failure-tolerant. A period lookup that throws must
 * not stop a background loop: the panel would go quiet exactly when its
 * database is unhappy, which is when its telemetry matters most. A failed read
 * reuses the last good row, and the defaults before there has ever been one.
 */

import {
  WORKER_PERIOD_FIELDS,
  clampWorkerPeriod,
  metricsSampleBelowPoll,
  type WorkerPeriodField,
  type WorkerPeriodOverrides,
} from "@amnezia/contracts";
import { portalPolicy, type Database } from "@amnezia/db";
import { eq } from "drizzle-orm";

import type { WorkerPeriodDefaults } from "./config.js";

/**
 * How long a read of the settings row is reused. Well below the smallest period
 * anything can be set to (30 s), so it never doubles a loop's cadence, and high
 * enough that a fleet of loops costs one query rather than one each.
 */
export const PERIOD_CACHE_TTL_MS = 10_000;

export type WorkerPeriods = {
  /** The effective period, in the field's own unit (seconds, or days). */
  get: (field: WorkerPeriodField) => Promise<number>;
  /** The same value in milliseconds. Only meaningful for the second-valued fields. */
  intervalMs: (field: WorkerPeriodField) => Promise<number>;
};

export type CreateWorkerPeriodsOptions = {
  /** Reads the stored overrides. Called at most once per cache window. */
  read: () => Promise<WorkerPeriodOverrides>;
  /** Used for any period the panel has not set. */
  defaults: WorkerPeriodDefaults;
  onError?: (error: unknown) => void;
  cacheTtlMs?: number;
  now?: () => number;
};

/**
 * Read the eight period columns off the singleton settings row.
 *
 * A missing row (a panel where nothing has ever been saved) is the same answer
 * as a row of nulls: no override, so every default applies.
 */
export const readWorkerPeriodOverrides = async (
  db: Database,
): Promise<WorkerPeriodOverrides> => {
  const [row] = await db
    .select({
      telemetryPollSec: portalPolicy.telemetryPollSec,
      nodeMetricsSampleSec: portalPolicy.nodeMetricsSampleSec,
      nodeMetricsRetentionDays: portalPolicy.nodeMetricsRetentionDays,
      peerSampleSec: portalPolicy.peerSampleSec,
      maintenanceIntervalSec: portalPolicy.maintenanceIntervalSec,
      agentReleaseRefreshSec: portalPolicy.agentReleaseRefreshSec,
      ruleFetchIntervalSec: portalPolicy.ruleFetchIntervalSec,
      accessReconcileSec: portalPolicy.accessReconcileSec,
    })
    .from(portalPolicy)
    .where(eq(portalPolicy.id, true))
    .limit(1);
  return row ?? {};
};

/**
 * Resolve one field against a set of overrides and defaults.
 *
 * Exported for the tests and used by `createWorkerPeriods`: keeping the pure
 * decision separate from the caching and the database is what makes the bounds
 * and the sample/poll relation testable without a Postgres.
 */
export const resolveWorkerPeriod = (
  field: WorkerPeriodField,
  overrides: WorkerPeriodOverrides,
  defaults: WorkerPeriodDefaults,
): number => {
  const stored = clampWorkerPeriod(field, overrides[field]);
  const value = stored ?? defaults[field];
  if (field !== "nodeMetricsSampleSec") return value;
  // The one cross-field rule, applied here rather than only on the write path.
  // The control API refuses a stored pair that breaks it, but it cannot see the
  // worker's ENVIRONMENT: a panel with TELEMETRY_POLL_SEC=120 and a sample
  // period of 90 saved before that variable was set is a legitimate way to end
  // up here. Raising the sample period to the poll period is the honest
  // outcome - it is what the panel can actually deliver.
  const poll = resolveWorkerPeriod("telemetryPollSec", overrides, defaults);
  return metricsSampleBelowPoll(poll, value) ? poll : value;
};

export const createWorkerPeriods = ({
  read,
  defaults,
  onError = () => undefined,
  cacheTtlMs = PERIOD_CACHE_TTL_MS,
  now = () => Date.now(),
}: CreateWorkerPeriodsOptions): WorkerPeriods => {
  let cached: WorkerPeriodOverrides = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  // Collapses the burst of eight loops asking at once into one query, and stops
  // a slow database turning into a queue of identical reads.
  let inFlight: Promise<WorkerPeriodOverrides> | null = null;

  const overrides = async (): Promise<WorkerPeriodOverrides> => {
    if (now() - cachedAt < cacheTtlMs) return cached;
    inFlight ??= read()
      .then((next) => {
        cached = next;
        cachedAt = now();
        return next;
      })
      .catch((error: unknown) => {
        onError(error);
        // Not cached: a failed read must not silence the next attempt for a
        // whole window, and the last good row is a better answer than nothing.
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const get = async (field: WorkerPeriodField): Promise<number> =>
    resolveWorkerPeriod(field, await overrides(), defaults);

  return {
    get,
    intervalMs: async (field) => {
      const value = await get(field);
      return WORKER_PERIOD_FIELDS[field].unit === "day"
        ? value * 24 * 60 * 60 * 1_000
        : value * 1_000;
    },
  };
};
