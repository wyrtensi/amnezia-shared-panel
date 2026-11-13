import { asc, eq } from "drizzle-orm";
import type { BridgeAgentPollOutcome } from "@amnezia/contracts";

import type { Database } from "./client.js";
import { vpnBridgeRoutes, vpnBridges } from "./schema.js";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** One classified status read of a bridge-agent, ready to be stored. */
export type BridgePollWrite = {
  bridgeId: string;
  /**
   * `managementEnrolledAt` of the credential the agent was read with. A
   * re-enrollment in the meantime makes the result describe a credential
   * the bridge no longer uses, so it is discarded.
   */
  enrolledAt: Date;
  /**
   * Panel clock, taken before the request. It becomes the bridge's
   * `lastPollAttemptAt` and, for a full observation, `lastObservedAt` and
   * every route's `observedAt`: the observation is never stamped later than
   * the moment the agent could have seen it (never the agent's clock).
   */
  startedAt: Date;
  outcome: BridgeAgentPollOutcome;
};

export type BridgePollApplied = "written" | "discarded";

const CLEARED_VERIFICATION = {
  verificationMethod: null,
  verifiedRegistrationMarker: null,
  verifiedAt: null,
  verificationResult: null,
  verificationError: null,
} as const;

/**
 * Store one bridge-agent poll. The one implementation for both the worker's
 * poller and the Control API's first read at enrollment. Call it inside a
 * transaction.
 *
 * Locks: the bridge row (`FOR NO KEY UPDATE`), then its routes in id order
 * (`FOR UPDATE`). Never a node row. Route mutations in the Control API take
 * node -> bridge -> route, so the two orders agree on bridge -> route.
 *
 * Discarded (nothing written) when the bridge is gone, was re-enrolled since
 * the read (`enrolledAt`), or already holds a newer poll (`lastPollAttemptAt`
 * after `startedAt`, an out-of-order write).
 *
 * - `ok` with a reachable frps: the bridge summary, `lastObservedAt =
 *   startedAt`, and every route of the bridge stamped `observedAt =
 *   startedAt`. A route is online only when frps reports its proxy name AND
 *   its public port and the registration is online; its marker is stored
 *   then, null otherwise. A name match on another port is not online and
 *   sets `lastErrorCode = ROUTE_PORT_MISMATCH`. When the stored marker
 *   changes, a verification bound to another marker is cleared (a reconnect
 *   is a different registration); one bound to the new marker stays (an
 *   operator verification recorded before the first observation).
 * - `ok` with frps unreachable: the bridge summary and `lastObservedAt`
 *   only. The (empty) proxy list proves nothing, so no route is touched;
 *   their `observedAt` now predates the bridge's latest poll, which the
 *   activation and release guards read as Unknown.
 * - `down`, `identity_mismatch`, `unsupported`: status, error code and
 *   `lastPollAttemptAt` (plus the agent's self-reported version for
 *   `unsupported`). Route observations, route states, the active assignment
 *   and reservations are never changed; with the status no longer `ok` the
 *   guards read every route as Unknown.
 */
export const applyBridgePollResult = async (
  tx: DbTransaction,
  write: BridgePollWrite,
): Promise<BridgePollApplied> => {
  const [bridge] = await tx
    .select({
      id: vpnBridges.id,
      managementEnrolledAt: vpnBridges.managementEnrolledAt,
      lastPollAttemptAt: vpnBridges.lastPollAttemptAt,
    })
    .from(vpnBridges)
    .where(eq(vpnBridges.id, write.bridgeId))
    .for("no key update");
  if (
    !bridge ||
    bridge.managementEnrolledAt?.getTime() !== write.enrolledAt.getTime() ||
    (bridge.lastPollAttemptAt !== null &&
      bridge.lastPollAttemptAt.getTime() > write.startedAt.getTime())
  ) {
    return "discarded";
  }

  const { outcome, startedAt } = write;
  if (outcome.kind !== "ok") {
    await tx
      .update(vpnBridges)
      .set({
        managementStatus: outcome.kind,
        lastErrorCode: outcome.errorCode,
        lastPollAttemptAt: startedAt,
        ...(outcome.kind === "unsupported"
          ? { agentVersion: outcome.agentVersion, agentApiVersion: outcome.agentApiVersion }
          : {}),
      })
      .where(eq(vpnBridges.id, write.bridgeId));
    return "written";
  }

  const summary = {
    managementStatus: "ok" as const,
    agentVersion: outcome.agentVersion,
    agentApiVersion: outcome.agentApiVersion,
    frpsReachable: outcome.frpsReachable,
    frpsVersion: outcome.frpsVersion,
    lastObservedAt: startedAt,
    lastPollAttemptAt: startedAt,
  };
  if (!outcome.frpsReachable) {
    await tx
      .update(vpnBridges)
      .set({ ...summary, lastErrorCode: outcome.errorCode ?? "FRPS_UNREACHABLE" })
      .where(eq(vpnBridges.id, write.bridgeId));
    return "written";
  }

  const routes = await tx
    .select()
    .from(vpnBridgeRoutes)
    .where(eq(vpnBridgeRoutes.bridgeId, write.bridgeId))
    .orderBy(asc(vpnBridgeRoutes.id))
    .for("update");
  const byName = new Map(outcome.proxies.map((proxy) => [proxy.proxyId, proxy]));
  let portMismatch = false;
  for (const route of routes) {
    const proxy = byName.get(route.frpProxyName);
    if (proxy && proxy.remotePort !== null && proxy.remotePort !== route.publicUdpPort) {
      portMismatch = true;
    }
    const online =
      proxy !== undefined && proxy.online && proxy.remotePort === route.publicUdpPort;
    const marker = online && proxy ? proxy.registrationMarker : null;
    const markerChanged = marker !== route.observedRegistrationMarker;
    const verificationOutdated =
      markerChanged &&
      route.verifiedRegistrationMarker !== marker &&
      (route.verifiedAt !== null ||
        route.verificationResult !== null ||
        route.verificationMethod !== null);
    await tx
      .update(vpnBridgeRoutes)
      .set({
        observedOnline: online,
        observedRegistrationMarker: marker,
        observedAt: startedAt,
        ...(verificationOutdated ? { ...CLEARED_VERIFICATION, updatedAt: new Date() } : {}),
      })
      .where(eq(vpnBridgeRoutes.id, route.id));
  }
  await tx
    .update(vpnBridges)
    .set({
      ...summary,
      lastErrorCode: portMismatch ? "ROUTE_PORT_MISMATCH" : outcome.errorCode,
    })
    .where(eq(vpnBridges.id, write.bridgeId));
  return "written";
};
