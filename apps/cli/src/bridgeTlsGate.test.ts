import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runBridgeTlsGate } from "./bridgeTlsGate.js";
import { ControlApiResponseError } from "./http.js";

const BRIDGE = "a0000000-0000-4000-8000-000000000001";
const ROUTE = "a0000000-0000-4000-8000-000000000002";
const NODE = "a0000000-0000-4000-8000-000000000003";
const OLD = "a0000000-0000-4000-8000-000000000004";
const NEW = "a0000000-0000-4000-8000-000000000005";
const SINCE = "2026-11-18T12:00:00Z";
const OBSERVED = "2026-11-18T12:00:01.000Z";

const currentRoute = {
  id: ROUTE,
  nodeId: NODE,
  state: "active",
  publicUdpPort: 41000,
  vpnEndpointRevision: 3,
  registration: { status: "online", observedAt: OBSERVED, marker: "current" },
  result: { handshake: true, http: true, download: true },
};

const evidence = (runId = OLD, route = currentRoute) => ({
  bridgeId: BRIDGE,
  probeReady: true,
  latestRunId: runId,
  routes: [route],
});

const baseline = JSON.stringify({
  version: 1,
  bridgeId: BRIDGE,
  routes: [{ id: ROUTE, nodeId: NODE, publicUdpPort: 41000, vpnEndpointRevision: 3, downloadRequired: true }],
});

const run = (responses: readonly unknown[], args: string[], snapshot = baseline) => {
  const api = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
  for (const response of responses) {
    if (response instanceof Error) api.mockRejectedValueOnce(response);
    else api.mockResolvedValueOnce(response);
  }
  const output = vi.fn<(line: string) => void>();
  const returned = runBridgeTlsGate([BRIDGE, ...args], {
    api,
    input: Readable.from([snapshot]),
    output,
    sleep: () => Promise.resolve(),
  });
  return { api, output, returned };
};

describe("bridge TLS rotation traffic gate", () => {
  it("uses a newly requested run and emits the exact topology without credentials", async () => {
    const { api, output, returned } = run([evidence(), { requestedRunId: NEW }, evidence(NEW)], ["baseline"]);
    await returned;
    expect(api.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      [`/api/admin/vpn-bridges/${BRIDGE}/rotation-evidence`, undefined],
      ["/api/admin/reachability/run?requireNew=true", "POST"],
      [`/api/admin/vpn-bridges/${BRIDGE}/rotation-evidence`, undefined],
    ]);
    expect(output).toHaveBeenCalledExactlyOnceWith(baseline);
  });

  it("waits for the occupied slot and verifies only its own fresh run", async () => {
    const pending = new ControlApiResponseError("Queued", 409, "PROBE_RUN_PENDING");
    const { api, returned } = run(
      [evidence(), pending, evidence(), { requestedRunId: NEW }, evidence(OLD), evidence(NEW)],
      ["verify", SINCE],
    );
    await returned;
    expect(api.mock.calls.map(([, init]) => init?.method))
      .toEqual([undefined, "POST", undefined, "POST", undefined, undefined]);
  });

  it("fails on a conflict unrelated to the pending probe run", async () => {
    const conflict = new ControlApiResponseError("Other conflict", 409, "OTHER_CONFLICT");
    const { api, returned } = run([evidence(), conflict], ["baseline"]);
    await expect(returned).rejects.toBe(conflict);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("disregards an older run even when it was ingested after restart and looks healthy", async () => {
    const { api, output, returned } = run([evidence(), { requestedRunId: NEW }, evidence(OLD), evidence(NEW)], ["verify", SINCE]);
    await returned;
    expect(api).toHaveBeenCalledTimes(4);
    expect(output).not.toHaveBeenCalled();
  });

  it.each([["baseline"], ["verify", SINCE]])(
    "rejects an exact probe result for a route whose FRP registration changed after requesting it (%s)",
    async (...args) => {
      const replaced = { ...currentRoute, registration: { ...currentRoute.registration, marker: "replacement" } };
      const { output, returned } = run([evidence(), { requestedRunId: NEW }, evidence(NEW, replaced)], args);
      await expect(returned).rejects.toThrow(/FRP registration changed/);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("rejects changed route membership or revision and retiring paths", async () => {
    const changed = run([evidence(), { requestedRunId: NEW }, evidence(NEW, { ...currentRoute, vpnEndpointRevision: 4 })], ["verify", SINCE]);
    await expect(changed.returned).rejects.toThrow(/topology changed/);
    const retiring = run([evidence(OLD, { ...currentRoute, state: "retiring" })], ["baseline"]);
    await expect(retiring.returned).rejects.toThrow(/retiring/);
    expect(retiring.api).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ handshake: false, http: true, download: true }, "handshake"],
    [{ handshake: true, http: false, download: true }, "HTTP"],
    [{ handshake: true, http: true, download: false }, "download"],
    [{ handshake: true, http: true, download: null }, "download"],
  ])("rejects a current run missing required data-plane evidence", async (result, reason) => {
    const failed = { ...currentRoute, result };
    const { returned } = run([evidence(), { requestedRunId: NEW }, evidence(NEW, failed as typeof currentRoute)], ["verify", SINCE]);
    await expect(returned).rejects.toThrow(reason);
  });

  it("waits for a fresh registered route rather than reusing a pre-restart observation", async () => {
    const stale = { ...currentRoute, registration: { ...currentRoute.registration, observedAt: "2026-11-18T11:59:59.000Z" } };
    const { api, returned } = run([evidence(), { requestedRunId: NEW }, evidence(NEW, stale), evidence(NEW)], ["verify", SINCE]);
    await returned;
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("does not start the AWG run before the restarted FRP route registers", async () => {
    const old = { ...currentRoute, registration: { ...currentRoute.registration, observedAt: "2026-11-18T11:59:59.000Z" } };
    const { api, returned } = run([evidence(OLD, old), evidence(), { requestedRunId: NEW }, evidence(NEW)], ["verify", SINCE]);
    await returned;
    expect(api.mock.calls.map(([, init]) => init?.method)).toEqual([undefined, undefined, "POST", undefined]);
  });

  it("rejects a token for another bridge before asking the API to run", async () => {
    const { api, returned } = run([], ["verify", SINCE], baseline.replace(BRIDGE, NODE));
    await expect(returned).rejects.toThrow(/different bridge/);
    expect(api).not.toHaveBeenCalled();
  });
});
