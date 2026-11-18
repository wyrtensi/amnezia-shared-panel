import { fetchServerInfo, fetchUdpProxies, FrpsError, type FrpsClientOptions } from "./frps.js";
import {
  BRIDGE_API_VERSION,
  MAX_ERRORS,
  STATUS_CAPABILITY,
  UPDATE_CAPABILITY,
  type AppliedPorts,
  type HostMetrics,
  type IdentityResponse,
  type StatusError,
  type StatusResponse,
} from "./types.js";
import type { UpdateSpool } from "./update.js";

export type AgentContext = {
  bridgeId: string;
  agentVersion: string;
  applied: AppliedPorts;
  frps: FrpsClientOptions;
  /** Present when updates are configured. */
  update?: { approvedRepository: string; spool: UpdateSpool } | null;
  now?: () => Date;
  sampleHostMetrics?: () => Promise<HostMetrics>;
};

export const identity = (ctx: AgentContext): IdentityResponse => ({
  bridgeId: ctx.bridgeId,
  agentVersion: ctx.agentVersion,
  apiVersion: BRIDGE_API_VERSION,
  capabilities: ctx.update ? [STATUS_CAPABILITY, UPDATE_CAPABILITY] : [STATUS_CAPABILITY],
});

const toError = (endpoint: string, error: unknown): StatusError =>
  error instanceof FrpsError
    ? { code: error.code, message: `${endpoint}: ${error.detail}` }
    : { code: "FRPS_UNREACHABLE", message: `${endpoint}: frps read failed` };

/**
 * One observation. Never throws: upstream trouble is reported in `errors` and
 * `frps.reachable`, so the endpoint stays 200 and the panel can tell "agent
 * down" from "frps down". `reachable` is true only when both reads succeeded;
 * otherwise `proxies` is empty and says nothing about any registration.
 */
export const status = async (ctx: AgentContext): Promise<StatusResponse> => {
  const [server, proxies, host] = await Promise.allSettled([
    fetchServerInfo(ctx.frps),
    fetchUdpProxies(ctx.frps),
    ctx.sampleHostMetrics?.(),
  ]);
  const errors: StatusError[] = [];
  if (server.status === "rejected") errors.push(toError("serverinfo", server.reason));
  if (proxies.status === "rejected") errors.push(toError("proxy/udp", proxies.reason));
  const info = server.status === "fulfilled" ? server.value : null;
  const reachable = info !== null && proxies.status === "fulfilled";
  // Despite their name, the FRP dashboard totals are TodayCount() values.
  const trafficToday =
    info?.totalTrafficIn !== undefined && info.totalTrafficOut !== undefined
      ? { inBytes: info.totalTrafficIn, outBytes: info.totalTrafficOut }
      : undefined;

  return {
    bridgeId: ctx.bridgeId,
    agentVersion: ctx.agentVersion,
    apiVersion: BRIDGE_API_VERSION,
    observedAt: (ctx.now?.() ?? new Date()).toISOString(),
    frps: {
      reachable,
      version: info?.version ?? null,
    },
    ...(trafficToday ? { trafficToday } : {}),
    ...(host.status === "fulfilled" && host.value ? { hostMetrics: host.value } : {}),
    applied: { ...ctx.applied },
    proxies: info && proxies.status === "fulfilled" ? proxies.value : [],
    errors: errors.slice(0, MAX_ERRORS),
  };
};
