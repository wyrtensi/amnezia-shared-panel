import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import {
  decryptSecret,
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
): Promise<void> => {
  await executor
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
    );
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
        publicUdpPort: vpnBridgeRoutes.publicUdpPort,
        bridgePublicIpv4: vpnBridges.publicIpv4,
        nodePublicIp: nodes.publicIp,
      })
      .from(vpnBridgeRoutes)
      .innerJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .innerJoin(nodes, eq(nodes.id, vpnBridgeRoutes.nodeId))
      .where(eq(vpnBridgeRoutes.id, routeId))
      .limit(1);
    if (!row) return null;
    // The node's AWG 3 service key: the same peer the regular run measures.
    const [key] = await db
      .select({
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
      .orderBy(desc(vpnKeys.createdAt))
      .limit(1);
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
    return { ...row, serviceConfig };
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

  recordCandidateResult = async (write: CandidateResultWrite): Promise<void> => {
    await writeCandidateVerification(this.options.db, write);
  };
}
