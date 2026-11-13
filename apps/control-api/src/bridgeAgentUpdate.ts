import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  BRIDGE_AGENT_UPDATE_CAPABILITY,
  BRIDGE_AGENT_UPDATE_JOB_TYPE,
  BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES,
  bridgeAgentUpdateDeduplicationKey,
  type BridgeAgentOfferedImage,
  type BridgeAgentUpdateOperation,
  type BridgeAgentUpdatePayload,
  type BridgeAgentUpdateSummary,
  type BridgeAgentUpdateView,
  type RequestBridgeAgentUpdate,
  type RequestBridgeAgentUpdateResult,
} from "@amnezia/contracts";
import {
  auditEvents,
  jobOutbox,
  vpnBridgeAgentUpdates,
  vpnBridges,
  type Database,
} from "@amnezia/db";

import { assertBridgeJobsEnabled } from "./bridgeConfig.js";
import { ApiError, type Actor } from "./service.js";

type UpdateRow = typeof vpnBridgeAgentUpdates.$inferSelect;

const HISTORY_LIMIT = 10;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const bridgeNotFound = () => new ApiError(404, "Bridge not found", "BRIDGE_NOT_FOUND");

/** The stored operation as the API shows it: bounded fields only. */
export const toAgentUpdateOperation = (row: UpdateRow): BridgeAgentUpdateOperation => ({
  operationId: row.id,
  state: row.state,
  requestedDigest: row.imageDigest,
  requestedVersion: row.imageVersion,
  fromVersion: row.fromVersion,
  requestedAt: row.requestedAt.toISOString(),
  sentAt: iso(row.sentAt),
  acknowledgedAt: iso(row.acknowledgedAt),
  lastCheckedAt: iso(row.lastCheckedAt),
  contactLostSince: iso(row.contactLostSince),
  errorCode: row.errorCode,
  result: row.finishedAt
    ? { finishedAt: row.finishedAt.toISOString(), errorCode: row.errorCode }
    : null,
});

export const agentSupportsUpdate = (capabilities: readonly string[] | null): boolean =>
  capabilities?.includes(BRIDGE_AGENT_UPDATE_CAPABILITY) ?? false;

export type BridgeAgentUpdatesOptions = {
  db: Database;
  /** `VPN_BRIDGE_JOBS_ENABLED`. */
  jobsEnabled: boolean;
  /** The newest approved image of the configured repository, or null. */
  approvedRelease: () => Promise<BridgeAgentOfferedImage | null>;
};

/**
 * Admin-side bridge-agent updates: preview, request and inspect. The request
 * stores a stable operation id and queues one outbox job with it; the worker
 * delivers it to the agent and tracks it. One operation per bridge may be
 * outstanding (partial unique index), a repeat of the same request returns it.
 */
export class BridgeAgentUpdates {
  constructor(private readonly options: BridgeAgentUpdatesOptions) {}

  /**
   * Card data for a set of bridges: the offered image, whether the agent can
   * be updated and the outstanding or latest operation of each.
   */
  summaries = async (
    bridges: ReadonlyArray<{ id: string; agentCapabilities: string[] | null }>,
  ): Promise<Map<string, BridgeAgentUpdateSummary>> => {
    const result = new Map<string, BridgeAgentUpdateSummary>();
    if (bridges.length === 0) return result;
    const offered = await this.options.approvedRelease();
    const rows = await this.options.db
      .select()
      .from(vpnBridgeAgentUpdates)
      .where(
        inArray(
          vpnBridgeAgentUpdates.bridgeId,
          bridges.map((bridge) => bridge.id),
        ),
      )
      .orderBy(desc(vpnBridgeAgentUpdates.requestedAt));
    const latest = new Map<string, UpdateRow>();
    for (const row of rows) {
      // Newest first. A new operation is only created once none is
      // outstanding, so the newest one is the outstanding one when there is one.
      if (!latest.has(row.bridgeId)) latest.set(row.bridgeId, row);
    }
    for (const bridge of bridges) {
      const row = latest.get(bridge.id);
      result.set(bridge.id, {
        updateSupported: agentSupportsUpdate(bridge.agentCapabilities),
        offered,
        operation: row ? toAgentUpdateOperation(row) : null,
      });
    }
    return result;
  };

  /** `GET /api/admin/vpn-bridges/:id/agent-update`. */
  view = async (bridgeId: string): Promise<BridgeAgentUpdateView> => {
    const [bridge] = await this.options.db
      .select({
        id: vpnBridges.id,
        enrolledAt: vpnBridges.managementEnrolledAt,
        agentVersion: vpnBridges.agentVersion,
        agentCapabilities: vpnBridges.agentCapabilities,
      })
      .from(vpnBridges)
      .where(eq(vpnBridges.id, bridgeId))
      .limit(1);
    if (!bridge) throw bridgeNotFound();
    const [offered, rows] = await Promise.all([
      this.options.approvedRelease(),
      this.options.db
        .select()
        .from(vpnBridgeAgentUpdates)
        .where(eq(vpnBridgeAgentUpdates.bridgeId, bridgeId))
        .orderBy(desc(vpnBridgeAgentUpdates.requestedAt))
        .limit(HISTORY_LIMIT),
    ]);
    const operations = rows.map(toAgentUpdateOperation);
    return {
      bridgeId,
      enrolled: bridge.enrolledAt !== null,
      installedVersion: bridge.agentVersion,
      updateSupported: agentSupportsUpdate(bridge.agentCapabilities),
      jobsEnabled: this.options.jobsEnabled,
      offered: offered ? [offered] : [],
      operation: operations[0] ?? null,
      history: operations.slice(1),
    };
  };

  /**
   * `POST /api/admin/vpn-bridges/:id/agent-update`. Gated by
   * `VPN_BRIDGE_JOBS_ENABLED`. The digest must be exactly the offered one.
   * The bridge row is locked, so two requests serialize; the repeat of the
   * outstanding operation's digest returns that operation, any other digest
   * while one is outstanding is a 409.
   */
  request = async (
    actor: Actor,
    bridgeId: string,
    request: RequestBridgeAgentUpdate,
  ): Promise<RequestBridgeAgentUpdateResult> => {
    assertBridgeJobsEnabled({ jobsEnabled: this.options.jobsEnabled });
    const offered = await this.options.approvedRelease();
    return this.options.db.transaction(async (tx) => {
      const [bridge] = await tx
        .select({
          id: vpnBridges.id,
          enrolledAt: vpnBridges.managementEnrolledAt,
          agentVersion: vpnBridges.agentVersion,
          agentCapabilities: vpnBridges.agentCapabilities,
        })
        .from(vpnBridges)
        .where(eq(vpnBridges.id, bridgeId))
        .for("no key update");
      if (!bridge) throw bridgeNotFound();
      if (!bridge.enrolledAt) {
        throw new ApiError(
          409,
          "The bridge has no enrolled management endpoint; enroll the bridge-agent first",
          "BRIDGE_UPDATE_NOT_ENROLLED",
        );
      }
      const [outstanding] = await tx
        .select()
        .from(vpnBridgeAgentUpdates)
        .where(
          and(
            eq(vpnBridgeAgentUpdates.bridgeId, bridgeId),
            inArray(vpnBridgeAgentUpdates.state, [...BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES]),
          ),
        )
        .limit(1);
      if (outstanding) {
        if (outstanding.imageDigest === request.imageDigest) {
          return { created: false, operation: toAgentUpdateOperation(outstanding) };
        }
        throw new ApiError(
          409,
          "Another bridge-agent update is outstanding for this bridge; wait for it to finish",
          "BRIDGE_UPDATE_IN_PROGRESS",
        );
      }
      if (!offered || offered.digest !== request.imageDigest) {
        throw new ApiError(
          400,
          "The requested image is not one the panel offers for this bridge",
          "BRIDGE_UPDATE_NOT_OFFERED",
        );
      }
      if (!agentSupportsUpdate(bridge.agentCapabilities)) {
        throw new ApiError(
          409,
          `The bridge-agent does not report the ${BRIDGE_AGENT_UPDATE_CAPABILITY} capability; update it on the host`,
          "BRIDGE_UNSUPPORTED_CAPABILITY",
        );
      }
      const operationId = randomUUID();
      const [row] = await tx
        .insert(vpnBridgeAgentUpdates)
        .values({
          id: operationId,
          bridgeId,
          imageRepository: offered.repository,
          imageDigest: offered.digest,
          imageVersion: offered.version,
          fromVersion: bridge.agentVersion,
        })
        .returning();
      if (!row) throw new Error("Bridge agent update insert returned no row");
      const payload: BridgeAgentUpdatePayload = { bridgeId, operationId };
      await tx.insert(jobOutbox).values({
        type: BRIDGE_AGENT_UPDATE_JOB_TYPE,
        deduplicationKey: bridgeAgentUpdateDeduplicationKey(operationId),
        payload,
      });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_bridge.agent_update_requested",
        targetType: "vpn_bridge",
        targetId: bridgeId,
        metadata: {
          operationId,
          imageRepository: offered.repository,
          imageDigest: offered.digest,
          imageVersion: offered.version,
          fromVersion: bridge.agentVersion,
        },
      });
      return { created: true, operation: toAgentUpdateOperation(row) };
    });
  };
}
