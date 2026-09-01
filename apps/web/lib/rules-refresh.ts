/**
 * Adapter over the control-api's "check the RoscomVPN feeds now" job.
 *
 * The trigger is fixed: `POST /api/admin/rules/global/refresh` through the
 * generic admin action route. The STATUS read is deliberately isolated here —
 * if the backend folds the refresh state into another admin payload instead of
 * exposing its own route, only `readRulesRefreshState` below has to change.
 */

/** Path the refresh state is read from. */
const STATUS_PATH = "/api/admin/rules/refresh";

/**
 * Normalized lifecycle of the refresh job, independent of the wire wording.
 * "idle" means no manual check has ever been requested.
 */
export type RulesRefreshPhase =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type RulesRefreshState = {
  phase: RulesRefreshPhase;
  queuedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
};

/**
 * Wire status values mapped onto the four phases above. Both the job_outbox
 * wording (pending/processing/completed) and the plainer queued/running/
 * succeeded wording are accepted so the UI does not break on either choice.
 */
const PHASE_BY_STATUS: Record<string, RulesRefreshPhase> = {
  idle: "idle",
  pending: "queued",
  queued: "queued",
  scheduled: "queued",
  processing: "running",
  running: "running",
  in_progress: "running",
  completed: "succeeded",
  complete: "succeeded",
  succeeded: "succeeded",
  success: "succeeded",
  done: "succeeded",
  ok: "succeeded",
  failed: "failed",
  failure: "failed",
  error: "failed",
  dead: "failed",
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Parse the wire payload into the normalized state, or null if unusable. */
export const parseRulesRefreshState = (
  payload: unknown,
): RulesRefreshState | null => {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const status = asString(row.status);
  if (!status) return null;
  const phase = PHASE_BY_STATUS[status.toLowerCase()];
  if (!phase) return null;
  return {
    phase,
    queuedAt: asString(row.queuedAt) ?? asString(row.availableAt),
    completedAt: asString(row.completedAt) ?? asString(row.processedAt),
    lastError: asString(row.lastError) ?? asString(row.error),
  };
};

/**
 * Read the current refresh state. Returns null when the backend does not
 * expose it (yet) — callers must degrade gracefully rather than fail.
 */
export const readRulesRefreshState = async (
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<RulesRefreshState | null> => {
  try {
    return parseRulesRefreshState(await request<unknown>(STATUS_PATH));
  } catch {
    return null;
  }
};
