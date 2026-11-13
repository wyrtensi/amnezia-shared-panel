import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  bridgeRouteCandidateCheckPayloadSchema,
  verifyBridgeRouteResultSchema,
} from "@amnezia/contracts";
import {
  auditEvents,
  createDatabase,
  encryptSecret,
  jobOutbox,
  nodes,
  reachabilityProbe,
  routeRuleVersions,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
} from "@amnezia/db";
import { inspectAwgVpnLink } from "@amnezia/vpn-config";

import { awg31Link } from "./awg31.fixture.js";
import { createDefaultControlApiService } from "./defaultService.js";
import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const failureOf = async (
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; code?: string; message?: string } | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { statusCode?: number; code?: string; message?: string };
  }
};

const MINUTE = 60_000;

describe("bridge candidate validation (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  let admin: Actor;
  let otherAdmin: Actor;
  // Three repositories over one database: the default (gate closed, no
  // capability), gate open without capability, gate open with capability.
  let repository: PostgresControlRepository;
  let gatedRepository: PostgresControlRepository;
  let capableRepository: PostgresControlRepository;
  const createdNodeIds: string[] = [];
  const createdBridgeIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdRuleIds: string[] = [];
  let probeCreated = false;
  let ipCounter = 0;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  const nextIpv4 = (): string => {
    ipCounter += 1;
    const seed = parseInt(runTag, 16);
    return `46.${(seed >> 8) & 0xff}.${seed & 0xff}.${ipCounter}`;
  };

  const seedNode = async (label: string): Promise<string> => {
    const credentials = encryptSecret("api-key", keyring, 1);
    const labelSecret = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `verify-${runTag}-${label}-${randomBytes(2).toString("hex")}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        protocol: "awg3",
        capabilities: {},
        credentialsCiphertext: credentials.ciphertext,
        credentialsNonce: credentials.nonce,
        credentialsAuthTag: credentials.authTag,
        credentialsKeyVersion: credentials.keyVersion,
        labelSecretCiphertext: labelSecret.ciphertext,
        labelSecretNonce: labelSecret.nonce,
        labelSecretAuthTag: labelSecret.authTag,
        labelSecretKeyVersion: labelSecret.keyVersion,
      })
      .returning();
    if (!node) throw new Error("Failed to seed node");
    createdNodeIds.push(node.id);
    return node.id;
  };

  const seedKey = async (
    nodeId: string,
    artifact: string,
    options: {
      owner?: Actor;
      protocol?: "awg2" | "awg3";
      state?: "active" | "disabled";
      routeProfile?: "full_tunnel" | "ru_blacklist";
    } = {},
  ): Promise<string> => {
    const secret = encryptSecret(artifact, keyring, 1);
    const [row] = await db()
      .insert(vpnKeys)
      .values({
        ownerId: (options.owner ?? admin).id,
        nodeId,
        nodeLabel: `verify_${runTag}_${randomBytes(3).toString("hex")}`,
        protocol: options.protocol ?? "awg3",
        routeProfile: options.routeProfile ?? "full_tunnel",
        state: options.state ?? "active",
        configCiphertext: secret.ciphertext,
        configNonce: secret.nonce,
        configAuthTag: secret.authTag,
        configKeyVersion: secret.keyVersion,
      })
      .returning({ id: vpnKeys.id });
    if (!row) throw new Error("Failed to seed key");
    return row.id;
  };

  const createBridge = async (name = `Bridge ${runTag}`) => {
    const bridge = await repository.createBridge(admin, {
      name,
      publicIpv4: nextIpv4(),
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
    createdBridgeIds.push(bridge.id);
    return bridge;
  };

  /** What the bridge-agent poller (Task 5) will write: a fresh online registration. */
  const observe = async (bridgeId: string, routeId: string, marker: string | null) => {
    const at = new Date();
    await db()
      .update(vpnBridges)
      .set({ managementStatus: "ok", lastObservedAt: at })
      .where(eq(vpnBridges.id, bridgeId));
    await db()
      .update(vpnBridgeRoutes)
      .set({
        observedOnline: marker !== null,
        observedRegistrationMarker: marker,
        observedAt: at,
      })
      .where(eq(vpnBridgeRoutes.id, routeId));
  };

  const routeRow = async (routeId: string) => {
    const [row] = await db().select().from(vpnBridgeRoutes).where(eq(vpnBridgeRoutes.id, routeId));
    return row;
  };

  const revisionOf = async (nodeId: string): Promise<number> => {
    const [row] = await db()
      .select({ revision: nodes.vpnEndpointRevision })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    return row?.revision ?? -1;
  };

  const activate = (nodeId: string, routeId: string | null, revision: number) =>
    repository.updateNode(admin, nodeId, {
      vpnBridgeRouteId: routeId,
      expectedVpnEndpointRevision: revision,
    }) as Promise<{ vpnEndpoint: { changed: boolean; vpnEndpointRevision: number } }>;

  const operatorVerify = (routeId: string, registrationMarker: string, repo = repository) =>
    repo.verifyBridgeRoute(admin, routeId, {
      method: "operator",
      registrationMarker,
      confirmHandshakeAndHttp: true,
    });

  const endpointOf = (link: string): string | null => {
    const inspected = inspectAwgVpnLink(link);
    return inspected.kind === "awg31" ? `${inspected.endpoint.host}:${inspected.endpoint.port}` : null;
  };

  const candidateJobs = (routeId: string) =>
    db()
      .select()
      .from(jobOutbox)
      .where(
        and(
          eq(jobOutbox.type, BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE),
          sql`${jobOutbox.payload} ->> 'routeId' = ${routeId}`,
        ),
      );

  const seedProbe = async (enabled = true) => {
    await db().delete(reachabilityProbe);
    const credentials = encryptSecret("probe-api-key-".padEnd(40, "x"), keyring, 1);
    await db().insert(reachabilityProbe).values({
      label: "Verify probe",
      apiBaseUrl: "http://probe-host.invalid:4002",
      credentialsCiphertext: credentials.ciphertext,
      credentialsNonce: credentials.nonce,
      credentialsAuthTag: credentials.authTag,
      credentialsKeyVersion: credentials.keyVersion,
      controlUrl: "https://control.invalid/",
      enabled,
    });
    probeCreated = true;
  };

  const seedAdmin = async (
    label: string,
    policyOverride?: { allowConfigRedownload: boolean },
  ): Promise<Actor> => {
    const [user] = await db()
      .insert(users)
      .values({
        email: `verify-${label}-${runTag}@example.com`,
        role: "admin",
        ...(policyOverride ? { policyOverride } : {}),
      })
      .returning();
    if (!user) throw new Error("Failed to seed admin");
    createdUserIds.push(user.id);
    return { id: user.id, email: user.email, displayName: null, role: "admin", status: "active" };
  };

  beforeAll(async () => {
    if (!database) return;
    repository = new PostgresControlRepository({ db: database.db, keyring });
    gatedRepository = new PostgresControlRepository({
      db: database.db,
      keyring,
      bridgeJobsEnabled: true,
    });
    capableRepository = new PostgresControlRepository({
      db: database.db,
      keyring,
      bridgeJobsEnabled: true,
      probeSupportsBridgeMeasurement: () => true,
    });
    admin = await seedAdmin("admin");
    otherAdmin = await seedAdmin("other");
  });

  afterEach(async () => {
    if (!database) return;
    if (createdNodeIds.length > 0 || createdBridgeIds.length > 0) {
      const routeIds = (
        await database.db
          .select({ id: vpnBridgeRoutes.id })
          .from(vpnBridgeRoutes)
          .where(
            or(
              createdNodeIds.length > 0 ? inArray(vpnBridgeRoutes.nodeId, createdNodeIds) : undefined,
              createdBridgeIds.length > 0
                ? inArray(vpnBridgeRoutes.bridgeId, createdBridgeIds)
                : undefined,
            ),
          )
      ).map((row) => row.id);
      if (routeIds.length > 0) {
        await database.db
          .delete(jobOutbox)
          .where(
            and(
              eq(jobOutbox.type, BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE),
              inArray(sql`${jobOutbox.payload} ->> 'routeId'`, routeIds),
            ),
          );
        await database.db.delete(vpnBridgeRoutes).where(inArray(vpnBridgeRoutes.id, routeIds));
      }
    }
    if (createdBridgeIds.length > 0) {
      await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, createdBridgeIds));
    }
    if (createdNodeIds.length > 0) {
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.nodeId, createdNodeIds));
      await database.db.delete(nodes).where(inArray(nodes.id, createdNodeIds));
    }
    if (probeCreated) {
      await database.db.delete(reachabilityProbe);
      probeCreated = false;
    }
    createdBridgeIds.length = 0;
    createdNodeIds.length = 0;
  });

  afterAll(async () => {
    if (!database) return;
    if (createdRuleIds.length > 0) {
      await database.db.delete(routeRuleVersions).where(inArray(routeRuleVersions.id, createdRuleIds));
    }
    if (createdUserIds.length > 0) {
      await database.db.delete(auditEvents).where(inArray(auditEvents.actorUserId, createdUserIds));
      await database.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await database.client.end();
  });

  const draftRoute = async (nodeId: string, name?: string) => {
    const bridge = await createBridge(name);
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    return { bridge, route };
  };

  describe("operator verification", () => {
    runDatabaseTest("is bound to the observed marker and completes the draft at activation", async () => {
      const nodeId = await seedNode("operator");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");

      const mismatch = await failureOf(operatorVerify(route.id, "m-2"));
      expect(mismatch).toMatchObject({ statusCode: 409, code: "BRIDGE_OBSERVATION_STALE" });
      expect((await routeRow(route.id))?.verificationResult).toBeNull();

      const result = verifyBridgeRouteResultSchema.parse(await operatorVerify(route.id, "m-1"));
      expect(result).toMatchObject({
        method: "operator",
        routeId: route.id,
        route: {
          verificationMethod: "operator",
          verifiedRegistrationMarker: "m-1",
          verificationResult: "success",
          verificationError: null,
        },
      });
      const row = await routeRow(route.id);
      expect(row?.verifiedAt).toBeInstanceOf(Date);
      const [audit] = await db()
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, "vpn_bridge_route.verified"), eq(auditEvents.targetId, route.id)),
        );
      expect(audit?.metadata).toEqual({
        nodeId,
        bridgeId: bridge.id,
        method: "operator",
        registrationMarker: "m-1",
      });

      // Completing the draft: the activation guard accepts this verification.
      const activated = await activate(nodeId, route.id, 0);
      expect(activated.vpnEndpoint).toMatchObject({ changed: true, vpnEndpointRevision: 1 });
      expect((await routeRow(route.id))?.state).toBe("active");
    });

    runDatabaseTest("a changed registration after verification blocks activation", async () => {
      const nodeId = await seedNode("reconnect");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      await operatorVerify(route.id, "m-1");
      // frpc reconnected: a new registration marker.
      await observe(bridge.id, route.id, "m-2");
      expect(await failureOf(activate(nodeId, route.id, 0))).toMatchObject({
        code: "BRIDGE_ROUTE_UNVERIFIED",
      });
      expect(await revisionOf(nodeId)).toBe(0);
    });

    runDatabaseTest("without an observation the marker is stored and compared at activation", async () => {
      const nodeId = await seedNode("unobserved");
      const { bridge, route } = await draftRoute(nodeId);
      await operatorVerify(route.id, "m-7");
      expect((await routeRow(route.id))?.verifiedRegistrationMarker).toBe("m-7");
      // No fresh observation: activation refuses.
      expect(await failureOf(activate(nodeId, route.id, 0))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });
      // The poller later reports the same registration: activation passes.
      await observe(bridge.id, route.id, "m-7");
      expect((await activate(nodeId, route.id, 0)).vpnEndpoint.changed).toBe(true);
    });

    runDatabaseTest("a verification older than 30 minutes is refused at activation", async () => {
      const nodeId = await seedNode("old");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      await operatorVerify(route.id, "m-1");
      await db()
        .update(vpnBridgeRoutes)
        .set({ verifiedAt: new Date(Date.now() - 31 * MINUTE) })
        .where(eq(vpnBridgeRoutes.id, route.id));
      expect(await failureOf(activate(nodeId, route.id, 0))).toMatchObject({
        code: "BRIDGE_ROUTE_UNVERIFIED",
      });
      // A fresh verification of the same registration activates.
      await operatorVerify(route.id, "m-1");
      expect((await activate(nodeId, route.id, 0)).vpnEndpoint.changed).toBe(true);
    });

    runDatabaseTest("refuses the active route and an unknown route", async () => {
      const nodeId = await seedNode("active");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      await operatorVerify(route.id, "m-1");
      await activate(nodeId, route.id, 0);
      expect(await failureOf(operatorVerify(route.id, "m-1"))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_ROUTE_ACTIVE",
      });
      expect(await failureOf(operatorVerify(randomUUID(), "m-1"))).toMatchObject({
        statusCode: 404,
        code: "BRIDGE_ROUTE_NOT_FOUND",
      });
    });

    runDatabaseTest("reactivating a retiring route needs a fresh verification", async () => {
      const nodeId = await seedNode("retiring");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      await operatorVerify(route.id, "m-1");
      await activate(nodeId, route.id, 0);
      await activate(nodeId, null, 1);
      expect((await routeRow(route.id))?.state).toBe("retiring");
      expect(await failureOf(activate(nodeId, route.id, 2))).toMatchObject({
        code: "BRIDGE_ROUTE_UNVERIFIED",
      });
      await operatorVerify(route.id, "m-1");
      expect((await activate(nodeId, route.id, 2)).vpnEndpoint).toMatchObject({
        changed: true,
        vpnEndpointRevision: 3,
      });
    });
  });

  describe("probe verification", () => {
    runDatabaseTest("is refused while bridge jobs are disabled", async () => {
      const nodeId = await seedNode("gate");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      await seedProbe();
      expect(
        await failureOf(repository.verifyBridgeRoute(admin, route.id, { method: "probe" })),
      ).toMatchObject({ statusCode: 409, code: "BRIDGE_JOBS_DISABLED" });
      expect(await candidateJobs(route.id)).toHaveLength(0);
    });

    runDatabaseTest("needs an enabled probe with the bridge-measurement capability", async () => {
      const nodeId = await seedNode("capability");
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      await db().delete(reachabilityProbe);
      const probe = { method: "probe" as const };
      expect(await failureOf(capableRepository.verifyBridgeRoute(admin, route.id, probe))).toMatchObject({
        code: "BRIDGE_UNSUPPORTED_CAPABILITY",
      });
      await seedProbe(false);
      expect(await failureOf(capableRepository.verifyBridgeRoute(admin, route.id, probe))).toMatchObject({
        code: "BRIDGE_UNSUPPORTED_CAPABILITY",
      });
      // An enabled probe whose capability is unknown (the default lookup).
      await seedProbe(true);
      expect(await failureOf(gatedRepository.verifyBridgeRoute(admin, route.id, probe))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_UNSUPPORTED_CAPABILITY",
      });
      expect(await candidateJobs(route.id)).toHaveLength(0);
    });

    runDatabaseTest("queues one candidate check bound to the observed marker", async () => {
      const nodeId = await seedNode("queue");
      const { bridge, route } = await draftRoute(nodeId);
      await seedProbe();
      // Nothing observed yet: nothing to bind the check to.
      expect(
        await failureOf(capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" })),
      ).toMatchObject({ code: "BRIDGE_OBSERVATION_STALE" });

      await observe(bridge.id, route.id, "m-1");
      const first = verifyBridgeRouteResultSchema.parse(
        await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" }),
      );
      expect(first).toMatchObject({ method: "probe", queued: true, registrationMarker: "m-1" });
      const jobs = await candidateJobs(route.id);
      expect(jobs).toHaveLength(1);
      const payload = bridgeRouteCandidateCheckPayloadSchema.parse(jobs[0]?.payload);
      expect(payload).toMatchObject({ routeId: route.id, nodeId, registrationMarker: "m-1" });
      // IDs and the marker only: no config and no key id.
      expect(Object.keys(jobs[0]?.payload ?? {}).sort()).toEqual(
        ["nodeId", "registrationMarker", "requestedAt", "routeId"],
      );
      // A repeat while it is pending returns the same job.
      const again = verifyBridgeRouteResultSchema.parse(
        await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" }),
      );
      expect(again).toMatchObject({
        queued: false,
        status: "pending",
        jobId: first.method === "probe" ? first.jobId : "",
      });
      expect(await candidateJobs(route.id)).toHaveLength(1);
      // Queuing changes nothing on the route.
      expect((await routeRow(route.id))?.verificationResult).toBeNull();

      // Once that job finished and its run settled, a new request queues a
      // new job.
      await db().update(jobOutbox).set({ status: "completed" }).where(eq(jobOutbox.id, jobs[0]!.id));
      const third = verifyBridgeRouteResultSchema.parse(
        await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" }),
      );
      expect(third).toMatchObject({ queued: true });
      expect(await candidateJobs(route.id)).toHaveLength(2);

      const audits = await db()
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "vpn_bridge_route.verification_requested"),
            eq(auditEvents.targetId, route.id),
          ),
        );
      expect(audits).toHaveLength(2);
      expect(Object.keys(audits[0]?.metadata ?? {}).sort()).toEqual(
        ["bridgeId", "jobId", "method", "nodeId", "registrationMarker"],
      );
    });

    runDatabaseTest("a check whose run is still out answers the next request instead of a dropped duplicate", async () => {
      const nodeId = await seedNode("inflight");
      const { bridge, route } = await draftRoute(nodeId);
      await seedProbe();
      await observe(bridge.id, route.id, "m-1");
      const first = verifyBridgeRouteResultSchema.parse(
        await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" }),
      );
      // The worker claimed the probe, started the run and completed the job.
      const runId = randomUUID();
      await db()
        .update(reachabilityProbe)
        .set({
          candidateRunId: runId,
          candidateRouteId: route.id,
          candidateRegistrationMarker: "m-1",
          candidateRequestedAt: new Date(),
          candidateRunStartedAt: new Date(),
        });
      await db()
        .update(jobOutbox)
        .set({ status: "completed" })
        .where(eq(jobOutbox.id, first.method === "probe" ? (first.jobId ?? "") : ""));

      const second = verifyBridgeRouteResultSchema.parse(
        await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" }),
      );
      expect(second).toMatchObject({
        method: "probe",
        queued: false,
        status: "running",
        runId,
        jobId: first.method === "probe" ? first.jobId : "",
        registrationMarker: "m-1",
      });
      // No second job that would wait behind the run and lose its result.
      expect(await candidateJobs(route.id)).toHaveLength(1);

      // frpc reconnected meanwhile: the running check is for the old
      // registration and does not answer a request for the new one.
      await observe(bridge.id, route.id, "m-2");
      expect(
        await failureOf(capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" })),
      ).toMatchObject({ statusCode: 409, code: "BRIDGE_CHECK_PENDING" });
      expect(await candidateJobs(route.id)).toHaveLength(1);

      // Once the run settled, the new registration gets its own check.
      await db().update(reachabilityProbe).set({
        candidateRunId: null,
        candidateRouteId: null,
        candidateRegistrationMarker: null,
        candidateRequestedAt: null,
        candidateRunStartedAt: null,
      });
      const third = verifyBridgeRouteResultSchema.parse(
        await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" }),
      );
      expect(third).toMatchObject({ status: "queued", queued: true, registrationMarker: "m-2" });
    });

    runDatabaseTest("a queued check for an older marker is reported, not reused", async () => {
      const nodeId = await seedNode("stalepending");
      const { bridge, route } = await draftRoute(nodeId);
      await seedProbe();
      await observe(bridge.id, route.id, "m-1");
      await capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" });
      await observe(bridge.id, route.id, "m-2");
      expect(
        await failureOf(capableRepository.verifyBridgeRoute(admin, route.id, { method: "probe" })),
      ).toMatchObject({ statusCode: 409, code: "BRIDGE_CHECK_PENDING" });
      expect(await candidateJobs(route.id)).toHaveLength(1);
    });
  });

  describe("test-config preview", () => {
    const seedActiveRule = async () => {
      const version = `verify-${runTag}-${randomBytes(2).toString("hex")}`;
      const [rule] = await db()
        .insert(routeRuleVersions)
        .values({
          profile: "ru_blacklist",
          version,
          sourceUrl: "https://feed.example/list.lst",
          sourceChecksum: version,
          status: "active",
          cidrCount: 1,
          domainCount: 0,
          payload: { cidrs: ["203.0.113.0/24"], domains: [] },
          publishedAt: new Date(),
        })
        .returning({ id: routeRuleVersions.id });
      if (!rule) throw new Error("Failed to seed rule");
      createdRuleIds.push(rule.id);
    };

    runDatabaseTest("renders the draft endpoint with no delivery side effects", async () => {
      await seedActiveRule();
      const service = createDefaultControlApiService({ repository, keyring });
      const nodeId = await seedNode("preview");
      const keyId = await seedKey(nodeId, awg31Link(), { routeProfile: "ru_blacklist" });
      const { bridge, route } = await draftRoute(nodeId);
      await observe(bridge.id, route.id, "m-1");
      const [keyBefore] = await db().select().from(vpnKeys).where(eq(vpnKeys.id, keyId));
      const routeBefore = await routeRow(route.id);

      const preview = await service.getBridgeRouteTestConfig(admin, route.id, keyId);
      expect(preview.registrationMarker).toBe("m-1");
      expect(preview.filename).toMatch(/\.vpn$/);
      expect(endpointOf(preview.body)).toBe(`${bridge.publicIpv4}:${route.publicUdpPort}`);

      // Nothing moved: assignment, revision, key row (rules applied, profile).
      expect(await revisionOf(nodeId)).toBe(0);
      expect(await routeRow(route.id)).toEqual(routeBefore);
      const [keyAfter] = await db().select().from(vpnKeys).where(eq(vpnKeys.id, keyId));
      expect(keyAfter).toEqual(keyBefore);
      expect(keyAfter?.routeRuleVersionId).toBeNull();
      // The ordinary download still serves the direct endpoint and is the one
      // that marks the rules as delivered.
      const normal = await service.getKeyConfig(admin, keyId, "vpn", false);
      expect(endpointOf(String(normal.body))).toBe("vpn.example.test:443");
      const [delivered] = await db().select().from(vpnKeys).where(eq(vpnKeys.id, keyId));
      expect(delivered?.routeRuleVersionId).not.toBeNull();

      const [audit] = await db()
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "vpn_bridge_route.test_config_issued"),
            eq(auditEvents.targetId, route.id),
          ),
        );
      expect(audit?.metadata).toEqual({ keyId, nodeId, bridgeId: bridge.id });
    });

    runDatabaseTest("follows the normal redownload policy", async () => {
      const restricted = await seedAdmin("nodownload", { allowConfigRedownload: false });
      const service = createDefaultControlApiService({ repository, keyring });
      const nodeId = await seedNode("policy");
      const keyId = await seedKey(nodeId, awg31Link(), { owner: restricted });
      const { route } = await draftRoute(nodeId);
      expect(
        await failureOf(service.getBridgeRouteTestConfig(restricted, route.id, keyId)),
      ).toMatchObject({ statusCode: 403, code: "POLICY_DENIED" });
      const audits = await db()
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "vpn_bridge_route.test_config_issued"),
            eq(auditEvents.targetId, route.id),
          ),
        );
      expect(audits).toHaveLength(0);
    });

    runDatabaseTest("returns a null marker when no registration was observed", async () => {
      const service = createDefaultControlApiService({ repository, keyring });
      const nodeId = await seedNode("nomarker");
      const keyId = await seedKey(nodeId, awg31Link());
      const { route } = await draftRoute(nodeId);
      const preview = await service.getBridgeRouteTestConfig(admin, route.id, keyId);
      expect(preview.registrationMarker).toBeNull();
    });

    runDatabaseTest("rejects cross-node, other-owner, inactive and non-3.1 keys", async () => {
      const service = createDefaultControlApiService({ repository, keyring });
      const nodeId = await seedNode("keys");
      const otherNodeId = await seedNode("keys-other");
      const { route } = await draftRoute(nodeId);
      const preview = (keyId: string) => service.getBridgeRouteTestConfig(admin, route.id, keyId);

      const crossNode = await seedKey(otherNodeId, awg31Link());
      expect(await failureOf(preview(crossNode))).toMatchObject({
        statusCode: 403,
        code: "BRIDGE_TEST_KEY_WRONG_NODE",
      });
      const otherOwner = await seedKey(nodeId, awg31Link(), { owner: otherAdmin });
      expect(await failureOf(preview(otherOwner))).toMatchObject({
        statusCode: 404,
        code: "KEY_NOT_FOUND",
      });
      const disabled = await seedKey(nodeId, awg31Link(), { state: "disabled" });
      expect(await failureOf(preview(disabled))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_TEST_KEY_UNSUITABLE",
      });
      const native = await seedKey(nodeId, awg31Link({ protocolVersion: "2" }), { protocol: "awg2" });
      expect(await failureOf(preview(native))).toMatchObject({ code: "BRIDGE_TEST_KEY_UNSUITABLE" });
      const fallback = await seedKey(nodeId, awg31Link({ protocolVersion: "2" }));
      expect(await failureOf(preview(fallback))).toMatchObject({ code: "BRIDGE_TEST_KEY_UNSUITABLE" });
      const unmarked = await seedKey(nodeId, awg31Link({ protocolVersion: null }));
      expect(await failureOf(preview(unmarked))).toMatchObject({ code: "BRIDGE_TEST_KEY_UNSUITABLE" });
      expect(await failureOf(preview(randomUUID()))).toMatchObject({ code: "KEY_NOT_FOUND" });
      expect(
        await failureOf(service.getBridgeRouteTestConfig(admin, randomUUID(), crossNode)),
      ).toMatchObject({ statusCode: 404, code: "BRIDGE_ROUTE_NOT_FOUND" });

      const audits = await db()
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "vpn_bridge_route.test_config_issued"),
            eq(auditEvents.targetId, route.id),
          ),
        );
      expect(audits).toHaveLength(0);
    });

    runDatabaseTest("prepares a second node while the first node's active endpoint is still exported", async () => {
      const service = createDefaultControlApiService({ repository, keyring });
      const first = await seedNode("first");
      const second = await seedNode("second");
      const firstKey = await seedKey(first, awg31Link());
      const secondKey = await seedKey(second, awg31Link());
      const bridge = await createBridge("Shared");
      const { route: firstRoute } = await repository.prepareBridgeRoute(admin, first, {
        bridgeId: bridge.id,
      });
      await observe(bridge.id, firstRoute.id, "m-a");
      await operatorVerify(firstRoute.id, "m-a");
      await activate(first, firstRoute.id, 0);
      const active = `${bridge.publicIpv4}:${firstRoute.publicUdpPort}`;
      const exportOf = async (keyId: string) =>
        endpointOf(String((await service.getKeyConfig(admin, keyId, "vpn", false)).body));
      expect(await exportOf(firstKey)).toBe(active);

      // Second node on the same bridge: its own port, its own draft.
      const { route: secondRoute } = await repository.prepareBridgeRoute(admin, second, {
        bridgeId: bridge.id,
      });
      expect(secondRoute.publicUdpPort).not.toBe(firstRoute.publicUdpPort);
      const preview = await service.getBridgeRouteTestConfig(admin, secondRoute.id, secondKey);
      expect(endpointOf(preview.body)).toBe(`${bridge.publicIpv4}:${secondRoute.publicUdpPort}`);
      // Meanwhile the first node keeps exporting its active endpoint, and the
      // second node stays Direct until its own activation.
      expect(await exportOf(firstKey)).toBe(active);
      expect(await exportOf(secondKey)).toBe("vpn.example.test:443");

      await observe(bridge.id, secondRoute.id, "m-b");
      await operatorVerify(secondRoute.id, "m-b");
      await activate(second, secondRoute.id, 0);
      expect(await exportOf(secondKey)).toBe(`${bridge.publicIpv4}:${secondRoute.publicUdpPort}`);
      expect(await exportOf(firstKey)).toBe(active);
    });
  });

  runDatabaseTest("canceling a draft releases its port", async () => {
    const nodeId = await seedNode("cancel");
    const { bridge, route } = await draftRoute(nodeId);
    // A draft on a never-enrolled bridge is released on confirmation (R9).
    const released = await repository.releaseBridgeRoute(admin, route.id);
    expect(released).toMatchObject({ id: route.id, released: true, publicUdpPort: route.publicUdpPort });
    expect(await routeRow(route.id)).toBeUndefined();
    const again = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    expect(again.route.publicUdpPort).toBe(route.publicUdpPort);
  });
});
