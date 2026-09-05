import { createDatabase, type EncryptionKeyring } from "@amnezia/db";
import { createNodeAgentClient } from "./nodeAgent.js";
import { createJobProcessor } from "./processor.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";
import { runWorker } from "./runner.js";
import { createMaintenanceRunner } from "./maintenance.js";
import { resolveWorkerPeriodDefaults } from "./config.js";
import {
  createWorkerPeriods,
  readWorkerPeriodOverrides,
} from "./periods.js";
import {
  createRuleFetcher,
  resolveRuleFeeds,
  type RuleProfile,
} from "./rules.js";
import { resolveNodeAgentRelease } from "./agentRelease.js";
import { runPeriodicTask } from "./scheduler.js";
import { createTelemetryPoller } from "./telemetry.js";
import { nonNegativeIntegerEnv, positiveIntegerEnv } from "./envInt.js";
import {
  createAccessReconciler,
  createAccessSync,
  createAccessWriteback,
  createAllowlistDirectory,
  createCloudflareDirectory,
  type AccessDirectory,
} from "./accessReconcile.js";

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const parseKeyring = (raw: string): EncryptionKeyring => {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const keyring: Record<number, Buffer> = {};
  for (const [versionRaw, keyRaw] of Object.entries(parsed)) {
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || typeof keyRaw !== "string") {
      throw new Error("CONFIG_ENCRYPTION_KEYS_JSON has an invalid entry");
    }
    const key = Buffer.from(keyRaw, "base64");
    if (key.byteLength !== 32) throw new Error("Encryption keys must be 32 bytes");
    keyring[version] = key;
  }
  return keyring;
};

// Sanitized single-line stderr write, shared by every path that surfaces a
// failure to the operator watching `docker logs worker`: strip newlines/tabs
// (so one failure cannot fake extra log lines) and cap the length.
const logError = (message: string): void => {
  console.error(message.replace(/[\r\n\t]+/g, " ").slice(0, 2_000));
};

const reportBackgroundError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : "Unknown background error";
  logError(message);
};

const database = createDatabase(requiredEnv("DATABASE_URL"));
const keyring = parseKeyring(requiredEnv("CONFIG_ENCRYPTION_KEYS_JSON"));
const activeKeyVersion = Number(requiredEnv("CONFIG_ENCRYPTION_ACTIVE_VERSION"));
if (!keyring[activeKeyVersion]) {
  throw new Error("CONFIG_ENCRYPTION_ACTIVE_VERSION is not present in the keyring");
}
// Read before anything is constructed: an unusable period should stop the
// worker at boot, not after it has already opened a pool and polled the fleet.
// These are the DEFAULTS now -- the value each period takes when the panel has
// not been given one, which is why an upgraded host keeps the periods it had.
const periodDefaults = resolveWorkerPeriodDefaults(process.env);
/**
 * The live periods. Every loop below asks this before each wait instead of
 * closing over a number, so an admin editing a period in the panel or from the
 * CLI is picked up without recreating a container.
 *
 * The latency is honest and worth stating: a loop that is already waiting out
 * the OLD period finishes that wait first, so a change lands at the start of
 * the next cycle -- up to one old period away -- plus at most the short cache
 * window inside this reader.
 */
const periods = createWorkerPeriods({
  read: () => readWorkerPeriodOverrides(database.db),
  defaults: periodDefaults,
  onError: (error) => reportBackgroundError(error),
});
const repository = new PostgresWorkerRepository({
  db: database.db,
  keyring,
  activeKeyVersion,
  metricsSampleSec: () => periods.get("nodeMetricsSampleSec"),
  peerSampleSec: () => periods.get("peerSampleSec"),
  // What a failed lookup falls back to. The worker's OWN defaults, not the
  // contract's constants: on a host that sets NODE_METRICS_SAMPLE_SEC that
  // variable is the period actually in force.
  periodDefaults,
});
const pollTelemetry = createTelemetryPoller({
  repository,
  createNodeAgent: (node) => createNodeAgentClient(node),
});
const runMaintenance = createMaintenanceRunner({
  repository,
  rawRetentionDays: positiveIntegerEnv("TELEMETRY_RAW_RETENTION_DAYS", 7),
  hourlyRetentionDays: positiveIntegerEnv(
    "TELEMETRY_HOURLY_RETENTION_DAYS",
    90,
  ),
  dailyRetentionDays: positiveIntegerEnv(
    "TELEMETRY_DAILY_RETENTION_DAYS",
    730,
  ),
  nodeMetricsRetentionDays: () => periods.get("nodeMetricsRetentionDays"),
});
// Route-rule feeds activate by default. Set RU_*_POC_APPROVED=false to hold a
// profile's auto-fetched versions in quarantine until an operator reviews them.
const pocApprovedFor = (profile: RuleProfile): boolean =>
  profile === "ru_whitelist"
    ? process.env.RU_WHITELIST_POC_APPROVED !== "false"
    : process.env.RU_BLACKLIST_POC_APPROVED !== "false";

/**
 * One rule fetcher per resolved routing-rule feed. With no feed configuration
 * at all this is the built-in RoscomVPN set, so route profiles work on a fresh
 * install; see `resolveRuleFeeds` for the full precedence.
 */
const ruleFetchers = resolveRuleFeeds(process.env, pocApprovedFor).map((feed) =>
  createRuleFetcher({ repository, feed }),
);

/**
 * Optional Cloudflare Access deactivation sync. Off unless
 * `ACCESS_RECONCILE_ENABLED=true`. Picks the allowed-email source from
 * `ACCESS_DIRECTORY` ("allowlist" by default, or "cloudflare").
 */
const buildAccessReconciler = (): (() => Promise<void>) | null => {
  if (process.env.ACCESS_RECONCILE_ENABLED !== "true") return null;
  const mode = (process.env.ACCESS_DIRECTORY ?? "allowlist").trim();
  const directory: AccessDirectory =
    mode === "cloudflare"
      ? createCloudflareDirectory({
          accountId: process.env.CF_ACCESS_ACCOUNT_ID,
          apiToken: process.env.CF_API_TOKEN,
          groupId: process.env.CF_ACCESS_GROUP_ID,
        })
      : createAllowlistDirectory(process.env.ACCESS_ALLOWLIST ?? "");
  return createAccessReconciler({
    repository,
    directory,
    log: (message) => console.log(message),
  });
};

const bootstrapAdminEmails = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

/**
 * The two-way Cloudflare Access sync instance (panel <-> CF policy include
 * list). Built once, directly into a const, so its closure's abort-audit
 * de-duplication state (see accessReconcile.ts) persists across every run --
 * a second instance would silently break that. `undefined` unless
 * `ACCESS_SYNC_ENABLED=true`.
 *
 * The timer no longer calls this directly (see the `runPeriodicTask` below):
 * it only arms the outbox row, and the outbox runner -- which processes one
 * job at a time -- is the sole executor. That removes the race where the
 * timer and the runner could both be mid-sync at once, cross their policy and
 * baseline writes, and leave the next run disabling a freshly created user.
 */
const buildAccessSyncTask = (): ReturnType<typeof createAccessSync> | undefined => {
  if (process.env.ACCESS_SYNC_ENABLED !== "true") return undefined;
  return createAccessSync({
    repository,
    bootstrapAdminEmails,
    maxDisablesPerRun: nonNegativeIntegerEnv("ACCESS_SYNC_MAX_DISABLES", 10),
    recordAccessSyncAborted: (details) =>
      repository.recordAccessSyncAborted(details),
    log: (message) => console.log(message),
  });
};

// The single instance, or undefined. Constructed here -- above the processor
// -- so `processJob` below can receive it and become the only place that
// runs it.
const accessSyncTask = buildAccessSyncTask();

// Built after the fetchers and the access-sync instance so the
// operator-triggered `rules.refresh` job can run exactly the same feed
// fetchers the 6-hourly timer runs, and the outbox runner can run the same
// access-sync instance the timer only arms.
const processJob = createJobProcessor({
  repository,
  createNodeAgent: (node) => createNodeAgentClient(node),
  ruleFetchers,
  accessSync: accessSyncTask,
  // Without this, a throwing access.sync run is only ever recorded in
  // job_outbox.last_error: the runner turns the throw into retryJob/failJob
  // with no console output, so an operator watching `docker logs worker`
  // would see nothing for a Cloudflare 401, a 5xx, a DNS failure or the fetch
  // timeout.
  log: logError,
});

// Legacy Cloudflare Access pieces, independent features kept exactly as they
// were and out of scope for this change:
//   ACCESS_RECONCILE_ENABLED (+ ACCESS_DIRECTORY) → CF → panel disable, and
//   ACCESS_WRITEBACK_ENABLED → panel → CF write-back.
// Both stay off when the two-way sync above is enabled -- running them
// alongside it would fight over the same state.
const buildAccessTasks = (): Array<() => Promise<void>> => {
  if (accessSyncTask) return [];
  const tasks: Array<() => Promise<void>> = [];
  const reconcile = buildAccessReconciler();
  if (reconcile) tasks.push(reconcile);
  if (process.env.ACCESS_WRITEBACK_ENABLED === "true") {
    tasks.push(
      createAccessWriteback({
        repository,
        bootstrapAdminEmails,
        log: (message) => console.log(message),
      }),
    );
  }
  return tasks;
};

const accessTasks = buildAccessTasks();

// Resolve the node-agent release the panel offers nodes. This is the worker's
// job and not the control API's: it is the process that already reaches the
// network, and an admin opening a node card must not wait on a registry round
// trip. The result is stored, and a stale or missing row is what makes the
// panel say "cannot resolve the current image" rather than fall back to a tag.
const nodeAgentUpdateRepository = process.env.NODE_AGENT_UPDATE_REPO?.trim();
const refreshNodeAgentRelease = async (): Promise<void> => {
  if (!nodeAgentUpdateRepository) return;
  const release = await resolveNodeAgentRelease(nodeAgentUpdateRepository);
  if (!release) {
    console.warn(
      `Could not resolve a node-agent release for ${nodeAgentUpdateRepository}`,
    );
    return;
  }
  await repository.saveNodeAgentRelease({
    repository: release.repository,
    version: release.version,
    digest: release.digest,
    resolvedAt: new Date(),
  });
};

const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

try {
  await Promise.all([
    runWorker({ repository, processJob, signal: abortController.signal }),
    runPeriodicTask({
      task: pollTelemetry,
      intervalMs: () => periods.intervalMs("telemetryPollSec"),
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    runPeriodicTask({
      task: runMaintenance,
      intervalMs: () => periods.intervalMs("maintenanceIntervalSec"),
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    runPeriodicTask({
      task: refreshNodeAgentRelease,
      intervalMs: () => periods.intervalMs("agentReleaseRefreshSec"),
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    ...ruleFetchers.map((fetchRules) =>
      runPeriodicTask({
        task: fetchRules,
        intervalMs: () => periods.intervalMs("ruleFetchIntervalSec"),
        signal: abortController.signal,
        onError: reportBackgroundError,
      }),
    ),
    ...accessTasks.map((task) =>
      runPeriodicTask({
        task,
        intervalMs: () => periods.intervalMs("accessReconcileSec"),
        signal: abortController.signal,
        onError: reportBackgroundError,
      }),
    ),
    ...(accessSyncTask
      ? [
          runPeriodicTask({
            // The timer no longer runs the sync: it arms the same outbox row a
            // user change arms, so the runner stays the ONLY executor. Two
            // concurrent runs can cross their policy and baseline writes and
            // leave the next run disabling a freshly created user.
            task: () => repository.armAccessSync("timer"),
            intervalMs: () => periods.intervalMs("accessReconcileSec"),
            signal: abortController.signal,
            onError: reportBackgroundError,
          }),
        ]
      : []),
  ]);
} finally {
  await database.client.end();
}
