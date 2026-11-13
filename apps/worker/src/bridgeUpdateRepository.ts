import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES,
  type BridgeAgentUpdateState,
} from "@amnezia/contracts";
import { vpnBridgeAgentUpdates, type Database } from "@amnezia/db";

/** One stored update operation, as the job handler and the tracker need it. */
export type BridgeUpdateOperation = {
  id: string;
  bridgeId: string;
  imageRepository: string;
  imageDigest: string;
  state: BridgeAgentUpdateState;
  requestedAt: Date;
  sentAt: Date | null;
  acknowledgedAt: Date | null;
  contactLostSince: Date | null;
};

/** Fields one transition may change; `undefined` leaves a column alone. */
export type BridgeUpdateChange = {
  state?: BridgeAgentUpdateState;
  agentState?: string | null;
  sentAt?: Date;
  acknowledgedAt?: Date;
  lastCheckedAt?: Date;
  contactLostSince?: Date | null;
  errorCode?: string | null;
  finishedAt?: Date | null;
};

export interface BridgeUpdateRepository {
  loadOperation: (operationId: string) => Promise<BridgeUpdateOperation | null>;
  /**
   * The operation the poller follows for a bridge: its outstanding one past
   * delivery (sent, acknowledged, running) or, when none is outstanding, its
   * latest `pickup_timeout` one that is not older than `lateWindowMs`. A late
   * acknowledgement can still move that one forward.
   */
  loadTracked: (bridgeId: string, now: Date, lateWindowMs: number) => Promise<BridgeUpdateOperation | null>;
  /**
   * Apply a transition. Only an operation that still holds the bridge's
   * outstanding slot changes; a `pickup_timeout` one changes only when
   * `fromPickupTimeout` is set and no other operation is outstanding. A
   * finished operation is never rewritten. Returns whether a row changed.
   */
  recordChange: (
    operationId: string,
    change: BridgeUpdateChange,
    options?: { fromPickupTimeout?: boolean },
  ) => Promise<boolean>;
}

const rowOf = (row: typeof vpnBridgeAgentUpdates.$inferSelect): BridgeUpdateOperation => ({
  id: row.id,
  bridgeId: row.bridgeId,
  imageRepository: row.imageRepository,
  imageDigest: row.imageDigest,
  state: row.state,
  requestedAt: row.requestedAt,
  sentAt: row.sentAt,
  acknowledgedAt: row.acknowledgedAt,
  contactLostSince: row.contactLostSince,
});

const OUTSTANDING = [...BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES];
const TRACKED_OUTSTANDING: BridgeAgentUpdateState[] = ["sent", "acknowledged", "running"];

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

  loadTracked = async (
    bridgeId: string,
    now: Date,
    lateWindowMs: number,
  ): Promise<BridgeUpdateOperation | null> => {
    const db = this.options.db;
    const [outstanding] = await db
      .select()
      .from(vpnBridgeAgentUpdates)
      .where(
        and(
          eq(vpnBridgeAgentUpdates.bridgeId, bridgeId),
          inArray(vpnBridgeAgentUpdates.state, OUTSTANDING),
        ),
      )
      .limit(1);
    if (outstanding) {
      // `queued` is still the send job's: it delivers and retries on its own.
      return TRACKED_OUTSTANDING.includes(outstanding.state) ? rowOf(outstanding) : null;
    }
    const [latest] = await db
      .select()
      .from(vpnBridgeAgentUpdates)
      .where(
        and(
          eq(vpnBridgeAgentUpdates.bridgeId, bridgeId),
          gt(vpnBridgeAgentUpdates.requestedAt, new Date(now.getTime() - lateWindowMs)),
        ),
      )
      .orderBy(desc(vpnBridgeAgentUpdates.requestedAt))
      .limit(1);
    return latest?.state === "pickup_timeout" ? rowOf(latest) : null;
  };

  recordChange = async (
    operationId: string,
    change: BridgeUpdateChange,
    { fromPickupTimeout = false }: { fromPickupTimeout?: boolean } = {},
  ): Promise<boolean> => {
    const table = vpnBridgeAgentUpdates;
    const holdsSlot = inArray(table.state, OUTSTANDING);
    const guard = fromPickupTimeout
      ? and(
          eq(table.state, "pickup_timeout"),
          sql`not exists (select 1 from vpn_bridge_agent_updates other
            where other.bridge_id = ${table.bridgeId}
              and other.state in ('queued', 'sent', 'acknowledged', 'running'))`,
        )
      : holdsSlot;
    try {
      const rows = await this.options.db
        .update(table)
        .set({ ...change, updatedAt: new Date() })
        .where(and(eq(table.id, operationId), guard))
        .returning({ id: table.id });
      return rows.length > 0;
    } catch (error) {
      // A request for the same bridge slipped in between the guard and the
      // write: the outstanding index refuses it, and the late result is dropped.
      if (fromPickupTimeout && pgCodeOf(error) === "23505") return false;
      throw error;
    }
  };
}

const pgCodeOf = (error: unknown): string | null => {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};
