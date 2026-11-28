"use client";

import * as React from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import {
  KEY_UPDATE_NOTIFY_NOTE_MAX_LENGTH,
  type NotifyKeyUpdateResult,
} from "@amnezia/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/provider";

export type NotifyKeyUpdateTarget = {
  title: string;
  notifiedAt: string | null;
  note: string | null;
  onNotify: (note: string | null) => Promise<NotifyKeyUpdateResult>;
  onClear: () => Promise<NotifyKeyUpdateResult>;
};

export function NotifyKeyUpdateDialog({
  target,
  onClose,
  onDone,
}: {
  target: NotifyKeyUpdateTarget | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useT();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setNote(target?.note ?? "");
  }, [target]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target) return;
    setBusy(true);
    try {
      const res = await target.onNotify(note.trim() || null);
      toast.success(t("notifyKeyUpdate.sentToast", { count: res.affectedActiveKeys }));
      onClose();
      await onDone();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("nodes.changeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await target.onClear();
      toast.success(t("notifyKeyUpdate.clearedToast"));
      onClose();
      await onDone();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("nodes.changeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="size-4 text-warning" />
            {t("notifyKeyUpdate.title")}
          </DialogTitle>
          <DialogDescription>
            {target?.title ? <span className="font-medium text-foreground">{target.title} — </span> : null}
            {t("notifyKeyUpdate.desc")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void send(event)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="notify-key-update-note">{t("notifyKeyUpdate.noteLabel")}</Label>
            <Input
              id="notify-key-update-note"
              maxLength={KEY_UPDATE_NOTIFY_NOTE_MAX_LENGTH}
              placeholder={t("notifyKeyUpdate.notePlaceholder")}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter className="flex-wrap gap-2">
            {target?.notifiedAt ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void clear()}
                className="mr-auto"
              >
                {t("notifyKeyUpdate.clear")}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("notifyKeyUpdate.send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
