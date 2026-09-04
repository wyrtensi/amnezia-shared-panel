"use client";

import * as React from "react";
import { LifeBuoy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/hint";
import { useT } from "@/lib/i18n/provider";

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
 * The field headings are the wizard's own labels (`wizard.*`, `route.*`) so
 * the explanation and the form can never call the same control two names.
 */
export function KeyHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("keyHelp.title")}</DialogTitle>
          <DialogDescription>{t("keyHelp.desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <Field title={t("keyHelp.namesTitle")}>{t("keyHelp.namesBody")}</Field>
          <Field title={t("wizard.server")}>{t("keyHelp.serverBody")}</Field>
          <Field title={t("wizard.routing")}>
            <p>{t("keyHelp.routingBody")}</p>
            <p>{t("keyHelp.profilesIntro")}</p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <span className="font-medium text-foreground">
                  {t("route.ru_whitelist")}
                </span>{" "}
                — {t("keyHelp.whitelistBody")}
              </li>
              <li>
                <span className="font-medium text-foreground">
                  {t("route.ru_blacklist")}
                </span>{" "}
                — {t("keyHelp.blacklistBody")}
              </li>
            </ul>
          </Field>
        </div>

        <Callout
          tone="info"
          icon={<LifeBuoy className="h-4 w-4" />}
          title={t("keyHelp.troubleTitle")}
        >
          {t("keyHelp.troubleBody")}
        </Callout>

        <DialogFooter>
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

/** One wizard field: its own label, then what to put in it. */
function Field({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="space-y-1.5 text-muted-foreground">{children}</div>
    </section>
  );
}
