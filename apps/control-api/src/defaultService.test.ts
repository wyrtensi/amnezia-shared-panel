import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { defaultPortalPolicy } from "@amnezia/contracts";
import { encryptSecret } from "@amnezia/db";
import type { Actor } from "./service.js";
import { createDefaultControlApiService } from "./defaultService.js";
import { encodeVpnPayload } from "./vpnConfig.js";
import type { ControlRepository } from "./repository.js";

const employee: Actor = {
  id: "user-1",
  email: "employee@example.com",
  displayName: "Employee",
  role: "user",
  status: "active",
};

const admin: Actor = {
  ...employee,
  id: "admin-1",
  email: "admin@example.com",
  role: "admin",
};

const keyring = { 1: randomBytes(32) };
const encrypted = encryptSecret("vpn://stored-payload", keyring, 1);

const createRepository = (): ControlRepository => ({
  resolveIdentity: vi.fn(() => Promise.resolve(employee)),
  getMe: vi.fn(() => Promise.resolve({ keyLimit: 5, keyCount: 1 })),
  listNodes: vi.fn(() => Promise.resolve([])),
  listKeys: vi.fn(() => Promise.resolve([])),
  createProvisioningKey: vi.fn(() =>
    Promise.resolve({ id: "key-1", state: "provisioning" as const }),
  ),
  findKeyConfig: vi.fn(() =>
    Promise.resolve({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: "phone",
      encrypted,
      policy: defaultPortalPolicy,
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      appliedRuleVersionId: null,
      activeRule: null,
      customRoutes: null,
    }),
  ),
  markKeyRuleVersion: vi.fn(() => Promise.resolve()),
  listRouteProfiles: vi.fn(() => Promise.resolve([])),
  getRuleVersion: vi.fn(() => Promise.resolve({ id: "rule-1" })),
  diffRuleVersions: vi.fn(() => Promise.resolve({ diff: {} })),
  enqueueOwnRevoke: vi.fn(() => Promise.resolve()),
  enqueueOwnRotate: vi.fn(() => Promise.resolve()),
  updateOwnCustomRoutes: vi.fn(() =>
    Promise.resolve({
      ru_whitelist: { cidrs: [], domains: [] },
      ru_blacklist: { cidrs: [], domains: [] },
    }),
  ),
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
  appendAudit: vi.fn(() => Promise.resolve()),
});

describe("default control service policy enforcement", () => {
  it("blocks QR retrieval when the effective policy disables it", async () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: null,
      encrypted,
      policy: { ...defaultPortalPolicy, allowQrDownload: false },
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      appliedRuleVersionId: null,
      activeRule: null,
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });

    await expect(
      service.getKeyConfig(employee, "key-1", "qr", false),
    ).rejects.toEqual(
      expect.objectContaining({
        statusCode: 403,
        code: "POLICY_DENIED",
      }),
    );
  });

  it("requires confirmation and audits an admin private-config view", async () => {
    const repository = createRepository();
    const service = createDefaultControlApiService({ repository, keyring });

    await expect(
      service.getKeyConfig(admin, "key-1", "vpn", false),
    ).rejects.toEqual(
      expect.objectContaining({ code: "ADMIN_CONFIRMATION_REQUIRED" }),
    );

    await expect(
      service.getKeyConfig(admin, "key-1", "vpn", true),
    ).resolves.toMatchObject({ body: "vpn://stored-payload" });
    expect(repository.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: admin.id,
        action: "vpn_key.private_config_viewed",
        targetId: "key-1",
      }),
    );
  });

  it("does not reveal whether another employee owns a key", async () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: "user-2",
      deviceLabel: null,
      encrypted,
      policy: defaultPortalPolicy,
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      appliedRuleVersionId: null,
      activeRule: null,
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });

    await expect(
      service.getKeyConfig(employee, "key-1", "vpn", false),
    ).rejects.toEqual(expect.objectContaining({ statusCode: 404 }));
  });

  it("applies the active route rules to the exported config", async () => {
    const repository = createRepository();
    const link = encodeVpnPayload({
      dns1: "1.1.1.1",
      dns2: "1.0.0.1",
      containers: [
        {
          container: "amnezia-awg",
          awg: {
            last_config: JSON.stringify({
              config:
                "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n",
            }),
          },
        },
      ],
    });
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: "phone",
      encrypted: encryptSecret(link, keyring, 1),
      policy: defaultPortalPolicy,
      routeProfile: "ru_blacklist",
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      appliedRuleVersionId: null,
      activeRule: {
        versionId: "v1",
        version: "v1",
        payload: { cidrs: ["10.0.0.0/8"], domains: ["blocked.ru"] },
      },
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });

    const result = await service.getKeyConfig(employee, "key-1", "conf", false);

    expect(String(result.body)).toContain(
      "AllowedIPs = 10.0.0.0/8, 1.1.1.1/32, 1.0.0.1/32",
    );
    expect(String(result.body)).not.toContain("0.0.0.0/0");
    expect(repository.markKeyRuleVersion).toHaveBeenCalledWith("key-1", "v1");
  });

  it("merges the owner's custom routes on top of the base feed", async () => {
    const repository = createRepository();
    const link = encodeVpnPayload({
      dns1: "1.1.1.1",
      dns2: "1.0.0.1",
      containers: [
        {
          container: "amnezia-awg",
          awg: {
            last_config: JSON.stringify({
              config:
                "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n",
            }),
          },
        },
      ],
    });
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: "phone",
      encrypted: encryptSecret(link, keyring, 1),
      policy: defaultPortalPolicy,
      routeProfile: "ru_blacklist",
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      appliedRuleVersionId: null,
      activeRule: {
        versionId: "v1",
        version: "v1",
        // 10.0.0.0/8 is in both the base feed and the custom list → deduped.
        payload: { cidrs: ["10.0.0.0/8"], domains: ["blocked.ru"] },
      },
      customRoutes: {
        ru_whitelist: { cidrs: [], domains: [] },
        ru_blacklist: { cidrs: ["10.0.0.0/8", "203.0.113.0/24"], domains: [] },
      },
    });
    const service = createDefaultControlApiService({ repository, keyring });

    const conf = String(
      (await service.getKeyConfig(employee, "key-1", "conf", false)).body,
    );
    // Base + custom CIDR present, the duplicate collapsed, base preserved.
    expect(conf).toContain("203.0.113.0/24");
    expect(conf).toContain("10.0.0.0/8");
    expect(conf.match(/10\.0\.0\.0\/8/g)?.length).toBe(1);
  });
});
