import { describe, expect, it } from "vitest";

import {
  BRIDGE_MANAGEMENT_HOSTS_DEFAULT,
  bridgeAgentPollDeduplicationKey,
  classifyBridgeAgentIdentity,
  classifyBridgeAgentStatus,
  isAllowedBridgeManagementUrl,
  normalizeBridgeManagementUrl,
  parseBridgeManagementHosts,
} from "./bridgeAgent.js";
import { bridgeManagementApiUrlSchema, updateBridgeRequestSchema } from "./bridges.js";

const BRIDGE_ID = "6f1d2c1e-7d0f-4a8e-9f0a-3c3d5e8b1a01";
const OTHER_ID = "0b6a9d3c-1e2f-4a5b-8c7d-9e0f1a2b3c4d";
const MARKER = "0123456789abcdef0123456789abcdef";

const status = (overrides: Record<string, unknown> = {}) => ({
  bridgeId: BRIDGE_ID,
  agentVersion: "0.1.0",
  apiVersion: 1,
  observedAt: "2026-11-13T10:00:00.000Z",
  frps: { reachable: true, version: "0.72.0" },
  applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
  proxies: [
    { proxyId: "awg-route-a", remotePort: 41000, online: true, registrationMarker: MARKER },
  ],
  errors: [],
  ...overrides,
});

const ok = (body: unknown) => ({ kind: "response" as const, status: 200, body });

describe("classifyBridgeAgentStatus", () => {
  it("accepts a v1 status for the expected bridge", () => {
    expect(classifyBridgeAgentStatus(BRIDGE_ID, ok(status()))).toEqual({
      kind: "ok",
      agentVersion: "0.1.0",
      agentApiVersion: 1,
      frpsReachable: true,
      frpsVersion: "0.72.0",
      proxies: [
        { proxyId: "awg-route-a", remotePort: 41000, online: true, registrationMarker: MARKER },
      ],
      unreadableProxyIds: [],
      errorCode: null,
    });
  });

  it("keeps a foreign proxy on remote port 0 (frps reports 0..65535)", () => {
    const outcome = classifyBridgeAgentStatus(
      BRIDGE_ID,
      ok(
        status({
          proxies: [
            { proxyId: "awg-route-a", remotePort: 41000, online: true, registrationMarker: MARKER },
            { proxyId: "foreign", remotePort: 0, online: true, registrationMarker: null },
          ],
        }),
      ),
    );
    expect(outcome).toMatchObject({ kind: "ok", unreadableProxyIds: [], errorCode: null });
    expect(outcome.kind === "ok" && outcome.proxies.map((proxy) => proxy.proxyId)).toEqual([
      "awg-route-a",
      "foreign",
    ]);
  });

  it("drops unreadable proxy entries one by one instead of rejecting the status", () => {
    const outcome = classifyBridgeAgentStatus(
      BRIDGE_ID,
      ok(
        status({
          proxies: [
            { proxyId: "awg-route-a", remotePort: 41000, online: true, registrationMarker: MARKER },
            // A route's own entry with an unusable marker: its name is kept.
            { proxyId: "awg-route-b", remotePort: 41001, online: true, registrationMarker: "a\nb" },
            { proxyId: "foreign", remotePort: 70_000, online: true, registrationMarker: null },
            "not an object",
            { remotePort: 41002 },
          ],
        }),
      ),
    );
    expect(outcome).toMatchObject({
      kind: "ok",
      proxies: [{ proxyId: "awg-route-a" }],
      unreadableProxyIds: ["awg-route-b", "foreign"],
      errorCode: "PROXY_ENTRY_INVALID",
    });
  });

  it("drops the proxy list when frps is unreachable: it means unknown, not absent", () => {
    const outcome = classifyBridgeAgentStatus(
      BRIDGE_ID,
      ok(
        status({
          frps: { reachable: false, version: null },
          proxies: [],
          errors: [{ code: "FRPS_UNREACHABLE", message: "frps did not answer" }],
        }),
      ),
    );
    expect(outcome).toMatchObject({
      kind: "ok",
      frpsReachable: false,
      proxies: [],
      errorCode: "FRPS_UNREACHABLE",
    });
  });

  it("never accepts proxies reported for another bridge id", () => {
    expect(classifyBridgeAgentStatus(BRIDGE_ID, ok(status({ bridgeId: OTHER_ID })))).toEqual({
      kind: "identity_mismatch",
      errorCode: "AGENT_IDENTITY_MISMATCH",
    });
  });

  it("classifies another API version or a non-v1 body as unsupported", () => {
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, ok(status({ apiVersion: 2, agentVersion: "9.0.0" }))),
    ).toEqual({
      kind: "unsupported",
      errorCode: "AGENT_API_UNSUPPORTED",
      agentVersion: "9.0.0",
      agentApiVersion: 2,
    });
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, ok(status({ proxies: "nope" }))),
    ).toMatchObject({ kind: "unsupported", errorCode: "AGENT_MALFORMED_RESPONSE" });
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, { kind: "response", status: 404, body: null }),
    ).toMatchObject({ kind: "unsupported", errorCode: "AGENT_API_UNSUPPORTED" });
    // A marker with a control character never reaches storage: the entry
    // is dropped and its name reported as unreadable.
    expect(
      classifyBridgeAgentStatus(
        BRIDGE_ID,
        ok(
          status({
            proxies: [
              { proxyId: "awg-route-a", remotePort: 41000, online: true, registrationMarker: "a\nb" },
            ],
          }),
        ),
      ),
    ).toMatchObject({ kind: "ok", proxies: [], unreadableProxyIds: ["awg-route-a"] });
  });

  it("classifies no answer, a rejected credential and server errors as down", () => {
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, { kind: "failed", code: "AGENT_TIMEOUT" }),
    ).toEqual({ kind: "down", errorCode: "AGENT_TIMEOUT" });
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, { kind: "failed", code: "AGENT_UNREACHABLE" }),
    ).toEqual({ kind: "down", errorCode: "AGENT_UNREACHABLE" });
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, { kind: "response", status: 401, body: null }),
    ).toEqual({ kind: "down", errorCode: "AGENT_UNAUTHORIZED" });
    expect(
      classifyBridgeAgentStatus(BRIDGE_ID, { kind: "response", status: 500, body: null }),
    ).toEqual({ kind: "down", errorCode: "AGENT_HTTP_ERROR" });
  });
});

describe("classifyBridgeAgentIdentity", () => {
  const identity = (overrides: Record<string, unknown> = {}) =>
    ok({
      bridgeId: BRIDGE_ID,
      agentVersion: "0.1.0",
      apiVersion: 1,
      capabilities: ["status.v1"],
      ...overrides,
    });

  it("requires the expected id, API version 1 and status.v1", () => {
    expect(classifyBridgeAgentIdentity(BRIDGE_ID, identity()).kind).toBe("ok");
    expect(classifyBridgeAgentIdentity(BRIDGE_ID, identity({ bridgeId: OTHER_ID })).kind).toBe(
      "identity_mismatch",
    );
    expect(classifyBridgeAgentIdentity(BRIDGE_ID, identity({ apiVersion: 2 })).kind).toBe(
      "unsupported",
    );
    expect(classifyBridgeAgentIdentity(BRIDGE_ID, identity({ capabilities: [] })).kind).toBe(
      "unsupported",
    );
    expect(classifyBridgeAgentIdentity(BRIDGE_ID, ok({ hello: 1 })).kind).toBe("unsupported");
    expect(
      classifyBridgeAgentIdentity(BRIDGE_ID, { kind: "response", status: 401, body: null }).kind,
    ).toBe("unauthorized");
    expect(
      classifyBridgeAgentIdentity(BRIDGE_ID, { kind: "failed", code: "AGENT_TIMEOUT" }).kind,
    ).toBe("unreachable");
  });
});

describe("management destinations", () => {
  it("defaults to the tunnel host and normalizes the list", () => {
    expect(parseBridgeManagementHosts(undefined)).toEqual(BRIDGE_MANAGEMENT_HOSTS_DEFAULT);
    expect(parseBridgeManagementHosts(" ")).toEqual(["host.docker.internal"]);
    expect(parseBridgeManagementHosts("A.example, [::1] ,127.0.0.1")).toEqual([
      "a.example",
      "::1",
      "127.0.0.1",
    ]);
    expect(() => parseBridgeManagementHosts("a.example/path")).toThrow(
      /VPN_BRIDGE_MANAGEMENT_HOSTS/,
    );
    expect(
      parseBridgeManagementHosts("Host.Docker.Internal:7605, [::1]:7606, ::1"),
    ).toEqual(["host.docker.internal:7605", "[::1]:7606", "::1"]);
    for (const bad of ["a.example:0", "a.example:65536", "a.example:x", "[::1]:", "http://a.example"]) {
      expect(() => parseBridgeManagementHosts(bad), bad).toThrow(/VPN_BRIDGE_MANAGEMENT_HOSTS/);
    }
  });

  it("pins an entry with a port to that port", () => {
    const hosts = parseBridgeManagementHosts("host.docker.internal:7605,[::1]:7606");
    expect(isAllowedBridgeManagementUrl("http://host.docker.internal:7605", hosts)).toBe(true);
    expect(isAllowedBridgeManagementUrl("http://host.docker.internal:7606", hosts)).toBe(false);
    // No port in the URL is the scheme's default, which is not 7605.
    expect(isAllowedBridgeManagementUrl("http://host.docker.internal", hosts)).toBe(false);
    expect(isAllowedBridgeManagementUrl("http://[::1]:7606", hosts)).toBe(true);
    expect(isAllowedBridgeManagementUrl("http://[::1]:7605", hosts)).toBe(false);
    expect(isAllowedBridgeManagementUrl("http://a.example", ["a.example:80"])).toBe(true);
    expect(isAllowedBridgeManagementUrl("https://a.example", ["a.example:443"])).toBe(true);
  });

  it("allows only the listed hosts", () => {
    const hosts = ["host.docker.internal"];
    expect(isAllowedBridgeManagementUrl("http://host.docker.internal:7605", hosts)).toBe(true);
    expect(isAllowedBridgeManagementUrl("http://HOST.docker.internal:7605/", hosts)).toBe(true);
    expect(isAllowedBridgeManagementUrl("http://198.51.100.7:7605", hosts)).toBe(false);
    expect(isAllowedBridgeManagementUrl("http://host.docker.internal.evil:7605", hosts)).toBe(
      false,
    );
    expect(isAllowedBridgeManagementUrl("ftp://host.docker.internal", hosts)).toBe(false);
    expect(isAllowedBridgeManagementUrl("not a url", hosts)).toBe(false);
    expect(isAllowedBridgeManagementUrl("http://[::1]:7605", ["::1"])).toBe(true);
    expect(normalizeBridgeManagementUrl("http://host.docker.internal:7605/")).toBe(
      "http://host.docker.internal:7605",
    );
  });

  it("accepts an origin only in the request contract", () => {
    expect(bridgeManagementApiUrlSchema.safeParse("http://host.docker.internal:7605").success).toBe(
      true,
    );
    for (const value of [
      "http://user:pass@host.docker.internal:7605",
      "http://host.docker.internal:7605/v1",
      "http://host.docker.internal:7605/?a=1",
      "http://host.docker.internal:7605/#x",
      "file:///etc/passwd",
    ]) {
      expect(bridgeManagementApiUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires the URL and the credential together", () => {
    const apiKey = "k".repeat(40);
    expect(
      updateBridgeRequestSchema.safeParse({
        managementApiUrl: "http://host.docker.internal:7605",
        apiKey,
      }).success,
    ).toBe(true);
    expect(updateBridgeRequestSchema.safeParse({ apiKey }).success).toBe(false);
    expect(
      updateBridgeRequestSchema.safeParse({ managementApiUrl: "http://host.docker.internal:7605" })
        .success,
    ).toBe(false);
    expect(
      updateBridgeRequestSchema.safeParse({
        managementApiUrl: "http://host.docker.internal:7605",
        apiKey: "short",
      }).success,
    ).toBe(false);
    expect(
      updateBridgeRequestSchema.safeParse({
        managementApiUrl: "http://host.docker.internal:7605",
        apiKey: `${"k".repeat(40)} x`,
      }).success,
    ).toBe(false);
  });

  it("keys one poll row per bridge", () => {
    expect(bridgeAgentPollDeduplicationKey(BRIDGE_ID)).toBe(`bridge_agent.poll:${BRIDGE_ID}`);
  });
});
