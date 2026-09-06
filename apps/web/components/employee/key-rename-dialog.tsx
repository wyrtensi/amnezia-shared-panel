"use client";

import * as React from "react";
import { Info, Pencil, TriangleAlert } from "lucide-react";
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
import { Callout } from "@/components/ui/hint";
import { composeKeyDisplayName, type KeyNameDisplay } from "@amnezia/contracts";
import { useT } from "@/lib/i18n/provider";

/** Same column width `renameKeyRequestSchema` enforces server-side. */
export const RENAME_LABEL_MAX = 80;

/**
 * Whether a draft is worth submitting, and the trimmed label to send.
 *
 * A rename always leaves the key with SOME label -- an empty draft is not a
 * way to clear it back to nothing, it is just nothing to send -- and an
 * unchanged draft (after trimming) is not an edit either: a user who opens
 * the dialog and closes it without typing anything must not be able to
 * trigger a re-issue by accident.
 */
export function renameKeyOutcome(
  draft: string,
  current: string | null | undefined,
): { canSave: boolean; deviceLabel: string } {
  const deviceLabel = draft.slice(0, RENAME_LABEL_MAX).trim();
  const before = (current ?? "").trim();
  return {
    canSave: deviceLabel.length > 0 && deviceLabel !== before,
    deviceLabel,
  };
}

/**
 * Rename one of the caller's OWN keys. There is no admin equivalent of this
 * dialog and none is planned: the API only ever lets an owner rename their
 * own key (`renameOwnKey` checks `ownerId`, with no admin bypass), so this
 * lives under `employee/` rather than beside the shared internal-name editor.
 *
 * The warning shown before saving is computed, not assumed: it composes the
 * connection name before and after the edit with the SAME function and the
 * SAME `nameDisplay` flags the exported config uses
 * (`composeKeyDisplayName`), and only claims a re-issue is coming when that
 * comparison actually differs. A key whose displayed name does not include
 * the device label (`nameDisplay.label` off) is renamed just as plainly, but
 * without the "your current config stops working" warning, because nothing
 * about that config would actually change.
 */
export function KeyRenameDialog({
  open,
  deviceLabel,
  nodeName,
  keyNumber,
  nameDisplay,
  onClose,
  onSave,
}: {
  open: boolean;
  deviceLabel: string | null | undefined;
  nodeName: string;
  keyNumber?: number | null;
  nameDisplay: KeyNameDisplay;
  onClose: () => void;
  onSave: (deviceLabel: string) => Promise<boolean>;
}) {
  const { t } = useT();
  const [draft, setDraft] = React.useState(deviceLabel ?? "");
  const [saving, setSaving] = React.useState(false);

  // Reseeded on every open, never while open -- same reasoning as the
  // internal-name editor: a draft abandoned by closing must not look saved,
  // and a background key-list refresh must not overwrite what is being typed.
  React.useEffect(() => {
    if (!open) return;
    setDraft(deviceLabel ?? "");
    setSaving(false);
  }, [open, deviceLabel]);

  const outcome = renameKeyOutcome(draft, deviceLabel);
  const willReissue =
    outcome.canSave &&
    composeKeyDisplayName({
      serverName: nodeName,
      label: deviceLabel,
      keyNumber,
      display: nameDisplay,
    }) !==
      composeKeyDisplayName({
        serverName: nodeName,
        label: outcome.deviceLabel,
        keyNumber,
        display: nameDisplay,
      });

  const submit = async () => {
    if (!outcome.canSave) return;
    setSaving(true);
    const ok = await onSave(outcome.deviceLabel);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" />
            {t("keyCard.renameTitle")}
          </DialogTitle>
          <DialogDescription>{t("keyCard.renameDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="key-rename-label">{t("keyCard.renameLabel")}</Label>
            <Input
              id="key-rename-label"
              value={draft}
              autoFocus
              disabled={saving}
              maxLength={RENAME_LABEL_MAX}
              placeholder={t("keyCard.renamePlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>

          {/* The warning is conditional on purpose -- see the component doc
              comment. Saying "the current config stops working" when it does
              not would be a lie the operator explicitly asked this dialog not
              to tell. */}
          {willReissue ? (
            <Callout
              tone="warning"
              icon={<TriangleAlert className="h-4 w-4 text-warning" />}
              title={t("keyCard.renameReissueTitle")}
            >
              {t("keyCard.renameReissueBody")}
            </Callout>
          ) : outcome.canSave ? (
            <Callout
              tone="info"
              icon={<Info className="h-4 w-4 text-chart-4" />}
              title={t("keyCard.renameQuietTitle")}
            >
              {t("keyCard.renameQuietBody")}
            </Callout>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={saving || !outcome.canSave}
            onClick={() => void submit()}
          >
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
