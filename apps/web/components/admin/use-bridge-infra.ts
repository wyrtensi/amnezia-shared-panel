"use client";

import * as React from "react";
import type { Bridge, InfrastructureItem } from "@amnezia/contracts";
import { useAdminData } from "@/components/admin/admin-data";
import { listInfrastructure } from "@/lib/bridge-api";
import { bridgeEntry } from "@/lib/bridge-ui";

export type NodeRouteLabel = {
  bridgeName: string;
  entry: string;
};

export type BridgeInfra = {
  bridges: Bridge[];
  /** Active bridge route of each VPN node, by node id; absent means Direct. */
  routeByNode: Map<string, NodeRouteLabel>;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
};

/** One `GET /api/admin/infrastructure` for both the Nodes and Bridges tabs. */
export function useBridgeInfra(): BridgeInfra {
  const { request } = useAdminData();
  const [items, setItems] = React.useState<InfrastructureItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setItems(await listInfrastructure(request));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
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
        bridgeName: bridge.name,
        entry: bridgeEntry(bridge.publicIpv4, item.activeRoute.publicUdpPort),
      });
    }
    return { bridges, routeByNode, loading, failed, reload };
  }, [items, loading, failed, reload]);
}
