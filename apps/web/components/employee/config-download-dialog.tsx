"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Maximize2,
  Pause,
  Play,
  QrCode,
  X,
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
import { Skeleton } from "@/components/ui/skeleton";
import { configUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Me } from "@/lib/types";

export type ConfigTarget = {
  id: string;
  deviceLabel: string;
  routeProfile: string;
};

/**
 * Which scanner the user is holding.
 *
 * `app` is the in-app scanner of AmneziaVPN **and** of DefaultVPN. One tab, not
 * two: DefaultVPN is a fork of amnezia-client and its scanner is byte-identical
 * -- magic 1984, an 8-byte header, 850-byte chunks, a qCompress body, base64url
 * (`client/core/qrCodeUtils.cpp:8-17` and
 * `client/ui/controllers/importController.cpp:643-669` in
 * github.com/amnezia-vpn/DefaultVPN@dev). Showing the same picture twice under
 * two brand names only invites the question of what the difference is.
 *
 * `camera` serves the single-frame `vpn://` code that a camera app hands to the
 * OS. It is a different payload, not a different picture of the same one: no
 * in-app scanner can read a `vpn://` symbol (the prefix is stripped only on the
 * paste/import path, never on the scan path), and no camera app can read the
 * chunk envelope.
 */
type QrAudience = "app" | "camera";

/** Tab order: the in-app scanner leads; the camera is the fallback. */
const QR_AUDIENCES = ["app", "camera"] as const;

/**
 * True for the audience served by the chunk envelope. Every VPN app that reads
 * a code reads that one; only the camera path takes the `vpn://` symbol.
 */
const usesFrames = (audience: QrAudience): boolean => audience !== "camera";

/** Copy per audience, kept in one place so a new client is three strings. */
const QR_AUDIENCE_LABEL_KEYS: Record<QrAudience, MessageKey> = {
  app: "config.qrForApp",
  camera: "config.qrForCamera",
};
const QR_AUDIENCE_WARNING_KEYS: Record<QrAudience, MessageKey> = {
  app: "config.qrAppWarning",
  camera: "config.qrAppWarning", // unused: the camera code needs no warning.
};
const QR_AUDIENCE_HINT_KEYS: Record<QrAudience, MessageKey> = {
  app: "config.qrHintApp",
  camera: "config.qrHint",
};

/** The two display modes for a multi-frame series. */
type QrFrameMode = "animated" | "static";

// The QR is displayed on a PC monitor or a laptop screen and scanned with a
// phone camera, so the only thing that reliably decides whether a *camera app*
// scan succeeds is how many camera pixels land on one module. The old control
// was three fixed sizes capped at 460 px, which did not even fit the dialog's
// 464 px content box and shrank further on a high-DPI screen. It is replaced by
// one continuous slider, expressed as a percentage of whatever box the code is
// in, plus a full-screen view whose size is viewport-relative and therefore
// independent of OS scaling.
const QR_MIN_ZOOM = 40;
const QR_MAX_ZOOM = 100;
/** Widest the inline code may get: the dialog content box is 464 px. */
const QR_DIALOG_MAX_PX = 440;
/**
 * Full-screen size. Height binds on every 16:9 screen (96vw never does), and a
 * 1366x768 laptop leaves only ~625 CSS px of viewport once the OS taskbar and
 * the browser chrome are gone -- so each point of vh is worth about 1 % of
 * camera pixels per module. 86vh is as much as can be taken while one 64 px row
 * of controls still fits: 0.86 * 625 + 64 + padding = 618 of 625. The image also
 * carries `max-h-full` inside a `flex-1 min-h-0` region, so if the controls ever
 * grow the code shrinks instead of them scrolling off screen.
 */
const QR_FULLSCREEN_BOX = "min(96vw, 86vh)";
/**
 * One frame per 1.5 s in animated mode. The production payload is at most two
 * frames, so a full cycle is 3 s and speed buys nothing, while a slow rate stops
 * the camera catching a mid-transition composite and gives the scanner time to
 * lock on.
 */
const QR_FRAME_INTERVAL_MS = 1500;

/**
 * Which code the dialog opens on.
 *
 * "app": the app this panel is built for leads, and the envelope it reads is
 * also what DefaultVPN reads, so the default tab is the right one for both VPN
 * apps -- which is every user who has followed the install guide. The audience
 * chooser sits directly above the code and names the tool rather than the
 * format, so a user holding a bare camera is one labelled click away, and the
 * standing recovery link below the code names the other tool either way.
 *
 * This constant is also the restore knob: flipping it is the entire cost of
 * changing which code the dialog leads with, and it needs a rebuild of this app
 * and nothing else in the system.
 */
const QR_DEFAULT_AUDIENCE: QrAudience = "app";

/**
 * Which mode a multi-frame series opens in. "animated" on purpose: a user who
 * touches nothing must still be shown every frame, because the app's scanner
 * needs all of them, and a still first frame that never advances is a silent
 * dead end for someone who has not noticed there is a second one. "static" is
 * one click away for a scanner that keeps missing a frame.
 */
const QR_DEFAULT_FRAME_MODE: QrFrameMode = "animated";

const frameSrc = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

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
  const [qrZoom, setQrZoom] = React.useState(QR_MAX_ZOOM);
  const [zoomed, setZoomed] = React.useState(false);
  const [qrFor, setQrFor] = React.useState<QrAudience>(QR_DEFAULT_AUDIENCE);
  const [frames, setFrames] = React.useState<string[] | null>(null);
  const [framesError, setFramesError] = React.useState(false);
  const [frameAttempt, setFrameAttempt] = React.useState(0);
  const [frameIndex, setFrameIndex] = React.useState(0);
  const [frameMode, setFrameMode] =
    React.useState<QrFrameMode>(QR_DEFAULT_FRAME_MODE);

  React.useEffect(() => {
    if (!target) return;
    let active = true;
    setVpnLink(null);
    setFailed(false);
    setCopied(false);
    setQrZoom(QR_MAX_ZOOM);
    setZoomed(false);
    setQrFor(QR_DEFAULT_AUDIENCE);
    setFrames(null);
    setFramesError(false);
    setFrameIndex(0);
    setFrameMode(QR_DEFAULT_FRAME_MODE);
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

  // The frame series is fetched only when the user actually asks for an in-app
  // code, because it is several rendered SVGs. Both app tabs share one fetch —
  // it is one payload — so switching between them costs nothing. Only a
  // *successful* fetch is final: a failure leaves `frames` null, so switching
  // back to an app tab or pressing retry tries again. `frameAttempt` is in the
  // dependency list solely as the retry trigger.
  React.useEffect(() => {
    if (!target || !usesFrames(qrFor) || frames) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(configUrl(target.id, "qr-frames"));
        if (!res.ok) throw new Error("failed");
        const payload = (await res.json()) as { total: number; frames: string[] };
        if (!active) return;
        setFrames(payload.frames);
        setFrameIndex(0);
        setFramesError(false);
      } catch {
        if (active) setFramesError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [target, qrFor, frames, frameAttempt]);

  // Only the animated mode ticks. A single-frame series is a still picture in
  // either mode, so nothing animates and no mode switch is rendered for it.
  React.useEffect(() => {
    if (
      !usesFrames(qrFor) ||
      !frames ||
      frames.length < 2 ||
      frameMode !== "animated"
    ) {
      return;
    }
    const timer = window.setInterval(
      () => setFrameIndex((index) => (index + 1) % frames.length),
      QR_FRAME_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [qrFor, frames, frameMode]);

  const currentFrame =
    frames && frames.length > 0 ? frames[frameIndex % frames.length] : undefined;
  const qrSrc = !target
    ? null
    : !usesFrames(qrFor)
      ? configUrl(target.id, "qr-svg")
      : currentFrame
        ? frameSrc(currentFrame)
        : null;

  // A one-frame series is a still picture: no modes, no stepping, no dots.
  const frameCount = usesFrames(qrFor) && frames ? frames.length : 0;
  const showFrameControls = frameCount > 1;

  const stepFrame = (delta: number): void => {
    if (frameCount === 0) return;
    // Stepping is a statement of intent, so it drops out of animation.
    setFrameMode("static");
    setFrameIndex((index) => (index + delta + frameCount) % frameCount);
  };

  /*
    Built once and rendered in BOTH the dialog and the full-screen overlay, so
    the two cannot drift apart. Everything is on one line on purpose: in the
    overlay this is the single 64 px row the 86vh sizing budget assumes, and on a
    1366x768 laptop a stacked version costs ~90 px more, which is the difference
    between a code above and below the camera's decode floor.

    The mode switch is a labelled two-button control, not a play/pause toggle:
    the operator asked for two modes, and a mode you can read off the screen is
    what that means.
  */
  const frameControls = showFrameControls ? (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        type="button"
        onClick={() => stepFrame(-1)}
        aria-label={t("config.qrFramePrev")}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div
        role="group"
        aria-label={t("config.qrFrameModeAria")}
        className="flex items-center gap-1 rounded-md border border-border p-0.5"
      >
        {(["animated", "static"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setFrameMode(mode)}
            aria-pressed={frameMode === mode}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors",
              frameMode === mode
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {mode === "animated" ? (
              <Play className="h-3 w-3" />
            ) : (
              <Pause className="h-3 w-3" />
            )}
            {t(
              mode === "animated"
                ? "config.qrFrameModeAnimated"
                : "config.qrFrameModeStatic",
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => stepFrame(1)}
        aria-label={t("config.qrFrameNext")}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <span className="text-xs text-muted-foreground">
        {t("config.qrFrameCounter", {
          current: String((frameIndex % frameCount) + 1),
          total: String(frameCount),
        })}
      </span>
      <div className="flex items-center gap-1">
        {Array.from({ length: frameCount }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              index === frameIndex % frameCount ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </div>
    </div>
  ) : null;

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
              target.routeProfile !== "full_tunnel" ? (
                // Split-tunnel profiles carry thousands of routes/domains, so a
                // QR is not merely dense — it does not exist. Measured on the
                // shipped feeds: ru_whitelist is a 59 745-character link and
                // ru_blacklist a 1 787 465-character one, against a hard QR
                // ceiling of ~2 900 bytes at any error-correction level. The
                // copy says the reason rather than only the refusal, and points
                // at the copy button above.
                <div className="rounded-xl border border-dashed bg-muted/40 p-4 text-center">
                  <QrCode className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    {t("config.qrUnavailableTitle")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("config.qrUnavailableWhy")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("config.qrUnavailableBody")}
                  </p>
                </div>
              ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="qr-zoom">{t("config.qr")}</Label>
                  <div className="flex items-center gap-2">
                    <input
                      id="qr-zoom"
                      type="range"
                      min={QR_MIN_ZOOM}
                      max={QR_MAX_ZOOM}
                      step={5}
                      value={qrZoom}
                      onChange={(event) => setQrZoom(Number(event.target.value))}
                      aria-label={t("config.qrZoom")}
                      className="h-7 w-28 cursor-pointer accent-primary"
                    />
                    <button
                      type="button"
                      onClick={() => setZoomed(true)}
                      aria-label={t("config.qrMaximize")}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/*
                  Three tabs, two payloads. The choice is labelled by the tool
                  the user is holding, never by the format: a camera app reads
                  the `vpn://` URL, while either VPN app's in-app scanner reads
                  only the chunk envelope and ignores a `vpn://` symbol
                  entirely, however large and crisp it is. AmneziaVPN leads
                  because it is the app this panel is built for; DefaultVPN gets
                  its own tab because its users do not know it is the same app,
                  and its own wording because its menu is branded differently.
                  Only one code is ever shown, so nobody points a camera at the
                  wrong one.

                  The legend is VISIBLE, not just an aria-label: the user has to
                  pick a tool before looking at a code, otherwise they discover
                  the mismatch only by pointing something at a symbol it cannot
                  read and getting silence back.
                */}
                <div className="space-y-1">
                  <span
                    id="qr-audience-label"
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    {t("config.qrAudienceLabel")}
                  </span>
                  <div
                    role="group"
                    aria-labelledby="qr-audience-label"
                    className="grid grid-cols-3 gap-1 rounded-lg border border-border p-1"
                  >
                    {QR_AUDIENCES.map((audience) => (
                      <button
                        key={audience}
                        type="button"
                        onClick={() => setQrFor(audience)}
                        aria-pressed={qrFor === audience}
                        className={cn(
                          "rounded-md px-1.5 py-1 text-center text-xs font-medium transition-colors",
                          qrFor === audience
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {t(QR_AUDIENCE_LABEL_KEYS[audience])}
                      </button>
                    ))}
                  </div>
                </div>

                {usesFrames(qrFor) ? (
                  // Permanent and non-dismissible on purpose: this code is
                  // unreadable by any camera app, and that has to be visible in
                  // the same glance as the code itself.
                  <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-center text-xs text-amber-900">
                    {t(QR_AUDIENCE_WARNING_KEYS[qrFor])}
                  </p>
                ) : null}

                {/*
                  `bg-white` is a hard-coded literal on purpose, not a theme
                  token: an inverted or tinted QR fails on many scanners, and
                  the panel has a dark mode. The padding is the outer half of
                  the quiet zone. The width is computed rather than clamped with
                  `min()` so the top of the slider is not a dead zone.
                */}
                <div
                  className="mx-auto rounded-xl border bg-white p-3 shadow-sm"
                  style={{
                    width: `calc(${qrZoom} * min(100%, ${QR_DIALOG_MAX_PX}px) / 100)`,
                  }}
                >
                  {qrSrc ? (
                    <button
                      type="button"
                      onClick={() => setZoomed(true)}
                      aria-label={t("config.qrMaximize")}
                      className="block w-full cursor-zoom-in"
                    >
                      {/*
                        SVG, not PNG: the raster form was generated at 1024 px
                        and downscaled by CSS, which smeared module edges on a
                        symbol that was already near the camera's resolution
                        limit. An SVG carries no intrinsic size, so it is never
                        resampled at any zoom level.
                      */}
                      <img
                        src={qrSrc}
                        alt={t("config.qrAlt")}
                        className="block aspect-square w-full"
                      />
                    </button>
                  ) : framesError ? (
                    <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 p-2 text-center text-xs text-neutral-700">
                      <span>{t("config.qrFramesFailed")}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setFramesError(false);
                          setFrameAttempt((attempt) => attempt + 1);
                        }}
                        className="rounded-md border border-neutral-300 px-2 py-1"
                      >
                        {t("config.qrFramesRetry")}
                      </button>
                    </div>
                  ) : (
                    <Skeleton className="aspect-square w-full" />
                  )}
                </div>

                {showFrameControls ? (
                  <div className="space-y-1">
                    {frameControls}
                    {/*
                      The standing line says what the CURRENT mode does, so the
                      two modes read differently at a glance and neither leaves
                      the user waiting for something that will not happen.
                    */}
                    <p className="text-center text-xs text-muted-foreground">
                      {t(
                        frameMode === "animated"
                          ? "config.qrFramesLoop"
                          : "config.qrFramesManual",
                      )}
                    </p>
                  </div>
                ) : null}

                <p className="text-center text-xs text-muted-foreground">
                  {t(QR_AUDIENCE_HINT_KEYS[qrFor])}
                </p>
                <p className="text-center text-xs text-muted-foreground">
                  {t("config.qrZoomHint")}
                </p>
                {/*
                  The wrong-tool recovery, permanent and one click. With three
                  tabs it stays a two-way switch between the two things that are
                  actually different — an in-app scanner and a camera app —
                  because that is the mistake it exists to undo. Switching
                  between the two app tabs changes no code, only the wording.
                */}
                <button
                  type="button"
                  onClick={() => setQrFor(usesFrames(qrFor) ? "camera" : "app")}
                  className="mx-auto block text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {t(
                    usesFrames(qrFor)
                      ? "config.qrSwitchToCamera"
                      : "config.qrSwitchToApp",
                  )}
                </button>
              </div>
              )
            ) : null}

            {target ? (
              // The `.vpn` file is the same `vpn://` payload already shown
              // above (as text and, for full-tunnel keys, as a QR code), so it
              // needs no extra policy gate beyond reaching this dialog at all.
              // It leads because it is the only shape that survives import:
              // AmneziaVPN's client sniffs a file's content, not its
              // extension, so `.vpn` imports through the same "File with
              // connection settings" flow and keeps the connection name the
              // panel gave it, while a `.conf` always lands as "Server N" no
              // matter what is inside it or what it is named. `.conf` stays
              // available, behind its own policy flag, for awg-quick and
              // router firmwares that cannot take the `.vpn` shape.
              <div className="space-y-2">
                <Button asChild className="w-full">
                  <a href={configUrl(target.id, "vpn")} download>
                    <Download className="h-4 w-4" /> {t("common.downloadVpnFile")}
                  </a>
                </Button>
                {me?.policy.allowConfDownload ? (
                  <>
                    <Button asChild variant="outline" className="w-full">
                      <a href={configUrl(target.id, "conf")} download>
                        <Download className="h-4 w-4" /> {t("common.downloadConf")}
                      </a>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {t("config.fileShapesHint")}
                    </p>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/*
          Rendered into document.body: DialogContent carries a translate
          (components/ui/dialog.tsx:40), which makes it the containing block for
          `position: fixed` descendants — an inline overlay would be positioned
          against the dialog, not the viewport.

          The size is `min(96vw, 86vh)` rather than a pixel constant on purpose.
          A viewport-relative size grows with the screen's CSS resolution, so it
          stays physically large on a high-DPI panel where a fixed 460 px would
          shrink to roughly half a millimetre per module. Measured: 806 CSS px on
          a 1080p laptop and 538 on a 1366x768 one, against the old 460.

          Height is the binding dimension on every 16:9 screen -- 96vw never
          binds there -- which is why the chrome is ONE row rather than the
          stacked column an earlier draft had. On a 1366x768 laptop the browser
          leaves ~625 CSS px of viewport, and ~90 px of stacked chrome was the
          difference between a code above and below the camera's decode floor.
          `flex-1 min-h-0` plus `max-h-full` on the image means that if the
          chrome ever grows anyway (a wrapped warning, a longer translation) the
          code shrinks instead of the controls scrolling off screen.

          It shows whichever code is currently selected, in whichever display
          mode is selected, so the AmneziaVPN frames get the same screen the
          camera code does.
        */}
        {zoomed && qrSrc
          ? createPortal(
              <div
                role="dialog"
                aria-modal="true"
                aria-label={t("config.qrFullscreen")}
                onClick={(event) => {
                  // Only a click on the backdrop itself closes: clicking the
                  // slider, the frame controls or the code must not dismiss it.
                  if (event.target === event.currentTarget) setZoomed(false);
                }}
                className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-white p-2"
              >
                {usesFrames(qrFor) ? (
                  <p className="max-w-[90vw] shrink-0 text-center text-xs text-neutral-700">
                    {t(QR_AUDIENCE_WARNING_KEYS[qrFor])}
                  </p>
                ) : null}
                <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                  <img
                    src={qrSrc}
                    alt={t("config.qrAlt")}
                    style={{
                      width: `calc(${qrZoom} * ${QR_FULLSCREEN_BOX} / 100)`,
                    }}
                    className="block aspect-square max-h-full max-w-full"
                  />
                </div>
                {/* The single chrome row the 86vh budget assumes.
                    `on-light-surface` because this row is on the permanent white
                    of the overlay while the page may be in dark mode: the shared
                    frame controls resolve their colours from theme tokens and
                    would otherwise render light on white. */}
                <div className="on-light-surface flex w-full shrink-0 flex-wrap items-center justify-center gap-3 px-12">
                  {frameControls}
                  <input
                    type="range"
                    min={QR_MIN_ZOOM}
                    max={QR_MAX_ZOOM}
                    step={5}
                    value={qrZoom}
                    onChange={(event) => setQrZoom(Number(event.target.value))}
                    aria-label={t("config.qrZoom")}
                    className="w-48 max-w-[70vw] cursor-pointer accent-neutral-900"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setZoomed(false)}
                  aria-label={t("common.close")}
                  className="absolute right-2 top-2 rounded-md border border-neutral-300 bg-white p-2 text-neutral-900"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>,
              document.body,
            )
          : null}
      </DialogContent>
    </Dialog>
  );
}
