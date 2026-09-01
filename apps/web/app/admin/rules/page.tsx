"use client";

import * as React from "react";
import { Check, Eye } from "lucide-react";
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
import { RulePreviewDialog } from "@/components/admin/rule-preview-dialog";
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

export default function AdminRulesPage() {
  const { rules, loading, action } = useAdminData();
  const { t, lang } = useT();
  const [preview, setPreview] = React.useState<RuleVersion | null>(null);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="space-y-1 px-5 py-4">
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
        {loading ? (
          <div className="space-y-2 p-5">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("rules.colProfile")}</TableHead>
                <TableHead>{t("rules.colVersion")}</TableHead>
                <TableHead>{t("rules.colSubnets")}</TableHead>
                <TableHead>{t("rules.colStatus")}</TableHead>
                <TableHead>{t("rules.colPublished")}</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => {
                const meta =
                  STATUS_META[rule.status] ?? {
                    labelKey: rule.status,
                    variant: "secondary" as const,
                  };
                return (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">
                      {t(PROFILE_LABEL[rule.profile] ?? rule.profile)}
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {(rule.version || rule.id).slice(0, 20)}
                      </code>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t("rules.cidrDomains", {
                        cidr: rule.cidrCount ?? 0,
                        domains: rule.domainCount ?? 0,
                      })}
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{t(meta.labelKey)}</Badge>
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
                          onClick={() => setPreview(rule)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {rule.status !== "active" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void action("rules", rule.id, "activate")
                            }
                          >
                            <Check className="h-4 w-4" /> {t("rules.activate")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rules.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {t("rules.empty")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <RulePreviewDialog rule={preview} onClose={() => setPreview(null)} />
    </Card>
  );
}
