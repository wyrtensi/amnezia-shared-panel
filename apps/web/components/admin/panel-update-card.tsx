"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest, ApiClientError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

type VersionInfo = {
  version: string;
  commit: string | null;
  builtAt: string | null;
};

type UpdateStatus = {
  enabled: boolean;
  version: VersionInfo;
  pending: { id: string; requestedAt: string; requestedBy: string } | null;
  lastResult: {
    id: string;
    finishedAt: string;
    ok: boolean;
    message: string;
  } | null;
};

/**
 * Admin "Update panel" card (GET/POST /api/admin/update). The button drops a
 * request into the host spool; a host worker runs update.sh and writes a result
 * back, so this card is a live view of that spool — reload-safe and resilient to
 * the brief restart while the panel updates itself.
 */
export function PanelUpdateCard() {
  const { t, lang } = useT();
  const [status, setStatus] = React.useState<UpdateStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const wasPending = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      setStatus(await apiRequest<UpdateStatus>("/api/admin/update"));
    } catch {
      // The stack may be mid-restart (web/api briefly down). Keep the last known
      // status and let the poll retry.
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Poll while an update is pending (through transient errors during restart).
  const pending = Boolean(status?.pending);
  React.useEffect(() => {
    if (!pending) return;
    wasPending.current = true;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [pending, load]);

  // Toast once when a pending update resolves into a result.
  React.useEffect(() => {
    if (wasPending.current && status && !status.pending && status.lastResult) {
      wasPending.current = false;
      if (status.lastResult.ok) toast.success(t("update.lastOk"));
      else toast.error(t("update.lastFail"));
    }
  }, [status, t]);

  const trigger = async () => {
    setBusy(true);
    try {
      await apiRequest("/api/admin/update", { method: "POST" });
      toast.success(t("update.scheduled"));
      setConfirmOpen(false);
      await load();
    } catch (error) {
      toast.error(
        error instanceof ApiClientError ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null; // first load — stay quiet until the state is known

  const version = status.version;
  const versionLabel = version.commit
    ? `${version.version} · ${version.commit.slice(0, 7)}`
    : version.version;
  const running = Boolean(status.pending);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 font-semibold">
            <RefreshCw className="h-4 w-4 text-chart-2" />
            {t("update.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("update.current")}:{" "}
            <span className="font-mono">{versionLabel}</span>
            {version.builtAt ? (
              <>
                {" · "}
                {t("update.built")} {formatDate(version.builtAt, lang)}
              </>
            ) : null}
          </p>
          {running ? (
            <p className="flex items-center gap-1.5 text-sm text-chart-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("update.running")}
            </p>
          ) : status.lastResult ? (
            <p
              className={cn(
                "flex items-center gap-1.5 text-xs",
                status.lastResult.ok ? "text-success" : "text-destructive",
              )}
            >
              {status.lastResult.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {status.lastResult.ok ? t("update.lastOk") : t("update.lastFail")}
              {" · "}
              {formatDate(status.lastResult.finishedAt, lang)}
            </p>
          ) : null}
          {!status.enabled ? (
            <p className="text-xs text-muted-foreground">
              {t("update.disabled")}.{" "}
              <span className="font-mono">{t("update.disabledHint")}</span>
            </p>
          ) : running ? (
            <p className="text-xs text-muted-foreground">
              {t("update.runningHint")}
            </p>
          ) : null}
        </div>
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={!status.enabled || running}
          className="shrink-0"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {t("update.button")}
        </Button>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("update.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("update.confirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void trigger()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("update.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
