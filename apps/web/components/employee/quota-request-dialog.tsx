"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import type { KeyLimitMode, Me, NodeView } from "@/lib/types";

/** Sentinel for "every server" — the API takes `nodeId: null` for it. */
const ALL_SERVERS = "all";

/** The user's per-node quota, as the dashboard already computes it. */
export type QuotaTargetNode = {
  node: NodeView;
  used: number;
  limit: number;
};

/**
 * Preselect the node the user actually ran out of room on: only when exactly
 * one available node is at its limit. Anything else defaults to every server.
 */
const defaultTarget = (nodeQuota: QuotaTargetNode[]): string => {
  const atLimit = nodeQuota.filter((entry) => entry.used >= entry.limit);
  return atLimit.length === 1 ? atLimit[0]!.node.id : ALL_SERVERS;
};

export function QuotaRequestDialog({
  open,
  onOpenChange,
  me,
  keyLimitMode,
  nodeQuota,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: Me;
  keyLimitMode: KeyLimitMode;
  nodeQuota: QuotaTargetNode[];
  onSubmitted: () => Promise<void> | void;
}) {
  const { t } = useT();
  const [target, setTarget] = React.useState<string>(ALL_SERVERS);
  const [additional, setAdditional] = React.useState(1);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // A target selector only makes sense with more than one available server AND
  // per-node limits; in global mode the number is the pool and has no server.
  // The API refuses a per-server request in global mode
  // (400 NODE_TARGET_NOT_APPLICABLE), so none is ever offered or sent.
  const canPickTarget = keyLimitMode === "per_node" && nodeQuota.length > 1;

  React.useEffect(() => {
    if (open) {
      setAdditional(1);
      setReason("");
      setTarget(canPickTarget ? defaultTarget(nodeQuota) : ALL_SERVERS);
    }
    // `nodeQuota` is a fresh array on every dashboard render, so it stays out of
    // the dependency list: the reset belongs to the dialog opening.
  }, [open, canPickTarget]);

  const targetNode =
    target === ALL_SERVERS
      ? null
      : (nodeQuota.find((entry) => entry.node.id === target) ?? null);

  // The limit the request builds on: the node's own limit when one server is
  // targeted, the flat per-user limit when every server is.
  const currentLimit =
    targetNode
      ? (me.perNode?.find((entry) => entry.nodeId === targetNode.node.id)
          ?.limit ?? me.keyLimit)
      : me.keyLimit;

  // The request is expressed as extra slots, but the API takes the new total.
  const maxAdditional = Math.max(1, 1000 - currentLimit);
  const total = currentLimit + Math.min(additional, maxAdditional);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await apiRequest("/api/quota-requests", {
        method: "POST",
        body: JSON.stringify({
          requestedLimit: total,
          nodeId: targetNode ? targetNode.node.id : null,
          reason,
        }),
      });
      toast.success(t("quota.sent"));
      onOpenChange(false);
      await onSubmitted();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("quota.sendFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("quota.title")}</DialogTitle>
          <DialogDescription>
            {t("quota.desc")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {canPickTarget ? (
            <div className="space-y-1.5">
              <Label htmlFor="quota-target">{t("quota.target")}</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="quota-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SERVERS}>
                    {t("quota.targetAll")}
                  </SelectItem>
                  {nodeQuota.map((entry) => (
                    <SelectItem key={entry.node.id} value={entry.node.id}>
                      {entry.node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {/* Outside the target picker, which global mode hides: without it a
              user asking for more keys is told only what the limit WILL be, and
              never what it is now -- so they cannot tell what they are asking
              for. It reads the same in both modes; only the picker is
              mode-dependent. */}
          <p className="text-xs text-muted-foreground">
            {t("quota.currentLimit", { limit: currentLimit })}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="quota-additional">{t("quota.additional")}</Label>
            <Input
              id="quota-additional"
              type="number"
              min={1}
              max={maxAdditional}
              value={additional}
              onChange={(event) =>
                setAdditional(
                  Math.min(
                    maxAdditional,
                    Math.max(1, event.target.valueAsNumber || 1),
                  ),
                )
              }
            />
            <p className="text-xs text-muted-foreground">
              {targetNode
                ? t("quota.willBecomeNode", {
                    total,
                    node: targetNode.node.name,
                  })
                : keyLimitMode === "global"
                  ? t("quota.willBecomeTotal", { total })
                  : t("quota.willBecome", { total })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quota-reason">{t("quota.reason")}</Label>
            <Textarea
              id="quota-reason"
              maxLength={1000}
              placeholder={t("quota.reasonPlaceholder")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("quota.reasonOptional")}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("quota.sending") : t("quota.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
