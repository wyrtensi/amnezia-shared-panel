import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { REACHABILITY_NOTIFY_JOB_TYPE, type BridgeAgentPollOutcome } from "@amnezia/contracts";

import { advanceBridgeIncident, EMPTY_BRIDGE_INCIDENT } from "./bridgeIncidents.js";
import type { Database } from "./client.js";
import { bridgeReachabilityState, jobOutbox, nodes, vpnBridgeRoutes, vpnBridges } from "./schema.js";

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
  timeZone?: string;
};

export type BridgePollApplied = "written" | "discarded";

export const BRIDGE_POLL_FAIL_THRESHOLD = 3;

export const CLEARED_BRIDGE_ROUTE_ALERT = {
  alertConsecutiveFailures: 0,
  alertFailingSince: null,
  alertedAt: null,
} as const;

const alertSince = (date: Date, timeZone = "UTC") =>
  `\nс ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone }).format(date)} ${timeZone}`;

const queuePollAlert = async (
  tx: DbTransaction,
  scope: "management" | "route",
  identity: string,
  openedAt: Date,
  direction: "down" | "up",
  text: string,
) => {
  await tx.insert(jobOutbox).values({
    type: REACHABILITY_NOTIFY_JOB_TYPE,
    deduplicationKey: `${REACHABILITY_NOTIFY_JOB_TYPE}:bridge-${scope}:${identity}:${openedAt.getTime()}:${direction}`,
    payload: { text },
  }).onConflictDoNothing();
};

const trackManagementIncident = async (
  tx: DbTransaction,
  bridge: Pick<typeof vpnBridges.$inferSelect, "id" | "name" | "publicIpv4" | "frpsEnabled">,
  { outcome, startedAt, timeZone }: BridgePollWrite,
) => {
  const [prior] = await tx.select().from(bridgeReachabilityState)
    .where(eq(bridgeReachabilityState.bridgeId, bridge.id));
  const previous = prior ? {
    consecutiveFailures: prior.mgmtConsecutiveFailures,
    failingSince: prior.mgmtFailingSince,
    alertedAt: prior.mgmtAlertedAt,
  } : EMPTY_BRIDGE_INCIDENT;
  const frpsExpected = bridge.frpsEnabled;
  const frpsDisabledMismatch =
    bridge.frpsEnabled && outcome.kind === "ok" && outcome.frpsEnabled === false;
  const frpsHealthy = !frpsExpected || (outcome.kind === "ok" && outcome.frpsReachable);
  const healthy = outcome.kind === "ok" && frpsHealthy;
  const detail = healthy
    ? null
    : frpsDisabledMismatch
      ? "FRPS_DISABLED_UNEXPECTEDLY"
      : (outcome.errorCode ?? "FRPS_UNREACHABLE");
  const status = healthy ? "ok" : "failed";
  const { state, notice } = advanceBridgeIncident(previous, status, startedAt, BRIDGE_POLL_FAIL_THRESHOLD);
  const values = {
    mgmtStatus: status,
    mgmtConsecutiveFailures: state.consecutiveFailures,
    mgmtFailingSince: state.failingSince,
    mgmtAlertedAt: state.alertedAt,
    mgmtAlertDetail: detail,
  } as const;
  await tx.insert(bridgeReachabilityState).values({ bridgeId: bridge.id, ...values })
    .onConflictDoUpdate({ target: bridgeReachabilityState.bridgeId, set: values });
  if (notice) {
    const label = `Мост ${bridge.name} (${bridge.publicIpv4})`;
    await queuePollAlert(tx, "management", bridge.id, previous.alertedAt ?? startedAt, notice,
      notice === "down"
        ? `${label}: ${outcome.kind === "ok" ? "FRP-сервер" : "агент управления"} недоступен (${detail})` +
          alertSince(state.failingSince ?? startedAt, timeZone)
        : frpsExpected
          ? `${label}: агент управления и FRP-сервер доступны`
          : `${label}: агент управления доступен`);
  }
};

const trackRouteIncident = async (
  tx: DbTransaction,
  bridge: Pick<typeof vpnBridges.$inferSelect, "id" | "name" | "publicIpv4">,
  route: typeof vpnBridgeRoutes.$inferSelect,
  online: boolean,
  at: Date,
  timeZone?: string,
) => {
  const { state, notice } = advanceBridgeIncident({
    consecutiveFailures: route.alertConsecutiveFailures,
    failingSince: route.alertFailingSince,
    alertedAt: route.alertedAt,
  }, online ? "ok" : "failed", at, BRIDGE_POLL_FAIL_THRESHOLD);
  if (notice) {
    const [node] = await tx.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, route.nodeId));
    const label = `Маршрут ${node?.name ?? route.nodeId} → мост ${bridge.name} (${bridge.publicIpv4}:${route.publicUdpPort})`;
    const transportDownText =
      route.transport === "wytunnel"
        ? "wytunnel не подключён к мосту"
        : "frpc не подключён к мосту";
    await queuePollAlert(tx, "route", `${bridge.id}:${route.id}`, route.alertedAt ?? at, notice,
      notice === "down"
        ? `${label} недоступен: ${transportDownText}` + alertSince(state.failingSince ?? at, timeZone)
        : `${label} восстановлен`);
  }
  return {
    alertConsecutiveFailures: state.consecutiveFailures,
    alertFailingSince: state.failingSince,
    alertedAt: state.alertedAt,
  };
};

const interruptPendingRouteStreak = (
  tx: DbTransaction,
  bridgeId: string,
  routeId?: string,
) => tx.update(vpnBridgeRoutes).set(CLEARED_BRIDGE_ROUTE_ALERT).where(and(
  eq(vpnBridgeRoutes.bridgeId, bridgeId),
  eq(vpnBridgeRoutes.state, "active"),
  isNull(vpnBridgeRoutes.alertedAt),
  gt(vpnBridgeRoutes.alertConsecutiveFailures, 0),
  routeId ? eq(vpnBridgeRoutes.id, routeId) : undefined,
));

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
 * at or after `startedAt`, a duplicate or out-of-order write).
 *
 * - `ok` with a reachable frps: the bridge summary, `lastObservedAt =
 *   startedAt`, and every route of the bridge stamped `observedAt =
 *   startedAt`. A route is online only when frps reports its proxy name AND
 *   its public port and the registration is online; its marker is stored
 *   then, null otherwise. A name match on another port is not online and
 *   sets `lastErrorCode = ROUTE_PORT_MISMATCH`. When the stored marker
 *   changes, a verification bound to another marker is cleared (a reconnect
 *   is a different registration); one bound to the new marker stays (an
 *   operator verification recorded before the first observation). A route
 *   whose own proxy entry was reported but unreadable is not touched (Unknown,
 *   never offline); unreadable foreign entries are simply dropped
 *   (`lastErrorCode = PROXY_ENTRY_INVALID` unless a port mismatch is found).
 * - `ok` with frps unreachable: the bridge summary and `lastObservedAt`
 *   are updated. The (empty) proxy list proves nothing about routes;
 *   their `observedAt` now predates the bridge's latest poll, which the
 *   activation and release guards read as Unknown.
 * - `down`, `identity_mismatch`, `unsupported`: status, error code and
 *   `lastPollAttemptAt` (plus the agent's self-reported version for
 *   `unsupported`). These outcomes interrupt unconfirmed FRP alert streaks.
 *   Route observations, route states, the active assignment
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
      name: vpnBridges.name,
      publicIpv4: vpnBridges.publicIpv4,
      frpsEnabled: vpnBridges.frpsEnabled,
      reachabilityEnabled: vpnBridges.reachabilityEnabled,
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
      bridge.lastPollAttemptAt.getTime() >= write.startedAt.getTime())
  ) {
    return "discarded";
  }

  const { outcome, startedAt, timeZone } = write;
  if (bridge.reachabilityEnabled) await trackManagementIncident(tx, bridge, write);
  if (outcome.kind !== "ok") {
    // An unknown observation interrupts pending failures. An open incident
    // still needs a confirmed online registration to recover.
    await interruptPendingRouteStreak(tx, write.bridgeId);
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

  const frpsDisabledMismatch = bridge.frpsEnabled && outcome.frpsEnabled === false;
  const summary = {
    managementStatus: "ok" as const,
    agentVersion: outcome.agentVersion,
    agentApiVersion: outcome.agentApiVersion,
    frpsReachable: outcome.frpsReachable,
    frpsVersion: outcome.frpsVersion,
    metrics: {
      host: outcome.hostMetrics,
      trafficToday: outcome.trafficToday,
      agentLatencyMs: outcome.agentLatencyMs,
      frpsTls: outcome.frpsTls,
    },
    lastObservedAt: startedAt,
    lastPollAttemptAt: startedAt,
  };

  const routes = await tx
    .select()
    .from(vpnBridgeRoutes)
    .where(eq(vpnBridgeRoutes.bridgeId, write.bridgeId))
    .orderBy(asc(vpnBridgeRoutes.id))
    .for("update");
  const byName = new Map(outcome.proxies.map((proxy) => [proxy.proxyId, proxy]));
  const unreadable = new Set(outcome.unreadableProxyIds);
  const unreadableWytunnel = new Set(outcome.unreadableWytunnelRouteIds ?? []);
  const wytunnelByRoute =
    outcome.wytunnelInstances !== undefined
      ? new Map(outcome.wytunnelInstances.map((inst) => [inst.routeId, inst]))
      : null;
  let portMismatch = false;
  for (const route of routes) {
    if (route.transport === "wytunnel") {
      // An older bridge-agent without wytunnel.v1 (or missing /run/amnezia-wytunnel)
      // omits `wytunnel`, and malformed entries appear in unreadableWytunnel; leave
      // observedAt behind the bridge poll so routes read Unknown instead of offline.
      if (wytunnelByRoute === null || unreadableWytunnel.has(route.id)) {
        await interruptPendingRouteStreak(tx, write.bridgeId, route.id);
        continue;
      }
      const inst = wytunnelByRoute.get(route.id);
      if (inst && inst.remotePort !== null && inst.remotePort !== undefined && inst.remotePort !== route.publicUdpPort) {
        portMismatch = true;
      }
      const online =
        inst !== undefined && inst.online && inst.remotePort === route.publicUdpPort;
      const marker = online && inst ? inst.registrationMarker : null;
      const telemetry = inst?.telemetry ?? null;
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
          observedTelemetry: telemetry,
          ...(route.state === "active" && bridge.reachabilityEnabled
            ? await trackRouteIncident(tx, bridge, route, online, startedAt, timeZone)
            : CLEARED_BRIDGE_ROUTE_ALERT),
          ...(verificationOutdated ? { ...CLEARED_VERIFICATION, updatedAt: new Date() } : {}),
        })
        .where(eq(vpnBridgeRoutes.id, route.id));
      continue;
    }

    if (!outcome.frpsReachable) {
      if (outcome.frpsEnabled === false) {
        // frps is intentionally disabled on this bridge host, so any remaining
        // frp_tcp route is definitively offline (allowing retiring routes to be released).
        const verificationOutdated =
          route.observedRegistrationMarker !== null &&
          (route.verifiedAt !== null ||
            route.verificationResult !== null ||
            route.verificationMethod !== null);
        await tx
          .update(vpnBridgeRoutes)
          .set({
            observedOnline: false,
            observedRegistrationMarker: null,
            observedAt: startedAt,
            observedTelemetry: null,
            ...(route.state === "active" && bridge.reachabilityEnabled
              ? await trackRouteIncident(tx, bridge, route, false, startedAt, timeZone)
              : CLEARED_BRIDGE_ROUTE_ALERT),
            ...(verificationOutdated ? { ...CLEARED_VERIFICATION, updatedAt: new Date() } : {}),
          })
          .where(eq(vpnBridgeRoutes.id, route.id));
      } else {
        await interruptPendingRouteStreak(tx, write.bridgeId, route.id);
      }
      continue;
    }

    // The agent reported an entry under this route's name that could not be
    // read: this poll says nothing about the route. Left as it was, its
    // `observedAt` predates the bridge's latest poll, so it reads Unknown.
    if (unreadable.has(route.frpProxyName)) {
      await interruptPendingRouteStreak(tx, write.bridgeId, route.id);
      continue;
    }
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
        observedTelemetry: null,
        ...(route.state === "active" && bridge.reachabilityEnabled
          ? await trackRouteIncident(tx, bridge, route, online, startedAt, timeZone)
          : CLEARED_BRIDGE_ROUTE_ALERT),
        ...(verificationOutdated ? { ...CLEARED_VERIFICATION, updatedAt: new Date() } : {}),
      })
      .where(eq(vpnBridgeRoutes.id, route.id));
  }
  const lastErrorCode =
    frpsDisabledMismatch
      ? "FRPS_DISABLED_UNEXPECTEDLY"
      : bridge.frpsEnabled && !outcome.frpsReachable
        ? (outcome.errorCode ?? "FRPS_UNREACHABLE")
        : portMismatch
          ? "ROUTE_PORT_MISMATCH"
          : outcome.errorCode;
  await tx
    .update(vpnBridges)
    .set({
      ...summary,
      lastErrorCode,
    })
    .where(eq(vpnBridges.id, write.bridgeId));
  return "written";
};
