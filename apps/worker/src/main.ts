import { createDatabase, type EncryptionKeyring } from "@amnezia/db";
import { createNodeAgentClient } from "./nodeAgent.js";
import { createJobProcessor } from "./processor.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";
import { runWorker } from "./runner.js";
import { createMaintenanceRunner } from "./maintenance.js";
import {
  createRuleFetcher,
  type RuleFeed,
  type RuleProfile,
  type RuleSource,
} from "./rules.js";
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

const positiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

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
const repository = new PostgresWorkerRepository({
  db: database.db,
  keyring,
  activeKeyVersion,
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
});
// Route-rule feeds activate by default. Set RU_*_POC_APPROVED=false to hold a
// profile's auto-fetched versions in quarantine until an operator reviews them.
const pocApprovedFor = (profile: RuleProfile): boolean =>
  profile === "ru_whitelist"
    ? process.env.RU_WHITELIST_POC_APPROVED !== "false"
    : process.env.RU_BLACKLIST_POC_APPROVED !== "false";

/**
 * Build one rule fetcher per configured routing-rule feed. `RULE_FEEDS` is a
 * JSON array of `{ profile, sources: [{ url, format }] }`; the legacy
 * `ROSCOMVPN_RULES_URL` maps to a single JSON ru_whitelist feed.
 */
const buildRuleFetchers = (): Array<() => Promise<void>> => {
  const feeds: RuleFeed[] = [];
  const raw = process.env.RULE_FEEDS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("RULE_FEEDS is not valid JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("RULE_FEEDS must be an array");
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const profile = entry.profile;
      if (profile !== "ru_whitelist" && profile !== "ru_blacklist") {
        throw new Error(`RULE_FEEDS has an invalid profile: ${String(profile)}`);
      }
      const sources = (entry.sources as RuleSource[] | undefined)?.filter(
        (source) =>
          typeof source?.url === "string" &&
          ["json", "cidr-lines", "domain-lines"].includes(source?.format),
      );
      if (!sources?.length) {
        throw new Error(`RULE_FEEDS entry for ${profile} has no valid sources`);
      }
      feeds.push({ profile, sources, pocApproved: pocApprovedFor(profile) });
    }
  }
  const legacyUrl = process.env.ROSCOMVPN_RULES_URL?.trim();
  if (legacyUrl && !feeds.some((feed) => feed.profile === "ru_whitelist")) {
    feeds.push({
      profile: "ru_whitelist",
      sources: [{ url: legacyUrl, format: "json" }],
      pocApproved: pocApprovedFor("ru_whitelist"),
    });
  }
  return feeds.map((feed) => createRuleFetcher({ repository, feed }));
};

const ruleFetchers = buildRuleFetchers();

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

const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

try {
  await Promise.all([
    runWorker({ repository, processJob, signal: abortController.signal }),
    runPeriodicTask({
      task: pollTelemetry,
      intervalMs: 60_000,
      signal: abortController.signal,
      onError: reportBackgroundError,
    }),
    runPeriodicTask({
      task: runMaintenance,
      intervalMs: 60 * 60_000,
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
