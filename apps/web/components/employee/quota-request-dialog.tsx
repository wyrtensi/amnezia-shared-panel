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
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

export function QuotaRequestDialog({
  open,
  onOpenChange,
  currentLimit,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentLimit: number;
  onSubmitted: () => Promise<void> | void;
}) {
  const { t } = useT();
  const [additional, setAdditional] = React.useState(1);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setAdditional(1);
      setReason("");
    }
  }, [open, currentLimit]);

  // The request is expressed as extra slots, but the API takes the new total.
  const maxAdditional = Math.max(1, 1000 - currentLimit);
  const total = currentLimit + additional;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await apiRequest("/api/quota-requests", {
        method: "POST",
        body: JSON.stringify({ requestedLimit: total, reason }),
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
              {t("quota.willBecome", { total })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quota-reason">{t("quota.reason")}</Label>
            <Textarea
              id="quota-reason"
              minLength={10}
              maxLength={1000}
              required
              placeholder={t("quota.reasonPlaceholder")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || reason.trim().length < 10}>
              {busy ? t("quota.sending") : t("quota.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
