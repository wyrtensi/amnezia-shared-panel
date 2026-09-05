"use client";

import * as React from "react";
import {
  Check,
  CircleHelp,
  Copy,
  Download,
  Globe,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldHalf,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/status-badge";
import { Callout } from "@/components/ui/hint";
import { configUrl } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { TrafficSplit } from "@/components/inline-traffic";
import { useT } from "@/lib/i18n/provider";
import { deviceIconFor } from "@/components/device-icon";
import { deviceTypeLabel } from "@/lib/device-type";
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

export function KeyCard({
  keyView,
  node,
  me,
  busy,
  onShowConfig,
  onShowGuide,
  onRotate,
  onRevoke,
}: {
  keyView: KeyView;
  node?: NodeView;
  me: Me;
  busy: boolean;
  onShowConfig: () => void;
  onShowGuide: () => void;
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
  const DeviceIcon = deviceIconFor(keyView.deviceType);

  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-12 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/15">
              <DeviceIcon className="size-7" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-0.5">
                <p className="truncate font-medium leading-tight">
                  {keyView.deviceLabel || deviceTypeLabel(t, keyView.deviceType)}
                  {keyView.keyNumber != null ? (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      #{keyView.keyNumber}
                    </span>
                  ) : null}
                </p>
                {/* The guide lives on the key, not in the page header: the card
                    knows which device the key was labelled for, so it opens
                    straight to that instruction. Icon-only because the title
                    must keep the room it needs to stay readable. */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-muted-foreground"
                      aria-label={t("install.button")}
                      onClick={onShowGuide}
                    >
                      <CircleHelp className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("install.button")}</TooltipContent>
                </Tooltip>
              </div>
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
            {/* Named profile, not a generic "rules changed": `rulesOutdated`
                is set per profile — this key's own profile has a newer rule
                version than the one it was issued with — so the callout can
                say which of them moved and why this card is the one showing
                it. Same label the route chip above uses. */}
            {t("keyCard.rulesUpdatedBody", {
              profile: t(
                ROUTE_LABEL[keyView.routeProfile] ?? keyView.routeProfile,
              ),
            })}
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
              <dt className="inline">{t("keyCard.traffic")}</dt>{" "}
              <dd className="inline-flex text-foreground">
                <TrafficSplit pair={keyView.traffic} />
              </dd>
            </div>
          ) : null}
        </dl>

        {/* Wraps: at a phone width the labelled downloads no longer fit beside
            Copy, and a row that cannot wrap pushes them out of reach instead. */}
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
          {provisioning ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("keyCard.provisioning")}
            </span>
          ) : null}
          {active && me.policy.allowConfigRedownload ? (
            <>
              {/* QR first: it is the shortcut for the common case — the panel
                  is open on a computer and the key has to reach a phone — and
                  the action that leads the row is the easiest one to find.

                  Labelled and outlined rather than left as a bare icon, so it
                  reads as a sibling of Copy instead of as a stray glyph. Copy
                  is the row's primary and paints itself `bg-primary`, so the
                  border here is `border-primary`: the same token, tracking the
                  theme in both light and dark rather than a pinned hex. */}
              {me.policy.allowQrDownload ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="border border-primary"
                      aria-label={t("keyCard.showQr")}
                      onClick={onShowConfig}
                    >
                      <QrCode className="h-4 w-4" />
                      {t("keyCard.qrShort")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("keyCard.qrAndLink")}</TooltipContent>
                </Tooltip>
              ) : null}
              <CopyKeyButton keyId={keyView.id} disabled={busy} />
              {/*
                Two downloads that used to be two identical download icons, so
                which one a user pressed was luck. They now carry the extension
                as their label.

                The `.vpn` file carries the same `vpn://` payload the Copy
                button already hands out as text, so it needs no extra policy
                gate. It leads because it is the shape that survives import
                with the connection name the panel gave it; `.conf` always
                lands as "Server N" regardless of what is inside it, so it
                comes last, in the quietest variant, behind its own flag, for
                awg-quick and router firmwares. Neither is coloured as a
                primary action: the ordering says which one to take.
              */}
              <FormatDownload
                href={configUrl(keyView.id, "vpn")}
                format=".vpn"
                label={t("common.downloadVpnFile")}
                variant="secondary"
              />
              {me.policy.allowConfDownload ? (
                <FormatDownload
                  href={configUrl(keyView.id, "conf")}
                  format=".conf"
                  label={t("common.downloadConf")}
                  variant="outline"
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

/**
 * One config download, labelled with the extension it produces.
 *
 * The extension is written verbatim rather than translated: it is a file name,
 * the same in every language and the same thing the user will see in their
 * downloads folder. The full wording stays on the tooltip and on the
 * `aria-label`, so a screen reader still hears "Download .vpn" and not a dot.
 */
function FormatDownload({
  href,
  format,
  label,
  variant = "secondary",
}: {
  href: string;
  format: string;
  label: string;
  variant?: ButtonProps["variant"];
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant={variant} size="sm">
          <a href={href} aria-label={label} download>
            <Download className="h-4 w-4" />
            {format}
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
