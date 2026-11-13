import { z } from "zod";

import { bridgeRegistrationMarkerSchema } from "./bridges.js";

/**
 * The panel's side of the bridge-agent management API
 * (`services/bridge-agent`, `openapi/bridge-agent.v1.yaml`): the response
 * schemas, one HTTP client and the pure classification of a status read.
 * The Control API (enrollment) and the worker (poller) share all of it.
 */

/** The management API version this panel speaks. */
export const BRIDGE_AGENT_API_VERSION = 1;
/** The capability an agent must report for `GET /v1/status`. */
export const BRIDGE_AGENT_STATUS_CAPABILITY = "status.v1";

/** Outbox job type of one bridge's status poll. */
export const BRIDGE_AGENT_POLL_JOB_TYPE = "bridge_agent.poll";
/** One outbox row per bridge, re-armed by the worker's timer. */
export const bridgeAgentPollDeduplicationKey = (bridgeId: string): string =>
  `${BRIDGE_AGENT_POLL_JOB_TYPE}:${bridgeId}`;
export const bridgeAgentPollPayloadSchema = z.object({ bridgeId: z.uuid() });
export type BridgeAgentPollPayload = z.infer<typeof bridgeAgentPollPayloadSchema>;

/** How often the worker arms every enrolled bridge's poll. */
export const BRIDGE_AGENT_POLL_INTERVAL_MS = 60_000;
/**
 * Per-request deadline. Above the agent's own frps read timeout (3 s), so a
 * slow frps still comes back as a status with `frps.reachable: false`.
 */
export const BRIDGE_AGENT_REQUEST_TIMEOUT_MS = 5_000;
/** Largest response body the panel reads from an agent. */
export const BRIDGE_AGENT_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Bounded codes the panel stores in `vpn_bridges.last_error_code` for its
 * own findings. The agent's frps codes (`FRPS_UNREACHABLE`, ...) are stored
 * as reported, after `bridgeAgentErrorCodeSchema` bounded their format.
 */
export const BRIDGE_AGENT_POLL_ERRORS = [
  "AGENT_UNREACHABLE",
  "AGENT_TIMEOUT",
  "AGENT_UNAUTHORIZED",
  "AGENT_HTTP_ERROR",
  "AGENT_MALFORMED_RESPONSE",
  "AGENT_API_UNSUPPORTED",
  "AGENT_IDENTITY_MISMATCH",
  // The stored management URL is no longer an allowed management destination.
  "AGENT_URL_NOT_ALLOWED",
  // The stored credential cannot be decrypted with the panel's keyring.
  "AGENT_CREDENTIAL_UNREADABLE",
  // frps reports a route's proxy name on a different public port.
  "ROUTE_PORT_MISMATCH",
] as const;
export type BridgeAgentPollError = (typeof BRIDGE_AGENT_POLL_ERRORS)[number];

/** An error code as the agent reports it: an upper-case identifier, never text. */
export const bridgeAgentErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const bridgeAgentIdentitySchema = z.object({
  bridgeId: z.string().min(1).max(200),
  agentVersion: z.string().min(1).max(64),
  apiVersion: z.int(),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
});
export type BridgeAgentIdentity = z.infer<typeof bridgeAgentIdentitySchema>;

export const bridgeAgentProxySchema = z.object({
  proxyId: z.string().min(1).max(200),
  // Null once frps no longer holds the proxy config (offline).
  remotePort: z.int().min(1).max(65_535).nullable(),
  online: z.boolean(),
  registrationMarker: bridgeRegistrationMarkerSchema.nullable(),
});
export type BridgeAgentProxy = z.infer<typeof bridgeAgentProxySchema>;

export const bridgeAgentStatusSchema = z.object({
  bridgeId: z.string().min(1).max(200),
  agentVersion: z.string().min(1).max(64),
  apiVersion: z.literal(BRIDGE_AGENT_API_VERSION),
  observedAt: z.string().max(64),
  frps: z.object({
    // True only when both frps reads succeeded. When false, `proxies` is
    // empty and proves nothing about the routes.
    reachable: z.boolean(),
    version: z.string().max(64).nullable(),
  }),
  applied: z.object({
    controlTcpPort: z.int(),
    udpPortStart: z.int(),
    udpPortEnd: z.int(),
  }),
  proxies: z.array(bridgeAgentProxySchema).max(4_096),
  errors: z
    .array(z.object({ code: bridgeAgentErrorCodeSchema, message: z.string().max(500) }))
    .max(32),
});
export type BridgeAgentStatus = z.infer<typeof bridgeAgentStatusSchema>;

/**
 * One status poll, classified. `ok` means the agent answered for the
 * expected bridge with a supported status; `frpsReachable: false` is still
 * `ok` for management, but its (empty) proxy list must not be read as the
 * routes being absent. The other kinds never carry route observations.
 */
export type BridgeAgentPollOutcome =
  | {
      kind: "ok";
      agentVersion: string;
      agentApiVersion: number;
      frpsReachable: boolean;
      frpsVersion: string | null;
      proxies: readonly BridgeAgentProxy[];
      /** First error the agent reported, if any. */
      errorCode: string | null;
    }
  | { kind: "down"; errorCode: BridgeAgentPollError }
  | { kind: "identity_mismatch"; errorCode: "AGENT_IDENTITY_MISMATCH" }
  | {
      kind: "unsupported";
      errorCode: "AGENT_API_UNSUPPORTED" | "AGENT_MALFORMED_RESPONSE";
      agentVersion: string | null;
      agentApiVersion: number | null;
    };

/** What came back from one request to the agent, before interpretation. */
export type BridgeAgentHttpResult =
  | { kind: "response"; status: number; body: unknown }
  | {
      kind: "failed";
      code: "AGENT_UNREACHABLE" | "AGENT_TIMEOUT" | "AGENT_MALFORMED_RESPONSE";
    };

export type BridgeAgentRequestOptions = {
  /** The management API origin, e.g. `http://host.docker.internal:7605`. */
  baseUrl: string;
  /** The agent's bearer token. Sent as a header, never logged or echoed. */
  apiKey: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
};

const readCappedText = async (response: Response, maxBytes: number): Promise<string | null> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

/**
 * GET one management path. Never throws for an agent problem: network
 * failures, timeouts, redirects and oversized or non-JSON bodies become a
 * bounded code, and nothing the agent sent ends up in an error message.
 */
export const requestBridgeAgent = async (
  path: "/v1/identity" | "/v1/status",
  {
    baseUrl,
    apiKey,
    timeoutMs = BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
    maxBytes = BRIDGE_AGENT_MAX_RESPONSE_BYTES,
    fetchImpl = fetch,
  }: BridgeAgentRequestOptions,
): Promise<BridgeAgentHttpResult> => {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      // A management endpoint never redirects; following one could carry the
      // bearer token to a destination the allowlist never approved.
      redirect: "error",
      signal,
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return { kind: "failed", code: signal.aborted ? "AGENT_TIMEOUT" : "AGENT_UNREACHABLE" };
  }
  let text: string | null;
  try {
    text = await readCappedText(response, maxBytes);
  } catch {
    return { kind: "failed", code: signal.aborted ? "AGENT_TIMEOUT" : "AGENT_UNREACHABLE" };
  }
  if (text === null) return { kind: "failed", code: "AGENT_MALFORMED_RESPONSE" };
  if (!response.ok) return { kind: "response", status: response.status, body: null };
  try {
    return { kind: "response", status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "failed", code: "AGENT_MALFORMED_RESPONSE" };
  }
};

const reportedApiVersion = (body: unknown): number | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { apiVersion?: unknown }).apiVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

const reportedAgentVersion = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { agentVersion?: unknown }).agentVersion;
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
};

/**
 * Classify a `GET /v1/status` result for the bridge the panel expects.
 * Pure: every branch is unit-tested.
 *
 * - no answer, 401 or another non-2xx: `down`;
 * - 404 (an agent without the v1 status route), another `apiVersion` or a
 *   body that is not a v1 status: `unsupported`;
 * - a v1 status for another bridge id: `identity_mismatch`; its proxies are
 *   never accepted;
 * - otherwise `ok`.
 */
export const classifyBridgeAgentStatus = (
  expectedBridgeId: string,
  result: BridgeAgentHttpResult,
): BridgeAgentPollOutcome => {
  if (result.kind === "failed") {
    return result.code === "AGENT_MALFORMED_RESPONSE"
      ? {
          kind: "unsupported",
          errorCode: "AGENT_MALFORMED_RESPONSE",
          agentVersion: null,
          agentApiVersion: null,
        }
      : { kind: "down", errorCode: result.code };
  }
  if (result.status === 401 || result.status === 403) {
    return { kind: "down", errorCode: "AGENT_UNAUTHORIZED" };
  }
  if (result.status === 404) {
    return {
      kind: "unsupported",
      errorCode: "AGENT_API_UNSUPPORTED",
      agentVersion: null,
      agentApiVersion: null,
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return { kind: "down", errorCode: "AGENT_HTTP_ERROR" };
  }
  const apiVersion = reportedApiVersion(result.body);
  if (apiVersion !== null && apiVersion !== BRIDGE_AGENT_API_VERSION) {
    return {
      kind: "unsupported",
      errorCode: "AGENT_API_UNSUPPORTED",
      agentVersion: reportedAgentVersion(result.body),
      agentApiVersion: apiVersion,
    };
  }
  const parsed = bridgeAgentStatusSchema.safeParse(result.body);
  if (!parsed.success) {
    return {
      kind: "unsupported",
      errorCode: "AGENT_MALFORMED_RESPONSE",
      agentVersion: reportedAgentVersion(result.body),
      agentApiVersion: apiVersion,
    };
  }
  const status = parsed.data;
  if (status.bridgeId !== expectedBridgeId) {
    return { kind: "identity_mismatch", errorCode: "AGENT_IDENTITY_MISMATCH" };
  }
  return {
    kind: "ok",
    agentVersion: status.agentVersion,
    agentApiVersion: status.apiVersion,
    frpsReachable: status.frps.reachable,
    frpsVersion: status.frps.version,
    // An unreachable frps reports an empty list that means "unknown"; it is
    // dropped here so no caller can mistake it for "every route is gone".
    proxies: status.frps.reachable ? status.proxies : [],
    errorCode: status.errors[0]?.code ?? null,
  };
};

/** `GET /v1/status`, classified for the expected bridge. */
export const readBridgeAgentStatus = async (
  expectedBridgeId: string,
  options: BridgeAgentRequestOptions,
): Promise<BridgeAgentPollOutcome> =>
  classifyBridgeAgentStatus(expectedBridgeId, await requestBridgeAgent("/v1/status", options));

/** Why an enrollment candidate was refused, or the identity it proved. */
export type BridgeAgentIdentityCheck =
  | { kind: "ok"; identity: BridgeAgentIdentity }
  | { kind: "unreachable" }
  | { kind: "unauthorized" }
  | { kind: "identity_mismatch" }
  | { kind: "unsupported" };

/**
 * Classify a `GET /v1/identity` result: the agent must answer for the
 * expected bridge id, speak a supported API version and report the status
 * capability.
 */
export const classifyBridgeAgentIdentity = (
  expectedBridgeId: string,
  result: BridgeAgentHttpResult,
): BridgeAgentIdentityCheck => {
  if (result.kind === "failed") {
    return result.code === "AGENT_MALFORMED_RESPONSE"
      ? { kind: "unsupported" }
      : { kind: "unreachable" };
  }
  if (result.status === 401 || result.status === 403) return { kind: "unauthorized" };
  if (result.status === 404) return { kind: "unsupported" };
  if (result.status < 200 || result.status >= 300) return { kind: "unreachable" };
  const parsed = bridgeAgentIdentitySchema.safeParse(result.body);
  if (!parsed.success) return { kind: "unsupported" };
  const identity = parsed.data;
  if (identity.bridgeId !== expectedBridgeId) return { kind: "identity_mismatch" };
  if (
    identity.apiVersion !== BRIDGE_AGENT_API_VERSION ||
    !identity.capabilities.includes(BRIDGE_AGENT_STATUS_CAPABILITY)
  ) {
    return { kind: "unsupported" };
  }
  return { kind: "ok", identity };
};

/** `GET /v1/identity`, classified for the expected bridge. */
export const readBridgeAgentIdentity = async (
  expectedBridgeId: string,
  options: BridgeAgentRequestOptions,
): Promise<BridgeAgentIdentityCheck> =>
  classifyBridgeAgentIdentity(
    expectedBridgeId,
    await requestBridgeAgent("/v1/identity", options),
  );

// --- Allowed management destinations ---------------------------------------

/**
 * Hosts a bridge management URL may name when `VPN_BRIDGE_MANAGEMENT_HOSTS`
 * is unset: the panel side of the supervised SSH tunnels, which the panel
 * containers reach as `host.docker.internal` (docs/NODE-CONNECT.md, the same
 * path node-agent tunnels use).
 */
export const BRIDGE_MANAGEMENT_HOSTS_DEFAULT: readonly string[] = ["host.docker.internal"];

const normalizeHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

/**
 * `VPN_BRIDGE_MANAGEMENT_HOSTS`: a comma-separated list of host names or IP
 * literals (no scheme or port). Unset or empty means the default.
 */
export const parseBridgeManagementHosts = (raw: string | undefined): readonly string[] => {
  const hosts = (raw ?? "")
    .split(",")
    .map(normalizeHost)
    .filter(Boolean);
  if (hosts.length === 0) return BRIDGE_MANAGEMENT_HOSTS_DEFAULT;
  for (const host of hosts) {
    if (!/^[a-z0-9.:_-]+$/.test(host)) {
      throw new Error("VPN_BRIDGE_MANAGEMENT_HOSTS must list host names or IP literals");
    }
  }
  return hosts;
};

/** Whether a management URL names one of the allowed hosts. */
export const isAllowedBridgeManagementUrl = (
  value: string,
  allowedHosts: readonly string[],
): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return allowedHosts.includes(normalizeHost(url.hostname));
};

/** The stored form of a management URL: its origin. */
export const normalizeBridgeManagementUrl = (value: string): string => new URL(value).origin;
