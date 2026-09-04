"use client";

import * as React from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  LifeBuoy,
  TriangleAlert,
} from "lucide-react";
import { DEVICE_ICON } from "@/components/device-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/hint";
import { useT } from "@/lib/i18n/provider";

/**
 * The example key and server the mock controls show.
 *
 * Not translated: they stand in for what the user typed and for a server name,
 * and both are the same in every language. They agree with each other on
 * purpose - step 3's preview line is built from both, exactly as the form
 * builds it.
 */
const SAMPLE_KEY_NAME = "Android 8";
const SAMPLE_NODE = "london1";

/**
 * "I don't understand how to make a key" — the form, field by field.
 *
 * Deliberately NOT the install guide. This dialog explains the create-key
 * wizard and stops there: installing the client, scanning a code and
 * connecting live behind "How to connect" (InstallGuideDialog). A sentence
 * about the client app in here is a sentence in the wrong dialog — the two
 * were split because a user who cannot get past the form was being handed
 * install instructions they had already followed.
 *
 * **The order is the form's order, and the numbers say so.** Somebody opens
 * this while looking at the form, part way down it, and needs to find the field
 * in front of them. Two earlier attempts got that wrong: one grouped the fields
 * by topic and silently dropped the first one, "Device type"; the other laid
 * them out as cards in two columns, which reads as a menu rather than as a
 * sequence. Every step here is one field of `create-key-wizard.tsx`, in the
 * order they appear on screen, headed by that field's own label — the same
 * `t()` key the form uses, so the two can never call one control two names.
 *
 * `wizard.protocol` is deliberately absent: it is rendered only when the node
 * offers a choice, so most users never see it, and explaining a field that is
 * not on their screen costs more than it gives.
 *
 * Not a paged wizard with a "next" button either: the form it explains is a
 * single screen.
 */
export function KeyHelpDialog({
  open,
  onOpenChange,
  onOpenGuide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand over to the connect guide — the half this dialog deliberately omits. */
  onOpenGuide: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("keyHelp.title")}</DialogTitle>
          <DialogDescription>{t("keyHelp.desc")}</DialogDescription>
        </DialogHeader>

        <ol className="divide-y divide-border">
          <Step number={1} title={t("wizard.deviceType")}>
            <p>{t("keyHelp.deviceBody")}</p>
            <p>{t("keyHelp.deviceOneEach")}</p>
            <Mock>
              <div className="grid grid-cols-3 gap-1.5">
                {(["android", "ios", "windows"] as const).map((device, index) => {
                  const Icon = DEVICE_ICON[device];
                  return (
                    <Tile key={device} selected={index === 0}>
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded [&_svg]:size-4 ${
                          index === 0
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <Icon />
                      </span>
                      <span className="break-words">{t(`device.${device}`)}</span>
                    </Tile>
                  );
                })}
              </div>
            </Mock>
          </Step>

          <Step number={2} title={t("common.name")}>
            <p>{t("keyHelp.nameBody")}</p>
            <Mock>
              <div className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground">
                {SAMPLE_KEY_NAME}
              </div>
            </Mock>
          </Step>

          <Step number={3} title={t("wizard.nameDisplay")}>
            <p>{t("keyHelp.namesBody")}</p>
            <Mock>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <Tick checked>{t("wizard.nameDisplay.server")}</Tick>
                <Tick checked>{t("wizard.nameDisplay.label")}</Tick>
                <Tick>{t("wizard.nameDisplay.number")}</Tick>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("wizard.nameDisplayPreview", {
                  value: `${SAMPLE_NODE} ${SAMPLE_KEY_NAME}`,
                })}
              </p>
            </Mock>
          </Step>

          <Step number={4} title={t("wizard.server")}>
            <p>{t("keyHelp.serverBody")}</p>
            <Mock>
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs">
                <span className="font-medium text-foreground">{SAMPLE_NODE}</span>
                <Badge variant="success">{t("wizard.recommended")}</Badge>
                <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
              </div>
            </Mock>
          </Step>

          <Step number={5} title={t("wizard.routing")}>
            <Mock>
              <div className="grid grid-cols-3 gap-1.5">
                <Tile selected>{t("route.full_tunnel")}</Tile>
                <Tile>{t("route.ru_whitelist")}</Tile>
                <Tile>{t("route.ru_blacklist")}</Tile>
              </div>
            </Mock>
            {/* The safe answer, first and marked as such. Someone who reads
                nothing else should still leave with this one. */}
            <Profile
              tone="good"
              name={t("route.full_tunnel")}
              badge={t("keyHelp.alwaysWorks")}
            >
              {t("keyHelp.routingBody")}
            </Profile>
            <p>{t("keyHelp.profilesIntro")}</p>
            <Profile
              tone="caution"
              name={t("route.ru_whitelist")}
              badge={t("keyHelp.noGuarantee")}
            >
              {t("keyHelp.whitelistBody")}
            </Profile>
            <Profile
              tone="caution"
              name={t("route.ru_blacklist")}
              badge={t("keyHelp.noGuarantee")}
            >
              {t("keyHelp.blacklistBody")}
            </Profile>
          </Step>
        </ol>

        <Callout
          tone="info"
          icon={<LifeBuoy className="h-4 w-4" />}
          title={t("keyHelp.troubleTitle")}
        >
          {t("keyHelp.troubleBody")}
        </Callout>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="secondary" onClick={onOpenGuide}>
            <BookOpen className="h-4 w-4" />
            {t("keyHelp.thenConnect")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One field of the form: its position, its own label, then what to put in it. */
function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="mb-1 text-sm font-semibold">{title}</h3>
        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </li>
  );
}

/**
 * One routing profile.
 *
 * The badge carries the only thing that decides between them — whether it is
 * guaranteed to work — because that is the part a user skips when it is buried
 * in a sentence, and it is the part that sends them back here later.
 */
function Profile({
  tone,
  name,
  badge,
  children,
}: {
  tone: "good" | "caution";
  name: string;
  badge: string;
  children: React.ReactNode;
}) {
  const good = tone === "good";
  return (
    <div
      className={`rounded-md border-l-2 py-1.5 pl-3 ${
        good ? "border-l-success bg-success/5" : "border-l-border"
      }`}
    >
      <div className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {/* The app's own badge: its success and warning tones already read
            correctly in both themes. */}
        <Badge variant={good ? "success" : "warning"} className="gap-1">
          {good ? (
            <Check className="h-3 w-3" aria-hidden="true" />
          ) : (
            <TriangleAlert className="h-3 w-3" aria-hidden="true" />
          )}
          {badge}
        </Badge>
      </div>
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * A picture of a control, not a control.
 *
 * `aria-hidden` and `pointer-events-none`, and nothing inside is a button, an
 * input or a checkbox - they are divs wearing the same classes. So there is
 * nothing to tab to, nothing to click that does nothing, and a screen reader
 * hears the step's sentence rather than a second, fake form.
 *
 * It exists because recognition beats description: someone stuck on the form is
 * looking for the thing on their screen, and a small likeness of it finds the
 * field faster than a sentence naming it.
 */
function Mock({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden="true" className="pointer-events-none select-none pt-0.5">
      {children}
    </div>
  );
}

/** One option tile, at the size a picture of one wants to be. */
function Tile({
  selected,
  children,
}: {
  selected?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs leading-tight ${
        selected
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border bg-card text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}

/** One tick box. */
function Tick({
  checked,
  children,
}: {
  checked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border"
        }`}
      >
        {checked ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      <span className={checked ? "text-foreground" : "text-muted-foreground"}>
        {children}
      </span>
    </span>
  );
}
