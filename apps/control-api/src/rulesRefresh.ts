import {
  idleRulesRefreshStatus,
  type RulesRefreshStatus,
} from "@amnezia/contracts";

/** The `job_outbox` columns a refresh status is built from. */
export type RulesRefreshJobRow = {
  status: "pending" | "processing" | "completed" | "failed";
  payload: Record<string, unknown>;
  availableAt: Date;
  completedAt: Date | null;
  lastError: string | null;
};

/**
 * Map the single `rules.refresh` outbox row onto the API status. No row at all
 * means nobody has asked for a manual check yet ("idle").
 *
 * A completed run means the feeds were checked — a feed whose checksum still
 * matches the active version is a deliberate no-op, so "checked, nothing new"
 * reads as success here and must not be presented as a failure.
 */
export const toRulesRefreshStatus = (
  row: RulesRefreshJobRow | null | undefined,
): RulesRefreshStatus => {
  if (!row) return { ...idleRulesRefreshStatus };
  // The request time is carried in the payload rather than read off
  // `availableAt`, which a retry pushes into the future.
  const requestedAt = row.payload.requestedAt;
  return {
    status: row.status,
    queuedAt:
      typeof requestedAt === "string"
        ? requestedAt
        : row.availableAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
};
