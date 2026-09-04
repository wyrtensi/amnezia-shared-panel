"use client";

import * as React from "react";
import { Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { apiRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { AdminServiceCheck } from "@/lib/types";

/**
 * The admin's view of the service checks and what every node says about them.
 *
 * Deliberately not a builder for assertions. The rule set is open — a check can
 * assert on a substring count, a body size, a header — and a form that offered
 * a subset of that would quietly become the definition of what a check can be.
 * Assertions are shown as text and edited from the CLI (`check-create`,
 * `check-set`), which is the surface that stays honest as the set grows.
 * Everything an operator needs day to day — enable, run, delete, read the
 * verdicts — is here.
 */
export function ServiceChecksCard() {
  const { t, lang } = useT();
  const [checks, setChecks] = React.useState<AdminServiceCheck[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setChecks(await apiRequest<AdminServiceCheck[]>("/api/admin/service-checks"));
    } catch {
      toast.error(t("checks.loadFailed"));
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await run();
      await load();
    } catch {
      toast.error(t("checks.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (!checks) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("checks.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("checks.cliHint")}</p>
        {checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("checks.empty")}</p>
        ) : null}
        {checks.map((check) => (
          <div key={check.id} className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <span className="text-sm font-medium">{check.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {check.probe?.url ?? check.probe?.kind}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("checks.every", {
                    minutes: String(Math.round(check.intervalSec / 60)),
                  })}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch
                  checked={check.enabled}
                  disabled={busy === check.id}
                  onCheckedChange={(enabled) => {
                    void act(check.id, () =>
                      apiRequest(`/api/admin/service-checks/${check.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled }),
                      }),
                    );
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === check.id}
                  onClick={() => {
                    void act(check.id, async () => {
                      await apiRequest(
                        `/api/admin/service-checks/${check.id}/run`,
                        { method: "POST" },
                      );
                      // Not "ran it": the panel reaches nodes on the telemetry
                      // poll, and an admin who read this as "done" would look at
                      // a stale row and conclude the check was broken.
                      toast.success(t("checks.runQueued"));
                    });
                  }}
                >
                  <Play className="h-4 w-4" /> {t("checks.run")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === check.id}
                  onClick={() => {
                    if (!confirm(t("checks.deleteConfirm", { name: check.name })))
                      return;
                    void act(check.id, () =>
                      apiRequest(`/api/admin/service-checks/${check.id}`, {
                        method: "DELETE",
                      }),
                    );
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {(check.assertions ?? []).map((assertion, index) => (
                <li key={index} className="truncate">
                  {JSON.stringify(assertion)}
                </li>
              ))}
            </ul>

            {(check.results ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("checks.noResults")}
              </p>
            ) : (
              <ul className="space-y-1">
                {(check.results ?? []).map((result) => (
                  <li
                    key={result.nodeId}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">
                        {result.nodeName}
                      </span>
                      {/* The internal vocabulary, on purpose. An admin needs
                          `error` - the node could not look - to stay distinct
                          from `failed`, which the user surface collapses. */}
                      <Badge
                        variant={
                          result.status === "ok"
                            ? "success"
                            : result.status === "failed"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {result.status}
                      </Badge>
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {result.detail ?? result.finalUrl ?? ""}
                    </span>
                    <span className="text-muted-foreground">
                      {formatDateTime(result.checkedAt, lang)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
