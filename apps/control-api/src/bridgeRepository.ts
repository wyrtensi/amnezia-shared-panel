import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  isPublishableAgentImage,
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  bridgeFrpProxyName,
  nodeServedProtocols,
  probeCapabilityInputOf,
  probeSupportsBridgeMeasurement,
  type BridgeRouteCandidateCheckPayload,
  type ProbeCapabilityInput,
  type VerifyBridgeRouteRequest,
  type VerifyBridgeRouteResult,
  type Bridge,
  type BridgeEligibility,
  toUserReachability,
  type AdminOverviewBridges,
  type BridgeRouteSummary,
  type CreateBridgeRequest,
  type DeleteBridgeResult,
  type NodeBridgeRoute,
  type NodeBridgeRoutes,
  type NodeEndpointAssignment,
  type PrepareBridgeRouteRequest,
  type PrepareBridgeRouteResult,
  type ReleaseBridgeRouteResult,
  type BridgeAgentOfferedImage,
  type BridgeAgentUpdateSummary,
  type BridgeAgentUpdateView,
  type BridgeRollbackPreflight,
  type RequestBridgeAgentUpdate,
  type RequestBridgeAgentUpdateResult,
  type UpdateBridgeRequest,
} from "@amnezia/contracts";
import {
  bridgeAgentReleases,
  auditEvents,
  decryptSecret,
  jobOutbox,
  nodes,
  nodeReachabilityResults,
  reachabilityProbe,
  resetNodeEndpointEvidence,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";
import {
  bridgeConfigUnsupported,
  canRenderBridgeEndpoint,
  classifyKeyForBridge,
} from "./bridgeEndpoint.js";
import { readBridgeRollbackPreflight } from "./bridgeRollback.js";
import { BridgeAgentUpdates } from "./bridgeAgentUpdate.js";
import { assertBridgeJobsEnabled } from "./bridgeConfig.js";
import { storeEnrollment, verifyEnrollmentCandidate } from "./bridgeEnrollment.js";
import {
  checkActivationGuard,
  checkReleaseGuard,
} from "./bridgeGuards.js";
import {
  UNKNOWN_AWG_PATH,
  effectiveManagementStatus,
  type AwgPathEvidence,
  overviewBridgeOf,
  routeRegistration,
  routeVerification,
} from "./bridgeReadModel.js";
import { bridgeSetupCommands, routeSetupCommands } from "./bridgeSetupCommands.js";
import { ApiError, type Actor } from "./service.js";

// The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`.
export type BridgeTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type BridgeRow = typeof vpnBridges.$inferSelect;
type RouteRow = typeof vpnBridgeRoutes.$inferSelect;

export type BridgeRepositoryOptions = {
  db: Database;
  /** `VPN_BRIDGE_OBSERVATION_STALE_MS`, see bridgeConfig.ts. */
  observationStaleMs: number;
  /**
   * Decrypts stored key artifacts for the eligibility dry-run and encrypts
   * the bridge-agent credential at enrollment (with `activeKeyVersion`).
   */
  keyring: EncryptionKeyring;
  activeKeyVersion: number;
  /** `VPN_BRIDGE_MANAGEMENT_HOSTS`: hosts a management URL may name. */
  managementHosts: readonly string[];
  /** The HTTP client for bridge-agent calls at enrollment; tests inject one. */
  bridgeAgentFetch?: typeof fetch;
  bridgeAgentTimeoutMs?: number;
  /**
   * `BRIDGE_AGENT_IMAGE_REPOSITORY`: the approved bridge-agent repository. Only
   * its resolved release is ever put in a setup command; unset means none.
   */
  bridgeAgentImageRepository?: string;
  /** `VPN_BRIDGE_JOBS_ENABLED`: whether probe candidate checks may be queued. */
  jobsEnabled?: boolean;
  /**
   * The capability lookup for probe candidate checks. Defaults to the shared
   * `probeSupportsBridgeMeasurement`; tests inject a stand-in.
   */
  probeSupportsBridgeMeasurement?: (probe: ProbeCapabilityInput, now: Date) => boolean;
};

/** A held route as the test-config preview needs it. */
export type BridgeRouteTarget = {
  id: string;
  nodeId: string;
  bridgeId: string;
  state: RouteRow["state"];
  publicUdpPort: number;
  bridgePublicIpv4: string;
  observedRegistrationMarker: string | null;
};

/** Per-node endpoint state for the shared infrastructure view. */
export type NodeEndpointSummary = {
  vpnEndpointRevision: number;
  activeRoute: NodeBridgeRoute | null;
};

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const bridgeNotFound = () => new ApiError(404, "Bridge not found", "BRIDGE_NOT_FOUND");
const routeNotFound = () =>
  new ApiError(404, "Bridge route not found", "BRIDGE_ROUTE_NOT_FOUND");
const nodeNotFound = () => new ApiError(404, "Node not found", "NODE_NOT_FOUND");

/**
 * The PG error behind a drizzle error, when it is one. drizzle wraps the
 * driver's error, so the SQLSTATE and constraint are on `cause`.
 */
const pgErrorOf = (
  error: unknown,
): { code: string; constraint_name?: string } | null => {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const row = current as { code?: unknown; constraint_name?: string };
      if (typeof row.code === "string" && /^[0-9A-Z]{5}$/.test(row.code)) {
        return { code: row.code, constraint_name: row.constraint_name };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};

/**
 * Maps the constraint errors the bridge tables can raise to their stable API
 * codes. A constraint violation aborts the PG transaction, so this runs on the
 * error after the transaction has rolled back, never inside it.
 */
export const mapBridgeConstraintError = (error: unknown): unknown => {
  const pg = pgErrorOf(error);
  if (!pg) return error;
  if (pg.code === "23505") {
    switch (pg.constraint_name) {
      case "vpn_bridges_public_ipv4_unique":
        return new ApiError(
          409,
          "A bridge with this public IPv4 address is already registered",
          "BRIDGE_IPV4_CONFLICT",
        );
      case "vpn_bridge_routes_bridge_port_unique":
        return new ApiError(
          409,
          "This bridge UDP port is already held by another route",
          "BRIDGE_PORT_TAKEN",
        );
      case "vpn_bridge_routes_node_bridge_unique":
        return new ApiError(
          409,
          "This node already holds a route on this bridge",
          "BRIDGE_ROUTE_PAIR_CONFLICT",
        );
      default:
        return error;
    }
  }
  if (pg.code === "23503") {
    switch (pg.constraint_name) {
      case "vpn_bridge_routes_bridge_id_vpn_bridges_id_fk":
        return new ApiError(
          409,
          "The bridge still holds draft, active or retiring routes",
          "BRIDGE_HAS_ROUTES",
        );
      case "vpn_bridge_routes_node_id_nodes_id_fk":
        return new ApiError(
          409,
          "The node still holds draft, active or retiring bridge routes",
          "NODE_HAS_BRIDGE_ROUTES",
        );
      default:
        return error;
    }
  }
  return error;
};

const toNodeRoute = (
  route: RouteRow,
  bridge: BridgeRow,
  now: Date,
  staleMs: number,
  awgPath: AwgPathEvidence,
): NodeBridgeRoute => {
  const registration = routeRegistration(route, bridge, now, staleMs);
  return {
    id: route.id,
    nodeId: route.nodeId,
    bridgeId: route.bridgeId,
    publicUdpPort: route.publicUdpPort,
    state: route.state,
    frpProxyName: route.frpProxyName,
    observedOnline: route.observedOnline,
    observedRegistrationMarker: route.observedRegistrationMarker,
    observedAt: iso(route.observedAt),
    verificationMethod: route.verificationMethod,
    verifiedRegistrationMarker: route.verifiedRegistrationMarker,
    verifiedAt: iso(route.verifiedAt),
    verificationResult: route.verificationResult,
    verificationError: route.verificationError,
    activatedAt: iso(route.activatedAt),
    retiringSince: iso(route.retiringSince),
    createdAt: route.createdAt.toISOString(),
    bridgeName: bridge.name,
    bridgePublicIpv4: bridge.publicIpv4,
    bridgeControlTcpPort: bridge.controlTcpPort,
    // Computed like `Bridge.managementStatus`: a stored `ok` past the stale
    // window reads `stale`.
    bridgeManagementStatus: effectiveManagementStatus(bridge, now, staleMs),
    bridgeLastObservedAt: iso(bridge.lastObservedAt),
    registration,
    verification: routeVerification(route, registration, now, awgPath),
    setupCommands: routeSetupCommands({
      id: route.id,
      publicUdpPort: route.publicUdpPort,
      bridgePublicIpv4: bridge.publicIpv4,
      bridgeControlTcpPort: bridge.controlTcpPort,
    }),
  };
};

const toBridge = (
  row: BridgeRow,
  routes: BridgeRouteSummary[],
  now: Date,
  staleMs: number,
  agentImage: string | null,
  agentUpdate: BridgeAgentUpdateSummary | undefined,
): Bridge => ({
  id: row.id,
  name: row.name,
  publicIpv4: row.publicIpv4,
  controlTcpPort: row.controlTcpPort,
  udpPortStart: row.udpPortStart,
  udpPortEnd: row.udpPortEnd,
  capacity: row.udpPortEnd - row.udpPortStart + 1,
  // Every route row is a held reservation (draft, active or retiring);
  // releasing a route deletes it.
  heldPorts: routes.length,
  managementStatus: effectiveManagementStatus(row, now, staleMs),
  lastObservedAt: iso(row.lastObservedAt),
  // Enrollment state and safe metadata; the credential is never read here.
  management: {
    apiUrl: row.managementApiUrl,
    enrolled: row.managementEnrolledAt !== null,
    enrolledAt: iso(row.managementEnrolledAt),
    agentVersion: row.agentVersion,
    agentApiVersion: row.agentApiVersion,
    agentCapabilities: row.agentCapabilities,
    frpsVersion: row.frpsVersion,
    frpsReachable: row.frpsReachable,
    lastErrorCode: row.lastErrorCode,
    lastPollAttemptAt: iso(row.lastPollAttemptAt),
  },
  agentUpdate,
  routes,
  setupCommands: bridgeSetupCommands(row, agentImage),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Persistence for the bridge registry: bridges, route reservations, the
 * node's active endpoint assignment and route release.
 *
 * Lock order, everywhere a route is mutated: node row -> bridge row -> route
 * rows. Route mutation is serialized per VPN node by its node row lock; port
 * allocation is serialized per bridge by the bridge row lock, with the unique
 * (bridge, port) index as the final guard.
 *
 * The node row is locked `FOR NO KEY UPDATE`, not `FOR UPDATE`: it still
 * serializes every route mutation and node edit on that node, but it does not
 * block the key-share locks that foreign-key inserts referencing the node take
 * (reachability history, keys, telemetry). With `FOR UPDATE`, an activation
 * that resets the node's reachability rows deadlocks against a worker ingest
 * that has upserted those rows and then inserts a history row. The worker's
 * ingest now takes the node rows `FOR SHARE` before it writes any
 * reachability row, so an activation and an ingest serialize on the node
 * row and the ingest always sees the endpoint revision it writes against.
 */
export class PostgresBridgeRepository {
  private readonly agentUpdates: BridgeAgentUpdates;

  constructor(private readonly options: BridgeRepositoryOptions) {
    this.agentUpdates = new BridgeAgentUpdates({
      db: options.db,
      jobsEnabled: options.jobsEnabled ?? false,
      approvedRelease: () => this.approvedRelease(),
    });
  }

  private get db(): Database {
    return this.options.db;
  }

  /**
   * The AWG path evidence of each node's active route (ruling R19): the node's
   * AWG 3.1 reachability result, reduced like the user verdict
   * (`toUserReachability`: missing, stale, errored, probe-disabled or mass
   * failure all read unknown). The worker deletes that row when the node's
   * endpoint changes, so a present row was measured for the current revision.
   */
  private loadAwgPaths = async (
    executor: Database | BridgeTransaction,
    nodeIds: readonly string[],
  ): Promise<Map<string, AwgPathEvidence>> => {
    const result = new Map<string, AwgPathEvidence>();
    if (nodeIds.length === 0) return result;
    const [[probe], rows] = await Promise.all([
      executor
        .select({
          enabled: reachabilityProbe.enabled,
          lastResultAt: reachabilityProbe.lastResultAt,
          staleAfterSec: reachabilityProbe.staleAfterSec,
          intervalSec: reachabilityProbe.intervalSec,
          staleAlertedAt: reachabilityProbe.staleAlertedAt,
          enabledAt: reachabilityProbe.enabledAt,
          lastRunMass: reachabilityProbe.lastRunMass,
        })
        .from(reachabilityProbe)
        .where(eq(reachabilityProbe.id, 1))
        .limit(1),
      executor
        .select({
          nodeId: nodes.id,
          reachabilityEnabled: nodes.reachabilityEnabled,
          status: nodeReachabilityResults.status,
          failingSince: nodeReachabilityResults.failingSince,
          checkedAt: nodeReachabilityResults.checkedAt,
        })
        .from(nodes)
        .leftJoin(
          nodeReachabilityResults,
          and(
            eq(nodeReachabilityResults.nodeId, nodes.id),
            eq(nodeReachabilityResults.protocol, "awg3"),
          ),
        )
        .where(inArray(nodes.id, [...new Set(nodeIds)])),
    ]);
    const now = new Date();
    for (const row of rows) {
      const verdict = toUserReachability({
        probe: probe ?? null,
        reachabilityEnabled: row.reachabilityEnabled,
        state:
          row.status !== null && row.checkedAt !== null
            ? { status: row.status, failingSince: row.failingSince, checkedAt: row.checkedAt }
            : null,
        now,
      });
      result.set(row.nodeId, {
        status: verdict.state === "blocked" ? "failed" : verdict.state,
        checkedAt: row.checkedAt,
      });
    }
    return result;
  };

  /** Route summaries with their computed registration and verification, by bridge id. */
  private routeSummaries = async (
    bridgeRows: readonly BridgeRow[],
    now: Date,
  ): Promise<Map<string, BridgeRouteSummary[]>> => {
    const byBridge = new Map<string, BridgeRouteSummary[]>();
    if (bridgeRows.length === 0) return byBridge;
    const bridgesById = new Map(bridgeRows.map((row) => [row.id, row]));
    const rows = await this.db
      .select({
        route: vpnBridgeRoutes,
        nodeName: nodes.name,
      })
      .from(vpnBridgeRoutes)
      .innerJoin(nodes, eq(nodes.id, vpnBridgeRoutes.nodeId))
      .where(inArray(vpnBridgeRoutes.bridgeId, [...bridgesById.keys()]))
      .orderBy(asc(vpnBridgeRoutes.publicUdpPort));
    const awgPaths = await this.loadAwgPaths(
      this.db,
      rows.filter(({ route }) => route.state === "active").map(({ route }) => route.nodeId),
    );
    for (const { route, nodeName } of rows) {
      const bridge = bridgesById.get(route.bridgeId);
      if (!bridge) continue;
      const registration = routeRegistration(
        route,
        bridge,
        now,
        this.options.observationStaleMs,
      );
      const list = byBridge.get(route.bridgeId) ?? [];
      list.push({
        id: route.id,
        nodeId: route.nodeId,
        nodeName,
        publicUdpPort: route.publicUdpPort,
        state: route.state,
        registration,
        verification: routeVerification(
          route,
          registration,
          now,
          awgPaths.get(route.nodeId) ?? UNKNOWN_AWG_PATH,
        ),
      });
      byBridge.set(route.bridgeId, list);
    }
    return byBridge;
  };

  /**
   * The newest compatible bridge-agent image the worker resolved from the
   * approved repository, as `repository@sha256:<digest>`; null when the
   * repository is not configured, nothing was resolved, or the stored
   * reference is not a digest of exactly that repository. Rows of any other
   * repository are never read, and a tag can never come out of here.
   */
  private approvedRelease = async (): Promise<BridgeAgentOfferedImage | null> => {
    const repository = this.options.bridgeAgentImageRepository?.trim();
    if (!repository) return null;
    const [release] = await this.db
      .select()
      .from(bridgeAgentReleases)
      .where(eq(bridgeAgentReleases.repository, repository))
      .limit(1);
    if (!release) return null;
    const image = `${release.repository}@${release.digest}`;
    if (!isPublishableAgentImage(image, repository)) return null;
    return {
      image,
      repository: release.repository,
      version: release.version,
      digest: release.digest,
    };
  };

  private approvedAgentImage = async (): Promise<string | null> =>
    (await this.approvedRelease())?.image ?? null;

  private readBridge = async (bridgeId: string): Promise<Bridge> => {
    const [row] = await this.db
      .select()
      .from(vpnBridges)
      .where(eq(vpnBridges.id, bridgeId))
      .limit(1);
    if (!row) throw bridgeNotFound();
    const now = new Date();
    const routes = await this.routeSummaries([row], now);
    const summaries = await this.agentUpdates.summaries([row]);
    return toBridge(
      row,
      routes.get(row.id) ?? [],
      now,
      this.options.observationStaleMs,
      await this.approvedAgentImage(),
      summaries.get(row.id),
    );
  };

  listBridges = async (): Promise<Bridge[]> => {
    const rows = await this.db
      .select()
      .from(vpnBridges)
      .orderBy(asc(vpnBridges.name), asc(vpnBridges.createdAt));
    const now = new Date();
    const routes = await this.routeSummaries(rows, now);
    const agentImage = await this.approvedAgentImage();
    const summaries = await this.agentUpdates.summaries(rows);
    return rows.map((row) =>
      toBridge(
        row,
        routes.get(row.id) ?? [],
        now,
        this.options.observationStaleMs,
        agentImage,
        summaries.get(row.id),
      ),
    );
  };

  /** The preview, outstanding operation and history of a bridge's agent update. */
  getAgentUpdate = (bridgeId: string): Promise<BridgeAgentUpdateView> =>
    this.agentUpdates.view(bridgeId);

  /** What must hold before rolling back to a release that predates bridges. */
  getRollbackPreflight = (): Promise<BridgeRollbackPreflight> =>
    readBridgeRollbackPreflight(this.db, this.options.jobsEnabled ?? false);

  /** Request an agent update (idempotent per outstanding operation). */
  requestAgentUpdate = (
    actor: Actor,
    bridgeId: string,
    request: RequestBridgeAgentUpdate,
  ): Promise<RequestBridgeAgentUpdateResult> =>
    this.agentUpdates.request(actor, bridgeId, request);

  /**
   * The overview's Bridges block, from the same stored observations as the
   * bridge list. Undefined when no bridge exists, so the overview stays
   * unchanged for panels without bridges.
   */
  overviewBridges = async (): Promise<AdminOverviewBridges | undefined> => {
    const bridges = await this.listBridges();
    if (bridges.length === 0) return undefined;
    return { count: bridges.length, items: bridges.map(overviewBridgeOf) };
  };

  createBridge = async (actor: Actor, request: CreateBridgeRequest): Promise<Bridge> => {
    let createdId: string;
    try {
      createdId = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(vpnBridges)
          .values({
            name: request.name,
            publicIpv4: request.publicIpv4,
            controlTcpPort: request.controlTcpPort,
            udpPortStart: request.udpPortStart,
            udpPortEnd: request.udpPortEnd,
            managementStatus: "pending_enrollment",
          })
          .returning();
        if (!created) throw new Error("Bridge insert returned no row");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_bridge.created",
          targetType: "vpn_bridge",
          targetId: created.id,
          metadata: {
            name: created.name,
            publicIpv4: created.publicIpv4,
            controlTcpPort: created.controlTcpPort,
            udpPortStart: created.udpPortStart,
            udpPortEnd: created.udpPortEnd,
          },
        });
        return created.id;
      });
    } catch (error) {
      throw mapBridgeConstraintError(error);
    }
    return this.readBridge(createdId);
  };

  /**
   * Rename and/or enroll a bridge. Enrollment (`managementApiUrl` with
   * `apiKey`) first checks the candidate against the agent itself
   * (`verifyEnrollmentCandidate`: allowed destination, this bridge's id,
   * API version and status capability), outside any transaction; only then
   * is it stored, replacing any previous enrollment, together with the first
   * status read. A refused candidate changes nothing.
   */
  updateBridge = async (
    actor: Actor,
    bridgeId: string,
    request: UpdateBridgeRequest,
  ): Promise<Bridge> => {
    const enrollmentRequest =
      request.managementApiUrl !== undefined && request.apiKey !== undefined
        ? { managementApiUrl: request.managementApiUrl, apiKey: request.apiKey }
        : null;
    let enrollment: Awaited<ReturnType<typeof verifyEnrollmentCandidate>> | null = null;
    if (enrollmentRequest) {
      // 404 before contacting anything for an unknown id.
      const [known] = await this.db
        .select({ id: vpnBridges.id })
        .from(vpnBridges)
        .where(eq(vpnBridges.id, bridgeId))
        .limit(1);
      if (!known) throw bridgeNotFound();
      enrollment = await verifyEnrollmentCandidate(
        {
          keyring: this.options.keyring,
          activeKeyVersion: this.options.activeKeyVersion,
          managementHosts: this.options.managementHosts,
          fetchImpl: this.options.bridgeAgentFetch,
          timeoutMs: this.options.bridgeAgentTimeoutMs,
        },
        bridgeId,
        enrollmentRequest,
      );
    }
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: vpnBridges.id,
          name: vpnBridges.name,
          enrolledAt: vpnBridges.managementEnrolledAt,
        })
        .from(vpnBridges)
        .where(eq(vpnBridges.id, bridgeId))
        .for("update");
      if (!current) throw bridgeNotFound();
      if (request.name !== undefined && request.name !== current.name) {
        await tx
          .update(vpnBridges)
          .set({ name: request.name, updatedAt: new Date() })
          .where(eq(vpnBridges.id, bridgeId));
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_bridge.renamed",
          targetType: "vpn_bridge",
          targetId: bridgeId,
          metadata: { from: current.name, to: request.name },
        });
      }
      if (enrollment) {
        await storeEnrollment(
          tx,
          { keyring: this.options.keyring, activeKeyVersion: this.options.activeKeyVersion },
          actor,
          bridgeId,
          current.enrolledAt !== null,
          enrollment,
        );
      }
    });
    return this.readBridge(bridgeId);
  };

  deleteBridge = async (actor: Actor, bridgeId: string): Promise<DeleteBridgeResult> => {
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: vpnBridges.id, name: vpnBridges.name })
          .from(vpnBridges)
          .where(eq(vpnBridges.id, bridgeId))
          .for("update");
        if (!current) throw bridgeNotFound();
        // Prepare takes this same row lock before inserting a route, so the
        // count cannot go stale before the delete; the RESTRICT foreign key
        // stays as the backstop (mapped to the same code).
        const [held] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(vpnBridgeRoutes)
          .where(eq(vpnBridgeRoutes.bridgeId, bridgeId));
        if ((held?.value ?? 0) > 0) {
          throw new ApiError(
            409,
            `The bridge still holds ${held?.value ?? 0} draft, active or retiring route(s); release them first`,
            "BRIDGE_HAS_ROUTES",
          );
        }
        await tx.delete(vpnBridges).where(eq(vpnBridges.id, bridgeId));
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_bridge.deleted",
          targetType: "vpn_bridge",
          targetId: bridgeId,
          metadata: { name: current.name },
        });
        return { id: bridgeId, deleted: true as const };
      });
    } catch (error) {
      throw mapBridgeConstraintError(error);
    }
  };

  private routesWithBridges = async (
    where: SQL,
    executor: Database | BridgeTransaction = this.db,
  ): Promise<NodeBridgeRoute[]> => {
    const rows = await executor
      .select({ route: vpnBridgeRoutes, bridge: vpnBridges })
      .from(vpnBridgeRoutes)
      .innerJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .where(where)
      .orderBy(asc(vpnBridgeRoutes.createdAt));
    const awgPaths = await this.loadAwgPaths(
      executor,
      rows.filter(({ route }) => route.state === "active").map(({ route }) => route.nodeId),
    );
    const now = new Date();
    return rows.map(({ route, bridge }) =>
      toNodeRoute(
        route,
        bridge,
        now,
        this.options.observationStaleMs,
        awgPaths.get(route.nodeId) ?? UNKNOWN_AWG_PATH,
      ),
    );
  };

  private loadNodeRoute = async (
    executor: Database | BridgeTransaction,
    routeId: string,
  ): Promise<NodeBridgeRoute> => {
    const [row] = await executor
      .select({ route: vpnBridgeRoutes, bridge: vpnBridges })
      .from(vpnBridgeRoutes)
      .innerJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .where(eq(vpnBridgeRoutes.id, routeId))
      .limit(1);
    if (!row) throw routeNotFound();
    const awgPaths = await this.loadAwgPaths(
      executor,
      row.route.state === "active" ? [row.route.nodeId] : [],
    );
    return toNodeRoute(
      row.route,
      row.bridge,
      new Date(),
      this.options.observationStaleMs,
      awgPaths.get(row.route.nodeId) ?? UNKNOWN_AWG_PATH,
    );
  };

  getNodeBridgeRoutes = async (
    nodeId: string,
    executor: Database | BridgeTransaction = this.db,
  ): Promise<NodeBridgeRoutes> => {
    const [node] = await executor
      .select({ id: nodes.id, revision: nodes.vpnEndpointRevision })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw nodeNotFound();
    const routes = await this.routesWithBridges(eq(vpnBridgeRoutes.nodeId, nodeId), executor);
    return {
      nodeId,
      vpnEndpointRevision: node.revision,
      activeRoute: routes.find((route) => route.state === "active") ?? null,
      drafts: routes.filter((route) => route.state === "draft"),
      retiring: routes.filter((route) => route.state === "retiring"),
    };
  };

  /** Revision and active route of every node, for the infrastructure view. */
  nodeEndpointSummaries = async (): Promise<Map<string, NodeEndpointSummary>> => {
    const [nodeRows, activeRoutes] = await Promise.all([
      this.db
        .select({ id: nodes.id, revision: nodes.vpnEndpointRevision })
        .from(nodes),
      this.routesWithBridges(eq(vpnBridgeRoutes.state, "active")),
    ]);
    const activeByNode = new Map(activeRoutes.map((route) => [route.nodeId, route]));
    return new Map(
      nodeRows.map((row) => [
        row.id,
        {
          vpnEndpointRevision: row.revision,
          activeRoute: activeByNode.get(row.id) ?? null,
        },
      ]),
    );
  };

  /**
   * Reserve a bridge UDP port for a VPN node.
   *
   * Idempotent per (node, bridge): a repeat with no port or the same port
   * returns the held route (`created: false`); a different port conflicts. A
   * retiring held route is returned with its port and its verification
   * cleared, because it has to be verified again before it can be reactivated.
   * The endpoint (bridge + port) of a route never changes after creation.
   */
  prepareRoute = async (
    actor: Actor,
    nodeId: string,
    request: PrepareBridgeRouteRequest,
  ): Promise<PrepareBridgeRouteResult> => {
    let outcome: { created: boolean; routeId: string };
    try {
      outcome = await this.db.transaction(async (tx) => {
        // Only VPN nodes hold routes: a bridge lives in its own table and can
        // never be named here.
        const [node] = await tx
          .select({
            id: nodes.id,
            protocol: nodes.protocol,
            capabilities: nodes.capabilities,
            enabledProtocols: nodes.enabledProtocols,
          })
          .from(nodes)
          .where(eq(nodes.id, nodeId))
          .for("no key update");
        if (!node) throw nodeNotFound();
        // A bridge only carries the node's AWG 3.1 listener. Same rule the
        // panel uses to decide whether a node offers awg3 keys: reported
        // capabilities (or the primary protocol) narrowed by the admin's
        // enabled subset.
        if (!nodeServedProtocols(node).includes("awg3")) {
          throw new ApiError(
            409,
            "This node does not serve AWG 3.1, so it cannot be reached through a bridge",
            "BRIDGE_NODE_NOT_AWG31",
          );
        }
        const [bridge] = await tx
          .select()
          .from(vpnBridges)
          .where(eq(vpnBridges.id, request.bridgeId))
          .for("update");
        if (!bridge) throw bridgeNotFound();

        const [held] = await tx
          .select()
          .from(vpnBridgeRoutes)
          .where(
            and(
              eq(vpnBridgeRoutes.nodeId, nodeId),
              eq(vpnBridgeRoutes.bridgeId, bridge.id),
            ),
          )
          .for("update");
        if (held) {
          if (
            request.publicUdpPort !== undefined &&
            request.publicUdpPort !== held.publicUdpPort
          ) {
            throw new ApiError(
              409,
              `This node already holds port ${held.publicUdpPort} on this bridge; a route's port cannot change`,
              "BRIDGE_ROUTE_PAIR_CONFLICT",
            );
          }
          if (held.state === "retiring") {
            await tx
              .update(vpnBridgeRoutes)
              .set({
                verificationMethod: null,
                verifiedRegistrationMarker: null,
                verifiedAt: null,
                verificationResult: null,
                verificationError: null,
                updatedAt: new Date(),
              })
              .where(eq(vpnBridgeRoutes.id, held.id));
            await tx.insert(auditEvents).values({
              actorUserId: actor.id,
              actorType: "user",
              action: "vpn_bridge_route.reprepared",
              targetType: "vpn_bridge_route",
              targetId: held.id,
              metadata: {
                nodeId,
                bridgeId: bridge.id,
                publicUdpPort: held.publicUdpPort,
                state: held.state,
              },
            });
          }
          return { created: false, routeId: held.id };
        }

        const taken = new Set(
          (
            await tx
              .select({ port: vpnBridgeRoutes.publicUdpPort })
              .from(vpnBridgeRoutes)
              .where(eq(vpnBridgeRoutes.bridgeId, bridge.id))
          ).map((row) => row.port),
        );
        let port: number;
        if (request.publicUdpPort !== undefined) {
          port = request.publicUdpPort;
          if (port < bridge.udpPortStart || port > bridge.udpPortEnd) {
            throw new ApiError(
              409,
              `Port ${port} is outside the bridge UDP range ${bridge.udpPortStart}-${bridge.udpPortEnd}`,
              "BRIDGE_PORT_OUT_OF_RANGE",
            );
          }
          if (taken.has(port)) {
            throw new ApiError(
              409,
              `Port ${port} is already held by another route on this bridge`,
              "BRIDGE_PORT_TAKEN",
            );
          }
        } else {
          let free: number | null = null;
          for (let candidate = bridge.udpPortStart; candidate <= bridge.udpPortEnd; candidate += 1) {
            if (!taken.has(candidate)) {
              free = candidate;
              break;
            }
          }
          if (free === null) {
            throw new ApiError(
              409,
              `Every port of the bridge UDP range ${bridge.udpPortStart}-${bridge.udpPortEnd} is held`,
              "BRIDGE_POOL_EXHAUSTED",
            );
          }
          port = free;
        }

        // Generated here so the proxy name derived from it goes into the same
        // insert.
        const routeId = randomUUID();
        await tx.insert(vpnBridgeRoutes).values({
          id: routeId,
          nodeId,
          bridgeId: bridge.id,
          publicUdpPort: port,
          state: "draft",
          frpProxyName: bridgeFrpProxyName(routeId),
        });
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_bridge_route.prepared",
          targetType: "vpn_bridge_route",
          targetId: routeId,
          metadata: { nodeId, bridgeId: bridge.id, publicUdpPort: port },
        });
        return { created: true, routeId };
      });
    } catch (error) {
      throw mapBridgeConstraintError(error);
    }
    return { created: outcome.created, route: await this.loadNodeRoute(this.db, outcome.routeId) };
  };

  /**
   * Release a draft or retiring route: delete its row, which frees the port.
   * Allowed only when the latest bridge observation is fresh and did not
   * report the route online (see `checkReleaseGuard`); an unknown bridge state
   * keeps the reservation.
   */
  releaseRoute = async (
    actor: Actor,
    routeId: string,
  ): Promise<ReleaseBridgeRouteResult> =>
    this.db.transaction(async (tx) => {
      const [located] = await tx
        .select({ nodeId: vpnBridgeRoutes.nodeId, bridgeId: vpnBridgeRoutes.bridgeId })
        .from(vpnBridgeRoutes)
        .where(eq(vpnBridgeRoutes.id, routeId))
        .limit(1);
      if (!located) throw routeNotFound();
      // Node, then bridge, then the route: the same order as activation (and
      // the poller's bridge -> route), so they serialize instead of
      // deadlocking, and the guard reads a poll's committed result.
      await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, located.nodeId))
        .for("no key update");
      const bridge = (await this.lockBridgesShared(tx, [located.bridgeId])).get(
        located.bridgeId,
      );
      if (!bridge) throw bridgeNotFound();
      const [route] = await tx
        .select()
        .from(vpnBridgeRoutes)
        .where(eq(vpnBridgeRoutes.id, routeId))
        .for("update");
      if (!route) throw routeNotFound();
      if (route.state === "active") {
        throw new ApiError(
          409,
          "The route is the node's active endpoint; select another route or Direct first",
          "BRIDGE_ROUTE_ACTIVE",
        );
      }
      const failure = checkReleaseGuard(
        route,
        bridge,
        new Date(),
        this.options.observationStaleMs,
      );
      if (failure) throw new ApiError(409, failure.message, failure.code);
      await tx.delete(vpnBridgeRoutes).where(eq(vpnBridgeRoutes.id, routeId));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_bridge_route.released",
        targetType: "vpn_bridge_route",
        targetId: routeId,
        metadata: {
          nodeId: route.nodeId,
          bridgeId: route.bridgeId,
          publicUdpPort: route.publicUdpPort,
          state: route.state,
        },
      });
      return {
        id: routeId,
        released: true as const,
        nodeId: route.nodeId,
        bridgeId: route.bridgeId,
        publicUdpPort: route.publicUdpPort,
      };
    });

  /** Lock bridge rows `FOR SHARE` in id order and return them by id. */
  private lockBridgesShared = async (
    tx: BridgeTransaction,
    bridgeIds: readonly string[],
  ): Promise<Map<string, BridgeRow>> => {
    const ids = [...new Set(bridgeIds)].sort();
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(vpnBridges)
      .where(inArray(vpnBridges.id, ids))
      .orderBy(asc(vpnBridges.id))
      .for("share");
    return new Map(rows.map((row) => [row.id, row]));
  };

  /**
   * Refuse to delete a node that still holds any bridge route. Runs before the
   * node delete touches keys, jobs or policy, so `deleteKeys` cannot override
   * it; the RESTRICT foreign key is the backstop.
   */
  assertNodeHasNoRoutes = async (tx: BridgeTransaction, nodeId: string): Promise<void> => {
    const [held] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.nodeId, nodeId));
    if ((held?.value ?? 0) > 0) {
      throw new ApiError(
        409,
        `The node still holds ${held?.value ?? 0} draft, active or retiring bridge route(s); select Direct and release them first`,
        "NODE_HAS_BRIDGE_ROUTES",
      );
    }
  };

  /**
   * Dry-run the endpoint renderer over the node's usable stored configs and
   * return counts only. Usable: a saved artifact, an owner that is not the
   * probe service account, and a key not revoked or failed. Only AWG3-issued
   * keys are inspected; AWG2-issued keys always stay Direct.
   */
  bridgeEligibility = async (
    nodeId: string,
    tx: Pick<Database, "select"> = this.db,
  ): Promise<BridgeEligibility> => {
    const rows = await tx
      .select({
        id: vpnKeys.id,
        protocol: vpnKeys.protocol,
        ciphertext: vpnKeys.configCiphertext,
        nonce: vpnKeys.configNonce,
        authTag: vpnKeys.configAuthTag,
        keyVersion: vpnKeys.configKeyVersion,
      })
      .from(vpnKeys)
      .innerJoin(users, eq(users.id, vpnKeys.ownerId))
      .where(
        and(
          eq(vpnKeys.nodeId, nodeId),
          eq(users.serviceAccount, false),
          inArray(vpnKeys.state, ["provisioning", "active", "disabled", "revoking"]),
          sql`${vpnKeys.configCiphertext} is not null`,
        ),
      );
    const result: BridgeEligibility = {
      nodeId,
      total: 0,
      awg31Eligible: 0,
      awg20Direct: 0,
      awg2NativeDirect: 0,
      unsupported: 0,
      unsupportedKeyIds: [],
    };
    for (const row of rows) {
      result.total += 1;
      if (row.protocol === "awg2") {
        result.awg2NativeDirect += 1;
        continue;
      }
      let link: string | null = null;
      if (
        row.ciphertext &&
        row.nonce &&
        row.authTag &&
        row.keyVersion !== null
      ) {
        try {
          link = decryptSecret(
            {
              ciphertext: row.ciphertext,
              nonce: row.nonce,
              authTag: row.authTag,
              keyVersion: row.keyVersion,
            },
            this.options.keyring,
          );
        } catch {
          link = null;
        }
      }
      const cls = classifyKeyForBridge("awg3", link);
      if (cls === "awg20") result.awg20Direct += 1;
      else if (cls === "awg31" && link !== null && canRenderBridgeEndpoint(link)) {
        result.awg31Eligible += 1;
      } else {
        result.unsupported += 1;
        result.unsupportedKeyIds.push(row.id);
      }
    }
    return result;
  };

  /**
   * Change the node's active endpoint inside the caller's transaction: a route
   * id activates that route, null selects Direct. The caller must already
   * hold the node row lock (`FOR NO KEY UPDATE`).
   *
   * Order of checks: endpoint revision -> route ownership and state ->
   * observation -> verification. A request for the state the node is already
   * in changes nothing (no revision bump, no audit, no reachability reset).
   * Otherwise, in this one transaction: the previous active route becomes
   * retiring (its verification cleared), the candidate becomes active, the revision increments, the
   * node's AWG 3.1 reachability evidence is reset and the audit event is
   * written; any failure, including the audit insert, rolls all of it back.
   */
  changeNodeEndpoint = async (
    tx: BridgeTransaction,
    actor: Actor,
    nodeId: string,
    routeId: string | null,
    expectedRevision: number,
  ): Promise<NodeEndpointAssignment> => {
    const [node] = await tx
      .select({ id: nodes.id, revision: nodes.vpnEndpointRevision })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .for("no key update");
    if (!node) throw nodeNotFound();
    if (node.revision !== expectedRevision) {
      throw new ApiError(
        409,
        `The node's endpoint assignment changed (revision ${node.revision}, expected ${expectedRevision}); reload and try again`,
        "BRIDGE_REVISION_CONFLICT",
      );
    }

    // Bridge rows before route rows: the bridge-agent poller locks a bridge
    // and then its routes, so taking a route here and a bridge after it could
    // close a cycle with two polls and two activations across two bridges.
    // A route never changes bridges and the node lock above keeps this
    // node's set of routes fixed, so the ids read here are the ones locked
    // below. `FOR SHARE` waits for an in-flight poll of the bridge to commit
    // and then reads its result.
    const involved = await tx
      .select({ bridgeId: vpnBridgeRoutes.bridgeId })
      .from(vpnBridgeRoutes)
      .where(
        and(
          eq(vpnBridgeRoutes.nodeId, nodeId),
          routeId === null
            ? eq(vpnBridgeRoutes.state, "active")
            : or(eq(vpnBridgeRoutes.state, "active"), eq(vpnBridgeRoutes.id, routeId)),
        ),
      );
    const lockedBridges = await this.lockBridgesShared(
      tx,
      involved.map((row) => row.bridgeId),
    );

    const [current] = await tx
      .select()
      .from(vpnBridgeRoutes)
      .where(and(eq(vpnBridgeRoutes.nodeId, nodeId), eq(vpnBridgeRoutes.state, "active")))
      .for("update");

    let candidate: RouteRow | undefined;
    if (routeId !== null) {
      [candidate] = await tx
        .select()
        .from(vpnBridgeRoutes)
        .where(eq(vpnBridgeRoutes.id, routeId))
        .for("update");
      if (!candidate || candidate.nodeId !== nodeId) throw routeNotFound();
    }

    const unchanged =
      routeId === null ? current === undefined : candidate?.state === "active";
    if (unchanged) {
      return {
        changed: false,
        vpnEndpointRevision: node.revision,
        activeRoute: current ? await this.loadNodeRoute(tx, current.id) : null,
      };
    }

    const now = new Date();
    if (candidate) {
      const bridge = lockedBridges.get(candidate.bridgeId);
      if (!bridge) throw bridgeNotFound();
      const failure = checkActivationGuard(
        candidate,
        bridge,
        now,
        this.options.observationStaleMs,
      );
      if (failure) throw new ApiError(409, failure.message, failure.code);
      // Eligibility is checked on every activation, not only the first: new
      // keys can appear between activations, and an unsupported stored
      // artifact would fail at download time. It runs inside this
      // transaction, after the node row lock, so the keys it sees are the
      // ones the new assignment will serve.
      const eligibility = await this.bridgeEligibility(nodeId, tx);
      if (eligibility.unsupported > 0) throw bridgeConfigUnsupported();
    }

    // Demote first: the one-active-route-per-node index is checked per
    // statement, so promoting first would collide with the current route.
    // A retiring route loses its verification (ruling R11): reactivating it
    // later needs a fresh verification of its then-current registration.
    if (current) {
      await tx
        .update(vpnBridgeRoutes)
        .set({
          state: "retiring",
          retiringSince: now,
          verificationMethod: null,
          verifiedRegistrationMarker: null,
          verifiedAt: null,
          verificationResult: null,
          verificationError: null,
          updatedAt: now,
        })
        .where(eq(vpnBridgeRoutes.id, current.id));
    }
    if (candidate) {
      await tx
        .update(vpnBridgeRoutes)
        .set({ state: "active", activatedAt: now, retiringSince: null, updatedAt: now })
        .where(eq(vpnBridgeRoutes.id, candidate.id));
    }
    const revision = node.revision + 1;
    await tx
      .update(nodes)
      .set({ vpnEndpointRevision: revision, updatedAt: now })
      .where(eq(nodes.id, nodeId));

    // The evidence gathered through the previous endpoint no longer describes
    // the node (`resetNodeEndpointEvidence`). Same transaction, under the node
    // lock taken above, which the worker's ingest also takes before it writes.
    await resetNodeEndpointEvidence(tx, nodeId, now);

    await tx.insert(auditEvents).values({
      actorUserId: actor.id,
      actorType: "user",
      action: "node.vpn_endpoint_changed",
      targetType: "node",
      targetId: nodeId,
      metadata: {
        fromRouteId: current?.id ?? null,
        toRouteId: candidate?.id ?? null,
        bridgeId: candidate?.bridgeId ?? null,
        publicUdpPort: candidate?.publicUdpPort ?? null,
        previousRevision: node.revision,
        revision,
      },
    });

    return {
      changed: true,
      vpnEndpointRevision: revision,
      activeRoute: candidate ? await this.loadNodeRoute(tx, candidate.id) : null,
    };
  };

  /** The route and its bridge's public address for the test-config preview. */
  findRouteTarget = async (routeId: string): Promise<BridgeRouteTarget | null> => {
    const [row] = await this.db
      .select({
        id: vpnBridgeRoutes.id,
        nodeId: vpnBridgeRoutes.nodeId,
        bridgeId: vpnBridgeRoutes.bridgeId,
        state: vpnBridgeRoutes.state,
        publicUdpPort: vpnBridgeRoutes.publicUdpPort,
        bridgePublicIpv4: vpnBridges.publicIpv4,
        observedRegistrationMarker: vpnBridgeRoutes.observedRegistrationMarker,
      })
      .from(vpnBridgeRoutes)
      .innerJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .where(eq(vpnBridgeRoutes.id, routeId))
      .limit(1);
    return row ?? null;
  };

  /**
   * Lock a route for a verification change: its node row first, then the
   * route (the lock order every route mutation uses). Only a draft or
   * retiring route is verified; the active one already serves.
   */
  private lockCandidateRoute = async (
    tx: BridgeTransaction,
    routeId: string,
  ): Promise<RouteRow> => {
    const [located] = await tx
      .select({ nodeId: vpnBridgeRoutes.nodeId })
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.id, routeId))
      .limit(1);
    if (!located) throw routeNotFound();
    await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, located.nodeId))
      .for("no key update");
    const [route] = await tx
      .select()
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.id, routeId))
      .for("update");
    if (!route) throw routeNotFound();
    if (route.state === "active") {
      throw new ApiError(
        409,
        "The route is already the node's active endpoint; only a draft or retiring route is verified",
        "BRIDGE_ROUTE_ACTIVE",
      );
    }
    return route;
  };

  /**
   * Verify a draft or retiring route.
   *
   * `operator`: record the administrator's attestation of a real AWG
   * handshake and HTTP through the tunnel, bound to the registration marker
   * they tested. When a registration has been observed the marker must be
   * that one; otherwise it is stored as given and compared at activation.
   *
   * `probe`: queue a `bridge_route_candidate_check` job bound to the
   * currently observed marker. Gated by `VPN_BRIDGE_JOBS_ENABLED` and the
   * probe's bridge-measurement capability. A check already pending for the
   * route is returned instead of queuing a second one. Nothing about the
   * route changes until the worker records the result.
   */
  verifyRoute = async (
    actor: Actor,
    routeId: string,
    request: VerifyBridgeRouteRequest,
  ): Promise<VerifyBridgeRouteResult> => {
    if (request.method === "operator") {
      await this.db.transaction(async (tx) => {
        const route = await this.lockCandidateRoute(tx, routeId);
        if (
          route.observedRegistrationMarker !== null &&
          route.observedRegistrationMarker !== request.registrationMarker
        ) {
          throw new ApiError(
            409,
            "The tested registration marker is not the one the bridge reports now; download a fresh test config and test again",
            "BRIDGE_OBSERVATION_STALE",
          );
        }
        const now = new Date();
        await tx
          .update(vpnBridgeRoutes)
          .set({
            verificationMethod: "operator",
            verifiedRegistrationMarker: request.registrationMarker,
            verifiedAt: now,
            verificationResult: "success",
            verificationError: null,
            updatedAt: now,
          })
          .where(eq(vpnBridgeRoutes.id, routeId));
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_bridge_route.verified",
          targetType: "vpn_bridge_route",
          targetId: routeId,
          metadata: {
            nodeId: route.nodeId,
            bridgeId: route.bridgeId,
            method: "operator",
            registrationMarker: request.registrationMarker,
          },
        });
      });
      return {
        method: "operator",
        routeId,
        route: await this.loadNodeRoute(this.db, routeId),
      };
    }

    // Gate first: with job submission off nothing below matters.
    assertBridgeJobsEnabled({ jobsEnabled: this.options.jobsEnabled ?? false });
    const [probe] = await this.db
      .select({
        id: reachabilityProbe.id,
        enabled: reachabilityProbe.enabled,
        capabilities: reachabilityProbe.capabilities,
        capabilitiesCheckedAt: reachabilityProbe.capabilitiesCheckedAt,
      })
      .from(reachabilityProbe)
      .where(eq(reachabilityProbe.id, 1))
      .limit(1);
    if (!probe || !probe.enabled) {
      throw new ApiError(
        409,
        "No enabled external probe is configured; use operator verification",
        "BRIDGE_UNSUPPORTED_CAPABILITY",
      );
    }
    const supports =
      this.options.probeSupportsBridgeMeasurement ?? probeSupportsBridgeMeasurement;
    if (!supports(probeCapabilityInputOf(probe.capabilities, probe.capabilitiesCheckedAt), new Date())) {
      throw new ApiError(
        409,
        "The configured probe does not report the bridge-measurement capability; use operator verification",
        "BRIDGE_UNSUPPORTED_CAPABILITY",
      );
    }

    return this.db.transaction(async (tx) => {
      const route = await this.lockCandidateRoute(tx, routeId);
      if (route.observedRegistrationMarker === null) {
        throw new ApiError(
          409,
          "No frps registration has been observed for this route yet; a probe check needs one to bind to",
          "BRIDGE_OBSERVATION_STALE",
        );
      }
      const marker = route.observedRegistrationMarker;
      const stalePending = (pendingMarker: string) =>
        new ApiError(
          409,
          `A probe check of this route for an older registration (${pendingMarker}) is still pending; ask again once it has settled`,
          "BRIDGE_CHECK_PENDING",
        );
      // Serialized by the route lock above, so two requests cannot both
      // miss each other's pending job. Jobs are read before the probe slot:
      // the worker claims the slot before it completes the job, so a check
      // is always seen in one of the two.
      const [pending] = await tx
        .select({ id: jobOutbox.id, payload: jobOutbox.payload })
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.type, BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE),
            inArray(jobOutbox.status, ["pending", "processing"]),
            sql`${jobOutbox.payload} ->> 'routeId' = ${routeId}`,
          ),
        )
        .limit(1);
      if (pending) {
        const pendingMarker =
          typeof pending.payload.registrationMarker === "string"
            ? pending.payload.registrationMarker
            : null;
        // A check bound to another registration does not answer this
        // request; queuing beside it would let its later result shadow ours.
        if (pendingMarker !== marker) throw stalePending(pendingMarker ?? "unknown");
        return {
          method: "probe" as const,
          routeId,
          jobId: pending.id,
          queued: false,
          status: "pending" as const,
          runId: null,
          registrationMarker: marker,
        };
      }
      // The job that started a run is already completed; the run itself
      // still holds the probe until the reachability tick settles it.
      const [inFlight] = await tx
        .select({
          runId: reachabilityProbe.candidateRunId,
          marker: reachabilityProbe.candidateRegistrationMarker,
        })
        .from(reachabilityProbe)
        .where(
          and(eq(reachabilityProbe.id, 1), eq(reachabilityProbe.candidateRouteId, routeId)),
        )
        .limit(1);
      if (inFlight?.runId) {
        if (inFlight.marker !== marker) throw stalePending(inFlight.marker ?? "unknown");
        const [started] = await tx
          .select({ id: jobOutbox.id })
          .from(jobOutbox)
          .where(
            and(
              eq(jobOutbox.type, BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE),
              sql`${jobOutbox.payload} ->> 'routeId' = ${routeId}`,
            ),
          )
          .orderBy(desc(jobOutbox.createdAt))
          .limit(1);
        return {
          method: "probe" as const,
          routeId,
          jobId: started?.id ?? null,
          queued: false,
          status: "running" as const,
          runId: inFlight.runId,
          registrationMarker: marker,
        };
      }
      const payload: BridgeRouteCandidateCheckPayload = {
        routeId,
        nodeId: route.nodeId,
        registrationMarker: marker,
        requestedAt: new Date().toISOString(),
      };
      const [job] = await tx
        .insert(jobOutbox)
        .values({
          type: BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
          // Completed rows keep their key, so every request gets its own.
          deduplicationKey: `${BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE}:${routeId}:${randomUUID()}`,
          payload,
        })
        .returning({ id: jobOutbox.id });
      if (!job) throw new Error("Candidate check job insert returned no row");
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_bridge_route.verification_requested",
        targetType: "vpn_bridge_route",
        targetId: routeId,
        metadata: {
          nodeId: route.nodeId,
          bridgeId: route.bridgeId,
          method: "probe",
          registrationMarker: marker,
          jobId: job.id,
        },
      });
      return {
        method: "probe" as const,
        routeId,
        jobId: job.id,
        queued: true,
        status: "queued" as const,
        runId: null,
        registrationMarker: marker,
      };
    });
  };
}
