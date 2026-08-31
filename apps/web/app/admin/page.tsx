"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Check,
  KeyRound,
  Moon,
  Server,
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
import { formatBytes, formatDate } from "@/lib/format";
import {
  INACTIVE_DAYS,
  formatLastSeen,
  isInactive,
  lastSeenFromKeys,
} from "@/lib/activity";
import { cn } from "@/lib/utils";
import { TrafficCard } from "@/components/traffic-card";
import { TrafficSplit } from "@/components/inline-traffic";
import { useAdminData } from "@/components/admin/admin-data";
import { PanelUpdateCard } from "@/components/admin/panel-update-card";
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
  const { overview, users, requests, nodes, keys, loading, action } =
    useAdminData();
  const { t, lang } = useT();

  const pending = requests.filter((request) => request.status === "pending");
  const userEmail = (id: string) =>
    users.find((user) => user.id === id)?.email ?? id;

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
      value: overview
        ? formatBytes(overview.totalTrafficBytes ?? "0", lang)
        : "—",
      sub: overview ? (
        <span className="inline-flex items-center gap-1 tabular-nums">
          <ArrowDown className="h-3 w-3 text-chart-2" />
          {formatBytes(overview.totalReceivedBytes ?? "0", lang)}
          <ArrowUp className="ml-0.5 h-3 w-3 text-chart-5" />
          {formatBytes(overview.totalSentBytes ?? "0", lang)}
        </span>
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node) => (
              <Card key={node.id} className="transition-shadow hover:shadow-md">
                <CardContent className="space-y-2.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "h-2.5 w-2.5 shrink-0 rounded-full",
                          node.lastError
                            ? "bg-destructive"
                            : node.enabled
                              ? "bg-success"
                              : "bg-muted-foreground",
                        )}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {node.publicName || node.name}
                        </p>
                        {node.publicName ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {node.name}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <span
                      className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground"
                      title={t("nodes.capacity")}
                    >
                      {node.peerCount ?? 0}/{node.maxPeers}
                    </span>
                  </div>
                  <dl className="space-y-1 border-t pt-2 text-xs">
                    {[
                      { label: t("traffic.rangeToday"), pair: node.traffic?.today },
                      { label: t("traffic.range7"), pair: node.traffic?.week },
                      { label: t("traffic.range30"), pair: node.traffic?.month },
                    ].map(({ label, pair }) => (
                      <div
                        key={label}
                        className="flex items-center justify-between gap-2"
                      >
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="text-foreground">
                          <TrafficSplit pair={pair} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <TrafficCard endpoint="/api/admin/traffic" title={t("ov.trafficByDay")} />

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
                  <TableHead>{t("ov.colNewLimit")}</TableHead>
                  <TableHead>{t("ov.colReason")}</TableHead>
                  <TableHead>{t("ov.colDate")}</TableHead>
                  <TableHead className="text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">
                      {userEmail(request.userId)}
                    </TableCell>
                    <TableCell className="font-semibold">
                      {request.requestedLimit}
                    </TableCell>
                    <TableCell className="max-w-xs text-sm text-muted-foreground">
                      {request.reason}
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
                ))}
                {pending.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
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
