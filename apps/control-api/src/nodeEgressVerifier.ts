import type { EncryptedSecret, EncryptionKeyring } from "@amnezia/db";
import { decryptSecret } from "@amnezia/db";
import {
  verifyNodeEgressIpResultSchema,
  type VerifyNodeEgressIpRequest,
  type VerifyNodeEgressIpResult,
} from "@amnezia/contracts";
import { ApiError } from "./service.js";

export type NodeEgressVerifyTarget = {
  nodeId: string;
  apiBaseUrl: string;
  credentials: EncryptedSecret;
  egressIpId: string;
  egressIpv4: string;
  dnsPrimary: string;
  probeUrl: string | null;
};

export type NodeEgressVerifier = (
  target: NodeEgressVerifyTarget,
  keyring: EncryptionKeyring,
  request: VerifyNodeEgressIpRequest,
) => Promise<VerifyNodeEgressIpResult>;

/**
 * Ask the node's own node-agent to verify both outbound HTTP egress IP binding
 * and UDP DNS resolution for one configured Exit IP.
 */
export const verifyNodeEgressIpViaAgent: NodeEgressVerifier = async (
  target,
  keyring,
  request,
): Promise<VerifyNodeEgressIpResult> => {
  const probeUrl = request.probeUrl ?? target.probeUrl;
  if (!probeUrl) {
    throw new ApiError(
      409,
      "Reachability probe egress URL is not configured; provide probeUrl",
      "PROBE_EGRESS_URL_MISSING",
    );
  }
  const apiKey = decryptSecret(target.credentials, keyring);
  const url = `${target.apiBaseUrl.replace(/\/$/, "")}/server/egress/verify`;
  const timeoutMs = (request.timeoutMs ?? 15_000) + 5_000;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        egressIpv4: target.egressIpv4,
        probeUrl,
        dnsServer: target.dnsPrimary,
        ...(request.dnsDomain ? { dnsDomain: request.dnsDomain } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ApiError(
      502,
      error instanceof Error && error.name === "TimeoutError"
        ? "Timed out waiting for node agent egress verification"
        : "Could not reach node agent for egress verification",
      "NODE_AGENT_UNREACHABLE",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      502,
      `Node agent rejected egress verification with status ${response.status}`,
      "NODE_AGENT_UNREACHABLE",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      502,
      "Invalid egress verification response from node agent",
      "NODE_AGENT_INVALID_RESPONSE",
    );
  }
  const parsed = verifyNodeEgressIpResultSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      502,
      "Invalid egress verification response from node agent",
      "NODE_AGENT_INVALID_RESPONSE",
    );
  }
  return parsed.data;
};
