"use client";

import * as React from "react";
import { Play, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Callout } from "@/components/ui/hint";
import { apiRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { ServiceChecksState } from "@/components/admin/use-service-checks";

/**
 * The admin's view of the service checks and what every node says about them.
 *
 * Deliberately not a builder for assertions. The rule set is open — a check can
 * assert on a substring count, a body size, a header — and a form that offered
 * a subset of that would quietly become the definition of what a check can be.
 * Assertions are shown as text and edited from the CLI (`check-create`,
 * `check-set`), which is the surface that stays honest as the set grows.
 * Everything an operator needs day to day — enable, run, delete, read the
 * verdicts, and change how often a check runs — is here. The period is a plain
 * number with a range, not an open rule set, which is why it does not belong
 * with the assertions on the other side of that line.
 */
/**
 * How often one check runs, in minutes, editable in place.
 *
 * It was read-only here for as long as the number was only settable from the
 * CLI, which made "how often does this run" the one thing on the card an
 * operator could see but not change. Minutes rather than seconds because that
 * is the unit the answer is given in (the shipped checks run twice a day); the
 * stored column is seconds, so the bounds below are the table's 60..86400
 * expressed in minutes.
 *
 * Save only appears once the number differs from the stored one: a per-row save
 * button that is always live invites a save that changes nothing and reads as
 * though it did.
 */
function CheckInterval({
  intervalSec,
  disabled,
  onSave,
}: {
  intervalSec: number;
  disabled: boolean;
  onSave: (intervalSec: number) => void;
}) {
  const { t } = useT();
  const storedMinutes = Math.round(intervalSec / 60);
  const [minutes, setMinutes] = React.useState(storedMinutes);
  // Re-sync when the card reloads after a save, or after somebody else's edit.
  React.useEffect(() => setMinutes(storedMinutes), [storedMinutes]);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const changed = minutes !== storedMinutes;

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {t("checks.everyLabel")}
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={1440}
        aria-label={t("checks.intervalAria")}
        className="h-7 w-20 text-xs"
        disabled={disabled}
        value={String(minutes)}
        onChange={(event) => setMinutes(Number(event.target.value.trim()))}
      />
      {t("checks.minutes")}
      {changed ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7"
          disabled={disabled || !valid}
          onClick={() => onSave(minutes * 60)}
        >
          {t("common.save")}
        </Button>
      ) : null}
      {changed && !valid ? (
        <span className="text-destructive">{t("checks.intervalRange")}</span>
      ) : null}
    </span>
  );
}

export function ServiceChecksCard({
  state,
}: {
  state: ServiceChecksState;
}) {
  const { t, lang } = useT();
  const { checks, loading, failed, reload: load } = state;
  const [busy, setBusy] = React.useState<string | null>(null);

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

  if (loading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("checks.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* A check is defined once and runs on EVERY node - the per-node lines
            below are the same check seen from each server. Without this the
            card reads as though a check belonged to something in particular. */}
        <p className="text-xs text-muted-foreground">{t("checks.scope")}</p>
        <p className="text-xs text-muted-foreground">{t("checks.cliHint")}</p>
        {failed ? (
          // An empty card and a card that could not load look identical, and
          // only one of them means "there is nothing here".
          <Callout tone="danger" className="text-xs">
            {t("checks.loadFailed")}
          </Callout>
        ) : null}
        {!failed && checks.length === 0 ? (
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
                <CheckInterval
                  intervalSec={check.intervalSec}
                  disabled={busy === check.id}
                  onSave={(intervalSec) => {
                    void act(check.id, () =>
                      apiRequest(`/api/admin/service-checks/${check.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ intervalSec }),
                      }),
                    );
                  }}
                />
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
                  title={t("checks.resetHint")}
                  onClick={() => {
                    void act(check.id, async () => {
                      await apiRequest(
                        `/api/admin/service-checks/${check.id}/results`,
                        { method: "DELETE" },
                      );
                      // Not "deleted": the result IS the schedule, so clearing
                      // it makes every node measure the check again rather than
                      // losing anything.
                      toast.success(t("checks.resetDone"));
                    });
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
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
