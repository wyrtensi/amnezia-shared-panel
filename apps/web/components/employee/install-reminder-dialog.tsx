"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { MIN_AWG3_CLIENT_VERSION } from "@amnezia/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/ui/hint";
import { useT } from "@/lib/i18n/provider";

/**
 * The step between "your key is ready" and the connection guide.
 *
 * Why it exists: every key this panel issues is an AmneziaWG 3.1 key, and an
 * AmneziaVPN older than MIN_AWG3_CLIENT_VERSION cannot read one. The failure is
 * quiet — the old client starts, looks healthy, and simply never connects — so
 * a user who already has the app installed concludes that the panel is broken.
 * Saying "this is important" would not prevent that; saying WHY it will not
 * work is the whole point of the dialog.
 *
 * Who sees it, and when, is decided in `lib/install-reminder.ts` and applied by
 * the dashboard AFTER the key exists. This component only draws it.
 */
export function InstallReminderDialog({
  open,
  onOpenChange,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand over to the connection guide. The dialog closes as the guide opens. */
  onContinue: () => void;
}) {
  const { t } = useT();
  const [acknowledged, setAcknowledged] = React.useState(false);

  // Every opening starts unticked. The box is a statement about the key just
  // created, not a preference to remember: carrying a tick over from the
  // previous key would hand the user a live "Next" they never earned.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) setAcknowledged(false);
    wasOpen.current = open;
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("installReminder.title")}</DialogTitle>
          <DialogDescription>{t("installReminder.desc")}</DialogDescription>
        </DialogHeader>
        <InstallReminderBody
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onLater={() => onOpenChange(false)}
          onContinue={onContinue}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything inside the dialog frame, as a plain component.
 *
 * Split out because it is the half worth testing — the checkbox gate — and
 * because the frame around it is a Radix portal that renders nothing at all
 * outside a browser. This part is ordinary markup, so a test can render it and
 * read the `disabled` attribute off the real button rather than trusting a
 * copy of the rule.
 */
export function InstallReminderBody({
  acknowledged,
  onAcknowledgedChange,
  onLater,
  onContinue,
}: {
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  onLater: () => void;
  onContinue: () => void;
}) {
  const { t } = useT();
  return (
    <div className="space-y-4">
      {/* The panel's existing weight signal for "read this": the same warning
          Callout and TriangleAlert the install guide uses for a stale download
          link or the iOS profile caveat. Deliberately not `danger` — nothing
          has gone wrong, there is simply one step left. */}
      <Callout
        tone="warning"
        icon={<TriangleAlert className="h-5 w-5" />}
        title={t("installReminder.headline")}
      >
        <p className="text-sm text-foreground">
          {t("installReminder.mandatory")}
        </p>
      </Callout>

      <p className="text-sm leading-snug text-muted-foreground">
        {t("installReminder.why", { version: MIN_AWG3_CLIENT_VERSION })}
      </p>
      <p className="text-sm leading-snug text-muted-foreground">
        {t("installReminder.looksFine")}
      </p>

      <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 p-3">
        {/* `autoComplete="off"` is load-bearing, not boilerplate. Chrome
            restores form-control state across a reload of the same URL, and
            with it restored the tick on this box: reload the panel after
            ticking it once and the next key opened this dialog with the gate
            already open, which is precisely the thing the gate exists to
            prevent. Observed in the dev stack; off tells the browser not to
            remember it. */}
        <Checkbox
          id="install-reminder-ack"
          autoComplete="off"
          className="mt-0.5"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        />
        <Label
          htmlFor="install-reminder-ack"
          className="cursor-pointer text-sm font-medium leading-snug"
        >
          {t("installReminder.confirm")}
        </Label>
      </div>

      <DialogFooter>
        {/* Closable, and it says so. A modal with no way out is hostile, and
            the dialog returns on the next key while the user is still inside
            their first few — it is a reminder, not a gate on the panel. */}
        <Button type="button" variant="outline" onClick={onLater}>
          {t("installReminder.later")}
        </Button>
        <Button type="button" disabled={!acknowledged} onClick={onContinue}>
          {t("installReminder.next")}
        </Button>
      </DialogFooter>
      <p className="text-xs leading-snug text-muted-foreground">
        {t("installReminder.nextHint")}
      </p>
    </div>
  );
}
