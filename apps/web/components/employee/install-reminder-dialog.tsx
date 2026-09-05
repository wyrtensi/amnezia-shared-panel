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
 * Where the user is inside the dialog's two-step confirmation.
 *
 * `challenged` is round two: the first "Next" has been pressed and answered
 * with a doubt rather than the guide. It never falls back to round one on its
 * own — only a fresh opening resets it.
 */
export type InstallReminderStep = {
  acknowledged: boolean;
  challenged: boolean;
};

/** Every opening starts here: unticked, round one. */
export const INSTALL_REMINDER_START: InstallReminderStep = {
  acknowledged: false,
  challenged: false,
};

/** Everything that can happen to the dialog while it is on screen. */
export type InstallReminderEvent =
  | { type: "opened" }
  | { type: "ticked"; value: boolean }
  | { type: "pressed" };

/**
 * The whole two-step confirmation, as a pure function.
 *
 * Pure and exported because the state machine has to be testable where the
 * component is not: the dialog frame is a Radix portal that renders nothing
 * outside a browser, and this repo's vitest runs on `environment: "node"`.
 * Keeping "opened" in here rather than in an effect means the reset between
 * two keys is a transition a test can exercise, not a constant it restates.
 *
 * `proceed` is the only way to the guide, and the FIRST press never sets it.
 * That press takes the tick back and moves to round two, so the user has to
 * confirm a second time — deliberate friction against clicking through a
 * warning unread. Only the second press hands over.
 */
export function installReminderStep(
  step: InstallReminderStep,
  event: InstallReminderEvent,
): { step: InstallReminderStep; proceed: boolean } {
  switch (event.type) {
    case "opened":
      // A fresh key, a fresh dialog: back to round one, unticked. Carrying
      // either flag over would hand the user a live button they never earned.
      return { step: INSTALL_REMINDER_START, proceed: false };
    case "ticked":
      return { step: { ...step, acknowledged: event.value }, proceed: false };
    case "pressed":
      if (!step.challenged) {
        return {
          step: { acknowledged: false, challenged: true },
          proceed: false,
        };
      }
      return { step, proceed: true };
  }
}

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
 *
 * There is no soft exit. A "Later" button would be a third state — not read,
 * and yet dismissed approvingly — which is exactly what the two-step
 * confirmation below exists to close off. The ✕ and Esc still work, and the
 * dialog returns on the next key while the user is inside their first few.
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
  const [step, setStep] = React.useState(INSTALL_REMINDER_START);

  // Every opening replays the "opened" event, which puts the dialog back into
  // round one with the box clear.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setStep(
        (current) => installReminderStep(current, { type: "opened" }).step,
      );
    }
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
          acknowledged={step.acknowledged}
          challenged={step.challenged}
          onAcknowledgedChange={(value) =>
            setStep(
              (current) =>
                installReminderStep(current, { type: "ticked", value }).step,
            )
          }
          onSubmit={() => {
            const pressed = installReminderStep(step, { type: "pressed" });
            setStep(pressed.step);
            if (pressed.proceed) onContinue();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything inside the dialog frame, as a plain component.
 *
 * Split out because it is the half worth testing — the two-step gate — and
 * because the frame around it is a Radix portal that renders nothing at all
 * outside a browser. This part is ordinary markup, so a test can render it and
 * read the `disabled` attribute off the real button rather than trusting a
 * copy of the rule.
 */
export function InstallReminderBody({
  acknowledged,
  challenged,
  onAcknowledgedChange,
  onSubmit,
}: {
  acknowledged: boolean;
  /** Round two: the first "Next" has been pressed and answered with a doubt. */
  challenged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  /** Press of the one button. Round one challenges; round two proceeds. */
  onSubmit: () => void;
}) {
  const { t } = useT();
  const checkboxRef = React.useRef<HTMLInputElement>(null);

  // The button the user just pressed becomes disabled the instant round two
  // starts, and a disabled control drops focus to <body> — leaving a keyboard
  // or screen-reader user nowhere. Focus goes to the checkbox instead, which
  // is the only thing left to do and announces its own new label on arrival.
  React.useEffect(() => {
    if (challenged) checkboxRef.current?.focus();
  }, [challenged]);

  const confirmLabel = challenged
    ? t("installReminder.confirmAgain")
    : t("installReminder.confirm");
  // Round two shows the doubt until the box is ticked again; ticking it turns
  // the button back into "Next". The round-one pair never returns — only
  // closing and reopening the dialog resets that.
  const buttonLabel =
    challenged && !acknowledged
      ? t("installReminder.doubt")
      : t("installReminder.next");

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
          ref={checkboxRef}
          autoComplete="off"
          className="mt-0.5"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        />
        <Label
          htmlFor="install-reminder-ack"
          className="cursor-pointer text-sm font-medium leading-snug"
        >
          {confirmLabel}
        </Label>
      </div>

      {/* The button renames itself and goes disabled while it holds focus, and
          assistive technology does not reliably re-read a control it is
          already sitting on. This region carries the change out of band: it is
          in the DOM from the start (a live region added at the same moment as
          its text is often missed) and stays empty until there is something to
          say. `polite` so it waits for the checkbox focus announcement rather
          than talking over it. */}
      <p role="status" aria-live="polite" className="sr-only">
        {challenged && !acknowledged
          ? `${t("installReminder.doubt")}. ${t("installReminder.challenge")}`
          : ""}
      </p>

      <DialogFooter>
        <Button type="button" disabled={!acknowledged} onClick={onSubmit}>
          {buttonLabel}
        </Button>
      </DialogFooter>
      <p className="text-xs leading-snug text-muted-foreground">
        {t("installReminder.nextHint")}
      </p>
    </div>
  );
}
