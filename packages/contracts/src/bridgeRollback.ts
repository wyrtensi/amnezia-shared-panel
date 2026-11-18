import { z } from "zod";

export const BRIDGE_ROLLBACK_BLOCKING_REASONS = [
  "BRIDGE_JOBS_ENABLED",
  "ACTIVE_ASSIGNMENTS",
  "OUTSTANDING_AGENT_UPDATES",
  "PENDING_BRIDGE_JOBS",
] as const;
export type BridgeRollbackBlockingReason = (typeof BRIDGE_ROLLBACK_BLOCKING_REASONS)[number];

/**
 * `GET /api/admin/vpn-bridges/rollback-preflight`: what must be true before the
 * panel is rolled back to a release that predates bridges. Read-only and
 * secret-free (ids and counts only).
 */
export const bridgeRollbackPreflightSchema = z.object({
  /** Nodes whose active endpoint is a bridge route; they must be back on Direct. */
  activeAssignments: z.object({
    count: z.number().int().nonnegative(),
    nodeIds: z.array(z.uuid()),
  }),
  /** Bridge-agent update operations still queued, sent, acknowledged or running. */
  outstandingAgentUpdates: z.object({
    count: z.number().int().nonnegative(),
    bridgeIds: z.array(z.uuid()),
  }),
  /**
   * Bridge jobs still pending or processing in the outbox (agent poll, agent
   * update, route candidate check), counted per job type.
   */
  pendingJobs: z.object({
    count: z.number().int().nonnegative(),
    byType: z.record(z.string(), z.number().int().positive()),
  }),
  /** `VPN_BRIDGE_JOBS_ENABLED` as the control-api reads it (the worker has its own copy). */
  jobsEnabled: z.boolean(),
  /**
   * True only when the gate is off and no active assignment, outstanding
   * update or pending bridge job remains. Failed jobs do not count.
   */
  readyForPreBridgeRollback: z.boolean(),
  /** Why it is not ready: bounded codes, empty exactly when ready. */
  blockingReasons: z.array(z.enum(BRIDGE_ROLLBACK_BLOCKING_REASONS)),
});
export type BridgeRollbackPreflight = z.infer<typeof bridgeRollbackPreflightSchema>;
