import { fetchServerVersion, fetchUdpProxies, FrpsError, type FrpsClientOptions } from "./frps.js";
import {
  BRIDGE_API_VERSION,
  BRIDGE_CAPABILITIES,
  MAX_ERRORS,
  type AppliedPorts,
  type IdentityResponse,
  type StatusError,
  type StatusResponse,
} from "./types.js";

export type AgentContext = {
  bridgeId: string;
  agentVersion: string;
  applied: AppliedPorts;
  frps: FrpsClientOptions;
  now?: () => Date;
};

export const identity = (ctx: AgentContext): IdentityResponse => ({
  bridgeId: ctx.bridgeId,
  agentVersion: ctx.agentVersion,
  apiVersion: BRIDGE_API_VERSION,
  capabilities: [...BRIDGE_CAPABILITIES],
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
  const [version, proxies] = await Promise.allSettled([fetchServerVersion(ctx.frps), fetchUdpProxies(ctx.frps)]);
  const errors: StatusError[] = [];
  if (version.status === "rejected") errors.push(toError("serverinfo", version.reason));
  if (proxies.status === "rejected") errors.push(toError("proxy/udp", proxies.reason));

  return {
    bridgeId: ctx.bridgeId,
    agentVersion: ctx.agentVersion,
    apiVersion: BRIDGE_API_VERSION,
    observedAt: (ctx.now?.() ?? new Date()).toISOString(),
    frps: {
      reachable: version.status === "fulfilled" && proxies.status === "fulfilled",
      version: version.status === "fulfilled" ? version.value : null,
    },
    applied: { ...ctx.applied },
    proxies: proxies.status === "fulfilled" && version.status === "fulfilled" ? proxies.value : [],
    errors: errors.slice(0, MAX_ERRORS),
  };
};
