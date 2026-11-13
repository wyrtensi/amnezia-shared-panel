import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { defaultPortalPolicy, emptyGlobalRoutes } from "@amnezia/contracts";
import type { GlobalRoutes } from "@amnezia/contracts";
import { encryptSecret } from "@amnezia/db";
import type { Actor } from "./service.js";
import { createDefaultControlApiService } from "./defaultService.js";
import { decodeVpnLink, encodeVpnPayload } from "./vpnConfig.js";
import type { ConfigRefreshSnapshot, ControlRepository } from "./repository.js";
import { awg31Link, readCopies } from "./awg31.fixture.js";
import { configRefreshToken } from "./awgClientProfile.js";
import { ApiError } from "./service.js";

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

const createRepository = (): ControlRepository => ({
  resolveIdentity: vi.fn(() => Promise.resolve(employee)),
  getMe: vi.fn(() => Promise.resolve({ keyLimit: 5, keyCount: 1 })),
  ackNotice: vi.fn(() => Promise.resolve({ install: 1, update: 1 })),
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
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: null,
      customRoutes: null,
    }),
  ),
  getGlobalRoutes: vi.fn(() => Promise.resolve(emptyGlobalRoutes)),
  markKeyRuleVersion: vi.fn(() => Promise.resolve()),
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
  enqueueOwnRevoke: vi.fn(() => Promise.resolve()),
  enqueueOwnRotate: vi.fn(() => Promise.resolve()),
  refreshOwnConfigProfile: vi.fn(() => Promise.resolve({ revision: 1 })),
  renameOwnKey: vi.fn(() =>
    Promise.resolve({ id: "key-1", state: "active" as const, reissued: false }),
  ),
  updateOwnCustomRoutes: vi.fn(() =>
    Promise.resolve({
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
  appendAudit: vi.fn(() => Promise.resolve()),
  listBridges: vi.fn(() => Promise.resolve([])),
  createBridge: vi.fn(() => Promise.resolve(bridgeFixture)),
  updateBridge: vi.fn(() => Promise.resolve(bridgeFixture)),
  deleteBridge: vi.fn(() =>
    Promise.resolve({ id: bridgeFixture.id, deleted: true as const }),
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
});

const splitTunnelLink = encodeVpnPayload({
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

const splitTunnelKey = () => ({
  id: "key-1",
  ownerId: employee.id,
  deviceLabel: "phone",
  encrypted: encryptSecret(splitTunnelLink, keyring, 1),
  policy: defaultPortalPolicy,
  routeProfile: "ru_blacklist" as const,
  keyNumber: 3,
  nodeDisplayName: "Frankfurt",
  nameDisplay: { server: true, label: true, number: false },
  appliedRuleVersionId: null,
  state: "active" as const,
  awgClientProfile: null,
  activeRule: null,
  customRoutes: null,
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
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
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
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
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
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
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
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: {
        versionId: "v1",
        version: "v1",
        // 10.0.0.0/8 is in both the base feed and the custom list → deduped.
        payload: { cidrs: ["10.0.0.0/8"], domains: ["blocked.ru"] },
      },
      customRoutes: {
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

  it("applies the admin's global exclusions and additions to the export", async () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      ...splitTunnelKey(),
      activeRule: {
        versionId: "v1",
        version: "v1",
        payload: {
          cidrs: ["10.0.0.0/8", "192.0.2.0/24"],
          domains: ["cdn.example.com"],
        },
      },
    });
    vi.mocked(repository.getGlobalRoutes).mockResolvedValue({
      ru_blacklist: {
        add: { cidrs: ["198.51.100.0/24"], domains: [] },
        // The domain half of a stored override is inert: it neither adds nor
        // excludes anything, because no name reaches an exported key.
        exclude: { cidrs: ["10.0.0.0/8"], domains: ["example.com"] },
      },
    });
    const service = createDefaultControlApiService({ repository, keyring });

    const conf = String(
      (await service.getKeyConfig(employee, "key-1", "conf", false)).body,
    );

    expect(conf).not.toContain("10.0.0.0/8");
    expect(conf).toContain("192.0.2.0/24");
    expect(conf).toContain("198.51.100.0/24");
    expect(conf).not.toContain("cdn.example.com");
  });

  it("lets the owner's custom routes override a global exclusion", async () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      ...splitTunnelKey(),
      activeRule: {
        versionId: "v1",
        version: "v1",
        payload: { cidrs: ["10.0.0.0/8"], domains: [] },
      },
      customRoutes: {
        ru_blacklist: { cidrs: ["10.0.0.0/8"], domains: [] },
      },
    });
    vi.mocked(repository.getGlobalRoutes).mockResolvedValue({
      ru_blacklist: {
        add: { cidrs: [], domains: [] },
        exclude: { cidrs: ["10.0.0.0/8"], domains: [] },
      },
    });
    const service = createDefaultControlApiService({ repository, keyring });

    const conf = String(
      (await service.getKeyConfig(employee, "key-1", "conf", false)).body,
    );

    expect(conf).toContain("10.0.0.0/8");
  });

  it("blocks every QR container under the same policy flag", async () => {
    for (const format of ["qr", "qr-svg", "qr-frames", "qr-conf"] as const) {
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
        nameDisplay: { server: true, label: true, number: false },
        appliedRuleVersionId: null,
        state: "active" as const,
        awgClientProfile: null,
        activeRule: null,
        customRoutes: null,
      });
      const service = createDefaultControlApiService({ repository, keyring });

      await expect(
        service.getKeyConfig(employee, "key-1", format, false),
      ).rejects.toEqual(
        expect.objectContaining({ statusCode: 403, code: "POLICY_DENIED" }),
      );
    }
  });

  it("does not consult the global overrides for a full-tunnel key", async () => {
    const repository = createRepository();
    const service = createDefaultControlApiService({ repository, keyring });

    await service.getKeyConfig(employee, "key-1", "vpn", false);

    expect(repository.getGlobalRoutes).not.toHaveBeenCalled();
  });
});

describe("client-visible connection name", () => {
  const nameOf = async (
    display: { server: boolean; label: boolean; number: boolean },
  ): Promise<string | undefined> => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: "Main laptop",
      encrypted: encryptSecret(
        encodeVpnPayload({
          containers: [
            { awg: { last_config: JSON.stringify({ config: "[Interface]\n" }) } },
          ],
        }),
        keyring,
        1,
      ),
      policy: defaultPortalPolicy,
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      nameDisplay: display,
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: null,
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });
    const result = await service.getKeyConfig(employee, "key-1", "vpn", false);
    return decodeVpnLink(String(result.body)).description;
  };

  it("uses the key's own name parts", async () => {
    await expect(
      nameOf({ server: true, label: true, number: false }),
    ).resolves.toBe("Frankfurt Main laptop");
    await expect(
      nameOf({ server: true, label: false, number: true }),
    ).resolves.toBe("Frankfurt #3");
    await expect(
      nameOf({ server: false, label: true, number: true }),
    ).resolves.toBe("Main laptop #3");
  });
});

describe("the two file shapes and what each one keeps", () => {
  const namedKeyService = () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: "phone",
      encrypted: encryptSecret(
        encodeVpnPayload({
          containers: [
            {
              awg: {
                last_config: JSON.stringify({
                  config: "[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n",
                }),
              },
            },
          ],
        }),
        keyring,
        1,
      ),
      policy: defaultPortalPolicy,
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: null,
      customRoutes: null,
    });
    return createDefaultControlApiService({ repository, keyring });
  };

  it("serves the vpn payload as a .vpn file that still carries the name", async () => {
    const service = namedKeyService();

    const result = await service.getKeyConfig(employee, "key-1", "vpn", false);

    // The extension is the fix: the client's own file picker offers
    // `*.vpn *.ovpn *.conf *.json`, so the `.vpn.txt` this used to be hid the
    // one downloadable shape whose name survives an import.
    expect(result.filename).toBe("Frankfurt phone.vpn");
    expect(decodeVpnLink(String(result.body)).description).toBe(
      "Frankfurt phone",
    );
  });

  it("names the .conf after the connection but writes nothing into it", async () => {
    const service = namedKeyService();

    const result = await service.getKeyConfig(employee, "key-1", "conf", false);

    expect(result.filename).toBe("Frankfurt phone.conf");
    // The client renames every imported .conf to "Server N" regardless, so the
    // name must NOT be smuggled into the file: its INI scrape never reads a
    // comment back, and `checkConfigFormat` sniffs the whole text for the
    // Amnezia JSON markers BEFORE the [Interface]/[Peer] pair -- a comment
    // holding one of those words would fail the import outright. A line that
    // looks like a name and does nothing is worse than no line at all.
    const conf = String(result.body);
    expect(conf).not.toContain("Frankfurt phone");
    expect(conf).not.toMatch(/^\s*#/m);
    for (const marker of ["containers", "api_key", "auth_data"]) {
      expect(conf).not.toContain(marker);
    }
  });
});

describe("simple-key QR rendering", () => {
  it("returns an SVG with no attachment disposition", async () => {
    const repository = createRepository();
    const service = createDefaultControlApiService({ repository, keyring });

    const result = await service.getKeyConfig(employee, "key-1", "qr-svg", false);

    expect(result.format).toBe("qr-svg");
    expect(result.contentType).toBe("image/svg+xml; charset=utf-8");
    expect(result.filename).toBeUndefined();
    expect(String(result.body)).toContain("<svg");
    // The quiet zone is four modules per side, as the QR spec requires.
    expect(String(result.body)).toMatch(/viewBox="0 0 (\d+) \1"/);
  });

  it("returns a PNG with a download name for the raster format", async () => {
    const repository = createRepository();
    const service = createDefaultControlApiService({ repository, keyring });

    const result = await service.getKeyConfig(employee, "key-1", "qr", false);

    expect(result.contentType).toBe("image/png");
    expect(result.filename).toBe("Frankfurt phone.png");
    expect(Buffer.isBuffer(result.body)).toBe(true);
  });

  it("returns the AmneziaVPN frame series as JSON SVGs", async () => {
    const repository = createRepository();
    const service = createDefaultControlApiService({ repository, keyring });

    const result = await service.getKeyConfig(
      employee,
      "key-1",
      "qr-frames",
      false,
    );

    expect(result.format).toBe("qr-frames");
    expect(result.contentType).toBe("application/json; charset=utf-8");
    expect(result.filename).toBeUndefined();
    const parsed = JSON.parse(String(result.body)) as {
      total: number;
      frames: string[];
    };
    expect(parsed.total).toBe(parsed.frames.length);
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    for (const frame of parsed.frames) {
      expect(frame).toContain("<svg");
      expect(frame).toContain('shape-rendering="crispEdges"');
    }
  });

  it("renders a QR of the plain WireGuard config for the AmneziaWG app", async () => {
    const repository = createRepository();
    // AmneziaWG reads neither the vpn:// link nor the chunk envelope, only the
    // bare WireGuard config -- the same bytes `conf` downloads as a file, so
    // the fixture needs a decodable payload rather than the default
    // repository's opaque `encrypted` value.
    const link = encodeVpnPayload({
      containers: [
        {
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
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: null,
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });

    const result = await service.getKeyConfig(
      employee,
      "key-1",
      "qr-conf",
      false,
    );

    expect(result.format).toBe("qr-conf");
    expect(result.contentType).toBe("image/svg+xml; charset=utf-8");
    // A display format, like qr-svg: no attachment disposition.
    expect(result.filename).toBeUndefined();
    expect(String(result.body)).toContain("<svg");
  });
});

// Chunking removes the capacity limit that makes `qr` and `qr-svg` refuse a
// split-tunnel config, so `qr-frames` would otherwise answer a blacklist key
// with dozens of codes where every other QR format gives it a 422. Pinned
// because the failure is silent: a valid, useless response.
describe("the AmneziaVPN series refuses a config nobody could scan", () => {
  it("returns 422 rather than dozens of frames", async () => {
    const repository = createRepository();
    // ~20 KB of payload: 24 frames at the client's 850-byte chunk size, which
    // is the scale a real blacklist config reaches.
    const huge = encryptSecret(
      `vpn://${"A".repeat(28000)}`,
      keyring,
      1,
    );
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      id: "key-1",
      ownerId: employee.id,
      deviceLabel: "phone",
      encrypted: huge,
      policy: defaultPortalPolicy,
      routeProfile: "full_tunnel" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: null,
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });

    await expect(
      service.getKeyConfig(employee, "key-1", "qr-frames", false),
    ).rejects.toEqual(
      expect.objectContaining({ statusCode: 422, code: "QR_TOO_LARGE" }),
    );
  });
});

// The .conf text embeds the same CIDR list applyRouteProfileToVpnLink writes
// into AllowedIPs, so a blacklist key's plain WireGuard config is exactly as
// oversized as its vpn:// link. `qr-conf` must degrade the same way `qr` and
// `qr-svg` do -- refuse with QR_TOO_LARGE -- not silently answer with a symbol
// nobody can scan.
describe("the AmneziaWG QR refuses a config that will not fit", () => {
  it("returns 422 rather than an unreadable code", async () => {
    const repository = createRepository();
    // ~7.5 KB of AllowedIPs: 500 CIDRs, well past the ~2900-byte ceiling a QR
    // symbol can hold at any error-correction level -- the scale a real
    // ru_blacklist .conf reaches.
    const hugeAllowedIps = Array.from(
      { length: 500 },
      (_, i) => `10.${i % 256}.0.0/16`,
    ).join(", ");
    const link = encodeVpnPayload({
      containers: [
        {
          awg: {
            last_config: JSON.stringify({
              config: `[Interface]\nPrivateKey = x\n\n[Peer]\nAllowedIPs = ${hugeAllowedIps}\n`,
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
      routeProfile: "ru_blacklist" as const,
      keyNumber: 3,
      nodeDisplayName: "Frankfurt",
      nameDisplay: { server: true, label: true, number: false },
      appliedRuleVersionId: null,
      state: "active" as const,
      awgClientProfile: null,
      activeRule: null,
      customRoutes: null,
    });
    const service = createDefaultControlApiService({ repository, keyring });

    await expect(
      service.getKeyConfig(employee, "key-1", "qr-conf", false),
    ).rejects.toEqual(
      expect.objectContaining({ statusCode: 422, code: "QR_TOO_LARGE" }),
    );
  });
});

describe("AWG 3.1 config refresh", () => {
  const base31 = awg31Link();
  const saved = { version: 1, revision: 2, jc: 5, jmin: 50, jmax: 150, cpsOrder: 1 };
  const key31 = (over: Record<string, unknown> = {}) => ({
    ...splitTunnelKey(),
    routeProfile: "full_tunnel" as const,
    encrypted: encryptSecret(base31, keyring, 1),
    ...over,
  });
  const statusOf = (error: unknown) =>
    error instanceof ApiError ? `${error.statusCode} ${error.code}` : String(error);

  it("hands the owner a token for the exact config it saw", async () => {
    const repository = createRepository();
    const key = key31();
    vi.mocked(repository.findKeyConfig).mockResolvedValue(key);
    const service = createDefaultControlApiService({ repository, keyring });
    expect(await service.getConfigRefresh(employee, "key-1")).toEqual({
      eligible: true,
      revision: 0,
      refreshToken: configRefreshToken("key-1", key.encrypted.nonce, 0),
    });
    vi.mocked(repository.findKeyConfig).mockResolvedValue({ ...key, awgClientProfile: saved });
    expect(await service.getConfigRefresh(employee, "key-1")).toMatchObject({
      eligible: true,
      revision: 2,
      refreshToken: configRefreshToken("key-1", key.encrypted.nonce, 2),
    });
    // Checking is not delivering.
    expect(repository.markKeyRuleVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["a 2.0 artifact", { encrypted: encryptSecret(awg31Link({ protocolVersion: "2" }), keyring, 1) }],
    ["an unmarked artifact", { encrypted: encryptSecret(awg31Link({ protocolVersion: null }), keyring, 1) }],
    ["a key being rotated", { state: "provisioning" }],
    ["a key being revoked", { state: "revoking" }],
    ["a disabled key", { state: "disabled" }],
  ])("says %s is not eligible", async (_name, over) => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue(key31(over));
    const service = createDefaultControlApiService({ repository, keyring });
    expect(await service.getConfigRefresh(employee, "key-1")).toEqual({ eligible: false });
  });

  it("answers 404 for someone else's key, admins included, and 403 without redownload", async () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue(key31({ ownerId: "someone-else" }));
    const service = createDefaultControlApiService({ repository, keyring });
    for (const actor of [employee, admin]) {
      expect(statusOf(await service.getConfigRefresh(actor, "key-1").catch((e: unknown) => e))).toBe(
        "404 KEY_NOT_FOUND",
      );
    }
    vi.mocked(repository.findKeyConfig).mockResolvedValue(
      key31({ policy: { ...defaultPortalPolicy, allowConfigRedownload: false } }),
    );
    expect(statusOf(await service.getConfigRefresh(employee, "key-1").catch((e: unknown) => e))).toBe(
      "403 POLICY_DENIED",
    );
  });

  /** Run the service's prepare step the way the repository would. */
  const prepared = async (snapshot: Partial<ConfigRefreshSnapshot>) => {
    const repository = createRepository();
    let result: unknown;
    vi.mocked(repository.refreshOwnConfigProfile).mockImplementation(
      (_actor, keyId, _token, prepare) => {
        try {
          result = prepare({
            keyId,
            encrypted: encryptSecret(base31, keyring, 1),
            awgClientProfile: null,
            revision: 0,
            ...snapshot,
          });
          return Promise.resolve({ revision: 1 });
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error("prepare failed"));
        }
      },
    );
    const service = createDefaultControlApiService({ repository, keyring });
    await service.refreshOwnConfig(employee, "key-1", "a".repeat(64));
    return result as typeof saved;
  };

  it("draws the next revision with a Jc other than the effective one", async () => {
    for (let n = 0; n < 50; n += 1) {
      const fresh = await prepared({});
      expect(fresh.revision).toBe(1);
      expect(fresh.jc).not.toBe(8);
      const next = await prepared({ awgClientProfile: saved, revision: 2 });
      expect(next.revision).toBe(3);
      expect(next.jc).not.toBe(5);
    }
  });

  it("refuses to draw for an artifact that cannot take a profile", async () => {
    const error = await prepared({
      encrypted: encryptSecret(awg31Link({ protocolVersion: "2" }), keyring, 1),
    }).catch((e: unknown) => e);
    expect(statusOf(error)).toBe("409 CONFIG_REFRESH_UNAVAILABLE");
  });
});

describe("export with a saved AWG 3.1 client profile", () => {
  const profile = { version: 1, revision: 1, jc: 4, jmin: 45, jmax: 175, cpsOrder: 1 };
  const feed = (cidrs: string[]) => ({
    versionId: "v1",
    version: "v1",
    payload: { cidrs, domains: [] },
  });
  const withGlobals: GlobalRoutes = {
    ru_blacklist: {
      add: { cidrs: ["198.51.100.0/24"], domains: [] },
      exclude: { cidrs: ["192.0.2.0/24"], domains: [] },
    },
  };
  const exportAll = async (over: Record<string, unknown>, globals = withGlobals) => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      ...splitTunnelKey(),
      encrypted: encryptSecret(awg31Link(), keyring, 1),
      ...over,
    });
    vi.mocked(repository.getGlobalRoutes).mockResolvedValue(globals);
    const service = createDefaultControlApiService({ repository, keyring });
    const vpn = String((await service.getKeyConfig(employee, "key-1", "vpn", false)).body);
    const conf = String((await service.getKeyConfig(employee, "key-1", "conf", false)).body);
    return { vpn, conf, copies: readCopies(vpn, decodeVpnLink) };
  };
  const confLine = (conf: string, key: string) =>
    new RegExp(`^${key} = (.*)$`, "m").exec(conf)?.[1];

  it("carries the same parameters in .vpn and .conf, with the routes untouched", async () => {
    const routes = {
      routeProfile: "ru_blacklist" as const,
      activeRule: feed(["10.0.0.0/8", "192.0.2.0/24"]),
      customRoutes: { ru_blacklist: { cidrs: ["203.0.113.0/24"], domains: [] } },
    };
    const before = await exportAll({ ...routes, awgClientProfile: null });
    const after = await exportAll({ ...routes, awgClientProfile: profile });
    for (const [key, value] of [["Jc", "4"], ["Jmin", "45"], ["Jmax", "175"]] as const) {
      expect(after.copies.awg[key]).toBe(value);
      expect(after.copies.lastConfig[key]).toBe(value);
      expect(after.copies.line(key)).toBe(value);
      expect(confLine(after.conf, key)).toBe(value);
    }
    expect(confLine(after.conf, "I1")).toBe(after.copies.line("I1"));
    // Same routes as before the refresh, in both shapes, DNS included.
    const expected = ["10.0.0.0/8", "198.51.100.0/24", "203.0.113.0/24", "1.1.1.1/32", "1.0.0.1/32"];
    expect(after.copies.lastConfig.allowed_ips).toEqual(expected);
    expect(before.copies.lastConfig.allowed_ips).toEqual(expected);
    expect(confLine(after.conf, "AllowedIPs")).toBe(expected.join(", "));
    expect(confLine(before.conf, "AllowedIPs")).toBe(expected.join(", "));
    expect(confLine(before.conf, "Jc")).toBe("8");
  });

  it.each([
    ["an empty merge", []],
    ["a feed past the route limit", Array.from({ length: 6800 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`)],
  ])("keeps the profile on the full-tunnel fallback for %s", async (_name, cidrs) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { copies, conf } = await exportAll(
      { routeProfile: "ru_blacklist", activeRule: feed(cidrs), awgClientProfile: profile },
      emptyGlobalRoutes,
    );
    warn.mockRestore();
    expect(confLine(conf, "AllowedIPs")).toBe("0.0.0.0/0, ::/0");
    expect(copies.line("Jc")).toBe("4");
    expect(confLine(conf, "Jc")).toBe("4");
  });

  it("stays split just inside the route limit, with the profile", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 6797 feed routes, the global addition and two DNS addresses: exactly
    // the limit.
    const cidrs = Array.from({ length: 6797 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`);
    const { copies } = await exportAll({
      routeProfile: "ru_blacklist",
      activeRule: feed(cidrs),
      awgClientProfile: profile,
    });
    warn.mockRestore();
    expect((copies.lastConfig.allowed_ips as string[]).length).toBe(6800);
    expect(copies.line("Jc")).toBe("4");
  });

  it("still refuses a QR for a split config that is too large", async () => {
    const repository = createRepository();
    vi.mocked(repository.findKeyConfig).mockResolvedValue({
      ...splitTunnelKey(),
      encrypted: encryptSecret(awg31Link(), keyring, 1),
      activeRule: feed(Array.from({ length: 2000 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`)),
      awgClientProfile: profile,
    });
    const service = createDefaultControlApiService({ repository, keyring });
    const error = await service.getKeyConfig(employee, "key-1", "qr", false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("QR_TOO_LARGE");
  });

  it("exports a 2.0 artifact exactly as before, whatever profile was saved", async () => {
    const link = awg31Link({ protocolVersion: "2" });
    const plain = await exportAll({ routeProfile: "full_tunnel", encrypted: encryptSecret(link, keyring, 1), awgClientProfile: null });
    const withProfile = await exportAll({ routeProfile: "full_tunnel", encrypted: encryptSecret(link, keyring, 1), awgClientProfile: profile });
    expect(withProfile.vpn).toBe(plain.vpn);
    expect(withProfile.conf).toBe(plain.conf);
  });

  it("reports a broken saved profile without its content", async () => {
    const error = await exportAll({ routeProfile: "full_tunnel", awgClientProfile: { jc: 99 } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("CONFIG_PROFILE_INVALID");
    expect((error as ApiError).message).not.toContain("99");
  });
});
