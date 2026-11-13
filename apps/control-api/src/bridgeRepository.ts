import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  bridgeFrpProxyName,
  type Bridge,
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
  nodeReachabilityResults,
  nodeReachabilityState,
  nodes,
  vpnBridgeRoutes,
  vpnBridges,
  type Database,
} from "@amnezia/db";
import { checkActivationGuard, checkReleaseGuard } from "./bridgeGuards.js";
import { ApiError, type Actor } from "./service.js";

// The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`.
export type BridgeTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type BridgeRow = typeof vpnBridges.$inferSelect;
type RouteRow = typeof vpnBridgeRoutes.$inferSelect;

export type BridgeRepositoryOptions = {
  db: Database;
  /** `VPN_BRIDGE_OBSERVATION_STALE_MS`, see bridgeConfig.ts. */
  observationStaleMs: number;
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
 * that has upserted those rows and then inserts a history row.
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
          .select({ id: nodes.id })
          .from(nodes)
          .where(eq(nodes.id, nodeId))
          .for("no key update");
        if (!node) throw nodeNotFound();
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
   * retiring, the candidate becomes active, the revision increments, the
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
    }

    // Demote first: the one-active-route-per-node index is checked per
    // statement, so promoting first would collide with the current route.
    if (current) {
      await tx
        .update(vpnBridgeRoutes)
        .set({ state: "retiring", retiringSince: now, updatedAt: now })
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

    // Minimal reachability invalidation (Task 4b replaces it with the
    // revision-aware version): the evidence was gathered through the previous
    // endpoint, so it no longer describes the node. Delete the node's AWG 3.1
    // per-protocol result and its aggregate state row; missing evidence reads
    // as Unknown everywhere (`toUserReachability`, the admin view), and the
    // worker starts the node's failure count afresh on its next run. The AWG 2
    // result stays: AWG 2 keeps the direct path. History rows are kept.
    await tx
      .delete(nodeReachabilityResults)
      .where(
        and(
          eq(nodeReachabilityResults.nodeId, nodeId),
          eq(nodeReachabilityResults.protocol, "awg3"),
        ),
      );
    await tx.delete(nodeReachabilityState).where(eq(nodeReachabilityState.nodeId, nodeId));

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
}
