import { eq } from "drizzle-orm";
import {
  isAllowedBridgeManagementUrl,
  normalizeBridgeManagementUrl,
  readBridgeAgentIdentity,
  readBridgeAgentStatus,
  type BridgeAgentIdentity,
  type BridgeAgentPollOutcome,
} from "@amnezia/contracts";
import {
  applyBridgePollResult,
  auditEvents,
  encryptSecret,
  vpnBridges,
  type EncryptionKeyring,
} from "@amnezia/db";

import type { BridgeTransaction } from "./bridgeRepository.js";
import { ApiError, type Actor } from "./service.js";

export type BridgeEnrollmentOptions = {
  keyring: EncryptionKeyring;
  activeKeyVersion: number;
  /** `VPN_BRIDGE_MANAGEMENT_HOSTS`: hosts a management URL may name. */
  managementHosts: readonly string[];
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** A candidate enrollment that passed the identity check. */
export type VerifiedEnrollment = {
  apiUrl: string;
  apiKey: string;
  identity: BridgeAgentIdentity;
  /** Panel clock before the first status read. */
  statusStartedAt: Date;
  status: BridgeAgentPollOutcome;
};

const unsupported = () =>
  new ApiError(
    409,
    "The bridge-agent does not offer a supported management API (version 1 with status.v1)",
    "BRIDGE_UNSUPPORTED_CAPABILITY",
  );
const identityMismatch = () =>
  new ApiError(
    409,
    "The bridge-agent at this endpoint answers for another bridge",
    "BRIDGE_IDENTITY_MISMATCH",
  );

/**
 * Check a candidate enrollment against the agent itself, before anything is
 * stored: the URL must be an allowed management destination, and the agent,
 * called with the candidate credential, must report this bridge's id, API
 * version 1 and the `status.v1` capability. Then one status read gives the
 * initial observation. Runs outside any transaction (network calls); a
 * refusal leaves the current enrollment exactly as it was. Error messages
 * never carry what the agent sent.
 */
export const verifyEnrollmentCandidate = async (
  options: BridgeEnrollmentOptions,
  bridgeId: string,
  request: { managementApiUrl: string; apiKey: string },
): Promise<VerifiedEnrollment> => {
  if (!isAllowedBridgeManagementUrl(request.managementApiUrl, options.managementHosts)) {
    throw new ApiError(
      400,
      "The management API URL is not an allowed management destination (VPN_BRIDGE_MANAGEMENT_HOSTS)",
      "BRIDGE_MANAGEMENT_URL_NOT_ALLOWED",
    );
  }
  const apiUrl = normalizeBridgeManagementUrl(request.managementApiUrl);
  const client = {
    baseUrl: apiUrl,
    apiKey: request.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  };
  const check = await readBridgeAgentIdentity(bridgeId, client);
  switch (check.kind) {
    case "unreachable":
      throw new ApiError(
        502,
        "The bridge-agent could not be reached through the management endpoint",
        "BRIDGE_AGENT_UNREACHABLE",
      );
    case "unauthorized":
      throw new ApiError(
        409,
        "The bridge-agent rejected the API credential",
        "BRIDGE_AGENT_UNAUTHORIZED",
      );
    case "identity_mismatch":
      throw identityMismatch();
    case "unsupported":
      throw unsupported();
    case "ok":
      break;
  }
  const statusStartedAt = new Date();
  const status = await readBridgeAgentStatus(bridgeId, client);
  // The identity just matched, so these mean the agent is inconsistent or
  // changed under us: refuse rather than store an enrollment that cannot
  // produce observations. An agent that is merely down for the status read
  // is enrolled and recorded as down.
  if (status.kind === "identity_mismatch") throw identityMismatch();
  if (status.kind === "unsupported") throw unsupported();
  return { apiUrl, apiKey: request.apiKey, identity: check.identity, statusStartedAt, status };
};

/**
 * Store a verified enrollment inside the caller's transaction, which holds
 * the bridge row lock: the URL and the encrypted credential, the identity's
 * metadata, then the first status read through the same write the worker's
 * poller uses. The audit event carries ids and enums only.
 */
export const storeEnrollment = async (
  tx: BridgeTransaction,
  options: Pick<BridgeEnrollmentOptions, "keyring" | "activeKeyVersion">,
  actor: Actor,
  bridgeId: string,
  replaced: boolean,
  enrollment: VerifiedEnrollment,
): Promise<void> => {
  const credential = encryptSecret(enrollment.apiKey, options.keyring, options.activeKeyVersion);
  const enrolledAt = new Date();
  await tx
    .update(vpnBridges)
    .set({
      managementApiUrl: enrollment.apiUrl,
      managementCredentialCiphertext: credential.ciphertext,
      managementCredentialNonce: credential.nonce,
      managementCredentialAuthTag: credential.authTag,
      managementCredentialKeyVersion: credential.keyVersion,
      managementEnrolledAt: enrolledAt,
      agentVersion: enrollment.identity.agentVersion,
      agentApiVersion: enrollment.identity.apiVersion,
      agentCapabilities: enrollment.identity.capabilities,
      // Polls of the previous credential no longer count as newer than the
      // first read of this one.
      lastPollAttemptAt: null,
      updatedAt: enrolledAt,
    })
    .where(eq(vpnBridges.id, bridgeId));
  await applyBridgePollResult(tx, {
    bridgeId,
    enrolledAt,
    startedAt: enrollment.statusStartedAt,
    outcome: enrollment.status,
  });
  await tx.insert(auditEvents).values({
    actorUserId: actor.id,
    actorType: "user",
    action: "vpn_bridge.enrolled",
    targetType: "vpn_bridge",
    targetId: bridgeId,
    metadata: {
      replaced,
      agentApiVersion: enrollment.identity.apiVersion,
      managementStatus: enrollment.status.kind,
    },
  });
};
