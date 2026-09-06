import { WORKER_PERIOD_FIELDS } from "@amnezia/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * A retention window that may be a fixed number of days or a resolver.
 *
 * A resolver that throws or returns a non-positive number falls back to
 * `fallback` rather than pruning nothing (a window of `Infinity`) or pruning
 * everything (a window of `0`) -- both are worse than the panel's own default,
 * because they either grow a table without bound or destroy rows a resolver
 * hiccup had nothing to do with.
 */
const resolveRetentionDays = async (
  option: number | (() => Promise<number>),
  fallback: number,
): Promise<number> => {
  if (typeof option === "number") return option;
  try {
    const value = await option();
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

/**
 * A gate that may be a fixed boolean or a resolver, asked once per run.
 *
 * Unlike `resolveRetentionDays` above, there is no "fallback" to weigh here:
 * only one direction is ever safe for an irreversible delete. A resolver that
 * throws is treated as OFF -- never as ON -- because a failed read gives no
 * information about what the operator actually wants, and the one thing a
 * failure must never do is start deleting accounts nobody asked to have
 * deleted.
 */
const resolveGate = async (
  option: boolean | (() => Promise<boolean>),
): Promise<boolean> => {
  if (typeof option === "boolean") return option;
  try {
    return await option();
  } catch {
    return false;
  }
};

export type RollupPeriod = "hour" | "day";

export type TrafficSample = {
  keyId: string;
  sampledAt: Date;
  receivedBytes: bigint;
  sentBytes: bigint;
};

export type TrafficRollup = {
  keyId: string;
  period: RollupPeriod;
  bucketStart: Date;
  receivedBytes: bigint;
  sentBytes: bigint;
};

export interface MaintenanceRepository {
  loadSamplesSince: (since: Date) => Promise<TrafficSample[]>;
  replaceRollups: (
    period: RollupPeriod,
    rollups: TrafficRollup[],
  ) => Promise<void>;
  deleteSamplesBefore: (cutoff: Date) => Promise<void>;
  deleteRollupsBefore: (period: RollupPeriod, cutoff: Date) => Promise<void>;
  /**
   * Prune the host-metrics history (`node_metrics_samples`). Separate from
   * `deleteSamplesBefore`, which prunes per-key traffic samples: the two tables
   * grow at different rates - one row per KEY per change, versus one row per
   * NODE per sample period - so they get their own windows.
   */
  deleteNodeMetricsSamplesBefore: (cutoff: Date) => Promise<void>;
  /**
   * Hard-delete disabled users once all their keys have been revoked (peers
   * removed) AND they have sat disabled since before `disabledBefore`, along
   * with the revoked key rows. Returns the deleted emails.
   *
   * `disabledBefore` is the retention-window cutoff, resolved once per run the
   * same way `deleteNodeMetricsSamplesBefore`'s is. It exists so a disabled
   * account survives long enough to be reinstated -- see the fail-closed rule
   * on a NULL `disabled_at` in `purgeOffboardedUsers`'s implementation.
   */
  purgeOffboardedUsers: (disabledBefore: Date) => Promise<{ deleted: string[] }>;
  /**
   * Prune `completed` `job_outbox` rows older than `cutoff` (measured from
   * `completed_at`). Never touches `failed` rows -- a failed row is the
   * evidence an operator reads to see what went wrong, and `rearmStuckRevokes`
   * below counts them -- nor `pending`/`processing` ones. The `rules.refresh`
   * and `access.sync` singleton rows are spared no matter their status or age;
   * see the implementation for why.
   */
  deleteCompletedJobsBefore: (cutoff: Date) => Promise<void>;
  /**
   * Re-insert a fresh `vpn-key.revoke` job for a bounded set of keys stuck in
   * `revoking` whose revoke exhausted its retries. `failJob` deliberately
   * leaves such a key in `revoking` rather than moving it to `failed` (see its
   * comment), and nothing else ever retries it -- without this sweep a
   * permanently-failed revoke sits there forever, its peer still live on the
   * node. Returns how many were re-armed.
   */
  rearmStuckRevokes: () => Promise<{ rearmed: number }>;
}

const bucketStart = (date: Date, period: RollupPeriod): Date => {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  if (period === "day") result.setUTCHours(0);
  return result;
};

const trafficDelta = (previous: bigint, current: bigint): bigint =>
  current >= previous ? current - previous : current;

export const aggregateTrafficSamples = (
  samples: TrafficSample[],
  period: RollupPeriod,
): TrafficRollup[] => {
  const ordered = [...samples].sort(
    (left, right) =>
      left.keyId.localeCompare(right.keyId) ||
      left.sampledAt.getTime() - right.sampledAt.getTime(),
  );
  const previous = new Map<string, TrafficSample>();
  const buckets = new Map<string, TrafficRollup>();
  for (const sample of ordered) {
    const prior = previous.get(sample.keyId);
    previous.set(sample.keyId, sample);
    if (!prior) continue;
    const received = trafficDelta(prior.receivedBytes, sample.receivedBytes);
    const sent = trafficDelta(prior.sentBytes, sample.sentBytes);
    const start = bucketStart(sample.sampledAt, period);
    const bucketKey = `${sample.keyId}:${start.toISOString()}`;
    const current = buckets.get(bucketKey) ?? {
      keyId: sample.keyId,
      period,
      bucketStart: start,
      receivedBytes: 0n,
      sentBytes: 0n,
    };
    current.receivedBytes += received;
    current.sentBytes += sent;
    buckets.set(bucketKey, current);
  }
  return [...buckets.values()].sort(
    (left, right) =>
      left.keyId.localeCompare(right.keyId) ||
      left.bucketStart.getTime() - right.bucketStart.getTime(),
  );
};

export type MaintenanceRunnerOptions = {
  repository: MaintenanceRepository;
  now?: () => Date;
  rawRetentionDays?: number;
  hourlyRetentionDays?: number;
  dailyRetentionDays?: number;
  /**
   * How long host-metrics history rows are kept. A function is asked at the
   * start of every run, which is how an admin's edit reaches the pruner without
   * a restart; a plain number is still accepted and is what the tests use.
   */
  nodeMetricsRetentionDays?: number | (() => Promise<number>);
  /**
   * How long a disabled account is kept before it is purged, resolved the same
   * way as `nodeMetricsRetentionDays` above (a function re-read every run, so
   * an admin's edit applies without a restart).
   */
  offboardedUserRetentionDays?: number | (() => Promise<number>);
  /**
   * How long a `completed` job_outbox row is kept before it is pruned,
   * resolved the same way as the retention windows above.
   */
  completedJobRetentionDays?: number | (() => Promise<number>);
  /**
   * Whether this run may call `purgeOffboardedUsers` at all. Resolved once per
   * run like the windows above, but with no numeric fallback: see
   * `resolveGate`. Defaults to `false`, matching the contract's
   * `autoPurgeOffboardedUsers` -- deleting a user row is irreversible, so a
   * panel that has never touched this setting must not do it on a timer.
   */
  autoPurgeOffboardedUsers?: boolean | (() => Promise<boolean>);
  /**
   * Called when `rearmStuckRevokes` throws. The throw itself must not stop the
   * rest of the pass (see the try/catch around that call below), but a
   * persistently failing sweep still needs to be visible to whoever is
   * watching the worker's logs. Same shape as `runPeriodicTask`'s `onError`;
   * the caller is expected to wire it to the same `reportBackgroundError` used
   * for every other background failure in `main.ts`. Defaults to a no-op so
   * existing callers (and tests) that do not pass one keep swallowing quietly.
   */
  onError?: (error: unknown) => void;
};

export const createMaintenanceRunner = ({
  repository,
  now = () => new Date(),
  rawRetentionDays = 7,
  hourlyRetentionDays = 90,
  dailyRetentionDays = 730,
  nodeMetricsRetentionDays = WORKER_PERIOD_FIELDS.nodeMetricsRetentionDays
    .fallback,
  offboardedUserRetentionDays = WORKER_PERIOD_FIELDS.offboardedUserRetentionDays
    .fallback,
  completedJobRetentionDays = WORKER_PERIOD_FIELDS.completedJobRetentionDays
    .fallback,
  autoPurgeOffboardedUsers = false,
  onError = () => {},
}: MaintenanceRunnerOptions) => async (): Promise<void> => {
  const current = now();
  // Resolved once per run rather than per statement, so one maintenance pass
  // cannot prune against two different windows. A resolver that fails leaves
  // the run on the default window: pruning nothing would let the table grow
  // unbounded on exactly the panel whose database is already struggling.
  const metricsRetentionDays = await resolveRetentionDays(
    nodeMetricsRetentionDays,
    WORKER_PERIOD_FIELDS.nodeMetricsRetentionDays.fallback,
  );
  // Same failure tolerance as the metrics window: a resolver that throws must
  // fall back to the default rather than pruning nothing (never purging any
  // offboarded account) or pruning everything (a window of 0, which would
  // purge every disabled account regardless of how recently it was disabled).
  const userRetentionDays = await resolveRetentionDays(
    offboardedUserRetentionDays,
    WORKER_PERIOD_FIELDS.offboardedUserRetentionDays.fallback,
  );
  // Same failure tolerance again: a resolver that throws must fall back to the
  // default rather than pruning nothing (job_outbox grows without bound) or
  // pruning everything (a window of 0 would race a job that just completed).
  const jobRetentionDays = await resolveRetentionDays(
    completedJobRetentionDays,
    WORKER_PERIOD_FIELDS.completedJobRetentionDays.fallback,
  );
  const rawCutoff = new Date(current.getTime() - rawRetentionDays * DAY_MS);
  const samples = await repository.loadSamplesSince(rawCutoff);
  // Only replace buckets that are FULLY inside the sample window. The bucket
  // that CONTAINS rawCutoff (bucketStart < rawCutoff) is only partially covered
  // — recomputing it would truncate the already-complete stored value to the
  // slice after rawCutoff, and as rawCutoff sweeps forward hourly it would shrink
  // that day/hour to ~its last slice. Dropping partial buckets freezes each one
  // at the last complete recompute (when rawCutoff <= its start).
  const fullBucketsOnly = (rollups: ReturnType<typeof aggregateTrafficSamples>) =>
    rollups.filter(
      (rollup) => rollup.bucketStart.getTime() >= rawCutoff.getTime(),
    );
  await repository.replaceRollups(
    "hour",
    fullBucketsOnly(aggregateTrafficSamples(samples, "hour")),
  );
  await repository.replaceRollups(
    "day",
    fullBucketsOnly(aggregateTrafficSamples(samples, "day")),
  );
  await repository.deleteSamplesBefore(rawCutoff);
  await repository.deleteRollupsBefore(
    "hour",
    new Date(current.getTime() - hourlyRetentionDays * DAY_MS),
  );
  await repository.deleteRollupsBefore(
    "day",
    new Date(current.getTime() - dailyRetentionDays * DAY_MS),
  );
  await repository.deleteNodeMetricsSamplesBefore(
    new Date(current.getTime() - metricsRetentionDays * DAY_MS),
  );
  // job_outbox is never pruned otherwise: every key create/revoke/rotate/
  // enable/disable, every node reconcile, agent update and capacity change
  // leaves a row forever. Only `completed` rows are ever removed -- see the
  // interface comment for why `failed`/`pending`/`processing` are untouched.
  await repository.deleteCompletedJobsBefore(
    new Date(current.getTime() - jobRetentionDays * DAY_MS),
  );
  // Re-arm a bounded set of keys stuck in `revoking` BEFORE the offboarded-user
  // purge below. The two run in separate transactions, so a key re-armed this
  // run will not be `revoked` in time for THIS run's purge -- that is correct,
  // the user is deleted a cycle later, once the retry has actually landed.
  // Wrapped so a failure here (e.g. a transient DB error) cannot stop the
  // purge or any other step in this pass.
  try {
    await repository.rearmStuckRevokes();
  } catch (error) {
    // Reported rather than rethrown -- the pass must continue (see the
    // comment above), but a sweep that keeps failing needs to surface
    // somewhere, or an operator has no way to notice it. The next scheduled
    // maintenance run tries again regardless.
    onError(error);
  }
  // Disabled accounts are removed once their keys have finished revoking AND
  // they have sat disabled for the whole retention window -- long enough for
  // an admin to notice and reinstate one that should not have been
  // offboarded. That is still gated on `autoPurgeOffboardedUsers`: the window
  // above answers HOW LONG to wait, this answers whether the panel may ever
  // do this by itself. Off by default -- see `resolveGate`.
  if (await resolveGate(autoPurgeOffboardedUsers)) {
    await repository.purgeOffboardedUsers(
      new Date(current.getTime() - userRetentionDays * DAY_MS),
    );
  }
};
