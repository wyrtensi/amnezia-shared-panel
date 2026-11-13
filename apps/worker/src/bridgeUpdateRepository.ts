import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES,
  type BridgeAgentUpdateState,
} from "@amnezia/contracts";
import { jobOutbox, vpnBridgeAgentUpdates, type Database } from "@amnezia/db";

/** One stored update operation, as the job handler and the tracker need it. */
export type BridgeUpdateOperation = {
  id: string;
  bridgeId: string;
  imageRepository: string;
  imageDigest: string;
  state: BridgeAgentUpdateState;
  requestedAt: Date;
  /** The pickup deadline sent with the intent. */
  notAfter: Date;
  /** Set once a POST was attempted, whatever it returned. */
  sendAttemptedAt: Date | null;
  sentAt: Date | null;
  acknowledgedAt: Date | null;
  contactLostSince: Date | null;
  acknowledgementOverdueSince: Date | null;
};

/** Fields one transition may change; `undefined` leaves a column alone. */
export type BridgeUpdateChange = {
  state?: BridgeAgentUpdateState;
  agentState?: string | null;
  sendAttemptedAt?: Date;
  sentAt?: Date;
  acknowledgedAt?: Date;
  lastCheckedAt?: Date;
  contactLostSince?: Date | null;
  acknowledgementOverdueSince?: Date | null;
  errorCode?: string | null;
  finishedAt?: Date | null;
};

export interface BridgeUpdateRepository {
  loadOperation: (operationId: string) => Promise<BridgeUpdateOperation | null>;
  /** The bridge's outstanding operation (queued, sent, acknowledged, running). */
  loadOutstanding: (bridgeId: string) => Promise<BridgeUpdateOperation | null>;
  /**
   * Close a bridge's `queued` operations whose POST was never attempted, that
   * are past `notAfter`, and whose delivery job is no longer pending or
   * processing (it failed, was dropped or was completed by a worker that does
   * not know the job type). Nothing else would move them, and the agent never
   * saw them, so closing is safe: they become `failed UPDATE_NEVER_SENT`. An
   * operation whose POST was attempted is never closed here: only the agent
   * can say whether it arrived. Returns how many were closed.
   */
  expireNeverSent: (bridgeId: string, now: Date) => Promise<number>;
  /** Apply a transition. Only an operation that still holds the slot changes. */
  recordChange: (operationId: string, change: BridgeUpdateChange) => Promise<boolean>;
}

const rowOf = (row: typeof vpnBridgeAgentUpdates.$inferSelect): BridgeUpdateOperation => ({
  id: row.id,
  bridgeId: row.bridgeId,
  imageRepository: row.imageRepository,
  imageDigest: row.imageDigest,
  state: row.state,
  requestedAt: row.requestedAt,
  notAfter: row.notAfter,
  sendAttemptedAt: row.sendAttemptedAt,
  sentAt: row.sentAt,
  acknowledgedAt: row.acknowledgedAt,
  contactLostSince: row.contactLostSince,
  acknowledgementOverdueSince: row.acknowledgementOverdueSince,
});

const OUTSTANDING = [...BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES];

export class PostgresBridgeUpdateRepository implements BridgeUpdateRepository {
  constructor(private readonly options: { db: Database }) {}

  loadOperation = async (operationId: string): Promise<BridgeUpdateOperation | null> => {
    const [row] = await this.options.db
      .select()
      .from(vpnBridgeAgentUpdates)
      .where(eq(vpnBridgeAgentUpdates.id, operationId))
      .limit(1);
    return row ? rowOf(row) : null;
  };

  loadOutstanding = async (bridgeId: string): Promise<BridgeUpdateOperation | null> => {
    const [row] = await this.options.db
      .select()
      .from(vpnBridgeAgentUpdates)
      .where(
        and(
          eq(vpnBridgeAgentUpdates.bridgeId, bridgeId),
          inArray(vpnBridgeAgentUpdates.state, OUTSTANDING),
        ),
      )
      .limit(1);
    return row ? rowOf(row) : null;
  };

  expireNeverSent = async (bridgeId: string, now: Date): Promise<number> => {
    const table = vpnBridgeAgentUpdates;
    const rows = await this.options.db
      .update(table)
      .set({
        state: "failed",
        errorCode: "UPDATE_NEVER_SENT",
        finishedAt: now,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(table.bridgeId, bridgeId),
          eq(table.state, "queued"),
          sql`${table.sendAttemptedAt} is null`,
          lte(table.notAfter, now),
          sql`not exists (select 1 from ${jobOutbox}
            where ${jobOutbox.deduplicationKey} = 'bridge_agent.update:' || ${table.id}::text
              and ${jobOutbox.status} in ('pending', 'processing'))`,
        ),
      )
      .returning({ id: table.id });
    return rows.length;
  };

  recordChange = async (operationId: string, change: BridgeUpdateChange): Promise<boolean> => {
    const table = vpnBridgeAgentUpdates;
    const rows = await this.options.db
      .update(table)
      .set({ ...change, updatedAt: new Date() })
      .where(and(eq(table.id, operationId), inArray(table.state, OUTSTANDING)))
      .returning({ id: table.id });
    return rows.length > 0;
  };
}
