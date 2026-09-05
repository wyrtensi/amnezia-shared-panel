"use client";

import * as React from "react";
import {
  Check,
  CircleHelp,
  Copy,
  Download,
  Globe,
  Loader2,
  NotebookPen,
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
import {
  InternalNameChip,
  KeyInternalNameDialog,
} from "@/components/key-internal-name-dialog";
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
  onSetInternalName,
}: {
  keyView: KeyView;
  node?: NodeView;
  me: Me;
  busy: boolean;
  onShowConfig: () => void;
  onShowGuide: () => void;
  onRotate: () => void;
  onRevoke: () => void;
  onSetInternalName?: (internalName: string) => Promise<boolean>;
}) {
  const { t, lang } = useT();
  /**
   * The operator-only note is an administrator's own business, shown on an
   * administrator's own key — that is the point of having admin rights.
   *
   * This gate decides whether the trigger exists at all; it is NOT what keeps
   * the note away from a regular user. The server does that: `/api/keys`
   * leaves `internalName` off the payload entirely for a non-admin caller
   * (`internalNameFor` in control-api's keyView.ts), so there is nothing here
   * to hide and nothing in the JSON for a curious user to read. A gate that
   * lived only in this component would ship the note to every browser and
   * merely decline to draw it.
   */
  const isAdmin = me.role === "admin";
  const [editingInternal, setEditingInternal] = React.useState(false);
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
    <>
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

          {/* The operator-only note, on the administrator's own key. Same framed
              chip as the admin Users row rather than a second treatment: it is
              the same field, and a muted subtitle is what that row moved away
              from. The trigger carries the field's name, with the tooltip and
              `aria-label` saying whether it adds or edits — the row's wording,
              because the card has no room for the long phrase inline. */}
          {isAdmin ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {keyView.internalName ? (
                <InternalNameChip>{keyView.internalName}</InternalNameChip>
              ) : null}
              {onSetInternalName ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                      aria-label={
                        keyView.internalName
                          ? t("users.internalNameEdit")
                          : t("users.internalNameAdd")
                      }
                      onClick={() => setEditingInternal(true)}
                    >
                      <NotebookPen className="size-3" />
                      {t("users.internalName")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {keyView.internalName
                      ? t("users.internalNameEdit")
                      : t("users.internalNameAdd")}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          ) : null}

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
                  gate. It is the only download drawn as a button, because it is
                  the shape that survives import with the connection name the
                  panel gave it. It is not coloured as a primary action either —
                  Copy is — so the row still reads as one route to the key.
                */}
                <FormatDownload
                  href={configUrl(keyView.id, "vpn")}
                  format=".vpn"
                  label={t("common.downloadVpnFile")}
                />
                {/*
                  `.conf` last and drawn as a bare muted link rather than a
                  button: as an outlined button beside `.vpn` it still read as a
                  choice between two files, and offered as a choice it gets taken
                  by coin-flip — the user only finds out which one they took when
                  the connection arrives named "Server 1", because the client
                  renames every imported `.conf` whatever is inside it. It stays
                  in this row rather than moving behind the download dialog's
                  disclosure the way the dialog's own copy did: that dialog is
                  reachable only through the QR button, which has a policy flag of
                  its own, and `.conf` must not start depending on that flag.
                  `allowConfDownload` still decides, by itself, whether it exists
                  at all, and the tooltip and `aria-label` still say the whole
                  phrase.
                */}
                {me.policy.allowConfDownload ? (
                  <FormatDownload
                    href={configUrl(keyView.id, "conf")}
                    format=".conf"
                    label={t("common.downloadConf")}
                    quiet
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

      {isAdmin && onSetInternalName ? (
        <KeyInternalNameDialog
          open={editingInternal}
          deviceLabel={keyView.deviceLabel || deviceTypeLabel(t, keyView.deviceType)}
          nodeName={node?.name ?? "—"}
          internalName={keyView.internalName ?? null}
          onClose={() => setEditingInternal(false)}
          onSave={onSetInternalName}
        />
      ) : null}
    </>
  );
}

/**
 * One config download, labelled with the extension it produces.
 *
 * The extension is written verbatim rather than translated: it is a file name,
 * the same in every language and the same thing the user will see in their
 * downloads folder. The full wording stays on the tooltip and on the
 * `aria-label`, so a screen reader still hears "Download .vpn" and not a dot.
 *
 * `quiet` is the fallback's dress: no fill, no border, no download glyph and
 * muted text, so it carries the weight of a footnote next to the button beside
 * it. It stays a real, focusable link with the same tooltip and `aria-label` —
 * quieter to the eye only, not to a screen reader or to the keyboard.
 */
function FormatDownload({
  href,
  format,
  label,
  quiet = false,
}: {
  href: string;
  format: string;
  label: string;
  quiet?: boolean;
}) {
  const variant: ButtonProps["variant"] = quiet ? "link" : "secondary";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant={variant}
          size="sm"
          className={
            quiet
              ? "px-1 font-normal text-muted-foreground hover:text-foreground"
              : undefined
          }
        >
          <a href={href} aria-label={label} download>
            {quiet ? null : <Download className="h-4 w-4" />}
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
