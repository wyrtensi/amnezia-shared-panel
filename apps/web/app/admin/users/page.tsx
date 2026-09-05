"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowDownUp,
  ArrowUpDown,
  AtSign,
  Check,
  ChevronDown,
  Download,
  Globe,
  Info,
  KeyRound,
  ListFilter,
  Lock,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldOff,
  Sliders,
  Eraser,
  Trash2,
  UserPlus,
  Users,
  Wifi,
  X,
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
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/status-badge";
import { Hint, FieldHint, Callout } from "@/components/ui/hint";
import {
  accessDomainSchema,
  composeKeyDisplayName,
  defaultKeyNameDisplay,
  isPurgeableKeyState,
  isRevocableKeyState,
  normalizeAccessDomain,
  type KeyNameDisplay,
} from "@amnezia/contracts";
import { ProtocolSelect } from "@/components/protocol-select";
import type { KeyLimitMode, ProtocolKind } from "@/lib/types";
import { effectiveKeyLimitMode, isNodeFull } from "@/lib/key-quota";
import { trafficTotal } from "@/lib/format";
import { TrafficBytes } from "@/components/inline-traffic";
import {
  INACTIVE_DAYS,
  classifyKeyActivity,
  formatLastSeen,
  isInactive,
  isStaleActivity,
  lastSeenFromKeys,
  staleKeys as staleKeysOf,
  staleSince,
  summarizeStaleKeys,
  type StaleKeySummary,
} from "@/lib/activity";
import { cn } from "@/lib/utils";
import { deviceTypeLabel } from "@/lib/device-type";
import {
  useAdminData,
  type AdminKey,
  type AdminUser,
  type AdminNode,
  type GlobalPortalPolicy,
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
// Order of the toggles in the "name shown in the client" row; also the order
// composeKeyDisplayName joins the parts in.
const NAME_DISPLAY_PARTS = ["server", "label", "number"] as const;

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
  ["showNodeAddress", "upolicy.showNodeAddress"],
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

/**
 * The user's own key-limit mode, or null when they inherit the global one.
 * `policyOverride` is an untyped JSON blob, so an unrecognised value has to
 * read as "no override" instead of leaking into the UI.
 */
function modeOverrideOf(user: AdminUser): KeyLimitMode | null {
  const raw = user.policyOverride?.keyLimitMode;
  if (raw === "global") return "global";
  if (raw === "per_node") return "per_node";
  return null;
}

/**
 * The explicit per-user server list from `policyOverride.allowedNodeIds`, or
 * null when the global list applies. Same untyped-JSON caveat as above.
 */
function explicitNodeIdsOf(user: AdminUser): string[] | null {
  const raw: unknown = user.policyOverride?.allowedNodeIds;
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string")
    : null;
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
  /** Per-key handshake tally — see `summarizeStaleKeys` in lib/activity.ts. */
  staleness: StaleKeySummary;
};

type FilterKey =
  | "all"
  | "inactive"
  | "stalekeys"
  | "online"
  | "nokeys"
  | "admins"
  | "disabled";
type SortKey = "activity" | "name" | "keys" | "traffic" | "stale";

const FILTER_OPTIONS: Array<[FilterKey, string]> = [
  ["all", "users.filter.all"],
  // Two different questions, kept apart on purpose. "inactive" asks whether the
  // PERSON has gone quiet (their most recent key across the fleet);
  // "stalekeys" asks who is holding peers nobody connects with, which a user
  // with one live key and four dead ones answers yes to while reading active.
  ["inactive", "users.filter.inactive"],
  ["stalekeys", "users.filter.stalekeys"],
  ["online", "users.filter.online"],
  ["nokeys", "users.filter.nokeys"],
  ["admins", "users.filter.admins"],
  ["disabled", "users.filter.disabled"],
];

const SORT_OPTIONS: Array<[SortKey, string]> = [
  ["name", "users.sort.name"],
  ["activity", "users.sort.activity"],
  ["stale", "users.sort.stale"],
  ["keys", "users.sort.keys"],
  ["traffic", "users.sort.traffic"],
];

function matchesFilter(entry: EnrichedUser, filter: FilterKey): boolean {
  switch (filter) {
    case "inactive":
      return entry.inactive;
    case "stalekeys":
      return entry.staleness.stale > 0;
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

/** The lowercased part after the last "@", or "" when `email` has none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * The domain filter value to actually apply: `selected` itself when it is
 * still one of the domains present in `available`, otherwise the "all"
 * sentinel. Mirrors how `selected` (the chosen user) falls back below when
 * its id drops out of view — the underlying selection is never mutated, so a
 * domain that reappears (an admin's edit undone, the list reloaded) is
 * honoured again without the operator having to reselect it. Without this,
 * a domain that stops existing among the loaded users (renamed, offboarded,
 * the last of it removed) would leave the list showing nobody with no
 * visible reason why.
 */
export function resolveDomainFilter(
  selected: string,
  available: string[],
): string {
  return selected === "all" || available.includes(selected)
    ? selected
    : "all";
}

/**
 * Whether Cloudflare Access is configured enough for the panel's domain
 * write-back to actually reach Cloudflare — the same four fields
 * `getCloudflareConfig` in `apps/worker/src/postgresRepository.ts` requires
 * (account, app and policy id, plus a stored API token). All four are already
 * on the policy object this page holds, so this needs no extra request.
 * Gates the Access-domains editor: without this, claiming "the panel keeps
 * these domains in the Access policy" would not be true yet.
 */
export function isAccessConfigured(
  policy: Pick<
    GlobalPortalPolicy,
    "cfAccessAccountId" | "cfAccessAppId" | "cfAccessPolicyId" | "cfApiTokenSet"
  >,
): boolean {
  return Boolean(
    policy.cfAccessAccountId &&
      policy.cfAccessAppId &&
      policy.cfAccessPolicyId &&
      policy.cfApiTokenSet,
  );
}

function sortEntries(entries: EnrichedUser[], sort: SortKey): EnrichedUser[] {
  const list = [...entries];
  switch (sort) {
    case "activity":
      // Least-active first: never-seen (null → 0) and oldest at the top.
      return list.sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
    case "stale":
      // Most stale keys first, ties broken by the one stale longest.
      return list.sort(
        (a, b) =>
          b.staleness.stale - a.staleness.stale ||
          (a.staleness.oldestStaleSince ?? 0) -
            (b.staleness.oldestStaleSince ?? 0),
      );
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
  const [domain, setDomain] = React.useState("all");
  const [sort, setSort] = React.useState<SortKey>("name");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [accessDomainsOpen, setAccessDomainsOpen] = React.useState(false);
  const [limitUser, setLimitUser] = React.useState<AdminUser | null>(null);
  const [policyUser, setPolicyUser] = React.useState<AdminUser | null>(null);
  const [keyUser, setKeyUser] = React.useState<AdminUser | null>(null);
  const [staleUser, setStaleUser] = React.useState<AdminUser | null>(null);
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
        staleness: summarizeStaleKeys(list, now),
      };
    });
  }, [users, keysByOwner, now]);

  // Domains actually present among the loaded users, for the domain filter's
  // options — never free text, so the control cannot land on a value that
  // matches nobody by typo.
  const domainOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const entry of enriched) {
      const value = emailDomain(entry.user.email);
      if (value) set.add(value);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [enriched]);
  const activeDomain = resolveDomainFilter(domain, domainOptions);

  const needle = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    const matched = enriched
      .filter((entry) => matchesFilter(entry, filter))
      .filter(
        (entry) =>
          activeDomain === "all" || emailDomain(entry.user.email) === activeDomain,
      )
      .filter(
        (entry) =>
          !needle ||
          `${entry.user.displayName ?? ""} ${entry.user.email} ${entry.user.role}`
            .toLowerCase()
            .includes(needle),
      );
    return sortEntries(matched, sort);
  }, [enriched, filter, activeDomain, needle, sort]);

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

  /**
   * Run the stale-key cleanup: one revoke per key, in order, against the same
   * per-key route the trash button uses. Sequential rather than in parallel —
   * each call queues a job the worker has to take to a node, and a burst of
   * them buys nothing while making a partial failure harder to read.
   *
   * A key whose state moved under the operator (someone revoked it in another
   * tab, the worker finished a delete) is refused by the API with a 409 and
   * counted as failed rather than retried: the list they confirmed is no longer
   * what is on the server, and the reload below shows them what is.
   */
  const revokeStaleKeys = async (ids: string[]) => {
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await request(`/api/admin/keys/${id}/revoke`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) toast.error(t("users.staleDonePartial", { ok, failed }));
    else toast.success(t("users.staleDone", { ok }));
    setStaleUser(null);
    await reload();
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
            {filter !== "all" || activeDomain !== "all" || needle
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
        {domainOptions.length > 1 ? (
          <Select value={activeDomain} onValueChange={setDomain}>
            <SelectTrigger className="h-9 w-[172px] gap-1.5">
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("users.domainFilterAll")}</SelectItem>
              {domainOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
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
        {/* Siblings of the same size, kept in one wrapping unit so a narrow
            toolbar never splits them across two rows: both open a dialog, and
            neither should sit permanently open eating vertical space. Outline
            keeps adding a user the one primary action here. */}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setAccessDomainsOpen(true)}>
            <Globe className="h-4 w-4" />
            {t("users.accessDomainsBtn")}
            {(policy.cfAccessAllowedDomains ?? []).length > 0 ? (
              <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                {(policy.cfAccessAllowedDomains ?? []).length}
              </Badge>
            ) : null}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus className="h-4 w-4" />
            {t("users.addBtn")}
          </Button>
        </div>
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
                  staleCount={entry.staleness.stale}
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
            onCleanStale={() => setStaleUser(selected)}
            now={now}
            onKeyAction={(id, name, payload) =>
              action("keys", id, name, payload)
            }
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
      <AccessDomainsDialog
        open={accessDomainsOpen}
        onClose={() => setAccessDomainsOpen(false)}
        domains={policy.cfAccessAllowedDomains ?? []}
        configured={isAccessConfigured(policy)}
        onSave={(next) =>
          action("portal-policy", "global", "update", {
            cfAccessAllowedDomains: next,
          })
        }
      />
      <LimitDialog
        user={limitUser}
        nodes={nodes}
        globalPolicy={policy}
        onClose={() => setLimitUser(null)}
        onSave={(payload) =>
          action("users", limitUser!.id, "set-limit", payload)
        }
      />
      <PolicyDialog
        user={policyUser}
        globalPolicy={policy}
        onClose={() => setPolicyUser(null)}
        onSave={(next) => action("users", policyUser!.id, "set-policy", next)}
      />
      <CreateKeyDialog
        user={keyUser}
        nodes={nodes}
        globalPolicy={policy}
        userKeys={keyUser ? (keysByOwner.get(keyUser.id) ?? []) : []}
        onClose={() => setKeyUser(null)}
        onSave={(payload) =>
          action("users", keyUser!.id, "create-key", payload)
        }
      />
      <StaleKeysDialog
        user={staleUser}
        keys={staleUser ? (keysByOwner.get(staleUser.id) ?? []) : []}
        nodes={nodes}
        now={now}
        onClose={() => setStaleUser(null)}
        onConfirm={revokeStaleKeys}
      />
      <AdminConfigDialog
        target={configTarget}
        onClose={() => setConfigTarget(null)}
      />
    </div>
  );
}

/**
 * Appends `entry` to `list` unless an entry already there is the same domain.
 * Sameness is judged on the normalized form — `normalizeAccessDomain` from the
 * contracts package, the very spelling the server stores — so "@company.tld"
 * and "COMPANY.TLD" are recognised as the domain "company.tld" already in the
 * list. `entry` arrives already trimmed, non-empty and validated; the raw text
 * it was typed in is stored untouched for the server to normalize, so
 * `accessDomainSchema` stays the single source of truth on what a domain
 * looks like. This only stops a duplicate chip from appearing.
 */
export function addAccessDomain(list: string[], entry: string): string[] {
  const key = normalizeAccessDomain(entry);
  return list.some((item) => normalizeAccessDomain(item) === key)
    ? list
    : [...list, entry];
}

/**
 * i18n key for each way `accessDomainSchema` can refuse a domain, keyed by the
 * exact message the contract attaches to that refusal. Matching on the message
 * keeps the contract the single source of truth for WHAT is rejected while the
 * operator still reads the reason in their own language; a message reworded on
 * the contract side falls through to the generic key, and the test that pins
 * this map fails rather than the panel silently going vague.
 */
const ACCESS_DOMAIN_ERROR_KEYS: Record<string, string> = {
  "that is an address, add the user instead": "users.accessDomainErrEmail",
  "not a domain name": "users.accessDomainErrHostname",
};

/**
 * Checks one typed domain before it becomes a chip: the contract's own rules
 * first, then "already in this draft". Returns the i18n key of the reason so
 * the dialog can show it inline under the field instead of firing a toast the
 * operator has to read and dismiss before retyping.
 */
export function validateAccessDomain(
  entry: string,
  list: string[],
): { ok: true } | { ok: false; messageKey: string } {
  const parsed = accessDomainSchema.safeParse(entry);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "";
    return {
      ok: false,
      messageKey:
        ACCESS_DOMAIN_ERROR_KEYS[message] ?? "users.accessDomainErrGeneric",
    };
  }
  if (list.some((item) => normalizeAccessDomain(item) === parsed.data)) {
    return { ok: false, messageKey: "users.accessDomainErrDuplicate" };
  }
  return { ok: true };
}

/**
 * Admin-only editor for the domains the Cloudflare Access policy admits, plus
 * the honest summary of who can actually sign in. Posts only
 * `cfAccessAllowedDomains` — never the rest of the global policy row — so a
 * stale copy of unrelated fields can never overwrite a concurrent edit made
 * on the Policies page.
 *
 * Lives behind a button in the page toolbar, next to "add user", rather than
 * as a card standing permanently open: it is configuration an admin visits,
 * not something to read on every trip to the Users page.
 *
 * `configured` gates the whole editor on Cloudflare actually being set up
 * (account, app and policy id, plus a stored API token — see
 * `isAccessConfigured`). Without it, nothing typed here would ever reach
 * Cloudflare: the write-back silently no-ops on an unconfigured panel, so the
 * editor is shown plainly disabled with a pointer to where Cloudflare is
 * configured, rather than making promises a save cannot keep.
 *
 * The domains themselves are the subject: one readable row each inside a
 * scrolling frame, with a labelled Remove button rather than a cluster of
 * pills carrying a 12px cross. The "who can sign in" answer keeps every word
 * it had, but sits below the list behind a disclosure — it is read once, while
 * the list is why the dialog is open.
 *
 * Removing a domain is a two-step: a row's Remove only arms a confirmation
 * that spells out what dropping the rule costs (see
 * `users.accessDomainRemove*`), because the cost is invisible from here — the
 * people it locks out are exactly the ones who have no panel account yet.
 */
function AccessDomainsDialog({
  open,
  onClose,
  domains,
  configured,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  domains: string[];
  configured: boolean;
  onSave: (next: string[]) => Promise<boolean>;
}) {
  const { t } = useT();
  const [list, setList] = React.useState<string[]>(domains);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Follows the policy row like the Policies page's own form does, and starts
  // clean on every open: a draft abandoned by closing the dialog must not come
  // back later looking like it was saved.
  React.useEffect(() => {
    if (!open) return;
    setList(domains);
    setValue("");
    setError(null);
    setPendingRemoval(null);
  }, [open, domains]);
  const dirty = JSON.stringify(list) !== JSON.stringify(domains);

  const add = () => {
    const entry = value.trim();
    if (!entry) return;
    // Validated against the contract's own schema before it can become a chip,
    // so "someone@company.tld" or "tld" is refused right here with the reason,
    // instead of travelling to the API and coming back as a toast.
    const checked = validateAccessDomain(entry, list);
    if (!checked.ok) {
      setError(t(checked.messageKey, { value: entry }));
      return;
    }
    setValue("");
    setError(null);
    setList((current) => addAccessDomain(current, entry));
  };

  const save = async () => {
    setSaving(true);
    const ok = await onSave(list);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              {t("users.accessDomainsTitle")}
            </DialogTitle>
            <DialogDescription>{t("users.accessDomainsDesc")}</DialogDescription>
          </DialogHeader>

          {/* min-w-0: DialogContent is a grid, and a grid item's automatic
              minimum size is its min-content width. Without this a domain too
              long to fit — they are user-supplied, so one always turns up —
              widens the whole dialog and puts a horizontal scrollbar under it
              instead of being ellipsised by the row's `truncate`. */}
          <div className="min-w-0 space-y-3">
            {configured ? null : (
              <Callout
                tone="warning"
                title={t("users.accessDomainsDisabledTitle")}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/policy" prefetch={false}>
                      {t("users.accessDomainsDisabledLink")}
                    </Link>
                  </Button>
                }
              >
                {t("users.accessDomainsDisabledSummary")}
              </Callout>
            )}

            <div className="space-y-1.5">
              <div className="flex gap-2">
                <Input
                  value={value}
                  disabled={!configured}
                  aria-invalid={error !== null}
                  placeholder={t("users.accessDomainsPlaceholder")}
                  onChange={(event) => {
                    setValue(event.target.value);
                    // Clears as soon as the operator starts fixing it; a stale
                    // reason under a field they are already retyping is noise.
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  disabled={!configured}
                  aria-label={t("common.add")}
                  onClick={add}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {error ? (
                <p role="alert" className="text-xs leading-snug text-destructive">
                  {error}
                </p>
              ) : null}
            </div>

            {list.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("users.accessDomainsCount", { count: list.length })}
                </p>
                {/* One row per domain, not a cluster of pills: the list is what
                    this dialog exists for, so a domain is readable at a glance
                    and its removal is a button rather than a 12px cross. The
                    frame scrolls past a handful of rows instead of pushing the
                    footer off a short screen. */}
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border">
                  {list.map((domain) => (
                    <li
                      key={domain}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <AtSign className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono text-sm">
                          {domain}
                        </span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!configured}
                        onClick={() => setPendingRemoval(domain)}
                        className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={t("users.accessDomainRemoveAria", {
                          value: domain,
                        })}
                      >
                        <X className="h-4 w-4" />
                        {/* Named at every width, not just on a wide screen: a
                            bare cross is what this list had before, and the
                            confirmation it arms is worth announcing. The
                            domain beside it truncates instead. */}
                        {t("users.accessDomainsRemoveBtn")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              // An empty list gets the same frame as a full one, and says what
              // "empty" actually means for who can sign in — not just nothing.
              <div className="rounded-lg border border-dashed px-4 py-6 text-center">
                <Globe className="mx-auto h-6 w-6 text-muted-foreground/60" />
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {t("users.accessDomainsEmpty")}
                </p>
              </div>
            )}

            {/* The full "who can sign in" answer, kept word for word but folded
                below the list and closed by default: it is reference material
                an admin reads once, and five lines of it above the controls
                buried the domains this dialog is for. */}
            {configured ? (
              <details className="group rounded-lg border border-chart-4/40 bg-chart-4/10 px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  <Info className="h-4 w-4 shrink-0 text-chart-4" />
                  <span className="flex-1">{t("users.accessWhoTitle")}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {t("users.accessWhoSummary")}
                </p>
              </details>
            ) : null}

            <FieldHint>
              {configured
                ? t("users.accessDomainsHint")
                : t("users.accessDomainsDisabledHint")}
            </FieldHint>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!configured || !dirty || saving}
              onClick={() => void save()}
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AccessDomainRemoveDialog
        domain={pendingRemoval}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => {
          setList((current) =>
            current.filter((item) => item !== pendingRemoval),
          );
          setPendingRemoval(null);
        }}
      />
    </>
  );
}

/**
 * The confirmation behind a domain row's Remove. Every claim it makes is what
 * `createAccessSync` in apps/worker/src/accessReconcile.ts actually does, and
 * matches docs/CLOUDFLARE-ACCESS.md ("Panel-managed domains"):
 *
 *  - the removal is a draft until Save, and the save arms an Access sync run
 *    (CF_ACCESS_CONFIG_FIELDS in apps/control-api/src/postgresRepository.ts
 *    includes cfAccessAllowedDomains), so the rule goes on the next run;
 *  - nobody is disabled and no keys are revoked: the same PUT that drops the
 *    `email_domain` rule re-emits every active user's own `email` rule, since
 *    both come out of the one `include` list the sync computes;
 *  - the people who lose their way in are those on the domain with no active
 *    panel account — the domain rule was their only route, and it is also what
 *    lets `resolveIdentity` auto-provision them on first sign-in.
 */
function AccessDomainRemoveDialog({
  domain,
  onCancel,
  onConfirm,
}: {
  domain: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  // The domain outlives `domain` going null on purpose: the dialog plays a
  // close animation after that, and reading it straight would flash a title
  // and a warning with an empty name for the length of the fade.
  const [value, setValue] = React.useState(domain ?? "");
  React.useEffect(() => {
    if (domain !== null) setValue(domain);
  }, [domain]);
  return (
    <Dialog open={domain !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("users.accessDomainRemoveTitle", { value })}
          </DialogTitle>
          <DialogDescription>
            {t("users.accessDomainRemoveWhat", { value })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Callout tone="success" title={t("users.accessDomainRemoveKeepsTitle")}>
            {t("users.accessDomainRemoveKeeps")}
          </Callout>
          <Callout tone="danger" title={t("users.accessDomainRemoveCostTitle")}>
            {t("users.accessDomainRemoveCost", { value })}
          </Callout>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("users.accessDomainRemoveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The per-user cleanup of stale keys.
 *
 * It is N calls to the **existing** per-key revoke action — the same route the
 * trash button on a key row posts to — issued one at a time, so every one of
 * them is validated and audited on its own and nothing here bypasses the
 * Control API. There is deliberately no bulk endpoint: a single call that
 * decided for itself which keys are stale would put the criterion on the server
 * where the operator cannot see it before pressing the button.
 *
 * What it does NOT do matters as much as what it does, and the dialog says both
 * out loud before anything is queued:
 *
 *  - it revokes, it never purges. `key-purge` is irreversible and legal only
 *    for a key already `revoked` (docs/KEY-STATES.md); nothing here deletes a
 *    row, its traffic history or its audit trail, and the user can issue a new
 *    key straight away;
 *  - it only ever offers keys the staleness rule selected, and every one of
 *    them can be unticked. A key with a handshake inside the window, a key too
 *    young to have one yet, and a key in any state that holds no peer are not
 *    in the list at all;
 *  - it is a dialog with a named count on a destructive button, not a click on
 *    a row.
 */
function StaleKeysDialog({
  user,
  keys,
  nodes,
  now,
  onClose,
  onConfirm,
}: {
  user: AdminUser | null;
  keys: AdminKey[];
  nodes: AdminNode[];
  now: number;
  onClose: () => void;
  onConfirm: (ids: string[]) => Promise<void>;
}) {
  const { t, lang } = useT();
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const open = user !== null;
  // A fresh selection on every open, not merely on a change of user. The dialog
  // instance is reused, so without this a cancelled run leaves its unticked ids
  // behind: reopening it on the same person would show keys already excluded
  // for a reason nobody can see, and reopening it on the next person would skip
  // keys the operator never looked at.
  React.useEffect(() => {
    if (!open) return;
    setExcluded(new Set());
    setBusy(false);
  }, [open, user?.id]);

  // The subject outlives `user` going null, the same way AccessDomainRemoveDialog
  // holds its domain: the dialog plays a close animation afterwards, and reading
  // the live props straight would blank the name and empty the list for the
  // length of the fade — including right after a successful run, where the
  // reload has already dropped the keys that were just revoked.
  const [shown, setShown] = React.useState<{
    user: AdminUser;
    keys: AdminKey[];
  } | null>(null);
  React.useEffect(() => {
    if (user) setShown({ user, keys });
  }, [user, keys]);

  const rows = React.useMemo(
    () =>
      staleKeysOf(shown?.keys ?? [], now).map((key) => ({
        key,
        activity: classifyKeyActivity(key, now),
        since: staleSince(key, now),
      })),
    [shown, now],
  );
  const chosen = rows.filter(({ key }) => !excluded.has(key.id));
  const nodeName = (id: string) =>
    nodes.find((node) => node.id === id)?.name ?? id;

  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("users.staleTitle")}</DialogTitle>
          <DialogDescription>
            {t("users.staleDesc", {
              name: shown ? displayName(shown.user) : "",
              days: INACTIVE_DAYS,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Callout tone="danger" title={t("users.staleWillTitle")}>
            {t("users.staleWill")}
          </Callout>
          <Callout tone="success" title={t("users.staleKeepsTitle")}>
            {t("users.staleKeeps")}
          </Callout>
          <Callout tone="info" title={t("users.staleSkipsTitle")}>
            {t("users.staleSkips", { days: INACTIVE_DAYS })}
          </Callout>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || excluded.size === 0}
            onClick={() => setExcluded(new Set())}
          >
            {t("users.staleSelectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || chosen.length === 0}
            onClick={() => setExcluded(new Set(rows.map(({ key }) => key.id)))}
          >
            {t("users.staleClearAll")}
          </Button>
        </div>

        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {rows.map(({ key, activity, since }) => (
            <label
              key={key.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2 hover:bg-accent/40"
            >
              <Checkbox
                checked={!excluded.has(key.id)}
                disabled={busy}
                onChange={() => toggle(key.id)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {key.deviceLabel || deviceTypeLabel(t, key.deviceType)}
                  {key.internalName ? (
                    <span className="ml-1.5 text-xs italic text-muted-foreground/80">
                      {key.internalName}
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {nodeName(key.nodeId)} ·{" "}
                  {activity === "never"
                    ? t("users.staleNeverWhy", {
                        age: formatLastSeen(since, now, lang),
                      })
                    : t("users.staleIdleWhy", {
                        age: formatLastSeen(since, now, lang),
                      })}
                </div>
              </div>
              <StatusBadge value={key.state} />
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || chosen.length === 0}
            onClick={() => {
              setBusy(true);
              const ids = chosen.map(({ key }) => key.id);
              void onConfirm(ids).finally(() => setBusy(false));
            }}
          >
            {busy
              ? t("users.staleWorking")
              : t("users.staleConfirm", { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserMiniCard({
  user,
  stats,
  lastSeen,
  inactive,
  staleCount,
  now,
  selected,
  onSelect,
}: {
  user: AdminUser;
  stats: UserStats;
  lastSeen: number | null;
  inactive: boolean;
  staleCount: number;
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
        {/* Independent of the line beside it: this user can be online right
            now and still be holding keys nobody has connected with. */}
        {staleCount > 0 ? (
          <Badge variant="warning" className="h-4 px-1.5 text-[10px]">
            {t("users.staleBadge", { count: staleCount })}
          </Badge>
        ) : null}
        <TrafficBytes bytes={stats.traffic} className="ml-auto" />
      </div>
    </button>
  );
}

function UserDetail({
  user,
  keys,
  nodes,
  now,
  onSetRole,
  onReinstate,
  onOffboard,
  onEditLimit,
  onEditPolicy,
  onCreateKey,
  onCleanStale,
  onKeyAction,
  onExportKey,
}: {
  user: AdminUser;
  keys: AdminKey[];
  nodes: AdminNode[];
  now: number;
  onSetRole: (role: string) => void;
  onReinstate: () => void;
  onOffboard: () => void;
  onEditLimit: () => void;
  onEditPolicy: () => void;
  onCreateKey: () => void;
  onCleanStale: () => void;
  onKeyAction: (
    id: string,
    action: string,
    payload?: unknown,
  ) => Promise<boolean>;
  onExportKey: (id: string, deviceLabel: string) => void;
}) {
  const { t } = useT();
  const stats = statsFor(keys);
  const staleness = summarizeStaleKeys(keys, now);
  const disabled = user.status !== "active";
  const nodeName = (id: string) =>
    nodes.find((node) => node.id === id)?.name ?? id;
  const overrides = user.policyOverride
    ? Object.keys(user.policyOverride).length
    : 0;
  // How many servers carry their own key limit, shown on the limit button.
  const perNodeLimits = Object.keys(user.nodeKeyLimits ?? {}).length;
  // S7: the button summarises the whole limit state — the number, an explicit
  // mode override (the global mode is not repeated here), how many servers
  // carry their own limit, and the explicit server list when there is one.
  // Built as a single string so the same text can truncate and go into `title`.
  const modeOverride = modeOverrideOf(user);
  const explicitNodes = explicitNodeIdsOf(user);
  const limitSummary =
    `${t("users.limitNode")} ` +
    `${user.keyLimitOverride !== null ? user.keyLimitOverride : t("users.default")}` +
    (modeOverride === "global"
      ? ` · ${t("users.limitModeGlobalShort")}`
      : modeOverride === "per_node"
        ? ` · ${t("users.limitModePerNodeShort")}`
        : "") +
    (perNodeLimits > 0 ? ` (${perNodeLimits})` : "") +
    (explicitNodes !== null
      ? ` · ${
          explicitNodes.length > 0
            ? explicitNodes.map(nodeName).join(", ")
            : t("users.limitNoneWord")
        }`
      : "");

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
          {/* Adaptive width (answered question 5): every server name is written
              out and the row absorbs it; the label only truncates at the real
              edge of the available space, and `title` keeps the full text
              reachable by hover and by screen readers. */}
          <Button
            variant="outline"
            size="sm"
            className="min-w-0 max-w-full"
            title={limitSummary}
            onClick={onEditLimit}
          >
            <Sliders className="h-4 w-4" />
            <span className="truncate">{limitSummary}</span>
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
            value={<TrafficBytes bytes={stats.traffic} strong />}
          />
        </div>

        {/* Keys */}
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            {t("users.keys")}
            <Hint>{t("users.keysHint")}</Hint>
          </h4>
          <div className="flex items-center gap-1.5">
            {/* Only appears when there is something to clean, and it opens a
                dialog rather than acting — see StaleKeysDialog. */}
            {staleness.stale > 0 ? (
              <Button size="sm" variant="outline" onClick={onCleanStale}>
                <Moon className="h-4 w-4" />
                {t("users.staleCleanupBtn", { count: staleness.stale })}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={onCreateKey}>
              <Plus className="h-4 w-4" />
              {t("users.keyBtn")}
            </Button>
          </div>
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
                  now={now}
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
  now,
  onAction,
  onExport,
}: {
  keyView: AdminKey;
  nodeName: string;
  now: number;
  onAction: (
    id: string,
    action: string,
    payload?: unknown,
  ) => Promise<boolean>;
  onExport: () => void;
}) {
  const { t, lang } = useT();
  // Why this row is on the cleanup list, said on the row itself, so the count
  // on the button above is checkable without opening the dialog.
  const activity = classifyKeyActivity(keyView, now);
  const staleWhy = isStaleActivity(activity)
    ? activity === "never"
      ? t("users.staleNeverWhy", {
          age: formatLastSeen(staleSince(keyView, now), now, lang),
        })
      : t("users.staleIdleWhy", {
          age: formatLastSeen(staleSince(keyView, now), now, lang),
        })
    : null;
  const confirmAction = (name: string, message: string) => {
    if (window.confirm(message)) void onAction(keyView.id, name);
  };
  const renameInternal = () => {
    // Same idiom as the confirmations on this row. An empty answer clears the
    // note; Cancel (null) leaves it alone, which are different answers.
    const next = window.prompt(
      t("users.internalNamePrompt"),
      keyView.internalName ?? "",
    );
    if (next === null) return;
    void onAction(keyView.id, "set-internal-name", {
      internalName: next.slice(0, 80),
    });
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
            {keyView.deviceLabel || deviceTypeLabel(t, keyView.deviceType)}
          </span>
          {keyView.rulesOutdated ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <RefreshCw className="size-3 shrink-0 text-warning" />
              </TooltipTrigger>
              <TooltipContent>{t("users.rulesOutdatedTip")}</TooltipContent>
            </Tooltip>
          ) : null}
          {staleWhy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Moon className="size-3 shrink-0 text-chart-3" />
              </TooltipTrigger>
              <TooltipContent>
                {t("users.staleKeyTip")} — {staleWhy}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {nodeName} · {t(PROFILE_LABEL[keyView.routeProfile] ?? keyView.routeProfile)}{" "}
          · {t(PROTOCOL_LABEL[keyView.protocol] ?? keyView.protocol)}
        </div>
        {/* Operators only. Never shown to the key's owner and never part of a
            config, so it can say who the key is really for. */}
        {keyView.internalName ? (
          <div className="truncate text-xs italic text-muted-foreground/80">
            {keyView.internalName}
          </div>
        ) : null}
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
        <TrafficBytes bytes={trafficTotal(keyView.traffic)} />
      </span>
      <StatusBadge value={keyView.state} />
      <div className="flex shrink-0 items-center gap-0.5">
        <RowAction
          label={t("users.internalName")}
          icon={<Pencil className="h-4 w-4" />}
          onClick={renameInternal}
        />
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
        {/* Includes `revoking`: that is where a delete waits when the node was
            unreachable, and the retry is what unsticks it. The list comes from
            the contract so the button and the route cannot disagree. */}
        {isRevocableKeyState(keyView.state) ? (
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
        {/* Only `revoked`: the node has confirmed the peer is gone, so the row
            is history and nothing on a node depends on it any more. This
            deletes the row itself, which is why it is a separate action from
            the delete above rather than a second click on it. */}
        {isPurgeableKeyState(keyView.state) ? (
          <RowAction
            label={t("users.purge")}
            destructive
            icon={<Eraser className="h-4 w-4" />}
            onClick={() =>
              confirmAction(
                "purge",
                t("users.purgeConfirm", { label: keyView.deviceLabel }),
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

/**
 * Parses one limit field: an empty field means "inherit", `undefined` marks a
 * value the API would reject (so the dialog can block the save instead).
 */
function parseLimitField(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 1000) return undefined;
  return value;
}

type LimitPayload = {
  keyLimitOverride: number | null;
  allowedNodeIds: string[] | null;
  nodeKeyLimits: Record<string, number> | null;
  /** null clears the per-user override, i.e. inherit the global mode. */
  keyLimitMode: KeyLimitMode | null;
};

/**
 * Servers and quotas of a single user: the default limit, which servers the
 * user may use, and a per-server limit. Node availability has three states —
 * "all servers" (sent as `allowedNodeIds: null`, so the global list applies
 * again), an explicit list, and an empty list (no server at all).
 */
function LimitDialog({
  user,
  nodes,
  globalPolicy,
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  nodes: AdminNode[];
  globalPolicy: GlobalPortalPolicy;
  onClose: () => void;
  onSave: (payload: LimitPayload) => Promise<boolean>;
}) {
  const { t } = useT();
  const [value, setValue] = React.useState("");
  const [allNodes, setAllNodes] = React.useState(true);
  const [allowed, setAllowed] = React.useState<string[]>([]);
  const [nodeLimits, setNodeLimits] = React.useState<Record<string, string>>({});
  // "" = inherit the global mode; otherwise an explicit per-user mode.
  const [mode, setMode] = React.useState<"" | KeyLimitMode>("");

  React.useEffect(() => {
    setValue(
      user?.keyLimitOverride != null ? String(user.keyLimitOverride) : "",
    );
    // The per-user node list lives in policyOverride.allowedNodeIds; missing or
    // null there means the global list applies.
    const override = user?.policyOverride?.allowedNodeIds as
      | string[]
      | null
      | undefined;
    setAllNodes(!Array.isArray(override));
    setAllowed(Array.isArray(override) ? [...override] : []);
    setNodeLimits(
      Object.fromEntries(
        Object.entries(user?.nodeKeyLimits ?? {}).map(([nodeId, limit]) => [
          nodeId,
          String(limit),
        ]),
      ),
    );
    setMode(user ? (modeOverrideOf(user) ?? "") : "");
  }, [user]);

  const globalNodeIds = globalPolicy.allowedNodeIds;
  // Placeholder of the per-server inputs: what a server without its own limit
  // ends up using, recomputed live from the default field above.
  const parsedDefault = parseLimitField(value);
  const fallbackLimit =
    typeof parsedDefault === "number"
      ? parsedDefault
      : globalPolicy.defaultKeyLimit;

  // What the API will actually enforce for this user once saved, so the labels
  // and the dormant per-server inputs follow the select without a round-trip.
  const effectiveMode = effectiveKeyLimitMode(
    globalPolicy.keyLimitMode,
    mode === "" ? undefined : mode,
  );
  const globalModeLabel =
    globalPolicy.keyLimitMode === "global"
      ? t("users.limitModeGlobal")
      : t("users.limitModePerNode");

  const isAvailable = (nodeId: string) =>
    allNodes
      ? globalNodeIds === null || globalNodeIds.includes(nodeId)
      : allowed.includes(nodeId);

  const toggleNode = (nodeId: string, checked: boolean) =>
    setAllowed((current) =>
      checked
        ? current.includes(nodeId)
          ? current
          : [...current, nodeId]
        : current.filter((id) => id !== nodeId),
    );

  const valid =
    parsedDefault !== undefined &&
    Object.values(nodeLimits).every(
      (raw) => parseLimitField(raw) !== undefined,
    );
  const noneSelected = !allNodes && allowed.length === 0;

  return (
    <Dialog open={Boolean(user)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("users.limitTitle")}</DialogTitle>
          <DialogDescription>
            {t("users.limitDesc", { email: user?.email ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="limit-input">
              {effectiveMode === "global"
                ? t("users.limitLabelGlobal")
                : t("users.limitLabel")}
            </Label>
            <Input
              id="limit-input"
              type="number"
              min={0}
              max={1000}
              placeholder={String(globalPolicy.defaultKeyLimit)}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <FieldHint>
              {t(
                effectiveMode === "global"
                  ? "users.limitLabelGlobalHint"
                  : "users.limitLabelHint",
                { value: globalPolicy.defaultKeyLimit },
              )}
            </FieldHint>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="limit-mode">{t("users.limitMode")}</Label>
              <Hint>{t("users.limitModeHint")}</Hint>
            </div>
            <Select
              value={mode === "" ? "inherit" : mode}
              onValueChange={(next) =>
                setMode(next === "inherit" ? "" : (next as KeyLimitMode))
              }
            >
              <SelectTrigger id="limit-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">
                  {t("users.limitModeInherit", { mode: globalModeLabel })}
                </SelectItem>
                <SelectItem value="per_node">
                  {t("users.limitModePerNode")}
                </SelectItem>
                <SelectItem value="global">
                  {t("users.limitModeGlobal")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border p-2.5">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                {t("users.limitAllNodes")}
                <Hint>{t("users.limitAllNodesHint")}</Hint>
              </span>
              <Switch
                checked={allNodes}
                onCheckedChange={(checked) => {
                  setAllNodes(checked);
                  // Leaving "all servers" starts from what the user sees today,
                  // so turning the switch off does not silently revoke access.
                  if (!checked && allowed.length === 0) {
                    setAllowed(
                      nodes
                        .map((node) => node.id)
                        .filter(
                          (id) =>
                            globalNodeIds === null || globalNodeIds.includes(id),
                        ),
                    );
                  }
                }}
              />
            </label>
            {allNodes && globalNodeIds !== null ? (
              <FieldHint className="mt-2">
                {t("users.limitGlobalNodes", {
                  nodes:
                    nodes
                      .filter((node) => globalNodeIds.includes(node.id))
                      .map((node) => node.name)
                      .join(", ") || t("users.limitNoneWord"),
                })}
              </FieldHint>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <Label>{t("users.limitPerNode")}</Label>
                <Hint>{t("users.limitPerNodeHint")}</Hint>
              </div>
              <span className="text-xs text-muted-foreground">
                {t("users.limitColumnLimit")}
              </span>
            </div>
            {/* S3: the numbers stay in the database, they are just not enforced
                while the pool is in charge. */}
            {effectiveMode === "global" ? (
              <FieldHint>{t("users.limitPerNodeDormant")}</FieldHint>
            ) : null}
            {nodes.length === 0 ? (
              <FieldHint>{t("nodeSelect.noNodes")}</FieldHint>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    className="flex items-center gap-2.5 rounded-lg border p-2"
                  >
                    <Checkbox
                      id={`limit-node-${node.id}`}
                      checked={isAvailable(node.id)}
                      disabled={allNodes}
                      onChange={(event) =>
                        toggleNode(node.id, event.target.checked)
                      }
                    />
                    <Label
                      htmlFor={`limit-node-${node.id}`}
                      className={cn(
                        "min-w-0 flex-1 cursor-pointer truncate font-normal",
                        allNodes && "cursor-default",
                      )}
                    >
                      {node.name}
                      {node.enabled ? "" : t("users.nodeDisabledSuffix")}
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      max={1000}
                      aria-label={t("users.limitPerNodeAria", {
                        node: node.name,
                      })}
                      disabled={effectiveMode === "global"}
                      placeholder={String(fallbackLimit)}
                      className="h-8 w-20 shrink-0"
                      value={nodeLimits[node.id] ?? ""}
                      onChange={(event) =>
                        setNodeLimits((current) => ({
                          ...current,
                          [node.id]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {noneSelected ? (
              <FieldHint className="text-destructive">
                {t("users.limitNoNodesWarning")}
              </FieldHint>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              void (async () => {
                const known = new Set(nodes.map((node) => node.id));
                const limits: Record<string, number> = {};
                for (const [nodeId, raw] of Object.entries(nodeLimits)) {
                  // Drop entries for nodes that no longer exist: the API
                  // rejects unknown ids with NODE_NOT_FOUND.
                  if (!known.has(nodeId)) continue;
                  const parsed = parseLimitField(raw);
                  if (typeof parsed === "number") limits[nodeId] = parsed;
                }
                const ok = await onSave({
                  keyLimitOverride: parsedDefault ?? null,
                  allowedNodeIds: allNodes
                    ? null
                    : allowed.filter((id) => known.has(id)),
                  nodeKeyLimits:
                    Object.keys(limits).length > 0 ? limits : null,
                  // The select shows "inherit" exactly when there is no
                  // override, so sending null here never clears a mode the
                  // admin did not mean to clear.
                  keyLimitMode: mode === "" ? null : mode,
                });
                if (ok) onClose();
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
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  globalPolicy: Record<string, unknown>;
  onClose: () => void;
  onSave: (next: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useT();
  // The form is seeded from the stored override and sent back whole, because
  // `set-policy` replaces `policyOverride` with exactly the fields the payload
  // names. So keys this dialog has no control over -- `allowedNodeIds` and
  // `keyLimitMode`, both written by the servers-and-limits dialog -- must be
  // carried through unchanged; dropping them would silently delete the user's
  // server list and pin/unpin their limit mode on an unrelated toggle save.
  // Nothing here ever introduces `keyLimitMode`: it can only be in the payload
  // when the user already had that override.
  const [form, setForm] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    setForm(user?.policyOverride ?? {});
  }, [user]);

  const globalProtocols = (globalPolicy.allowedProtocols as
    | ProtocolKind[]
    | undefined) ?? ["awg3"];
  const overrideProtocols = form.allowedProtocols as ProtocolKind[] | undefined;
  const customProtocols = Array.isArray(overrideProtocols);

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
          {/* Node availability moved into the servers-and-limits dialog, where
              it sits next to the per-server key limit it belongs with. */}
          <div className="rounded-lg border border-dashed p-2.5">
            <FieldHint>{t("users.nodesMovedHint")}</FieldHint>
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

// Key states that count against a user's per-node quota; mirrors the control
// API's `quotaStates` so the dialog shows the same numbers the server enforces.
const QUOTA_STATES = ["provisioning", "active", "disabled"];

function CreateKeyDialog({
  user,
  nodes,
  globalPolicy,
  userKeys,
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  nodes: AdminNode[];
  /** Global policy: the fallback limit and the key limit mode. */
  globalPolicy: GlobalPortalPolicy;
  /** The target user's existing keys — used to estimate the next key number. */
  userKeys: AdminKey[];
  onClose: () => void;
  onSave: (payload: {
    nodeId: string;
    deviceLabel: string;
    deviceType: string;
    routeProfile: string;
    protocol: string;
    nameDisplay: KeyNameDisplay;
  }) => Promise<boolean>;
}) {
  const { t } = useT();
  const [nodeId, setNodeId] = React.useState("");
  const [deviceLabel, setDeviceLabel] = React.useState("");
  const [routeProfile, setRouteProfile] = React.useState("full_tunnel");
  const [nameDisplay, setNameDisplay] = React.useState<KeyNameDisplay>(() => ({
    ...defaultKeyNameDisplay,
  }));
  // Quota of the target user per server. In per-node mode each server has its
  // own limit, so a full one is excluded on its own; in global mode one shared
  // pool decides, so a full pool closes every server at once (S2).
  const quotaByNode = React.useMemo(() => {
    const mode = effectiveKeyLimitMode(
      globalPolicy.keyLimitMode,
      user?.policyOverride?.keyLimitMode,
    );
    const used = new Map<string, number>();
    let total = 0;
    for (const key of userKeys) {
      if (!QUOTA_STATES.includes(key.state)) continue;
      used.set(key.nodeId, (used.get(key.nodeId) ?? 0) + 1);
      total += 1;
    }
    const pool = user?.keyLimitOverride ?? globalPolicy.defaultKeyLimit;
    return new Map(
      nodes.map((item) => {
        // S3: per-server numbers are dormant in global mode, so the pool is
        // what the admin is shown against.
        const limit =
          mode === "global" ? pool : (user?.nodeKeyLimits?.[item.id] ?? pool);
        const count = used.get(item.id) ?? 0;
        return [
          item.id,
          {
            used: count,
            limit,
            full: isNodeFull(
              mode,
              { nodeId: item.id, used: count, limit },
              { used: total, limit: pool },
            ),
          },
        ];
      }),
    );
  }, [nodes, userKeys, user, globalPolicy]);

  // Read through a ref so a background refresh of `userKeys` cannot re-run the
  // reset effect below and wipe what the admin already filled in.
  const quotaRef = React.useRef(quotaByNode);
  React.useEffect(() => {
    quotaRef.current = quotaByNode;
  }, [quotaByNode]);

  React.useEffect(() => {
    const enabled = nodes.filter((node) => node.enabled);
    const withRoom = enabled.filter(
      (node) => !quotaRef.current.get(node.id)?.full,
    );
    setNodeId(withRoom[0]?.id ?? enabled[0]?.id ?? nodes[0]?.id ?? "");
    setDeviceLabel("");
    setRouteProfile("full_tunnel");
    setNameDisplay({ ...defaultKeyNameDisplay });
  }, [user, nodes]);
  const node = nodes.find((item) => item.id === nodeId);
  const protocol = pickProtocol(node);

  // Estimated only: the control API assigns the real number on provisioning.
  const nextKeyNumber =
    userKeys.reduce((max, key) => Math.max(max, key.keyNumber ?? 0), 0) + 1;
  const previewName = composeKeyDisplayName({
    serverName: node?.publicName?.trim() || node?.name || "",
    label: deviceLabel.trim(),
    keyNumber: nextKeyNumber,
    display: nameDisplay,
  });
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
                {nodes.map((item) => {
                  const quota = quotaByNode.get(item.id);
                  return (
                    <SelectItem
                      key={item.id}
                      value={item.id}
                      disabled={!item.enabled || quota?.full}
                    >
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="truncate">
                          {item.name}
                          {item.enabled ? "" : t("users.nodeDisabledSuffix")}
                        </span>
                        {quota ? (
                          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                            {t("wizard.serverQuota", {
                              used: quota.used,
                              limit: quota.limit,
                            })}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
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
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>{t("wizard.nameDisplay")}</Label>
              <Hint>{t("wizard.nameDisplayHint")}</Hint>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {NAME_DISPLAY_PARTS.map((part) => (
                <div key={part} className="flex items-center gap-2">
                  <Checkbox
                    id={`admin-key-name-${part}`}
                    checked={nameDisplay[part]}
                    onChange={(event) =>
                      setNameDisplay((prev) => ({
                        ...prev,
                        [part]: event.target.checked,
                      }))
                    }
                  />
                  <Label
                    htmlFor={`admin-key-name-${part}`}
                    className="cursor-pointer font-normal"
                  >
                    {t(`wizard.nameDisplay.${part}`)}
                  </Label>
                </div>
              ))}
            </div>
            <FieldHint>
              {t("wizard.nameDisplayPreview", { value: previewName })}
            </FieldHint>
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
                    // This dialog has no device-type field, so the panel does
                    // not know the platform. It used to claim "desktop".
                    deviceType: "unspecified",
                    routeProfile,
                    protocol,
                    nameDisplay,
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
