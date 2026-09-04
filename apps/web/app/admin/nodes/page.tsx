"use client";

import * as React from "react";
import {
  Activity,
  ArrowUpDown,
  Boxes,
  Download,
  Gauge,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Callout, Hint } from "@/components/ui/hint";
import { ProtocolSelect } from "@/components/protocol-select";
import { formatDateTime } from "@/lib/format";
import { InlineTraffic } from "@/components/inline-traffic";
import { NodeMetrics } from "@/components/admin/node-metrics";
import { ServiceChecksCard } from "@/components/admin/service-checks-card";
import { useServiceChecks } from "@/components/admin/use-service-checks";
import { cn } from "@/lib/utils";
import { useAdminData, type AdminNode } from "@/components/admin/admin-data";
import { useT } from "@/lib/i18n/provider";
import type { ProtocolKind } from "@/lib/types";
import { isIpLiteral } from "@amnezia/contracts";

const preferredProtocol = (list: ProtocolKind[]): ProtocolKind =>
  list.includes("awg3") ? "awg3" : (list[0] ?? "awg3");

const PROTOCOL_LABEL: Record<string, string> = {
  awg2: "protocol.awg2",
  awg3: "protocol.awg3",
};

const CAPABILITY_LABEL: Record<string, string> = {
  peerLifecycle: "nodes.cap.peerLifecycle",
  telemetry: "nodes.cap.telemetry",
  backup: "nodes.cap.backup",
};

/** Keys a node still owns, in every state, plus how many users hold them. */
type NodeKeyStats = { total: number; active: number; owners: number };

const NO_KEYS: NodeKeyStats = { total: 0, active: 0, owners: 0 };

/** What `DELETE /api/admin/nodes/:id` reports back. */
type DeleteNodeResult = {
  id: string;
  deleted: boolean;
  deletedKeys: number;
  affectedOwners: number;
  droppedJobs: number;
  cancelledQuotaRequests: number;
};

export default function AdminNodesPage() {
  const { nodes, keys, loading, reload, action, request } = useAdminData();
  // One fetch for the whole page: the card below lists checks by check, the
  // node cards show the same results by node. Two fetches could disagree.
  const serviceChecks = useServiceChecks();
  const { t } = useT();
  const [showCreate, setShowCreate] = React.useState(false);
  const [editNode, setEditNode] = React.useState<AdminNode | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminNode | null>(null);
  const [updateAgentNode, setUpdateAgentNode] = React.useState<AdminNode | null>(
    null,
  );

  // Count keys per node in EVERY state, not just the active ones: revoked keys
  // still reference the node and still block (or get destroyed by) a deletion.
  const keyStats = React.useMemo(() => {
    const owners = new Map<string, Set<string>>();
    const stats = new Map<string, NodeKeyStats>();
    for (const key of keys) {
      const entry = stats.get(key.nodeId) ?? { total: 0, active: 0, owners: 0 };
      entry.total += 1;
      if (key.state === "active") entry.active += 1;
      stats.set(key.nodeId, entry);
      const seen = owners.get(key.nodeId) ?? new Set<string>();
      seen.add(key.ownerId);
      owners.set(key.nodeId, seen);
    }
    for (const [nodeId, entry] of stats) {
      entry.owners = owners.get(nodeId)?.size ?? 0;
    }
    return stats;
  }, [keys]);

  const statsFor = (nodeId: string) => keyStats.get(nodeId) ?? NO_KEYS;

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Server className="h-5 w-5 text-primary" />
            {t("nav.nodes")}
            <Hint>{t("nodes.titleHint")}</Hint>
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("nodes.summary", {
              total: nodes.length,
              enabled: nodes.filter((node) => node.enabled).length,
            })}
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> {t("nodes.addNode")}
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
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Server className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold">{t("nodes.empty")}</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("nodes.emptyHint")}
            </p>
            <Button className="mt-2" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" /> {t("nodes.addNode")}
            </Button>
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
              checkResults={serviceChecks.byNode.get(node.id) ?? []}
              checksConfigured={serviceChecks.checks.length > 0}
            />
          ))}
        </div>
      )}

      {/* Under the fleet rather than on its own page: a check is a statement
          about what works FROM these servers, and reading it beside them is
          what makes a red chip actionable. */}
      <ServiceChecksCard state={serviceChecks} />

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
      <DeleteNodeDialog
        node={deleteTarget}
        keyStats={deleteTarget ? statsFor(deleteTarget.id) : NO_KEYS}
        onClose={() => setDeleteTarget(null)}
        request={request}
        reload={reload}
      />
    </div>
  );
}

function NodeCard({
  node,
  keyStats,
  onToggle,
  onReconcile,
  onEdit,
  onDelete,
  onUpdateAgent,
  checkResults,
  checksConfigured,
}: {
  node: AdminNode;
  keyStats: NodeKeyStats;
  /** This node's verdict for each service check. Empty until it has run one. */
  checkResults: Array<{ name: string; status: string; detail: string | null }>;
  /** Whether any check exists at all, which is a different thing from none run. */
  checksConfigured: boolean;
  onToggle: (enabled: boolean) => void;
  onReconcile: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onUpdateAgent: () => void;
}) {
  const { t, lang } = useT();
  const peers = node.peerCount ?? 0;
  const fill = Math.min(100, (peers / Math.max(1, node.maxPeers)) * 100);
  const supported = node.supportedProtocols?.length
    ? node.supportedProtocols
    : [node.protocol as ProtocolKind];
  const enabled = node.enabledProtocols?.length
    ? node.enabledProtocols
    : supported;
  // The node-agent declares many internal capability flags; surface only the
  // few operator-meaningful ones as chips instead of dumping all of them.
  const capabilities = Object.entries(node.capabilities ?? {})
    .filter(([key, value]) => Boolean(value) && key in CAPABILITY_LABEL)
    .map(([key]) => CAPABILITY_LABEL[key] ?? key);

  return (
    <Card className={cn("overflow-hidden", !node.enabled && "opacity-80")}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                node.lastError
                  ? "bg-destructive/12 text-destructive"
                  : node.enabled
                    ? "bg-success/15 text-success"
                    : "bg-muted text-muted-foreground",
              )}
            >
              <Server className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium leading-tight">{node.name}</p>
              {node.publicName ? (
                <p className="truncate text-xs text-muted-foreground">
                  {t("nodes.seenAs", { name: node.publicName })}
                </p>
              ) : null}
              <p className="truncate text-xs text-muted-foreground">
                {node.lastError ? (
                  <span className="text-destructive">{t("nodes.commError")}</span>
                ) : node.enabled ? (
                  t("nodes.working")
                ) : (
                  t("nodes.stopped")
                )}
              </p>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Switch
                  checked={node.enabled}
                  onCheckedChange={onToggle}
                  aria-label={node.enabled ? t("nodes.toggleOff") : t("nodes.toggleOn")}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {node.enabled ? t("nodes.toggleOffTip") : t("nodes.toggleOnTip")}
            </TooltipContent>
          </Tooltip>
        </div>

        <code className="truncate rounded bg-muted px-2 py-1 text-xs">
          {node.apiBaseUrl}
        </code>

        <div className="flex flex-wrap gap-1">
          {supported.map((protocol) => {
            const on = enabled.includes(protocol);
            const protoKey = PROTOCOL_LABEL[protocol];
            return (
              <Badge
                key={protocol}
                variant={on ? "success" : "outline"}
                className={on ? undefined : "opacity-60"}
                title={on ? t("nodes.protoActive") : t("nodes.protoSupported")}
              >
                {protoKey ? t(protoKey) : protocol.toUpperCase()}
              </Badge>
            );
          })}
          {capabilities.map((capability) => (
            <Badge key={capability} variant="secondary" className="gap-1">
              {t(capability)}
            </Badge>
          ))}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Gauge className="h-3.5 w-3.5" /> {t("nodes.capacity")}
            </span>
            <span className="tabular font-medium">
              {peers} / {node.maxPeers}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                fill >= 90
                  ? "bg-destructive"
                  : fill >= 70
                    ? "bg-warning"
                    : "bg-success",
              )}
              style={{ width: `${fill}%` }}
            />
          </div>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ArrowUpDown className="h-3.5 w-3.5" />
            {t("nodes.traffic")}
          </span>
          <InlineTraffic
            today={node.traffic?.today}
            week={node.traffic?.week}
            month={node.traffic?.month}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Activity className="h-3.5 w-3.5" />
            <span>{t("nodes.healthCheck")}</span>
          </div>
          <div className="text-right text-foreground">
            {formatDateTime(node.lastHealthAt, lang)}
          </div>
          <div className="flex items-center gap-1">
            <Boxes className="h-3.5 w-3.5" />
            <span>{t("nodes.sync")}</span>
          </div>
          <div className="text-right text-foreground">
            {formatDateTime(node.lastSyncAt, lang)}
          </div>
          <div className="flex items-center gap-1">
            <Globe className="h-3.5 w-3.5" />
            <span>{t("nodes.publicAddress")}</span>
            <Hint>{t("nodes.publicAddressHint")}</Hint>
          </div>
          <div className="min-w-0 text-right text-foreground">
            <NodePublicAddress
              host={node.publicHost}
              ip={node.publicIp}
              resolvedAt={node.publicIpResolvedAt}
            />
          </div>
        </dl>

        <div className="space-y-1 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {t("nodes.metrics.title")}
          </span>
          <NodeMetrics metrics={node.metrics} endpoint={node.endpoint} />
        </div>

        {checksConfigured ? (
          <div className="space-y-1 border-t pt-3">
            <span className="text-xs text-muted-foreground">
              {t("nodes.checks.title")}
            </span>
            {checkResults.length === 0 ? (
              // Nothing has come back FROM THIS NODE yet. Said plainly, because
              // an empty space here reads as "this node has no services" - and
              // the usual cause is an agent too old to serve /checks/run.
              <p className="text-xs text-muted-foreground">
                {t("nodes.checks.none")}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {checkResults.map((result) => (
                  <li
                    key={result.name}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">{result.name}</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {result.detail ? (
                        <span className="min-w-0 truncate text-muted-foreground">
                          {result.detail}
                        </span>
                      ) : null}
                      {/* ok / failed / error, not the user's three words: an
                          admin needs `error` - the node could not look - to
                          stay distinct from `failed`. */}
                      <Badge
                        variant={
                          result.status === "ok"
                            ? "success"
                            : result.status === "failed"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {result.status}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {node.lastError ? (
          <Callout tone="danger" className="text-xs">
            {node.lastError}
          </Callout>
        ) : null}

        <NodeAgentUpdateStatus node={node} />

        <div className="flex items-center gap-1.5 border-t pt-3">
          <Button variant="secondary" size="sm" onClick={onReconcile}>
            <RefreshCw className="h-4 w-4" /> {t("nodes.reconcile")}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="secondary"
                  size="sm"
                  // Disabled while the panel has nothing to offer, and while an
                  // update is in flight: a second request would only queue
                  // behind the first, and the node is busy replacing itself.
                  disabled={
                    !node.availableAgent ||
                    node.agentUpdateState === "requested" ||
                    node.agentUpdateState === "running"
                  }
                  onClick={onUpdateAgent}
                >
                  <Download className="h-4 w-4" /> {t("nodes.agentUpdate")}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {node.availableAgent
                ? t("nodes.agentUpdateTip", {
                    version: node.availableAgent.version,
                  })
                : t("nodes.agentUpdateUnresolved")}
            </TooltipContent>
          </Tooltip>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" /> {t("nodes.edit")}
          </Button>
          <div className="ml-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t("nodes.deleteAria")}
                  onClick={onDelete}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {keyStats.total > 0
                  ? t("nodes.deleteTipKeys", { keys: keyStats.total })
                  : t("nodes.deleteTip")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The value cell of the card's "public address" row: where clients reach the
 * node, plus the IP the panel resolved it to when the host is a DNS name. Three
 * states an operator must not confuse: the agent never told us; it told us and
 * the name resolved; it told us and the name has never resolved.
 */
function NodePublicAddress({
  host,
  ip,
  resolvedAt,
}: {
  host: string | null;
  ip: string | null;
  resolvedAt: string | null;
}) {
  const { t, lang } = useT();
  if (host === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate text-muted-foreground">
            {t("nodes.publicAddressUnknown")}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("nodes.publicAddressUnknownHint")}</TooltipContent>
      </Tooltip>
    );
  }
  // An IP literal is its own answer; repeating it as a resolved address would
  // be noise, and there was no lookup to date-stamp.
  if (isIpLiteral(host)) {
    return <span className="truncate tabular">{host}</span>;
  }
  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5">
      <span className="truncate">{host}</span>
      {ip === null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Badge variant="outline" className="gap-1">
                <TriangleAlert className="h-3 w-3" />
                {t("nodes.publicIpUnresolved")}
              </Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("nodes.publicIpUnresolvedHint")}</TooltipContent>
        </Tooltip>
      ) : (
        // The resolution time lives in the tooltip, not on the row: it says
        // when the panel learned the address, which an operator wants once and
        // never again. There is deliberately no staleness warning — the address
        // is resolved once because a node's public address does not change, so
        // a "this might be old" badge would fire on a condition that cannot
        // happen and would train the operator to ignore badges.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate tabular">{ip}</span>
          </TooltipTrigger>
          <TooltipContent>
            {t("nodes.publicIpResolvedAt", {
              when: formatDateTime(resolvedAt, lang),
            })}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

type NodeFormState = {
  name: string;
  publicName: string;
  apiBaseUrl: string;
  apiKey: string;
  enabledProtocols: ProtocolKind[];
  maxPeers: number;
  enabled: boolean;
};

function CreateNodeDialog({
  open,
  onClose,
  request,
  reload,
}: {
  open: boolean;
  onClose: () => void;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  reload: () => Promise<void>;
}) {
  const { t } = useT();
  const [form, setForm] = React.useState<NodeFormState>(blankNode());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setForm(blankNode());
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await request("/api/admin/nodes", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          publicName: form.publicName || undefined,
          apiBaseUrl: form.apiBaseUrl,
          apiKey: form.apiKey,
          protocol: preferredProtocol(form.enabledProtocols),
          enabledProtocols: form.enabledProtocols,
          maxPeers: form.maxPeers,
          enabled: true,
          capabilities: { peerLifecycle: true, telemetry: true, backup: true },
        }),
      });
      toast.success(t("nodes.added"));
      onClose();
      await reload();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("nodes.addFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("nodes.createTitle")}</DialogTitle>
          <DialogDescription>
            {t("nodes.createDesc")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <NodeFields form={form} setForm={setForm} requireKey />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.adding") : t("common.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditNodeDialog({
  node,
  onClose,
  request,
  reload,
}: {
  node: AdminNode | null;
  onClose: () => void;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  reload: () => Promise<void>;
}) {
  const { t } = useT();
  const [form, setForm] = React.useState<NodeFormState>(blankNode());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (node)
      setForm({
        name: node.name,
        publicName: node.publicName ?? "",
        apiBaseUrl: node.apiBaseUrl,
        apiKey: "",
        enabledProtocols: node.enabledProtocols?.length
          ? node.enabledProtocols
          : (node.supportedProtocols ?? [node.protocol as ProtocolKind]),
        maxPeers: node.maxPeers,
        enabled: node.enabled,
      });
  }, [node]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!node) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        publicName: form.publicName,
        apiBaseUrl: form.apiBaseUrl,
        protocol: preferredProtocol(form.enabledProtocols),
        enabledProtocols: form.enabledProtocols,
        maxPeers: form.maxPeers,
        enabled: form.enabled,
      };
      if (form.apiKey.trim().length >= 32) payload.apiKey = form.apiKey.trim();
      await request(`/api/admin/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      toast.success(t("nodes.updated"));
      onClose();
      await reload();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("nodes.updateFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(node)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("nodes.editTitle")}</DialogTitle>
          <DialogDescription>
            {t("nodes.editDesc")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <NodeFields
            form={form}
            setForm={setForm}
            availableProtocols={node?.supportedProtocols}
          />
          <label className="flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm">
            {t("nodes.enabledToggle")}
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) =>
                setForm({ ...form, enabled: checked })
              }
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Two-step confirmation for an irreversible deletion.
 *
 * A node without keys is a plain "are you sure". A node that still owns keys
 * destroys all of them in the same transaction, so the dialog spells out the
 * counts, warns that the peers survive on a still-running server, and keeps the
 * delete button disabled until the operator retypes the node's internal name.
 */
/**
 * The node's own record of its last agent update. It is a mirror of what the
 * node reports, kept on the row so a failure is still readable long after the
 * job that caused it - which is the whole point: the alternative is an SSH
 * session on the host that just refused to update.
 */
function NodeAgentUpdateStatus({ node }: { node: AdminNode }) {
  const { t, lang } = useT();
  const state = node.agentUpdateState ?? "idle";
  if (state === "idle") return null;

  const tone =
    state === "failed" ? "danger" : state === "succeeded" ? "success" : "info";
  const log = node.agentUpdateLog?.trim() ?? "";

  return (
    <Callout tone={tone} className="space-y-1 text-xs">
      <div className="font-medium">{t(`nodes.agentUpdate.${state}`)}</div>
      {node.agentUpdateImage ? (
        <code className="block truncate text-[11px] opacity-80">
          {node.agentUpdateImage}
        </code>
      ) : null}
      {node.agentUpdateMessage ? <div>{node.agentUpdateMessage}</div> : null}
      {node.agentUpdateAt ? (
        <div className="opacity-70">
          {formatDateTime(node.agentUpdateAt, lang)}
        </div>
      ) : null}
      {log ? (
        <details className="mt-1">
          <summary className="cursor-pointer select-none opacity-80">
            {t("nodes.agentUpdateLog")}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
            {log}
          </pre>
        </details>
      ) : null}
    </Callout>
  );
}

/**
 * The confirm step. It names the node and the exact digest, and that digest is
 * what gets sent: if a newer release lands between this dialog opening and the
 * click, the admin still installs what they were shown.
 */
function UpdateAgentDialog({
  node,
  onClose,
  request,
  reload,
}: {
  node: AdminNode | null;
  onClose: () => void;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  reload: () => Promise<void>;
}) {
  const { t } = useT();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setError(null);
  }, [node]);

  const release = node?.availableAgent ?? null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!node || !release || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request(`/api/admin/nodes/${node.id}/agent-update`, {
        method: "POST",
        body: JSON.stringify({ image: release.image }),
      });
      toast.success(t("nodes.agentUpdateQueued", { name: node.name }));
      onClose();
      await reload();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : t("nodes.agentUpdateFailed");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(node)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("nodes.agentUpdateTitle", { name: node?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{t("nodes.agentUpdateBody")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">
              {t("nodes.agentUpdateRunning")}
            </dt>
            <dd className="min-w-0 truncate font-mono">
              {node?.agentUpdateImage ?? t("nodes.agentUpdateUnknown")}
            </dd>
            <dt className="text-muted-foreground">
              {t("nodes.agentUpdateInstall")}
            </dt>
            <dd className="min-w-0 break-all font-mono">
              {release?.image ?? "—"}
            </dd>
            <dt className="text-muted-foreground">
              {t("nodes.agentUpdateVersion")}
            </dt>
            <dd>{release?.version ?? "—"}</dd>
          </dl>
          <Callout tone="info" className="text-xs">
            {t("nodes.agentUpdateNoDowntime")}
          </Callout>
          {error ? (
            <Callout tone="danger" className="text-xs">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!release || busy}>
              {busy ? t("nodes.agentUpdateBusy") : t("nodes.agentUpdateConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteNodeDialog({
  node,
  keyStats,
  onClose,
  request,
  reload,
}: {
  node: AdminNode | null;
  keyStats: NodeKeyStats;
  onClose: () => void;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  reload: () => Promise<void>;
}) {
  const { t } = useT();
  const [typedName, setTypedName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTypedName("");
    setError(null);
  }, [node]);

  const hasKeys = keyStats.total > 0;
  // The destructive path stays disarmed until the typed name matches exactly.
  const armed = Boolean(node) && (!hasKeys || typedName.trim() === node?.name);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!node || !armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The destructive half is opt-in through the query string; a DELETE with
      // a JSON body is what the API deliberately does not accept.
      const result = await request<DeleteNodeResult>(
        `/api/admin/nodes/${node.id}${hasKeys ? "?deleteKeys=true" : ""}`,
        { method: "DELETE" },
      );
      toast.success(
        result.deletedKeys > 0
          ? t("nodes.deletedWithKeys", {
              name: node.name,
              keys: result.deletedKeys,
              users: result.affectedOwners,
            })
          : t("nodes.deleted"),
      );
      onClose();
      await reload();
    } catch (cause) {
      // Covers 409 NODE_HAS_KEYS, which happens when the loaded key list was
      // stale: keep the dialog open and show exactly what the API said.
      const message =
        cause instanceof Error ? cause.message : t("nodes.deleteFailed");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(node)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("nodes.deleteTitle", { name: node?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {hasKeys
              ? t("nodes.deleteWithKeys")
              : t("nodes.deleteConfirm", { name: node?.name ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          {hasKeys ? (
            <>
              <Callout
                tone="danger"
                icon={<TriangleAlert className="h-4 w-4 text-destructive" />}
                title={t("nodes.deleteImpact", {
                  keys: keyStats.total,
                  users: keyStats.owners,
                })}
              >
                {t("nodes.deleteImpactStates", {
                  active: keyStats.active,
                  other: keyStats.total - keyStats.active,
                })}
              </Callout>
              <Callout tone="warning" title={t("nodes.deletePeersTitle")}>
                {t("nodes.deletePeersBody")}
              </Callout>
              <Field
                label={t("nodes.deleteTypeName")}
                hint={t("nodes.deleteTypeNameHint", { name: node?.name ?? "" })}
              >
                <Input
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                />
              </Field>
            </>
          ) : null}
          {error ? (
            <Callout tone="danger" className="text-xs">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !armed}>
              {busy
                ? t("nodes.deleting")
                : hasKeys
                  ? t("nodes.deleteActionKeys")
                  : t("nodes.deleteAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function blankNode(): NodeFormState {
  return {
    name: "",
    publicName: "",
    apiBaseUrl: "",
    apiKey: "",
    enabledProtocols: ["awg3"],
    maxPeers: 500,
    enabled: true,
  };
}

function NodeFields({
  form,
  setForm,
  requireKey,
  availableProtocols,
}: {
  form: NodeFormState;
  setForm: React.Dispatch<React.SetStateAction<NodeFormState>>;
  requireKey?: boolean;
  availableProtocols?: ProtocolKind[];
}) {
  const { t } = useT();
  return (
    <>
      <Field label={t("nodes.internalName")} hint={t("nodes.internalNameHint")}>
        <Input
          required
          maxLength={120}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </Field>
      <Field label={t("nodes.publicName")} hint={t("nodes.publicNameHint")}>
        <Input
          maxLength={120}
          placeholder={form.name || t("nodes.publicNamePlaceholder")}
          value={form.publicName}
          onChange={(event) =>
            setForm({ ...form, publicName: event.target.value })
          }
        />
      </Field>
      <Field label={t("nodes.agentAddr")} hint={t("nodes.agentHint")}>
        <Input
          required
          type="url"
          placeholder="https://node.example.com:4001"
          value={form.apiBaseUrl}
          onChange={(event) =>
            setForm({ ...form, apiBaseUrl: event.target.value })
          }
        />
      </Field>
      <Field
        label={requireKey ? t("nodes.apiKeyRequired") : t("nodes.apiKeyNew")}
        hint={requireKey ? undefined : t("nodes.apiKeyNewHint")}
      >
        <Input
          required={requireKey}
          type="password"
          minLength={32}
          maxLength={4096}
          autoComplete="new-password"
          value={form.apiKey}
          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("nodes.protocols")}
          hint={t("nodes.protocolsHint")}
        >
          <ProtocolSelect
            value={form.enabledProtocols}
            available={availableProtocols}
            onChange={(next) => setForm({ ...form, enabledProtocols: next })}
          />
        </Field>
        <Field label={t("nodes.peerLimit")}>
          <Input
            required
            type="number"
            min={1}
            max={500}
            value={form.maxPeers}
            onChange={(event) =>
              setForm({ ...form, maxPeers: event.target.valueAsNumber || 1 })
            }
          />
        </Field>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
