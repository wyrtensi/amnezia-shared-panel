"use client";

import * as React from "react";
import { Check, Eye, Pin, RotateCw } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { useAdminData, type RuleVersion } from "@/components/admin/admin-data";
import { GlobalRoutesCard } from "@/components/admin/global-routes-card";
import { RulePreviewDialog } from "@/components/admin/rule-preview-dialog";
import { RulesRefreshButton } from "@/components/admin/rules-refresh-button";
import {
  distinctSources,
  ruleSources,
  type RuleSourceRef,
} from "@amnezia/contracts";
import { useT } from "@/lib/i18n/provider";

const STATUS_META: Record<
  string,
  { labelKey: string; variant: "success" | "secondary" | "warning" }
> = {
  active: { labelKey: "rules.status.active", variant: "success" },
  superseded: { labelKey: "rules.status.superseded", variant: "secondary" },
  quarantined: { labelKey: "rules.status.quarantined", variant: "warning" },
};

const PROFILE_LABEL: Record<string, string> = {
  full_tunnel: "route.full_tunnel",
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};

/** Profiles first in the order the panel talks about them everywhere else. */
const PROFILE_ORDER = ["ru_whitelist", "ru_blacklist", "full_tunnel"];

type ProfileGroup = {
  profile: string;
  versions: RuleVersion[];
  active: RuleVersion | undefined;
  pinned: RuleVersion | undefined;
  /** A version fetched after the pin, sitting unpublished behind it. */
  newerThanPinned: RuleVersion | undefined;
  sources: RuleSourceRef[];
};

/**
 * A flat list of versions read as "what feeds each profile, what is live on it,
 * and what else has been fetched". Two blacklist rows next to each other with
 * nothing saying which one is serving traffic is the thing this replaces.
 */
export const groupByProfile = (rules: RuleVersion[]): ProfileGroup[] => {
  const byProfile = new Map<string, RuleVersion[]>();
  for (const rule of rules) {
    const bucket = byProfile.get(rule.profile);
    if (bucket) bucket.push(rule);
    else byProfile.set(rule.profile, [rule]);
  }
  const profiles = [...byProfile.keys()].sort((a, b) => {
    const rankA = PROFILE_ORDER.indexOf(a);
    const rankB = PROFILE_ORDER.indexOf(b);
    // Anything the panel does not know about sorts after, by name, rather than
    // disappearing: a profile added later must still be visible here.
    if (rankA !== rankB) return (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB);
    return a.localeCompare(b);
  });
  return profiles.map((profile) => {
    // The caller hands these over newest-first (ORDER BY created_at DESC).
    const versions = byProfile.get(profile) ?? [];
    const active = versions.find((version) => version.status === "active");
    const pinned = versions.find((version) => version.pinnedAt);
    const newerThanPinned =
      pinned &&
      versions.find(
        (version) =>
          version.id !== pinned.id &&
          version.status !== "quarantined" &&
          version.createdAt > pinned.createdAt,
      );
    return {
      profile,
      versions,
      active,
      pinned,
      newerThanPinned,
      // Read off the versions themselves rather than off RULE_FEEDS: this is
      // what actually produced these lists, including a feed since removed.
      sources: distinctSources(versions.map((v) => v.sourceUrl)),
    };
  });
};

/**
 * Provider names, each carrying its full URL on hover — the derived label is
 * short enough to scan, the URL is what settles any doubt about it.
 */
function SourceNames({ sources }: { sources: RuleSourceRef[] }) {
  const { t } = useT();
  if (sources.length === 0) {
    return <span className="italic">{t("rules.sourcesNone")}</span>;
  }
  return (
    <>
      {sources.map((source, index) => (
        <React.Fragment key={source.url}>
          {index > 0 ? <span aria-hidden> · </span> : null}
          <span className="underline decoration-dotted" title={source.url}>
            {source.name}
          </span>
        </React.Fragment>
      ))}
    </>
  );
}

function ProfileSection({
  group,
  onPreview,
}: {
  group: ProfileGroup;
  onPreview: (rule: RuleVersion) => void;
}) {
  const { action } = useAdminData();
  const { t, lang } = useT();
  const { profile, versions, pinned, newerThanPinned, sources } = group;

  return (
    <div className="border-t">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">
              {t(PROFILE_LABEL[profile] ?? profile)}
            </h3>
            <span className="text-xs text-muted-foreground">
              {t("rules.versionCount", { count: versions.length })}
            </span>
            {pinned ? (
              <Badge variant="warning" className="gap-1">
                <Pin className="h-3 w-3" /> {t("rules.pinned")}
              </Badge>
            ) : null}
          </div>
          {sources.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("rules.sourcesLabel")}: <SourceNames sources={sources} />
            </p>
          ) : null}
          <p className="text-xs leading-snug text-muted-foreground">
            {pinned ? t("rules.pinnedNote") : t("rules.autoPublish")}
          </p>
          {newerThanPinned ? (
            <p className="text-xs leading-snug text-warning-foreground dark:text-warning">
              {t("rules.newerFetched")}
            </p>
          ) : null}
        </div>
        {pinned ? (
          <Button
            size="sm"
            variant="secondary"
            title={t("rules.followTitle")}
            onClick={() => void action("rules", pinned.id, "follow")}
          >
            <RotateCw className="h-4 w-4" /> {t("rules.follow")}
          </Button>
        ) : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("rules.colVersion")}</TableHead>
            <TableHead>{t("rules.colSource")}</TableHead>
            <TableHead>{t("rules.colSubnets")}</TableHead>
            <TableHead>{t("rules.colStatus")}</TableHead>
            <TableHead>{t("rules.colFetched")}</TableHead>
            <TableHead>{t("rules.colPublished")}</TableHead>
            <TableHead className="text-right">{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((rule) => {
            const meta =
              STATUS_META[rule.status] ?? {
                labelKey: rule.status,
                variant: "secondary" as const,
              };
            return (
              <TableRow key={rule.id}>
                <TableCell>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {(rule.version || rule.id).slice(0, 20)}
                  </code>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <SourceNames sources={ruleSources(rule.sourceUrl)} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {t("rules.cidrDomains", {
                    cidr: rule.cidrCount ?? 0,
                    domains: rule.domainCount ?? 0,
                  })}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={meta.variant}>{t(meta.labelKey)}</Badge>
                    {rule.pinnedAt ? (
                      <Badge variant="warning" className="gap-1">
                        <Pin className="h-3 w-3" /> {t("rules.pinned")}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDateTime(rule.createdAt, lang)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {rule.publishedAt
                    ? formatDateTime(rule.publishedAt, lang)
                    : t("rules.notActive")}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("rules.viewAria")}
                      title={t("rules.viewTitle")}
                      onClick={() => onPreview(rule)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {rule.status !== "active" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        title={t("rules.activateTitle")}
                        onClick={() => void action("rules", rule.id, "activate")}
                      >
                        <Check className="h-4 w-4" /> {t("rules.activate")}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {versions.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="py-6 text-center text-muted-foreground"
              >
                {t("rules.profileEmpty")}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AdminRulesPage() {
  const { rules, loading } = useAdminData();
  const { t } = useT();
  const [preview, setPreview] = React.useState<RuleVersion | null>(null);
  const groups = React.useMemo(() => groupByProfile(rules), [rules]);

  return (
    <div className="space-y-4">
      {/* Admin-owned additions and exclusions come first, the fetched feed
          versions below — the two halves must not blur together. */}
      <GlobalRoutesCard />

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">
                  {t("rules.title")}
                </h2>
                <span className="text-sm text-muted-foreground">
                  {rules.length}
                </span>
              </div>
              <p className="text-xs leading-snug text-muted-foreground">
                {t("rules.autoUpdate")}
              </p>
            </div>
            <RulesRefreshButton />
          </div>
          {loading ? (
            <div className="space-y-2 p-5">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              {t("rules.empty")}
            </p>
          ) : (
            groups.map((group) => (
              <ProfileSection
                key={group.profile}
                group={group}
                onPreview={setPreview}
              />
            ))
          )}
        </CardContent>
        <RulePreviewDialog rule={preview} onClose={() => setPreview(null)} />
      </Card>
    </div>
  );
}
