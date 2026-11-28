import { fetchServerInfo, fetchUdpProxies, FrpsError, type FrpsClientOptions } from "./frps.js";
import {
  BRIDGE_API_VERSION,
  MAX_ERRORS,
  STATUS_CAPABILITY,
  UPDATE_CAPABILITY,
  WYTUNNEL_CAPABILITY,
  type AppliedPorts,
  type FrpsTlsStatus,
  type HostMetrics,
  type IdentityResponse,
  type StatusError,
  type StatusResponse,
  type WytunnelInstanceStatus,
} from "./types.js";
import type { UpdateSpool } from "./update.js";

export type AgentContext = {
  bridgeId: string;
  agentVersion: string;
  applied: AppliedPorts;
  /** Null when BRIDGE_FRPS_ENABLED=false on a WyTunnel-only bridge. */
  frps: FrpsClientOptions | null;
  /** Present when updates are configured. */
  update?: { approvedRepository: string; spool: UpdateSpool } | null;
  now?: () => Date;
  sampleHostMetrics?: () => Promise<HostMetrics>;
  sampleFrpsTls?: () => Promise<FrpsTlsStatus>;
  sampleWytunnel?: () => Promise<WytunnelInstanceStatus[]>;
};

export const identity = (ctx: AgentContext): IdentityResponse => ({
  bridgeId: ctx.bridgeId,
  agentVersion: ctx.agentVersion,
  apiVersion: BRIDGE_API_VERSION,
  capabilities: [
    STATUS_CAPABILITY,
    ...(ctx.update ? [UPDATE_CAPABILITY] : []),
    ...(ctx.sampleWytunnel ? [WYTUNNEL_CAPABILITY] : []),
  ],
});

const toError = (endpoint: string, error: unknown): StatusError =>
  error instanceof FrpsError
    ? { code: error.code, message: `${endpoint}: ${error.detail}` }
    : { code: "FRPS_UNREACHABLE", message: `${endpoint}: frps read failed` };

/**
 * One observation. Never throws: upstream trouble is reported in `errors` and
 * `frps.reachable`, so the endpoint stays 200 and the panel can tell "agent
 * down" from "frps down". When `ctx.frps` is null (`BRIDGE_FRPS_ENABLED=false`),
 * frps is intentionally disabled and reports `enabled: false` with zero errors.
 */
export const status = async (ctx: AgentContext): Promise<StatusResponse> => {
  const [server, proxies, host, tls, wytunnel] = await Promise.allSettled([
    ctx.frps ? fetchServerInfo(ctx.frps) : Promise.resolve(null),
    ctx.frps ? fetchUdpProxies(ctx.frps) : Promise.resolve([]),
    ctx.sampleHostMetrics?.(),
    ctx.frps ? ctx.sampleFrpsTls?.() : Promise.resolve(undefined),
    ctx.sampleWytunnel?.(),
  ]);
  const errors: StatusError[] = [];
  if (ctx.frps) {
    if (server.status === "rejected") errors.push(toError("serverinfo", server.reason));
    if (proxies.status === "rejected") errors.push(toError("proxy/udp", proxies.reason));
  }
  const info = server.status === "fulfilled" ? server.value : null;
  const reachable = ctx.frps !== null && info !== null && proxies.status === "fulfilled";
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
      ...(ctx.frps === null ? { enabled: false } : {}),
      reachable,
      version: info?.version ?? null,
    },
    ...(trafficToday ? { trafficToday } : {}),
    ...(host.status === "fulfilled" && host.value ? { hostMetrics: host.value } : {}),
    ...(tls.status === "fulfilled" && tls.value ? { frpsTls: tls.value } : {}),
    applied: { ...ctx.applied },
    proxies: ctx.frps && info && proxies.status === "fulfilled" ? proxies.value : [],
    ...(wytunnel.status === "fulfilled" && wytunnel.value !== undefined
      ? { wytunnel: wytunnel.value }
      : {}),
    errors: errors.slice(0, MAX_ERRORS),
  };
};
