"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Cable,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Globe,
  Server,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  AdminNodeEndpoint,
  Bridge,
  NodeEgressDaemonState,
  NodeEgressIp,
  NodeEgressIpHostState,
  NodeEgressMode,
} from "@amnezia/contracts";
import type { AdminNode } from "@/components/admin/admin-data";
import type { NodeRouteLabel } from "@/components/admin/use-bridge-infra";
import { PROTOCOLS } from "@/components/protocol-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bridgeSectionHref, nodeCardAnchor, NODES_PATH } from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";
import type { AdminReachabilityView, AdminServiceCheck } from "@/lib/types";
import { cn } from "@/lib/utils";

export type FleetTopologyMapProps = {
  nodes: readonly AdminNode[];
  bridges: readonly Bridge[];
  routeByNode: ReadonlyMap<string, NodeRouteLabel>;
  serviceChecks: readonly AdminServiceCheck[];
  reachability?: AdminReachabilityView | null;
  activeKeysCount: number;
  onlineDevicesCount: number;
  defaultExpanded?: boolean;
  onOpenBridge?: (bridgeId: string) => void;
  onOpenNode?: (nodeId: string) => void;
  onOpenVariant?: (nodeId: string, endpointId: string) => void;
  onOpenExit?: (nodeId: string, exitId: string | null) => void;
};

export type TopologyColumnId = "panel" | "bridges" | "nodes" | "entries" | "exits";

export type TopologyHealth = "success" | "warning" | "destructive" | "muted";

export type TopologyCheckFailure = {
  checkId: string;
  checkName: string;
  status: "failed" | "error";
  detail: string | null;
};

export type PanelGraphNode = {
  id: string;
  kind: "panel";
  column: "panel";
  row: number;
  xLeft: number;
  xRight: number;
  y: number;
  activeKeysCount: number;
  onlineDevicesCount: number;
  health: TopologyHealth;
};

export type BridgeGraphNode = {
  id: string;
  kind: "bridge";
  column: "bridges";
  row: number;
  xLeft: number;
  xRight: number;
  y: number;
  bridgeId: string;
  name: string;
  publicIpv4: string;
  controlTcpPort: number;
  defaultTransport?: Bridge["defaultTransport"];
  frpsEnabled?: boolean;
  managementStatus: Bridge["managementStatus"];
  frpsReachable: boolean | null;
  activeRouteCount: number;
  wytunnelRouteCount: number;
  wytunnelHealthyStreams: number;
  wytunnelTargetStreams: number;
  wytunnelAvgRttMs: number | null;
  onlinePeerCount: number;
  onlineByProtocol?: Record<string, number>;
  health: TopologyHealth;
};

export type VpnNodeGraphNode = {
  id: string;
  kind: "node";
  column: "nodes";
  row: number;
  xLeft: number;
  xRight: number;
  y: number;
  nodeId: string;
  name: string;
  enabled: boolean;
  protocol: string;
  egressMode: NodeEgressMode;
  egressDaemonState: NodeEgressDaemonState | null;
  modeDrift: boolean;
  lastError: string | null;
  peerCount: number;
  maxPeers: number;
  onlinePeerCount: number;
  onlineByProtocol?: Record<string, number>;
  hasKeyUpdateNotice: boolean;
  route: NodeRouteLabel | null;
  health: TopologyHealth;
};

export type EntryGraphNode = {
  id: string;
  kind: "entry";
  column: "entries";
  row: number;
  xLeft: number;
  xRight: number;
  y: number;
  endpointId: string;
  nodeId: string;
  nodeName: string;
  name: string;
  variantTag: string | null;
  publicAddress: string;
  enabled: boolean;
  reachabilityEnabled: boolean;
  probeStatus: AdminNodeEndpoint["probeStatus"];
  probeConsecutiveFailures: number;
  incidentOpen: boolean;
  probeEgressMatch: boolean | null;
  effectiveEgressIp: string | null;
  egressIpId: string | null;
  egressAutoRotateEnabled?: boolean;
  egressAutoRotatePoolCount?: number;
  onlinePeerCount: number;
  onlineByProtocol?: Record<string, number>;
  activeKeyCount?: number;
  assignedKeyCount?: number;
  hasKeyUpdateNotice: boolean;
  isSynthetic: boolean;
  health: TopologyHealth;
};

export type ExitGraphNode = {
  id: string;
  kind: "exit";
  column: "exits";
  row: number;
  xLeft: number;
  xRight: number;
  y: number;
  exitId: string | null;
  nodeId: string;
  nodeName: string;
  ipv4: string;
  label: string | null;
  isDefault: boolean;
  enabled: boolean;
  hostState: NodeEgressIpHostState | null;
  failingChecks: TopologyCheckFailure[];
  incomingVariantCount: number;
  onlinePeerCount: number;
  onlineByProtocol?: Record<string, number>;
  hasKeyUpdateNotice: boolean;
  isSynthetic: boolean;
  health: TopologyHealth;
};

export type TopologyGraphItem =
  | PanelGraphNode
  | BridgeGraphNode
  | VpnNodeGraphNode
  | EntryGraphNode
  | ExitGraphNode;

export type SelectableTopologyItem = Exclude<TopologyGraphItem, PanelGraphNode>;

export type TopologyEdgeKind =
  | "panel-bridge"
  | "panel-node"
  | "bridge-node"
  | "node-entry"
  | "entry-exit";

export type TopologyEdge = {
  id: string;
  kind: TopologyEdgeKind;
  from: string;
  to: string;
  fromCol: TopologyColumnId;
  toCol: TopologyColumnId;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path: string;
  health: TopologyHealth;
  dashed: boolean;
};

export type BuildFleetTopologyGraphInput = Omit<
  FleetTopologyMapProps,
  | "defaultExpanded"
  | "onOpenBridge"
  | "onOpenNode"
  | "onOpenVariant"
  | "onOpenExit"
>;

export type FleetTopologyGraph = {
  hasBridges: boolean;
  columns: readonly TopologyColumnId[];
  panel: PanelGraphNode;
  bridges: BridgeGraphNode[];
  nodes: VpnNodeGraphNode[];
  entries: EntryGraphNode[];
  exits: ExitGraphNode[];
  edges: TopologyEdge[];
  itemsById: ReadonlyMap<string, TopologyGraphItem>;
  columnOffsets: Record<TopologyColumnId, number>;
  viewBoxWidth: number;
  canvasHeight: number;
  cardHeight: number;
  rowGap: number;
};

const VIEWBOX_WIDTH = 1000;
const CARD_HEIGHT = 88;
const ROW_GAP = 14;
const CANVAS_PAD_Y = 8;
const EDGE_ANCHOR_INSET = 9;

const DAEMON_PILL_TONE: Record<NodeEgressDaemonState, string> = {
  routed_active: "bg-success/15 text-success",
  masquerade_ready: "bg-success/15 text-success",
  degraded: "bg-warning/15 text-warning",
  unavailable: "bg-warning/15 text-warning",
  conflict: "bg-destructive/15 text-destructive",
};

const HEALTH_DOT_CLASS: Record<TopologyHealth, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

const HEALTH_STROKE_CLASS: Record<TopologyHealth, string> = {
  success: "stroke-success",
  warning: "stroke-warning",
  destructive: "stroke-destructive",
  muted: "stroke-muted-foreground/45",
};

const HEALTH_BORDER_CLASS: Record<TopologyHealth, string> = {
  success: "border-border/80 hover:border-success/60",
  warning: "border-warning/60 hover:border-warning",
  destructive: "border-destructive/60 hover:border-destructive",
  muted: "border-border/60 opacity-75 hover:opacity-100",
};

const HEALTH_PRIORITY: Record<TopologyHealth, number> = {
  destructive: 3,
  warning: 2,
  success: 1,
  muted: 0,
};

const worstHealth = (a: TopologyHealth, b: TopologyHealth): TopologyHealth =>
  HEALTH_PRIORITY[a] >= HEALTH_PRIORITY[b] ? a : b;

const buildBezierPath = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = (x2 - x1) * 0.5;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
};

const resolveBridgeHealth = (
  bridge: Bridge,
  reachBridge: NonNullable<AdminReachabilityView["bridges"]>[number] | undefined,
  frpsReachable: boolean | null,
): TopologyHealth => {
  const frpsExpected = bridge.frpsEnabled !== false;
  if (
    bridge.managementStatus === "down" ||
    bridge.managementStatus === "identity_mismatch" ||
    (frpsExpected && frpsReachable === false) ||
    bridge.alertState?.incidentOpen ||
    reachBridge?.mgmtIncidentOpen ||
    reachBridge?.probeIncidentOpen ||
    reachBridge?.probeStatus === "failed"
  ) {
    return "destructive";
  }
  if (
    bridge.managementStatus === "stale" ||
    bridge.managementStatus === "unsupported" ||
    (reachBridge?.probeConsecutiveFailures ?? 0) > 0 ||
    reachBridge?.probeStatus === "error"
  ) {
    return "warning";
  }
  if (bridge.managementStatus === "pending_enrollment") {
    return "muted";
  }
  return "success";
};

const resolveNodeHealth = (
  node: AdminNode,
  reachNode: AdminReachabilityView["nodes"][number] | undefined,
  hasNodeCheckFailure: boolean,
): TopologyHealth => {
  if (!node.enabled) return "muted";
  if (
    node.lastError ||
    node.modeDrift ||
    node.egressModeState === "failed" ||
    reachNode?.incidentOpen ||
    reachNode?.status === "failed"
  ) {
    return "destructive";
  }
  if (
    node.egressDaemonState === "conflict" ||
    node.egressDaemonState === "degraded" ||
    node.egressDaemonState === "unavailable" ||
    (reachNode?.consecutiveFailures ?? 0) > 0 ||
    reachNode?.status === "error" ||
    hasNodeCheckFailure
  ) {
    return "warning";
  }
  return "success";
};

const resolveEndpointHealth = (
  nodeEnabled: boolean,
  ep: AdminNodeEndpoint,
): TopologyHealth => {
  if (!nodeEnabled || !ep.enabled) return "muted";
  if (
    ep.incidentOpen ||
    ep.probeStatus === "failed" ||
    ep.probeEgressMatch === false
  ) {
    return "destructive";
  }
  if ((ep.probeConsecutiveFailures ?? 0) > 0 || ep.probeStatus === "error") {
    return "warning";
  }
  if (ep.probeStatus === "ok") return "success";
  return "muted";
};

const resolveExitHealth = (
  nodeEnabled: boolean,
  exitEnabled: boolean,
  hostState: NodeEgressIpHostState | null,
  failingChecks: readonly TopologyCheckFailure[],
): TopologyHealth => {
  if (!nodeEnabled || !exitEnabled || hostState === "disabled") return "muted";
  if (
    hostState === "missing_ip" ||
    hostState === "gateway_error" ||
    failingChecks.some((c) => c.status === "failed")
  ) {
    return "destructive";
  }
  if (
    hostState === "daemon_offline" ||
    failingChecks.some((c) => c.status === "error")
  ) {
    return "warning";
  }
  if (hostState === "active") return "success";
  return "muted";
};

const mergeNodeEndpoints = (
  node: AdminNode,
  reachNode: AdminReachabilityView["nodes"][number] | undefined,
): AdminNodeEndpoint[] => {
  const base = node.publicEndpoints ?? [];
  const overlay = reachNode?.publicEndpoints ?? [];
  if (base.length === 0) return [...overlay];
  if (overlay.length === 0) return [...base];
  const overlayById = new Map(overlay.map((ep) => [ep.id, ep]));
  const seen = new Set<string>();
  const merged = base.map((ep) => {
    seen.add(ep.id);
    const live = overlayById.get(ep.id);
    return live ? { ...ep, ...live } : ep;
  });
  for (const ep of overlay) {
    if (!seen.has(ep.id)) merged.push(ep);
  }
  return merged;
};

/**
 * Pure layout & graph builder for the fleet topology map.
 *
 * Produces deterministic row positions and SVG bezier paths across columns
 * (`Panel -> Bridges -> VPN Nodes -> Entry Variants -> Physical Exit IPs`)
 * so both SSR and browser rendering stay aligned without DOM measurements.
 */
export function buildFleetTopologyGraph({
  nodes,
  bridges,
  routeByNode,
  serviceChecks,
  reachability,
  activeKeysCount,
  onlineDevicesCount,
}: BuildFleetTopologyGraphInput): FleetTopologyGraph {
  const hasBridges = bridges.length > 0;
  const columns: TopologyColumnId[] = hasBridges
    ? ["panel", "bridges", "nodes", "entries", "exits"]
    : ["panel", "nodes", "entries", "exits"];

  const reachBridgeById = new Map(
    (reachability?.bridges ?? []).map((b) => [b.bridgeId, b]),
  );
  const reachNodeById = new Map(
    (reachability?.nodes ?? []).map((n) => [n.nodeId, n]),
  );
  const bridgeById = new Map(bridges.map((b) => [b.id, b]));

  // Index enabled service check failures by egress IP and by node fallback.
  const failuresByExitId = new Map<string, TopologyCheckFailure[]>();
  const failuresByNodeAndIp = new Map<string, TopologyCheckFailure[]>();
  const failuresByNodeFallback = new Map<string, TopologyCheckFailure[]>();

  const pushFailure = (
    map: Map<string, TopologyCheckFailure[]>,
    key: string,
    failure: TopologyCheckFailure,
  ) => {
    const list = map.get(key) ?? [];
    if (!list.some((item) => item.checkId === failure.checkId)) {
      list.push(failure);
      map.set(key, list);
    }
  };

  for (const check of serviceChecks) {
    if (!check.enabled) continue;
    const nodesWithEgressResults = new Set<string>();
    for (const er of check.egressResults ?? []) {
      nodesWithEgressResults.add(er.nodeId);
      if (er.status === "failed" || er.status === "error") {
        const failure: TopologyCheckFailure = {
          checkId: check.id,
          checkName: check.name,
          status: er.status,
          detail: er.detail,
        };
        pushFailure(failuresByExitId, er.egressIpId, failure);
        pushFailure(failuresByNodeAndIp, `${er.nodeId}:${er.egressIpv4}`, failure);
      }
    }
    for (const res of check.results ?? []) {
      if (nodesWithEgressResults.has(res.nodeId)) continue;
      if (res.status === "failed" || res.status === "error") {
        pushFailure(failuresByNodeFallback, res.nodeId, {
          checkId: check.id,
          checkName: check.name,
          status: res.status,
          detail: res.detail,
        });
      }
    }
  }

  // Build bridges (drafting geometry later once row counts are known).
  const bridgeOrderIndex = new Map(bridges.map((b, idx) => [b.id, idx]));
  const rawBridges: Omit<BridgeGraphNode, "row" | "xLeft" | "xRight" | "y">[] =
    bridges.map((bridge) => {
      const reachBridge = reachBridgeById.get(bridge.id);
      const frpsReachable =
        reachBridge?.frpsReachable ?? bridge.management?.frpsReachable ?? null;
      const activeRoutes = bridge.routes.filter((r) => r.state === "active");
      const wytunnelRoutes = activeRoutes.filter((r) => r.transport === "wytunnel");
      let wytunnelHealthyStreams = 0;
      let wytunnelTargetStreams = 0;
      const rtts: number[] = [];
      for (const route of wytunnelRoutes) {
        wytunnelHealthyStreams += route.telemetry?.healthyStreams ?? 0;
        wytunnelTargetStreams +=
          route.telemetry?.targetStreams ?? route.transportConfig?.poolSize ?? 0;
        if (typeof route.telemetry?.poolRttMs === "number") {
          rtts.push(route.telemetry.poolRttMs);
        }
      }
      const wytunnelAvgRttMs =
        rtts.length > 0 ? rtts.reduce((sum, val) => sum + val, 0) / rtts.length : null;
      return {
        id: `bridge:${bridge.id}`,
        kind: "bridge",
        column: "bridges",
        bridgeId: bridge.id,
        name: bridge.name,
        publicIpv4: bridge.publicIpv4,
        controlTcpPort: bridge.controlTcpPort,
        defaultTransport: bridge.defaultTransport,
        frpsEnabled: bridge.frpsEnabled,
        managementStatus: bridge.managementStatus,
        frpsReachable,
        activeRouteCount: activeRoutes.length,
        wytunnelRouteCount: wytunnelRoutes.length,
        wytunnelHealthyStreams,
        wytunnelTargetStreams,
        wytunnelAvgRttMs,
        onlinePeerCount: bridge.onlinePeerCount ?? 0,
        onlineByProtocol: bridge.onlineByProtocol,
        health: resolveBridgeHealth(bridge, reachBridge, frpsReachable),
      };
    });

  // Sort VPN nodes so bridged nodes align with their bridge order, and direct
  // nodes group cleanly below them to minimize line crossings.
  const sortedNodes = [...nodes].sort((a, b) => {
    const ra = routeByNode.get(a.id);
    const rb = routeByNode.get(b.id);
    const aBridgeIdx =
      ra && bridgeOrderIndex.has(ra.bridgeId)
        ? bridgeOrderIndex.get(ra.bridgeId)!
        : Number.MAX_SAFE_INTEGER;
    const bBridgeIdx =
      rb && bridgeOrderIndex.has(rb.bridgeId)
        ? bridgeOrderIndex.get(rb.bridgeId)!
        : Number.MAX_SAFE_INTEGER;
    if (aBridgeIdx !== bBridgeIdx) return aBridgeIdx - bBridgeIdx;
    return (a.publicName || a.name).localeCompare(b.publicName || b.name);
  });

  const rawNodes: Omit<VpnNodeGraphNode, "row" | "xLeft" | "xRight" | "y">[] = [];
  const rawEntries: Omit<EntryGraphNode, "row" | "xLeft" | "xRight" | "y">[] = [];
  const rawExits: Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y">[] = [];
  const pendingEdges: Array<{
    id: string;
    kind: TopologyEdgeKind;
    from: string;
    to: string;
    fromCol: TopologyColumnId;
    toCol: TopologyColumnId;
    health: TopologyHealth;
    dashed: boolean;
  }> = [];

  // Panel summary health reflects worst active bridge/node health (or muted if empty).
  let panelHealth: TopologyHealth =
    sortedNodes.length === 0 && rawBridges.length === 0 ? "muted" : "success";

  for (const b of rawBridges) {
    const edgeHealth = b.health;
    if (b.health !== "muted") {
      panelHealth = worstHealth(panelHealth, b.health);
    }
    pendingEdges.push({
      id: `panel->${b.id}`,
      kind: "panel-bridge",
      from: "panel:root",
      to: b.id,
      fromCol: "panel",
      toCol: "bridges",
      health: edgeHealth,
      dashed: false,
    });
  }

  for (const node of sortedNodes) {
    const reachNode = reachNodeById.get(node.id);
    const nodeDisplayName = node.publicName || node.name;
    const rawRoute = routeByNode.get(node.id) ?? null;
    const activeBridge =
      rawRoute && bridgeById.has(rawRoute.bridgeId)
        ? bridgeById.get(rawRoute.bridgeId)!
        : null;
    const route = activeBridge ? rawRoute : null;
    const nodeFailures = failuresByNodeFallback.get(node.id) ?? [];
    const nodeHealth = resolveNodeHealth(
      node,
      reachNode,
      nodeFailures.length > 0,
    );
    if (node.enabled) {
      panelHealth = worstHealth(panelHealth, nodeHealth);
    }

    const nodeGraphId = `node:${node.id}`;
    rawNodes.push({
      id: nodeGraphId,
      kind: "node",
      column: "nodes",
      nodeId: node.id,
      name: nodeDisplayName,
      enabled: node.enabled,
      protocol: node.protocol,
      egressMode: node.egressMode ?? "masquerade",
      egressDaemonState: node.egressDaemonState ?? null,
      modeDrift: Boolean(node.modeDrift),
      lastError: node.lastError,
      peerCount: node.peerCount ?? 0,
      maxPeers: node.maxPeers,
      onlinePeerCount: node.onlinePeerCount ?? 0,
      onlineByProtocol: node.onlineByProtocol,
      hasKeyUpdateNotice: Boolean(node.keyUpdateNotifiedAt),
      route,
      health: nodeHealth,
    });

    // Connect Panel/Bridge -> Node.
    if (hasBridges && route && activeBridge) {
      const bridgeNode = rawBridges.find((b) => b.bridgeId === activeBridge.id);
      const reachBridge = reachBridgeById.get(activeBridge.id);
      const reachRoute = reachBridge?.activeRoutes.find(
        (r) => r.nodeId === node.id,
      );
      const bridgeRouteSummary = activeBridge.routes.find(
        (r) => r.nodeId === node.id && r.state === "active",
      );
      let bridgeNodeHealth: TopologyHealth = !node.enabled
        ? "muted"
        : worstHealth(bridgeNode?.health ?? "muted", nodeHealth);
      if (
        node.enabled &&
        (reachRoute?.incidentOpen ||
          reachRoute?.observedOnline === false ||
          bridgeRouteSummary?.registration.status === "offline" ||
          (bridgeRouteSummary?.verification.kind === "awg_path" &&
            bridgeRouteSummary.verification.status === "failed"))
      ) {
        bridgeNodeHealth = "destructive";
      }
      pendingEdges.push({
        id: `${bridgeNode?.id ?? `bridge:${activeBridge.id}`}->${nodeGraphId}`,
        kind: "bridge-node",
        from: `bridge:${activeBridge.id}`,
        to: nodeGraphId,
        fromCol: "bridges",
        toCol: "nodes",
        health: bridgeNodeHealth,
        dashed: false,
      });
    } else {
      pendingEdges.push({
        id: `panel->${nodeGraphId}`,
        kind: "panel-node",
        from: "panel:root",
        to: nodeGraphId,
        fromCol: "panel",
        toCol: "nodes",
        health: node.enabled ? nodeHealth : "muted",
        dashed: hasBridges,
      });
    }

    // Build exits map for this node first so variants can resolve target exits.
    const nodeEgressIps: readonly NodeEgressIp[] = node.egressIps ?? [];
    const nodeExitById = new Map<
      string,
      Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y">
    >();
    const nodeExitByIp = new Map<
      string,
      Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y">
    >();
    const orderedNodeExits: Omit<
      ExitGraphNode,
      "row" | "xLeft" | "xRight" | "y"
    >[] = [];

    for (const exitIp of nodeEgressIps) {
      const checks = [
        ...(failuresByExitId.get(exitIp.id) ?? []),
        ...(failuresByNodeAndIp.get(`${node.id}:${exitIp.ipv4}`) ?? []),
      ];
      // Merge fallback node checks only if no per-exit check reported on this exit.
      const dedupedChecks: TopologyCheckFailure[] = [];
      const seenCheckIds = new Set<string>();
      for (const c of [...checks, ...nodeFailures]) {
        if (seenCheckIds.has(c.checkId)) continue;
        seenCheckIds.add(c.checkId);
        dedupedChecks.push(c);
      }

      const exitItem: Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y"> = {
        id: `exit:${node.id}:${exitIp.id}`,
        kind: "exit",
        column: "exits",
        exitId: exitIp.id,
        nodeId: node.id,
        nodeName: nodeDisplayName,
        ipv4: exitIp.ipv4,
        label: exitIp.label,
        isDefault: node.egressDefaultIpId === exitIp.id,
        enabled: exitIp.enabled,
        hostState: exitIp.hostState,
        failingChecks: dedupedChecks,
        incomingVariantCount: 0,
        onlinePeerCount: exitIp.onlinePeerCount ?? 0,
        onlineByProtocol: exitIp.onlineByProtocol,
        hasKeyUpdateNotice: Boolean(exitIp.keyUpdateNotifiedAt),
        isSynthetic: false,
        health: resolveExitHealth(
          node.enabled,
          exitIp.enabled,
          exitIp.hostState,
          dedupedChecks,
        ),
      };
      nodeExitById.set(exitIp.id, exitItem);
      if (!nodeExitByIp.has(exitIp.ipv4)) {
        nodeExitByIp.set(exitIp.ipv4, exitItem);
      }
      orderedNodeExits.push(exitItem);
    }

    const mergeExitOnlineStats = (
      target: Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y">,
      peerCount: number,
      byProto?: Record<string, number>,
    ) => {
      target.onlinePeerCount += peerCount;
      if (!byProto) return;
      const merged = { ...(target.onlineByProtocol ?? {}) };
      for (const [proto, count] of Object.entries(byProto)) {
        if (typeof count === "number" && count > 0) {
          merged[proto] = (merged[proto] ?? 0) + count;
        }
      }
      if (Object.keys(merged).length > 0) {
        target.onlineByProtocol = merged;
      }
    };

    const ensureImplicitExit = (
      ipv4: string,
    ): Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y"> => {
      const existing = nodeExitByIp.get(ipv4);
      if (existing) return existing;
      const checks = [
        ...(failuresByNodeAndIp.get(`${node.id}:${ipv4}`) ?? []),
        ...nodeFailures,
      ];
      const dedupedChecks: TopologyCheckFailure[] = [];
      const seenCheckIds = new Set<string>();
      for (const c of checks) {
        if (seenCheckIds.has(c.checkId)) continue;
        seenCheckIds.add(c.checkId);
        dedupedChecks.push(c);
      }
      const implicitHostState: NodeEgressIpHostState | null = !node.enabled
        ? "disabled"
        : node.lastError
          ? "daemon_offline"
          : "active";
      const synthetic: Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y"> = {
        id: `exit:${node.id}:ip:${ipv4}`,
        kind: "exit",
        column: "exits",
        exitId: null,
        nodeId: node.id,
        nodeName: nodeDisplayName,
        ipv4,
        label:
          node.egressMode === "masquerade" ? "Masquerade" : null,
        isDefault: true,
        enabled: node.enabled,
        hostState: implicitHostState,
        failingChecks: dedupedChecks,
        incomingVariantCount: 0,
        onlinePeerCount: 0,
        onlineByProtocol: undefined,
        hasKeyUpdateNotice: false,
        isSynthetic: true,
        health: resolveExitHealth(
          node.enabled,
          true,
          implicitHostState,
          dedupedChecks,
        ),
      };
      nodeExitByIp.set(ipv4, synthetic);
      orderedNodeExits.push(synthetic);
      return synthetic;
    };

    // Build entry variants for this node.
    const endpoints = mergeNodeEndpoints(node, reachNode);
    const siblingCounts = new Map<string, number>();
    for (const ep of endpoints) {
      siblingCounts.set(
        ep.publicAddress,
        (siblingCounts.get(ep.publicAddress) ?? 0) + 1,
      );
    }
    const addrCursor = new Map<string, number>();

    if (endpoints.length > 0) {
      for (const ep of endpoints) {
        const idxInAddr = (addrCursor.get(ep.publicAddress) ?? 0) + 1;
        addrCursor.set(ep.publicAddress, idxInAddr);
        const siblings = siblingCounts.get(ep.publicAddress) ?? 1;
        const ordinal = ep.variantOrdinal ?? idxInAddr;
        const hasVariantSuffix = /\bv\d+$/i.test(ep.name.trim());
        const variantTag =
          siblings > 1 || (ep.variantOrdinal ?? 0) > 1
            ? hasVariantSuffix
              ? null
              : `v${ordinal}`
            : null;
        const entryHealth = resolveEndpointHealth(node.enabled, ep);
        const entryGraphId = `entry:${node.id}:${ep.id}`;

        rawEntries.push({
          id: entryGraphId,
          kind: "entry",
          column: "entries",
          endpointId: ep.id,
          nodeId: node.id,
          nodeName: nodeDisplayName,
          name: ep.name,
          variantTag,
          publicAddress: ep.publicAddress,
          enabled: ep.enabled,
          reachabilityEnabled: ep.reachabilityEnabled ?? true,
          probeStatus: ep.probeStatus ?? null,
          probeConsecutiveFailures: ep.probeConsecutiveFailures ?? 0,
          incidentOpen: Boolean(ep.incidentOpen),
          probeEgressMatch: ep.probeEgressMatch ?? null,
          effectiveEgressIp: ep.effectiveEgressIp ?? null,
          egressIpId: ep.egressIpId ?? null,
          egressAutoRotateEnabled: Boolean(ep.egressAutoRotateEnabled),
          egressAutoRotatePoolCount: (ep.egressAutoRotatePoolIds ?? []).length,
          onlinePeerCount: ep.onlinePeerCount ?? 0,
          onlineByProtocol: ep.onlineByProtocol,
          activeKeyCount: ep.activeKeyCount,
          assignedKeyCount: ep.assignedKeyCount,
          hasKeyUpdateNotice: Boolean(ep.keyUpdateNotifiedAt),
          isSynthetic: false,
          health: entryHealth,
        });

        // Node -> Entry edge.
        const nodeEntryHealth: TopologyHealth =
          !node.enabled || !ep.enabled
            ? "muted"
            : entryHealth === "muted"
              ? nodeHealth === "success"
                ? "muted"
                : nodeHealth
              : worstHealth(nodeHealth, entryHealth);
        pendingEdges.push({
          id: `${nodeGraphId}->${entryGraphId}`,
          kind: "node-entry",
          from: nodeGraphId,
          to: entryGraphId,
          fromCol: "nodes",
          toCol: "entries",
          health: nodeEntryHealth,
          dashed: false,
        });

        // Resolve target Exit IP for this variant.
        let targetExit:
          | Omit<ExitGraphNode, "row" | "xLeft" | "xRight" | "y">
          | undefined =
          (node.egressMode === "routed" && ep.egressIpId
            ? nodeExitById.get(ep.egressIpId)
            : undefined) ??
          (ep.effectiveEgressIp
            ? nodeExitByIp.get(ep.effectiveEgressIp)
            : undefined);

        if (!targetExit && node.egressMode === "routed" && node.egressDefaultIpId) {
          targetExit = nodeExitById.get(node.egressDefaultIpId);
        }
        if (!targetExit) {
          const entryAddrIsIpv4 =
            /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ep.publicAddress);
          const fallbackIp =
            ep.effectiveEgressIp ??
            (node.egressMode === "routed" && entryAddrIsIpv4
              ? ep.publicAddress
              : null) ??
            node.publicIp ??
            node.publicHost ??
            ep.publicAddress;
          targetExit = nodeExitByIp.get(fallbackIp) ?? ensureImplicitExit(fallbackIp);
        }
        if (targetExit.isSynthetic) {
          mergeExitOnlineStats(targetExit, ep.onlinePeerCount ?? 0, ep.onlineByProtocol);
        }

        const entryExitHealth: TopologyHealth =
          !node.enabled || !ep.enabled || !targetExit.enabled
            ? "muted"
            : ep.probeEgressMatch === false
              ? "destructive"
              : targetExit.health;
        pendingEdges.push({
          id: `${entryGraphId}->${targetExit.id}`,
          kind: "entry-exit",
          from: entryGraphId,
          to: targetExit.id,
          fromCol: "entries",
          toCol: "exits",
          health: entryExitHealth,
          dashed: false,
        });
      }
    } else if (node.publicIp || node.publicHost || orderedNodeExits.length > 0) {
      // Fallback virtual entry for nodes without explicit publicEndpoints (e.g., AWG 2.0).
      const addr = node.publicIp ?? node.publicHost ?? nodeDisplayName;
      const entryGraphId = `entry:${node.id}:default`;
      rawEntries.push({
        id: entryGraphId,
        kind: "entry",
        column: "entries",
        endpointId: "default",
        nodeId: node.id,
        nodeName: nodeDisplayName,
        name: nodeDisplayName,
        variantTag: null,
        publicAddress: addr,
        enabled: node.enabled,
        reachabilityEnabled: Boolean(node.reachabilityEnabled),
        probeStatus: reachNode?.status ?? null,
        probeConsecutiveFailures: reachNode?.consecutiveFailures ?? 0,
        incidentOpen: Boolean(reachNode?.incidentOpen),
        probeEgressMatch: null,
        effectiveEgressIp: null,
        egressIpId: null,
        onlinePeerCount: node.onlinePeerCount ?? 0,
        onlineByProtocol: node.onlineByProtocol,
        hasKeyUpdateNotice: false,
        isSynthetic: true,
        health: node.enabled
          ? reachNode?.incidentOpen || reachNode?.status === "failed"
            ? "destructive"
            : (reachNode?.consecutiveFailures ?? 0) > 0 ||
                reachNode?.status === "error"
              ? "warning"
              : reachNode?.status === "ok"
                ? "success"
                : "muted"
          : "muted",
      });

      pendingEdges.push({
        id: `${nodeGraphId}->${entryGraphId}`,
        kind: "node-entry",
        from: nodeGraphId,
        to: entryGraphId,
        fromCol: "nodes",
        toCol: "entries",
        health: node.enabled ? nodeHealth : "muted",
        dashed: false,
      });

      const targetExit =
        (node.egressMode === "routed" && node.egressDefaultIpId
          ? nodeExitById.get(node.egressDefaultIpId)
          : undefined) ??
        orderedNodeExits[0] ??
        ensureImplicitExit(addr);
      if (targetExit.isSynthetic) {
        mergeExitOnlineStats(targetExit, node.onlinePeerCount ?? 0, node.onlineByProtocol);
      }

      pendingEdges.push({
        id: `${entryGraphId}->${targetExit.id}`,
        kind: "entry-exit",
        from: entryGraphId,
        to: targetExit.id,
        fromCol: "entries",
        toCol: "exits",
        health: node.enabled ? targetExit.health : "muted",
        dashed: false,
      });
    }

    for (const exitItem of orderedNodeExits) {
      rawExits.push(exitItem);
    }
  }

  // Count how many Entry variants converge onto each Physical Exit IP.
  const incomingByExitId = new Map<string, number>();
  for (const edge of pendingEdges) {
    if (edge.kind !== "entry-exit") continue;
    incomingByExitId.set(edge.to, (incomingByExitId.get(edge.to) ?? 0) + 1);
  }
  for (const exitItem of rawExits) {
    exitItem.incomingVariantCount = incomingByExitId.get(exitItem.id) ?? 0;
  }

  // Assign deterministic coordinates per column.
  const rawPanel: Omit<PanelGraphNode, "row" | "xLeft" | "xRight" | "y"> = {
    id: "panel:root",
    kind: "panel",
    column: "panel",
    activeKeysCount,
    onlineDevicesCount,
    health: panelHealth,
  };

  const countByCol: Record<TopologyColumnId, number> = {
    panel: 1,
    bridges: rawBridges.length,
    nodes: rawNodes.length,
    entries: rawEntries.length,
    exits: rawExits.length,
  };

  const maxRows = Math.max(
    1,
    ...columns.map((col) => countByCol[col]),
  );
  const contentHeight = maxRows * CARD_HEIGHT + (maxRows - 1) * ROW_GAP;
  const canvasHeight = CANVAS_PAD_Y * 2 + contentHeight;

  const columnOffsets: Record<TopologyColumnId, number> = {
    panel: CANVAS_PAD_Y,
    bridges: CANVAS_PAD_Y,
    nodes: CANVAS_PAD_Y,
    entries: CANVAS_PAD_Y,
    exits: CANVAS_PAD_Y,
  };
  for (const col of columns) {
    const cnt = countByCol[col];
    const colHeight = cnt === 0 ? 0 : cnt * CARD_HEIGHT + (cnt - 1) * ROW_GAP;
    columnOffsets[col] = CANVAS_PAD_Y + Math.round((contentHeight - colHeight) / 2);
  }

  const colBounds = (col: TopologyColumnId) => {
    const idx = columns.indexOf(col);
    const total = columns.length;
    return {
      xLeft: (idx / total) * VIEWBOX_WIDTH + EDGE_ANCHOR_INSET,
      xRight: ((idx + 1) / total) * VIEWBOX_WIDTH - EDGE_ANCHOR_INSET,
    };
  };

  const positionItem = <T extends { column: TopologyColumnId }>(
    item: T,
    row: number,
  ): T & { row: number; xLeft: number; xRight: number; y: number } => {
    const { xLeft, xRight } = colBounds(item.column);
    const top = columnOffsets[item.column] + row * (CARD_HEIGHT + ROW_GAP);
    return {
      ...item,
      row,
      xLeft,
      xRight,
      y: top + CARD_HEIGHT / 2,
    };
  };

  const positionItems = <
    T extends { column: TopologyColumnId },
  >(
    items: readonly T[],
  ): Array<T & { row: number; xLeft: number; xRight: number; y: number }> =>
    items.map((item, row) => positionItem(item, row));

  const panel: PanelGraphNode = positionItem(rawPanel, 0);
  const bridgeItems = positionItems(rawBridges);
  const nodeItems = positionItems(rawNodes);
  const entryItems = positionItems(rawEntries);
  const exitItems = positionItems(rawExits);

  const itemsById = new Map<string, TopologyGraphItem>();
  for (const item of [
    panel,
    ...bridgeItems,
    ...nodeItems,
    ...entryItems,
    ...exitItems,
  ]) {
    itemsById.set(item.id, item);
  }

  const edges: TopologyEdge[] = [];
  for (const edge of pendingEdges) {
    const fromItem = itemsById.get(edge.from);
    const toItem = itemsById.get(edge.to);
    if (!fromItem || !toItem) continue;
    edges.push({
      ...edge,
      x1: fromItem.xRight,
      y1: fromItem.y,
      x2: toItem.xLeft,
      y2: toItem.y,
      path: buildBezierPath(fromItem.xRight, fromItem.y, toItem.xLeft, toItem.y),
    });
  }

  return {
    hasBridges,
    columns,
    panel,
    bridges: bridgeItems,
    nodes: nodeItems,
    entries: entryItems,
    exits: exitItems,
    edges,
    itemsById,
    columnOffsets,
    viewBoxWidth: VIEWBOX_WIDTH,
    canvasHeight,
    cardHeight: CARD_HEIGHT,
    rowGap: ROW_GAP,
  };
}

/**
 * Compute all nodes and edges connected upstream and downstream of `selectedId`
 * in the layered topology DAG.
 */
export function computeHighlightedPath(
  graph: FleetTopologyGraph,
  selectedId: string | null,
): { activeNodeIds: Set<string>; activeEdgeIds: Set<string> } {
  const activeNodeIds = new Set<string>();
  const activeEdgeIds = new Set<string>();
  if (!selectedId || !graph.itemsById.has(selectedId)) {
    return { activeNodeIds, activeEdgeIds };
  }

  const outgoing = new Map<string, TopologyEdge[]>();
  const incoming = new Map<string, TopologyEdge[]>();
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push(edge);
    outgoing.set(edge.from, out);

    const inc = incoming.get(edge.to) ?? [];
    inc.push(edge);
    incoming.set(edge.to, inc);
  }

  activeNodeIds.add(selectedId);

  // Walk upstream (ancestors) toward Panel.
  const upQueue = [selectedId];
  const visitedUp = new Set<string>([selectedId]);
  while (upQueue.length > 0) {
    const cur = upQueue.shift()!;
    for (const edge of incoming.get(cur) ?? []) {
      activeEdgeIds.add(edge.id);
      activeNodeIds.add(edge.from);
      if (!visitedUp.has(edge.from)) {
        visitedUp.add(edge.from);
        upQueue.push(edge.from);
      }
    }
  }

  // Walk downstream (descendants) toward Physical Exit IPs.
  const downQueue = [selectedId];
  const visitedDown = new Set<string>([selectedId]);
  while (downQueue.length > 0) {
    const cur = downQueue.shift()!;
    for (const edge of outgoing.get(cur) ?? []) {
      activeEdgeIds.add(edge.id);
      activeNodeIds.add(edge.to);
      if (!visitedDown.has(edge.to)) {
        visitedDown.add(edge.to);
        downQueue.push(edge.to);
      }
    }
  }

  return { activeNodeIds, activeEdgeIds };
}

const COLUMN_TITLE_KEY: Record<TopologyColumnId, string> = {
  panel: "ov.map.colPanel",
  bridges: "ov.map.colBridges",
  nodes: "ov.map.colNodes",
  entries: "ov.map.colEntries",
  exits: "ov.map.colExits",
};

function OnlineCountPill({
  count,
  t,
}: {
  count: number;
  t: ReturnType<typeof useT>["t"];
}) {
  return (
    <span
      title={t("ov.map.onlineTitle")}
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none tabular",
        count > 0
          ? "bg-success/15 text-success"
          : "bg-muted text-muted-foreground",
      )}
    >
      {t("ov.map.onlineCount", { count })}
    </span>
  );
}

function HealthDot({ health }: { health: TopologyHealth }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", HEALTH_DOT_CLASS[health])}
    />
  );
}

/**
 * Interactive fleet topology map (`Panel -> Bridges -> VPN Nodes -> Entry Variants -> Exits`).
 */
export function FleetTopologyMap({
  nodes,
  bridges,
  routeByNode,
  serviceChecks,
  reachability,
  activeKeysCount,
  onlineDevicesCount,
  defaultExpanded = true,
  onOpenBridge,
  onOpenNode,
  onOpenVariant,
  onOpenExit,
}: FleetTopologyMapProps) {
  const { t } = useT();
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const graph = React.useMemo(
    () =>
      buildFleetTopologyGraph({
        nodes,
        bridges,
        routeByNode,
        serviceChecks,
        reachability,
        activeKeysCount,
        onlineDevicesCount,
      }),
    [
      nodes,
      bridges,
      routeByNode,
      serviceChecks,
      reachability,
      activeKeysCount,
      onlineDevicesCount,
    ],
  );

  // Clear selection/hover if the targeted item disappears after a refresh.
  const effectiveSelectedId =
    selectedId && graph.itemsById.has(selectedId) ? selectedId : null;
  const effectiveHoveredId =
    hoveredId && graph.itemsById.has(hoveredId) ? hoveredId : null;
  const activeHighlightId = effectiveHoveredId ?? effectiveSelectedId;

  const { activeNodeIds, activeEdgeIds } = React.useMemo(
    () => computeHighlightedPath(graph, activeHighlightId),
    [graph, activeHighlightId],
  );
  const hasHighlight = activeHighlightId !== null;
  const selectedItem = effectiveSelectedId
    ? graph.itemsById.get(effectiveSelectedId)
    : undefined;

  const toggleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  const hoverProps = (id: string) => ({
    onMouseEnter: () => setHoveredId(id),
    onMouseLeave: () => setHoveredId((prev) => (prev === id ? null : prev)),
    onFocus: () => setHoveredId(id),
    onBlur: () => setHoveredId((prev) => (prev === id ? null : prev)),
  });

  const isEmpty = nodes.length === 0 && bridges.length === 0;

  return (
    <Card data-testid="fleet-topology-map" className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 px-4 py-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <GitBranch className="size-4 text-primary" />
            {t("ov.map.title")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("ov.map.subtitle")}
            <span className="ml-1.5 text-muted-foreground/80">
              · {t("ov.map.clickHint")}
            </span>
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3.5" />
              {t("ov.map.collapse")}
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" />
              {t("ov.map.expand")}
            </>
          )}
        </Button>
      </CardHeader>

      {expanded ? (
        <CardContent className="space-y-3 border-t border-border/60 px-4 py-3">
          {isEmpty ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t("ov.map.empty")}
            </p>
          ) : (
            <div className="overflow-x-auto pb-1">
              <div
                className={cn(
                  "space-y-2",
                  graph.hasBridges ? "min-w-[900px]" : "min-w-[760px]",
                )}
              >
                {/* Column headers */}
                <div
                  className={cn(
                    "grid gap-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                    graph.hasBridges ? "grid-cols-5" : "grid-cols-4",
                  )}
                >
                  {graph.columns.map((col) => (
                    <div key={col} className="px-2">
                      {t(COLUMN_TITLE_KEY[col])}
                    </div>
                  ))}
                </div>

                {/* Layered columns + SVG bezier connection overlay */}
                <div
                  className="relative"
                  style={{ height: `${graph.canvasHeight}px` }}
                >
                  <svg
                    aria-hidden="true"
                    data-testid="fleet-topology-svg"
                    viewBox={`0 0 ${graph.viewBoxWidth} ${graph.canvasHeight}`}
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 z-0 h-full w-full"
                  >
                    {graph.edges.map((edge) => {
                      const highlighted =
                        !hasHighlight || activeEdgeIds.has(edge.id);
                      return (
                        <path
                          key={edge.id}
                          d={edge.path}
                          fill="none"
                          strokeWidth={highlighted && hasHighlight ? 2.6 : 1.8}
                          strokeLinecap="round"
                          strokeDasharray={edge.dashed ? "5 4" : undefined}
                          className={cn(
                            "transition-opacity duration-150",
                            HEALTH_STROKE_CLASS[edge.health],
                            highlighted ? "opacity-85" : "opacity-15",
                          )}
                        />
                      );
                    })}
                  </svg>

                  <div
                    className={cn(
                      "relative z-10 grid h-full gap-0",
                      graph.hasBridges ? "grid-cols-5" : "grid-cols-4",
                    )}
                  >
                    {/* Panel column */}
                    <div
                      className="flex flex-col px-2"
                      style={{
                        paddingTop: `${graph.columnOffsets.panel}px`,
                        gap: `${graph.rowGap}px`,
                      }}
                    >
                      <div
                        data-node-id={graph.panel.id}
                        style={{ height: `${graph.cardHeight}px` }}
                        className={cn(
                          "flex flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-xs shadow-xs transition-opacity",
                          HEALTH_BORDER_CLASS[graph.panel.health],
                          hasHighlight && !activeNodeIds.has(graph.panel.id)
                            ? "opacity-35"
                            : "opacity-100",
                        )}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                            <Server className="size-3.5 shrink-0 text-primary" />
                            <span className="truncate">
                              {t("ov.map.panelLabel")}
                            </span>
                          </span>
                          <HealthDot health={graph.panel.health} />
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground tabular">
                          {t("ov.map.peersOnline", {
                            keys: graph.panel.activeKeysCount,
                            online: graph.panel.onlineDevicesCount,
                          })}
                        </p>
                        <div className="text-[11px] text-muted-foreground">
                          {nodes.length} {t("ov.map.colNodes").toLowerCase()}
                        </div>
                      </div>
                    </div>

                    {/* Bridges column (only when bridges exist) */}
                    {graph.hasBridges ? (
                      <div
                        className="flex flex-col px-2"
                        style={{
                          paddingTop: `${graph.columnOffsets.bridges}px`,
                          gap: `${graph.rowGap}px`,
                        }}
                      >
                        {graph.bridges.map((b) => {
                          const isSelected = effectiveSelectedId === b.id;
                          const isDimmed =
                            hasHighlight && !activeNodeIds.has(b.id);
                          const wytunnelSummary =
                            b.wytunnelRouteCount > 0
                              ? b.wytunnelTargetStreams > 0
                                ? `WyTunnel ${b.wytunnelHealthyStreams}/${b.wytunnelTargetStreams}`
                                : "WyTunnel"
                              : null;
                          const frpsLabel =
                            b.frpsEnabled === false
                              ? (wytunnelSummary ?? "WyTunnel")
                              : b.frpsReachable === null
                                ? "frps ?"
                                : b.frpsReachable
                                  ? "frps ok"
                                  : "frps down";
                          const transportLine =
                            b.frpsEnabled === false
                              ? frpsLabel
                              : wytunnelSummary
                                ? `${frpsLabel} · ${wytunnelSummary}`
                                : `${frpsLabel} · :${b.controlTcpPort}`;
                          return (
                            <button
                              key={b.id}
                              type="button"
                              data-node-id={b.id}
                              aria-pressed={isSelected}
                              {...hoverProps(b.id)}
                              onClick={() => {
                                if (onOpenBridge) {
                                  setSelectedId(b.id);
                                  onOpenBridge(b.bridgeId);
                                } else {
                                  toggleSelect(b.id);
                                }
                              }}
                              style={{ height: `${graph.cardHeight}px` }}
                              className={cn(
                                "flex w-full cursor-pointer flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-xs shadow-xs transition-all hover:border-primary/60 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                HEALTH_BORDER_CLASS[b.health],
                                isSelected && "ring-2 ring-primary",
                                isDimmed && "opacity-35",
                              )}
                            >
                              <div className="flex items-center justify-between gap-1.5">
                                <span className="flex min-w-0 items-center gap-1.5 font-medium">
                                  <Cable className="size-3.5 shrink-0 text-chart-1" />
                                  <span className="truncate">{b.name}</span>
                                </span>
                                <div className="flex shrink-0 items-center gap-1">
                                  <OnlineCountPill count={b.onlinePeerCount} t={t} />
                                  <HealthDot health={b.health} />
                                </div>
                              </div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">
                                {b.publicIpv4}
                              </div>
                              <div className="flex items-center justify-between gap-1 text-[11px]">
                                <span
                                  className={cn(
                                    "shrink-0 font-mono",
                                    b.frpsEnabled === false
                                      ? "text-primary"
                                      : b.frpsReachable === false
                                        ? "text-destructive"
                                        : b.frpsReachable
                                          ? "text-success"
                                          : "text-muted-foreground",
                                  )}
                                >
                                  {transportLine}
                                </span>
                                <span
                                  title={t(`bridge.status.${b.managementStatus}`)}
                                  className="min-w-0 truncate text-muted-foreground"
                                >
                                  {t(`bridge.status.${b.managementStatus}`)}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {/* VPN Nodes column */}
                    <div
                      className="flex flex-col px-2"
                      style={{
                        paddingTop: `${graph.columnOffsets.nodes}px`,
                        gap: `${graph.rowGap}px`,
                      }}
                    >
                      {graph.nodes.map((n) => {
                        const isSelected = effectiveSelectedId === n.id;
                        const isDimmed =
                          hasHighlight && !activeNodeIds.has(n.id);
                        const egressdText = n.egressDaemonState
                          ? t(`egress.daemon.${n.egressDaemonState}`)
                          : "—";
                        const daemonShortText = n.egressDaemonState
                          ? t(`ov.map.daemonShort.${n.egressDaemonState}`)
                          : "—";
                        const daemonPillTone = n.egressDaemonState
                          ? DAEMON_PILL_TONE[n.egressDaemonState]
                          : "bg-muted text-muted-foreground";
                        return (
                          <button
                            key={n.id}
                            type="button"
                            data-node-id={n.id}
                            aria-pressed={isSelected}
                            {...hoverProps(n.id)}
                            onClick={() => {
                              if (onOpenNode) {
                                setSelectedId(n.id);
                                onOpenNode(n.nodeId);
                              } else {
                                toggleSelect(n.id);
                              }
                            }}
                            style={{ height: `${graph.cardHeight}px` }}
                            className={cn(
                              "flex w-full cursor-pointer flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-xs shadow-xs transition-all hover:border-primary/60 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              HEALTH_BORDER_CLASS[n.health],
                              isSelected && "ring-2 ring-primary",
                              isDimmed && "opacity-35",
                            )}
                          >
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="flex min-w-0 items-center gap-1.5 font-medium">
                                <Server className="size-3.5 shrink-0 text-chart-2" />
                                <span className="truncate">{n.name}</span>
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <OnlineCountPill count={n.onlinePeerCount} t={t} />
                                {n.modeDrift ? (
                                  <AlertTriangle className="size-3 text-destructive" />
                                ) : null}
                                <HealthDot health={n.health} />
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-1.5 text-[11px]">
                              <span className="truncate font-medium text-foreground/85">
                                {t(`egress.mode.${n.egressMode}`)}
                              </span>
                              <span
                                title={egressdText}
                                className={cn(
                                  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
                                  daemonPillTone,
                                )}
                              >
                                {daemonShortText}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground tabular">
                              <span>
                                {n.peerCount}/{n.maxPeers}
                              </span>
                              {graph.hasBridges ? (
                                <span className="truncate">
                                  {n.route
                                    ? t("ov.map.viaBridge", {
                                        name: n.route.bridgeName,
                                      })
                                    : t("ov.map.direct")}
                                </span>
                              ) : (
                                <span className="uppercase">{n.protocol}</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Entry Variants column */}
                    <div
                      className="flex flex-col px-2"
                      style={{
                        paddingTop: `${graph.columnOffsets.entries}px`,
                        gap: `${graph.rowGap}px`,
                      }}
                    >
                      {graph.entries.map((e) => {
                        const isSelected = effectiveSelectedId === e.id;
                        const isDimmed =
                          hasHighlight && !activeNodeIds.has(e.id);
                        const hasPreAlert =
                          e.probeConsecutiveFailures > 0 && !e.incidentOpen;
                        return (
                          <button
                            key={e.id}
                            type="button"
                            data-node-id={e.id}
                            aria-pressed={isSelected}
                            {...hoverProps(e.id)}
                            onClick={() => {
                              if (onOpenVariant) {
                                setSelectedId(e.id);
                                onOpenVariant(e.nodeId, e.endpointId);
                              } else {
                                toggleSelect(e.id);
                              }
                            }}
                            style={{ height: `${graph.cardHeight}px` }}
                            className={cn(
                              "flex w-full cursor-pointer flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-xs shadow-xs transition-all hover:border-primary/60 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              HEALTH_BORDER_CLASS[e.health],
                              isSelected && "ring-2 ring-primary",
                              isDimmed && "opacity-35",
                            )}
                          >
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="flex min-w-0 items-center gap-1 font-medium">
                                <span className="truncate">{e.name}</span>
                                {e.variantTag ? (
                                  <Badge
                                    variant="secondary"
                                    className="shrink-0 px-1.5 py-0 text-[10px]"
                                  >
                                    {e.variantTag}
                                  </Badge>
                                ) : null}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <OnlineCountPill count={e.onlinePeerCount} t={t} />
                                <HealthDot health={e.health} />
                              </div>
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {e.publicAddress}
                            </div>
                            <div className="flex min-h-[18px] items-center gap-1 overflow-hidden">
                              {e.incidentOpen ? (
                                <Badge
                                  variant="destructive"
                                  className="gap-1 px-1.5 py-0 text-[10px]"
                                >
                                  <ShieldAlert className="size-2.5" />
                                  {t("reachability.incident")}
                                </Badge>
                              ) : hasPreAlert ? (
                                <Badge
                                  variant="warning"
                                  className="px-1.5 py-0 text-[10px]"
                                >
                                  {t("reachability.preAlert", {
                                    count: e.probeConsecutiveFailures,
                                  })}
                                </Badge>
                              ) : e.probeEgressMatch === false ? (
                                <Badge
                                  variant="destructive"
                                  className="px-1.5 py-0 text-[10px]"
                                >
                                  {t("reachability.egressMismatch")}
                                </Badge>
                              ) : (
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {e.nodeName}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Physical Exit IPs column */}
                    <div
                      className="flex flex-col px-2"
                      style={{
                        paddingTop: `${graph.columnOffsets.exits}px`,
                        gap: `${graph.rowGap}px`,
                      }}
                    >
                      {graph.exits.map((ex) => {
                        const isSelected = effectiveSelectedId === ex.id;
                        const isDimmed =
                          hasHighlight && !activeNodeIds.has(ex.id);
                        const firstFailure = ex.failingChecks[0];
                        return (
                          <button
                            key={ex.id}
                            type="button"
                            data-node-id={ex.id}
                            aria-pressed={isSelected}
                            {...hoverProps(ex.id)}
                            onClick={() => {
                              if (onOpenExit) {
                                setSelectedId(ex.id);
                                onOpenExit(ex.nodeId, ex.exitId);
                              } else {
                                toggleSelect(ex.id);
                              }
                            }}
                            style={{ height: `${graph.cardHeight}px` }}
                            className={cn(
                              "flex w-full cursor-pointer flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-xs shadow-xs transition-all hover:border-primary/60 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              HEALTH_BORDER_CLASS[ex.health],
                              isSelected && "ring-2 ring-primary",
                              isDimmed && "opacity-35",
                            )}
                          >
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="flex min-w-0 items-center gap-1.5 font-mono font-medium">
                                <Globe className="size-3.5 shrink-0 text-chart-4" />
                                <span className="truncate">{ex.ipv4}</span>
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <OnlineCountPill count={ex.onlinePeerCount} t={t} />
                                {ex.incomingVariantCount > 1 ? (
                                  <span
                                    title={t("ov.map.sharedExitTitle", {
                                      count: ex.incomingVariantCount,
                                    })}
                                    className="rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none text-primary tabular"
                                  >
                                    ×{ex.incomingVariantCount}
                                  </span>
                                ) : null}
                                <HealthDot health={ex.health} />
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
                              <span className="truncate">
                                {ex.label ?? ex.nodeName}
                              </span>
                              {ex.hostState ? (
                                <span className="shrink-0 truncate">
                                  {t(`egress.hostState.${ex.hostState}`)}
                                </span>
                              ) : null}
                            </div>
                            <div className="flex min-h-[18px] items-center gap-1 overflow-hidden">
                              {firstFailure ? (
                                <Badge
                                  variant={
                                    firstFailure.status === "failed"
                                      ? "destructive"
                                      : "warning"
                                  }
                                  className="max-w-full truncate px-1.5 py-0 text-[10px]"
                                >
                                  {firstFailure.checkName}
                                  {ex.failingChecks.length > 1
                                    ? ` +${ex.failingChecks.length - 1}`
                                    : ""}
                                </Badge>
                              ) : (
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {ex.nodeName}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Compact inspector footer when a Bridge, Node, Variant, or Exit is selected */}
          {selectedItem && selectedItem.kind !== "panel" ? (
            <TopologyInspectorFooter
              item={selectedItem}
              onClear={() => setSelectedId(null)}
              t={t}
            />
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

const PROTOCOL_DISPLAY_LABEL: Record<string, string> = Object.fromEntries(
  PROTOCOLS.map((p) => [p.value, p.label]),
);

function formatProtocolBreakdown(onlineByProtocol?: Record<string, number>): string | null {
  if (!onlineByProtocol) return null;
  const parts = Object.entries(onlineByProtocol)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([proto, count]) => `${PROTOCOL_DISPLAY_LABEL[proto] ?? proto.toUpperCase()}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function describeSelectedItem(
  item: SelectableTopologyItem,
  t: ReturnType<typeof useT>["t"],
): { summary: string; href: string; linkLabel: string } {
  const breakdown = formatProtocolBreakdown(item.onlineByProtocol);
  const onlineText = breakdown
    ? `${t("ov.map.onlineCount", { count: item.onlinePeerCount })} (${breakdown})`
    : t("ov.map.onlineCount", { count: item.onlinePeerCount });

  if (item.kind === "bridge") {
    const wtPart =
      item.wytunnelRouteCount > 0
        ? `WyTunnel ${item.wytunnelHealthyStreams}/${item.wytunnelTargetStreams}${item.wytunnelAvgRttMs !== null ? ` (${Math.round(item.wytunnelAvgRttMs)} ms)` : ""}`
        : null;
    const frpsText =
      item.frpsEnabled === false
        ? (wtPart ?? "WyTunnel")
        : item.frpsReachable === null
          ? "frps ?"
          : item.frpsReachable
            ? "frps ok"
            : "frps down";
    const transportPart =
      item.frpsEnabled !== false && wtPart ? `${frpsText} · ${wtPart}` : frpsText;
    return {
      summary: `${item.name} · ${item.publicIpv4} · ${onlineText} · ${transportPart} · ${t(`bridge.status.${item.managementStatus}`)}`,
      href: bridgeSectionHref,
      linkLabel: t("ov.map.openBridges"),
    };
  }
  const noticePart = item.hasKeyUpdateNotice
    ? ` · ${t("notifyKeyUpdate.activeBadge")}`
    : "";
  if (item.kind === "node") {
    const routePart = item.route
      ? t("ov.map.viaBridge", { name: item.route.bridgeName })
      : t("ov.map.direct");
    const egressPart = item.egressDaemonState
      ? t(`egress.daemon.${item.egressDaemonState}`)
      : "—";
    return {
      summary: `${item.name} · ${onlineText} · ${t(`egress.mode.${item.egressMode}`)} · egressd: ${egressPart} · ${item.peerCount}/${item.maxPeers} · ${routePart}${noticePart}`,
      href: `${NODES_PATH}#${nodeCardAnchor(item.nodeId)}`,
      linkLabel: t("ov.map.openNode"),
    };
  }
  if (item.kind === "entry") {
    const probePart = item.incidentOpen
      ? t("reachability.incident")
      : item.probeConsecutiveFailures > 0
        ? t("reachability.preAlert", { count: item.probeConsecutiveFailures })
        : item.probeStatus ?? "unknown";
    const exitPart = item.effectiveEgressIp
      ? ` -> ${item.effectiveEgressIp}`
      : "";
    const keysPart =
      typeof item.activeKeyCount === "number"
        ? t("ov.map.activeKeysCount", { count: item.activeKeyCount })
        : "";
    const autoRotatePart = item.egressAutoRotateEnabled
      ? ` · ${t("egress.autoRotateBadge", { count: item.egressAutoRotatePoolCount ?? 0 })}`
      : "";
    return {
      summary: `${item.nodeName} · ${item.name} (${item.publicAddress}${exitPart}) · ${onlineText}${keysPart} · ${probePart}${autoRotatePart}${noticePart}`,
      href: `${NODES_PATH}#${nodeCardAnchor(item.nodeId)}`,
      linkLabel: t("ov.map.openNode"),
    };
  }
  const hostPart = item.hostState
    ? t(`egress.hostState.${item.hostState}`)
    : "—";
  const checksPart =
    item.failingChecks.length > 0
      ? ` · ${item.failingChecks.map((c) => c.checkName).join(", ")}`
      : "";
  return {
    summary: `${item.nodeName} · ${item.ipv4}${item.label ? ` (${item.label})` : ""} · ${onlineText} · ${hostPart}${checksPart}${noticePart}`,
    href: `${NODES_PATH}#${nodeCardAnchor(item.nodeId)}`,
    linkLabel: t("ov.map.openNode"),
  };
}

function TopologyInspectorFooter({
  item,
  onClear,
  t,
}: {
  item: SelectableTopologyItem;
  onClear: () => void;
  t: ReturnType<typeof useT>["t"];
}) {
  const { summary, href, linkLabel } = describeSelectedItem(item, t);

  return (
    <div
      data-testid="fleet-topology-inspector"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-well px-3 py-2 text-xs shadow-[var(--inset-shadow)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline" className="shrink-0">
          {t("ov.map.selectedPath")}
        </Badge>
        <span className="min-w-0 break-words font-medium">{summary}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button asChild variant="secondary" size="sm" className="h-7 px-2.5 text-xs">
          <Link href={href} prefetch={false}>
            {linkLabel}
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onClear}
        >
          <X className="size-3.5" />
          {t("ov.map.clearSelection")}
        </Button>
      </div>
    </div>
  );
}
