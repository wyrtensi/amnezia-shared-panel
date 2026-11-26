"use client";

import * as React from "react";
import Link from "next/link";
import { Server } from "lucide-react";
import { toast } from "sonner";
import type { AdminKey, AdminNode } from "@/components/admin/admin-data";
import {
  DeleteNodeDialog,
  EditNodeDialog,
  NO_KEYS,
  NodeCard,
  SetCapacityDialog,
  UpdateAgentDialog,
  computeNodeKeyStats,
} from "@/components/admin/node-card-suite";
import type { NodeTopologyFocus } from "@/components/admin/node-topology-dialog";
import type { BridgeInfra } from "@/components/admin/use-bridge-infra";
import type { useReachability } from "@/components/admin/use-reachability";
import type { useServiceChecks } from "@/components/admin/use-service-checks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setNodeEndpoint, type Requester } from "@/lib/bridge-api";
import {
  NODES_PATH,
  describeBridgeError,
  nodeCardAnchor,
} from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";

export type NodeDetailDialogProps = {
  node: AdminNode | null;
  onClose: () => void;
  keys: readonly AdminKey[];
  infra: BridgeInfra;
  serviceChecks: ReturnType<typeof useServiceChecks>;
  reachability: ReturnType<typeof useReachability>;
  action: (
    resource: string,
    id: string,
    actionName: string,
    payload?: unknown,
  ) => Promise<boolean>;
  request: Requester;
  reload: () => Promise<void>;
  onOpenTopology?: (nodeId: string, focus?: NodeTopologyFocus | null) => void;
  onOpenBridge?: (bridgeId: string) => void;
};

/**
 * Contextual node detail modal for the Overview topology map and node cards.
 * Embeds the full `NodeCard` suite and its edit/agent/capacity/delete dialogs.
 */
export function NodeDetailDialog({
  node,
  onClose,
  keys,
  infra,
  serviceChecks,
  reachability,
  action,
  request,
  reload,
  onOpenTopology,
  onOpenBridge,
}: NodeDetailDialogProps) {
  const { t } = useT();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [updateAgentOpen, setUpdateAgentOpen] = React.useState(false);
  const [capacityOpen, setCapacityOpen] = React.useState(false);

  React.useEffect(() => {
    if (!node) {
      setEditOpen(false);
      setDeleteOpen(false);
      setUpdateAgentOpen(false);
      setCapacityOpen(false);
    }
  }, [node]);

  const keyStats = React.useMemo(() => {
    if (!node) return NO_KEYS;
    return computeNodeKeyStats(keys).get(node.id) ?? NO_KEYS;
  }, [keys, node]);

  if (!node) return null;

  const hasSubDialog = editOpen || deleteOpen || updateAgentOpen || capacityOpen;
  const statusLabel = node.lastError
    ? t("nodes.commError")
    : node.enabled
      ? t("nodes.working")
      : t("nodes.stopped");

  const handleDeleteReload = async () => {
    await reload();
    onClose();
  };

  return (
    <>
      <Dialog
        open={Boolean(node)}
        onOpenChange={(next) => {
          if (!next && !hasSubDialog) onClose();
        }}
      >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
          onInteractOutside={(e) => {
            if (hasSubDialog) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (hasSubDialog) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-center gap-2 pr-6">
              <Server aria-hidden className="size-4 shrink-0 text-primary" />
              <span className="truncate">{node.publicName || node.name}</span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className={node.lastError ? "truncate text-destructive" : "truncate"}>
                {statusLabel}
                {node.agentVersion ? ` · v${node.agentVersion}` : null}
              </span>
              <Link
                href={`${NODES_PATH}#${nodeCardAnchor(node.id)}`}
                prefetch={false}
                className="inline-flex shrink-0 items-center gap-1 text-primary underline-offset-2 hover:underline"
              >
                {t("ov.map.openNode")}
              </Link>
            </DialogDescription>
          </DialogHeader>

          <NodeDetailDialogBody
            node={node}
            keyStats={keyStats}
            infra={infra}
            serviceChecks={serviceChecks}
            reachability={reachability}
            action={action}
            request={request}
            reload={reload}
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleteOpen(true)}
            onUpdateAgent={() => setUpdateAgentOpen(true)}
            onSetCapacity={() => setCapacityOpen(true)}
            onOpenTopology={() => onOpenTopology?.(node.id, null)}
            onOpenBridge={onOpenBridge}
          />
        </DialogContent>
      </Dialog>

      <EditNodeDialog
        node={editOpen ? node : null}
        onClose={() => setEditOpen(false)}
        request={request}
        reload={reload}
      />
      <UpdateAgentDialog
        node={updateAgentOpen ? node : null}
        onClose={() => setUpdateAgentOpen(false)}
        request={request}
        reload={reload}
      />
      <SetCapacityDialog
        node={capacityOpen ? node : null}
        onClose={() => setCapacityOpen(false)}
        request={request}
        reload={reload}
      />
      <DeleteNodeDialog
        node={deleteOpen ? node : null}
        keyStats={keyStats}
        onClose={() => setDeleteOpen(false)}
        request={request}
        reload={handleDeleteReload}
      />
    </>
  );
}

/** Inner embedded node card wiring, exported separately for SSR unit tests. */
export function NodeDetailDialogBody({
  node,
  keyStats,
  infra,
  serviceChecks,
  reachability,
  action,
  request,
  reload,
  onEdit,
  onDelete,
  onUpdateAgent,
  onSetCapacity,
  onOpenTopology,
  onOpenBridge,
}: {
  node: AdminNode;
  keyStats: ReturnType<typeof computeNodeKeyStats> extends Map<string, infer V>
    ? V
    : never;
  infra: BridgeInfra;
  serviceChecks: ReturnType<typeof useServiceChecks>;
  reachability: ReturnType<typeof useReachability>;
  action: NodeDetailDialogProps["action"];
  request: Requester;
  reload: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
  onUpdateAgent: () => void;
  onSetCapacity: () => void;
  onOpenTopology: () => void;
  onOpenBridge?: (bridgeId: string) => void;
}) {
  const { t } = useT();

  const setNodeChecks = async (patch: {
    checksEnabled?: boolean;
    disabledCheckIds?: string[];
  }) => {
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

  const switchNodeDirect = async (revision: number) => {
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

  const toggleEnabled = async (enabled: boolean) => {
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

  const toggleIpv6Stub = async (enabled: boolean) => {
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

  return (
    <NodeCard
      embedded
      node={node}
      keyStats={keyStats}
      onToggle={(enabled) => void toggleEnabled(enabled)}
      onReconcile={() => void action("nodes", node.id, "reconcile")}
      onEdit={onEdit}
      onDelete={onDelete}
      onUpdateAgent={onUpdateAgent}
      onSetCapacity={onSetCapacity}
      onOpenTopology={onOpenTopology}
      onOpenBridge={onOpenBridge}
      onSwitchDirect={
        infra.loading || infra.failed || !infra.routeByNode.get(node.id)
          ? undefined
          : (revision) => void switchNodeDirect(revision)
      }
      route={
        infra.loading || infra.failed
          ? undefined
          : (infra.routeByNode.get(node.id) ?? null)
      }
      routeLoadFailed={infra.failed}
      checkResults={serviceChecks.byNode.get(node.id) ?? []}
      checksConfigured={serviceChecks.checks.length > 0}
      onSetChecks={(patch) => void setNodeChecks(patch)}
      onToggleIpv6Stub={(enabled) => void toggleIpv6Stub(enabled)}
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
  );
}
