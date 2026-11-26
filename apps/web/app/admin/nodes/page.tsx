"use client";

import * as React from "react";
import { ArrowDown, Cable, Plus, Server } from "lucide-react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { BridgesSection } from "@/components/admin/bridges-tab";
import {
  CreateNodeDialog,
  DeleteNodeDialog,
  EditNodeDialog,
  NO_KEYS,
  NodeCard,
  SetCapacityDialog,
  UpdateAgentDialog,
  computeNodeKeyStats,
} from "@/components/admin/node-card-suite";
import { useBridgeInfra } from "@/components/admin/use-bridge-infra";
import {
  BRIDGES_ANCHOR,
  VPN_NODES_ANCHOR,
  describeBridgeError,
} from "@/lib/bridge-ui";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/ui/hint";
import { setNodeEndpoint } from "@/lib/bridge-api";
import {
  NodeTopologyDialog,
  summarizeNodeEgress,
} from "@/components/admin/node-topology-dialog";
import { ServiceChecksCard } from "@/components/admin/service-checks-card";
import { useServiceChecks } from "@/components/admin/use-service-checks";
import { ReachabilityCard } from "@/components/admin/reachability-card";
import { useReachability } from "@/components/admin/use-reachability";
import { useAdminData, type AdminNode } from "@/components/admin/admin-data";
import { useT } from "@/lib/i18n/provider";

export default function AdminNodesPage() {
  // `useSearchParams` needs a Suspense boundary for the static prerender.
  return (
    <Suspense fallback={null}>
      <AdminNodesView />
    </Suspense>
  );
}

function AdminNodesView() {
  const { nodes, keys, loading, reload, action, request } = useAdminData();
  const legacyBridgeLink = useSearchParams().get("tab") === "bridges";
  const infra = useBridgeInfra();
  // One fetch for the whole page: the card below lists checks by check, the
  // node cards show the same results by node. Two fetches could disagree.
  const serviceChecks = useServiceChecks();
  const reachability = useReachability();
  const [bridgeReachabilityBusy, setBridgeReachabilityBusy] =
    React.useState(false);
  const { t } = useT();
  const [showCreate, setShowCreate] = React.useState(false);
  const [editNode, setEditNode] = React.useState<AdminNode | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminNode | null>(
    null,
  );
  const [updateAgentNode, setUpdateAgentNode] =
    React.useState<AdminNode | null>(null);
  const [capacityNode, setCapacityNode] = React.useState<AdminNode | null>(
    null,
  );
  const [topologyNodeId, setTopologyNodeId] = React.useState<string | null>(
    null,
  );
  const topologyNode =
    nodes.find((node) => node.id === topologyNodeId) ?? null;

  React.useEffect(() => {
    if (legacyBridgeLink && !window.location.hash) {
      document.getElementById(BRIDGES_ANCHOR)?.focus();
    }
  }, [legacyBridgeLink]);

  const keyStats = React.useMemo(() => computeNodeKeyStats(keys), [keys]);

  const statsFor = (nodeId: string) => keyStats.get(nodeId) ?? NO_KEYS;

  /**
   * Change which service checks this node runs.
   *
   * Sends only the field that changed, and reloads BOTH the nodes and the
   * checks: the two views show the same data from different ends, and leaving
   * one stale is how a switch appears not to have worked.
   */
  const setNodeChecks = async (
    node: AdminNode,
    patch: { checksEnabled?: boolean; disabledCheckIds?: string[] },
  ) => {
    try {
      await request(`/api/admin/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await Promise.all([reload(), serviceChecks.reload()]);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("nodes.changeFailed"),
      );
    }
  };

  /**
   * Include or exclude a node from the external probe. Reloads both the nodes
   * and the probe view, for the same reason as `setNodeChecks`. Errors reach
   * the card, which owns the toast.
   */
  const setNodeReachability = async (nodeId: string, enabled: boolean) => {
    await request(`/api/admin/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ reachabilityEnabled: enabled }),
    });
    await Promise.all([reload(), reachability.reload()]);
  };

  const setEndpointReachability = async (
    nodeId: string,
    endpointId: string,
    enabled: boolean,
  ) => {
    await request(`/api/admin/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({
        publicEndpoint: {
          action: "update",
          id: endpointId,
          reachabilityEnabled: enabled,
        },
      }),
    });
    await Promise.all([reload(), reachability.reload()]);
  };

  const setBridgeReachability = async (bridgeId: string, enabled: boolean) => {
    setBridgeReachabilityBusy(true);
    try {
      await request(`/api/admin/vpn-bridges/${encodeURIComponent(bridgeId)}`, {
        method: "PATCH",
        body: JSON.stringify({ reachabilityEnabled: enabled }),
      });
      await Promise.all([infra.reload(), reachability.reload()]);
    } catch {
      toast.error(t("reachability.actionFailed"));
    } finally {
      setBridgeReachabilityBusy(false);
    }
  };

  const switchNodeDirect = async (node: AdminNode, revision: number) => {
    if (
      !window.confirm(
        t("nodes.bridgeDirectConfirm", { name: node.publicName || node.name }),
      )
    ) {
      return;
    }
    try {
      await setNodeEndpoint(request, node.id, null, revision);
      toast.success(t("bridge.switchedDirect"));
      await Promise.all([reload(), infra.reload()]);
    } catch (cause) {
      toast.error(describeBridgeError(cause, t).message);
    }
  };

  const toggleEnabled = async (node: AdminNode, enabled: boolean) => {
    try {
      await request(`/api/admin/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? t("nodes.enabled") : t("nodes.disabled"));
      await reload();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("nodes.changeFailed"),
      );
    }
  };

  const toggleIpv6Stub = async (node: AdminNode, enabled: boolean) => {
    try {
      await request(`/api/admin/nodes/${node.id}/ipv6-reject-stub`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      toast.success(
        enabled
          ? t("nodes.ipv6Stub.enabledToast")
          : t("nodes.ipv6Stub.disabledToast"),
      );
      await reload();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("nodes.changeFailed"),
      );
    }
  };

  const reachNodes = reachability?.view?.nodes ?? [];
  const diagHealthy = nodes.filter(
    (node) => node.enabled && !node.lastError,
  ).length;
  const diagErrors = nodes.length - diagHealthy;
  const diagIncidents = reachNodes.filter(
    (rn) =>
      rn.incidentOpen ||
      (rn.publicEndpoints ?? []).some(
        (ep) => ep.incidentOpen || ep.probeEgressMatch === false,
      ),
  ).length;
  const diagPreAlert = reachNodes.reduce(
    (sum, rn) =>
      sum +
      (rn.publicEndpoints ?? []).filter(
        (ep) => !ep.incidentOpen && (ep.probeConsecutiveFailures ?? 0) > 0,
      ).length,
    0,
  );
  const diagEgress = nodes.filter(
    (node) => summarizeNodeEgress(node).hasIssue,
  ).length;

  return (
    <div className="@container space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {t("nav.nodes")}
        <Hint>{t("nodes.titleHint")}</Hint>
      </h2>

      {nodes.length > 0 ? (
        <div
          data-testid="nodes-diagnostic-header"
          className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 py-2 text-xs"
        >
          <Badge variant={diagHealthy === nodes.length ? "success" : "warning"}>
            {t("nodes.diag.healthy", { ok: diagHealthy, total: nodes.length })}
          </Badge>
          <Badge variant={diagErrors > 0 ? "destructive" : "outline"}>
            {t("nodes.diag.errors", { count: diagErrors })}
          </Badge>
          <Badge variant={diagIncidents > 0 ? "destructive" : "outline"}>
            {t("nodes.diag.incidents", { count: diagIncidents })}
          </Badge>
          <Badge variant={diagPreAlert > 0 ? "warning" : "outline"}>
            {t("nodes.diag.preAlert", { count: diagPreAlert })}
          </Badge>
          <Badge variant={diagEgress > 0 ? "destructive" : "outline"}>
            {t("nodes.diag.egressIssues", { count: diagEgress })}
          </Badge>
        </div>
      ) : null}

      <nav aria-label={t("nav.nodes")} className="grid grid-cols-2 gap-2">
        <SectionLink
          anchor={VPN_NODES_ANCHOR}
          icon={Server}
          label={t("nodes.section")}
        >
          {loading && nodes.length === 0
            ? t("bridge.loading")
            : t("nodes.summary", {
                total: nodes.length,
                enabled: nodes.filter((node) => node.enabled).length,
              })}
        </SectionLink>
        <SectionLink
          anchor={BRIDGES_ANCHOR}
          icon={Cable}
          label={t("bridge.title")}
        >
          {infra.failed
            ? t("bridge.routeUnknown")
            : infra.loading
              ? t("bridge.loading")
              : t("bridge.summary", {
                  total: infra.bridges.length,
                  online: infra.bridges.filter(
                    (bridge) => bridge.managementStatus === "ok",
                  ).length,
                })}
        </SectionLink>
      </nav>

      <div className="space-y-6">
        <section
          id={VPN_NODES_ANCHOR}
          aria-labelledby="vpn-nodes-title"
          tabIndex={-1}
          className="min-w-0 scroll-mt-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="vpn-nodes-title" className="text-base font-semibold">
              {t("nodes.section")}
            </h3>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus /> {t("nodes.addNode")}
            </Button>
          </div>
          {loading && nodes.length === 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-56 rounded-xl" />
              ))}
            </div>
          ) : nodes.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="space-y-1 p-4 text-sm">
                <p className="font-medium">{t("nodes.empty")}</p>
                <p className="text-muted-foreground">{t("nodes.emptyHint")}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {nodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  keyStats={statsFor(node.id)}
                  onToggle={(enabled) => void toggleEnabled(node, enabled)}
                  onReconcile={() => void action("nodes", node.id, "reconcile")}
                  onEdit={() => setEditNode(node)}
                  onDelete={() => setDeleteTarget(node)}
                  onUpdateAgent={() => setUpdateAgentNode(node)}
                  onSetCapacity={() => setCapacityNode(node)}
                  onOpenTopology={() => setTopologyNodeId(node.id)}
                  onSwitchDirect={
                    infra.loading ||
                    infra.failed ||
                    !infra.routeByNode.get(node.id)
                      ? undefined
                      : (revision) => void switchNodeDirect(node, revision)
                  }
                  route={
                    infra.loading || infra.failed
                      ? undefined
                      : (infra.routeByNode.get(node.id) ?? null)
                  }
                  routeLoadFailed={infra.failed}
                  checkResults={serviceChecks.byNode.get(node.id) ?? []}
                  checksConfigured={serviceChecks.checks.length > 0}
                  onSetChecks={(patch) => void setNodeChecks(node, patch)}
                  onToggleIpv6Stub={(enabled) =>
                    void toggleIpv6Stub(node, enabled)
                  }
                  onSaveGenerator={async (endpointId, awgGenerator, awgMtu) => {
                    await request(`/api/admin/nodes/${node.id}`, {
                      method: "PATCH",
                      body: JSON.stringify(
                        endpointId
                          ? {
                              publicEndpoint: {
                                action: "update",
                                id: endpointId,
                                awgGenerator,
                                awgMtu,
                              },
                            }
                          : { awgGenerator, awgMtu },
                      ),
                    });
                    await reload();
                  }}
                  onSaveDeviceRules={async (endpointId, awgDeviceRules) => {
                    await request(`/api/admin/nodes/${node.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({
                        publicEndpoint: {
                          action: "update",
                          id: endpointId,
                          awgDeviceRules,
                        },
                      }),
                    });
                    await reload();
                  }}
                  onSavePublicEndpoint={async (publicEndpoint) => {
                    await request(`/api/admin/nodes/${node.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ publicEndpoint }),
                    });
                    await Promise.all([reload(), reachability.reload()]);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <BridgesSection
          infra={infra}
          reachabilityBusy={bridgeReachabilityBusy}
          onSetReachability={setBridgeReachability}
        />
      </div>

      <ServiceChecksCard state={serviceChecks} />
      <ReachabilityCard
        state={reachability}
        onSetNodeEnabled={setNodeReachability}
        onSetEndpointEnabled={setEndpointReachability}
        bridgeToggleBusy={bridgeReachabilityBusy}
        onSetBridgeEnabled={setBridgeReachability}
      />

      <CreateNodeDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        request={request}
        reload={reload}
      />
      <EditNodeDialog
        node={editNode}
        onClose={() => setEditNode(null)}
        request={request}
        reload={reload}
      />
      <UpdateAgentDialog
        node={updateAgentNode}
        onClose={() => setUpdateAgentNode(null)}
        request={request}
        reload={reload}
      />
      <SetCapacityDialog
        node={capacityNode}
        onClose={() => setCapacityNode(null)}
        request={request}
        reload={reload}
      />
      <DeleteNodeDialog
        node={deleteTarget}
        keyStats={deleteTarget ? statsFor(deleteTarget.id) : NO_KEYS}
        onClose={() => setDeleteTarget(null)}
        request={request}
        reload={reload}
      />
      <NodeTopologyDialog
        node={topologyNode}
        onClose={() => setTopologyNodeId(null)}
        request={request}
        reload={reload}
        onSavePublicEndpoint={async (nodeId, publicEndpoint) => {
          await request(`/api/admin/nodes/${nodeId}`, {
            method: "PATCH",
            body: JSON.stringify({ publicEndpoint }),
          });
          await Promise.all([reload(), reachability.reload()]);
        }}
      />
    </div>
  );
}

function SectionLink({
  anchor,
  icon: Icon,
  label,
  children,
}: {
  anchor: string;
  icon: typeof Server;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`#${anchor}`}
      className="flex min-w-0 items-start gap-2 rounded-lg border bg-card px-2.5 py-2 text-card-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:px-3"
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{children}</span>
      </span>
      <ArrowDown
        aria-hidden
        className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
      />
    </a>
  );
}
