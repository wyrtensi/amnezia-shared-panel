import { and, eq, inArray } from "drizzle-orm";
import {
  BRIDGE_AGENT_POLL_JOB_TYPE,
  BRIDGE_AGENT_UPDATE_JOB_TYPE,
  BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES,
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  type BridgeRollbackPreflight,
} from "@amnezia/contracts";
import { jobOutbox, vpnBridgeAgentUpdates, vpnBridgeRoutes, type Database } from "@amnezia/db";

const BRIDGE_JOB_TYPES = [
  BRIDGE_AGENT_POLL_JOB_TYPE,
  BRIDGE_AGENT_UPDATE_JOB_TYPE,
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
];

/**
 * The rollback preflight: reads only, so it is safe to run at any time and as
 * often as needed. A release that predates bridges would keep serving a
 * bridge endpoint it cannot manage, and would fail jobs it does not know.
 */
export const readBridgeRollbackPreflight = async (
  db: Database,
  jobsEnabled: boolean,
): Promise<BridgeRollbackPreflight> => {
  const [active, updates, jobs] = await Promise.all([
    db
      .selectDistinct({ nodeId: vpnBridgeRoutes.nodeId })
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.state, "active")),
    db
      .selectDistinct({ bridgeId: vpnBridgeAgentUpdates.bridgeId })
      .from(vpnBridgeAgentUpdates)
      .where(inArray(vpnBridgeAgentUpdates.state, [...BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES])),
    db
      .select({ type: jobOutbox.type })
      .from(jobOutbox)
      .where(
        and(
          inArray(jobOutbox.type, BRIDGE_JOB_TYPES),
          inArray(jobOutbox.status, ["pending", "processing"]),
        ),
      ),
  ]);
  const nodeIds = active.map((row) => row.nodeId).sort();
  const bridgeIds = updates.map((row) => row.bridgeId).sort();
  const byType: Record<string, number> = {};
  for (const job of jobs) byType[job.type] = (byType[job.type] ?? 0) + 1;
  return {
    activeAssignments: { count: nodeIds.length, nodeIds },
    outstandingAgentUpdates: { count: bridgeIds.length, bridgeIds },
    pendingJobs: { count: jobs.length, byType },
    jobsEnabled,
    readyForPreBridgeRollback:
      nodeIds.length === 0 && bridgeIds.length === 0 && jobs.length === 0,
  };
};
