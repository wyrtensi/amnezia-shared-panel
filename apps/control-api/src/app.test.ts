import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
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
});
