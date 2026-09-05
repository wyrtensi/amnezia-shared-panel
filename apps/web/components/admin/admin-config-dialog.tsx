"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { configUrl } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

export type AdminConfigTarget = { id: string; deviceLabel: string };

export function AdminConfigDialog({
  target,
  onClose,
}: {
  target: AdminConfigTarget | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [confirmed, setConfirmed] = React.useState(false);
  const [vpnLink, setVpnLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setConfirmed(false);
    setVpnLink(null);
    setCopied(false);
  }, [target]);

  const confirm = async (next: boolean) => {
    setConfirmed(next);
    if (!next || !target) {
      setVpnLink(null);
      return;
    }
    try {
      const res = await fetch(
        `${configUrl(target.id, "vpn")}&adminConfirmed=true`,
      );
      if (!res.ok) throw new Error("failed");
      setVpnLink((await res.text()).trim());
    } catch {
      toast.error(t("acfg.fetchFailed"));
      setConfirmed(false);
    }
  };

  const copy = async () => {
    if (!vpnLink) return;
    await navigator.clipboard.writeText(vpnLink);
    setCopied(true);
    toast.success(t("acfg.copied"));
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("acfg.title")}</DialogTitle>
          <DialogDescription className="flex items-start gap-2 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {t("acfg.warning")}
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span className="text-sm">
            {t("acfg.confirmLabel")}
          </span>
          <Switch checked={confirmed} onCheckedChange={(v) => void confirm(v)} />
        </label>

        {confirmed && vpnLink && target ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("config.connectionKey")}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={vpnLink}
                  className="font-mono text-xs"
                  onClick={(event) =>
                    (event.target as HTMLInputElement).select()
                  }
                />
                <Button variant="secondary" onClick={() => void copy()}>
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            {/*
              Two files, and only the first one keeps the key's name. The
              client's importer sniffs a file's content, not its extension, so
              the `.vpn` file — the same `vpn://` payload as the field above —
              imports through the same "File with connection settings" flow and
              arrives under the name the panel composed. A `.conf` cannot: the
              importer assigns "Server N" itself and reads no name from the file
              or its file name. So the `.vpn` one is the button, and the `.conf`
              moves one click behind a disclosure that says what it is still
              for. An admin sending a user a file should not be able to pick the
              wrong one by reflex, and the ones who genuinely need `.conf` —
              awg-quick, router firmware — know to open it.
            */}
            <div className="space-y-2">
              <Button asChild className="w-full">
                <a
                  href={`${configUrl(target.id, "vpn")}&adminConfirmed=true`}
                  download
                >
                  <Download className="h-4 w-4" /> {t("common.downloadVpnFile")}
                </a>
              </Button>
              <details className="group rounded-lg border bg-muted/30 px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground">
                  <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                  {t("config.otherFormat")}
                </summary>
                <div className="mt-2.5 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t("config.fileShapesHint")}
                  </p>
                  <Button asChild variant="outline" className="w-full">
                    <a
                      href={`${configUrl(target.id, "conf")}&adminConfirmed=true`}
                      download
                    >
                      <Download className="h-4 w-4" />{" "}
                      {t("common.downloadConf")}
                    </a>
                  </Button>
                </div>
              </details>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
