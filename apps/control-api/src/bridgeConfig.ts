import {
  parseBridgeJobsEnabled,
  parseBridgeManagementHosts,
  parseBridgeObservationStaleMs,
} from "@amnezia/contracts";
import { ApiError } from "./service.js";

/** Bridge settings the Control API reads from its environment once at boot. */
export type BridgeConfig = {
  /**
   * `VPN_BRIDGE_JOBS_ENABLED` (default false). Gates only the QUEUING of
   * bridge-related jobs (candidate probe verification, bridge-agent polling,
   * bridge-agent updates). Registry CRUD, route reservation, activation and
   * export rendering are not jobs and are never gated.
   */
  jobsEnabled: boolean;
  /** `VPN_BRIDGE_OBSERVATION_STALE_MS` (default 300000, five minutes). */
  observationStaleMs: number;
  /**
   * `VPN_BRIDGE_MANAGEMENT_HOSTS` (default `host.docker.internal`): the hosts
   * a bridge management URL may name, i.e. the panel side of the trusted
   * management tunnels.
   */
  managementHosts: readonly string[];
};

export const resolveBridgeConfig = (env: NodeJS.ProcessEnv): BridgeConfig => ({
  jobsEnabled: parseBridgeJobsEnabled(env.VPN_BRIDGE_JOBS_ENABLED),
  observationStaleMs: parseBridgeObservationStaleMs(
    env.VPN_BRIDGE_OBSERVATION_STALE_MS,
  ),
  managementHosts: parseBridgeManagementHosts(env.VPN_BRIDGE_MANAGEMENT_HOSTS),
});

export const bridgeJobsDisabledError = (): ApiError =>
  new ApiError(
    409,
    "Bridge jobs are disabled on this panel (set VPN_BRIDGE_JOBS_ENABLED=true once the worker and bridge stack are bridge-capable)",
    "BRIDGE_JOBS_DISABLED",
  );

/**
 * Call before inserting any bridge-related job into the outbox. Throws the
 * typed 409 `BRIDGE_JOBS_DISABLED` while the gate is closed, so a pre-bridge
 * worker in a mixed deployment never sees a job it would mark complete
 * without running.
 */
export const assertBridgeJobsEnabled = (config: Pick<BridgeConfig, "jobsEnabled">): void => {
  if (!config.jobsEnabled) throw bridgeJobsDisabledError();
};
