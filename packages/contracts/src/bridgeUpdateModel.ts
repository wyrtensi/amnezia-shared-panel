import { z } from "zod";

/**
 * The panel-facing model of a bridge-agent update operation: its states, the
 * stored shape and the Control API payloads. No dependency on the agent wire
 * contract (`bridgeAgentUpdate.ts`), so `bridges.ts` can embed the summary.
 */

/**
 * Acknowledgement deadline: `notAfter = requestedAt + this`. It travels in the
 * request, and the agent and the host updater refuse to start an intent after
 * it. A reachable agent that still reports `queued` past it keeps the
 * operation outstanding with the observation `acknowledgementOverdueSince`
 * (never freed, never retried). `pickup_timeout` is recorded only when the
 * agent confirms the intent `expired` unstarted. Task 8b reuses this deadline
 * and these names for the panel's own updater.
 */
export const BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS = 120_000;

/** A full image digest, as the agent and the host updater validate it. */
export const bridgeAgentImageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected a full sha256 image digest");

/**
 * The panel's lifecycle of one operation:
 * `queued` (stored, not yet delivered) -> `sent` (the agent accepted it, no
 * host pickup yet) -> `acknowledged` (the host updater picked it up) ->
 * `running` (staging, replacing or health gate) -> one terminal outcome.
 * `pickup_timeout` is terminal and means the agent confirmed the intent
 * `expired` without the host having started it, so applying it later is
 * impossible; it is never retried automatically and the administrator may
 * request again. An operation holds its slot until a reachable agent confirms
 * a terminal state, `expired`, or that it does not know the operation. Lost
 * management contact and an overdue acknowledgement are observations
 * (`contactLostSince`, `acknowledgementOverdueSince`), not states.
 */
export const BRIDGE_AGENT_UPDATE_STATES = [
  "queued",
  "sent",
  "acknowledged",
  "running",
  "succeeded",
  "rolled_back",
  "rollback_failed",
  "failed",
  "pickup_timeout",
] as const;
export type BridgeAgentUpdateState = (typeof BRIDGE_AGENT_UPDATE_STATES)[number];
export const bridgeAgentUpdateStateSchema = z.enum(BRIDGE_AGENT_UPDATE_STATES);

/** States that hold the bridge's single outstanding-operation slot. */
export const BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES = [
  "queued",
  "sent",
  "acknowledged",
  "running",
] as const satisfies readonly BridgeAgentUpdateState[];

export const isBridgeAgentUpdateOutstanding = (state: BridgeAgentUpdateState): boolean =>
  (BRIDGE_AGENT_UPDATE_OUTSTANDING_STATES as readonly string[]).includes(state);

/** What the agent reports for an operation, from the host's own state. */
export const BRIDGE_AGENT_UPDATE_AGENT_STATES = [
  "queued",
  "picked_up",
  "staging",
  "replacing",
  "health_check",
  "succeeded",
  "rolled_back",
  "rollback_failed",
  "failed",
  // The agent will never start the intent: `notAfter` passed unstarted.
  "expired",
] as const;
export type BridgeAgentUpdateAgentState = (typeof BRIDGE_AGENT_UPDATE_AGENT_STATES)[number];

/** The panel state an agent state stands for. */
export const bridgeAgentUpdateStateOf = (
  agentState: BridgeAgentUpdateAgentState,
): BridgeAgentUpdateState => {
  switch (agentState) {
    case "queued":
      return "sent";
    case "picked_up":
      return "acknowledged";
    case "staging":
    case "replacing":
    case "health_check":
      return "running";
    case "succeeded":
    case "rolled_back":
    case "rollback_failed":
    case "failed":
      return agentState;
    case "expired":
      return "pickup_timeout";
  }
};

/** Progress order of the non-terminal states; a state never moves backwards. */
export const bridgeAgentUpdateProgress = (state: BridgeAgentUpdateState): number => {
  switch (state) {
    case "queued":
      return 0;
    case "sent":
      return 1;
    case "acknowledged":
      return 2;
    case "running":
      return 3;
    default:
      return 4;
  }
};

/**
 * Bounded codes the panel stores for its own findings on an operation. The
 * agent's own codes are stored as reported, after `bridgeAgentErrorCodeSchema`
 * bounded their format.
 */
export const BRIDGE_AGENT_UPDATE_ERRORS = [
  "BRIDGE_JOBS_DISABLED",
  "AGENT_UPDATE_UNSUPPORTED",
  "UPDATE_UNKNOWN_TO_AGENT",
  "UPDATE_NEVER_SENT",
  "AGENT_UPDATE_REJECTED",
  "AGENT_UPDATE_CONFLICT",
  "AGENT_OPERATION_MISMATCH",
  "AGENT_OPERATION_UNKNOWN",
  "AGENT_UNREACHABLE",
  "AGENT_TIMEOUT",
  "AGENT_UNAUTHORIZED",
  "AGENT_HTTP_ERROR",
  "AGENT_MALFORMED_RESPONSE",
  "AGENT_API_UNSUPPORTED",
  "AGENT_IDENTITY_MISMATCH",
  "AGENT_URL_NOT_ALLOWED",
  "AGENT_CREDENTIAL_UNREADABLE",
  "UPDATE_NOT_ACKNOWLEDGED",
] as const;
export type BridgeAgentUpdateError = (typeof BRIDGE_AGENT_UPDATE_ERRORS)[number];

/** `POST /api/admin/vpn-bridges/:id/agent-update` body. */
export const requestBridgeAgentUpdateSchema = z.object({
  imageDigest: bridgeAgentImageDigestSchema,
});
export type RequestBridgeAgentUpdate = z.infer<typeof requestBridgeAgentUpdateSchema>;

/** One approved image the panel offers (resolved by the worker, never a tag). */
export const bridgeAgentOfferedImageSchema = z.object({
  /** `<approved repository>@sha256:<digest>`. */
  image: z.string(),
  repository: z.string(),
  version: z.string(),
  digest: bridgeAgentImageDigestSchema,
});
export type BridgeAgentOfferedImage = z.infer<typeof bridgeAgentOfferedImageSchema>;

/** The sanitized outcome of a finished operation: a bounded code, never text. */
export const bridgeAgentUpdateResultSchema = z.object({
  finishedAt: z.iso.datetime(),
  errorCode: z.string().max(80).nullable(),
});

export const bridgeAgentUpdateOperationSchema = z.object({
  operationId: z.uuid(),
  state: bridgeAgentUpdateStateSchema,
  requestedDigest: bridgeAgentImageDigestSchema,
  requestedVersion: z.string().nullable(),
  /** The agent version installed when the update was requested. */
  fromVersion: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  /** The panel's pickup deadline sent with the intent. */
  notAfter: z.iso.datetime(),
  /**
   * Observation: a reachable agent still reports the request unstarted past
   * `notAfter`. The operation stays outstanding; it is never retried.
   */
  acknowledgementOverdueSince: z.iso.datetime().nullable(),
  /**
   * Set while the management endpoint has been unreachable since the host
   * started the update: an observation, not a terminal state.
   */
  contactLostSince: z.iso.datetime().nullable(),
  /** The last bounded code seen for the operation, also while it is outstanding. */
  errorCode: z.string().max(80).nullable(),
  result: bridgeAgentUpdateResultSchema.nullable(),
});
export type BridgeAgentUpdateOperation = z.infer<typeof bridgeAgentUpdateOperationSchema>;

/**
 * What a bridge card needs about its agent update (`Bridge.agentUpdate`):
 * the single offered image (null when none), whether the agent can be
 * updated by the panel, and the outstanding or latest operation.
 */
export const bridgeAgentUpdateSummarySchema = z.object({
  updateSupported: z.boolean(),
  offered: bridgeAgentOfferedImageSchema.nullable(),
  operation: bridgeAgentUpdateOperationSchema.nullable(),
});
export type BridgeAgentUpdateSummary = z.infer<typeof bridgeAgentUpdateSummarySchema>;

/** `GET /api/admin/vpn-bridges/:id/agent-update`. */
export const bridgeAgentUpdateViewSchema = z.object({
  bridgeId: z.uuid(),
  enrolled: z.boolean(),
  installedVersion: z.string().nullable(),
  /** Whether the agent's last reported capabilities include `update.v1`. */
  updateSupported: z.boolean(),
  /** `VPN_BRIDGE_JOBS_ENABLED`: a request is refused while it is false. */
  jobsEnabled: z.boolean(),
  offered: z.array(bridgeAgentOfferedImageSchema),
  /** The outstanding operation, else the latest one. */
  operation: bridgeAgentUpdateOperationSchema.nullable(),
  /** Earlier operations, newest first (at most nine). */
  history: z.array(bridgeAgentUpdateOperationSchema),
});
export type BridgeAgentUpdateView = z.infer<typeof bridgeAgentUpdateViewSchema>;

/** `POST /api/admin/vpn-bridges/:id/agent-update`: 202 created, 200 replay. */
export const requestBridgeAgentUpdateResultSchema = z.object({
  created: z.boolean(),
  operation: bridgeAgentUpdateOperationSchema,
});
export type RequestBridgeAgentUpdateResult = z.infer<
  typeof requestBridgeAgentUpdateResultSchema
>;
