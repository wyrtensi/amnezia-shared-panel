import type {
  CreateNodeEgressIpRequest,
  NodeEgressIp,
  NodeEgressMode,
  SwapNodeEgressIpRequest,
  UpdateNodeEgressIpRequest,
  UpdateNodeEgressModeRequest,
  VerifyNodeEgressIpRequest,
  VerifyNodeEgressIpResult,
} from "@amnezia/contracts";
import type { Requester } from "@/lib/bridge-api";

export const formatEntryExit = (
  entryAddress: string | null | undefined,
  exitIpv4: string | null | undefined,
): string | null => {
  const entry = entryAddress?.trim() || "";
  const exit = exitIpv4?.trim() || "";
  if (entry && exit && entry !== exit) {
    return `${entry} → ${exit}`;
  }
  return entry || exit || null;
};

export const listNodeEgressIps = (
  request: Requester,
  nodeId: string,
): Promise<NodeEgressIp[]> =>
  request<NodeEgressIp[]>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips`,
  );

export const createNodeEgressIp = (
  request: Requester,
  nodeId: string,
  body: CreateNodeEgressIpRequest,
): Promise<NodeEgressIp> =>
  request<NodeEgressIp>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

export const updateNodeEgressIp = (
  request: Requester,
  nodeId: string,
  ipId: string,
  body: UpdateNodeEgressIpRequest,
): Promise<NodeEgressIp> =>
  request<NodeEgressIp>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips/${encodeURIComponent(ipId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );

export const deleteNodeEgressIp = (
  request: Requester,
  nodeId: string,
  ipId: string,
): Promise<{ deleted: boolean }> =>
  request<{ deleted: boolean }>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips/${encodeURIComponent(ipId)}`,
    {
      method: "DELETE",
    },
  );

export const swapNodeEgressIp = (
  request: Requester,
  nodeId: string,
  ipId: string,
  body: SwapNodeEgressIpRequest,
): Promise<NodeEgressIp> =>
  request<NodeEgressIp>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips/${encodeURIComponent(ipId)}/swap`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

export const verifyNodeEgressIp = (
  request: Requester,
  nodeId: string,
  ipId: string,
  body: VerifyNodeEgressIpRequest = {},
): Promise<VerifyNodeEgressIpResult> =>
  request<VerifyNodeEgressIpResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips/${encodeURIComponent(ipId)}/verify`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

export const setNodeEgressMode = (
  request: Requester,
  nodeId: string,
  body: UpdateNodeEgressModeRequest,
): Promise<{ queued: boolean; mode: NodeEgressMode }> =>
  request<{ queued: boolean; mode: NodeEgressMode }>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-mode`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );

export const adoptNodeEgressMode = (
  request: Requester,
  nodeId: string,
): Promise<{ adopted: boolean; mode: NodeEgressMode }> =>
  request<{ adopted: boolean; mode: NodeEgressMode }>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-mode/adopt`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );

export const reassignKeyEndpoint = (
  request: Requester,
  keyId: string,
  endpointId: string,
): Promise<{ keyId: string; endpointId: string; synced: boolean }> =>
  request<{ keyId: string; endpointId: string; synced: boolean }>(
    `/api/admin/keys/${encodeURIComponent(keyId)}/reassign-endpoint`,
    {
      method: "POST",
      body: JSON.stringify({ endpointId }),
    },
  );
