const DAY_MS = 24 * 60 * 60 * 1_000;

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
};

export const createMaintenanceRunner = ({
  repository,
  now = () => new Date(),
  rawRetentionDays = 7,
  hourlyRetentionDays = 90,
  dailyRetentionDays = 730,
}: MaintenanceRunnerOptions) => async (): Promise<void> => {
  const current = now();
  const rawCutoff = new Date(current.getTime() - rawRetentionDays * DAY_MS);
  const samples = await repository.loadSamplesSince(rawCutoff);
  await repository.replaceRollups(
    "hour",
    aggregateTrafficSamples(samples, "hour"),
  );
  await repository.replaceRollups(
    "day",
    aggregateTrafficSamples(samples, "day"),
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
  // Disabled accounts are removed once their keys have finished revoking.
  await repository.purgeOffboardedUsers();
};
