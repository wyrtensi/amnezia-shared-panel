import { describe, expect, it, vi } from "vitest";
import { ROUTE_DOMAINS_UNSUPPORTED } from "@amnezia/contracts";
import type { ClientRelease } from "@amnezia/contracts";
import { buildApp } from "./app.js";
import type { ClientReleaseResolver } from "./clientReleases.js";
import { parseEnvironment } from "./main.js";
import type { ControlApiService } from "./service.js";

const user = {
  id: "f5e8308c-e09d-4d55-9b5d-da1597f486e6",
  email: "employee@example.com",
  displayName: "Employee",
  role: "user" as const,
  status: "active" as const,
};

const createService = (): ControlApiService => ({
  resolveIdentity: vi.fn(() => Promise.resolve(user)),
  getMe: vi.fn(() =>
    Promise.resolve({ ...user, keyLimit: 5, keyCount: 1 }),
  ),
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
  updateMyCustomRoutes: vi.fn(() =>
    Promise.resolve({
      ru_whitelist: { cidrs: [], domains: [] },
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
});

describe("control API identity boundary", () => {
  it("allows the development identity adapter only in development", async () => {
    const service = createService();
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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

  it("does not coerce the literal false query value to true", async () => {
    const service = createService();
    const app = await buildApp({ service, environment: "development" });

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

  it("rejects admin routes for an employee", async () => {
    const app = await buildApp({
      service: createService(),
      environment: "development",
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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
});

describe("custom routes take addresses, not site names", () => {
  it("accepts an address-only update", async () => {
    const service = createService();
    vi.mocked(service.resolveIdentity).mockResolvedValue(user);
    const app = await buildApp({ service, environment: "development" });

    const response = await app.inject({
      method: "PUT",
      url: "/api/me/custom-routes",
      headers: { "x-dev-user-email": user.email },
      payload: { ru_whitelist: { cidrs: ["203.0.113.0/24"], domains: [] } },
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
    const app = await buildApp({ service, environment: "development" });

    const response = await app.inject({
      method: "PUT",
      url: "/api/me/custom-routes",
      headers: { "x-dev-user-email": user.email },
      payload: { ru_whitelist: { cidrs: [], domains: ["example.com"] } },
    });

    expect(response.statusCode).toBe(400);
    const body: {
      error: string;
      issues: Array<{ message: string; path: string[] }>;
    } = response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.issues[0]?.message).toBe(ROUTE_DOMAINS_UNSUPPORTED);
    expect(body.issues[0]?.path).toEqual(["ru_whitelist", "domains"]);
    expect(service.updateMyCustomRoutes).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("admin global route overrides", () => {
  const globalRoutes = {
    ru_whitelist: {
      add: { cidrs: ["203.0.113.0/24"], domains: [] },
      exclude: { cidrs: [], domains: ["example.com"] },
    },
    ru_blacklist: {
      add: { cidrs: [], domains: [] },
      exclude: { cidrs: [], domains: [] },
    },
  };

  it("exposes the current overrides to an admin", async () => {
    const service = createService();
    const admin = { ...user, role: "admin" as const };
    vi.mocked(service.resolveIdentity).mockResolvedValue(admin);
    vi.mocked(service.adminList).mockResolvedValue([globalRoutes]);
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });
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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });
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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
    const app = await buildApp({ service, environment: "development" });

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
  // between two known links; anything else falls back to the primary rather
  // than reaching for a URL the caller supplied.
  describe("the download QR", () => {
    const qr = async (url: string) => {
      const app = await buildApp({
        service: createService(),
        environment: "development",
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
    return { service, admin, app: await buildApp({ service, environment: "development" }) };
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
    const app = await buildApp({ service, environment: "development" });
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
