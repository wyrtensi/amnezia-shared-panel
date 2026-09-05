import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { sql } from "drizzle-orm";
import {
  ACCESS_SYNC_DEDUPLICATION_KEY,
  ACCESS_SYNC_JOB_TYPE,
  type KeyState,
  type PortalPolicy,
  type PortalPolicyOverride,
} from "@amnezia/contracts";
import type { Database } from "./client.js";
import { jobOutbox } from "./schema.js";

export * from "./client.js";
export * from "./schema.js";

export type EncryptionKeyring = Readonly<Record<number, Buffer>>;

export type EncryptedSecret = {
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
};

const quotaStates = new Set<KeyState>([
  "provisioning",
  "active",
  "disabled",
]);

const getEncryptionKey = (
  keyring: EncryptionKeyring,
  keyVersion: number,
): Buffer => {
  const key = keyring[keyVersion];
  if (!key) {
    throw new Error(`Unknown encryption key version: ${keyVersion}`);
  }
  if (key.byteLength !== 32) {
    throw new Error("AES-256-GCM keys must contain exactly 32 bytes");
  }
  return key;
};

export const encryptSecret = (
  plaintext: string,
  keyring: EncryptionKeyring,
  keyVersion: number,
): EncryptedSecret => {
  const key = getEncryptionKey(keyring, keyVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    keyVersion,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
};

export const decryptSecret = (
  encrypted: EncryptedSecret,
  keyring: EncryptionKeyring,
): string => {
  const key = getEncryptionKey(keyring, encrypted.keyVersion);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

export const countQuotaKeys = (states: readonly KeyState[]): number =>
  states.reduce((count, state) => count + Number(quotaStates.has(state)), 0);

export const effectiveKeyLimit = (
  globalLimit: number,
  userOverride: number | null | undefined,
): number => userOverride ?? globalLimit;

export const resolvePortalPolicy = (
  globalPolicy: PortalPolicy,
  userOverride: PortalPolicyOverride | null | undefined,
): PortalPolicy => ({ ...globalPolicy, ...(userOverride ?? {}) });

export const deterministicPeerLabel = (
  keyId: string,
  nodeLabelSecret: Buffer,
): string => {
  if (nodeLabelSecret.byteLength < 32) {
    throw new Error("Node label secrets must contain at least 32 bytes");
  }
  const digest = createHmac("sha256", nodeLabelSecret)
    .update(keyId, "utf8")
    .digest("base64url")
    .slice(0, 22);
  return `ap_${digest}`;
};

export const trafficDelta = (
  previous: number,
  current: number,
): { delta: number; reset: boolean } =>
  current >= previous
    ? { delta: current - previous, reset: false }
    : { delta: current, reset: true };

// --- Two-way Cloudflare Access sync arm -------------------------------------
// Both the worker (a panel-side user change, or its own hourly timer) and
// control-api (Task 4: the same user mutations, from the admin side) arm the
// single `access.sync` outbox row. The statement lives here, once, so both
// apps run the exact same upsert rather than two copies that can drift.
export type AccessSyncArmReason = "user-change" | "timer" | "operator" | "config";

// The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`.
// armAccessSyncRow accepts this or the top-level Database handle so a caller
// that already holds a transaction -- control-api arms the sync inside the
// same transaction as the user mutation that triggered it -- can pass it
// straight through instead of opening a second, separate transaction.
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A fresh arm is debounced by this much, so a burst of changes is one run. */
const ACCESS_SYNC_DEBOUNCE_MS = 10_000;

const accessSyncPayload = (reason: AccessSyncArmReason) => ({
  requestedAt: new Date().toISOString(),
  // A UUID, not the timestamp: two arms in the same millisecond must differ.
  armId: randomUUID(),
  reason,
});

/**
 * Arm the single `access.sync` outbox row so the worker's poller runs a
 * reconciliation shortly, coalescing any number of changes inside the
 * debounce window into one run.
 *
 * The marker (`payload.armId`) is refreshed on every call, whatever the
 * row's current status -- a change committed after a running sync already
 * read the user table must still cause one more run, so a processing row
 * cannot be left alone the way the rules-refresh precedent leaves it.
 * `finishAccessSync` compares this marker before marking the job complete.
 *
 * Only a finished row (completed/failed) restarts its lifecycle columns
 * (status/availableAt/attempts/lockedAt/completedAt/lastError); a pending or
 * processing row keeps them so the attempt already in flight is undisturbed.
 */
export const armAccessSyncRow = async (
  executor: Database | DbTransaction,
  reason: AccessSyncArmReason,
): Promise<void> => {
  const availableAt = new Date(Date.now() + ACCESS_SYNC_DEBOUNCE_MS);
  // Built once: the insert branch and the conflict-update branch must see the
  // SAME marker. Calling accessSyncPayload() twice would mint two UUIDs and
  // silently discard one, for no benefit — only one of the two branches ever
  // actually runs per call.
  const payload = accessSyncPayload(reason);
  await executor
    .insert(jobOutbox)
    .values({
      type: ACCESS_SYNC_JOB_TYPE,
      deduplicationKey: ACCESS_SYNC_DEDUPLICATION_KEY,
      payload,
      availableAt,
    })
    .onConflictDoUpdate({
      target: jobOutbox.deduplicationKey,
      set: {
        payload,
        status: sql`CASE WHEN ${jobOutbox.status} IN ('completed','failed') THEN 'pending'::outbox_status ELSE ${jobOutbox.status} END`,
        // Interpolated as an ISO string cast to timestamptz, not as a raw
        // Date: the postgres.js driver can only bind a JS Date on drizzle's
        // typed `.set({ col: date })` path, which converts it first. A Date
        // handed straight to a `sql` template throws at bind time ("The
        // 'string' argument must be of type string or an instance of Buffer
        // or ArrayBuffer. Received an instance of Date") -- verified against
        // a real database while building this statement.
        availableAt: sql`CASE WHEN ${jobOutbox.status} IN ('completed','failed') THEN ${availableAt.toISOString()}::timestamptz ELSE ${jobOutbox.availableAt} END`,
        attempts: sql`CASE WHEN ${jobOutbox.status} IN ('completed','failed') THEN 0 ELSE ${jobOutbox.attempts} END`,
        lockedAt: sql`CASE WHEN ${jobOutbox.status} IN ('completed','failed') THEN NULL ELSE ${jobOutbox.lockedAt} END`,
        completedAt: sql`CASE WHEN ${jobOutbox.status} IN ('completed','failed') THEN NULL ELSE ${jobOutbox.completedAt} END`,
        lastError: sql`CASE WHEN ${jobOutbox.status} IN ('completed','failed') THEN NULL ELSE ${jobOutbox.lastError} END`,
        updatedAt: new Date(),
      },
    });
};
