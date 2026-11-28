import { readFileSync } from "node:fs";

export const BRIDGE_API_VERSION = 1;
export const STATUS_CAPABILITY = "status.v1";
/** Reported only when updates are configured (`BRIDGE_AGENT_IMAGE_REPOSITORY` and a usable spool). */
export const UPDATE_CAPABILITY = "update.v1";
/** Reported when local WyTunnel socket observation is wired. */
export const WYTUNNEL_CAPABILITY = "wytunnel.v1";

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

export type HostMetrics = {
  cpuUsedPercent: number | null;
  memoryFreeBytes: number;
  memoryTotalBytes: number;
  diskAvailableBytes: number | null;
  diskUsedPercent: number | null;
};

export const FRPS_TLS_FAILURES = [
  "config", "expired", "not_yet_valid", "wrong_ip", "untrusted", "unreachable", "handshake",
] as const;
export type FrpsTlsFailure = (typeof FRPS_TLS_FAILURES)[number];
export type FrpsTlsStatus =
  | { state: "unconfigured" }
  | { state: "failed"; reason: FrpsTlsFailure }
  | { state: "verified"; expiresAt: string; expiresSoon: boolean; fingerprintSha256: string; matchesDeployed: boolean | null };

export type WytunnelTelemetry = {
  version?: string;
  mode?: "direct" | "pool";
  ebpfMode?: "nic" | "userspace_fallback";
  uptimeSec?: number;
  activeSessions?: number;
  healthyStreams?: number;
  targetStreams?: number;
  drainingStreams?: number;
  poolRttMs?: number | null;
  rxPackets?: number;
  txPackets?: number;
  fecRecovered?: number;
  fecLostGroups?: number;
  keepaliveResets?: number;
  failoversTotal?: number;
  rotationsTotal?: number;
};

export type WytunnelInstanceStatus = {
  routeId: string;
  remotePort: number | null;
  online: boolean;
  registrationMarker: string | null;
  telemetry?: WytunnelTelemetry;
};

export type StatusResponse = {
  bridgeId: string;
  agentVersion: string;
  apiVersion: number;
  observedAt: string;
  frps: { enabled?: boolean; reachable: boolean; version: string | null };
  frpsTls?: FrpsTlsStatus;
  trafficToday?: { inBytes: number; outBytes: number };
  hostMetrics?: HostMetrics;
  applied: AppliedPorts;
  proxies: ProxyStatus[];
  wytunnel?: WytunnelInstanceStatus[];
  errors: StatusError[];
};

/** The agent's own version: this package's version (the file ships next to dist/ and src/). */
export const readAgentVersion = (): string => {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || !version) throw new Error("package.json has no version");
  return version;
};
