"use client";

import * as React from "react";

import { apiRequest } from "@/lib/api";
import type { AdminServiceCheck } from "@/lib/types";

/**
 * Every service check, with every node's verdict.
 *
 * One fetch shared by the checks card and the node cards. A check is defined
 * once and runs on EVERY node, so the two views are the same data seen from
 * different ends - by check, and by node - and fetching it twice would let them
 * disagree on screen.
 */
export type ServiceChecksState = {
  checks: AdminServiceCheck[];
  /** Node id -> that node's verdict for each check, in check-name order. */
  byNode: Map<string, Array<{ name: string; status: string; detail: string | null }>>;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
};

export function useServiceChecks(): ServiceChecksState {
  const [checks, setChecks] = React.useState<AdminServiceCheck[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setChecks(await apiRequest<AdminServiceCheck[]>("/api/admin/service-checks"));
      setFailed(false);
    } catch {
      // Recorded, not swallowed. Rendering nothing on a failed load is how a
      // card becomes invisible and an operator concludes the feature is absent.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const byNode = React.useMemo(() => {
    const map = new Map<
      string,
      Array<{ name: string; status: string; detail: string | null }>
    >();
    for (const check of checks) {
      for (const result of check.results ?? []) {
        const list = map.get(result.nodeId) ?? [];
        list.push({ name: check.name, status: result.status, detail: result.detail });
        map.set(result.nodeId, list);
      }
    }
    for (const list of map.values()) {
      list.sort((left, right) => left.name.localeCompare(right.name));
    }
    return map;
  }, [checks]);

  return { checks, byNode, loading, failed, reload };
}
