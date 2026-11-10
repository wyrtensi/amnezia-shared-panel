"use client";

import * as React from "react";

import { apiRequest } from "@/lib/api";
import type { AdminReachabilityNode, AdminReachabilityView } from "@/lib/types";

/**
 * The external probe's settings, health, and what it saw of every node.
 *
 * One fetch for the page, like the service checks: the card lists it by node,
 * and anything else that wants a node's reachability reads the same map rather
 * than fetching again and risking a different answer on screen.
 */
export type ReachabilityState = {
  view: AdminReachabilityView | null;
  byNode: Map<string, AdminReachabilityNode>;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
};

export function useReachability(): ReachabilityState {
  const [view, setView] = React.useState<AdminReachabilityView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setView(await apiRequest<AdminReachabilityView>("/api/admin/reachability"));
      setFailed(false);
    } catch {
      // Recorded, not swallowed: a card that silently renders nothing reads as
      // "no probe", which is a different and wrong answer.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const byNode = React.useMemo(
    () => new Map((view?.nodes ?? []).map((node) => [node.nodeId, node])),
    [view],
  );

  return { view, byNode, loading, failed, reload };
}
