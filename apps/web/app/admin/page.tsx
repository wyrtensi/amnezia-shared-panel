"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpDown,
  Check,
  Cpu,
  Globe,
  KeyRound,
  Moon,
  Server,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import {
  INACTIVE_DAYS,
  formatLastSeen,
  isInactive,
  lastSeenFromKeys,
} from "@/lib/activity";
import { cn } from "@/lib/utils";
import { TrafficSummary } from "@/components/traffic-summary";
import {
  InlineTraffic,
  TrafficBytes,
  TrafficSplit,
} from "@/components/inline-traffic";
import { useAdminData, type AdminNode } from "@/components/admin/admin-data";
import { effectiveKeyLimitMode } from "@/lib/key-quota";
import { PanelUpdateCard } from "@/components/admin/panel-update-card";
import { NodeCardSection } from "@/components/admin/node-card-section";
import {
  NodeCheckChips,
  type NodeCheckResult,
} from "@/components/admin/node-check-chips";
import { NodeMetrics } from "@/components/admin/node-metrics";
import { NodePublicAddress } from "@/components/admin/node-public-address";
import { useServiceChecks } from "@/components/admin/use-service-checks";
import { useT } from "@/lib/i18n/provider";

const METRIC_TONE: Record<string, string> = {
  "chart-1": "bg-chart-1/12 text-chart-1",
  "chart-2": "bg-chart-2/15 text-chart-2",
  "chart-3": "bg-chart-3/15 text-chart-3",
  "chart-4": "bg-chart-4/15 text-chart-4",
  "chart-5": "bg-chart-5/12 text-chart-5",
};

const BAR_TONE = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
];

const PROTOCOL_LABEL: Record<string, string> = {
  awg2: "protocol.awg2",
  awg3: "protocol.awg3",
};
const PROFILE_LABEL: Record<string, string> = {
  full_tunnel: "route.full_tunnel",
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};
const STATE_LABEL: Record<string, string> = {
  active: "ov.stateActive",
  disabled: "ov.stateDisabled",
  provisioning: "ov.stateProvisioning",
  revoking: "ov.stateRevoking",
  revoked: "ov.stateRevoked",
  failed: "ov.stateFailed",
};

export default function AdminOverviewPage() {
  const { overview, users, requests, nodes, keys, policy, loading, action } =
    useAdminData();
  // The same fetch the nodes page uses, so the two surfaces cannot disagree
  // about what a server last answered.
  const serviceChecks = useServiceChecks();
  const { t, lang } = useT();

  /**
   * The verdicts worth showing on a summary card for one node.
   *
   * Empty unless a check exists at all AND this node takes part in checking:
   * a node with checking switched off has only stale verdicts, and a stale red
   * chip on the overview is worse than no chip. Individually disabled checks
   * drop out for the same reason — the nodes page keeps them, dimmed, because
   * that is where "this one is turned off here" is a fact you act on.
   */
  const visibleChecks = (node: AdminNode) => {
    if (node.checksEnabled === false) return [];
    const skipped = new Set(node.disabledCheckIds ?? []);
    return (serviceChecks.byNode.get(node.id) ?? []).filter(
      (result) => !skipped.has(result.id),
    );
  };

  const pending = requests.filter((request) => request.status === "pending");
  const userEmail = (id: string) =>
    users.find((user) => user.id === id)?.email ?? id;
  // The mode the API will approve under: the user's override, else the global.
  const modeFor = (userId: string) =>
    effectiveKeyLimitMode(
      policy.keyLimitMode,
      users.find((entry) => entry.id === userId)?.policyOverride?.keyLimitMode,
    );
  // The limit the request builds on, resolved the way the backend resolves it.
  // Per-node mode: the per-node entry for a per-server request, then the flat
  // override, then the global default. Global mode: the pool, whatever the
  // request targeted. So the admin sees "have now → requested".
  const currentLimit = (userId: string, nodeId: string | null) => {
    const user = users.find((entry) => entry.id === userId);
    const perNode =
      nodeId && modeFor(userId) === "per_node"
        ? user?.nodeKeyLimits?.[nodeId]
        : undefined;
    return perNode ?? user?.keyLimitOverride ?? policy.defaultKeyLimit;
  };

  // An every-server grant in per-node mode clears the user's per-node limits,
  // so the admin has to see that before approving. Global mode keeps them.
  const perNodeLimitCount = (userId: string) =>
    modeFor(userId) === "global"
      ? 0
      : Object.keys(
          users.find((entry) => entry.id === userId)?.nodeKeyLimits ?? {},
        ).length;

  const [now] = React.useState(() => Date.now());
  const inactiveUsers = React.useMemo(() => {
    const keysByOwner = new Map<string, typeof keys>();
    for (const key of keys) {
      const list = keysByOwner.get(key.ownerId);
      if (list) list.push(key);
      else keysByOwner.set(key.ownerId, [key]);
    }
    return users
      .filter((user) => user.status === "active")
      .map((user) => ({
        user,
        lastSeen: lastSeenFromKeys(keysByOwner.get(user.id) ?? []),
      }))
      .filter((entry) => isInactive(entry.lastSeen, now))
      .sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
  }, [users, keys, now]);

  const metrics: Array<{
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
    icon: React.ComponentType<{ className?: string }>;
    tone: string;
    attention: boolean;
  }> = [
    {
      label: t("ov.activeKeys"),
      value: overview?.activeKeys ?? keys.length,
      icon: KeyRound,
      tone: "chart-1",
      attention: false,
    },
    {
      label: t("ov.onlineNow"),
      value: overview?.onlineDevices ?? 0,
      icon: Wifi,
      tone: "chart-2",
      attention: false,
    },
    {
      label: t("ov.totalTraffic"),
      value: overview ? (
        <TrafficBytes bytes={overview.totalTrafficBytes ?? "0"} strong />
      ) : (
        "—"
      ),
      sub: overview ? (
        <TrafficSplit
          pair={{
            receivedBytes: overview.totalReceivedBytes ?? "0",
            sentBytes: overview.totalSentBytes ?? "0",
          }}
        />
      ) : null,
      icon: ArrowUpDown,
      tone: "chart-5",
      attention: false,
    },
    {
      label: t("ov.users"),
      value: overview?.totalUsers ?? users.length,
      sub: overview
        ? t("ov.usersSub", {
            active: overview.activeUsers ?? 0,
            disabled: overview.disabledUsers ?? 0,
          })
        : null,
      icon: Users,
      tone: "chart-3",
      attention: false,
    },
    {
      label: t("ov.nodesHealthy"),
      value: overview?.nodes
        ? `${overview.nodes.healthy}/${overview.nodes.total}`
        : `${nodes.length}`,
      icon: Server,
      tone: "chart-4",
      attention: false,
    },
    {
      label: t("ov.quotaRequests"),
      value: overview?.pendingQuotaRequests ?? pending.length,
      icon: AlertTriangle,
      tone: "chart-1",
      attention: (overview?.pendingQuotaRequests ?? pending.length) > 0,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <Card
            key={metric.label}
            className="transition-shadow hover:shadow-md"
          >
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{metric.label}</p>
                <p className="tabular truncate font-display text-2xl font-semibold">
                  {loading ? "—" : metric.value}
                </p>
                {!loading && metric.sub ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {metric.sub}
                  </p>
                ) : null}
              </div>
              <span
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                  metric.attention
                    ? "bg-warning/20 text-warning"
                    : METRIC_TONE[metric.tone],
                )}
              >
                <metric.icon className="h-5 w-5" />
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <DistributionCard
          title={t("ov.byProtocol")}
          data={overview?.keysByProtocol}
          labels={PROTOCOL_LABEL}
        />
        <DistributionCard
          title={t("ov.byRouting")}
          data={overview?.keysByProfile}
          labels={PROFILE_LABEL}
        />
        <DistributionCard
          title={t("ov.byStatus")}
          data={overview?.keysByState}
          labels={STATE_LABEL}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <Server className="h-4 w-4 text-chart-1" />
            {t("ov.serversTitle")}
            <span className="tabular text-sm font-normal text-muted-foreground">
              {nodes.length}
            </span>
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/nodes" prefetch={false}>
              {t("ov.showAll")} <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ov.noServers")}</p>
        ) : (
          <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node) => (
              <OverviewNodeCard
                key={node.id}
                node={node}
                checkResults={visibleChecks(node)}
              />
            ))}
          </div>
        )}
      </div>

      <TrafficSummary
        endpoint="/api/admin/traffic"
        title={t("ov.trafficSummary")}
      />

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-2 px-5 py-4">
            <h2 className="flex items-center gap-2 font-semibold">
              <Moon className="h-4 w-4 text-chart-3" />
              {t("ov.inactiveTitle", { days: INACTIVE_DAYS })}
              <span className="tabular text-sm font-normal text-muted-foreground">
                {inactiveUsers.length}
              </span>
            </h2>
            {inactiveUsers.length > 0 ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/users?filter=inactive" prefetch={false}>
                  {t("ov.showAll")} <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            ) : null}
          </div>
          {loading ? (
            <div className="space-y-2 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : inactiveUsers.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">
              {t("ov.allActiveSeen", { days: INACTIVE_DAYS })}
            </p>
          ) : (
            <ul className="divide-y">
              {inactiveUsers.slice(0, 6).map(({ user, lastSeen }) => (
                <li
                  key={user.id}
                  className="flex items-center justify-between gap-3 px-5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {user.displayName || user.email}
                    </div>
                    {user.displayName ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {formatLastSeen(lastSeen, now, lang)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-5 py-4">
            <h2 className="flex items-center gap-2 font-semibold">
              <Activity className="h-4 w-4 text-muted-foreground" />
              {t("ov.quotaReqTitle")}
            </h2>
            <span className="text-sm text-muted-foreground">
              {pending.length}
            </span>
          </div>
          {loading ? (
            <div className="space-y-2 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("ov.colEmployee")}</TableHead>
                  <TableHead>{t("ov.colTarget")}</TableHead>
                  <TableHead>{t("ov.colLimitChange")}</TableHead>
                  <TableHead>{t("ov.colReason")}</TableHead>
                  <TableHead>{t("ov.colDate")}</TableHead>
                  <TableHead className="text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((request) => {
                  const nodeId = request.nodeId ?? null;
                  const limitNow = currentLimit(request.userId, nodeId);
                  const replacedPerNode =
                    nodeId === null ? perNodeLimitCount(request.userId) : 0;
                  return (
                    <TableRow key={request.id}>
                      <TableCell className="font-medium">
                        {userEmail(request.userId)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {nodeId && modeFor(request.userId) === "per_node" ? (
                          request.nodeName ?? nodeId
                        ) : (
                          <span>{t("ov.quotaTargetAll")}</span>
                        )}
                        {nodeId && modeFor(request.userId) === "global" ? (
                          <p className="text-xs leading-snug text-muted-foreground">
                            {t("ov.quotaTargetCoerced", {
                              node: request.nodeName ?? nodeId,
                            })}
                          </p>
                        ) : null}
                        {replacedPerNode > 0 ? (
                          <p className="text-xs leading-snug text-muted-foreground">
                            {t("ov.quotaReplacesPerNode", {
                              count: replacedPerNode,
                            })}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className="text-muted-foreground">{limitNow}</span>
                        <span className="mx-1 text-muted-foreground">→</span>
                        <span className="font-semibold">
                          {request.requestedLimit}
                        </span>
                        <span className="ml-1 text-xs text-success">
                          (+{request.requestedLimit - limitNow})
                        </span>
                      </TableCell>
                      <TableCell className="max-w-xs text-sm text-muted-foreground">
                        {request.reason || "—"}
                      </TableCell>
                      <TableCell>{formatDate(request.createdAt, lang)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void action(
                                "quota-requests",
                                request.id,
                                "approve",
                              )
                            }
                          >
                            <Check className="h-4 w-4" /> {t("ov.approve")}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("ov.reject")}
                            onClick={() =>
                              void action("quota-requests", request.id, "reject")
                            }
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {pending.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-8 text-center text-muted-foreground"
                    >
                      {t("ov.noRequests")}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PanelUpdateCard />
    </div>
  );
}

/**
 * One server, summarised.
 *
 * Deliberately a reading surface: the same header, the same metrics renderer
 * and the same public-address cell as the nodes page, so the two read as one
 * product — but none of the controls. Everything that changes a node (the
 * enable switch, reconcile, agent update, capacity, edit, delete, the per-check
 * switches) lives one click away behind "show all", and everything an operator
 * only needs while acting on a node (the agent's API URL, protocol and
 * capability chips, health/sync timestamps, the agent-update banner, the full
 * text of a failing check) went with it. What is left is the question this page
 * exists to answer: is this server healthy, reachable and carrying traffic.
 */
function OverviewNodeCard({
  node,
  checkResults,
}: {
  node: AdminNode;
  checkResults: NodeCheckResult[];
}) {
  const { t } = useT();
  const peers = node.peerCount ?? 0;
  const fill = Math.min(100, (peers / Math.max(1, node.maxPeers)) * 100);
  const failing = checkResults.filter((result) => result.status !== "ok").length;

  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md",
        !node.enabled && "opacity-80",
      )}
    >
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
              <p className="truncate font-medium leading-tight">
                {node.publicName || node.name}
              </p>
              {/* The state in words, not only in the tile's colour: a coloured
                  square is not an answer to "what is wrong with it". */}
              <p className="truncate text-xs text-muted-foreground">
                {node.lastError ? (
                  <span className="text-destructive">
                    {t("nodes.commError")}
                  </span>
                ) : node.enabled ? (
                  t("nodes.working")
                ) : (
                  t("nodes.stopped")
                )}
                {node.publicName ? ` · ${node.name}` : null}
              </p>
            </div>
          </div>
          <span
            className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground"
            title={t("nodes.capacity")}
          >
            {peers}/{node.maxPeers}
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

        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 text-xs text-muted-foreground">
          <dt className="flex items-center gap-1">
            <Globe className="size-3.5 shrink-0" />
            <span>{t("nodes.publicAddress")}</span>
          </dt>
          <dd className="min-w-0 text-right text-foreground">
            <NodePublicAddress
              host={node.publicHost}
              ip={node.publicIp}
              resolvedAt={node.publicIpResolvedAt}
            />
          </dd>
        </dl>

        <div className="space-y-1.5 border-t pt-3">
          <NodeCardSection icon={Cpu}>{t("nodes.metrics.title")}</NodeCardSection>
          <NodeMetrics metrics={node.metrics} endpoint={node.endpoint} />
        </div>

        {checkResults.length > 0 ? (
          <div className="space-y-1.5 border-t pt-3">
            <NodeCardSection
              icon={ShieldCheck}
              action={
                failing > 0 ? (
                  <span className="text-[11px] font-medium text-destructive">
                    {t("ov.checksFailing", { count: failing })}
                  </span>
                ) : null
              }
            >
              {t("nodes.checks.title")}
            </NodeCardSection>
            <NodeCheckChips results={checkResults} />
          </div>
        ) : null}

        <div className="space-y-1.5 border-t pt-3">
          <NodeCardSection icon={ArrowUpDown}>{t("nodes.traffic")}</NodeCardSection>
          <InlineTraffic
            today={node.traffic?.today}
            week={node.traffic?.week}
            month={node.traffic?.month}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DistributionCard({
  title,
  data,
  labels,
}: {
  title: string;
  data?: Record<string, number>;
  labels: Record<string, string>;
}) {
  const { t } = useT();
  const entries = Object.entries(data ?? {}).filter(([, value]) => value > 0);
  const total = entries.reduce((acc, [, value]) => acc + value, 0);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-semibold">{title}</p>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("common.noData")}</p>
        ) : (
          <div className="space-y-2">
            {entries
              .sort((a, b) => b[1] - a[1])
              .map(([key, value], index) => (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {t(labels[key] ?? key)}
                    </span>
                    <span className="tabular font-medium">{value}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        BAR_TONE[index % BAR_TONE.length],
                      )}
                      style={{
                        width: `${total > 0 ? (value / total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
