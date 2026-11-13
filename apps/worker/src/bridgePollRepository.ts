import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  BRIDGE_AGENT_POLL_JOB_TYPE,
  bridgeAgentPollDeduplicationKey,
  type BridgeAgentPollPayload,
} from "@amnezia/contracts";
import {
  applyBridgePollResult,
  decryptSecret,
  jobOutbox,
  vpnBridges,
  type BridgePollApplied,
  type BridgePollWrite,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";

import type { BridgePollRepository, BridgePollTarget } from "./bridgePoller.js";

export class PostgresBridgePollRepository implements BridgePollRepository {
  constructor(private readonly options: { db: Database; keyring: EncryptionKeyring }) {}

  armBridgePolls = async (): Promise<number> => {
    const db = this.options.db;
    const enrolled = await db
      .select({ id: vpnBridges.id })
      .from(vpnBridges)
      .where(isNotNull(vpnBridges.managementEnrolledAt));
    if (enrolled.length === 0) return 0;
    // One row per bridge under a stable key. A finished row restarts its
    // lifecycle; a pending or processing one keeps it, so a slow poll is
    // never doubled and a backlog never piles up more than one row per bridge.
    const finished = sql`${jobOutbox.status} IN ('completed', 'failed')`;
    await db
      .insert(jobOutbox)
      .values(
        enrolled.map(({ id }) => ({
          type: BRIDGE_AGENT_POLL_JOB_TYPE,
          deduplicationKey: bridgeAgentPollDeduplicationKey(id),
          payload: { bridgeId: id } satisfies BridgeAgentPollPayload,
        })),
      )
      .onConflictDoUpdate({
        target: jobOutbox.deduplicationKey,
        set: {
          status: sql`CASE WHEN ${finished} THEN 'pending'::outbox_status ELSE ${jobOutbox.status} END`,
          availableAt: sql`CASE WHEN ${finished} THEN now() ELSE ${jobOutbox.availableAt} END`,
          attempts: sql`CASE WHEN ${finished} THEN 0 ELSE ${jobOutbox.attempts} END`,
          completedAt: sql`CASE WHEN ${finished} THEN NULL ELSE ${jobOutbox.completedAt} END`,
          lockedAt: sql`CASE WHEN ${finished} THEN NULL ELSE ${jobOutbox.lockedAt} END`,
          lastError: sql`CASE WHEN ${finished} THEN NULL ELSE ${jobOutbox.lastError} END`,
          updatedAt: sql`now()`,
        },
      });
    return enrolled.length;
  };

  loadPollTarget = async (bridgeId: string): Promise<BridgePollTarget | null> => {
    const [row] = await this.options.db
      .select({
        bridgeId: vpnBridges.id,
        apiUrl: vpnBridges.managementApiUrl,
        ciphertext: vpnBridges.managementCredentialCiphertext,
        nonce: vpnBridges.managementCredentialNonce,
        authTag: vpnBridges.managementCredentialAuthTag,
        keyVersion: vpnBridges.managementCredentialKeyVersion,
        enrolledAt: vpnBridges.managementEnrolledAt,
      })
      .from(vpnBridges)
      .where(and(eq(vpnBridges.id, bridgeId), isNotNull(vpnBridges.managementEnrolledAt)))
      .limit(1);
    if (
      !row?.apiUrl ||
      !row.enrolledAt ||
      !row.ciphertext ||
      !row.nonce ||
      !row.authTag ||
      row.keyVersion === null
    ) {
      return null;
    }
    let apiKey: string | null;
    try {
      apiKey = decryptSecret(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.authTag,
          keyVersion: row.keyVersion,
        },
        this.options.keyring,
      );
    } catch {
      apiKey = null;
    }
    return { bridgeId: row.bridgeId, apiUrl: row.apiUrl, apiKey, enrolledAt: row.enrolledAt };
  };

  recordPoll = async (write: BridgePollWrite): Promise<BridgePollApplied> =>
    this.options.db.transaction((tx) => applyBridgePollResult(tx, write));
}
