"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  isBridgeAgentUpdateOutstanding,
  type Bridge,
  type BridgeAgentUpdateOperation,
  type BridgeAgentUpdateView,
} from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getAgentUpdate, requestAgentUpdate, type Requester } from "@/lib/bridge-api";
import { agentUpdateTone, describeBridgeError } from "@/lib/bridge-ui";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { Lang } from "@/lib/i18n/messages";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The agent-update facts of a bridge card: installed version, the approved
 * image on offer and the last operation. Presentational; every value comes
 * from the Control API, which also owns the rules for requesting an update.
 */
export function BridgeAgentUpdateFacts({
  bridge,
  t,
  lang,
  onUpdate,
}: {
  bridge: Bridge;
  t: Translate;
  lang: Lang;
  onUpdate?: () => void;
}) {
  if (!bridge.management?.enrolled) return null;
  const summary = bridge.agentUpdate;
  const operation = summary?.operation ?? null;
  const offered = summary?.offered ?? null;
  return (
    <div className="space-y-1.5 rounded-md border px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{t("bridge.upd.title")}</p>
        {onUpdate ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!offered && !operation}
            onClick={onUpdate}
          >
            {t("bridge.upd.button")}
          </Button>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("bridge.upd.installed")}</dt>
        <dd className="font-mono">{bridge.management.agentVersion ?? t("bridge.unknown")}</dd>
        <dt className="text-muted-foreground">{t("bridge.upd.offered")}</dt>
        <dd className="font-mono">{offered ? offered.version : t("bridge.upd.none")}</dd>
        <dt className="text-muted-foreground">{t("bridge.upd.last")}</dt>
        <dd>
          {operation ? (
            <Badge variant={agentUpdateTone(operation.state)}>
              {t(`bridge.upd.state.${operation.state}`)}
            </Badge>
          ) : (
            t("bridge.upd.never")
          )}
        </dd>
      </dl>
      {operation ? <OperationNotes operation={operation} t={t} lang={lang} /> : null}
      {summary && !summary.updateSupported ? (
        <p className="text-xs text-muted-foreground">{t("bridge.upd.unsupported")}</p>
      ) : null}
    </div>
  );
}

function OperationNotes({
  operation,
  t,
  lang,
}: {
  operation: BridgeAgentUpdateOperation;
  t: Translate;
  lang: Lang;
}) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {operation.contactLostSince ? (
        <p>
          {t("bridge.upd.contactLost", { at: formatDateTime(operation.contactLostSince, lang) })}
        </p>
      ) : null}
      {operation.state === "pickup_timeout" ? <p>{t("bridge.upd.pickupTimeout")}</p> : null}
      {operation.errorCode ? (
        <p>
          {t("bridge.upd.code")}: <span className="break-all font-mono">{operation.errorCode}</span>
        </p>
      ) : null}
      {operation.result ? (
        <p>{t("bridge.upd.finished", { at: formatDateTime(operation.result.finishedAt, lang) })}</p>
      ) : null}
    </div>
  );
}

/** Preview, then confirm, one bridge's agent update. */
export function UpdateAgentDialog({
  bridge,
  onClose,
  onDone,
  request,
}: {
  bridge: Bridge | null;
  onClose: () => void;
  onDone: () => Promise<void>;
  request: Requester;
}) {
  const { t, lang } = useT();
  const [view, setView] = React.useState<BridgeAgentUpdateView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const bridgeId = bridge?.id ?? null;

  React.useEffect(() => {
    setView(null);
    setError(null);
    if (!bridgeId) return;
    let cancelled = false;
    getAgentUpdate(request, bridgeId).then(
      (next) => {
        if (!cancelled) setView(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(describeBridgeError(cause, t).message);
      },
    );
    return () => {
      cancelled = true;
    };
    // One preview per opened dialog: `request` and `t` are deliberately not dependencies.
  }, [bridgeId]);

  const offered = view?.offered[0] ?? null;
  const outstanding = view?.operation ? isBridgeAgentUpdateOutstanding(view.operation.state) : false;
  const digest = offered?.digest ?? (outstanding ? (view?.operation?.requestedDigest ?? null) : null);

  const submit = async () => {
    if (!bridge || !digest) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestAgentUpdate(request, bridge.id, digest);
      toast.success(t(result.created ? "bridge.upd.requested" : "bridge.upd.replayed"));
      onClose();
      await onDone();
    } catch (cause) {
      const described = describeBridgeError(cause, t);
      setError(described.message);
      if (described.code === "BRIDGE_UPDATE_IN_PROGRESS") await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(bridge)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("bridge.upd.dialogTitle", { name: bridge?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("bridge.upd.dialogDesc")}</DialogDescription>
        </DialogHeader>
        {view ? (
          <div className="space-y-2">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t("bridge.upd.installed")}</dt>
              <dd className="font-mono">{view.installedVersion ?? t("bridge.unknown")}</dd>
              <dt className="text-muted-foreground">{t("bridge.upd.offered")}</dt>
              <dd className="font-mono">{offered ? offered.version : t("bridge.upd.none")}</dd>
              {offered ? (
                <>
                  <dt className="text-muted-foreground">{t("bridge.upd.image")}</dt>
                  <dd className="break-all font-mono">{offered.image}</dd>
                </>
              ) : null}
            </dl>
            {!offered ? <Callout tone="warning" className="text-xs">{t("bridge.upd.noOffer")}</Callout> : null}
            {!view.updateSupported ? (
              <Callout tone="warning" className="text-xs">{t("bridge.upd.unsupported")}</Callout>
            ) : null}
            {outstanding ? (
              <Callout tone="warning" className="text-xs">{t("bridge.upd.alreadyOutstanding")}</Callout>
            ) : null}
            {view.operation ? (
              <OperationNotes operation={view.operation} t={t} lang={lang} />
            ) : null}
          </div>
        ) : error ? null : (
          <p className="text-sm text-muted-foreground">{t("bridge.upd.loading")}</p>
        )}
        {error ? (
          <Callout tone="danger" className="text-xs">
            {error}
          </Callout>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={busy || !view || !digest} onClick={() => void submit()}>
            {t("bridge.upd.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
