import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  nodeReachabilityResults,
  nodeReachabilityState,
  nodeVpnEndpoints,
  reachabilityProbe,
} from "./schema.js";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What the node's verdict says between an endpoint change and its next run. */
export const ENDPOINT_CHANGED_DETAIL =
  "endpoint assignment changed; waiting for a measurement through the new endpoint";
export const GENERATOR_CHANGED_DETAIL =
  "client generator changed; waiting for a measurement with the new profile";

/**
 * Invalidate the reachability evidence that a node endpoint change (Direct or
 * a bridge route, `nodes.vpn_endpoint_revision` bumped) makes obsolete. The
 * caller holds the node row lock (`FOR NO KEY UPDATE`) in the same
 * transaction; the worker's ingest takes that row `FOR SHARE` before it
 * writes any result, so the two never interleave.
 *
 * - The AWG 3.1 result is deleted: it was measured through the previous
 *   endpoint. Missing evidence reads as unknown everywhere.
 * - Direct address evidence is cleared with the assignment change, so
 *   returning from a bridge cannot revive a result from the old direct path.
 * - The AWG 2 result is kept: AWG 2 always uses the direct path.
 * - The node verdict becomes `error` (unknown to users, never "blocked")
 *   until a run through the new endpoint is ingested. An open incident
 *   (`alertedAt`, `alertKind`) is kept, so it is closed by exactly one
 *   recovery message and never alerted twice. The failure streak
 *   (`consecutiveFailures`, `failingSince`) restarts: failures of the old
 *   path must not count towards an alert about the new one.
 * - History rows are kept: they describe what was true when measured.
 */
export const resetNodeEndpointEvidence = async (
  executor: Database | DbTransaction,
  nodeId: string,
  now: Date,
  options: { endpointIds?: readonly string[]; detail?: string } = {},
): Promise<void> => {
  await executor
    .delete(nodeReachabilityResults)
    .where(
      and(
        eq(nodeReachabilityResults.nodeId, nodeId),
        eq(nodeReachabilityResults.protocol, "awg3"),
      ),
    );
  await executor
    .update(nodeVpnEndpoints)
    .set({
      probeStatus: null,
      probeLevels: null,
      probeCheckedAt: null,
      probeConsecutiveFailures: 0,
      probeFailingSince: null,
      probeDetail: null,
    })
    .where(and(
      eq(nodeVpnEndpoints.nodeId, nodeId),
      options.endpointIds ? inArray(nodeVpnEndpoints.id, [...options.endpointIds]) : undefined,
    ));
  await executor
    .update(nodeReachabilityState)
    .set({
      status: "error",
      consecutiveFailures: 0,
      failingSince: null,
      checkedAt: now,
      detail: options.detail ?? ENDPOINT_CHANGED_DETAIL,
      directStatus: null,
      directCheckedAt: null,
      directDetail: null,
    })
    .where(eq(nodeReachabilityState.nodeId, nodeId));
};

/**
 * Queue a probe run after a committed change to what the probe measures, so
 * the worker starts it at its next tick (or right after a run in flight)
 * instead of at the next scheduled run.
 *
 * Call it only after the change has committed and with no row lock held: the
 * worker locks the probe row before node rows, so writing the probe row under
 * a node lock could deadlock. The wait for the probe row is bounded, since a
 * dispatch holds it across its request to the probe. False when the request
 * could not be written; the change stands and the scheduled run measures it.
 */
export const requestReachabilityRun = async (db: Database, now = new Date()): Promise<boolean> => {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx
        .update(reachabilityProbe)
        .set({ runRequestedAt: now, updatedAt: now })
        .where(and(eq(reachabilityProbe.id, 1), eq(reachabilityProbe.enabled, true)));
    });
    return true;
  } catch {
    return false;
  }
};
