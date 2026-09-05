import { WORKER_PERIOD_FIELDS } from "@amnezia/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A retention window that may be a fixed number of days or a resolver. */
const resolveRetentionDays = async (
  option: number | (() => Promise<number>),
): Promise<number> => {
  if (typeof option === "number") return option;
  try {
    const value = await option();
    return Number.isFinite(value) && value > 0
      ? value
      : WORKER_PERIOD_FIELDS.nodeMetricsRetentionDays.fallback;
  } catch {
    return WORKER_PERIOD_FIELDS.nodeMetricsRetentionDays.fallback;
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
   * removed), along with the revoked key rows. Returns the deleted emails.
   */
  purgeOffboardedUsers: () => Promise<{ deleted: string[] }>;
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
};

export const createMaintenanceRunner = ({
  repository,
  now = () => new Date(),
  rawRetentionDays = 7,
  hourlyRetentionDays = 90,
  dailyRetentionDays = 730,
  nodeMetricsRetentionDays = WORKER_PERIOD_FIELDS.nodeMetricsRetentionDays
    .fallback,
}: MaintenanceRunnerOptions) => async (): Promise<void> => {
  const current = now();
  // Resolved once per run rather than per statement, so one maintenance pass
  // cannot prune against two different windows. A resolver that fails leaves
  // the run on the default window: pruning nothing would let the table grow
  // unbounded on exactly the panel whose database is already struggling.
  const metricsRetentionDays = await resolveRetentionDays(
    nodeMetricsRetentionDays,
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
  // Disabled accounts are removed once their keys have finished revoking.
  await repository.purgeOffboardedUsers();
};
