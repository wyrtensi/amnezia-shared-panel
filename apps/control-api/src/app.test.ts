import { describe, expect, it, vi } from "vitest";
import { CONFIG_REFRESH_STALE, ROUTE_DOMAINS_UNSUPPORTED } from "@amnezia/contracts";
import type { ClientRelease } from "@amnezia/contracts";
import { buildApp } from "./app.js";
import type { ClientReleaseResolver } from "./clientReleases.js";
import { parseEnvironment } from "./main.js";
import { ApiError, type ControlApiService } from "./service.js";

const user = {
  id: "f5e8308c-e09d-4d55-9b5d-da1597f486e6",
  email: "employee@example.com",
  displayName: "Employee",
  role: "user" as const,
  status: "active" as const,
};

const reachabilityProbeView = {
  label: "Testland",
  apiBaseUrl: "http://127.0.0.1:8090",
  enabled: true,
  controlUrl: "https://control.example.com/",
  egressUrl: "https://api.ipify.org",
  intervalSec: 3600,
  failThreshold: 2,
  staleAfterSec: 10800,
  lastResultAt: null,
  lastError: null,
  lastErrorAt: null,
  stale: false,
  runInFlight: false,
  runRequestedAt: null,
  timeZone: "UTC",
  widgetUpdatedAt: null,
  widgetLastError: null,
};

const bridgeNodeId = "9b2f6c1e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const bridgeFixture = {
  id: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  name: "Bridge A",
  publicIpv4: "45.10.20.30",
  controlTcpPort: 7000,
  udpPortStart: 41000,
  udpPortEnd: 41031,
  capacity: 32,
  heldPorts: 0,
  managementStatus: "pending_enrollment" as const,
  lastObservedAt: null,
  routes: [],
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
};
const bridgeRouteFixture = {
  id: "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a",
  nodeId: bridgeNodeId,
  bridgeId: bridgeFixture.id,
  publicUdpPort: 41000,
  state: "draft" as const,
  frpProxyName: "awg-route-0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a",
  observedOnline: null,
  observedRegistrationMarker: null,
  observedAt: null,
  verificationMethod: null,
  verifiedRegistrationMarker: null,
  verifiedAt: null,
  verificationResult: null,
  verificationError: null,
  activatedAt: null,
  retiringSince: null,
  createdAt: "2026-11-13T00:00:00.000Z",
  bridgeName: "Bridge A",
  bridgePublicIpv4: "45.10.20.30",
  bridgeControlTcpPort: 7000,
  bridgeManagementStatus: "pending_enrollment" as const,
  bridgeLastObservedAt: null,
};

const createService = (): ControlApiService => ({
  resolveIdentity: vi.fn(() => Promise.resolve(user)),
  getMe: vi.fn(() =>
    Promise.resolve({ ...user, keyLimit: 5, keyCount: 1 }),
  ),
  ackNotice: vi.fn(() => Promise.resolve({ install: 1, update: 1 })),
  listNodes: vi.fn(() => Promise.resolve([])),
  listKeys: vi.fn(() => Promise.resolve([])),
  requestKey: vi.fn(() => Promise.resolve({
    id: "key-1",
    state: "provisioning" as const,
  })),
  getKeyConfig: vi.fn(() => Promise.resolve({
    format: "vpn" as const,
    contentType: "text/plain",
    body: "vpn://payload",
  })),
  revokeOwnKey: vi.fn(() => Promise.resolve()),
  rotateOwnKey: vi.fn(() => Promise.resolve()),
  getConfigRefresh: vi.fn(() => Promise.resolve({ eligible: false as const })),
  refreshOwnConfig: vi.fn(() => Promise.resolve({ revision: 1 })),
  renameOwnKey: vi.fn(() =>
    Promise.resolve({
      id: "key-1",
      state: "active" as const,
      reissued: false,
    }),
  ),
  updateMyCustomRoutes: vi.fn(() =>
    Promise.resolve({
      ru_blacklist: { cidrs: [], domains: [] },
    }),
  ),
  listRouteProfiles: vi.fn(() => Promise.resolve([])),
  getRuleVersion: vi.fn(() => Promise.resolve({ id: "rule-1" })),
  getRulesRefreshStatus: vi.fn(() =>
    Promise.resolve({
      status: "idle" as const,
      queuedAt: null,
      completedAt: null,
      lastError: null,
    }),
  ),
  getAccessSyncStatus: vi.fn(() =>
    Promise.resolve({
      status: "idle" as const,
      queuedAt: null,
      completedAt: null,
      lastError: null,
    }),
  ),
  diffRuleVersions: vi.fn(() => Promise.resolve({ diff: {} })),
  listQuotaRequests: vi.fn(() => Promise.resolve([])),
  createQuotaRequest: vi.fn(() =>
    Promise.resolve({ id: "quota-1", status: "pending" }),
  ),
  getAdminOverview: vi.fn(() =>
    Promise.resolve({ pendingQuotaRequests: 0 }),
  ),
  trafficSeries: vi.fn(() => Promise.resolve([])),
  nodeTrafficPeriods: vi.fn(() => Promise.resolve([])),
    createUser: vi.fn(() => Promise.resolve({ id: "user-x" })),
createNode: vi.fn(() => Promise.resolve({ id: "node-1" })),
  updateNode: vi.fn(() => Promise.resolve({ id: "node-1" })),
  deleteNode: vi.fn(() => Promise.resolve({ id: "node-1", deleted: true })),
  adminList: vi.fn(() => Promise.resolve([])),
  adminAction: vi.fn(() => Promise.resolve({ ok: true })),
  createServiceCheck: vi.fn(() => Promise.resolve({ id: "check-1" })),
  updateServiceCheck: vi.fn(() => Promise.resolve({ id: "check-1" })),
  deleteServiceCheck: vi.fn(() => Promise.resolve({ id: "check-1" })),
  runServiceCheckNow: vi.fn(() => Promise.resolve({ id: "check-1" })),
  resetServiceCheckResults: vi.fn(() => Promise.resolve({ cleared: 3 })),
  getReachability: vi.fn(() => Promise.resolve({ probe: null, nodes: [] })),
  upsertReachabilityProbe: vi.fn(() => Promise.resolve(reachabilityProbeView)),
  deleteReachabilityProbe: vi.fn(() => Promise.resolve()),
  runReachabilityNow: vi.fn(() => Promise.resolve(reachabilityProbeView)),
  listReachabilityHistory: vi.fn(() => Promise.resolve([])),
  listBridges: vi.fn(() => Promise.resolve([])),
  createBridge: vi.fn(() => Promise.resolve(bridgeFixture)),
  updateBridge: vi.fn(() => Promise.resolve(bridgeFixture)),
  deleteBridge: vi.fn(() =>
    Promise.resolve({ id: bridgeFixture.id, deleted: true as const }),
  ),
  getBridgeEligibility: vi.fn(() =>
    Promise.resolve({
      nodeId: bridgeNodeId,
      total: 0,
      awg31Eligible: 0,
      awg20Direct: 0,
      awg2NativeDirect: 0,
      unsupported: 0,
    }),
  ),
  getNodeBridgeRoutes: vi.fn(() =>
    Promise.resolve({
      nodeId: bridgeNodeId,
      vpnEndpointRevision: 0,
      activeRoute: null,
      drafts: [],
      retiring: [],
    }),
  ),
  prepareBridgeRoute: vi.fn(() =>
    Promise.resolve({ created: true, route: bridgeRouteFixture }),
  ),
  releaseBridgeRoute: vi.fn(() =>
    Promise.resolve({
      id: bridgeRouteFixture.id,
      released: true as const,
      nodeId: bridgeNodeId,
      bridgeId: bridgeFixture.id,
      publicUdpPort: 41000,
    }),
  ),
  listInfrastructure: vi.fn(() => Promise.resolve([])),
  getBridgeRouteTestConfig: vi.fn(() =>
    Promise.resolve({
      contentType: "text/plain; charset=utf-8",
      body: "vpn://test-config",
      filename: "Node A.vpn",
      registrationMarker: null as string | null,
    }),
  ),
  verifyBridgeRoute: vi.fn(() =>
    Promise.resolve({
      method: "operator" as const,
      routeId: bridgeRouteFixture.id,
      route: bridgeRouteFixture,
    }),
  ),
});

describe("control API identity boundary", () => {
  it("allows the development identity adapter only in development", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { "x-dev-user-email": "Employee@Example.com" },
    });

    expect(response.statusCode).toBe(200);
    const resolveIdentity = vi.mocked(service.resolveIdentity);
    expect(resolveIdentity).toHaveBeenCalledWith({
      provider: "dev",
      subject: "employee@example.com",
      email: "employee@example.com",
    });
    await app.close();
  });

  it("does not trust the development header in production", async () => {
    const app = await buildApp({
      service: createService(),
      environment: "production",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { "x-dev-user-email": "employee@example.com" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("falls back to the identity adapter when the dev header is absent", async () => {
    const service = createService();
    const identityAdapter = vi.fn(() =>
      Promise.resolve({
        provider: "test",
        subject: "adapter@example.com",
        email: "adapter@example.com",
      }),
    );
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
      identityAdapter,
    });

    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(200);
    expect(identityAdapter).toHaveBeenCalledTimes(1);
    const resolveIdentity = vi.mocked(service.resolveIdentity);
    expect(resolveIdentity).toHaveBeenCalledWith({
      provider: "test",
      subject: "adapter@example.com",
      email: "adapter@example.com",
    });
    await app.close();
  });

  it("prefers the dev header over the identity adapter when both are present", async () => {
    const service = createService();
    const identityAdapter = vi.fn(() =>
      Promise.resolve({
        provider: "test",
        subject: "adapter@example.com",
        email: "adapter@example.com",
      }),
    );
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
      identityAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { "x-dev-user-email": "dev@example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(identityAdapter).not.toHaveBeenCalled();
    const resolveIdentity = vi.mocked(service.resolveIdentity);
    expect(resolveIdentity).toHaveBeenCalledWith({
      provider: "dev",
      subject: "dev@example.com",
      email: "dev@example.com",
    });
    await app.close();
  });

  it("does not honour the dev header without an explicit opt-in, even in development", async () => {
    const app = await buildApp({
      service: createService(),
      environment: "development",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { "x-dev-user-email": "employee@example.com" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("fails closed when NODE_ENV is missing or invalid", () => {
    expect(() => parseEnvironment(undefined)).toThrowError(
      "NODE_ENV is required and must be development, test, or production",
    );
    expect(() => parseEnvironment("")).toThrowError(
      "NODE_ENV is required and must be development, test, or production",
    );
    expect(() => parseEnvironment("staging")).toThrowError(
      "NODE_ENV must be development, test, or production",
    );
    expect(parseEnvironment("production")).toBe("production");
    expect(parseEnvironment("development")).toBe("development");
    expect(parseEnvironment("test")).toBe("test");
  });
});

describe("control API authorization", () => {
  it("passes the authenticated owner to config retrieval", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=vpn",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("vpn://payload");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const getKeyConfig = vi.mocked(service.getKeyConfig);
    expect(getKeyConfig).toHaveBeenCalledWith(
      user,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      "vpn",
      false,
    );
    await app.close();
  });

  // The panel adds `rev` after a config refresh so the browser loads the QR
  // again; the API must take it and ignore it.
  it("ignores the revision the panel adds to a config URL", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=vpn&rev=3",
      headers: { "x-dev-user-email": user.email },
    });
    expect(response.statusCode).toBe(200);
    expect(vi.mocked(service.getKeyConfig)).toHaveBeenCalledWith(
      user,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      "vpn",
      false,
    );
    await app.close();
  });

  it("does not coerce the literal false query value to true", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?adminConfirmed=false",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(service.getKeyConfig).toHaveBeenCalledWith(
      user,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      "vpn",
      false,
    );
    await app.close();
  });

  it("renames a key and reports 202 when a rotate was queued", async () => {
    const service = createService();
    vi.mocked(service.renameOwnKey).mockResolvedValue({
      id: "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      state: "provisioning",
      reissued: true,
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/rename",
      headers: { "x-dev-user-email": user.email },
      payload: { deviceLabel: "  New Laptop  " },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ state: "provisioning", reissued: true });
    // The schema trims before the service ever sees it -- a label of nothing
    // but the surrounding whitespace the user happened to type must not
    // become the stored device label.
    expect(service.renameOwnKey).toHaveBeenCalledWith(
      user,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      "New Laptop",
    );
    await app.close();
  });

  it("reports 200 for a rename that did not need to reissue", async () => {
    const service = createService();
    vi.mocked(service.renameOwnKey).mockResolvedValue({
      id: "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      state: "active",
      reissued: false,
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/rename",
      headers: { "x-dev-user-email": user.email },
      payload: { deviceLabel: "New Laptop" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "active", reissued: false });
    await app.close();
  });

  it("rejects a rename to an empty label instead of calling the service", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/rename",
      headers: { "x-dev-user-email": user.email },
      payload: { deviceLabel: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(service.renameOwnKey).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects admin routes for an employee", async () => {
    const app = await buildApp({
      service: createService(),
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("allows an admin to register a node without returning credentials", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.createNode).mockResolvedValue({
      id: "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      name: "primary",
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/nodes",
      headers: { "x-dev-user-email": admin.email },
      payload: {
        name: "primary",
        apiBaseUrl: "http://127.0.0.1:4001",
        apiKey: "a".repeat(32),
        protocol: "awg2",
        maxPeers: 500,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain("a".repeat(32));
    expect(service.createNode).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ name: "primary", protocol: "awg2" }),
    );
    await app.close();
  });

  // The admin projection carries the full host/IP pair; the route must not
  // filter it, because the node card is the only place an operator can see
  // where clients actually reach a node.
  it("returns each node's public host and resolved IP to admins", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.adminList).mockResolvedValue([
      {
        id: "0b48cc4c-404b-47a6-af28-4cf15f305e30",
        name: "primary",
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
      },
    ]);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/nodes",
      headers: { "x-dev-user-email": admin.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
      }),
    ]);
    expect(service.adminList).toHaveBeenCalledWith(admin, "nodes");
    await app.close();
  });

  // `amnezia-panel key-config` prints these to answer "the QR does not scan".
  // It degrades silently when they are absent -- which is exactly what happened
  // while they were specified but never emitted -- so the route pins them.
  it("reports how the symbol was drawn", async () => {
    const service = createService();
    vi.mocked(service.getKeyConfig).mockResolvedValue({
      format: "qr-svg",
      contentType: "image/svg+xml; charset=utf-8",
      body: "<svg/>",
      qrParams: { errorCorrectionLevel: "L", modules: 113, scale: 8 },
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=qr-svg",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.headers["x-qr-ecc"]).toBe("L");
    expect(response.headers["x-qr-modules"]).toBe("113");
    expect(response.headers["x-qr-scale"]).toBe("8");
    await app.close();
  });

  // The download's name is the connection's name now, and those are written in
  // the operator's language. A single `filename=` is a byte string, so without
  // the `filename*` half every Russian-named key would arrive as `amnezia-key`.
  it("offers a non-Latin download name in both header forms", async () => {
    const service = createService();
    vi.mocked(service.getKeyConfig).mockResolvedValue({
      format: "vpn",
      contentType: "text/plain; charset=utf-8",
      body: "vpn://x",
      filename: "Франкфурт #3.vpn",
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=vpn",
      headers: { "x-dev-user-email": user.email },
    });

    const disposition = String(response.headers["content-disposition"]);
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain("%233.vpn");
    await app.close();
  });

  it("omits the QR parameter headers for a non-QR format", async () => {
    const service = createService();
    vi.mocked(service.getKeyConfig).mockResolvedValue({
      format: "vpn",
      contentType: "text/plain; charset=utf-8",
      body: "vpn://x",
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=vpn",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.headers["x-qr-ecc"]).toBeUndefined();
    await app.close();
  });

  it("accepts qr-svg as a config format", async () => {
    const service = createService();
    vi.mocked(service.getKeyConfig).mockResolvedValue({
      format: "qr-svg",
      contentType: "image/svg+xml; charset=utf-8",
      body: "<svg/>",
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=qr-svg",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    // A display format must not arrive as a download.
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(vi.mocked(service.getKeyConfig)).toHaveBeenCalledWith(
      user,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      "qr-svg",
      false,
    );
    await app.close();
  });

  it("accepts qr-frames as a config format", async () => {
    const service = createService();
    vi.mocked(service.getKeyConfig).mockResolvedValue({
      format: "qr-frames",
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ total: 1, frames: ["<svg/>"] }),
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=qr-frames",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ total: 1, frames: ["<svg/>"] });
    await app.close();
  });

  it("accepts qr-conf as a config format", async () => {
    const service = createService();
    vi.mocked(service.getKeyConfig).mockResolvedValue({
      format: "qr-conf",
      contentType: "image/svg+xml; charset=utf-8",
      body: "<svg/>",
    });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/keys/0b48cc4c-404b-47a6-af28-4cf15f305e30/config?format=qr-conf",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    // A display format, like qr-svg: must not arrive as a download.
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(vi.mocked(service.getKeyConfig)).toHaveBeenCalledWith(
      user,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      "qr-conf",
      false,
    );
    await app.close();
  });
});

describe("custom routes take addresses, not site names", () => {
  it("accepts an address-only update", async () => {
    const service = createService();
    vi.mocked(service.resolveIdentity).mockResolvedValue(user);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/me/custom-routes",
      headers: { "x-dev-user-email": user.email },
      payload: { ru_blacklist: { cidrs: ["203.0.113.0/24"], domains: [] } },
    });

    expect(response.statusCode).toBe(200);
    expect(service.updateMyCustomRoutes).toHaveBeenCalled();
    await app.close();
  });

  // Refused at the edge rather than stored-and-ignored: an entry that is kept
  // but routes nothing is the thing this whole change is removing.
  it("refuses a domain, says why, and never reaches the service", async () => {
    const service = createService();
    vi.mocked(service.resolveIdentity).mockResolvedValue(user);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/me/custom-routes",
      headers: { "x-dev-user-email": user.email },
      payload: { ru_blacklist: { cidrs: [], domains: ["example.com"] } },
    });

    expect(response.statusCode).toBe(400);
    const body: {
      error: string;
      issues: Array<{ message: string; path: string[] }>;
    } = response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.issues[0]?.message).toBe(ROUTE_DOMAINS_UNSUPPORTED);
    expect(body.issues[0]?.path).toEqual(["ru_blacklist", "domains"]);
    expect(service.updateMyCustomRoutes).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/me/notices/:kind", () => {
  const user = {
    id: "f5e8308c-e09d-4d55-9b5d-da1597f486e6",
    email: "employee@example.com",
    displayName: "Employee",
    role: "user" as const,
    status: "active" as const,
  };

  it("records the answer and hands back both counters", async () => {
    const service = createService();
    vi.mocked(service.resolveIdentity).mockResolvedValue(user);
    vi.mocked(service.ackNotice).mockResolvedValue({ install: 0, update: 2 });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/me/notices/update",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    // The whole shape, not just the field that moved: the dialog decides
    // whether to open again from this reply, so a counter dropped on the wire
    // reads as "never signed" and the notice comes back.
    expect(response.json()).toEqual({ notices: { install: 0, update: 2 } });
    expect(service.ackNotice).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id }),
      "update",
    );
    await app.close();
  });

  it("refuses a kind the panel does not have", async () => {
    const service = createService();
    vi.mocked(service.resolveIdentity).mockResolvedValue(user);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/me/notices/newsletter",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(400);
    const body: { error: string } = response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(service.ackNotice).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("admin global route overrides", () => {
  const globalRoutes = {
    ru_blacklist: {
      add: { cidrs: ["203.0.113.0/24"], domains: [] },
      exclude: { cidrs: [], domains: ["example.com"] },
    },
  };

  it("exposes the current overrides to an admin", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.adminList).mockResolvedValue([globalRoutes]);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/global-routes",
      headers: { "x-dev-user-email": admin.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([globalRoutes]);
    expect(service.adminList).toHaveBeenCalledWith(admin, "global-routes");
    await app.close();
  });

  it("routes the update through the admin action handler", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.adminAction).mockResolvedValue(globalRoutes);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/global-routes/global/update",
      headers: { "x-dev-user-email": admin.email },
      payload: globalRoutes,
    });

    expect(response.statusCode).toBe(200);
    expect(service.adminAction).toHaveBeenCalledWith(
      admin,
      "global-routes",
      "global",
      "update",
      globalRoutes,
    );
    await app.close();
  });

  it("passes recommended node ids and the node order through the portal-policy update action", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    const payload = {
      recommendedNodeIds: ["0f1b8b7e-4c3a-4c8d-9d1e-0a1b2c3d4e5f"],
      nodeOrder: [
        "0f1b8b7e-4c3a-4c8d-9d1e-0a1b2c3d4e5f",
        "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      ],
    };
    vi.mocked(service.adminAction).mockResolvedValue({ id: true, ...payload });
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/portal-policy/global/update",
      headers: { "x-dev-user-email": admin.email },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(service.adminAction).toHaveBeenCalledWith(
      admin,
      "portal-policy",
      "global",
      "update",
      payload,
    );
    await app.close();
  });

  it("refuses the portal-policy update to an employee", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/portal-policy/global/update",
      headers: { "x-dev-user-email": user.email },
      payload: { recommendedNodeIds: [], nodeOrder: [] },
    });
    expect(response.statusCode).toBe(403);
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps both global route endpoints away from an employee", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    for (const request of [
      { method: "GET" as const, url: "/api/admin/global-routes" },
      {
        method: "POST" as const,
        url: "/api/admin/global-routes/global/update",
        payload: globalRoutes,
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { "x-dev-user-email": user.email },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(service.adminList).not.toHaveBeenCalled();
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("quota requests target a server", () => {
  it("passes an explicit node id through to the service", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });
    const nodeId = "5b2ad2b8-2c4e-4a3d-8f8e-6f3a1c0d9a11";

    const response = await app.inject({
      method: "POST",
      url: "/api/quota-requests",
      headers: { "x-dev-user-email": user.email },
      payload: { requestedLimit: 7, nodeId, reason: "one more phone" },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createQuotaRequest).toHaveBeenCalledWith(user, {
      requestedLimit: 7,
      nodeId,
      reason: "one more phone",
    });
    await app.close();
  });

  // S8: the key limit mode decides how every number in the panel is read, so a
  // user must never be able to change it. "The dialog does not offer it" is not
  // a guarantee -- a hand-written request has to be refused, and the refusal is
  // what these two tests pin.
  it("refuses a keyLimitMode smuggled into a quota request", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/quota-requests",
      headers: { "x-dev-user-email": user.email },
      payload: { requestedLimit: 5, keyLimitMode: "global" },
    });

    expect(response.statusCode).toBe(400);
    expect(vi.mocked(service.createQuotaRequest)).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a non-admin away from both routes that can set the mode", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    for (const url of [
      "/api/admin/portal-policy/global/update",
      "/api/admin/users/f5e8308c-e09d-4d55-9b5d-da1597f486e6/set-limit",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { "x-dev-user-email": user.email },
        payload: { keyLimitMode: "global" },
      });

      expect(response.statusCode, url).toBe(403);
    }
    await app.close();
  });

  it("accepts a request without a node as an every-server ask", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/quota-requests",
      headers: { "x-dev-user-email": user.email },
      payload: { requestedLimit: 7 },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createQuotaRequest).toHaveBeenCalledWith(user, {
      requestedLimit: 7,
    });
    await app.close();
  });

  it("rejects a node id that is not a uuid before it reaches the service", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/quota-requests",
      headers: { "x-dev-user-email": user.email },
      payload: { requestedLimit: 7, nodeId: "primary" },
    });

    expect(response.statusCode).toBe(400);
    expect(service.createQuotaRequest).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("manual route-feed refresh", () => {
  const status = {
    status: "pending" as const,
    queuedAt: "2026-09-01T10:00:00.000Z",
    completedAt: null,
    lastError: null,
  };

  it("enqueues the refresh through the admin action handler", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.adminAction).mockResolvedValue(status);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/rules/global/refresh",
      headers: { "x-dev-user-email": admin.email },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(service.adminAction).toHaveBeenCalledWith(
      admin,
      "rules",
      "global",
      "refresh",
      {},
    );
    await app.close();
  });

  it("reads the refresh state without colliding with a rule version id", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.getRulesRefreshStatus).mockResolvedValue(status);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/rules/refresh",
      headers: { "x-dev-user-email": admin.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(service.getRulesRefreshStatus).toHaveBeenCalledWith(admin);
    // The static segment wins: it never reaches the rule-version route.
    expect(service.getRuleVersion).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps both refresh endpoints away from an employee", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    for (const request of [
      { method: "GET" as const, url: "/api/admin/rules/refresh" },
      {
        method: "POST" as const,
        url: "/api/admin/rules/global/refresh",
        payload: {},
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { "x-dev-user-email": user.email },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(service.getRulesRefreshStatus).not.toHaveBeenCalled();
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("manual Cloudflare Access sync trigger", () => {
  const status = {
    status: "pending" as const,
    queuedAt: "2026-09-05T10:00:00.000Z",
    completedAt: null,
    lastError: null,
  };

  it("arms the sync through the admin action handler", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.adminAction).mockResolvedValue(status);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/access-sync/global/run",
      headers: { "x-dev-user-email": admin.email },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(service.adminAction).toHaveBeenCalledWith(
      admin,
      "access-sync",
      "global",
      "run",
      {},
    );
    await app.close();
  });

  it("reads the last run's outcome", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.getAccessSyncStatus).mockResolvedValue(status);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/access-sync",
      headers: { "x-dev-user-email": admin.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(service.getAccessSyncStatus).toHaveBeenCalledWith(admin);
    await app.close();
  });

  it("keeps both endpoints away from a non-admin", async () => {
    const service = createService();
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });

    for (const request of [
      { method: "GET" as const, url: "/api/admin/access-sync" },
      {
        method: "POST" as const,
        url: "/api/admin/access-sync/global/run",
        payload: {},
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { "x-dev-user-email": user.email },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(service.getAccessSyncStatus).not.toHaveBeenCalled();
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });
});

const SNAPSHOT: ClientRelease = {
  version: "5.0.1.5",
  releaseUrl: "https://github.com/amnezia-vpn/amnezia-client/releases/tag/5.0.1.5",
  publishedAt: "2026-08-21T14:47:49.000Z",
  fallback: false,
  resolvedAt: "2026-09-02T09:00:00.000Z",
  downloads: [
    {
      platform: "windows",
      primary: {
        url: "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_windows_x64.exe",
        kind: "installer",
        fileName: "AmneziaVPN_5.0.1.5_windows_x64.exe",
        sizeBytes: 91_991_200,
      },
      alternate: null,
      secondAlternate: null,
    },
    {
      platform: "macos",
      primary: {
        url: "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_macos_x64.pkg",
        kind: "installer",
        fileName: "AmneziaVPN_5.0.1.5_macos_x64.pkg",
        sizeBytes: 111_188_003,
      },
      alternate: null,
      secondAlternate: null,
    },
    {
      platform: "android",
      primary: {
        url: "https://play.google.com/store/apps/details?id=org.amnezia.vpn",
        kind: "store",
        fileName: null,
        sizeBytes: null,
      },
      alternate: {
        url: "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_android11%2B_arm64-v8a.apk",
        kind: "installer",
        fileName: "AmneziaVPN_5.0.1.5_android11+_arm64-v8a.apk",
        sizeBytes: 75_586_403,
      },
      secondAlternate: null,
    },
    {
      platform: "ios",
      primary: {
        url: "https://apps.apple.com/us/app/defaultvpn/id6744725017",
        kind: "store",
        fileName: null,
        sizeBytes: null,
      },
      alternate: {
        url: "https://apps.apple.com/us/app/amneziavpn/id1600529900",
        kind: "store",
        fileName: null,
        sizeBytes: null,
      },
      secondAlternate: {
        url: "https://apps.apple.com/us/app/amneziawg/id6478942365",
        kind: "store",
        fileName: null,
        sizeBytes: null,
      },
    },
  ],
};

describe("client release routes", () => {
  // `satisfies`, not an annotation: it still checks the stub against the
  // contract, but keeps the inferred Mock types so the assertions below read a
  // mock property rather than an unbound interface method.
  const stubResolver = () =>
    ({
      get: vi.fn(() => Promise.resolve(SNAPSHOT)),
      refresh: vi.fn(() => Promise.resolve(SNAPSHOT)),
    }) satisfies ClientReleaseResolver;

  it("serves the resolver's snapshot to any signed-in user", async () => {
    const clientReleaseResolver = stubResolver();
    const app = await buildApp({
      service: createService(),
      environment: "development",
      allowDevIdentity: true,
      clientReleaseResolver,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/client-releases",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SNAPSHOT);
    expect(clientReleaseResolver.get).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("lets the browser cache the answer for a while", async () => {
    const app = await buildApp({
      service: createService(),
      environment: "development",
      allowDevIdentity: true,
      clientReleaseResolver: stubResolver(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/client-releases",
      headers: { "x-dev-user-email": user.email },
    });

    // Private: the route sits behind the panel's identity check.
    expect(response.headers["cache-control"]).toBe("private, max-age=1800");
    await app.close();
  });

  // The QR is an image this panel serves, so what it encodes must come from the
  // release the panel resolved and never from the request. `variant` selects
  // among a platform's known links; anything else falls back to the primary
  // rather than reaching for a URL the caller supplied.
  describe("the download QR", () => {
    const qr = async (url: string) => {
      const app = await buildApp({
        service: createService(),
        environment: "development",
        allowDevIdentity: true,
        clientReleaseResolver: stubResolver(),
      });
      const response = await app.inject({
        method: "GET",
        url,
        headers: { "x-dev-user-email": user.email },
      });
      await app.close();
      return response;
    };

    it("encodes the platform's primary link by default", async () => {
      const response = await qr("/api/client-releases/qr/ios");

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("image/png");
    });

    it("encodes the alternate link when asked for it", async () => {
      const primary = await qr("/api/client-releases/qr/ios");
      const alternate = await qr(
        "/api/client-releases/qr/ios?variant=alternate",
      );

      expect(alternate.statusCode).toBe(200);
      // Two different listings, so two different symbols. Comparing the bytes
      // is what proves the variant reached the encoder at all.
      expect(alternate.rawPayload.equals(primary.rawPayload)).toBe(false);
    });

    it("encodes the secondAlternate link when asked for it", async () => {
      const primary = await qr("/api/client-releases/qr/ios");
      const alternate = await qr(
        "/api/client-releases/qr/ios?variant=alternate",
      );
      const secondAlternate = await qr(
        "/api/client-releases/qr/ios?variant=secondAlternate",
      );

      expect(secondAlternate.statusCode).toBe(200);
      // Three distinct listings must encode to three distinct symbols.
      expect(
        secondAlternate.rawPayload.equals(primary.rawPayload),
      ).toBe(false);
      expect(
        secondAlternate.rawPayload.equals(alternate.rawPayload),
      ).toBe(false);
    });

    it("404s a platform with no secondAlternate", async () => {
      const response = await qr(
        "/api/client-releases/qr/android?variant=secondAlternate",
      );

      expect(response.statusCode).toBe(404);
    });

    it("ignores a variant it does not know", async () => {
      const primary = await qr("/api/client-releases/qr/ios");
      const bogus = await qr(
        "/api/client-releases/qr/ios?variant=https://evil.example",
      );

      expect(bogus.statusCode).toBe(200);
      expect(bogus.rawPayload.equals(primary.rawPayload)).toBe(true);
    });

    it("404s a platform with no alternate", async () => {
      const response = await qr(
        "/api/client-releases/qr/windows?variant=alternate",
      );

      expect(response.statusCode).toBe(404);
    });
  });

  it("stays behind the identity gate", async () => {
    const clientReleaseResolver = stubResolver();
    const app = await buildApp({
      service: createService(),
      environment: "production",
      clientReleaseResolver,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/client-releases",
    });

    expect(response.statusCode).toBe(401);
    expect(clientReleaseResolver.get).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets an admin force a re-resolve", async () => {
    const clientReleaseResolver = stubResolver();
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
      clientReleaseResolver,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/client-releases/refresh",
      headers: { "x-dev-user-email": admin.email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SNAPSHOT);
    expect(clientReleaseResolver.refresh).toHaveBeenCalledTimes(1);
    // The refresh must not also be served from the cache.
    expect(clientReleaseResolver.get).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a re-resolve to a non-admin", async () => {
    const clientReleaseResolver = stubResolver();
    const app = await buildApp({
      service: createService(),
      environment: "development",
      allowDevIdentity: true,
      clientReleaseResolver,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/client-releases/refresh",
      headers: { "x-dev-user-email": user.email },
    });

    expect(response.statusCode).toBe(403);
    expect(clientReleaseResolver.refresh).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("service check routes", () => {
  const probe = {
    kind: "http",
    url: "https://gemini.google.com/",
    method: "GET",
    timeoutMs: 10_000,
  };
  const body = {
    name: "Gemini",
    probe,
    assertions: [{ type: "bodyContains", value: "conversation-container" }],
  };

  const adminApp = async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    return {
      service,
      admin,
      app: await buildApp({
        service,
        environment: "development",
        allowDevIdentity: true,
      }),
    };
  };

  it("creates a check and answers 201", async () => {
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/service-checks",
      headers: { "x-dev-user-email": admin.email },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(service.createServiceCheck).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ name: "Gemini", intervalSec: 43_200, enabled: true }),
    );
    await app.close();
  });

  it("refuses a check with no assertions", async () => {
    // Always green, and indistinguishable on the card from one that is passing.
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/service-checks",
      headers: { "x-dev-user-email": admin.email },
      payload: { ...body, assertions: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createServiceCheck).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a probe aimed at the node's own network", async () => {
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/service-checks",
      headers: { "x-dev-user-email": admin.email },
      payload: { ...body, probe: { ...probe, url: "http://localhost/" } },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createServiceCheck).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes only the named fields on an update", async () => {
    // The whole reason the update schema is built from a defaultless shape: a
    // partial of the defaulted one would turn "disable it" into "disable it and
    // reset the period and replace the assertions".
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/service-checks/0b48cc4c-404b-47a6-af28-4cf15f305e30",
      headers: { "x-dev-user-email": admin.email },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(service.updateServiceCheck).toHaveBeenCalledWith(
      admin,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
      { enabled: false },
    );
    await app.close();
  });

  it("routes run as its own endpoint, not as a generic admin action", async () => {
    // `/api/admin/:resource/:id/:action` would otherwise swallow this and hand
    // "service-checks" to adminAction, which knows nothing about them.
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/service-checks/0b48cc4c-404b-47a6-af28-4cf15f305e30/run",
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.runServiceCheckNow).toHaveBeenCalledWith(
      admin,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
    );
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("resets one check's results without deleting the check", async () => {
    // The result IS the schedule, so clearing it makes the check due again
    // rather than losing anything - which is what an operator needs after
    // changing what it asserts.
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/service-checks/0b48cc4c-404b-47a6-af28-4cf15f305e30/results",
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.resetServiceCheckResults).toHaveBeenCalledWith(
      admin,
      "0b48cc4c-404b-47a6-af28-4cf15f305e30",
    );
    expect(service.deleteServiceCheck).not.toHaveBeenCalled();
    await app.close();
  });

  it("resets every check's results on the bare results path", async () => {
    // A static segment beats `:id`, so "results" can never be parsed as a
    // check id and quietly reset one check instead of all of them.
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/service-checks/results",
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.resetServiceCheckResults).toHaveBeenCalledWith(admin, null);
    await app.close();
  });

  it("deletes a check", async () => {
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/service-checks/0b48cc4c-404b-47a6-af28-4cf15f305e30",
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.deleteServiceCheck).toHaveBeenCalled();
    await app.close();
  });

  it("lists checks through the same admin listing as every other resource", async () => {
    const { service, admin, app } = await adminApp();
    vi.mocked(service.adminList).mockResolvedValue([]);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/service-checks",
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.adminList).toHaveBeenCalledWith(admin, "service-checks");
    await app.close();
  });

  it("refuses a non-admin", async () => {
    const service = createService();
    vi.mocked(service.resolveIdentity).mockResolvedValue(user);
    const app = await buildApp({
      service,
      environment: "development",
      allowDevIdentity: true,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/service-checks",
      headers: { "x-dev-user-email": user.email },
      payload: body,
    });
    expect(response.statusCode).toBe(403);
    expect(service.createServiceCheck).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("reachability probe routes", () => {
  const nodeId = "0b48cc4c-404b-47a6-af28-4cf15f305e30";
  const body = {
    label: "Testland",
    apiBaseUrl: "http://127.0.0.1:8090",
    apiKey: "k".repeat(40),
    controlUrl: "https://control.example.com/",
  };

  const appFor = async (role: "admin" | "user") => {
    const service = createService();
    const actor = { ...user, role };
    vi.mocked(service.resolveIdentity).mockResolvedValue(actor);
    return {
      service,
      actor,
      app: await buildApp({
        service,
        environment: "development",
        allowDevIdentity: true,
      }),
    };
  };

  it("reads the view", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/reachability",
      headers: { "x-dev-user-email": actor.email },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ probe: null, nodes: [] });
    expect(service.getReachability).toHaveBeenCalledWith(actor);
    // A static path, never one of the generic admin listings.
    expect(service.adminList).not.toHaveBeenCalled();
    await app.close();
  });

  it("upserts the probe and never echoes the key", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/reachability/probe",
      headers: { "x-dev-user-email": actor.email },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(reachabilityProbeView);
    expect(response.body).not.toContain(body.apiKey);
    expect(service.upsertReachabilityProbe).toHaveBeenCalledWith(actor, body);
    await app.close();
  });

  it("refuses a malformed probe before it reaches the service", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/reachability/probe",
      headers: { "x-dev-user-email": actor.email },
      // The control site is fetched without the tunnel and must be https.
      payload: { ...body, controlUrl: "http://control.example.com/" },
    });
    expect(response.statusCode).toBe(400);
    expect(service.upsertReachabilityProbe).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes the probe with 204", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/reachability/probe",
      headers: { "x-dev-user-email": actor.email },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(service.deleteReachabilityProbe).toHaveBeenCalledWith(actor);
    await app.close();
  });

  it("asks for a run without reaching the generic admin action", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/reachability/run",
      headers: { "x-dev-user-email": actor.email },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(reachabilityProbeView);
    expect(service.runReachabilityNow).toHaveBeenCalledWith(actor);
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("reads a node's history with a default limit", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/reachability/history?nodeId=${nodeId}`,
      headers: { "x-dev-user-email": actor.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.listReachabilityHistory).toHaveBeenCalledWith(actor, {
      nodeId,
      limit: 50,
    });
    await app.close();
  });

  it("passes an explicit history limit through", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/reachability/history?nodeId=${nodeId}&limit=200`,
      headers: { "x-dev-user-email": actor.email },
    });
    expect(response.statusCode).toBe(200);
    expect(service.listReachabilityHistory).toHaveBeenCalledWith(actor, {
      nodeId,
      limit: 200,
    });
    await app.close();
  });

  it.each([
    ["no node", ""],
    ["a node id that is not a uuid", "?nodeId=node-a"],
    ["a limit over the cap", `?nodeId=${nodeId}&limit=201`],
    ["a zero limit", `?nodeId=${nodeId}&limit=0`],
  ])("refuses a history query with %s", async (_name, query) => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/reachability/history${query}`,
      headers: { "x-dev-user-email": actor.email },
    });
    expect(response.statusCode).toBe(400);
    expect(service.listReachabilityHistory).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes reachabilityEnabled through a node patch", async () => {
    const { service, actor, app } = await appFor("admin");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/nodes/${nodeId}`,
      headers: { "x-dev-user-email": actor.email },
      payload: { reachabilityEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(service.updateNode).toHaveBeenCalledWith(actor, nodeId, {
      reachabilityEnabled: false,
    });
    await app.close();
  });

  it.each([
    ["GET", "/api/admin/reachability"],
    ["PUT", "/api/admin/reachability/probe"],
    ["DELETE", "/api/admin/reachability/probe"],
    ["POST", "/api/admin/reachability/run"],
    ["GET", `/api/admin/reachability/history?nodeId=${nodeId}`],
  ] as const)("refuses %s %s to a non-admin", async (method, url) => {
    const { service, actor, app } = await appFor("user");
    const response = await app.inject({
      method,
      url,
      headers: { "x-dev-user-email": actor.email },
      ...(method === "PUT" ? { payload: body } : {}),
    });
    expect(response.statusCode).toBe(403);
    expect(service.getReachability).not.toHaveBeenCalled();
    expect(service.upsertReachabilityProbe).not.toHaveBeenCalled();
    expect(service.deleteReachabilityProbe).not.toHaveBeenCalled();
    expect(service.runReachabilityNow).not.toHaveBeenCalled();
    expect(service.listReachabilityHistory).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * A minimal pino-shaped logger that records the level each call came in at.
 * Fastify only needs these methods plus `child`, and returning `this` from
 * `child` keeps every request logger pointed at the same recorder.
 */
const recordingLogger = () => {
  const calls: Array<{ level: string; code?: string; status?: number }> = [];
  const record = (level: string) => (arg: unknown) => {
    const error = arg as { code?: string; statusCode?: number } | undefined;
    calls.push({ level, code: error?.code, status: error?.statusCode });
  };
  const logger = {
    calls,
    fatal: record("fatal"),
    error: record("error"),
    warn: record("warn"),
    info: () => {},
    debug: () => {},
    trace: () => {},
    silent: () => {},
    level: "info",
    child() {
      return this;
    },
  };
  return logger;
};

// A refusal is the API doing its job. Logging every one of them at `error`
// buries the failures that are the panel's own — which matters most on the
// direct login door, where NOT_ALLOWED arrives as a steady trickle from the
// open internet.
describe("error log levels", () => {
  it("logs a refused request at warn, not error", async () => {
    const logger = recordingLogger();
    const app = await buildApp({
      service: createService(),
      environment: "production",
      allowDevIdentity: true,
      loggerInstance: logger,
    });

    // A regular user on an admin route: 403 FORBIDDEN, thrown deliberately.
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { "x-dev-user-email": "employee@example.com" },
    });

    expect(response.statusCode).toBe(403);
    const refusal = logger.calls.find((call) => call.status === 403);
    expect(refusal?.level).toBe("warn");
    expect(logger.calls.some((call) => call.level === "error")).toBe(false);
    await app.close();
  });

  it("still logs an unexpected failure at error", async () => {
    const logger = recordingLogger();
    const service = createService();
    vi.mocked(service.getMe).mockRejectedValueOnce(new Error("boom"));
    const app = await buildApp({
      service,
      environment: "production",
      allowDevIdentity: true,
      loggerInstance: logger,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { "x-dev-user-email": "employee@example.com" },
    });

    expect(response.statusCode).toBe(500);
    expect(logger.calls.some((call) => call.level === "error")).toBe(true);
    await app.close();
  });
});

describe("config refresh routes", () => {
  const keyId = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
  const token = "ab".repeat(32);
  const devApp = (service: ControlApiService) =>
    buildApp({ service, environment: "development", allowDevIdentity: true });
  const headers = { "x-dev-user-email": "employee@example.com" };

  it("answers the eligibility check privately and uncached", async () => {
    const service = createService();
    vi.mocked(service.getConfigRefresh).mockResolvedValue({
      eligible: true,
      revision: 2,
      refreshToken: token,
    });
    const app = await devApp(service);
    const response = await app.inject({
      method: "GET",
      url: `/api/keys/${keyId}/config-refresh`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ eligible: true, revision: 2, refreshToken: token });
    expect(vi.mocked(service.getConfigRefresh).mock.calls[0]?.[1]).toBe(keyId);
    await app.close();
  });

  it("commits a refresh for a well-formed token only", async () => {
    const service = createService();
    vi.mocked(service.refreshOwnConfig).mockResolvedValue({ revision: 3 });
    const app = await devApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/keys/${keyId}/config-refresh`,
      headers,
      payload: { refreshToken: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ revision: 3 });
    expect(vi.mocked(service.refreshOwnConfig).mock.calls[0]?.slice(1)).toEqual([keyId, token]);

    const malformed = await app.inject({
      method: "POST",
      url: `/api/keys/${keyId}/config-refresh`,
      headers,
      payload: { refreshToken: "not-a-token" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(service.refreshOwnConfig).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("passes a stale token's 409 through with its own code", async () => {
    const service = createService();
    vi.mocked(service.refreshOwnConfig).mockRejectedValue(
      new ApiError(409, "The config changed since it was checked", CONFIG_REFRESH_STALE),
    );
    const app = await devApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/keys/${keyId}/config-refresh`,
      headers,
      payload: { refreshToken: token },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: CONFIG_REFRESH_STALE });
    await app.close();
  });
});

describe("bridge registry routes", () => {
  const routeId = bridgeRouteFixture.id;
  const keyId = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
  const bridgeEndpoints = [
    { method: "GET" as const, url: "/api/admin/infrastructure" },
    { method: "GET" as const, url: "/api/admin/vpn-bridges" },
    {
      method: "GET" as const,
      url: `/api/admin/nodes/${bridgeNodeId}/vpn-bridge-eligibility`,
    },
    {
      method: "POST" as const,
      url: "/api/admin/vpn-bridges",
      payload: { name: "Bridge", publicIpv4: "45.10.20.30" },
    },
    {
      method: "PATCH" as const,
      url: `/api/admin/vpn-bridges/${bridgeFixture.id}`,
      payload: { name: "Renamed" },
    },
    { method: "DELETE" as const, url: `/api/admin/vpn-bridges/${bridgeFixture.id}` },
    { method: "GET" as const, url: `/api/admin/nodes/${bridgeNodeId}/vpn-bridge-routes` },
    {
      method: "POST" as const,
      url: `/api/admin/nodes/${bridgeNodeId}/vpn-bridge-routes`,
      payload: { bridgeId: bridgeFixture.id },
    },
    {
      method: "DELETE" as const,
      url: `/api/admin/vpn-bridge-routes/${routeId}?confirmed=true`,
    },
    {
      method: "PATCH" as const,
      url: `/api/admin/nodes/${bridgeNodeId}`,
      payload: { vpnBridgeRouteId: routeId, expectedVpnEndpointRevision: 0 },
    },
    {
      method: "GET" as const,
      url: `/api/admin/vpn-bridge-routes/${routeId}/test-config?keyId=${keyId}`,
    },
    {
      method: "POST" as const,
      url: `/api/admin/vpn-bridge-routes/${routeId}/verify`,
      payload: { method: "probe" },
    },
  ];

  const adminApp = async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    const app = await buildApp({ service, environment: "development", allowDevIdentity: true });
    return { service, admin, app };
  };

  it("refuses every bridge endpoint to a non-admin with 403", async () => {
    const service = createService();
    const app = await buildApp({ service, environment: "development", allowDevIdentity: true });
    for (const request of bridgeEndpoints) {
      const response = await app.inject({
        ...request,
        headers: { "x-dev-user-email": user.email },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: "FORBIDDEN" });
    }
    for (const method of [
      service.listInfrastructure,
      service.listBridges,
      service.createBridge,
      service.updateBridge,
      service.deleteBridge,
      service.getNodeBridgeRoutes,
      service.getBridgeEligibility,
      service.prepareBridgeRoute,
      service.releaseBridgeRoute,
      service.updateNode,
      service.getBridgeRouteTestConfig,
      service.verifyBridgeRoute,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it("registers a bridge with defaults and rejects a non-canonical address", async () => {
    const { service, admin, app } = await adminApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/vpn-bridges",
      headers: { "x-dev-user-email": admin.email },
      payload: { name: "  Bridge A  ", publicIpv4: "45.10.20.30" },
    });
    expect(created.statusCode).toBe(201);
    expect(service.createBridge).toHaveBeenCalledWith(admin, {
      name: "Bridge A",
      publicIpv4: "45.10.20.30",
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
    for (const publicIpv4 of ["045.10.20.30", " 45.10.20.30", "10.0.0.1", "45.10.20.30:7000"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/vpn-bridges",
        headers: { "x-dev-user-email": admin.email },
        payload: { name: "Bridge", publicIpv4 },
      });
      expect(response.statusCode, publicIpv4).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    }
    expect(service.createBridge).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("answers 201 for a new reservation and 200 for the held one", async () => {
    const { service, admin, app } = await adminApp();
    const url = `/api/admin/nodes/${bridgeNodeId}/vpn-bridge-routes`;
    const headers = { "x-dev-user-email": admin.email };
    const first = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { bridgeId: bridgeFixture.id, publicUdpPort: 41000 },
    });
    expect(first.statusCode).toBe(201);
    expect(service.prepareBridgeRoute).toHaveBeenCalledWith(admin, bridgeNodeId, {
      bridgeId: bridgeFixture.id,
      publicUdpPort: 41000,
    });
    vi.mocked(service.prepareBridgeRoute).mockResolvedValueOnce({
      created: false,
      route: bridgeRouteFixture,
    });
    const again = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { bridgeId: bridgeFixture.id },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, route: { id: bridgeRouteFixture.id } });
    // A static last segment: never the generic admin action handler.
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires confirmed=true to release a route", async () => {
    const { service, admin, app } = await adminApp();
    for (const suffix of ["", "?confirmed=false"]) {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/admin/vpn-bridge-routes/${routeId}${suffix}`,
        headers: { "x-dev-user-email": admin.email },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "CONFIRMATION_REQUIRED" });
    }
    expect(service.releaseBridgeRoute).not.toHaveBeenCalled();
    const confirmed = await app.inject({
      method: "DELETE",
      url: `/api/admin/vpn-bridge-routes/${routeId}?confirmed=true`,
      headers: { "x-dev-user-email": admin.email },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(service.releaseBridgeRoute).toHaveBeenCalledWith(admin, routeId);
    await app.close();
  });

  it("maps a bridge ApiError to its status and stable code", async () => {
    const { service, admin, app } = await adminApp();
    vi.mocked(service.releaseBridgeRoute).mockRejectedValueOnce(
      new ApiError(409, "stale", "BRIDGE_OBSERVATION_STALE"),
    );
    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/vpn-bridge-routes/${routeId}?confirmed=true`,
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "BRIDGE_OBSERVATION_STALE", message: "stale" });
    await app.close();
  });

  it("requires the revision when a node PATCH names a route", async () => {
    const { service, admin, app } = await adminApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/nodes/${bridgeNodeId}`,
      headers: { "x-dev-user-email": admin.email },
      payload: { vpnBridgeRouteId: null },
    });
    expect(response.statusCode).toBe(400);
    expect(service.updateNode).not.toHaveBeenCalled();
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/admin/nodes/${bridgeNodeId}`,
      headers: { "x-dev-user-email": admin.email },
      payload: { vpnBridgeRouteId: null, expectedVpnEndpointRevision: 4 },
    });
    expect(ok.statusCode).toBe(200);
    expect(service.updateNode).toHaveBeenCalledWith(admin, bridgeNodeId, {
      vpnBridgeRouteId: null,
      expectedVpnEndpointRevision: 4,
    });
    await app.close();
  });

  it("serves the test config as a private attachment with the encoded marker", async () => {
    const { service, admin, app } = await adminApp();
    vi.mocked(service.getBridgeRouteTestConfig).mockResolvedValueOnce({
      contentType: "text/plain; charset=utf-8",
      body: "vpn://test-config",
      filename: "Node A.vpn",
      registrationMarker: "client-1 06-13 10:20:30",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/vpn-bridge-routes/${routeId}/test-config?keyId=${keyId}`,
      headers: { "x-dev-user-email": admin.email },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("vpn://test-config");
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(response.headers["x-bridge-registration-marker"]).toBe(
      "client-1%2006-13%2010%3A20%3A30",
    );
    expect(service.getBridgeRouteTestConfig).toHaveBeenCalledWith(admin, routeId, keyId);

    // No observed registration: no marker header at all.
    const unobserved = await app.inject({
      method: "GET",
      url: `/api/admin/vpn-bridge-routes/${routeId}/test-config?keyId=${keyId}`,
      headers: { "x-dev-user-email": admin.email },
    });
    expect(unobserved.statusCode).toBe(200);
    expect(unobserved.headers["x-bridge-registration-marker"]).toBeUndefined();

    for (const query of ["", "?keyId=not-a-uuid"]) {
      const bad = await app.inject({
        method: "GET",
        url: `/api/admin/vpn-bridge-routes/${routeId}/test-config${query}`,
        headers: { "x-dev-user-email": admin.email },
      });
      expect(bad.statusCode, query).toBe(400);
    }
    expect(service.getBridgeRouteTestConfig).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("answers 202 for a queued probe check and 200 for operator verification", async () => {
    const { service, admin, app } = await adminApp();
    const url = `/api/admin/vpn-bridge-routes/${routeId}/verify`;
    const headers = { "x-dev-user-email": admin.email };
    vi.mocked(service.verifyBridgeRoute).mockResolvedValueOnce({
      method: "probe",
      routeId,
      jobId: "5b0c3b3e-3a4f-4f5e-9d6a-7b8c9d0e1f2a",
      queued: true,
      registrationMarker: "m-1",
    });
    const probe = await app.inject({ method: "POST", url, headers, payload: { method: "probe" } });
    expect(probe.statusCode).toBe(202);
    expect(probe.json()).toMatchObject({ method: "probe", queued: true });

    const operator = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { method: "operator", registrationMarker: "m-1", confirmHandshakeAndHttp: true },
    });
    expect(operator.statusCode).toBe(200);
    expect(service.verifyBridgeRoute).toHaveBeenLastCalledWith(admin, routeId, {
      method: "operator",
      registrationMarker: "m-1",
      confirmHandshakeAndHttp: true,
    });
    // Never the generic admin action handler.
    expect(service.adminAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an operator verification without explicit confirmation or marker", async () => {
    const { service, admin, app } = await adminApp();
    const url = `/api/admin/vpn-bridge-routes/${routeId}/verify`;
    for (const payload of [
      { method: "operator", registrationMarker: "m-1" },
      { method: "operator", registrationMarker: "m-1", confirmHandshakeAndHttp: false },
      { method: "operator", confirmHandshakeAndHttp: true },
      { method: "operator", registrationMarker: "", confirmHandshakeAndHttp: true },
      { method: "operator", registrationMarker: "m\n1", confirmHandshakeAndHttp: true },
      { method: "probe", registrationMarker: "m-1" },
      { method: "manual" },
      {},
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { "x-dev-user-email": admin.email },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    }
    expect(service.verifyBridgeRoute).not.toHaveBeenCalled();
    await app.close();
  });
});
