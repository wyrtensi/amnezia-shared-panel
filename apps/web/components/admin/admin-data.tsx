"use client";

import * as React from "react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import type { GlobalRoutes } from "@amnezia/contracts";
import type { KeyLimitMode, ProtocolKind, TrafficPair } from "@/lib/types";

/** Fresh empty payload — a factory so no two callers share the same arrays. */
export const newGlobalRoutes = (): GlobalRoutes => ({
  ru_whitelist: {
    add: { cidrs: [], domains: [] },
    exclude: { cidrs: [], domains: [] },
  },
  ru_blacklist: {
    add: { cidrs: [], domains: [] },
    exclude: { cidrs: [], domains: [] },
  },
});

export type Overview = {
  pendingQuotaRequests: number;
  activeKeys: number;
  enabledNodes: number;
  totalKeys?: number;
  totalUsers?: number;
  activeUsers?: number;
  disabledUsers?: number;
  usersByStatus?: Record<string, number>;
  onlineDevices?: number;
  totalTrafficBytes?: string;
  totalReceivedBytes?: string;
  totalSentBytes?: string;
  keysByState?: Record<string, number>;
  keysByProtocol?: Record<string, number>;
  keysByProfile?: Record<string, number>;
  nodes?: { total: number; enabled: number; healthy: number };
};

export type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  keyLimitOverride: number | null;
  /** Per-node key limits (nodeId -> limit); null when the user has none. */
  nodeKeyLimits: Record<string, number> | null;
  policyOverride: Record<string, unknown> | null;
  deactivationReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type QuotaRequest = {
  id: string;
  userId: string;
  requestedLimit: number;
  /** Target server; null means the request covers every server. */
  nodeId: string | null;
  /** Admin-facing name of the target node; null for an every-server request. */
  nodeName: string | null;
  reason: string;
  status: string;
  createdAt: string;
};

export type AdminNode = {
  id: string;
  name: string;
  publicName?: string | null;
  apiBaseUrl: string;
  enabled: boolean;
  protocol: string;
  maxPeers: number;
  supportedProtocols?: ProtocolKind[];
  enabledProtocols?: ProtocolKind[] | null;
  peerCount?: number;
  traffic?: { today: TrafficPair; week: TrafficPair; month: TrafficPair };
  capabilities: Record<string, unknown>;
  lastHealthAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminKey = {
  id: string;
  ownerId: string;
  nodeId: string;
  protocol: string;
  state: string;
  deviceType: string;
  deviceLabel: string;
  keyNumber?: number | null;
  routeProfile: string;
  routeRuleVersionId: string | null;
  rulesOutdated?: boolean;
  lastUsedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  online?: boolean;
  traffic?: { receivedBytes: string; sentBytes: string } | null;
};

export type RuleVersion = {
  id: string;
  profile: string;
  version: string;
  sourceUrl: string | null;
  cidrCount?: number;
  domainCount?: number;
  status: string;
  publishedAt?: string | null;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  actorUserId: string | null;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type GlobalPortalPolicy = {
  allowKeyCreation: boolean;
  allowNodeSelection: boolean;
  allowedProtocols: ProtocolKind[];
  allowedNodeIds: string[] | null;
  allowRouteProfileSelection: boolean;
  allowCustomRoutes: boolean;
  allowConfigRedownload: boolean;
  allowQrDownload: boolean;
  allowConfDownload: boolean;
  allowSelfRevoke: boolean;
  showPublicKey: boolean;
  showLastUsed: boolean;
  showTraffic: boolean;
  defaultKeyLimit: number;
  keyLimitMode: KeyLimitMode;
  dailyRetentionDays: number | null;
  cfAccessAccountId?: string | null;
  cfAccessAppId?: string | null;
  cfAccessPolicyId?: string | null;
  cfApiTokenSet?: boolean;
};

const DEFAULT_POLICY: GlobalPortalPolicy = {
  allowKeyCreation: true,
  allowNodeSelection: true,
  allowedProtocols: ["awg3"],
  allowedNodeIds: null,
  allowRouteProfileSelection: true,
  allowCustomRoutes: true,
  allowConfigRedownload: true,
  allowQrDownload: true,
  allowConfDownload: true,
  allowSelfRevoke: true,
  showPublicKey: false,
  showLastUsed: true,
  showTraffic: true,
  defaultKeyLimit: 5,
  // Per-node is the pre-existing behaviour, so a panel that has not loaded the
  // policy yet never flashes the global-pool wording.
  keyLimitMode: "per_node",
  dailyRetentionDays: 730,
  cfAccessAccountId: null,
  cfAccessAppId: null,
  cfAccessPolicyId: null,
  cfApiTokenSet: false,
};

export type AdminData = {
  overview: Overview | null;
  users: AdminUser[];
  requests: QuotaRequest[];
  nodes: AdminNode[];
  keys: AdminKey[];
  rules: RuleVersion[];
  audit: AuditEvent[];
  policy: GlobalPortalPolicy;
  globalRoutes: GlobalRoutes;
  loading: boolean;
  reload: () => Promise<void>;
  action: (
    resource: string,
    id: string,
    actionName: string,
    payload?: unknown,
  ) => Promise<boolean>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

const AdminDataContext = React.createContext<AdminData | null>(null);

export function AdminDataProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [requests, setRequests] = React.useState<QuotaRequest[]>([]);
  const [nodes, setNodes] = React.useState<AdminNode[]>([]);
  const [keys, setKeys] = React.useState<AdminKey[]>([]);
  const [rules, setRules] = React.useState<RuleVersion[]>([]);
  const [audit, setAudit] = React.useState<AuditEvent[]>([]);
  const [policy, setPolicy] = React.useState<GlobalPortalPolicy>(DEFAULT_POLICY);
  const [globalRoutes, setGlobalRoutes] =
    React.useState<GlobalRoutes>(newGlobalRoutes);
  const [loading, setLoading] = React.useState(true);

  // Keep the latest translator in a ref so the memoized callbacks below do not
  // need `t` in their dependency arrays (which would refetch on a language
  // switch); the toast text is still resolved with the current language.
  const { t } = useT();
  const tRef = React.useRef(t);
  React.useEffect(() => {
    tRef.current = t;
  }, [t]);

  const reload = React.useCallback(async () => {
    try {
      const [
        overviewResult,
        userResult,
        requestResult,
        nodeResult,
        keyResult,
        ruleResult,
        auditResult,
        policyResult,
        globalRouteResult,
      ] = await Promise.all([
        apiRequest<Overview>("/api/admin/overview"),
        apiRequest<AdminUser[]>("/api/admin/users"),
        apiRequest<QuotaRequest[]>("/api/admin/quota-requests"),
        apiRequest<AdminNode[]>("/api/admin/nodes"),
        apiRequest<AdminKey[]>("/api/admin/keys"),
        apiRequest<RuleVersion[]>("/api/admin/rules"),
        apiRequest<AuditEvent[]>("/api/admin/audit"),
        apiRequest<GlobalPortalPolicy[]>("/api/admin/portal-policy"),
        apiRequest<GlobalRoutes[]>("/api/admin/global-routes"),
      ]);
      setOverview(overviewResult);
      setUsers(userResult);
      setRequests(requestResult);
      setNodes(nodeResult);
      setKeys(keyResult);
      setRules(ruleResult);
      setAudit(auditResult);
      setPolicy(policyResult?.[0] ?? DEFAULT_POLICY);
      setGlobalRoutes(globalRouteResult?.[0] ?? newGlobalRoutes());
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : tRef.current("common.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const action = React.useCallback<AdminData["action"]>(
    async (resource, id, actionName, payload = {}) => {
      try {
        await apiRequest(`/api/admin/${resource}/${id}/${actionName}`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast.success(tRef.current("adminData.actionDone"));
        await reload();
        return true;
      } catch (cause) {
        toast.error(
          cause instanceof Error
            ? cause.message
            : tRef.current("adminData.actionFailed"),
        );
        return false;
      }
    },
    [reload],
  );

  const value = React.useMemo<AdminData>(
    () => ({
      overview,
      users,
      requests,
      nodes,
      keys,
      rules,
      audit,
      policy,
      globalRoutes,
      loading,
      reload,
      action,
      request: apiRequest,
    }),
    [
      overview,
      users,
      requests,
      nodes,
      keys,
      rules,
      audit,
      policy,
      globalRoutes,
      loading,
      reload,
      action,
    ],
  );

  return (
    <AdminDataContext.Provider value={value}>
      {children}
    </AdminDataContext.Provider>
  );
}

export function useAdminData(): AdminData {
  const ctx = React.useContext(AdminDataContext);
  if (!ctx) {
    throw new Error("useAdminData must be used within AdminDataProvider");
  }
  return ctx;
}
