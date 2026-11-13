import { readFileSync } from "node:fs";

export const BRIDGE_API_VERSION = 1;
/** `update.v1` is added by the update task together with `/v1/update`. */
export const BRIDGE_CAPABILITIES = ["status.v1"] as const;

/** Fixed enum: the panel keys behavior off these, never off the message text. */
export const ERROR_CODES = [
  "FRPS_UNREACHABLE",
  "FRPS_AUTH_FAILED",
  "FRPS_TIMEOUT",
  "FRPS_HTTP_ERROR",
  "FRPS_MALFORMED_RESPONSE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const MAX_ERRORS = 8;

export type StatusError = { code: ErrorCode; message: string };

export type ProxyStatus = {
  /** The frp proxy name, `awg-route-<route uuid>` for managed routes. */
  proxyId: string;
  /** Public UDP port frps reports; null when frps no longer holds the config (offline). */
  remotePort: number | null;
  online: boolean;
  /** Opaque stable id of the observed registration; null when frps gave no clientID. */
  registrationMarker: string | null;
};

export type AppliedPorts = {
  controlTcpPort: number;
  udpPortStart: number;
  udpPortEnd: number;
};

export type IdentityResponse = {
  bridgeId: string;
  agentVersion: string;
  apiVersion: number;
  capabilities: string[];
};

export type StatusResponse = {
  bridgeId: string;
  agentVersion: string;
  apiVersion: number;
  observedAt: string;
  frps: { reachable: boolean; version: string | null };
  applied: AppliedPorts;
  proxies: ProxyStatus[];
  errors: StatusError[];
};

/** The agent's own version: this package's version (the file ships next to dist/ and src/). */
export const readAgentVersion = (): string => {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || !version) throw new Error("package.json has no version");
  return version;
};
