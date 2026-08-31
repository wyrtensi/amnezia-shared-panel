"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminData, type RuleVersion } from "@/components/admin/admin-data";
import { useT } from "@/lib/i18n/provider";

const PROFILE_LABEL: Record<string, string> = {
  full_tunnel: "route.full_tunnel",
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};

type RuleDetail = {
  id: string;
  profile: string;
  version: string;
  sourceUrl: string | null;
  cidrCount: number;
  domainCount: number;
  payload: { cidrs: string[]; domains: string[] };
};

type RuleDiff = {
  base: { id: string; version: string };
  next: { id: string; version: string };
  diff: {
    cidrs: { added: string[]; removed: string[]; addedCount: number; removedCount: number };
    domains: { added: string[]; removed: string[]; addedCount: number; removedCount: number };
  };
};

export function RulePreviewDialog({
  rule,
  onClose,
}: {
  rule: RuleVersion | null;
  onClose: () => void;
}) {
  const { rules, request } = useAdminData();
  const { t } = useT();
  const tRef = React.useRef(t);
  React.useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [detail, setDetail] = React.useState<RuleDetail | null>(null);
  const [diff, setDiff] = React.useState<RuleDiff | null>(null);
  const [loading, setLoading] = React.useState(false);

  // The currently active version of the same profile, for comparison.
  const activePeer = rule
    ? rules.find(
        (item) =>
          item.profile === rule.profile &&
          item.status === "active" &&
          item.id !== rule.id,
      )
    : undefined;

  React.useEffect(() => {
    if (!rule) return;
    let active = true;
    setDetail(null);
    setDiff(null);
    setLoading(true);
    void (async () => {
      try {
        const result = await request<RuleDetail>(`/api/admin/rules/${rule.id}`);
        if (active) setDetail(result);
      } catch (cause) {
        if (active)
          toast.error(
            cause instanceof Error ? cause.message : tRef.current("rpd.loadFailed"),
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [rule, request]);

  const loadDiff = async () => {
    if (!rule || !activePeer) return;
    try {
      setDiff(
        await request<RuleDiff>(
          `/api/admin/rules/${activePeer.id}/diff/${rule.id}`,
        ),
      );
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("rpd.compareFailed"),
      );
    }
  };

  return (
    <Dialog open={Boolean(rule)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("rpd.title", {
              profile: rule
                ? t(PROFILE_LABEL[rule.profile] ?? rule.profile)
                : "",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("rpd.version")}{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {(rule?.version || rule?.id || "").slice(0, 24)}
            </code>
          </DialogDescription>
        </DialogHeader>

        {loading || !detail ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Badge variant="outline">{t("rpd.cidrBadge", { count: detail.cidrCount })}</Badge>
              <Badge variant="outline">{t("rpd.domainsBadge", { count: detail.domainCount })}</Badge>
            </div>

            {activePeer ? (
              <div className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t("rpd.compareActive")}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => void loadDiff()}>
                    {t("rpd.showDiff")}
                  </Button>
                </div>
                {diff ? (
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <DiffColumn
                      title={t("rpd.cidrTitle")}
                      addedCount={diff.diff.cidrs.addedCount}
                      removedCount={diff.diff.cidrs.removedCount}
                      added={diff.diff.cidrs.added}
                      removed={diff.diff.cidrs.removed}
                    />
                    <DiffColumn
                      title={t("rpd.domains")}
                      addedCount={diff.diff.domains.addedCount}
                      removedCount={diff.diff.domains.removedCount}
                      added={diff.diff.domains.added}
                      removed={diff.diff.domains.removed}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            <SampleList title={t("rpd.subnetsCidr")} items={detail.payload.cidrs} />
            <SampleList title={t("rpd.domains")} items={detail.payload.domains} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DiffColumn({
  title,
  addedCount,
  removedCount,
  added,
  removed,
}: {
  title: string;
  addedCount: number;
  removedCount: number;
  added: string[];
  removed: string[];
}) {
  return (
    <div>
      <p className="font-medium">{title}</p>
      <p className="text-success">+{addedCount}</p>
      <p className="text-destructive">−{removedCount}</p>
      <div className="mt-1 max-h-28 space-y-0.5 overflow-y-auto font-mono text-xs">
        {added.slice(0, 20).map((value) => (
          <div key={`a-${value}`} className="text-success">
            + {value}
          </div>
        ))}
        {removed.slice(0, 20).map((value) => (
          <div key={`r-${value}`} className="text-destructive">
            − {value}
          </div>
        ))}
      </div>
    </div>
  );
}

function SampleList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-sm font-medium">
        {title}{" "}
        <span className="text-muted-foreground">({items.length})</span>
      </p>
      <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs">
        {items.slice(0, 200).map((value) => (
          <div key={value}>{value}</div>
        ))}
      </div>
    </div>
  );
}
