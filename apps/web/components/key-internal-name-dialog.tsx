"use client";

import * as React from "react";
import { EyeOff, KeyRound, NotebookPen } from "lucide-react";
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
import { Callout, FieldHint } from "@/components/ui/hint";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * The operator-only note's length budget, straight from the column it lands
 * in: `internal_name varchar(80)` (migration 0026) and the contract's
 * `setKeyInternalNameRequestSchema` (`.max(80)`). Kept here so the editor can
 * show the cap instead of letting the API refuse a note the operator already
 * believed they had written.
 */
export const INTERNAL_NAME_MAX = 80;

/**
 * What the internal-name editor should post for a given draft.
 *
 * Three outcomes, and two of them look alike until you say them out loud —
 * the `window.prompt` this replaced encoded them as `null` versus `""`:
 *
 *  - `save`: store this text on the key;
 *  - `clear`: post an empty string, which the API stores as NULL — the
 *    operator deliberately removed the note, which is a decision, not a
 *    no-op;
 *  - `none`: post nothing at all. Cancel means this, and so does a draft that
 *    ends up identical to what the key already had: an admin who opens the
 *    editor to read a note must not be able to write an audit event by
 *    closing it.
 *
 * Trimmed and capped here rather than at the input, so paste and IME entry
 * land on the same value the field's own `maxLength` would allow.
 */
export function internalNameOutcome(
  draft: string,
  current: string | null | undefined,
): { action: "save" | "clear" | "none"; internalName: string } {
  const next = draft.slice(0, INTERNAL_NAME_MAX).trim();
  const before = (current ?? "").trim();
  if (next === before) return { action: "none", internalName: next };
  return { action: next === "" ? "clear" : "save", internalName: next };
}

/**
 * The operator-only note on a key, edited in the panel's own dialog rather
 * than a `window.prompt`.
 *
 * The prompt did the job, but it is a grey system box with no room to say the
 * one thing that makes this field usable: only an administrator ever sees what
 * is written here, so a real person's name is safe in it. That sentence is the
 * whole feature, and the browser gave it nowhere to live.
 *
 * The three outcomes the prompt distinguished by `null` versus `""` are three
 * separate buttons here — Cancel changes nothing, Clear removes the note, Save
 * stores it — and `internalNameOutcome` decides which of them posts what.
 *
 * Shared between the admin Users page, where an operator annotates somebody
 * else's key, and an administrator's own key card in the ordinary panel. One
 * editor, because it is one field with one explanation attached to it; a
 * second copy would drift and the explanation is the part that must not.
 */
export function KeyInternalNameDialog({
  open,
  deviceLabel,
  nodeName,
  internalName,
  onClose,
  onSave,
}: {
  open: boolean;
  deviceLabel: string;
  nodeName: string;
  internalName: string | null;
  onClose: () => void;
  onSave: (internalName: string) => Promise<boolean>;
}) {
  const { t } = useT();
  const [draft, setDraft] = React.useState(internalName ?? "");
  const [saving, setSaving] = React.useState(false);

  // Reseeded on every open, never while open: a draft abandoned by closing
  // the dialog must not come back looking like it was saved, and a background
  // refresh of the key list must not overwrite what is being typed.
  React.useEffect(() => {
    if (!open) return;
    setDraft(internalName ?? "");
    setSaving(false);
  }, [open]);

  const outcome = internalNameOutcome(draft, internalName);
  const submit = async (value: string) => {
    const decided = internalNameOutcome(value, internalName);
    // "none" never reaches the API: closing the editor on an unchanged note is
    // not an edit, and posting it would write an audit event saying it was.
    if (decided.action === "none") {
      onClose();
      return;
    }
    setSaving(true);
    const ok = await onSave(decided.internalName);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NotebookPen className="h-5 w-5 text-primary" />
            {t("users.internalNameTitle")}
          </DialogTitle>
          <DialogDescription>{t("users.internalNameDesc")}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {/* Which key is being annotated. A user can have several rows that
              differ only by node, and the editor is opened from a row whose
              own label scrolls out of sight behind the dialog. */}
          <div className="space-y-1.5">
            <Label>{t("users.internalNameFor")}</Label>
            <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {deviceLabel}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {nodeName}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="key-internal-name">{t("users.internalName")}</Label>
            <Input
              id="key-internal-name"
              value={draft}
              autoFocus
              disabled={saving}
              maxLength={INTERNAL_NAME_MAX}
              placeholder={t("users.internalNamePlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit(draft);
                }
              }}
            />
            {/* The cap is shown, not enforced in silence. The prompt handler
                cut the answer down to size after the fact, so an operator who
                pasted a longer note was told nothing and got a truncated one
                back. `maxLength` stops the 81st character; the counter says
                why. */}
            <div className="flex items-baseline justify-between gap-2">
              <FieldHint>
                {draft.length >= INTERNAL_NAME_MAX
                  ? t("users.internalNameCapped", { max: INTERNAL_NAME_MAX })
                  : t("users.internalNameHint")}
              </FieldHint>
              <span
                className={cn(
                  "tabular shrink-0 text-xs",
                  draft.length >= INTERNAL_NAME_MAX
                    ? "font-medium text-warning"
                    : "text-muted-foreground",
                )}
              >
                {draft.length} / {INTERNAL_NAME_MAX}
              </span>
            </div>
          </div>

          {/* The reason a person's name can go in this field at all, said on
              the screen where someone is about to type one. */}
          <Callout
            tone="info"
            icon={<EyeOff className="h-4 w-4 text-chart-4" />}
            title={t("users.internalNamePrivateTitle")}
          >
            {t("users.internalNamePrivate")}
          </Callout>
        </div>

        <DialogFooter>
          {/* Clearing is its own answer, not "save an empty box": the note is
              removed on purpose. Offered only when there is one to remove. */}
          {internalName ? (
            <Button
              variant="ghost"
              disabled={saving}
              className="text-muted-foreground hover:text-destructive sm:mr-auto"
              onClick={() => void submit("")}
            >
              {t("users.internalNameClear")}
            </Button>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={saving || outcome.action === "none"}
            onClick={() => void submit(draft)}
          >
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The note itself, drawn the same way wherever it is shown: a framed chip,
 * never a muted subtitle.
 *
 * Set in muted italics inside a label column it read as a subtitle of the
 * device label, and on a narrow screen it was squeezed down to a couple of
 * characters — when it is in fact something an operator wrote about this key
 * and needs to be able to read. The caller places it; the frame is what has to
 * match between the admin Users row and an administrator's own key card.
 */
export function InternalNameChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-chart-4/40 bg-chart-4/10 px-1.5 py-0.5 text-[11px] leading-tight">
      <NotebookPen className="size-3 shrink-0 text-chart-4" />
      <span className="truncate">{children}</span>
    </span>
  );
}
