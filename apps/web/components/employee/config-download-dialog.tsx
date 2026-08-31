"use client";

import * as React from "react";
import { Check, Copy, Download } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { configUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { Me } from "@/lib/types";

export type ConfigTarget = { id: string; deviceLabel: string };

const QR_SIZES = { s: 220, m: 320, l: 460 } as const;
type QrSize = keyof typeof QR_SIZES;
const QR_SIZE_LABEL: Record<QrSize, string> = {
  s: "config.qrSmall",
  m: "config.qrMedium",
  l: "config.qrLarge",
};

export function ConfigDownloadDialog({
  target,
  onClose,
  me,
}: {
  target: ConfigTarget | null;
  onClose: () => void;
  me: Me | null;
}) {
  const { t } = useT();
  const [vpnLink, setVpnLink] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [qrSize, setQrSize] = React.useState<QrSize>("m");

  React.useEffect(() => {
    if (!target) return;
    let active = true;
    setVpnLink(null);
    setFailed(false);
    setCopied(false);
    setQrSize("m");
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(configUrl(target.id, "vpn"));
        if (!res.ok) throw new Error("failed");
        const text = await res.text();
        if (active) setVpnLink(text.trim());
      } catch {
        if (active) setFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [target]);

  const copy = async () => {
    if (!vpnLink) return;
    try {
      await navigator.clipboard.writeText(vpnLink);
      setCopied(true);
      toast.success(t("config.keyCopied"));
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error(t("config.copyFailed"));
    }
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("config.title", { label: target?.deviceLabel ?? "" })}</DialogTitle>
          <DialogDescription>
            {t("config.desc")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="mx-auto h-64 w-64" />
          </div>
        ) : failed ? (
          <p className="text-sm text-destructive">{t("config.loadFailed")}</p>
        ) : vpnLink ? (
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
                <Button
                  type="button"
                  variant={copied ? "secondary" : "default"}
                  onClick={() => void copy()}
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" /> {t("config.done")}
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" /> {t("config.copy")}
                    </>
                  )}
                </Button>
              </div>
            </div>

            {me?.policy.allowQrDownload && target ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("config.qr")}</Label>
                  <div
                    className="flex items-center gap-1"
                    role="group"
                    aria-label={t("config.qrSizeAria")}
                  >
                    {(Object.keys(QR_SIZES) as QrSize[]).map((size, index) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => setQrSize(size)}
                        aria-label={t("config.qrSizeItemAria", {
                          size: t(QR_SIZE_LABEL[size]),
                        })}
                        aria-pressed={qrSize === size}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
                          qrSize === size
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        <span
                          className="rounded-[2px] bg-current"
                          style={{
                            width: 6 + index * 3,
                            height: 6 + index * 3,
                          }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mx-auto w-fit rounded-xl border bg-white p-3 shadow-sm">
                  <img
                    src={configUrl(target.id, "qr")}
                    alt={t("config.qrAlt")}
                    style={{
                      width: `min(${QR_SIZES[qrSize]}px, 82vw)`,
                      height: "auto",
                    }}
                    className="block aspect-square"
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  {t("config.qrHint")}
                </p>
              </div>
            ) : null}

            {me?.policy.allowConfDownload && target ? (
              <Button asChild variant="outline" className="w-full">
                <a href={configUrl(target.id, "conf")} download>
                  <Download className="h-4 w-4" /> {t("common.downloadConf")}
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
