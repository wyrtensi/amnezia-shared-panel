"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Cable,
  CheckCircle2,
  GitBranch,
  KeyRound,
  Server,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AdminNode, Overview } from "@/components/admin/admin-data";
import type { AdminReachabilityView, AdminServiceCheck } from "@/lib/types";
import type { MessageKey } from "@/lib/i18n/messages";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type AttentionItem = {
  id: string;
  severity: "danger" | "warning";
  textKey: MessageKey;
  vars?: Record<string, string | number>;
  adoptNodeId?: string;
  href?: string;
};

export type FleetHealthSummary = {
  healthyNodes: number;
  totalNodes: number;
  routedNodes: number;
  egressIssueCount: number;
  bridgesOnline: number;
  bridgesTotal: number;
  probeIncidents: number;
  serviceFailures: number;
  pendingQuotaCount: number;
  attention: AttentionItem[];
};

const nodeObservedMode = (node: AdminNode): string => {
  const mode = node.hostNetworkReport?.observedMode;
  return mode === "routed" || mode === "masquerade" ? mode : "unknown";
};

/** Compute fleet health pills and actionable "Needs attention" items. */
export const summarizeFleetHealth = ({
  overview,
  nodes,
  reachability,
  serviceChecks,
  pendingQuotaCount,
}: {
  overview: Overview | null | undefined;
  nodes: readonly AdminNode[];
  reachability: AdminReachabilityView | null | undefined;
  serviceChecks: readonly AdminServiceCheck[];
  pendingQuotaCount: number;
}): FleetHealthSummary => {
  const totalNodes = overview?.nodes?.total ?? nodes.length;
  const healthyNodes =
    overview?.nodes?.healthy ??
    nodes.filter((node) => node.enabled && !node.lastError).length;
  const routedNodes = nodes.filter((node) => node.egressMode === "routed").length;
  const bridgesTotal = overview?.bridges?.count ?? 0;
  const bridgesOnline =
    overview?.bridges?.items.filter((bridge) => bridge.managementStatus === "ok")
      .length ?? 0;

  const attention: AttentionItem[] = [];
  let egressIssueCount = 0;

  for (const node of nodes) {
    const label = node.publicName || node.name;
    const nodeBrokenEgress =
      Boolean(node.modeDrift) ||
      node.egressDaemonState === "conflict" ||
      node.egressDaemonState === "degraded" ||
      node.egressModeState === "failed" ||
      (node.egressIps ?? []).some(
        (ip) =>
          ip.enabled &&
          (ip.hostState === "missing_ip" ||
            ip.hostState === "gateway_error" ||
            ip.hostState === "daemon_offline"),
      );
    if (nodeBrokenEgress) egressIssueCount += 1;

    if (node.modeDrift) {
      attention.push({
        id: `drift:${node.id}`,
        severity: "danger",
        textKey: "ov.attention.drift",
        vars: {
          node: label,
          db: node.egressMode ?? "masquerade",
          host: nodeObservedMode(node),
        },
        adoptNodeId: node.id,
        href: `/admin/nodes#node-${node.id}`,
      });
    } else if (node.lastError) {
      attention.push({
        id: `error:${node.id}`,
        severity: "danger",
        textKey: "ov.attention.nodeError",
        vars: { node: label, error: node.lastError.slice(0, 120) },
        href: `/admin/nodes#node-${node.id}`,
      });
    } else if (
      node.egressDaemonState === "conflict" ||
      node.egressDaemonState === "degraded" ||
      node.egressModeState === "failed"
    ) {
      attention.push({
        id: `egress:${node.id}`,
        severity: "warning",
        textKey: "ov.attention.egressState",
        vars: {
          node: label,
          state: node.egressModeState === "failed"
            ? (node.egressModeMessage ?? "failed")
            : (node.egressDaemonState ?? "degraded"),
        },
        href: `/admin/nodes#node-${node.id}`,
      });
    }

    for (const ip of node.egressIps ?? []) {
      if (!ip.enabled) continue;
      if (
        ip.hostState === "missing_ip" ||
        ip.hostState === "gateway_error" ||
        ip.hostState === "daemon_offline"
      ) {
        attention.push({
          id: `exit:${node.id}:${ip.id}`,
          severity: "danger",
          textKey: "ov.attention.exitError",
          vars: { node: label, ip: ip.ipv4, state: ip.hostState },
          href: `/admin/nodes#node-${node.id}`,
        });
      }
    }
  }

  let probeIncidents = 0;
  for (const rNode of reachability?.nodes ?? []) {
    const hasEndpointIssue = (rNode.publicEndpoints ?? []).some(
      (ep) => ep.incidentOpen || ep.probeEgressMatch === false,
    );
    if (rNode.incidentOpen || hasEndpointIssue) {
      probeIncidents += 1;
      attention.push({
        id: `probe:${rNode.nodeId}`,
        severity: "danger",
        textKey: "ov.attention.probeIncident",
        vars: { node: rNode.nodeName },
        href: "/admin/nodes",
      });
    }
  }

  let serviceFailures = 0;
  const seenCheckPairs = new Set<string>();
  for (const check of serviceChecks) {
    if (!check.enabled) continue;
    for (const res of check.results ?? []) {
      if (res.status !== "failed") continue;
      const key = `${res.nodeId}:${check.id}`;
      if (seenCheckPairs.has(key)) continue;
      seenCheckPairs.add(key);
      serviceFailures += 1;
      attention.push({
        id: `svc:${key}`,
        severity: "warning",
        textKey: "ov.attention.serviceFail",
        vars: { node: res.nodeName, check: check.name },
        href: "/admin/nodes",
      });
    }
  }

  if (pendingQuotaCount > 0) {
    attention.push({
      id: "quota:pending",
      severity: "warning",
      textKey: "ov.attention.quota",
      vars: { count: pendingQuotaCount },
    });
  }

  return {
    healthyNodes,
    totalNodes,
    routedNodes,
    egressIssueCount,
    bridgesOnline,
    bridgesTotal,
    probeIncidents,
    serviceFailures,
    pendingQuotaCount,
    attention,
  };
};

export function OverviewStatusStrip({
  summary,
  t,
}: {
  summary: FleetHealthSummary;
  t: Translate;
}) {
  const allHealthy =
    summary.egressIssueCount === 0 &&
    summary.probeIncidents === 0 &&
    summary.serviceFailures === 0 &&
    summary.healthyNodes === summary.totalNodes;

  return (
    <div
      data-testid="overview-status-strip"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card px-3.5 py-2.5 text-xs shadow-xs"
    >
      <Badge variant={summary.healthyNodes < summary.totalNodes ? "warning" : "success"} className="gap-1">
        <Server className="size-3" />
        {t("ov.pulse.nodesOk", {
          healthy: summary.healthyNodes,
          total: summary.totalNodes,
        })}
      </Badge>
      {summary.routedNodes > 0 ? (
        <Badge variant="outline" className="gap-1">
          <GitBranch className="size-3" />
          {t("ov.pulse.routedCount", { count: summary.routedNodes })}
        </Badge>
      ) : null}
      {summary.bridgesTotal > 0 ? (
        <Badge
          variant={summary.bridgesOnline < summary.bridgesTotal ? "warning" : "success"}
          className="gap-1"
        >
          <Cable className="size-3" />
          {t("ov.pulse.bridgesOk", {
            online: summary.bridgesOnline,
            total: summary.bridgesTotal,
          })}
        </Badge>
      ) : null}
      {summary.egressIssueCount > 0 ? (
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="size-3" />
          {t("ov.pulse.egressIssues", { count: summary.egressIssueCount })}
        </Badge>
      ) : null}
      {summary.probeIncidents > 0 ? (
        <Badge variant="destructive" className="gap-1">
          <ShieldAlert className="size-3" />
          {t("ov.pulse.probeIncidents", { count: summary.probeIncidents })}
        </Badge>
      ) : null}
      {summary.pendingQuotaCount > 0 ? (
        <Badge variant="warning" className="gap-1">
          <KeyRound className="size-3" />
          {t("ov.pulse.quotaPending", { count: summary.pendingQuotaCount })}
        </Badge>
      ) : null}
      {allHealthy ? (
        <span className="ml-auto inline-flex items-center gap-1 font-medium text-success">
          <CheckCircle2 className="size-3.5" />
          {t("ov.pulse.allGood")}
        </span>
      ) : null}
    </div>
  );
}

export function OverviewAttentionShelf({
  items,
  adoptingId,
  onAdoptDrift,
  t,
}: {
  items: readonly AttentionItem[];
  adoptingId: string | null;
  onAdoptDrift: (nodeId: string) => void;
  t: Translate;
}) {
  if (items.length === 0) return null;
  return (
    <Card
      data-testid="overview-attention-shelf"
      className="border-warning/60 bg-warning/5"
    >
      <CardContent className="space-y-2 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <AlertTriangle className="size-4 text-warning" />
            {t("ov.attention.title")}
            <Badge variant="warning" className="tabular-nums">
              {items.length}
            </Badge>
          </h2>
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <Link href="/admin/nodes" prefetch={false}>
              {t("ov.attention.openNodes")} <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
        <ul className="space-y-1.5">
          {items.slice(0, 8).map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={
                    item.severity === "danger"
                      ? "size-2 shrink-0 rounded-full bg-destructive"
                      : "size-2 shrink-0 rounded-full bg-warning"
                  }
                />
                <span className="truncate">{t(item.textKey, item.vars)}</span>
              </span>
              {item.adoptNodeId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-6 px-2 text-[11px]"
                  disabled={adoptingId === item.adoptNodeId}
                  onClick={() => onAdoptDrift(item.adoptNodeId!)}
                >
                  {t("egress.adoptHost")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
