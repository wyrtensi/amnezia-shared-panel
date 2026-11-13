import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
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
  type BridgeRouteSummary,
  type CreateBridgeRequest,
  type DeleteBridgeResult,
  type NodeBridgeRoute,
  type NodeBridgeRoutes,
  type NodeEndpointAssignment,
  type PrepareBridgeRouteRequest,
  type PrepareBridgeRouteResult,
  type ReleaseBridgeRouteResult,
  type UpdateBridgeRequest,
} from "@amnezia/contracts";
import {
  auditEvents,
  decryptSecret,
  jobOutbox,
  nodes,
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
import { assertBridgeJobsEnabled } from "./bridgeConfig.js";
import { checkActivationGuard, checkReleaseGuard } from "./bridgeGuards.js";
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
  /** Decrypts stored key artifacts for the eligibility dry-run. */
  keyring: EncryptionKeyring;
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

const toNodeRoute = (route: RouteRow, bridge: BridgeRow): NodeBridgeRoute => ({
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
  bridgeManagementStatus: bridge.managementStatus,
  bridgeLastObservedAt: iso(bridge.lastObservedAt),
  setupCommands: routeSetupCommands({
    id: route.id,
    publicUdpPort: route.publicUdpPort,
    bridgePublicIpv4: bridge.publicIpv4,
    bridgeControlTcpPort: bridge.controlTcpPort,
  }),
});

const toBridge = (row: BridgeRow, routes: BridgeRouteSummary[]): Bridge => ({
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
  managementStatus: row.managementStatus,
  lastObservedAt: iso(row.lastObservedAt),
  routes,
  setupCommands: bridgeSetupCommands(row),
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
  constructor(private readonly options: BridgeRepositoryOptions) {}

  private get db(): Database {
    return this.options.db;
  }

  private routeSummaries = async (
    bridgeIds: readonly string[],
  ): Promise<Map<string, BridgeRouteSummary[]>> => {
    const byBridge = new Map<string, BridgeRouteSummary[]>();
    if (bridgeIds.length === 0) return byBridge;
    const rows = await this.db
      .select({
        id: vpnBridgeRoutes.id,
        bridgeId: vpnBridgeRoutes.bridgeId,
        nodeId: vpnBridgeRoutes.nodeId,
        nodeName: nodes.name,
        publicUdpPort: vpnBridgeRoutes.publicUdpPort,
        state: vpnBridgeRoutes.state,
      })
      .from(vpnBridgeRoutes)
      .innerJoin(nodes, eq(nodes.id, vpnBridgeRoutes.nodeId))
      .where(inArray(vpnBridgeRoutes.bridgeId, [...bridgeIds]))
      .orderBy(asc(vpnBridgeRoutes.publicUdpPort));
    for (const { bridgeId, ...summary } of rows) {
      const list = byBridge.get(bridgeId) ?? [];
      list.push(summary);
      byBridge.set(bridgeId, list);
    }
    return byBridge;
  };

  private readBridge = async (bridgeId: string): Promise<Bridge> => {
    const [row] = await this.db
      .select()
      .from(vpnBridges)
      .where(eq(vpnBridges.id, bridgeId))
      .limit(1);
    if (!row) throw bridgeNotFound();
    const routes = await this.routeSummaries([row.id]);
    return toBridge(row, routes.get(row.id) ?? []);
  };

  listBridges = async (): Promise<Bridge[]> => {
    const rows = await this.db
      .select()
      .from(vpnBridges)
      .orderBy(asc(vpnBridges.name), asc(vpnBridges.createdAt));
    const routes = await this.routeSummaries(rows.map((row) => row.id));
    return rows.map((row) => toBridge(row, routes.get(row.id) ?? []));
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

  updateBridge = async (
    actor: Actor,
    bridgeId: string,
    request: UpdateBridgeRequest,
  ): Promise<Bridge> => {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: vpnBridges.id, name: vpnBridges.name })
        .from(vpnBridges)
        .where(eq(vpnBridges.id, bridgeId))
        .for("update");
      if (!current) throw bridgeNotFound();
      if (request.name === undefined || request.name === current.name) return;
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
    return rows.map(({ route, bridge }) => toNodeRoute(route, bridge));
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
    return toNodeRoute(row.route, row.bridge);
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
        .select({ nodeId: vpnBridgeRoutes.nodeId })
        .from(vpnBridgeRoutes)
        .where(eq(vpnBridgeRoutes.id, routeId))
        .limit(1);
      if (!located) throw routeNotFound();
      // Node first, then the route: the same order as activation, so release
      // and activation on one node serialize instead of deadlocking.
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
          "The route is the node's active endpoint; select another route or Direct first",
          "BRIDGE_ROUTE_ACTIVE",
        );
      }
      const [bridge] = await tx
        .select()
        .from(vpnBridges)
        .where(eq(vpnBridges.id, route.bridgeId))
        .limit(1);
      if (!bridge) throw bridgeNotFound();
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
      } else result.unsupported += 1;
    }
    return result;
  };

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
      const [bridge] = await tx
        .select()
        .from(vpnBridges)
        .where(eq(vpnBridges.id, candidate.bridgeId))
        .limit(1);
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
