"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Download,
  Globe,
  HardDrive,
  Laptop,
  Loader2,
  Monitor,
  QrCode,
  RefreshCw,
  ShieldHalf,
  Smartphone,
  Tablet,
  TabletSmartphone,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/status-badge";
import { Callout } from "@/components/ui/hint";
import { configUrl } from "@/lib/api";
import { formatDate, formatTraffic } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { KeyView, Me, NodeView } from "@/lib/types";

const ROUTE_LABEL: Record<string, string> = {
  full_tunnel: "route.full_tunnel",
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};

// Longer explanation shown on hover over the route chip.
const ROUTE_DESC: Record<string, string> = {
  full_tunnel: "wizard.route.full_tunnel.desc",
  ru_whitelist: "wizard.route.ru_whitelist.desc",
  ru_blacklist: "wizard.route.ru_blacklist.desc",
};

const PROTOCOL_LABEL: Record<string, string> = {
  awg2: "protocol.awg2",
  awg3: "protocol.awg3",
};

// Bigger, device-themed glyph per key so a phone key reads as a phone at a
// glance rather than a generic key icon.
const DEVICE_ICON: Record<string, React.ComponentType<{ className?: string }>> =
  {
    laptop: Laptop,
    desktop: Monitor,
    iphone: Smartphone,
    android: Smartphone,
    phone: Smartphone,
    phone2: Smartphone,
    tablet: Tablet,
    other: TabletSmartphone,
    unspecified: HardDrive,
  };

export function KeyCard({
  keyView,
  node,
  me,
  busy,
  onShowConfig,
  onRotate,
  onRevoke,
}: {
  keyView: KeyView;
  node?: NodeView;
  me: Me;
  busy: boolean;
  onShowConfig: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const { t, lang } = useT();
  const active = keyView.state === "active";
  const provisioning = keyView.state === "provisioning";
  // Rotation re-issues the peer with current rules; only meaningful for
  // rule-based profiles (a full-tunnel key never needs new rules).
  const canRotate = keyView.routeProfile !== "full_tunnel";
  const revocable =
    me.policy.allowSelfRevoke &&
    !["revoked", "revoking"].includes(keyView.state);
  const DeviceIcon = DEVICE_ICON[keyView.deviceType] ?? HardDrive;

  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-12 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/15">
              <DeviceIcon className="size-7" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium leading-tight">
                {keyView.deviceLabel || keyView.deviceType}
                {keyView.keyNumber != null ? (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    #{keyView.keyNumber}
                  </span>
                ) : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {node?.name ?? "—"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {provisioning ? (
              <Loader2 className="h-4 w-4 animate-spin text-warning" />
            ) : null}
            <StatusBadge value={keyView.state} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="gap-1">
            <ShieldHalf className="h-3 w-3" />
            {t(PROTOCOL_LABEL[keyView.protocol] ?? keyView.protocol)}
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="cursor-help gap-1">
                <Globe className="h-3 w-3" />
                {t(ROUTE_LABEL[keyView.routeProfile] ?? keyView.routeProfile)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-56">
              {t(ROUTE_DESC[keyView.routeProfile] ?? keyView.routeProfile)}
            </TooltipContent>
          </Tooltip>
        </div>

        {active && keyView.rulesOutdated ? (
          <Callout
            tone="warning"
            icon={<RefreshCw className="h-4 w-4 text-warning" />}
            title={t("keyCard.rulesUpdatedTitle")}
            action={
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={onRotate}
              >
                {t("keyCard.updateKey")}
              </Button>
            }
          >
            {t("keyCard.rulesUpdatedBody")}
          </Callout>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline">{t("keyCard.created")}</dt>
            <dd className="inline text-foreground">
              {formatDate(keyView.createdAt, lang)}
            </dd>
          </div>
          {me.policy.showTraffic ? (
            <div>
              <dt className="inline">{t("keyCard.traffic")}</dt>
              <dd className="inline text-foreground">
                {formatTraffic(keyView.traffic, lang)}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="flex items-center gap-1.5 border-t pt-3">
          {provisioning ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("keyCard.provisioning")}
            </span>
          ) : null}
          {active && me.policy.allowConfigRedownload ? (
            <>
              <CopyKeyButton keyId={keyView.id} disabled={busy} />
              {me.policy.allowQrDownload ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      aria-label={t("keyCard.showQr")}
                      onClick={onShowConfig}
                    >
                      <QrCode className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("keyCard.qrAndLink")}</TooltipContent>
                </Tooltip>
              ) : null}
              {me.policy.allowConfDownload ? (
                <IconLink
                  href={configUrl(keyView.id, "conf")}
                  label={t("common.downloadConf")}
                  icon={<Download className="h-4 w-4" />}
                  download
                />
              ) : null}
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            {/* Reissue lives here, apart from Copy and as a muted icon, so it is
                not mistaken for the primary "copy key" action. */}
            {active &&
            me.policy.allowConfigRedownload &&
            canRotate &&
            !keyView.rulesOutdated ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={onRotate}
                    aria-label={t("keyCard.reissue")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("keyCard.reissueTip")}</TooltipContent>
              </Tooltip>
            ) : null}
            {revocable ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={onRevoke}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("keyCard.revoke")}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IconLink({
  href,
  label,
  icon,
  download,
  newTab,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  download?: boolean;
  newTab?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="secondary" size="icon">
          <a
            href={href}
            aria-label={label}
            download={download}
            target={newTab ? "_blank" : undefined}
            rel={newTab ? "noreferrer" : undefined}
          >
            {icon}
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type CopyState = "idle" | "busy" | "copied" | "error";

/**
 * One-tap "copy the vpn:// key" button with self-managed feedback states.
 * Fetches the connection link on demand and writes it to the clipboard, then
 * shows a transient confirmation so the employee knows the paste is ready.
 */
function CopyKeyButton({
  keyId,
  disabled,
}: {
  keyId: string;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [state, setState] = React.useState<CopyState>("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };

  const copy = async () => {
    setState("busy");
    try {
      const res = await fetch(configUrl(keyId, "vpn"));
      if (!res.ok) throw new Error("failed");
      const text = (await res.text()).trim();
      await navigator.clipboard.writeText(text);
      setState("copied");
      toast.success(t("keyCard.copyToast"));
      reset();
    } catch {
      setState("error");
      toast.error(t("keyCard.copyErrToast"));
      reset();
    }
  };

  const content: Record<CopyState, React.ReactNode> = {
    idle: (
      <>
        <Copy className="h-4 w-4" /> {t("keyCard.copy")}
      </>
    ),
    busy: (
      <>
        <Loader2 className="h-4 w-4 animate-spin" /> {t("keyCard.copying")}
      </>
    ),
    copied: (
      <>
        <Check className="h-4 w-4" /> {t("keyCard.copied")}
      </>
    ),
    error: (
      <>
        <TriangleAlert className="h-4 w-4" /> {t("keyCard.copyFail")}
      </>
    ),
  };

  return (
    <Button
      type="button"
      variant={state === "copied" ? "secondary" : "default"}
      size="sm"
      disabled={disabled || state === "busy"}
      onClick={() => void copy()}
      className={state === "error" ? "text-destructive" : undefined}
    >
      {content[state]}
    </Button>
  );
}
