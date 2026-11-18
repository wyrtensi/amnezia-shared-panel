import { describe, expect, it } from "vitest";
import {
  createBridge,
  getAgentUpdate,
  requestAgentUpdate,
  fetchTestConfig,
  prepareRoute,
  releaseRoute,
  renameBridge,
  setNodeEndpoint,
  verifyRouteByOperator,
  verifyRouteByProbe,
  type Requester,
} from "./bridge-api";

type Call = { path: string; init: RequestInit | undefined };

const recorder = () => {
  const calls: Call[] = [];
  const request: Requester = <T>(path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve({} as T);
  };
  return { calls, request };
};

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(call?.init?.body as string) as Record<string, unknown>;

describe("setNodeEndpoint", () => {
  it("activates a route with the expected revision the editor loaded", async () => {
    const { calls, request } = recorder();
    await setNodeEndpoint(request, "node-1", "route-1", 7);
    expect(calls[0]?.path).toBe("/api/admin/nodes/node-1");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(bodyOf(calls[0])).toEqual({
      vpnBridgeRouteId: "route-1",
      expectedVpnEndpointRevision: 7,
    });
  });

  it("selects Direct with null and still sends the revision", async () => {
    const { calls, request } = recorder();
    await setNodeEndpoint(request, "node-1", null, 3);
    expect(bodyOf(calls[0])).toEqual({
      vpnBridgeRouteId: null,
      expectedVpnEndpointRevision: 3,
    });
  });
});

describe("route requests", () => {
  it("prepares with an optional port override", async () => {
    const a = recorder();
    await prepareRoute(a.request, "n", "b");
    expect(bodyOf(a.calls[0])).toEqual({ bridgeId: "b" });
    const b = recorder();
    await prepareRoute(b.request, "n", "b", 41005);
    expect(bodyOf(b.calls[0])).toEqual({ bridgeId: "b", publicUdpPort: 41005 });
    expect(b.calls[0]?.path).toBe("/api/admin/nodes/n/vpn-bridge-routes");
  });

  it("releases only with the confirmation flag", async () => {
    const { calls, request } = recorder();
    await releaseRoute(request, "r");
    expect(calls[0]?.path).toBe("/api/admin/vpn-bridge-routes/r?confirmed=true");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("sends the probe and operator verification bodies the API expects", async () => {
    const a = recorder();
    await verifyRouteByProbe(a.request, "r");
    expect(a.calls[0]?.path).toBe("/api/admin/vpn-bridge-routes/r/verify");
    expect(bodyOf(a.calls[0])).toEqual({ method: "probe" });
    const b = recorder();
    await verifyRouteByOperator(b.request, "r", "marker-1");
    expect(bodyOf(b.calls[0])).toEqual({
      method: "operator",
      registrationMarker: "marker-1",
      confirmHandshakeAndHttp: true,
    });
  });

  it("creates and renames bridges", async () => {
    const a = recorder();
    await createBridge(a.request, {
      name: "A",
      publicIpv4: "198.51.100.10",
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
    expect(bodyOf(a.calls[0]).udpPortEnd).toBe(41031);
    const b = recorder();
    await renameBridge(b.request, "id", "B");
    expect(b.calls[0]?.path).toBe("/api/admin/vpn-bridges/id");
    expect(bodyOf(b.calls[0])).toEqual({ name: "B" });
  });
});

describe("fetchTestConfig", () => {
  const fakeFetch =
    (make: () => Response, urls: string[] = []): typeof fetch =>
    (input) => {
      urls.push(typeof input === "string" ? input : "non-string");
      return Promise.resolve(make());
    };

  it("returns the body, filename and decoded marker", async () => {
    const result = await fetchTestConfig(
      "r",
      "k",
      fakeFetch(
        () =>
          new Response("vpn://x", {
            status: 200,
            headers: {
              "content-disposition": 'attachment; filename="My node.vpn"',
              "x-bridge-registration-marker": encodeURIComponent("run 42"),
            },
          }),
      ),
    );
    expect(await result.blob.text()).toBe("vpn://x");
    expect(result.filename).toBe("My node.vpn");
    expect(result.marker).toBe("run 42");
  });

  it("has a null marker when none is observed", async () => {
    const result = await fetchTestConfig("r", "k", fakeFetch(() => new Response("x")));
    expect(result.marker).toBeNull();
    expect(result.filename).toBe("bridge-test.vpn");
  });

  it("surfaces the API error code", async () => {
    await expect(
      fetchTestConfig(
        "r",
        "k",
        fakeFetch(
          () =>
            new Response(
              JSON.stringify({ error: "BRIDGE_TEST_KEY_UNSUITABLE", message: "no" }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
        ),
      ),
    ).rejects.toMatchObject({ code: "BRIDGE_TEST_KEY_UNSUITABLE", status: 409 });
  });

  it("requests the route's test-config with the key id", async () => {
    const urls: string[] = [];
    await fetchTestConfig("r1", "k 1", fakeFetch(() => new Response("x"), urls));
    expect(urls).toEqual([
      "/api/control/api/admin/vpn-bridge-routes/r1/test-config?keyId=k%201",
    ]);
  });
});

describe("agent update requests", () => {
  it("previews with a GET and requests exactly the given digest", async () => {
    const a = recorder();
    await getAgentUpdate(a.request, "b1");
    expect(a.calls[0]?.path).toBe("/api/admin/vpn-bridges/b1/agent-update");
    expect(a.calls[0]?.init).toBeUndefined();
    const b = recorder();
    await requestAgentUpdate(b.request, "b1", `sha256:${"a".repeat(64)}`);
    expect(b.calls[0]?.path).toBe("/api/admin/vpn-bridges/b1/agent-update");
    expect(b.calls[0]?.init?.method).toBe("POST");
    expect(bodyOf(b.calls[0])).toEqual({ imageDigest: `sha256:${"a".repeat(64)}` });
  });
});
