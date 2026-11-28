import type {
  CreateNodeEgressIpRequest,
  NodeEgressIp,
  NodeEgressMode,
  NodeEgressModeState,
  NotifyKeyUpdateResult,
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
): Promise<{ id: string; deleted: boolean; affectedEndpoints: number }> =>
  request<{ id: string; deleted: boolean; affectedEndpoints: number }>(
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
): Promise<{ ip: NodeEgressIp; replacedIpv4: string; affectedEndpoints: number }> =>
  request<{ ip: NodeEgressIp; replacedIpv4: string; affectedEndpoints: number }>(
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
): Promise<{
  nodeId: string;
  mode: NodeEgressMode;
  state: NodeEgressModeState;
  queued: boolean;
}> =>
  request<{
    nodeId: string;
    mode: NodeEgressMode;
    state: NodeEgressModeState;
    queued: boolean;
  }>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-mode`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );

export const adoptNodeEgressMode = (
  request: Requester,
  nodeId: string,
): Promise<{
  nodeId: string;
  mode: NodeEgressMode;
  state: NodeEgressModeState;
}> =>
  request<{
    nodeId: string;
    mode: NodeEgressMode;
    state: NodeEgressModeState;
  }>(
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
): Promise<{
  id: string;
  nodeId: string;
  endpointId: string;
  previousEndpointId: string | null;
}> =>
  request<{
    id: string;
    nodeId: string;
    endpointId: string;
    previousEndpointId: string | null;
  }>(
    `/api/admin/keys/${encodeURIComponent(keyId)}/endpoint`,
    {
      method: "PATCH",
      body: JSON.stringify({ endpointId }),
    },
  );

export const notifyNodeKeyUpdate = (
  request: Requester,
  nodeId: string,
  note: string | null = null,
): Promise<NotifyKeyUpdateResult> =>
  request<NotifyKeyUpdateResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/notify-key-update`,
    { method: "POST", body: JSON.stringify({ note }) },
  );

export const clearNodeKeyUpdate = (
  request: Requester,
  nodeId: string,
): Promise<NotifyKeyUpdateResult> =>
  request<NotifyKeyUpdateResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/notify-key-update`,
    { method: "DELETE" },
  );

export const notifyNodeEgressIpKeyUpdate = (
  request: Requester,
  nodeId: string,
  ipId: string,
  note: string | null = null,
): Promise<NotifyKeyUpdateResult> =>
  request<NotifyKeyUpdateResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips/${encodeURIComponent(ipId)}/notify-key-update`,
    { method: "POST", body: JSON.stringify({ note }) },
  );

export const clearNodeEgressIpKeyUpdate = (
  request: Requester,
  nodeId: string,
  ipId: string,
): Promise<NotifyKeyUpdateResult> =>
  request<NotifyKeyUpdateResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/egress-ips/${encodeURIComponent(ipId)}/notify-key-update`,
    { method: "DELETE" },
  );

export const notifyNodeEndpointKeyUpdate = (
  request: Requester,
  nodeId: string,
  endpointId: string,
  note: string | null = null,
): Promise<NotifyKeyUpdateResult> =>
  request<NotifyKeyUpdateResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/public-endpoints/${encodeURIComponent(endpointId)}/notify-key-update`,
    { method: "POST", body: JSON.stringify({ note }) },
  );

export const clearNodeEndpointKeyUpdate = (
  request: Requester,
  nodeId: string,
  endpointId: string,
): Promise<NotifyKeyUpdateResult> =>
  request<NotifyKeyUpdateResult>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/public-endpoints/${encodeURIComponent(endpointId)}/notify-key-update`,
    { method: "DELETE" },
  );
