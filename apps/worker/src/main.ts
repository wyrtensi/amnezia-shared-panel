import { createDatabase, type EncryptionKeyring } from "@amnezia/db";
import { createNodeAgentClient } from "./nodeAgent.js";
import { createJobProcessor } from "./processor.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";
import { runWorker } from "./runner.js";
import { createMaintenanceRunner } from "./maintenance.js";
import { resolveWorkerPeriods } from "./config.js";
import {
  createRuleFetcher,
  resolveRuleFeeds,
  type RuleProfile,
} from "./rules.js";
import { resolveNodeAgentRelease } from "./agentRelease.js";
import { runPeriodicTask } from "./scheduler.js";
import { createTelemetryPoller } from "./telemetry.js";
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

// Shared by the two variants below: `min` and `invalidMessage` are the only
// ways they differ (whether 0 is allowed, and the wording of the error).
const integerEnvAtLeast = (
  name: string,
  fallback: number,
  min: number,
  invalidMessage: string,
): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(invalidMessage);
  }
  return value;
};

const positiveIntegerEnv = (name: string, fallback: number): number =>
  integerEnvAtLeast(name, fallback, 1, `${name} must be a positive integer`);

const nonNegativeIntegerEnv = (name: string, fallback: number): number =>
  integerEnvAtLeast(name, fallback, 0, `${name} must be a non-negative integer`);

const reportBackgroundError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : "Unknown background error";
  console.error(message.replace(/[\r\n\t]+/g, " ").slice(0, 2_000));
};

const database = createDatabase(requiredEnv("DATABASE_URL"));
const keyring = parseKeyring(requiredEnv("CONFIG_ENCRYPTION_KEYS_JSON"));
const activeKeyVersion = Number(requiredEnv("CONFIG_ENCRYPTION_ACTIVE_VERSION"));
if (!keyring[activeKeyVersion]) {
  throw new Error("CONFIG_ENCRYPTION_ACTIVE_VERSION is not present in the keyring");
}
// Read before anything is constructed: an unusable period should stop the
// worker at boot, not after it has already opened a pool and polled the fleet.
const periods = resolveWorkerPeriods(process.env);
const repository = new PostgresWorkerRepository({
  db: database.db,
  keyring,
  activeKeyVersion,
  metricsSampleSec: periods.metricsSampleMs / 1_000,
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
  nodeMetricsRetentionDays: periods.metricsRetentionDays,
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

// Built after the fetchers so the operator-triggered `rules.refresh` job can
// run exactly the same feed fetchers the 6-hourly timer runs.
const processJob = createJobProcessor({
  repository,
  createNodeAgent: (node) => createNodeAgentClient(node),
  ruleFetchers,
});

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

const accessReconcileIntervalMs = positiveIntegerEnv(
  "ACCESS_RECONCILE_INTERVAL_MS",
  60 * 60_000,
);
const bootstrapAdminEmails = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

// Cloudflare Access sync tasks.
//   ACCESS_SYNC_ENABLED=true → two-way sync (panel <-> CF policy include list) in
//     a single task. This is the recommended mode and supersedes the separate
//     reconcile + write-back tasks (running those alongside it would fight).
//   Otherwise the legacy pieces stay available independently:
//     ACCESS_RECONCILE_ENABLED (+ ACCESS_DIRECTORY) → CF → panel disable, and
//     ACCESS_WRITEBACK_ENABLED → panel → CF write-back.
const buildAccessTasks = (): Array<() => Promise<void>> => {
  if (process.env.ACCESS_SYNC_ENABLED === "true") {
    return [
      createAccessSync({
        repository,
        bootstrapAdminEmails,
        maxDisablesPerRun: nonNegativeIntegerEnv("ACCESS_SYNC_MAX_DISABLES", 10),
        recordAccessSyncAborted: (details) =>
          repository.recordAccessSyncAborted(details),
        log: (message) => console.log(message),
      }),
    ];
  }
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
      intervalMs: periods.telemetryPollMs,
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    runPeriodicTask({
      task: runMaintenance,
      intervalMs: 60 * 60_000,
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    runPeriodicTask({
      task: refreshNodeAgentRelease,
      intervalMs: 30 * 60_000,
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    ...ruleFetchers.map((fetchRules) =>
      runPeriodicTask({
        task: fetchRules,
        intervalMs: 6 * 60 * 60_000,
        signal: abortController.signal,
        onError: reportBackgroundError,
      }),
    ),
    ...accessTasks.map((task) =>
      runPeriodicTask({
        task,
        intervalMs: accessReconcileIntervalMs,
        signal: abortController.signal,
        onError: reportBackgroundError,
      }),
    ),
  ]);
} finally {
  await database.client.end();
}
