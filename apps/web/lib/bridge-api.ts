import {
  BRIDGE_REGISTRATION_MARKER_HEADER,
  decodeRegistrationMarkerHeader,
  type Bridge,
  type BridgeAgentUpdateView,
  type BridgeEligibility,
  type CreateBridgeRequest,
  type InfrastructureItem,
  type NodeBridgeRoutes,
  type PrepareBridgeRouteResult,
  type RequestBridgeAgentUpdateResult,
  type ReleaseBridgeRouteResult,
  type VerifyBridgeRouteResult,
  type NodeEndpointAssignment,
  type DeleteBridgeResult,
} from "@amnezia/contracts";
import { ApiClientError } from "@/lib/api";

/**
 * Thin typed wrappers over the Control API's bridge endpoints. The web app
 * holds no bridge business logic: every rule (port allocation, observation
 * freshness, verification, revision checks) is enforced by the API and its
 * error codes are shown, never re-derived here.
 */
export type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const listInfrastructure = (request: Requester) =>
  request<InfrastructureItem[]>("/api/admin/infrastructure");

export const listBridges = (request: Requester) =>
  request<Bridge[]>("/api/admin/vpn-bridges");

export const createBridge = (request: Requester, body: CreateBridgeRequest) =>
  request<Bridge>("/api/admin/vpn-bridges", json("POST", body));

export const renameBridge = (request: Requester, id: string, name: string) =>
  request<Bridge>(`/api/admin/vpn-bridges/${id}`, json("PATCH", { name }));

export const deleteBridge = (request: Requester, id: string) =>
  request<DeleteBridgeResult>(`/api/admin/vpn-bridges/${id}`, { method: "DELETE" });

/** The preview: installed version, offered image, outstanding or last operation. */
export const getAgentUpdate = (request: Requester, bridgeId: string) =>
  request<BridgeAgentUpdateView>(`/api/admin/vpn-bridges/${bridgeId}/agent-update`);

/** Request exactly the digest the preview offered; the API refuses any other. */
export const requestAgentUpdate = (request: Requester, bridgeId: string, imageDigest: string) =>
  request<RequestBridgeAgentUpdateResult>(
    `/api/admin/vpn-bridges/${bridgeId}/agent-update`,
    json("POST", { imageDigest }),
  );

export const getNodeRoutes = (request: Requester, nodeId: string) =>
  request<NodeBridgeRoutes>(`/api/admin/nodes/${nodeId}/vpn-bridge-routes`);

export const getEligibility = (request: Requester, nodeId: string) =>
  request<BridgeEligibility>(`/api/admin/nodes/${nodeId}/vpn-bridge-eligibility`);

export const prepareRoute = (
  request: Requester,
  nodeId: string,
  bridgeId: string,
  publicUdpPort?: number,
) =>
  request<PrepareBridgeRouteResult>(
    `/api/admin/nodes/${nodeId}/vpn-bridge-routes`,
    json("POST", publicUdpPort === undefined ? { bridgeId } : { bridgeId, publicUdpPort }),
  );

/**
 * Activate a route (`routeId`) or switch back to Direct (`null`). The revision
 * is the one the editor last loaded, so a concurrent change is refused by the
 * API with BRIDGE_REVISION_CONFLICT instead of being overwritten.
 */
export const setNodeEndpoint = (
  request: Requester,
  nodeId: string,
  routeId: string | null,
  expectedVpnEndpointRevision: number,
) =>
  request<{ id: string; vpnEndpoint: NodeEndpointAssignment }>(
    `/api/admin/nodes/${nodeId}`,
    json("PATCH", { vpnBridgeRouteId: routeId, expectedVpnEndpointRevision }),
  );

export const releaseRoute = (request: Requester, routeId: string) =>
  request<ReleaseBridgeRouteResult>(
    `/api/admin/vpn-bridge-routes/${routeId}?confirmed=true`,
    { method: "DELETE" },
  );

export const verifyRouteByProbe = (request: Requester, routeId: string) =>
  request<VerifyBridgeRouteResult>(
    `/api/admin/vpn-bridge-routes/${routeId}/verify`,
    json("POST", { method: "probe" }),
  );

export const verifyRouteByOperator = (
  request: Requester,
  routeId: string,
  registrationMarker: string,
) =>
  request<VerifyBridgeRouteResult>(
    `/api/admin/vpn-bridge-routes/${routeId}/verify`,
    json("POST", {
      method: "operator",
      registrationMarker,
      confirmHandshakeAndHttp: true,
    }),
  );

export type TestConfig = {
  blob: Blob;
  filename: string;
  /** Registration marker the config was rendered for; null when not observed. */
  marker: string | null;
};

const filenameOf = (disposition: string | null): string => {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return "bridge-test.vpn";
};

/** Fetch the test config (a secret-bearing `.vpn` body) for a draft route. */
export const fetchTestConfig = async (
  routeId: string,
  keyId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TestConfig> => {
  const response = await fetchImpl(
    `/api/control/api/admin/vpn-bridge-routes/${routeId}/test-config?keyId=${encodeURIComponent(keyId)}`,
  );
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiClientError(
      response.status,
      error.error ?? "REQUEST_FAILED",
      error.message ?? `Request failed with status ${response.status}`,
    );
  }
  return {
    blob: await response.blob(),
    filename: filenameOf(response.headers.get("content-disposition")),
    marker: decodeRegistrationMarkerHeader(
      response.headers.get(BRIDGE_REGISTRATION_MARKER_HEADER),
    ),
  };
};
