import { z } from "zod";

import {
  bridgeAgentErrorCodeSchema,
  requestBridgeAgent,
  type BridgeAgentRequestOptions,
} from "./bridgeAgent.js";
import {
  BRIDGE_AGENT_UPDATE_AGENT_STATES,
  bridgeAgentImageDigestSchema,
  type BridgeAgentUpdateError,
} from "./bridgeUpdateModel.js";

/**
 * Independent bridge-agent updates: the contract shared by the Control API,
 * the worker and the agent's `POST/GET /v1/update` (services/bridge-agent).
 * The panel only ever sends an intent (`operationId`, approved repository,
 * full digest, `notAfter`); the host's systemd updater
 * (infra/bridge/bridge-agent-update.sh) validates it again and owns Docker.
 */

/** The capability an agent reports once it implements `/v1/update`. */
export const BRIDGE_AGENT_UPDATE_CAPABILITY = "update.v1";

/** Outbox job type of one queued update intent. */
export const BRIDGE_AGENT_UPDATE_JOB_TYPE = "bridge_agent.update";
/** Stable per operation: the same operation can never be queued twice. */
export const bridgeAgentUpdateDeduplicationKey = (operationId: string): string =>
  `${BRIDGE_AGENT_UPDATE_JOB_TYPE}:${operationId}`;
export const bridgeAgentUpdatePayloadSchema = z.object({
  bridgeId: z.uuid(),
  operationId: z.uuid(),
});
export type BridgeAgentUpdatePayload = z.infer<typeof bridgeAgentUpdatePayloadSchema>;

// --- The agent's wire contract (`/v1/update`) --------------------------------

/** `POST /v1/update` body. */
export const bridgeAgentUpdateRequestSchema = z.object({
  operationId: z.uuid(),
  imageRepository: z.string().min(1).max(255),
  imageDigest: bridgeAgentImageDigestSchema,
  /**
   * The panel's pickup deadline (ISO). The agent and the host updater refuse
   * to start the intent after it; a never-started operation then reads
   * `expired`.
   */
  notAfter: z.iso.datetime(),
});
export type BridgeAgentUpdateRequest = z.infer<typeof bridgeAgentUpdateRequestSchema>;

/** Response of `POST /v1/update` (202 or a replay's 200) and `GET /v1/update`. */
export const bridgeAgentUpdateStatusSchema = z.object({
  operationId: z.uuid(),
  state: z.enum(BRIDGE_AGENT_UPDATE_AGENT_STATES),
  updatedAt: z.string().max(64),
  errorCode: bridgeAgentErrorCodeSchema.optional(),
});
export type BridgeAgentUpdateStatus = z.infer<typeof bridgeAgentUpdateStatusSchema>;

// --- The client ------------------------------------------------------------------

/** What `POST /v1/update` answered, classified. */
export type BridgeAgentUpdateSendOutcome =
  | { kind: "accepted"; status: BridgeAgentUpdateStatus }
  /** The agent refused the intent: nothing will be applied. */
  | {
      kind: "rejected";
      errorCode:
        | "AGENT_UPDATE_REJECTED"
        | "AGENT_UPDATE_CONFLICT"
        | "AGENT_UPDATE_UNSUPPORTED"
        | "AGENT_UNAUTHORIZED";
    }
  /**
   * No usable answer. The agent may or may not have accepted the intent;
   * sending the same operation again is safe because a replay returns the
   * known state.
   */
  | {
      kind: "retry";
      errorCode: "AGENT_UNREACHABLE" | "AGENT_TIMEOUT" | "AGENT_HTTP_ERROR" | "AGENT_MALFORMED_RESPONSE";
    };

/** What `GET /v1/update?operationId=` answered, classified. */
export type BridgeAgentUpdateReadOutcome =
  | { kind: "status"; status: BridgeAgentUpdateStatus }
  /** The agent has no record of the operation (404). */
  | { kind: "unknown_operation" }
  /** The agent answered for another operation: never trusted. */
  | { kind: "mismatch" }
  /** Nothing usable came back: a management-contact observation. */
  | { kind: "no_contact"; errorCode: BridgeAgentUpdateError };

export const classifyBridgeAgentUpdateSend = (
  operationId: string,
  result: Awaited<ReturnType<typeof requestBridgeAgent>>,
): BridgeAgentUpdateSendOutcome => {
  if (result.kind === "failed") return { kind: "retry", errorCode: result.code };
  const { status } = result;
  if (status === 401 || status === 403) return { kind: "rejected", errorCode: "AGENT_UNAUTHORIZED" };
  if (status === 404 || status === 405) return { kind: "rejected", errorCode: "AGENT_UPDATE_UNSUPPORTED" };
  if (status === 409) return { kind: "rejected", errorCode: "AGENT_UPDATE_CONFLICT" };
  if (status === 400 || status === 422) return { kind: "rejected", errorCode: "AGENT_UPDATE_REJECTED" };
  if (status < 200 || status >= 300) return { kind: "retry", errorCode: "AGENT_HTTP_ERROR" };
  const parsed = bridgeAgentUpdateStatusSchema.safeParse(result.body);
  if (!parsed.success || parsed.data.operationId !== operationId) {
    return { kind: "retry", errorCode: "AGENT_MALFORMED_RESPONSE" };
  }
  return { kind: "accepted", status: parsed.data };
};

export const classifyBridgeAgentUpdateRead = (
  operationId: string,
  result: Awaited<ReturnType<typeof requestBridgeAgent>>,
): BridgeAgentUpdateReadOutcome => {
  if (result.kind === "failed") return { kind: "no_contact", errorCode: result.code };
  const { status } = result;
  if (status === 401 || status === 403) return { kind: "no_contact", errorCode: "AGENT_UNAUTHORIZED" };
  if (status === 404) {
    const code = (result.body as { error?: { code?: unknown } } | null)?.error?.code;
    return code === "UNKNOWN_OPERATION"
      ? { kind: "unknown_operation" }
      : { kind: "no_contact", errorCode: "AGENT_HTTP_ERROR" };
  }
  if (status < 200 || status >= 300) return { kind: "no_contact", errorCode: "AGENT_HTTP_ERROR" };
  const parsed = bridgeAgentUpdateStatusSchema.safeParse(result.body);
  if (!parsed.success) return { kind: "no_contact", errorCode: "AGENT_MALFORMED_RESPONSE" };
  if (parsed.data.operationId !== operationId) return { kind: "mismatch" };
  return { kind: "status", status: parsed.data };
};

/** `POST /v1/update`. Never throws for an agent problem. */
export const sendBridgeAgentUpdate = async (
  request: BridgeAgentUpdateRequest,
  options: BridgeAgentRequestOptions,
): Promise<BridgeAgentUpdateSendOutcome> =>
  classifyBridgeAgentUpdateSend(
    request.operationId,
    await requestBridgeAgent("/v1/update", { ...options, method: "POST", body: request }),
  );

/** `GET /v1/update?operationId=`. Never throws for an agent problem. */
export const readBridgeAgentUpdate = async (
  operationId: string,
  options: BridgeAgentRequestOptions,
): Promise<BridgeAgentUpdateReadOutcome> =>
  classifyBridgeAgentUpdateRead(
    operationId,
    await requestBridgeAgent(`/v1/update?operationId=${encodeURIComponent(operationId)}`, {
      ...options,
      method: "GET",
    }),
  );

