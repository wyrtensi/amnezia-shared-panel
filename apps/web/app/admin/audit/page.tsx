"use client";

import * as React from "react";
import {
  CheckCircle2,
  Circle,
  KeyRound,
  Search,
  Settings,
  Shield,
  Trash2,
  UserCog,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAdminData, type AuditEvent } from "@/components/admin/admin-data";
import {
  AUDIT_CATEGORIES,
  auditCategoryOf,
  auditRowMatches,
  type AuditCategory,
  type AuditScope,
} from "@/lib/audit-filter";
import { useT } from "@/lib/i18n/provider";

type Tone = "neutral" | "success" | "danger" | "warning";
type Translate = (key: string, vars?: Record<string, string | number>) => string;

const VERB: Record<string, { textKey: string; tone: Tone }> = {
  create: { textKey: "audit.verb.create", tone: "success" },
  "create-key": { textKey: "audit.verb.create-key", tone: "success" },
  disable: { textKey: "audit.verb.disable", tone: "warning" },
  enable: { textKey: "audit.verb.enable", tone: "success" },
  revoke: { textKey: "audit.verb.revoke", tone: "danger" },
  offboard: { textKey: "audit.verb.offboard", tone: "danger" },
  reinstate: { textKey: "audit.verb.reinstate", tone: "success" },
  "set-limit": { textKey: "audit.verb.set-limit", tone: "neutral" },
  "set-policy": { textKey: "audit.verb.set-policy", tone: "neutral" },
  "set-role": { textKey: "audit.verb.set-role", tone: "warning" },
  reconcile: { textKey: "audit.verb.reconcile", tone: "neutral" },
  update: { textKey: "audit.verb.update", tone: "neutral" },
  activate: { textKey: "audit.verb.activate", tone: "success" },
  seed: { textKey: "audit.verb.seed", tone: "success" },
  approve: { textKey: "audit.verb.approve", tone: "success" },
  reject: { textKey: "audit.verb.reject", tone: "danger" },
};

const RESOURCE: Record<string, string> = {
  users: "audit.res.users",
  keys: "audit.res.keys",
  nodes: "audit.res.nodes",
  "quota-requests": "audit.res.quota-requests",
  "portal-policy": "audit.res.portal-policy",
  rules: "audit.res.rules",
};

const EXACT: Record<string, { textKey: string; tone: Tone }> = {
  "vpn_key.create_requested": {
    textKey: "audit.exact.vpn_key.create_requested",
    tone: "success",
  },
  "vpn_key.revoke_requested": {
    textKey: "audit.exact.vpn_key.revoke_requested",
    tone: "danger",
  },
  "vpn_key.rotate_requested": {
    textKey: "audit.exact.vpn_key.rotate_requested",
    tone: "warning",
  },
  "vpn_key.private_config_viewed": {
    textKey: "audit.exact.vpn_key.private_config_viewed",
    tone: "warning",
  },
  "node.created": { textKey: "audit.exact.node.created", tone: "success" },
  "node.updated": { textKey: "audit.exact.node.updated", tone: "neutral" },
  "node.deleted": { textKey: "audit.exact.node.deleted", tone: "danger" },
  "node.reconcile": { textKey: "audit.exact.node.reconcile", tone: "neutral" },
  "quota_request.created": {
    textKey: "audit.exact.quota_request.created",
    tone: "neutral",
  },
  "user.access_revoked": {
    textKey: "audit.exact.user.access_revoked",
    tone: "danger",
  },
  "access.sync_aborted": {
    textKey: "audit.exact.access.sync_aborted",
    tone: "warning",
  },
  "user.deleted": { textKey: "audit.exact.user.deleted", tone: "danger" },
  "admin.users.create": {
    textKey: "audit.exact.admin.users.create",
    tone: "success",
  },
  "admin.users.create-key": {
    textKey: "audit.exact.admin.users.create-key",
    tone: "success",
  },
  "admin.portal-policy.update": {
    textKey: "audit.exact.admin.portal-policy.update",
    tone: "neutral",
  },
  "admin.rules.activate": {
    textKey: "audit.exact.admin.rules.activate",
    tone: "success",
  },
  "admin.nodes.reconcile": {
    textKey: "audit.exact.admin.nodes.reconcile",
    tone: "neutral",
  },
};

const TARGET_TYPE: Record<string, string> = {
  vpn_key: "audit.target.vpn_key",
  user: "audit.target.user",
  node: "audit.target.node",
  portal_policy: "audit.target.portal_policy",
  route_rule: "audit.target.route_rule",
  rule_version: "audit.target.rule_version",
  quota_request: "audit.target.quota_request",
  access_policy: "audit.target.access_policy",
};

/** A person, as far as a row can tell: a name, a role, and whether they still exist. */
type Person = { text: string; role?: string; gone?: boolean };

/**
 * The chip after a name. It carries the role when the person is still in the
 * panel, and "deleted" when the address could only be recovered from the log —
 * which is the more important of the two, because it says why the users page
 * will not explain this row.
 */
function PersonMark({ person, t }: { person: Person; t: Translate }) {
  if (!person.gone && !person.role) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 px-1.5 text-[10px] font-normal",
        person.gone && "border-destructive/40 text-destructive",
      )}
    >
      {person.gone ? t("audit.deletedUser") : t(`role.${person.role}`)}
    </Badge>
  );
}

const SCOPES: AuditScope[] = ["all", "people", "system"];

/** One chip in a facet row: pressed state and nothing else to it. */
function FacetChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function describe(action: string, t: Translate): { text: string; tone: Tone } {
  const exact = EXACT[action];
  if (exact) return { text: t(exact.textKey), tone: exact.tone };
  const parts = action.split(".");
  if (parts[0] === "admin" && parts.length >= 3) {
    const resource = parts[1] ?? "";
    const verb = parts.slice(2).join(".");
    const verbMeta = VERB[verb];
    const noun = t(RESOURCE[resource] ?? resource);
    if (verbMeta)
      return { text: `${t(verbMeta.textKey)} · ${noun}`, tone: verbMeta.tone };
    return { text: `${verb} · ${noun}`, tone: "neutral" };
  }
  return { text: action.replace(/[._]/g, " "), tone: "neutral" };
}

function ToneIcon({ tone, action }: { tone: Tone; action: string }) {
  const className = cn(
    "size-4",
    tone === "success" && "text-success",
    tone === "danger" && "text-destructive",
    tone === "warning" && "text-warning",
    tone === "neutral" && "text-muted-foreground",
  );
  if (action.includes("key")) return <KeyRound className={className} />;
  if (action.includes("user")) return <UserCog className={className} />;
  if (action.includes("polic")) return <Settings className={className} />;
  if (action.includes("rule")) return <Shield className={className} />;
  if (tone === "danger") return <Trash2 className={className} />;
  if (tone === "success") return <CheckCircle2 className={className} />;
  if (tone === "warning") return <XCircle className={className} />;
  return <Circle className={className} />;
}

/**
 * Which metadata keys hold a reference to something with a name, and to what.
 * A purge event carries `ownerId` and `nodeId`, and rendering those as raw
 * UUIDs makes the pill wider than the row and tells the reader nothing: the
 * question a purge raises is *whose* key it was.
 */
const META_REFERENCE: Record<string, "user" | "node"> = {
  ownerId: "user",
  userId: "user",
  actorUserId: "user",
  targetUserId: "user",
  nodeId: "node",
};

function metaPills(
  metadata: Record<string, unknown> | null,
  resolve: (kind: "user" | "node", id: string) => string | null,
): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 4)
    .map(([key, value]) => {
      const kind = META_REFERENCE[key];
      if (kind && typeof value === "string") {
        const name = resolve(kind, value);
        // Fall through to the raw id when nothing knows the name — a pill that
        // silently drops an unresolvable reference would hide the only handle
        // the reader has left.
        if (name) return `${key}: ${name}`;
      }
      const rendered =
        typeof value === "object"
          ? JSON.stringify(value)
          : String(value as string | number | boolean);
      return `${key}: ${rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered}`;
    });
}

export default function AdminAuditPage() {
  const { audit, users, nodes, loading } = useAdminData();
  const { t, lang } = useT();
  const [query, setQuery] = React.useState("");
  const [scope, setScope] = React.useState<AuditScope>("all");
  const [category, setCategory] = React.useState<AuditCategory | null>(null);

  /**
   * Emails of people who are no longer in the users list, recovered from the
   * log itself.
   *
   * A deletion is exactly the event whose subject cannot be looked up: by the
   * time anyone reads the row, the user row is gone and `users.find` misses, so
   * the record of who was removed rendered as `users d4158b91` — an id, on the
   * one entry where the name matters most. `user.deleted` writes the address
   * into its own metadata, so the log can answer the question the users list no
   * longer can.
   */
  const emailsFromLog = React.useMemo(() => {
    const found = new Map<string, string>();
    for (const event of audit) {
      const email = event.metadata?.email;
      if (event.targetId && typeof email === "string" && email) {
        found.set(event.targetId, email);
      }
    }
    return found;
  }, [audit]);

  const personFor = (id: string | null): Person | null => {
    if (!id) return null;
    const known = users.find((user) => user.id === id);
    if (known) return { text: known.email, role: known.role };
    const remembered = emailsFromLog.get(id);
    if (remembered) return { text: remembered, gone: true };
    return null;
  };

  const actorLabel = (event: AuditEvent): Person => {
    const person = personFor(event.actorUserId ?? null);
    if (person) return person;
    if (event.actorUserId) return { text: event.actorUserId };
    return {
      text:
        event.actorType === "system" ? t("audit.system") : event.actorType,
    };
  };

  /** Names for the ids that appear inside metadata pills. */
  const resolveReference = (kind: "user" | "node", id: string): string | null => {
    if (kind === "node") return nodes.find((node) => node.id === id)?.name ?? null;
    return personFor(id)?.text ?? null;
  };

  const targetLabel = (event: AuditEvent): Person => {
    if (!event.targetId)
      return { text: t(TARGET_TYPE[event.targetType] ?? event.targetType) };
    const person = personFor(event.targetId);
    if (person) return person;
    const type = t(TARGET_TYPE[event.targetType] ?? event.targetType);
    return { text: `${type} ${event.targetId.slice(0, 8)}` };
  };

  const described = audit.map((event) => ({
    event,
    actor: actorLabel(event),
    target: targetLabel(event),
    ...describe(event.action, t),
  }));

  // Only the categories actually present get a chip. A fixed row would offer
  // filters that empty the list on a panel that has never touched that subject,
  // which reads as a broken page rather than as an empty category.
  const presentCategories = AUDIT_CATEGORIES.filter((value) =>
    audit.some((event) => auditCategoryOf(event.targetType) === value),
  );

  const rows = described.filter((row) =>
    auditRowMatches(
      {
        actorType: row.event.actorType,
        targetType: row.event.targetType,
        haystack: `${row.actor.text} ${row.text} ${row.target.text} ${row.event.action}`,
      },
      { scope, category, query },
    ),
  );

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <div className="mr-auto">
            <h2 className="font-semibold">{t("nav.audit")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("audit.subtitle", { count: audit.length })}
            </p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("audit.searchPlaceholder")}
              className="h-9 w-60 pl-8"
            />
          </div>
        </div>

        {/* Two facets, because the log answers two questions badly at once: the
            panel's own reconcile traffic outnumbers people on a quiet day, and
            one subject at a time is what an operator actually came to read. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-5 py-2.5">
          <div
            role="group"
            aria-label={t("audit.scopeLabel")}
            className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
          >
            {SCOPES.map((value) => (
              <FacetChip
                key={value}
                active={scope === value}
                onClick={() => setScope(value)}
              >
                {t(`audit.scope.${value}`)}
              </FacetChip>
            ))}
          </div>

          {presentCategories.length > 1 ? (
            <div
              role="group"
              aria-label={t("audit.categoryLabel")}
              className="flex flex-wrap items-center gap-0.5"
            >
              <FacetChip active={category === null} onClick={() => setCategory(null)}>
                {t("audit.cat.all")}
              </FacetChip>
              {presentCategories.map((value) => (
                <FacetChip
                  key={value}
                  active={category === value}
                  onClick={() => setCategory(category === value ? null : value)}
                >
                  {t(`audit.cat.${value}`)}
                </FacetChip>
              ))}
            </div>
          ) : null}

          {scope !== "all" || category !== null || query ? (
            <button
              type="button"
              onClick={() => {
                setScope("all");
                setCategory(null);
                setQuery("");
              }}
              className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("audit.clearFilters", { count: rows.length })}
            </button>
          ) : null}
        </div>

        {loading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {audit.length === 0 ? t("audit.empty") : t("common.notFound")}
          </div>
        ) : (
          <ol className="divide-y">
            {rows.map((row) => (
              <li
                key={row.event.id}
                className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-accent/40"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
                    row.tone === "success" && "bg-success/12",
                    row.tone === "danger" && "bg-destructive/12",
                    row.tone === "warning" && "bg-warning/15",
                    row.tone === "neutral" && "bg-muted",
                  )}
                >
                  <ToneIcon tone={row.tone} action={row.event.action} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-1.5 text-sm leading-snug">
                    <span className="font-medium">{row.actor.text}</span>
                    <PersonMark person={row.actor} t={t} />
                    <span className="text-muted-foreground">{row.text}</span>
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate">{row.target.text}</span>
                    <PersonMark person={row.target} t={t} />
                    {metaPills(row.event.metadata, resolveReference).map((pill) => (
                      <Badge
                        key={pill}
                        variant="outline"
                        className="h-4 max-w-52 truncate px-1.5 font-mono text-[10px] font-normal"
                      >
                        {pill}
                      </Badge>
                    ))}
                  </div>
                </div>
                <time className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(row.event.createdAt, lang)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
