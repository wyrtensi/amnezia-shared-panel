import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { asValue } from "awilix";
import { afterEach, describe, expect, it, vi } from "vitest";

import { di } from "@/config/DIContainer";
import { AgentUpdateService } from "@/services/server/agentUpdate.service";

import { Protocol } from "@/types/shared";
import { AppFastifyInstance } from "@/types/shared";
import { DesiredState, HostNetworkReport } from "@/types/egress";
import { ServerBackupPayload } from "@/types/server";
import { createAmneziaBackupFixture } from "../fixtures";
import { TEST_API_KEY } from "../config/setupTestEnvironment";
import { closeTestApp, createServerTestApp } from "../helpers";

const AUTH_HEADERS = { "x-api-key": TEST_API_KEY } as const;

let app: AppFastifyInstance | undefined;

afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

describe("server backup routes", () => {
  // The service builds amneziaWg3 correctly and the unit tests prove it. This
  // test exists one layer out, because Fastify serializes by the response
  // schema and silently drops any field the schema does not declare — which
  // is how an empty backup shipped with a 200.
  it("returns the AmneziaWG 3.1 payload to the client", async () => {
    const backup: ServerBackupPayload = {
      generatedAt: "2026-09-07T00:00:00.000Z",
      serverId: "test-server-id",
      protocols: [Protocol.AMNEZIAWG3],
      amneziaWg3: createAmneziaBackupFixture(),
    };
    app = await createServerTestApp({
      exportBackup: vi.fn(async () => backup),
    });

    const response = await app.inject({
      method: "GET",
      url: "/server/backup",
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().amneziaWg3).toEqual(createAmneziaBackupFixture());
  });

  // The import half of the same gap. An unknown property is not validated, so
  // a half-built payload reached the service and was written to the node's own
  // config. The schema must refuse it before the service ever sees it.
  it("refuses an AmneziaWG 3.1 payload missing its config", async () => {
    const importBackup = vi.fn(async () => undefined);
    app = await createServerTestApp({
      importBackup,
      getServerStatus: vi.fn(async () => ({}) as never),
    });

    const response = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: {
        generatedAt: "2026-09-07T00:00:00.000Z",
        serverId: "test-server-id",
        protocols: [Protocol.AMNEZIAWG3],
        amneziaWg3: { presharedKey: "psk", serverPublicKey: "pub", clients: [] },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(importBackup).not.toHaveBeenCalled();
  });

  it("accepts a complete AmneziaWG 3.1 payload", async () => {
    const backup: ServerBackupPayload = {
      generatedAt: "2026-09-07T00:00:00.000Z",
      serverId: "test-server-id",
      protocols: [Protocol.AMNEZIAWG3],
      amneziaWg3: createAmneziaBackupFixture(),
    };
    const importBackup = vi.fn(async () => undefined);
    app = await createServerTestApp({
      exportBackup: vi.fn(async () => backup),
      importBackup,
      // The handler replies with getServerStatus()'s result, and that reply is
      // serialized against getServerSchema's response schema, which requires
      // these fields. Unrelated to the payload under test, but needed so the
      // route reaches 200 instead of failing serialization.
      getServerStatus: vi.fn(
        async () =>
          ({
            id: "test-server-id",
            region: "test-region",
            weight: 100,
            maxPeers: 10,
            totalPeers: 0,
            protocols: [Protocol.AMNEZIAWG3],
            publicHost: "test-public-host",
            agentVersion: "test-agent-version",
          }) as never,
      ),
    });

    const exportResponse = await app.inject({
      method: "GET",
      url: "/server/backup",
      headers: AUTH_HEADERS,
    });
    expect(exportResponse.statusCode).toBe(200);

    // The export and import schemas are two separately hand-written blocks
    // with no shared constant. Feeding the export route's own serialized JSON
    // back in as the import body — rather than building it straight from
    // createAmneziaBackupFixture() — is what would catch either schema
    // declaring a field the other one doesn't. Do not "simplify" this back to
    // posting the fixture directly: that would silently reopen the exact gap
    // this branch fixes.
    const importResponse = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: exportResponse.json(),
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importBackup).toHaveBeenCalledWith(
      expect.objectContaining({ amneziaWg3: createAmneziaBackupFixture() }),
    );
  });

  it("refuses an AmneziaWG 3.1 payload with an empty config", async () => {
    const importBackup = vi.fn(async () => undefined);
    app = await createServerTestApp({
      importBackup,
      getServerStatus: vi.fn(async () => ({}) as never),
    });

    const response = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: {
        generatedAt: "2026-09-07T00:00:00.000Z",
        serverId: "test-server-id",
        protocols: [Protocol.AMNEZIAWG3],
        amneziaWg3: {
          wgConfig: "",
          presharedKey: "psk",
          serverPublicKey: "pub",
          clients: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(importBackup).not.toHaveBeenCalled();
  });

  // Asserted at the route, not on the service's return value. A field the
  // service builds but the response schema does not declare is dropped
  // silently by Fastify's serializer — that is exactly how three fields went
  // missing from this service's backup endpoint.
  it("reports the running agent version to the client", async () => {
    app = await createServerTestApp({
      getServerStatus: vi.fn(async () => ({
        id: "test-server-id",
        region: "test-region",
        weight: 100,
        maxPeers: 250,
        totalPeers: 1,
        protocols: ["amneziawg3"],
        publicHost: "test-public-host",
        agentVersion: "9.9.9",
      })) as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/server",
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().agentVersion).toBe("9.9.9");
  });
});

describe("server load route", () => {
  const load = (cpu: Record<string, unknown>) => ({
    timestamp: "2026-10-10T00:00:00.000Z",
    uptimeSec: 86400,
    loadavg: [0.42, 0.4, 0.37],
    cpu,
    memory: {
      totalBytes: 1024,
      freeBytes: 256,
      usedBytes: 768,
      availableBytes: 512,
    },
    swap: null,
    agent: { pidsCurrent: 12, pidsMax: 128 },
    awg: { amneziawg2: null, amneziawg3: { up: true, peers: 2 } },
    disk: null,
    network: null,
    docker: null,
  });

  // Asserted on the wire for the same reason as the backup and version tests:
  // the CPU figures are new keys on an existing object, and a key the schema
  // does not declare leaves the agent as if it had never been computed.
  it("sends real CPU utilisation, per core, to the client", async () => {
    app = await createServerTestApp({
      getServerLoad: vi.fn(async () =>
        load({
          cores: 2,
          usedPercent: 23.4,
          iowaitPercent: 18.9,
          stealPercent: 0.5,
          perCorePercent: [30.1, 16.7],
          windowSec: 60,
        }),
      ) as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/server/load",
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().cpu).toEqual({
      cores: 2,
      usedPercent: 23.4,
      iowaitPercent: 18.9,
      stealPercent: 0.5,
      perCorePercent: [30.1, 16.7],
      windowSec: 60,
    });
  });

  it("sends nulls through when /proc/stat could not be read", async () => {
    app = await createServerTestApp({
      getServerLoad: vi.fn(async () =>
        load({
          cores: 1,
          usedPercent: null,
          iowaitPercent: null,
          stealPercent: null,
          perCorePercent: null,
          windowSec: null,
        }),
      ) as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/server/load",
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().cpu).toEqual({
      cores: 1,
      usedPercent: null,
      iowaitPercent: null,
      stealPercent: null,
      perCorePercent: null,
      windowSec: null,
    });
  });
});

describe("GET /server/update acknowledgement fields", () => {
  // Fastify drops response properties the schema does not declare, so the
  // service test alone cannot prove the fields reach the wire.
  it("returns acknowledgement, requestAgeSeconds and diagnosticHint", async () => {
    const spool = await mkdtemp(join(tmpdir(), "agent-update-route-"));
    try {
      const repository = "ghcr.io/owner/repo/node-agent";
      const image = `${repository}@sha256:${"a".repeat(64)}`;
      const old = new Date(Date.now() - 600_000).toISOString();
      const body = JSON.stringify({ id: "late", image, requestedAt: old });
      await writeFile(join(spool, "pending.json"), body);
      await writeFile(join(spool, "request.json"), body);
      app = await createServerTestApp({});
      di.container.register({
        [AgentUpdateService.key]: asValue(
          new AgentUpdateService({ repository, spoolDir: spool, ackDeadlineSeconds: 120 }),
        ),
      });

      const response = await app.inject({
        method: "GET",
        url: "/server/update",
        headers: AUTH_HEADERS,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.state).toBe("requested");
      expect(json.acknowledgement).toBe("unacknowledged");
      expect(json.diagnosticHint).toBe("UPDATE_NOT_ACKNOWLEDGED");
      expect(json.requestAgeSeconds).toBeGreaterThanOrEqual(600);
    } finally {
      await rm(spool, { recursive: true, force: true });
    }
  });
});

describe("server egress routes and backup egress integration", () => {
  const sampleReport = (): HostNetworkReport => ({
    daemonVersion: "1.2.0",
    observedMode: "routed",
    egressState: "routed_active",
    bridgeName: "br-awg-egress",
    bridgePresent: true,
    awg3ContainerIpv4: "172.30.0.2",
    tunnelSubnetConflict: false,
    ipv4Addresses: [
      {
        ipv4: "198.51.100.10",
        cidr: "198.51.100.10/24",
        interfaceName: "eth0",
        detectedGatewayIpv4: "198.51.100.1",
      },
    ],
    exits: [
      {
        ipv4: "198.51.100.10",
        hostState: "active",
        txBytes: 100,
        txPackets: 2,
      },
    ],
    observedAt: "2026-11-25T10:00:00Z",
  });

  const sampleDesiredState = (): DesiredState => ({
    schemaVersion: 1,
    blockSmtp: true,
    isolatePrivate: true,
    exits: [
      {
        id: "exit-1",
        ipv4: "198.51.100.10",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        enabled: true,
      },
    ],
    peers: [
      {
        tunnelIpv4: "10.90.0.2",
        exitIp: "198.51.100.10",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        enabled: true,
      },
    ],
  });

  const baseStatus = () => ({
    id: "test-server-id",
    region: "test-region",
    weight: 100,
    maxPeers: 10,
    totalPeers: 0,
    protocols: [Protocol.AMNEZIAWG3],
    publicHost: "198.51.100.10",
    agentVersion: "1.2.0",
    egressReport: sampleReport(),
  });

  it("serializes egressReport on GET /server and serves PUT /server/egress, verify, and mode", async () => {
    const applyEgressState = vi.fn(async () => ({
      ok: true,
      report: sampleReport(),
    }));
    const verifyEgressExit = vi.fn(async () => ({
      ok: true,
      egressIpv4: "198.51.100.10",
      observedIp: "198.51.100.10",
      ipMatch: true,
      httpLatencyMs: 12,
      dnsOk: true,
      dnsServer: "1.1.1.1:53",
      dnsLatencyMs: 8,
    }));
    const switchEgressMode = vi.fn(async () => ({
      ok: true,
      report: sampleReport(),
    }));

    app = await createServerTestApp({
      getServerStatus: vi.fn(async () => baseStatus() as never),
      applyEgressState,
      verifyEgressExit,
      switchEgressMode,
    });

    const statusRes = await app.inject({
      method: "GET",
      url: "/server",
      headers: AUTH_HEADERS,
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().egressReport).toEqual(sampleReport());

    const putRes = await app.inject({
      method: "PUT",
      url: "/server/egress",
      headers: AUTH_HEADERS,
      payload: sampleDesiredState(),
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({ ok: true, report: sampleReport() });
    expect(applyEgressState).toHaveBeenCalledWith(sampleDesiredState());

    const verifyRes = await app.inject({
      method: "POST",
      url: "/server/egress/verify",
      headers: AUTH_HEADERS,
      payload: {
        egressIpv4: "198.51.100.10",
        probeUrl: "https://ip.example/",
        dnsServer: "1.1.1.1",
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().ok).toBe(true);

    const modeRes = await app.inject({
      method: "POST",
      url: "/server/egress/mode",
      headers: AUTH_HEADERS,
      payload: { mode: "routed" },
    });
    expect(modeRes.statusCode).toBe(200);
    expect(modeRes.json().ok).toBe(true);
    expect(switchEgressMode).toHaveBeenCalledWith("routed");

    switchEgressMode.mockResolvedValueOnce({
      ok: false,
      error: "cotenant check failed",
      report: sampleReport(),
    } as never);
    const modeFailRes = await app.inject({
      method: "POST",
      url: "/server/egress/mode",
      headers: AUTH_HEADERS,
      payload: { mode: "masquerade" },
    });
    expect(modeFailRes.statusCode).toBe(200);
    expect(modeFailRes.json()).toEqual({
      ok: false,
      error: "cotenant check failed",
      report: sampleReport(),
    });
  });

  it("round-trips egress state in /server/backup, honours skipEgress=1, and flags legacy imports", async () => {
    const backup: ServerBackupPayload = {
      generatedAt: "2026-11-25T10:00:00.000Z",
      serverId: "test-server-id",
      protocols: [Protocol.AMNEZIAWG3],
      amneziaWg3: createAmneziaBackupFixture(),
      egress: sampleDesiredState(),
    };
    const importBackup = vi
      .fn()
      .mockResolvedValueOnce({ egressWarnings: ["192.0.2.99 missing"] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ egressReconcileRequired: true });

    app = await createServerTestApp({
      exportBackup: vi.fn(async () => backup),
      importBackup,
      getServerStatus: vi.fn(async () => baseStatus() as never),
    });

    const exported = await app.inject({
      method: "GET",
      url: "/server/backup",
      headers: AUTH_HEADERS,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().egress).toEqual(sampleDesiredState());

    const imported = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: exported.json(),
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().egressWarnings).toEqual(["192.0.2.99 missing"]);
    expect(importBackup).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ egress: sampleDesiredState() }),
    );

    const skipped = await app.inject({
      method: "POST",
      url: "/server/backup?skipEgress=1",
      headers: AUTH_HEADERS,
      payload: exported.json(),
    });
    expect(skipped.statusCode).toBe(200);
    expect(importBackup).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ egress: sampleDesiredState() }),
      { skipEgress: true },
    );

    const legacyPayload = { ...exported.json() };
    delete legacyPayload.egress;
    const legacyRes = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: legacyPayload,
    });
    expect(legacyRes.statusCode).toBe(200);
    expect(legacyRes.json().egressReconcileRequired).toBe(true);
  });
});
