"use client";

import * as React from "react";
import type { Bridge, InfrastructureItem, WytunnelRelease } from "@amnezia/contracts";
import { useAdminData } from "@/components/admin/admin-data";
import {
  getWytunnelRelease,
  listInfrastructure,
  refreshWytunnelRelease as requestRefreshWytunnelRelease,
} from "@/lib/bridge-api";
import { bridgeEntry } from "@/lib/bridge-ui";

export type NodeRouteLabel = {
  bridgeId: string;
  bridgeName: string;
  entry: string;
  revision: number;
};

export type BridgeInfra = {
  bridges: Bridge[];
  /** Active bridge route of each VPN node, by node id; absent means Direct. */
  routeByNode: Map<string, NodeRouteLabel>;
  wytunnelRelease?: WytunnelRelease | null;
  refreshWytunnelRelease?: () => Promise<WytunnelRelease | null>;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
};

/** One infrastructure response supplies both sections and their route links. */
export function useBridgeInfra(): BridgeInfra {
  const { request } = useAdminData();
  const [items, setItems] = React.useState<InfrastructureItem[]>([]);
  const [wytunnelRelease, setWytunnelRelease] = React.useState<WytunnelRelease | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const [infra, wtRel] = await Promise.all([
        listInfrastructure(request),
        getWytunnelRelease(request).catch(() => null),
      ]);
      setItems(infra);
      if (wtRel) setWytunnelRelease(wtRel);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [request]);

  const refreshWytunnelRelease = React.useCallback(async (): Promise<WytunnelRelease | null> => {
    try {
      const rel = await requestRefreshWytunnelRelease(request);
      setWytunnelRelease(rel);
      const infra = await listInfrastructure(request);
      setItems(infra);
      return rel;
    } catch {
      return null;
    }
  }, [request]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return React.useMemo(() => {
    const bridges = items.flatMap((item) => (item.kind === "bridge" ? [item] : []));
    const byId = new Map(bridges.map((bridge) => [bridge.id, bridge]));
    const routeByNode = new Map<string, NodeRouteLabel>();
    for (const item of items) {
      if (item.kind !== "vpn" || !item.activeRoute) continue;
      const bridge = byId.get(item.activeRoute.bridgeId);
      if (!bridge) continue;
      routeByNode.set(item.id, {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        entry: bridgeEntry(bridge.publicIpv4, item.activeRoute.publicUdpPort),
        revision: item.vpnEndpointRevision,
      });
    }
    return {
      bridges,
      routeByNode,
      wytunnelRelease,
      refreshWytunnelRelease,
      loading,
      failed,
      reload,
    };
  }, [items, wytunnelRelease, refreshWytunnelRelease, loading, failed, reload]);
}
