import { describe, expect, it } from "vitest";
import {
  bridgeFrpProxyName,
  bridgeRouteCandidateCheckPayloadSchema,
  decodeRegistrationMarkerHeader,
  encodeRegistrationMarkerHeader,
  probeCapabilityInputOf,
  probeSupportsBridgeMeasurement,
  verifyBridgeRouteRequestSchema,
  classifyPublicIpv4,
  createBridgeRequestSchema,
  infrastructureItemSchema,
  parseBridgeJobsEnabled,
  parseBridgeObservationStaleMs,
  prepareBridgeRouteRequestSchema,
  publicIpv4Schema,
  updateBridgeRequestSchema,
  updateNodeRequestSchema,
} from "./index.js";

const nonpublic = [
  "0.0.0.0",
  "0.255.255.255",
  "10.0.0.1",
  "10.255.255.255",
  "100.64.0.1",
  "100.127.255.255",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.8",
  "192.0.2.10",
  "192.168.1.1",
  "198.18.0.1",
  "198.19.255.255",
  "198.51.100.7",
  "203.0.113.9",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
];

describe("classifyPublicIpv4", () => {
  it.each(nonpublic)("rejects %s", (ip) => {
    expect(classifyPublicIpv4(ip).ok).toBe(false);
  });

  it.each(["8.8.8.8", "45.10.20.30", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "198.20.0.1", "223.255.255.255"])(
    "accepts %s",
    (ip) => {
      expect(classifyPublicIpv4(ip)).toEqual({ ok: true, address: ip });
    },
  );

  it.each([
    "example.com",
    "1.2.3.4:5",
    "http://1.2.3.4",
    "::1",
    "2001:db8::1",
    "010.1.1.1",
    "1.2.3.04",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    " 1.2.3.4",
    "1.2.3.4 ",
    "1.2.3.4/32",
    "",
  ])("rejects malformed %j", (ip) => {
    expect(classifyPublicIpv4(ip).ok).toBe(false);
  });

  it("is exposed as a zod schema", () => {
    expect(publicIpv4Schema.safeParse("8.8.8.8").success).toBe(true);
    expect(publicIpv4Schema.safeParse("10.0.0.1").success).toBe(false);
  });
});

describe("createBridgeRequestSchema", () => {
  it("applies the default ports", () => {
    expect(
      createBridgeRequestSchema.parse({ name: " Edge ", publicIpv4: "45.10.20.30" }),
    ).toEqual({
      name: "Edge",
      publicIpv4: "45.10.20.30",
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
  });

  it.each([
    { controlTcpPort: 0 },
    { controlTcpPort: 65_536 },
    { udpPortStart: 0 },
    { udpPortEnd: 65_536 },
    { udpPortStart: 1.5 },
  ])("rejects out-of-bounds ports %j", (ports) => {
    expect(
      createBridgeRequestSchema.safeParse({
        name: "b",
        publicIpv4: "45.10.20.30",
        ...ports,
      }).success,
    ).toBe(false);
  });

  it("requires start <= end but allows a one-port pool", () => {
    const base = { name: "b", publicIpv4: "45.10.20.30" };
    expect(
      createBridgeRequestSchema.safeParse({ ...base, udpPortStart: 5, udpPortEnd: 4 })
        .success,
    ).toBe(false);
    expect(
      createBridgeRequestSchema.safeParse({ ...base, udpPortStart: 5, udpPortEnd: 5 })
        .success,
    ).toBe(true);
  });

  it("rejects an empty name and a private address", () => {
    expect(
      createBridgeRequestSchema.safeParse({ name: " ", publicIpv4: "45.10.20.30" }).success,
    ).toBe(false);
    expect(
      createBridgeRequestSchema.safeParse({ name: "b", publicIpv4: "192.168.0.1" }).success,
    ).toBe(false);
  });
});

describe("updateBridgeRequestSchema", () => {
  it("accepts a rename and rejects an empty patch", () => {
    expect(updateBridgeRequestSchema.safeParse({ name: "New" }).success).toBe(true);
    expect(updateBridgeRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("prepareBridgeRouteRequestSchema", () => {
  const bridgeId = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
  it("takes an optional port within bounds", () => {
    expect(prepareBridgeRouteRequestSchema.safeParse({ bridgeId }).success).toBe(true);
    expect(
      prepareBridgeRouteRequestSchema.safeParse({ bridgeId, publicUdpPort: 41000 }).success,
    ).toBe(true);
    expect(
      prepareBridgeRouteRequestSchema.safeParse({ bridgeId, publicUdpPort: 0 }).success,
    ).toBe(false);
    expect(prepareBridgeRouteRequestSchema.safeParse({ bridgeId: "x" }).success).toBe(
      false,
    );
  });
});

describe("updateNodeRequestSchema bridge assignment", () => {
  const routeId = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

  it("requires the expected revision with a route id or null", () => {
    expect(updateNodeRequestSchema.safeParse({ vpnBridgeRouteId: routeId }).success).toBe(
      false,
    );
    expect(updateNodeRequestSchema.safeParse({ vpnBridgeRouteId: null }).success).toBe(
      false,
    );
    expect(
      updateNodeRequestSchema.safeParse({
        vpnBridgeRouteId: routeId,
        expectedVpnEndpointRevision: 3,
      }).success,
    ).toBe(true);
    expect(
      updateNodeRequestSchema.safeParse({
        vpnBridgeRouteId: null,
        expectedVpnEndpointRevision: 0,
      }).success,
    ).toBe(true);
  });

  it("leaves ordinary patches untouched and omits the assignment", () => {
    const parsed = updateNodeRequestSchema.parse({ name: "n" });
    expect(parsed).toEqual({ name: "n" });
    expect("vpnBridgeRouteId" in parsed).toBe(false);
  });
});

describe("infrastructureItemSchema", () => {
  it("discriminates on kind", () => {
    const now = "2026-11-13T00:00:00.000Z";
    const id = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    expect(
      infrastructureItemSchema.safeParse({
        kind: "vpn",
        id,
        name: "n",
        enabled: true,
        activeRoute: null,
        vpnEndpointRevision: 0,
      }).success,
    ).toBe(true);
    expect(
      infrastructureItemSchema.safeParse({
        kind: "bridge",
        id,
        name: "b",
        publicIpv4: "45.10.20.30",
        controlTcpPort: 7000,
        udpPortStart: 41000,
        udpPortEnd: 41031,
        capacity: 32,
        heldPorts: 0,
        managementStatus: "pending_enrollment",
        lastObservedAt: null,
        routes: [],
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
    expect(infrastructureItemSchema.safeParse({ kind: "other" }).success).toBe(false);
  });
});

describe("bridgeFrpProxyName", () => {
  it("derives the proxy name from the route id", () => {
    expect(bridgeFrpProxyName("abc")).toBe("awg-route-abc");
  });
});

describe("bridge environment parsers", () => {
  it("enables bridge jobs only for the exact value true", () => {
    expect(parseBridgeJobsEnabled(undefined)).toBe(false);
    expect(parseBridgeJobsEnabled("")).toBe(false);
    expect(parseBridgeJobsEnabled("yes")).toBe(false);
    expect(parseBridgeJobsEnabled("true")).toBe(true);
    expect(parseBridgeJobsEnabled(" true ")).toBe(true);
  });

  it("defaults the stale window to five minutes and refuses non-positive values", () => {
    expect(parseBridgeObservationStaleMs(undefined)).toBe(300_000);
    expect(parseBridgeObservationStaleMs("")).toBe(300_000);
    expect(parseBridgeObservationStaleMs("1000")).toBe(1_000);
    expect(() => parseBridgeObservationStaleMs("0")).toThrow();
    expect(() => parseBridgeObservationStaleMs("abc")).toThrow();
  });
});

describe("candidate validation contracts", () => {
  it("accepts a probe request or a confirmed operator attestation only", () => {
    expect(verifyBridgeRouteRequestSchema.safeParse({ method: "probe" }).success).toBe(true);
    expect(
      verifyBridgeRouteRequestSchema.safeParse({
        method: "operator",
        registrationMarker: "client-1 06-13 10:20:30",
        confirmHandshakeAndHttp: true,
      }).success,
    ).toBe(true);
    for (const bad of [
      { method: "operator", registrationMarker: "m-1" },
      { method: "operator", registrationMarker: "m-1", confirmHandshakeAndHttp: false },
      { method: "operator", registrationMarker: "", confirmHandshakeAndHttp: true },
      { method: "operator", registrationMarker: "a".repeat(201), confirmHandshakeAndHttp: true },
      { method: "operator", registrationMarker: "m\r\n1", confirmHandshakeAndHttp: true },
      { method: "probe", extra: 1 },
      { method: "manual" },
    ]) {
      expect(verifyBridgeRouteRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("round-trips a marker through the header encoding", () => {
    const marker = "client-1 06-13 10:20:30 ü";
    const header = encodeRegistrationMarkerHeader(marker);
    expect(header).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeRegistrationMarkerHeader(header)).toBe(marker);
    expect(decodeRegistrationMarkerHeader(undefined)).toBeNull();
    expect(decodeRegistrationMarkerHeader("")).toBeNull();
    expect(decodeRegistrationMarkerHeader("%E0%A4%A")).toBeNull();
    expect(decodeRegistrationMarkerHeader("%0A")).toBeNull();
  });

  it("keeps the candidate check payload to IDs and the marker", () => {
    const payload = {
      routeId: "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a",
      nodeId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
      registrationMarker: "m-1",
      requestedAt: "2026-11-13T00:00:00.000Z",
    };
    expect(bridgeRouteCandidateCheckPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      bridgeRouteCandidateCheckPayloadSchema.safeParse({ ...payload, registrationMarker: null }).success,
    ).toBe(false);
  });

  it("treats an unknown probe capability as unsupported", () => {
    expect(probeSupportsBridgeMeasurement({ capabilities: null })).toBe(false);
    expect(probeSupportsBridgeMeasurement({ capabilities: [] })).toBe(false);
    expect(probeSupportsBridgeMeasurement({ capabilities: ["bridge-measurement"] })).toBe(true);
  });

  it("reads the stored capability column as unknown unless it is a string list", () => {
    expect(probeCapabilityInputOf(null)).toEqual({ capabilities: null });
    expect(probeCapabilityInputOf({ bridge: true })).toEqual({ capabilities: null });
    expect(probeCapabilityInputOf(["bridge-measurement", 1])).toEqual({ capabilities: null });
    expect(
      probeSupportsBridgeMeasurement(probeCapabilityInputOf(["bridge-measurement"])),
    ).toBe(true);
  });
});
