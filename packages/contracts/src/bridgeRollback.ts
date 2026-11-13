import { z } from "zod";

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
  /** `VPN_BRIDGE_JOBS_ENABLED`; it must be off before rollback so no new job is queued. */
  jobsEnabled: z.boolean(),
  /** True when no active assignment, outstanding update or pending job remains. */
  readyForPreBridgeRollback: z.boolean(),
});
export type BridgeRollbackPreflight = z.infer<typeof bridgeRollbackPreflightSchema>;
