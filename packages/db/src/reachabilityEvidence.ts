import { and, eq } from "drizzle-orm";

import type { Database } from "./client.js";
import { nodeReachabilityResults, nodeReachabilityState } from "./schema.js";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What the node's verdict says between an endpoint change and its next run. */
export const ENDPOINT_CHANGED_DETAIL =
  "endpoint assignment changed; waiting for a measurement through the new endpoint";

/**
 * Invalidate the reachability evidence that a node endpoint change (Direct or
 * a bridge route, `nodes.vpn_endpoint_revision` bumped) makes obsolete. The
 * caller holds the node row lock (`FOR NO KEY UPDATE`) in the same
 * transaction; the worker's ingest takes that row `FOR SHARE` before it
 * writes any result, so the two never interleave.
 *
 * - The AWG 3.1 result is deleted: it was measured through the previous
 *   endpoint. Missing evidence reads as unknown everywhere.
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
    .update(nodeReachabilityState)
    .set({
      status: "error",
      consecutiveFailures: 0,
      failingSince: null,
      checkedAt: now,
      detail: ENDPOINT_CHANGED_DETAIL,
    })
    .where(eq(nodeReachabilityState.nodeId, nodeId));
};
