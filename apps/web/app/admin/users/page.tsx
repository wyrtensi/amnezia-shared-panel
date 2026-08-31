"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ArrowDownUp,
  ArrowUpDown,
  Check,
  Download,
  KeyRound,
  ListFilter,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldOff,
  Sliders,
  Trash2,
  UserPlus,
  Users,
  Wifi,
} from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/status-badge";
import { Hint, FieldHint } from "@/components/ui/hint";
import { ProtocolSelect } from "@/components/protocol-select";
import { NodeSelect } from "@/components/node-select";
import type { ProtocolKind } from "@/lib/types";
import { formatBytes, formatTraffic } from "@/lib/format";
import {
  INACTIVE_DAYS,
  formatLastSeen,
  isInactive,
  lastSeenFromKeys,
} from "@/lib/activity";
import { cn } from "@/lib/utils";
import {
  useAdminData,
  type AdminKey,
  type AdminUser,
  type AdminNode,
} from "@/components/admin/admin-data";
import {
  AdminConfigDialog,
  type AdminConfigTarget,
} from "@/components/admin/admin-config-dialog";
import { useT } from "@/lib/i18n/provider";

const PROFILE_LABEL: Record<string, string> = {
  full_tunnel: "route.full_tunnel",
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};
const PROTOCOL_LABEL: Record<string, string> = {
  awg2: "protocol.awg2",
  awg3: "protocol.awg3",
};
const DEACTIVATION_LABEL: Record<string, string> = {
  admin_offboard: "users.deact.admin_offboard",
  access_removed: "users.deact.access_removed",
};

const POLICY_LABELS: Array<[string, string]> = [
  ["allowKeyCreation", "upolicy.allowKeyCreation"],
  ["allowNodeSelection", "upolicy.allowNodeSelection"],
  ["allowRouteProfileSelection", "upolicy.allowRouteProfileSelection"],
  ["allowCustomRoutes", "upolicy.allowCustomRoutes"],
  ["allowConfigRedownload", "upolicy.allowConfigRedownload"],
  ["allowQrDownload", "upolicy.allowQrDownload"],
  ["allowConfDownload", "upolicy.allowConfDownload"],
  ["allowSelfRevoke", "upolicy.allowSelfRevoke"],
  ["showLastUsed", "upolicy.showLastUsed"],
  ["showTraffic", "upolicy.showTraffic"],
];

function displayName(user: AdminUser): string {
  return user.displayName || user.email;
}

function initials(user: AdminUser): string {
  const base = user.displayName?.trim() || user.email;
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return (letters || base.slice(0, 2)).toUpperCase();
}

function sumTraffic(list: AdminKey[]): bigint {
  let total = 0n;
  for (const key of list) {
    if (!key.traffic) continue;
    try {
      total += BigInt(key.traffic.receivedBytes) + BigInt(key.traffic.sentBytes);
    } catch {
      /* ignore malformed counters */
    }
  }
  return total;
}

type UserStats = {
  total: number;
  active: number;
  online: number;
  traffic: bigint;
};

function statsFor(list: AdminKey[]): UserStats {
  return {
    total: list.length,
    active: list.filter((key) => key.state === "active").length,
    online: list.filter((key) => key.online).length,
    traffic: sumTraffic(list),
  };
}

type EnrichedUser = {
  user: AdminUser;
  keys: AdminKey[];
  stats: UserStats;
  lastSeen: number | null;
  inactive: boolean;
};

type FilterKey =
  | "all"
  | "inactive"
  | "online"
  | "nokeys"
  | "admins"
  | "disabled";
type SortKey = "activity" | "name" | "keys" | "traffic";

const FILTER_OPTIONS: Array<[FilterKey, string]> = [
  ["all", "users.filter.all"],
  ["inactive", "users.filter.inactive"],
  ["online", "users.filter.online"],
  ["nokeys", "users.filter.nokeys"],
  ["admins", "users.filter.admins"],
  ["disabled", "users.filter.disabled"],
];

const SORT_OPTIONS: Array<[SortKey, string]> = [
  ["name", "users.sort.name"],
  ["activity", "users.sort.activity"],
  ["keys", "users.sort.keys"],
  ["traffic", "users.sort.traffic"],
];

function matchesFilter(entry: EnrichedUser, filter: FilterKey): boolean {
  switch (filter) {
    case "inactive":
      return entry.inactive;
    case "online":
      return entry.stats.online > 0;
    case "nokeys":
      return entry.stats.total === 0;
    case "admins":
      return entry.user.role === "admin";
    case "disabled":
      return entry.user.status !== "active";
    default:
      return true;
  }
}

function sortEntries(entries: EnrichedUser[], sort: SortKey): EnrichedUser[] {
  const list = [...entries];
  switch (sort) {
    case "activity":
      // Least-active first: never-seen (null → 0) and oldest at the top.
      return list.sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
    case "keys":
      return list.sort((a, b) => b.stats.total - a.stats.total);
    case "traffic":
      return list.sort((a, b) =>
        a.stats.traffic < b.stats.traffic
          ? 1
          : a.stats.traffic > b.stats.traffic
            ? -1
            : 0,
      );
    default:
      return list.sort((a, b) =>
        displayName(a.user).localeCompare(displayName(b.user), "ru"),
      );
  }
}

export default function AdminUsersPage() {
  const { users, keys, nodes, policy, loading, action, request, reload } =
    useAdminData();
  const { t } = useT();
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [sort, setSort] = React.useState<SortKey>("name");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [limitUser, setLimitUser] = React.useState<AdminUser | null>(null);
  const [policyUser, setPolicyUser] = React.useState<AdminUser | null>(null);
  const [keyUser, setKeyUser] = React.useState<AdminUser | null>(null);
  const [configTarget, setConfigTarget] =
    React.useState<AdminConfigTarget | null>(null);

  const keysByOwner = React.useMemo(() => {
    const map = new Map<string, AdminKey[]>();
    for (const key of keys) {
      const list = map.get(key.ownerId);
      if (list) list.push(key);
      else map.set(key.ownerId, [key]);
    }
    return map;
  }, [keys]);

  // Preset the filter/sort from the query string (e.g. the overview screen
  // links here with ?filter=inactive to review dormant accounts).
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("filter");
    if (requested && FILTER_OPTIONS.some(([key]) => key === requested)) {
      setFilter(requested as FilterKey);
      if (requested === "inactive") setSort("activity");
    }
    const requestedSort = params.get("sort");
    if (requestedSort && SORT_OPTIONS.some(([key]) => key === requestedSort)) {
      setSort(requestedSort as SortKey);
    }
  }, []);

  const [now] = React.useState(() => Date.now());
  const enriched = React.useMemo<EnrichedUser[]>(() => {
    return users.map((user) => {
      const list = keysByOwner.get(user.id) ?? [];
      const lastSeen = lastSeenFromKeys(list);
      return {
        user,
        keys: list,
        stats: statsFor(list),
        lastSeen,
        inactive: user.status === "active" && isInactive(lastSeen, now),
      };
    });
  }, [users, keysByOwner, now]);

  const needle = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    const matched = enriched
      .filter((entry) => matchesFilter(entry, filter))
      .filter(
        (entry) =>
          !needle ||
          `${entry.user.displayName ?? ""} ${entry.user.email} ${entry.user.role}`
            .toLowerCase()
            .includes(needle),
      );
    return sortEntries(matched, sort);
  }, [enriched, filter, needle, sort]);

  const selected =
    filtered.find((entry) => entry.user.id === selectedId)?.user ??
    users.find((user) => user.id === selectedId) ??
    filtered[0]?.user ??
    null;

  const createUser = async (payload: {
    email: string;
    displayName?: string;
    role: string;
  }) => {
    try {
      const created = await request<{ id: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast.success(t("users.added"));
      await reload();
      setSelectedId(created.id);
      return true;
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("users.addFailed"),
      );
      return false;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-5 w-5 text-primary" />
            {t("users.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("users.summary", { users: users.length, keys: keys.length })}
            {filter !== "all" || needle
              ? t("users.summaryShown", { shown: filtered.length })
              : ""}
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("users.searchPlaceholder")}
            className="h-9 w-52 pl-8"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as FilterKey)}>
          <SelectTrigger className="h-9 w-[172px] gap-1.5">
            <ListFilter className="h-4 w-4 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPTIONS.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {t(label, { days: INACTIVE_DAYS })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="h-9 w-[168px] gap-1.5">
            <ArrowDownUp className="h-4 w-4 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => setCreateOpen(true)}>
          <UserPlus className="h-4 w-4" />
          {t("users.addBtn")}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[19rem_1fr]">
        {/* Master: compact user mini-cards */}
        <div className="space-y-2">
          {loading && users.length === 0 ? (
            [0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))
          ) : filtered.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                {users.length === 0
                  ? t("users.noUsers")
                  : t("common.notFound")}
              </CardContent>
            </Card>
          ) : (
            <div className="max-h-[calc(100vh-13rem)] space-y-2 overflow-y-auto pr-1">
              {filtered.map((entry) => (
                <UserMiniCard
                  key={entry.user.id}
                  user={entry.user}
                  stats={entry.stats}
                  lastSeen={entry.lastSeen}
                  inactive={entry.inactive}
                  now={now}
                  selected={selected?.id === entry.user.id}
                  onSelect={() => setSelectedId(entry.user.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail: selected user */}
        {selected ? (
          <UserDetail
            key={selected.id}
            user={selected}
            keys={keysByOwner.get(selected.id) ?? []}
            nodes={nodes}
            onSetRole={(role) => {
              const label =
                role === "admin"
                  ? t("users.roleAdminLabel")
                  : t("users.roleRemoveLabel");
              if (
                window.confirm(
                  t("users.roleConfirm", { label, email: selected.email }),
                )
              )
                void action("users", selected.id, "set-role", { role });
            }}
            onReinstate={() =>
              void action("users", selected.id, "reinstate")
            }
            onOffboard={() => {
              if (
                window.confirm(
                  t("users.offboardConfirm", { email: selected.email }),
                )
              )
                void action("users", selected.id, "offboard");
            }}
            onEditLimit={() => setLimitUser(selected)}
            onEditPolicy={() => setPolicyUser(selected)}
            onCreateKey={() => setKeyUser(selected)}
            onKeyAction={(id, name) => action("keys", id, name)}
            onExportKey={(id, deviceLabel) =>
              setConfigTarget({ id, deviceLabel })
            }
          />
        ) : (
          <Card>
            <CardContent className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
              {t("users.selectLeft")}
            </CardContent>
          </Card>
        )}
      </div>

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSave={createUser}
      />
      <LimitDialog
        user={limitUser}
        onClose={() => setLimitUser(null)}
        onSave={(value) =>
          action("users", limitUser!.id, "set-limit", {
            keyLimitOverride: value,
          })
        }
      />
      <PolicyDialog
        user={policyUser}
        globalPolicy={policy}
        nodes={nodes.map((node) => ({ id: node.id, name: node.name }))}
        onClose={() => setPolicyUser(null)}
        onSave={(next) => action("users", policyUser!.id, "set-policy", next)}
      />
      <CreateKeyDialog
        user={keyUser}
        nodes={nodes}
        onClose={() => setKeyUser(null)}
        onSave={(payload) =>
          action("users", keyUser!.id, "create-key", payload)
        }
      />
      <AdminConfigDialog
        target={configTarget}
        onClose={() => setConfigTarget(null)}
      />
    </div>
  );
}

function UserMiniCard({
  user,
  stats,
  lastSeen,
  inactive,
  now,
  selected,
  onSelect,
}: {
  user: AdminUser;
  stats: UserStats;
  lastSeen: number | null;
  inactive: boolean;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t, lang } = useT();
  const disabled = user.status !== "active";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-xl border bg-card p-2.5 text-left transition-all",
        "hover:border-primary/40 hover:shadow-sm active:scale-[0.99]",
        selected
          ? "border-primary/60 ring-2 ring-primary/25"
          : "border-border",
        disabled && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "relative flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            user.role === "admin"
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {initials(user)}
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card",
              stats.online > 0
                ? "bg-success"
                : disabled
                  ? "bg-destructive/60"
                  : inactive
                    ? "bg-chart-3"
                    : "bg-muted-foreground/30",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-medium leading-tight">
              {displayName(user)}
            </span>
            {user.role === "admin" ? (
              <Shield className="size-3 shrink-0 text-primary" />
            ) : null}
          </div>
          <div className="truncate text-xs leading-tight text-muted-foreground">
            {user.email}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tabular text-sm font-semibold leading-none">
            {stats.total}
          </div>
          <div className="text-[10px] text-muted-foreground">{t("users.keysWord")}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        {disabled ? (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {t("status.disabled")}
          </Badge>
        ) : stats.online > 0 ? (
          <span className="font-medium text-success">
            {t("users.onlineCount", { count: stats.online })}
          </span>
        ) : (
          <span className={inactive ? "text-chart-3" : undefined}>
            {formatLastSeen(lastSeen, now, lang)}
          </span>
        )}
        <span className="tabular ml-auto">
          {formatBytes(stats.traffic, lang)}
        </span>
      </div>
    </button>
  );
}

function UserDetail({
  user,
  keys,
  nodes,
  onSetRole,
  onReinstate,
  onOffboard,
  onEditLimit,
  onEditPolicy,
  onCreateKey,
  onKeyAction,
  onExportKey,
}: {
  user: AdminUser;
  keys: AdminKey[];
  nodes: AdminNode[];
  onSetRole: (role: string) => void;
  onReinstate: () => void;
  onOffboard: () => void;
  onEditLimit: () => void;
  onEditPolicy: () => void;
  onCreateKey: () => void;
  onKeyAction: (id: string, action: string) => Promise<boolean>;
  onExportKey: (id: string, deviceLabel: string) => void;
}) {
  const { t, lang } = useT();
  const stats = statsFor(keys);
  const disabled = user.status !== "active";
  const nodeName = (id: string) =>
    nodes.find((node) => node.id === id)?.name ?? id;
  const overrides = user.policyOverride
    ? Object.keys(user.policyOverride).length
    : 0;

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-4 p-4 sm:p-5">
        {/* Identity + management */}
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
            {initials(user)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{displayName(user)}</h3>
              {user.role === "admin" ? (
                <Badge className="gap-1">
                  <Shield className="size-3" /> {t("role.admin")}
                </Badge>
              ) : (
                <Badge variant="outline">{t("role.user")}</Badge>
              )}
              <Badge variant={disabled ? "secondary" : "success"}>
                {disabled ? t("status.disabled") : t("status.active")}
              </Badge>
              {disabled && user.deactivationReason ? (
                <Badge
                  variant={
                    user.deactivationReason === "access_removed"
                      ? "warning"
                      : "outline"
                  }
                >
                  {t(
                    DEACTIVATION_LABEL[user.deactivationReason] ??
                      user.deactivationReason,
                  )}
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {user.email}
            </p>
          </div>
        </div>

        {/* Management actions */}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={onEditLimit}>
            <Sliders className="h-4 w-4" />
            {t("users.limitNode")}{" "}
            {user.keyLimitOverride !== null
              ? user.keyLimitOverride
              : t("users.default")}
          </Button>
          <Button variant="outline" size="sm" onClick={onEditPolicy}>
            <Settings className="h-4 w-4" />
            {t("users.policies")}{overrides > 0 ? ` (${overrides})` : ""}
          </Button>
          {user.role === "admin" ? (
            <Button variant="outline" size="sm" onClick={() => onSetRole("user")}>
              <ShieldOff className="h-4 w-4" />
              {t("users.removeAdmin")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSetRole("admin")}
            >
              <Shield className="h-4 w-4" />
              {t("users.makeAdmin")}
            </Button>
          )}
          {disabled ? (
            <Button variant="outline" size="sm" onClick={onReinstate}>
              <Check className="h-4 w-4" />
              {t("users.reinstate")}
            </Button>
          ) : user.role !== "admin" ? (
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onOffboard}
            >
              <Trash2 className="h-4 w-4" />
              {t("users.delete")}
            </Button>
          ) : null}
        </div>

        {/* Aggregate stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            icon={<KeyRound className="h-4 w-4" />}
            tone="chart-1"
            label={t("users.statKeys")}
            value={stats.total}
          />
          <StatTile
            icon={<Check className="h-4 w-4" />}
            tone="chart-2"
            label={t("users.statActive")}
            value={stats.active}
          />
          <StatTile
            icon={<Wifi className="h-4 w-4" />}
            tone="chart-4"
            label={t("users.statOnline")}
            value={stats.online}
          />
          <StatTile
            icon={<ArrowUpDown className="h-4 w-4" />}
            tone="chart-5"
            label={t("users.statTraffic")}
            value={formatBytes(stats.traffic, lang)}
          />
        </div>

        {/* Keys */}
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            {t("users.keys")}
            <Hint>{t("users.keysHint")}</Hint>
          </h4>
          <Button size="sm" variant="secondary" onClick={onCreateKey}>
            <Plus className="h-4 w-4" />
            {t("users.keyBtn")}
          </Button>
        </div>

        {keys.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("users.noUserKeys")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {keys
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((key) => (
                <AdminKeyRow
                  key={key.id}
                  keyView={key}
                  nodeName={nodeName(key.nodeId)}
                  onAction={onKeyAction}
                  onExport={() => onExportKey(key.id, key.deviceLabel)}
                />
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const TONE_CLASS: Record<string, string> = {
  "chart-1": "bg-chart-1/12 text-chart-1",
  "chart-2": "bg-chart-2/12 text-chart-2",
  "chart-4": "bg-chart-4/15 text-chart-4",
  "chart-5": "bg-chart-5/12 text-chart-5",
};

function StatTile({
  icon,
  tone,
  label,
  value,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONE_CLASS;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-muted/40 p-2.5">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          TONE_CLASS[tone],
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="tabular truncate text-sm font-semibold leading-tight">
          {value}
        </div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function AdminKeyRow({
  keyView,
  nodeName,
  onAction,
  onExport,
}: {
  keyView: AdminKey;
  nodeName: string;
  onAction: (id: string, action: string) => Promise<boolean>;
  onExport: () => void;
}) {
  const { t, lang } = useT();
  const confirmAction = (name: string, message: string) => {
    if (window.confirm(message)) void onAction(keyView.id, name);
  };
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2 transition-colors hover:bg-accent/40">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          keyView.online ? "bg-success" : "bg-muted-foreground/30",
        )}
        title={keyView.online ? t("users.online") : t("users.offline")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {keyView.deviceLabel || keyView.deviceType}
          </span>
          {keyView.rulesOutdated ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <RefreshCw className="size-3 shrink-0 text-warning" />
              </TooltipTrigger>
              <TooltipContent>{t("users.rulesOutdatedTip")}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {nodeName} · {t(PROFILE_LABEL[keyView.routeProfile] ?? keyView.routeProfile)}{" "}
          · {t(PROTOCOL_LABEL[keyView.protocol] ?? keyView.protocol)}
        </div>
      </div>
      <span className="tabular hidden shrink-0 text-xs text-muted-foreground sm:block">
        {formatTraffic(keyView.traffic, lang)}
      </span>
      <StatusBadge value={keyView.state} />
      <div className="flex shrink-0 items-center gap-0.5">
        {keyView.state === "active" ? (
          <RowAction
            label={t("users.disable")}
            icon={<Lock className="h-4 w-4" />}
            onClick={() =>
              confirmAction(
                "disable",
                t("users.disableConfirm", { label: keyView.deviceLabel }),
              )
            }
          />
        ) : null}
        {keyView.state === "disabled" ? (
          <RowAction
            label={t("users.enable")}
            icon={<Check className="h-4 w-4" />}
            onClick={() =>
              confirmAction(
                "enable",
                t("users.enableConfirm", { label: keyView.deviceLabel }),
              )
            }
          />
        ) : null}
        {keyView.state === "active" ? (
          <RowAction
            label={t("users.exportConfig")}
            icon={<Download className="h-4 w-4" />}
            onClick={onExport}
          />
        ) : null}
        {["provisioning", "active", "disabled", "failed"].includes(
          keyView.state,
        ) ? (
          <RowAction
            label={t("users.revoke")}
            destructive
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() =>
              confirmAction(
                "revoke",
                t("users.revokeConfirm", { label: keyView.deviceLabel }),
              )
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function RowAction({
  label,
  icon,
  onClick,
  destructive,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "size-8",
            destructive && "text-muted-foreground hover:text-destructive",
          )}
          aria-label={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (payload: {
    email: string;
    displayName?: string;
    role: string;
  }) => Promise<boolean>;
}) {
  const { t } = useT();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("user");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setRole("user");
      setBusy(false);
    }
  }, [open]);
  const valid = /.+@.+\..+/.test(email.trim());
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("users.newUser")}</DialogTitle>
          <DialogDescription>
            {t("users.newUserDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-user-email">{t("users.email")}</Label>
            <Input
              id="new-user-email"
              type="email"
              autoFocus
              placeholder={t("users.emailPlaceholder")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-name">{t("users.nameOptional")}</Label>
            <Input
              id="new-user-name"
              maxLength={160}
              placeholder={t("users.namePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>{t("users.role")}</Label>
              <Hint>{t("users.roleHint")}</Hint>
            </div>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("role.user")}</SelectItem>
                <SelectItem value="admin">{t("role.admin")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() => {
              void (async () => {
                setBusy(true);
                const ok = await onSave({
                  email: email.trim(),
                  displayName: name.trim() || undefined,
                  role,
                });
                setBusy(false);
                if (ok) onClose();
              })();
            }}
          >
            {busy ? t("common.adding") : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LimitDialog({
  user,
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const { t } = useT();
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    setValue(
      user?.keyLimitOverride != null ? String(user.keyLimitOverride) : "",
    );
  }, [user]);
  return (
    <Dialog open={Boolean(user)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("users.limitTitle")}</DialogTitle>
          <DialogDescription>{user?.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="limit-input">
            {t("users.limitLabel")}
          </Label>
          <Input
            id="limit-input"
            type="number"
            min={0}
            max={1000}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              void (async () => {
                const parsed = value.trim() === "" ? null : Number(value);
                if (await onSave(parsed)) onClose();
              })();
            }}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PolicyDialog({
  user,
  globalPolicy,
  nodes,
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  globalPolicy: Record<string, unknown>;
  nodes: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (next: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useT();
  const [form, setForm] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    setForm(user?.policyOverride ?? {});
  }, [user]);

  const globalProtocols = (globalPolicy.allowedProtocols as
    | ProtocolKind[]
    | undefined) ?? ["awg3"];
  const overrideProtocols = form.allowedProtocols as ProtocolKind[] | undefined;
  const customProtocols = Array.isArray(overrideProtocols);

  const hasNodeOverride = "allowedNodeIds" in form;
  const overrideNodeIds = (form.allowedNodeIds as string[] | null | undefined) ??
    null;

  return (
    <Dialog open={Boolean(user)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("users.policyTitle")}</DialogTitle>
          <DialogDescription>
            {t("users.policyDesc", { email: user?.email ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border p-2.5">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                {t("users.customProtocols")}
                <Hint>
                  {t("users.customProtocolsHint", {
                    protocols: globalProtocols.join(", "),
                  })}
                </Hint>
              </span>
              <Switch
                checked={customProtocols}
                onCheckedChange={(checked) =>
                  setForm((current) => {
                    const next = { ...current };
                    if (checked) next.allowedProtocols = globalProtocols;
                    else delete next.allowedProtocols;
                    return next;
                  })
                }
              />
            </label>
            {customProtocols ? (
              <div className="mt-2.5">
                <ProtocolSelect
                  value={overrideProtocols ?? globalProtocols}
                  onChange={(nextProtocols) =>
                    setForm((current) => ({
                      ...current,
                      allowedProtocols: nextProtocols,
                    }))
                  }
                />
              </div>
            ) : null}
          </div>
          <div className="rounded-lg border p-2.5">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                {t("users.customNodes")}
                <Hint>{t("users.customNodesHint")}</Hint>
              </span>
              <Switch
                checked={hasNodeOverride}
                onCheckedChange={(checked) =>
                  setForm((current) => {
                    const next = { ...current };
                    if (checked)
                      next.allowedNodeIds =
                        (globalPolicy.allowedNodeIds as string[] | null) ?? null;
                    else delete next.allowedNodeIds;
                    return next;
                  })
                }
              />
            </label>
            {hasNodeOverride ? (
              <div className="mt-2.5">
                <NodeSelect
                  nodes={nodes}
                  value={overrideNodeIds}
                  onChange={(nextNodes) =>
                    setForm((current) => ({
                      ...current,
                      allowedNodeIds: nextNodes,
                    }))
                  }
                />
              </div>
            ) : null}
          </div>
          {POLICY_LABELS.map(([key, label]) => {
            const value = Boolean(form[key] ?? globalPolicy[key] ?? false);
            return (
              <label
                key={key}
                className="flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm"
              >
                {t(label)}
                <Switch
                  checked={value}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, [key]: checked }))
                  }
                />
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              void (async () => {
                if (await onSave(form)) onClose();
              })();
            }}
          >
            {t("users.savePolicies")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ADMIN_ROUTE_OPTIONS: Array<[string, string]> = [
  ["full_tunnel", "route.full_tunnel"],
  ["ru_whitelist", "route.ru_whitelist"],
  ["ru_blacklist", "route.ru_blacklist"],
];

function pickProtocol(node: AdminNode | undefined): string {
  const supported: ProtocolKind[] =
    node?.supportedProtocols && node.supportedProtocols.length > 0
      ? node.supportedProtocols
      : node
        ? [node.protocol as ProtocolKind]
        : ["awg3"];
  // Only offer protocols the node actually enables (mirrors the server's
  // computeSelectableProtocols); null/empty enabledProtocols means "all
  // supported". Otherwise the backend rejects with 403 PROTOCOL_NOT_ALLOWED.
  const offered =
    node?.enabledProtocols && node.enabledProtocols.length > 0
      ? supported.filter((protocol) => node.enabledProtocols?.includes(protocol))
      : supported;
  const pool = offered.length > 0 ? offered : supported;
  return pool.includes("awg3") ? "awg3" : (pool[0] ?? "awg3");
}

function CreateKeyDialog({
  user,
  nodes,
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  nodes: AdminNode[];
  onClose: () => void;
  onSave: (payload: {
    nodeId: string;
    deviceLabel: string;
    deviceType: string;
    routeProfile: string;
    protocol: string;
  }) => Promise<boolean>;
}) {
  const { t } = useT();
  const [nodeId, setNodeId] = React.useState("");
  const [deviceLabel, setDeviceLabel] = React.useState("");
  const [routeProfile, setRouteProfile] = React.useState("full_tunnel");
  React.useEffect(() => {
    const enabled = nodes.filter((node) => node.enabled);
    setNodeId(enabled[0]?.id ?? nodes[0]?.id ?? "");
    setDeviceLabel("");
    setRouteProfile("full_tunnel");
  }, [user, nodes]);
  const node = nodes.find((item) => item.id === nodeId);
  const protocol = pickProtocol(node);
  return (
    <Dialog open={Boolean(user)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("users.keyForTitle", { email: user?.email ?? "" })}</DialogTitle>
          <DialogDescription>
            {t("users.keyForDesc", {
              protocol: t(PROTOCOL_LABEL[protocol] ?? protocol),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("wizard.server")}</Label>
            <Select value={nodeId} onValueChange={setNodeId}>
              <SelectTrigger>
                <SelectValue placeholder={t("wizard.serverPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    disabled={!item.enabled}
                  >
                    {item.name}
                    {item.enabled ? "" : t("users.nodeDisabledSuffix")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>{t("wizard.routing")}</Label>
              <Hint>{t("users.routeHintAdmin")}</Hint>
            </div>
            <Select value={routeProfile} onValueChange={setRouteProfile}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADMIN_ROUTE_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {t(label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-key-label">{t("common.name")}</Label>
            <Input
              id="user-key-label"
              maxLength={80}
              placeholder={t("wizard.namePlaceholder")}
              value={deviceLabel}
              onChange={(event) => setDeviceLabel(event.target.value)}
            />
          </div>
          <FieldHint>
            {t("users.keyCreatedHint")}
          </FieldHint>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!nodeId}
            onClick={() => {
              void (async () => {
                if (
                  await onSave({
                    nodeId,
                    deviceLabel,
                    deviceType: "desktop",
                    routeProfile,
                    protocol,
                  })
                )
                  onClose();
              })();
            }}
          >
            {t("wizard.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
