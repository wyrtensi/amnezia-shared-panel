"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  BellRing,
  CheckCircle2,
  GitBranch,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  detectExitSubnetProximityWarning,
  type NodeEgressIp,
  type NodeEgressMode,
  type NodePublicEndpointMutation,
  type ProtocolKind,
  type VerifyNodeEgressIpResult,
} from "@amnezia/contracts";
import type { AdminNode } from "@/components/admin/admin-data";
import { metricBytes } from "@/components/admin/node-metrics";
import { PROTOCOLS } from "@/components/protocol-select";
import {
  NotifyKeyUpdateDialog,
  type NotifyKeyUpdateTarget,
} from "@/components/admin/notify-key-update-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Callout, Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  adoptNodeEgressMode,
  clearNodeEgressIpKeyUpdate,
  clearNodeEndpointKeyUpdate,
  createNodeEgressIp,
  deleteNodeEgressIp,
  notifyNodeEgressIpKeyUpdate,
  notifyNodeEndpointKeyUpdate,
  setNodeEgressMode,
  swapNodeEgressIp,
  updateNodeEgressIp,
  verifyNodeEgressIp,
} from "@/lib/egress-api";
import {
  classifyHostIpv4s,
  variantsUsingExit,
  type HostIpRole,
} from "@/lib/host-ip-discovery";
import type { Requester } from "@/lib/bridge-api";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const DEFAULT_EXIT_SENTINEL = "__default__";

export type NodeEgressSummary = {
  mode: NodeEgressMode;
  modeState: NonNullable<AdminNode["egressModeState"]>;
  daemonState: AdminNode["egressDaemonState"] | null;
  modeDrift: boolean;
  activeExitCount: number;
  totalExitCount: number;
  unhealthyExitCount: number;
  hasIssue: boolean;
};

/** Summarize a node's multi-exit state for cards, diagnostic pills, and tests. */
export const summarizeNodeEgress = (node: AdminNode): NodeEgressSummary => {
  const mode = node.egressMode ?? "masquerade";
  const modeState = node.egressModeState ?? "idle";
  const daemonState = node.egressDaemonState ?? null;
  const modeDrift = Boolean(node.modeDrift);
  const exits = (node.egressIps ?? []).filter((ip) => ip.enabled);
  const activeExitCount = exits.filter((ip) => ip.hostState === "active").length;
  const unhealthyExitCount = exits.filter(
    (ip) =>
      ip.hostState === "missing_ip" ||
      ip.hostState === "gateway_error" ||
      ip.hostState === "daemon_offline",
  ).length;
  const hasIssue =
    modeDrift ||
    modeState === "failed" ||
    daemonState === "conflict" ||
    daemonState === "degraded" ||
    unhealthyExitCount > 0;
  return {
    mode,
    modeState,
    daemonState,
    modeDrift,
    activeExitCount,
    totalExitCount: exits.length,
    unhealthyExitCount,
    hasIssue,
  };
};

const HOST_STATE_BADGE: Record<
  NodeEgressIp["hostState"],
  "success" | "warning" | "destructive" | "outline"
> = {
  active: "success",
  pending: "outline",
  missing_ip: "destructive",
  gateway_error: "destructive",
  daemon_offline: "warning",
  disabled: "outline",
};

const HOST_IP_ROLE_BADGE: Record<
  HostIpRole,
  "success" | "secondary" | "warning" | "outline"
> = {
  both: "success",
  entry: "secondary",
  exit: "secondary",
  unassigned: "warning",
};

const EXIT_HEALTH_DOT: Record<NodeEgressIp["hostState"], string> = {
  active: "bg-success",
  pending: "bg-muted-foreground/60",
  missing_ip: "bg-destructive",
  gateway_error: "bg-destructive",
  daemon_offline: "bg-warning",
  disabled: "bg-muted-foreground/40",
};

export type OptionalRoutingTableResult =
  | { ok: true; value: number | null }
  | { ok: false };

/** Parse an optional custom routing table ID in the 200..219 range. */
export const parseOptionalRoutingTableId = (
  raw: string,
): OptionalRoutingTableResult => {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 200 || value > 219) {
    return { ok: false };
  }
  return { ok: true, value };
};

const DNS_PRESETS = [
  { label: "Cloudflare", dns1: "1.1.1.1", dns2: "1.0.0.1" },
  { label: "Google", dns1: "8.8.8.8", dns2: "8.8.4.4" },
  { label: "Quad9", dns1: "9.9.9.9", dns2: "149.112.112.112" },
] as const;

/** Localize subnet proximity warnings emitted by `detectExitSubnetProximityWarning`. */
export const formatSubnetProximityWarning = (
  raw: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string => {
  const sharedMatch = /^Exit IP shares subnet (\S+) with Entry IP (\S+)$/.exec(raw);
  if (sharedMatch) {
    return t("egress.subnetWarningShared", {
      cidr: sharedMatch[1]!,
      entry: sharedMatch[2]!,
    });
  }
  const same24Match = /^Exit IP is in the same \/24 subnet as Entry IP (\S+)$/.exec(raw);
  if (same24Match) {
    return t("egress.subnetWarningSame24", { entry: same24Match[1]! });
  }
  return raw;
};

export type NodeTopologyFocus =
  | { kind: "variant"; id: string }
  | { kind: "exit"; id: string | null };

export type NodeTopologyDialogProps = {
  node: AdminNode | null;
  onClose: () => void;
  request: Requester;
  reload: () => Promise<void>;
  onSavePublicEndpoint: (
    nodeId: string,
    change: NodePublicEndpointMutation,
  ) => Promise<void>;
  initialFocus?: NodeTopologyFocus | null;
};

export function NodeTopologyDialog({
  node,
  onClose,
  request,
  reload,
  onSavePublicEndpoint,
  initialFocus = null,
}: NodeTopologyDialogProps) {
  const { t } = useT();
  const [notifyTarget, setNotifyTarget] =
    React.useState<NotifyKeyUpdateTarget | null>(null);

  React.useEffect(() => {
    setNotifyTarget(null);
  }, [node?.id]);

  if (!node) return null;

  const hasSubDialog = Boolean(notifyTarget);

  return (
    <>
      <Dialog
        open={Boolean(node)}
        onOpenChange={(next) => {
          if (!next && !hasSubDialog) onClose();
        }}
      >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
          onEscapeKeyDown={(event) => {
            if (hasSubDialog) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (hasSubDialog) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-center gap-2 break-words pr-6">
              <GitBranch className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 break-words">
                {t("egress.dialogTitle", { name: node.publicName || node.name })}
              </span>
            </DialogTitle>
            <DialogDescription>{t("egress.dialogDesc")}</DialogDescription>
          </DialogHeader>

          <NodeTopologyDialogBody
            node={node}
            request={request}
            reload={reload}
            onSavePublicEndpoint={onSavePublicEndpoint}
            initialFocus={initialFocus}
            onOpenNotify={setNotifyTarget}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NotifyKeyUpdateDialog
        target={notifyTarget}
        onClose={() => setNotifyTarget(null)}
        onDone={reload}
      />
    </>
  );
}

/** Inner content of `NodeTopologyDialog`, exported separately for SSR unit tests. */
export function NodeTopologyDialogBody({
  node,
  request,
  reload,
  onSavePublicEndpoint,
  initialFocus = null,
  onOpenNotify,
}: {
  node: AdminNode;
  request: Requester;
  reload: () => Promise<void>;
  onSavePublicEndpoint: (
    nodeId: string,
    change: NodePublicEndpointMutation,
  ) => Promise<void>;
  initialFocus?: NodeTopologyFocus | null;
  onOpenNotify?: (target: NotifyKeyUpdateTarget) => void;
}) {
  const { t, lang } = useT();
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [blockSmtp, setBlockSmtp] = React.useState(true);
  const [isolatePrivate, setIsolatePrivate] = React.useState(true);

  const [newExitIp, setNewExitIp] = React.useState("");
  const [newExitLabel, setNewExitLabel] = React.useState("");
  const [newExitIface, setNewExitIface] = React.useState("");
  const [newExitGw, setNewExitGw] = React.useState("");
  const [newExitTable, setNewExitTable] = React.useState("");
  const [newExitDns1, setNewExitDns1] = React.useState("1.1.1.1");
  const [newExitDns2, setNewExitDns2] = React.useState("1.0.0.1");
  const [newExitAmneziaDns, setNewExitAmneziaDns] = React.useState(true);
  const [newExitEnforceDns, setNewExitEnforceDns] = React.useState(false);
  const [newExitAllowAsEntry, setNewExitAllowAsEntry] = React.useState(false);

  const [verifyByExitId, setVerifyByExitId] = React.useState<
    Record<string, VerifyNodeEgressIpResult>
  >({});
  const [swapTarget, setSwapTarget] = React.useState<NodeEgressIp | null>(null);
  const [swapIpv4, setSwapIpv4] = React.useState("");
  const [swapIface, setSwapIface] = React.useState("");
  const [swapGw, setSwapGw] = React.useState("");
  const [swapLabel, setSwapLabel] = React.useState("");

  const [editExit, setEditExit] = React.useState<NodeEgressIp | null>(null);
  const [editExitLabel, setEditExitLabel] = React.useState("");
  const [editExitIface, setEditExitIface] = React.useState("");
  const [editExitGw, setEditExitGw] = React.useState("");
  const [editExitTable, setEditExitTable] = React.useState("");
  const [editExitDns1, setEditExitDns1] = React.useState("1.1.1.1");
  const [editExitDns2, setEditExitDns2] = React.useState("");
  const [editExitAmneziaDns, setEditExitAmneziaDns] = React.useState(true);
  const [editExitEnforceDns, setEditExitEnforceDns] = React.useState(false);
  const [editExitAllowAsEntry, setEditExitAllowAsEntry] = React.useState(false);
  const [editExitEnabled, setEditExitEnabled] = React.useState(true);

  const [varAddress, setVarAddress] = React.useState(
    node.publicEndpoints?.[0]?.publicAddress ?? node.publicIp ?? "",
  );
  const [varEntryName, setVarEntryName] = React.useState(
    node.publicEndpoints?.[0]?.entryName || node.publicName || node.name,
  );
  const [varCustomName, setVarCustomName] = React.useState("");
  const [varExitId, setVarExitId] = React.useState<string>(DEFAULT_EXIT_SENTINEL);
  const [varProtocols, setVarProtocols] = React.useState<ProtocolKind[] | null>(null);

  const [editVarId, setEditVarId] = React.useState<string | null>(null);
  const [editVarEntryName, setEditVarEntryName] = React.useState("");
  const [editVarCustomName, setEditVarCustomName] = React.useState("");
  const [editVarExitId, setEditVarExitId] = React.useState<string>(DEFAULT_EXIT_SENTINEL);
  const [editVarRenameGroup, setEditVarRenameGroup] = React.useState(false);
  const [editVarProtocols, setEditVarProtocols] = React.useState<ProtocolKind[] | null>(null);
  const [internalNotifyTarget, setInternalNotifyTarget] =
    React.useState<NotifyKeyUpdateTarget | null>(null);
  const openNotify = onOpenNotify ?? setInternalNotifyTarget;

  React.useEffect(() => {
    setBlockSmtp(node.egressBlockSmtp ?? true);
    setIsolatePrivate(node.egressIsolatePrivate ?? true);
    setVerifyByExitId({});
    setSwapTarget(null);
    setEditExit(null);
    setEditVarId(null);
    setEditVarProtocols(null);
    setNewExitIp("");
    setNewExitLabel("");
    setNewExitIface("");
    setNewExitGw("");
    setNewExitTable("");
    setNewExitDns1("1.1.1.1");
    setNewExitDns2("1.0.0.1");
    setNewExitAmneziaDns(true);
    setNewExitEnforceDns(false);
    setNewExitAllowAsEntry(false);
    setVarAddress(node.publicEndpoints?.[0]?.publicAddress ?? node.publicIp ?? "");
    setVarEntryName(node.publicEndpoints?.[0]?.entryName || node.publicName || node.name);
    setVarCustomName("");
    setVarExitId(DEFAULT_EXIT_SENTINEL);
    setVarProtocols(null);
    setInternalNotifyTarget(null);
  }, [node.id]);

  const focusKind = initialFocus?.kind ?? null;
  const focusId = initialFocus?.id ?? null;

  React.useEffect(() => {
    if (!focusKind) return;
    const root = bodyRef.current;
    if (!root) return;
    const targetKey =
      focusKind === "exit" && focusId === null
        ? null
        : `${focusKind}:${focusId}`;
    const raf = requestAnimationFrame(() => {
      const el = targetKey
        ? Array.from(
            root.querySelectorAll<HTMLElement>("[data-topology-focus]"),
          ).find((candidate) => candidate.dataset.topologyFocus === targetKey)
        : root.querySelector<HTMLElement>('[data-topology-section="exits"]');
      el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [node.id, focusKind, focusId]);

  React.useEffect(() => {
    setBlockSmtp(node.egressBlockSmtp ?? true);
    setIsolatePrivate(node.egressIsolatePrivate ?? true);
  }, [node.egressBlockSmtp, node.egressIsolatePrivate]);

  const summary = summarizeNodeEgress(node);

  React.useEffect(() => {
    if (summary.modeState !== "switching") return;
    const timer = window.setInterval(() => {
      void reload();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [summary.modeState, reload]);
  const exits = node.egressIps ?? [];
  const endpoints = node.publicEndpoints ?? [];
  const entryAddresses = endpoints.map((ep) => ep.publicAddress);
  const classifiedHostIps = classifyHostIpv4s(node);
  const quickPickIps = Array.from(
    new Set([
      ...entryAddresses,
      ...(node.publicIp ? [node.publicIp] : []),
      ...classifiedHostIps.map((addr) => addr.ipv4),
    ]),
  );
  const defaultExitIpv4 =
    exits.find((e) => e.id === node.egressDefaultIpId)?.ipv4 ??
    node.publicIp ??
    "—";
  const observedHostMode = node.hostNetworkReport?.observedMode ?? "masquerade";
  const daemonVersionMismatch = Boolean(
    node.agentVersion &&
      node.egressDaemonVersion &&
      node.agentVersion !== node.egressDaemonVersion,
  );
  const modeSwitchBlockedReason =
    summary.daemonState === "unavailable"
      ? t("egress.switchBlockedUnavailable")
      : summary.mode !== "routed" && node.hostNetworkReport?.tunnelSubnetConflict
        ? t("egress.switchBlockedSubnetConflict")
        : summary.mode !== "routed" && exits.filter((e) => e.enabled).length === 0
          ? t("egress.switchBlockedNoExits")
          : null;
  const filtersDirty =
    blockSmtp !== (node.egressBlockSmtp ?? true) ||
    isolatePrivate !== (node.egressIsolatePrivate ?? true);

  const runAction = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    try {
      await fn();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("nodes.changeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={bodyRef} className="min-w-0 space-y-5">
          {/* Section 1: Mode & Daemon Status */}
          <section className="min-w-0 space-y-2.5 rounded-lg border bg-well p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold">{t("egress.sectionMode")}</span>
                <Hint>{t("egress.modeExplainHint")}</Hint>
                <Badge variant={summary.mode === "routed" ? "default" : "outline"}>
                  {t(`egress.mode.${summary.mode}`)}
                </Badge>
                {summary.modeState !== "idle" ? (
                  <Badge
                    variant={
                      summary.modeState === "failed" ? "destructive" : "warning"
                    }
                  >
                    {t(`egress.modeState.${summary.modeState}`)}
                  </Badge>
                ) : null}
                {summary.daemonState ? (
                  <Badge
                    variant={
                      summary.daemonState === "conflict"
                        ? "destructive"
                        : summary.daemonState === "degraded"
                          ? "warning"
                          : summary.daemonState === "routed_active" ||
                              summary.daemonState === "masquerade_ready"
                            ? "success"
                            : "outline"
                    }
                  >
                    {t(`egress.daemon.${summary.daemonState}`)}
                  </Badge>
                ) : null}
                {node.egressDaemonVersion ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 font-mono text-[11px]",
                      daemonVersionMismatch ? "text-warning" : "text-muted-foreground",
                    )}
                    title={
                      daemonVersionMismatch
                        ? t("nodes.egressDaemonVersionMismatch")
                        : undefined
                    }
                  >
                    v{node.egressDaemonVersion}
                    {daemonVersionMismatch ? (
                      <AlertTriangle className="size-3 shrink-0" />
                    ) : null}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={summary.mode === "routed" ? "outline" : "default"}
                  disabled={
                    busy !== null ||
                    summary.modeState === "switching" ||
                    Boolean(modeSwitchBlockedReason)
                  }
                  onClick={() =>
                    void runAction("mode", async () => {
                      const nextMode = summary.mode === "routed" ? "masquerade" : "routed";
                      await setNodeEgressMode(request, node.id, {
                        mode: nextMode,
                        blockSmtp,
                        isolatePrivate,
                      });
                      toast.success(t("egress.modeQueued"));
                      await reload();
                    })
                  }
                >
                  {summary.mode === "routed"
                    ? t("egress.switchToMasquerade")
                    : t("egress.switchToRouted")}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {summary.mode === "routed"
                ? t("egress.modeSummaryRouted")
                : t("egress.modeSummaryMasquerade")}
            </p>
            {modeSwitchBlockedReason ? (
              <p className="break-words text-xs text-warning">{modeSwitchBlockedReason}</p>
            ) : null}

            {node.modeDrift ? (
              <Callout
                tone="danger"
                icon={<AlertTriangle className="size-4" />}
                className="text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {t("egress.driftAlert", {
                      db: t(`egress.mode.${summary.mode}`),
                      host: t(`egress.mode.${observedHostMode}`),
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction("adopt", async () => {
                        await adoptNodeEgressMode(request, node.id);
                        toast.success(t("egress.modeAdopted"));
                        await reload();
                      })
                    }
                  >
                    {t("egress.adoptHost")}
                  </Button>
                </div>
              </Callout>
            ) : null}

            {node.egressModeMessage && summary.modeState === "failed" ? (
              <p className="break-words text-xs text-destructive">{node.egressModeMessage}</p>
            ) : null}
            {node.egressDaemonDetail &&
            (summary.daemonState === "degraded" ||
              summary.daemonState === "conflict" ||
              summary.daemonState === "unavailable") ? (
              <p className="break-words text-xs text-muted-foreground">
                {node.egressDaemonDetail}
              </p>
            ) : null}

            <div className="space-y-1.5 border-t border-border/60 pt-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={blockSmtp}
                      disabled={busy !== null}
                      onCheckedChange={setBlockSmtp}
                    />
                    <span>{t("egress.blockSmtp")}</span>
                    <Hint>{t("egress.blockSmtpHint")}</Hint>
                  </label>
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={isolatePrivate}
                      disabled={busy !== null}
                      onCheckedChange={setIsolatePrivate}
                    />
                    <span>{t("egress.isolatePrivate")}</span>
                    <Hint>{t("egress.isolatePrivateHint")}</Hint>
                  </label>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={filtersDirty ? "default" : "secondary"}
                  disabled={busy !== null || !filtersDirty}
                  onClick={() =>
                    void runAction("filters", async () => {
                      await request(`/api/admin/nodes/${encodeURIComponent(node.id)}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          egressBlockSmtp: blockSmtp,
                          egressIsolatePrivate: isolatePrivate,
                        }),
                      });
                      toast.success(t("adminData.actionDone"));
                      await reload();
                    })
                  }
                >
                  {t("egress.savePolicy")}
                </Button>
              </div>
              {summary.mode !== "routed" ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("egress.filtersRoutedOnlyHint")}
                </p>
              ) : null}
            </div>
          </section>

          {/* Section 2: Host IPs Onboarding */}
          {classifiedHostIps.length > 0 ? (
            <section className="min-w-0 space-y-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-xs">
              <div className="space-y-0.5">
                <h3 className="text-sm font-semibold">{t("egress.hostIpsTitle")}</h3>
                <p className="text-muted-foreground">{t("egress.hostIpsHint")}</p>
              </div>
              <ul className="space-y-1.5">
                {classifiedHostIps.map((addr) => (
                  <li
                    key={`${addr.interfaceName}:${addr.ipv4}`}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <code className="break-all font-mono font-medium">{addr.cidr || addr.ipv4}</code>
                      <span className="break-all font-mono text-muted-foreground">{addr.interfaceName}</span>
                      {addr.detectedGatewayIpv4 ? (
                        <span className="font-mono text-muted-foreground">
                          {t("egress.detectedGateway", { gw: addr.detectedGatewayIpv4 })}
                        </span>
                      ) : null}
                      {addr.detectedRuleTable != null ? (
                        <span className="font-mono text-muted-foreground">
                          {t("egress.detectedTable", { table: addr.detectedRuleTable })}
                        </span>
                      ) : null}
                      <Badge variant={HOST_IP_ROLE_BADGE[addr.role]}>
                        {t(`egress.hostIpRole.${addr.role}`)}
                      </Badge>
                    </div>
                    {!addr.usedAsEntry || !addr.usedAsExit ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {!addr.usedAsExit ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-6 px-2 text-[11px]"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(`quick-exit:${addr.ipv4}`, async () => {
                                await createNodeEgressIp(request, node.id, {
                                  ipv4: addr.ipv4,
                                  interfaceName: addr.interfaceName,
                                  gatewayIpv4: addr.detectedGatewayIpv4 ?? null,
                                  dnsPrimary: "1.1.1.1",
                                  dnsSecondary: "1.0.0.1",
                                  amneziaDnsDnat: true,
                                  enforceDnsDnat: false,
                                  allowAsEntry: addr.usedAsEntry,
                                  enabled: true,
                                });
                                toast.success(t("adminData.actionDone"));
                                await reload();
                              })
                            }
                          >
                            <Plus className="size-3" /> {t("egress.quickAddExit")}
                          </Button>
                        ) : null}
                        {!addr.usedAsEntry ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-6 px-2 text-[11px]"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(`quick-entry:${addr.ipv4}`, async () => {
                                await onSavePublicEndpoint(node.id, {
                                  action: "add",
                                  address: addr.ipv4,
                                  egressIpId: addr.existingExitId ?? null,
                                });
                                toast.success(t("adminData.actionDone"));
                              })
                            }
                          >
                            <Plus className="size-3" /> {t("egress.quickAddEntry")}
                          </Button>
                        ) : null}
                        {!addr.usedAsEntry && !addr.usedAsExit ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(`quick-both:${addr.ipv4}`, async () => {
                                const created = await createNodeEgressIp(request, node.id, {
                                  ipv4: addr.ipv4,
                                  interfaceName: addr.interfaceName,
                                  gatewayIpv4: addr.detectedGatewayIpv4 ?? null,
                                  dnsPrimary: "1.1.1.1",
                                  dnsSecondary: "1.0.0.1",
                                  amneziaDnsDnat: true,
                                  enforceDnsDnat: false,
                                  allowAsEntry: true,
                                  enabled: true,
                                });
                                try {
                                  await onSavePublicEndpoint(node.id, {
                                    action: "add",
                                    address: addr.ipv4,
                                    egressIpId: created.id,
                                  });
                                  toast.success(t("adminData.actionDone"));
                                } finally {
                                  await reload();
                                }
                              })
                            }
                          >
                            <Plus className="size-3" /> {t("egress.quickAddBoth")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Section 3: Physical Exit IPs */}
          <section data-topology-section="exits" className="min-w-0 space-y-2.5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <span>{t("egress.sectionExits")}</span>
              <Hint>{t("egress.sectionExitsHint")}</Hint>
            </h3>

            {exits.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("egress.noExits")}</p>
            ) : (
              <ul className="space-y-2">
                {exits.map((exit) => {
                  const verifyResult = verifyByExitId[exit.id];
                  const usedVariants = variantsUsingExit(node, exit.id);
                  const isDefault = node.egressDefaultIpId === exit.id;
                  const isFocusedExit =
                    initialFocus?.kind === "exit" && initialFocus.id === exit.id;
                  const proximityWarn =
                    exit.subnetWarning ??
                    detectExitSubnetProximityWarning({
                      exitIpv4: exit.ipv4,
                      observedSubnetCidr: exit.observedSubnetCidr,
                      entryAddresses,
                      allowAsEntry: exit.allowAsEntry,
                    });
                  return (
                    <li
                      key={exit.id}
                      data-topology-focus={`exit:${exit.id}`}
                      data-focused={isFocusedExit ? "true" : undefined}
                      className={cn(
                        "space-y-1.5 rounded-lg border bg-card p-2.5 text-xs transition-shadow",
                        !exit.enabled && "opacity-70",
                        isFocusedExit &&
                          "ring-2 ring-primary/70 border-primary/70 bg-primary/[0.06]",
                      )}
                    >
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <code className="break-all font-mono text-sm font-medium">{exit.ipv4}</code>
                          {exit.label ? (
                            <Badge variant="secondary" className="max-w-full break-words">
                              {exit.label}
                            </Badge>
                          ) : null}
                          {isDefault ? (
                            <Badge variant="outline">{t("egress.defaultExitBadge")}</Badge>
                          ) : null}
                          <Badge variant={HOST_STATE_BADGE[exit.hostState]}>
                            {t(`egress.hostState.${exit.hostState}`)}
                          </Badge>
                          {exit.allowAsEntry ? (
                            <Badge variant="outline">{t("egress.allowAsEntry")}</Badge>
                          ) : null}
                          {exit.keyUpdateNotifiedAt ? (
                            <Badge variant="warning">{t("notifyKeyUpdate.activeBadge")}</Badge>
                          ) : null}
                        </div>

                        <div className="flex flex-wrap items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={busy !== null}
                            title={t("notifyKeyUpdate.button")}
                            onClick={() =>
                              openNotify({
                                title: exit.label ? `${exit.label} (${exit.ipv4})` : exit.ipv4,
                                notifiedAt: exit.keyUpdateNotifiedAt ?? null,
                                note: exit.keyUpdateNotifyNote ?? null,
                                onNotify: (note) =>
                                  notifyNodeEgressIpKeyUpdate(request, node.id, exit.id, note),
                                onClear: () =>
                                  clearNodeEgressIpKeyUpdate(request, node.id, exit.id),
                              })
                            }
                          >
                            <BellRing className="size-3.5" />
                          </Button>
                          {!isDefault && exit.enabled ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={busy !== null}
                              onClick={() =>
                                void runAction(`make-default:${exit.id}`, async () => {
                                  await request(`/api/admin/nodes/${encodeURIComponent(node.id)}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({ egressDefaultIpId: exit.id }),
                                  });
                                  toast.success(t("adminData.actionDone"));
                                  await reload();
                                })
                              }
                            >
                              {t("egress.makeDefault")}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(`verify:${exit.id}`, async () => {
                                const res = await verifyNodeEgressIp(request, node.id, exit.id);
                                setVerifyByExitId((prev) => ({ ...prev, [exit.id]: res }));
                              })
                            }
                          >
                            <ShieldCheck className="size-3.5" /> {t("egress.verifyBtn")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={editExit?.id === exit.id ? "secondary" : "ghost"}
                            className="h-7 px-2 text-xs"
                            disabled={busy !== null}
                            onClick={() => {
                              if (editExit?.id === exit.id) {
                                setEditExit(null);
                                return;
                              }
                              setSwapTarget(null);
                              setEditExit(exit);
                              setEditExitLabel(exit.label ?? "");
                              setEditExitIface(exit.interfaceName ?? "");
                              setEditExitGw(exit.gatewayIpv4 ?? "");
                              setEditExitTable(
                                exit.routingTableId != null ? String(exit.routingTableId) : "",
                              );
                              setEditExitDns1(exit.dnsPrimary);
                              setEditExitDns2(exit.dnsSecondary ?? "");
                              setEditExitAmneziaDns(exit.amneziaDnsDnat);
                              setEditExitEnforceDns(exit.enforceDnsDnat);
                              setEditExitAllowAsEntry(exit.allowAsEntry);
                              setEditExitEnabled(exit.enabled);
                            }}
                          >
                            <Pencil className="size-3.5" /> {t("egress.editBtn")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={swapTarget?.id === exit.id ? "secondary" : "ghost"}
                            className="h-7 px-2 text-xs"
                            disabled={busy !== null}
                            onClick={() => {
                              if (swapTarget?.id === exit.id) {
                                setSwapTarget(null);
                                return;
                              }
                              setEditExit(null);
                              setSwapTarget(exit);
                              setSwapIpv4("");
                              setSwapIface(exit.interfaceName ?? "");
                              setSwapGw(exit.gatewayIpv4 ?? "");
                              setSwapLabel(exit.label ?? "");
                            }}
                          >
                            <ArrowLeftRight className="size-3.5" /> {t("egress.swapBtn")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            disabled={busy !== null || usedVariants.length > 0}
                            title={
                              usedVariants.length > 0
                                ? t("egress.usedInRouteCannotDelete")
                                : undefined
                            }
                            onClick={() => {
                              if (!window.confirm(t("egress.deleteConfirm", { ip: exit.ipv4 }))) {
                                return;
                              }
                              void runAction(`del-exit:${exit.id}`, async () => {
                                await deleteNodeEgressIp(request, node.id, exit.id);
                                toast.success(t("adminData.actionDone"));
                                await reload();
                              });
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>

                      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 break-words text-muted-foreground">
                        {exit.interfaceName ? (
                          <span>{t("egress.metaIface", { value: exit.interfaceName })}</span>
                        ) : null}
                        {exit.gatewayIpv4 || exit.detectedGatewayIpv4 ? (
                          <span>
                            {t("egress.metaGw", {
                              value: exit.gatewayIpv4 ?? exit.detectedGatewayIpv4 ?? "",
                            })}
                          </span>
                        ) : null}
                        {exit.routingTableId != null ? (
                          <span>{t("egress.metaTable", { value: exit.routingTableId })}</span>
                        ) : null}
                        <span>
                          DNS {exit.dnsPrimary}
                          {exit.dnsSecondary ? `, ${exit.dnsSecondary}` : ""}
                        </span>
                        <span>
                          {t("egress.txStat", { bytes: metricBytes(exit.txBytes, lang) })}
                        </span>
                        <span className="break-words">
                          {usedVariants.length > 0
                            ? t("egress.usedByVariants", {
                                names: usedVariants.map((v) => v.name).join(", "),
                              })
                            : t("egress.unusedExit")}
                        </span>
                      </div>

                      {exit.hostDetail ? (
                        <p className="break-words text-destructive">{exit.hostDetail}</p>
                      ) : null}
                      {proximityWarn ? (
                        <p className="break-words text-warning">
                          {formatSubnetProximityWarning(proximityWarn, t)}
                        </p>
                      ) : null}
                      {verifyResult ? (
                        <p
                          className={
                            verifyResult.ok ? "flex items-center gap-1 text-success" : "text-destructive"
                          }
                        >
                          {verifyResult.ok ? (
                            <>
                              <CheckCircle2 className="size-3.5" />
                              {t("egress.verifyOk", {
                                ip: verifyResult.observedIp ?? verifyResult.egressIpv4,
                                httpMs: verifyResult.httpLatencyMs,
                                dnsMs: verifyResult.dnsLatencyMs,
                              })}
                            </>
                          ) : (
                            t("egress.verifyFail", {
                              detail:
                                verifyResult.httpError ??
                                verifyResult.dnsError ??
                                `observed ${verifyResult.observedIp ?? "—"}`,
                            })
                          )}
                        </p>
                      ) : null}
                      {editExit?.id === exit.id ? (
                        <form
                          className="mt-2 space-y-2.5 border-t border-border/60 pt-2.5 text-xs"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const parsedTable = parseOptionalRoutingTableId(editExitTable);
                            if (!parsedTable.ok) {
                              toast.error(t("egress.invalidRoutingTable"));
                              return;
                            }
                            void runAction(`edit-exit:${editExit.id}`, async () => {
                              await updateNodeEgressIp(request, node.id, editExit.id, {
                                label: editExitLabel.trim() || null,
                                interfaceName: editExitIface.trim() || null,
                                gatewayIpv4: editExitGw.trim() || null,
                                routingTableId: parsedTable.value,
                                dnsPrimary: editExitDns1.trim(),
                                dnsSecondary: editExitDns2.trim() || null,
                                amneziaDnsDnat: editExitAmneziaDns,
                                enforceDnsDnat: editExitEnforceDns,
                                allowAsEntry: editExitAllowAsEntry,
                                enabled: editExitEnabled,
                              });
                              toast.success(t("adminData.actionDone"));
                              setEditExit(null);
                              await reload();
                            });
                          }}
                        >
                          <p className="font-medium">
                            {t("egress.editExitTitle", { ip: editExit.ipv4 })}
                          </p>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.fieldLabel")}</Label>
                              <Input
                                value={editExitLabel}
                                onChange={(e) => setEditExitLabel(e.target.value)}
                                placeholder={t("egress.label")}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.dnsPrimary")}</Label>
                              <Input
                                value={editExitDns1}
                                onChange={(e) => setEditExitDns1(e.target.value)}
                                placeholder="1.1.1.1"
                                className="h-8 text-xs"
                                required
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.dnsSecondary")}</Label>
                              <Input
                                value={editExitDns2}
                                onChange={(e) => setEditExitDns2(e.target.value)}
                                placeholder="1.0.0.1"
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] text-muted-foreground">
                              {t("egress.dnsPresetsLabel")}
                            </span>
                            {DNS_PRESETS.map((preset) => {
                              const active =
                                editExitDns1.trim() === preset.dns1 &&
                                editExitDns2.trim() === preset.dns2;
                              return (
                                <button
                                  key={preset.label}
                                  type="button"
                                  onClick={() => {
                                    setEditExitDns1(preset.dns1);
                                    setEditExitDns2(preset.dns2);
                                  }}
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                                    active
                                      ? "border-primary bg-primary/10 text-primary"
                                      : "border-border bg-well text-muted-foreground hover:bg-accent hover:text-foreground",
                                  )}
                                >
                                  {preset.label} ({preset.dns1})
                                </button>
                              );
                            })}
                          </div>
                          <div className="space-y-1.5">
                            <p className="text-[11px] text-muted-foreground">
                              {t("egress.advancedNetworkGroup")}
                            </p>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <div className="space-y-1">
                                <Label className="text-[11px]">{t("egress.fieldInterface")}</Label>
                                <Input
                                  value={editExitIface}
                                  onChange={(e) => setEditExitIface(e.target.value)}
                                  placeholder="eth0"
                                  className="h-8 text-xs"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px]">{t("egress.fieldGateway")}</Label>
                                <Input
                                  value={editExitGw}
                                  onChange={(e) => setEditExitGw(e.target.value)}
                                  placeholder={t("egress.gatewayIpv4")}
                                  className="h-8 text-xs"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="flex items-center gap-1 text-[11px]">
                                  <span>{t("egress.fieldRoutingTable")}</span>
                                  <Hint>{t("egress.routingTableHint")}</Hint>
                                </Label>
                                <Input
                                  value={editExitTable}
                                  onChange={(e) => setEditExitTable(e.target.value)}
                                  placeholder="200..219"
                                  title={t("egress.routingTableHint")}
                                  type="number"
                                  min={200}
                                  max={219}
                                  className="h-8 text-xs"
                                />
                              </div>
                            </div>
                          </div>
                          <div className="grid gap-2.5 pt-1 sm:grid-cols-2">
                            <label className="flex items-center gap-1.5">
                              <Switch
                                checked={editExitEnabled}
                                onCheckedChange={setEditExitEnabled}
                              />
                              <span>{t("egress.exitEnabled")}</span>
                              <Hint>{t("egress.exitEnabledHint")}</Hint>
                            </label>
                            <label className="flex items-center gap-1.5">
                              <Switch
                                checked={editExitAmneziaDns}
                                onCheckedChange={setEditExitAmneziaDns}
                              />
                              <span>{t("egress.amneziaDnsDnat")}</span>
                              <Hint>{t("egress.amneziaDnsDnatHint")}</Hint>
                            </label>
                            <label className="flex items-center gap-1.5">
                              <Switch
                                checked={editExitEnforceDns}
                                onCheckedChange={setEditExitEnforceDns}
                              />
                              <span>{t("egress.enforceDnsDnat")}</span>
                              <Hint>{t("egress.enforceDnsDnatHint")}</Hint>
                            </label>
                            <label className="flex items-center gap-1.5">
                              <Switch
                                checked={editExitAllowAsEntry}
                                onCheckedChange={setEditExitAllowAsEntry}
                              />
                              <span>{t("egress.allowAsEntry")}</span>
                              <Hint>{t("egress.allowAsEntryHint")}</Hint>
                            </label>
                          </div>
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditExit(null)}
                            >
                              {t("common.cancel")}
                            </Button>
                            <Button type="submit" size="sm" disabled={busy !== null}>
                              {t("common.save")}
                            </Button>
                          </div>
                        </form>
                      ) : null}
                      {swapTarget?.id === exit.id ? (
                        <form
                          className="mt-2 space-y-2.5 border-t border-primary/40 pt-2.5 text-xs"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void runAction(`swap:${swapTarget.id}`, async () => {
                              await swapNodeEgressIp(request, node.id, swapTarget.id, {
                                ipv4: swapIpv4.trim(),
                                interfaceName: swapIface.trim() || null,
                                gatewayIpv4: swapGw.trim() || null,
                                label: swapLabel.trim() || null,
                              });
                              toast.success(t("adminData.actionDone"));
                              setSwapTarget(null);
                              await reload();
                            });
                          }}
                        >
                          <div className="space-y-0.5">
                            <p className="font-medium">
                              {t("egress.swapTitle", { ip: swapTarget.ipv4 })}
                            </p>
                            <p className="text-muted-foreground">{t("egress.swapHint")}</p>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.fieldNewIpv4")}</Label>
                              <Input
                                value={swapIpv4}
                                onChange={(e) => setSwapIpv4(e.target.value)}
                                placeholder="198.51.100.25"
                                className="h-8 text-xs"
                                required
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.fieldLabel")}</Label>
                              <Input
                                value={swapLabel}
                                onChange={(e) => setSwapLabel(e.target.value)}
                                placeholder={t("egress.label")}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.fieldInterface")}</Label>
                              <Input
                                value={swapIface}
                                onChange={(e) => setSwapIface(e.target.value)}
                                placeholder="eth0"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]">{t("egress.fieldGateway")}</Label>
                              <Input
                                value={swapGw}
                                onChange={(e) => setSwapGw(e.target.value)}
                                placeholder={t("egress.gatewayIpv4")}
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setSwapTarget(null)}
                            >
                              {t("common.cancel")}
                            </Button>
                            <Button type="submit" size="sm" disabled={busy !== null}>
                              {t("egress.swapApply")}
                            </Button>
                          </div>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <details className="rounded-lg border bg-well p-2.5 text-xs">
              <summary className="cursor-pointer font-medium">{t("egress.addExitForm")}</summary>
              <form
                className="mt-2.5 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsedTable = parseOptionalRoutingTableId(newExitTable);
                  if (!parsedTable.ok) {
                    toast.error(t("egress.invalidRoutingTable"));
                    return;
                  }
                  void runAction("add-exit", async () => {
                    await createNodeEgressIp(request, node.id, {
                      ipv4: newExitIp.trim(),
                      label: newExitLabel.trim() || null,
                      interfaceName: newExitIface.trim() || null,
                      gatewayIpv4: newExitGw.trim() || null,
                      ...(parsedTable.value !== null
                        ? { routingTableId: parsedTable.value }
                        : {}),
                      dnsPrimary: newExitDns1.trim() || "1.1.1.1",
                      dnsSecondary: newExitDns2.trim() || null,
                      amneziaDnsDnat: newExitAmneziaDns,
                      enforceDnsDnat: newExitEnforceDns,
                      allowAsEntry: newExitAllowAsEntry,
                      enabled: true,
                    });
                    toast.success(t("adminData.actionDone"));
                    setNewExitIp("");
                    setNewExitLabel("");
                    setNewExitIface("");
                    setNewExitGw("");
                    setNewExitTable("");
                    await reload();
                  });
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-[11px]">{t("egress.ipv4")}</Label>
                    <Input
                      value={newExitIp}
                      onChange={(e) => setNewExitIp(e.target.value)}
                      placeholder="198.51.100.20"
                      className="h-8 text-xs"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">{t("egress.fieldLabel")}</Label>
                    <Input
                      value={newExitLabel}
                      onChange={(e) => setNewExitLabel(e.target.value)}
                      placeholder={t("egress.label")}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">{t("egress.dnsPrimary")}</Label>
                    <Input
                      value={newExitDns1}
                      onChange={(e) => setNewExitDns1(e.target.value)}
                      placeholder="1.1.1.1"
                      className="h-8 text-xs"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">{t("egress.dnsSecondary")}</Label>
                    <Input
                      value={newExitDns2}
                      onChange={(e) => setNewExitDns2(e.target.value)}
                      placeholder="1.0.0.1"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t("egress.dnsPresetsLabel")}
                  </span>
                  {DNS_PRESETS.map((preset) => {
                    const active =
                      newExitDns1.trim() === preset.dns1 &&
                      newExitDns2.trim() === preset.dns2;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setNewExitDns1(preset.dns1);
                          setNewExitDns2(preset.dns2);
                        }}
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                          active
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-well text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {preset.label} ({preset.dns1})
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">
                    {t("egress.advancedNetworkGroup")}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label className="text-[11px]">{t("egress.fieldInterface")}</Label>
                      <Input
                        value={newExitIface}
                        onChange={(e) => setNewExitIface(e.target.value)}
                        placeholder="eth0"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">{t("egress.fieldGateway")}</Label>
                      <Input
                        value={newExitGw}
                        onChange={(e) => setNewExitGw(e.target.value)}
                        placeholder={t("egress.gatewayIpv4")}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="flex items-center gap-1 text-[11px]">
                        <span>{t("egress.fieldRoutingTable")}</span>
                        <Hint>{t("egress.routingTableHint")}</Hint>
                      </Label>
                      <Input
                        value={newExitTable}
                        onChange={(e) => setNewExitTable(e.target.value)}
                        placeholder="200..219"
                        title={t("egress.routingTableHint")}
                        type="number"
                        min={200}
                        max={219}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                </div>
                <div className="grid gap-2.5 pt-1 sm:grid-cols-2">
                  <label className="flex items-center gap-1.5">
                    <Switch checked={newExitAmneziaDns} onCheckedChange={setNewExitAmneziaDns} />
                    <span>{t("egress.amneziaDnsDnat")}</span>
                    <Hint>{t("egress.amneziaDnsDnatHint")}</Hint>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <Switch checked={newExitEnforceDns} onCheckedChange={setNewExitEnforceDns} />
                    <span>{t("egress.enforceDnsDnat")}</span>
                    <Hint>{t("egress.enforceDnsDnatHint")}</Hint>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <Switch checked={newExitAllowAsEntry} onCheckedChange={setNewExitAllowAsEntry} />
                    <span>{t("egress.allowAsEntry")}</span>
                    <Hint>{t("egress.allowAsEntryHint")}</Hint>
                  </label>
                </div>
                <Button type="submit" size="sm" disabled={busy !== null || !newExitIp.trim()}>
                  <Plus className="size-3.5" /> {t("egress.addExitBtn")}
                </Button>
              </form>
            </details>
          </section>

          {/* Section 4: Server Variants (Entry -> Exit) */}
          <section data-topology-section="variants" className="min-w-0 space-y-2.5 border-t pt-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <span>{t("egress.sectionVariants")}</span>
              <Hint>{t("egress.sectionVariantsHint")}</Hint>
            </h3>
            <ul className="space-y-1.5">
              {endpoints.map((ep) => {
                const assignedExitId = ep.egressIpId ?? node.egressDefaultIpId ?? null;
                const assignedExit = assignedExitId
                  ? (exits.find((e) => e.id === assignedExitId) ?? null)
                  : null;
                const effectiveExitIp =
                  ep.effectiveEgressIp ?? assignedExit?.ipv4 ?? defaultExitIpv4;
                const enabledCount = endpoints.filter((x) => x.enabled).length;
                const isLastEnabled = ep.enabled && enabledCount <= 1;
                const isEditing = editVarId === ep.id;
                const isFocusedVariant =
                  initialFocus?.kind === "variant" && initialFocus.id === ep.id;
                return (
                  <li
                    key={ep.id}
                    data-topology-focus={`variant:${ep.id}`}
                    data-focused={isFocusedVariant ? "true" : undefined}
                    className={cn(
                      "space-y-2 rounded-lg border bg-well p-2.5 text-xs transition-shadow",
                      isFocusedVariant &&
                        "ring-2 ring-primary/70 border-primary/70 bg-primary/[0.06]",
                    )}
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="break-words text-sm font-medium">{ep.name}</span>
                        <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          <span className="break-all">{ep.publicAddress}</span>
                          <ArrowRight aria-hidden className="size-3 shrink-0" />
                          <span
                            aria-label={
                              assignedExit
                                ? t(`egress.hostState.${assignedExit.hostState}`)
                                : undefined
                            }
                            title={
                              assignedExit
                                ? t(`egress.hostState.${assignedExit.hostState}`)
                                : undefined
                            }
                            className={cn(
                              "inline-block size-2 shrink-0 rounded-full",
                              assignedExit
                                ? EXIT_HEALTH_DOT[assignedExit.hostState]
                                : "bg-muted-foreground/40",
                            )}
                          />
                          <span className="break-all">{effectiveExitIp}</span>
                        </span>
                        {ep.bridgeMode && ep.bridgeMode !== "inherit" ? (
                          <Badge variant="outline">{ep.bridgeMode}</Badge>
                        ) : null}
                        {ep.enabledProtocols && ep.enabledProtocols.length > 0 ? (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {ep.enabledProtocols.join(", ")}
                          </Badge>
                        ) : null}
                        {ep.keyUpdateNotifiedAt ? (
                          <Badge variant="warning">{t("notifyKeyUpdate.activeBadge")}</Badge>
                        ) : null}
                      </div>
                      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t("egress.inlineExitLabel")}
                          </span>
                          <Select
                            value={ep.egressIpId ?? DEFAULT_EXIT_SENTINEL}
                            disabled={busy !== null}
                            onValueChange={(nextValue) => {
                              const nextExitId =
                                nextValue === DEFAULT_EXIT_SENTINEL ? null : nextValue;
                              if (nextExitId === (ep.egressIpId ?? null)) return;
                              void runAction(`switch-exit:${ep.id}`, async () => {
                                await onSavePublicEndpoint(node.id, {
                                  action: "update",
                                  id: ep.id,
                                  egressIpId: nextExitId,
                                });
                                toast.success(t("egress.exitSwitched"));
                              });
                            }}
                          >
                            <SelectTrigger className="h-7 w-[190px] max-w-full text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={DEFAULT_EXIT_SENTINEL}>
                                {t("egress.exitDefaultOption", { ip: defaultExitIpv4 })}
                              </SelectItem>
                              {exits.map((exit) => (
                                <SelectItem
                                  key={exit.id}
                                  value={exit.id}
                                  disabled={!exit.enabled && exit.id !== (ep.egressIpId ?? "")}
                                >
                                  {exit.label ? `${exit.label} (${exit.ipv4})` : exit.ipv4}
                                  {!exit.enabled ? ` · ${t("egress.hostState.disabled")}` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={busy !== null}
                          title={t("notifyKeyUpdate.button")}
                          onClick={() =>
                            openNotify({
                              title: ep.name,
                              notifiedAt: ep.keyUpdateNotifiedAt ?? null,
                              note: ep.keyUpdateNotifyNote ?? null,
                              onNotify: (note) =>
                                notifyNodeEndpointKeyUpdate(request, node.id, ep.id, note),
                              onClear: () =>
                                clearNodeEndpointKeyUpdate(request, node.id, ep.id),
                            })
                          }
                        >
                          <BellRing className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={busy !== null}
                          onClick={() => {
                            setEditVarId(ep.id);
                            setEditVarEntryName(ep.entryName ?? ep.name);
                            setEditVarCustomName(ep.customName ?? "");
                            setEditVarExitId(ep.egressIpId ?? DEFAULT_EXIT_SENTINEL);
                            setEditVarProtocols(ep.enabledProtocols ?? null);
                            setEditVarRenameGroup(false);
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={busy !== null || isLastEnabled}
                          onClick={() => {
                            if (!window.confirm(t("egress.removeVariantConfirm", { name: ep.name }))) {
                              return;
                            }
                            void runAction(`rm-var:${ep.id}`, async () => {
                              await onSavePublicEndpoint(node.id, { action: "remove", id: ep.id });
                            });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {isEditing ? (
                      <form
                        className="space-y-2 border-t border-border/60 pt-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void runAction(`save-var:${ep.id}`, async () => {
                            await onSavePublicEndpoint(node.id, {
                              action: "update",
                              id: ep.id,
                              entryName: editVarEntryName.trim(),
                              customName: editVarCustomName.trim() || null,
                              renameEntryGroup: editVarRenameGroup,
                              egressIpId:
                                editVarExitId === DEFAULT_EXIT_SENTINEL
                                  ? null
                                  : editVarExitId,
                              enabledProtocols: editVarProtocols,
                            });
                            setEditVarId(null);
                          });
                        }}
                      >
                        <div className="grid gap-2 sm:grid-cols-3">
                          <Input
                            value={editVarEntryName}
                            onChange={(e) => setEditVarEntryName(e.target.value)}
                            placeholder={t("egress.entryName")}
                            className="h-8 text-xs"
                            required
                          />
                          <Input
                            value={editVarCustomName}
                            onChange={(e) => setEditVarCustomName(e.target.value)}
                            placeholder={t("egress.customName")}
                            className="h-8 text-xs"
                          />
                          <Select value={editVarExitId} onValueChange={setEditVarExitId}>
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={DEFAULT_EXIT_SENTINEL}>
                                {t("egress.exitDefaultOption", { ip: defaultExitIpv4 })}
                              </SelectItem>
                              {exits.map((exit) => (
                                <SelectItem
                                  key={exit.id}
                                  value={exit.id}
                                  disabled={!exit.enabled && exit.id !== editVarExitId}
                                >
                                  {exit.label ? `${exit.label} (${exit.ipv4})` : exit.ipv4}
                                  {!exit.enabled ? ` · ${t("egress.hostState.disabled")}` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          <span className="text-[11px] font-medium text-muted-foreground">
                            {t("egress.variantProtocols")}:
                          </span>
                          <label className="flex items-center gap-1.5">
                            <Checkbox
                              checked={editVarProtocols === null}
                              onChange={(e) =>
                                setEditVarProtocols(e.target.checked ? null : ["awg3"])
                              }
                            />
                            <span>{t("egress.variantProtocolsInherit")}</span>
                          </label>
                          {editVarProtocols !== null ? (
                            PROTOCOLS.map(({ value: proto, label }) => {
                              const checked = editVarProtocols.includes(proto);
                              return (
                                <label key={proto} className="flex items-center gap-1.5">
                                  <Checkbox
                                    checked={checked}
                                    onChange={(e) => {
                                      const next = e.target.checked
                                        ? [...editVarProtocols, proto]
                                        : editVarProtocols.filter((p) => p !== proto);
                                      if (next.length > 0) setEditVarProtocols(next);
                                    }}
                                  />
                                  <span className="font-mono">{label}</span>
                                </label>
                              );
                            })
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-2">
                            <Checkbox
                              checked={editVarRenameGroup}
                              onChange={(e) => setEditVarRenameGroup(e.target.checked)}
                            />
                            <span>{t("egress.renameGroup")}</span>
                          </label>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditVarId(null)}
                            >
                              {t("common.cancel")}
                            </Button>
                            <Button type="submit" size="sm" disabled={busy !== null}>
                              {t("common.save")}
                            </Button>
                          </div>
                        </div>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <form
              className="space-y-2 rounded-lg border bg-card p-2.5 text-xs"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction("add-variant", async () => {
                  await onSavePublicEndpoint(node.id, {
                    action: "add",
                    address: varAddress.trim(),
                    entryName: varEntryName.trim() || undefined,
                    customName: varCustomName.trim() || null,
                    egressIpId: varExitId === DEFAULT_EXIT_SENTINEL ? null : varExitId,
                    ...(varProtocols !== null ? { enabledProtocols: varProtocols } : {}),
                  });
                  setVarCustomName("");
                  setVarProtocols(null);
                });
              }}
            >
              <p className="font-medium">{t("egress.addVariantTitle")}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">{t("egress.entryIpv4")}</Label>
                  <Input
                    value={varAddress}
                    onChange={(e) => setVarAddress(e.target.value)}
                    placeholder={t("egress.entryIpv4")}
                    className="h-8 text-xs"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{t("egress.entryName")}</Label>
                  <Input
                    value={varEntryName}
                    onChange={(e) => setVarEntryName(e.target.value)}
                    placeholder={t("egress.entryName")}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{t("egress.customName")}</Label>
                  <Input
                    value={varCustomName}
                    onChange={(e) => setVarCustomName(e.target.value)}
                    placeholder={t("egress.customName")}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{t("egress.exitSelect")}</Label>
                  <Select value={varExitId} onValueChange={setVarExitId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_EXIT_SENTINEL}>
                        {t("egress.exitDefaultOption", { ip: defaultExitIpv4 })}
                      </SelectItem>
                      {exits.map((exit) => (
                        <SelectItem key={exit.id} value={exit.id} disabled={!exit.enabled}>
                          {exit.label ? `${exit.label} (${exit.ipv4})` : exit.ipv4}
                          {!exit.enabled ? ` · ${t("egress.hostState.disabled")}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("egress.variantProtocols")}:
                </span>
                <label className="flex items-center gap-1.5">
                  <Checkbox
                    checked={varProtocols === null}
                    onChange={(e) => setVarProtocols(e.target.checked ? null : ["awg3"])}
                  />
                  <span>{t("egress.variantProtocolsInherit")}</span>
                </label>
                {varProtocols !== null
                  ? PROTOCOLS.map(({ value: proto, label }) => {
                      const checked = varProtocols.includes(proto);
                      return (
                        <label key={proto} className="flex items-center gap-1.5">
                          <Checkbox
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...varProtocols, proto]
                                : varProtocols.filter((p) => p !== proto);
                              if (next.length > 0) setVarProtocols(next);
                            }}
                          />
                          <span className="font-mono">{label}</span>
                        </label>
                      );
                    })
                  : null}
              </div>
              {quickPickIps.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="text-[11px] text-muted-foreground">{t("egress.pickHostIp")}</span>
                  {quickPickIps.map((ip) => (
                    <button
                      key={ip}
                      type="button"
                      onClick={() => setVarAddress(ip)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                        varAddress.trim() === ip
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-well text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {ip}
                    </button>
                  ))}
                </div>
              ) : null}
              <Button type="submit" size="sm" disabled={busy !== null || !varAddress.trim()}>
                <Plus className="size-3.5" /> {t("egress.addVariantBtn")}
              </Button>
            </form>
          </section>
          {!onOpenNotify ? (
            <NotifyKeyUpdateDialog
              target={internalNotifyTarget}
              onClose={() => setInternalNotifyTarget(null)}
              onDone={reload}
            />
          ) : null}
        </div>
  );
}
