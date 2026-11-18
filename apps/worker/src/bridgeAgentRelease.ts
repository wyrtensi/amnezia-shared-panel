import {
  BRIDGE_AGENT_API_VERSION_LABEL,
  BRIDGE_AGENT_MIN_VERSION,
  BRIDGE_AGENT_SUPPORTED_API_VERSIONS,
} from "@amnezia/contracts";

import { resolveAgentRelease, type AgentRelease } from "./agentRelease.js";

/** The newest compatible bridge-agent image in the approved repository. */
export const resolveBridgeAgentRelease = (
  repository: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentRelease | null> =>
  resolveAgentRelease(
    repository,
    {
      minVersion: BRIDGE_AGENT_MIN_VERSION,
      apiVersionLabel: {
        name: BRIDGE_AGENT_API_VERSION_LABEL,
        supportedApiVersions: BRIDGE_AGENT_SUPPORTED_API_VERSIONS,
      },
      // An incompatible newest release must not hide an older compatible one.
      maxCandidates: 5,
    },
    fetchImpl,
  );
