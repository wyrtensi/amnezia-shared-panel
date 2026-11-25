import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import {
  decryptSecret,
  nodeEgressIps,
  nodes,
  reachabilityProbe,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";

import type {
  BridgeCandidateRepository,
  CandidateContext,
  CandidateResultWrite,
  CandidateRun,
} from "./bridgeCandidateCheck.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Store a candidate check result on its route. Only a draft or retiring
 * route takes it, only one that was not demoted after the check was
 * requested (a demotion cleared its verification, ruling R11, and a result
 * of a check queued before that must not bring it back), and only when no
 * newer verification was recorded since the request (an operator
 * verification made while this check waited for the probe stays).
 */
export const writeCandidateVerification = async (
  executor: Database | Tx,
  write: CandidateResultWrite,
): Promise<boolean> => {
  const written = await executor
    .update(vpnBridgeRoutes)
    .set({
      verificationMethod: "probe",
      verifiedRegistrationMarker: write.registrationMarker,
      verifiedAt: write.outcome.checkedAt,
      verificationResult: write.outcome.result,
      verificationError: write.outcome.error,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vpnBridgeRoutes.id, write.routeId),
        inArray(vpnBridgeRoutes.state, ["draft", "retiring"]),
        or(
          isNull(vpnBridgeRoutes.retiringSince),
          lte(vpnBridgeRoutes.retiringSince, write.requestedAt),
        ),
        or(
          isNull(vpnBridgeRoutes.verifiedAt),
          lte(vpnBridgeRoutes.verifiedAt, write.requestedAt),
        ),
      ),
    )
    .returning({ id: vpnBridgeRoutes.id });
  return written.length > 0;
};

/** The candidate slot columns, empty. */
export const EMPTY_CANDIDATE_SLOT = {
  candidateRunId: null,
  candidateRouteId: null,
  candidateRegistrationMarker: null,
  candidateRequestedAt: null,
  candidateRunStartedAt: null,
} as const;

export class PostgresBridgeCandidateRepository implements BridgeCandidateRepository {
  constructor(private readonly options: { db: Database; keyring: EncryptionKeyring }) {}

  loadCandidateContext = async (routeId: string): Promise<CandidateContext | null> => {
    const db = this.options.db;
    const [row] = await db
      .select({
        routeId: vpnBridgeRoutes.id,
        nodeId: vpnBridgeRoutes.nodeId,
        state: vpnBridgeRoutes.state,
        retiringSince: vpnBridgeRoutes.retiringSince,
        observedRegistrationMarker: vpnBridgeRoutes.observedRegistrationMarker,
        publicUdpPort: vpnBridgeRoutes.publicUdpPort,
        bridgePublicIpv4: vpnBridges.publicIpv4,
        nodePublicIp: nodes.publicIp,
        nodeEgressMode: nodes.egressMode,
        nodeEgressDefaultIpId: nodes.egressDefaultIpId,
        nodeGenerator: nodes.awgGenerator,
        nodeMtu: nodes.awgMtu,
      })
      .from(vpnBridgeRoutes)
      .innerJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .innerJoin(nodes, eq(nodes.id, vpnBridgeRoutes.nodeId))
      .where(eq(vpnBridgeRoutes.id, routeId))
      .limit(1);
    if (!row) return null;
    let nodePublicIp = row.nodePublicIp;
    if (row.nodeEgressMode === "routed" && row.nodeEgressDefaultIpId) {
      const [defaultExit] = await db
        .select({ ipv4: nodeEgressIps.ipv4 })
        .from(nodeEgressIps)
        .where(
          and(
            eq(nodeEgressIps.id, row.nodeEgressDefaultIpId),
            eq(nodeEgressIps.nodeId, row.nodeId),
          ),
        )
        .limit(1);
      if (defaultExit?.ipv4) {
        nodePublicIp = defaultExit.ipv4;
      }
    }
    // The node's AWG 3 default-exit service key (prefer endpointId IS NULL).
    const activeServiceKeys = await db
      .select({
        id: vpnKeys.id,
        endpointId: vpnKeys.endpointId,
        clientProfile: vpnKeys.awgClientProfile,
        ciphertext: vpnKeys.configCiphertext,
        nonce: vpnKeys.configNonce,
        authTag: vpnKeys.configAuthTag,
        keyVersion: vpnKeys.configKeyVersion,
      })
      .from(vpnKeys)
      .innerJoin(users, eq(users.id, vpnKeys.ownerId))
      .where(
        and(
          eq(users.serviceAccount, true),
          eq(vpnKeys.nodeId, row.nodeId),
          eq(vpnKeys.protocol, "awg3"),
          eq(vpnKeys.state, "active"),
        ),
      )
      .orderBy(desc(vpnKeys.createdAt));
    const key =
      activeServiceKeys.find((candidate) => candidate.endpointId === null) ??
      activeServiceKeys[0];
    const serviceConfig =
      key?.ciphertext && key.nonce && key.authTag && key.keyVersion !== null
        ? decryptSecret(
            {
              ciphertext: key.ciphertext,
              nonce: key.nonce,
              authTag: key.authTag,
              keyVersion: key.keyVersion,
            },
            this.options.keyring,
          )
        : null;
    return {
      routeId: row.routeId,
      nodeId: row.nodeId,
      state: row.state,
      retiringSince: row.retiringSince,
      observedRegistrationMarker: row.observedRegistrationMarker,
      publicUdpPort: row.publicUdpPort,
      bridgePublicIpv4: row.bridgePublicIpv4,
      nodePublicIp,
      nodeGenerator: row.nodeGenerator,
      nodeMtu: row.nodeMtu,
      serviceConfig,
      serviceKeyId: key?.id ?? null,
      serviceClientProfile: key?.clientProfile ?? null,
    };
  };

  claimCandidateRun = async (run: CandidateRun): Promise<boolean> => {
    // Only while the probe holds neither a regular run (in flight or not yet
    // ingested) nor another candidate.
    const claimed = await this.options.db
      .update(reachabilityProbe)
      .set({
        candidateRunId: run.runId,
        candidateRouteId: run.routeId,
        candidateRegistrationMarker: run.registrationMarker,
        candidateRequestedAt: run.requestedAt,
        candidateRunStartedAt: run.startedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(reachabilityProbe.id, 1),
          isNull(reachabilityProbe.currentRunId),
          isNull(reachabilityProbe.candidateRunId),
        ),
      )
      .returning({ id: reachabilityProbe.id });
    return claimed.length > 0;
  };

  releaseCandidateRun = async (runId: string): Promise<void> => {
    await this.options.db
      .update(reachabilityProbe)
      .set({ ...EMPTY_CANDIDATE_SLOT, updatedAt: new Date() })
      .where(and(eq(reachabilityProbe.id, 1), eq(reachabilityProbe.candidateRunId, runId)));
  };

  recordCandidateResult = async (write: CandidateResultWrite): Promise<boolean> =>
    writeCandidateVerification(this.options.db, write);
}
