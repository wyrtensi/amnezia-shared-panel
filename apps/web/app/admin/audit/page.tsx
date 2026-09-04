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

function metaPills(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 4)
    .map(([key, value]) => {
      const rendered =
        typeof value === "object"
          ? JSON.stringify(value)
          : String(value as string | number | boolean);
      return `${key}: ${rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered}`;
    });
}

export default function AdminAuditPage() {
  const { audit, users, loading } = useAdminData();
  const { t, lang } = useT();
  const [query, setQuery] = React.useState("");

  const actorLabel = (event: AuditEvent) =>
    (event.actorUserId &&
      users.find((user) => user.id === event.actorUserId)?.email) ||
    event.actorUserId ||
    (event.actorType === "system" ? t("audit.system") : event.actorType);

  const targetLabel = (event: AuditEvent) => {
    if (!event.targetId)
      return t(TARGET_TYPE[event.targetType] ?? event.targetType);
    const asUser = users.find((user) => user.id === event.targetId);
    if (asUser) return asUser.email;
    const type = t(TARGET_TYPE[event.targetType] ?? event.targetType);
    return `${type} ${event.targetId.slice(0, 8)}`;
  };

  const needle = query.trim().toLowerCase();
  const rows = audit
    .map((event) => ({
      event,
      actor: actorLabel(event),
      target: targetLabel(event),
      ...describe(event.action, t),
    }))
    .filter((row) => {
      if (!needle) return true;
      return `${row.actor} ${row.text} ${row.target} ${row.event.action}`
        .toLowerCase()
        .includes(needle);
    });

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
                  <p className="text-sm leading-snug">
                    <span className="font-medium">{row.actor}</span>{" "}
                    <span className="text-muted-foreground">{row.text}</span>
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate">{row.target}</span>
                    {metaPills(row.event.metadata).map((pill) => (
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
