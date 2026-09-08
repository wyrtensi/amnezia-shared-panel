"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { MIN_AWG3_CLIENT_VERSION } from "@amnezia/contracts";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import {
  signatureIsEnough,
  UPDATE_NOTICE_STAMP_MS,
  type SignaturePoint,
  type SignatureStroke,
} from "@/lib/update-notice";
import { useT } from "@/lib/i18n/provider";

/**
 * The poster's own colours, and the one place in the panel that does not use
 * design tokens.
 *
 * That is deliberate and it is the point of the dialog. Everything else here
 * is a panel surface and follows the theme; this is a notice pinned to the
 * wall, printed once, and it looks the same on a light panel, a dark panel and
 * a phone at night. Square corners for the same reason — every other surface
 * in this app is rounded, so hard corners read as "not part of the furniture".
 *
 * The values are read off the artwork itself (`public/update-notice-*.jpg`), so
 * the frame around the image is the same sheet the image is printed on.
 */
const PAPER = "#f4f0e3";
const PAPER_EDGE = "#ddd5c0";
const PAPER_INK = "#17120e";
const PAPER_MUTED = "#6f665a";
const POSTER_RED = "#cc2b26";
const PAD_PAPER = "#fbf9f1";
const PAD_RULE = "#b9ae95";
const PEN_INK = "#1b3a86";

/**
 * The step between reaching for a key and getting it: a poster saying the
 * AmneziaVPN client has to be up to date, and a line to sign that you read it.
 *
 * Why a signature and not a checkbox: the panel already has a checkbox gate on
 * the install reminder, and the failure it is aimed at is people clicking
 * through a warning without reading it. A signature cannot be dispatched with
 * one reflex tap — it takes a deliberate second, which is exactly the second
 * the notice needs.
 *
 * Who sees it, and how often, is decided in `lib/update-notice.ts` and applied
 * by the dashboard. This component only draws it.
 */
export function UpdateNoticeDialog({
  open,
  onOpenChange,
  onSigned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called the instant the user confirms, SYNCHRONOUSLY inside the click.
   *
   * Not a formality: the action waiting behind this dialog is a clipboard
   * write or a file download, and both need live user activation. Deferred to
   * a timer — after the stamp, say — Safari drops them silently. So the action
   * runs first and the stamp is painted over an already-finished job.
   */
  onSigned: () => void;
}) {
  const { t, lang } = useT();
  const [strokes, setStrokes] = React.useState<SignatureStroke[]>([]);
  const [cannotSign, setCannotSign] = React.useState(false);
  const [showFallback, setShowFallback] = React.useState(false);
  const [stamped, setStamped] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef<SignatureStroke | null>(null);

  const armed = signatureIsEnough(strokes) || cannotSign;

  // Every opening starts on a blank sheet. Carrying a signature over would hand
  // the user a live button they never earned on this showing.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setStrokes([]);
      setCannotSign(false);
      setShowFallback(false);
      setStamped(false);
      drawing.current = null;
    }
    wasOpen.current = open;
  }, [open]);

  /**
   * Size the backing store in device pixels and scale the context back, or a
   * phone at dpr 3 draws a signature at a third of the resolution it displays
   * at. Setting `width` also clears the canvas, so every fit repaints.
   */
  const fitPad = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = PEN_INK;
    ctx.clearRect(0, 0, rect.width, rect.height);
    for (const stroke of strokes) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
      for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }, [strokes]);

  // The canvas has no size until the dialog's content is in the DOM, so the
  // first fit waits for the frame after the portal mounts.
  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(fitPad);
    window.addEventListener("resize", fitPad);
    window.addEventListener("orientationchange", fitPad);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitPad);
      window.removeEventListener("orientationchange", fitPad);
    };
  }, [open, fitPad]);

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>): SignaturePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    // Capture, so a stroke that runs off the pad still ends on this element
    // rather than stranding `drawing` and painting on the next press.
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: SignatureStroke = [pointOf(event)];
    drawing.current = stroke;
    setStrokes((current) => [...current, stroke]);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = drawing.current;
    if (!stroke) return;
    event.preventDefault();
    const point = pointOf(event);
    const last = stroke[stroke.length - 1]!;
    stroke.push(point);
    // Drawn here rather than from a repaint of the whole signature: the state
    // update is what re-evaluates the button, and repainting every stroke on
    // every pointermove is the thing that makes a pad feel laggy on a phone.
    const ctx = event.currentTarget.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    setStrokes((current) => [...current]);
  };

  const endStroke = () => {
    drawing.current = null;
  };

  const clearPad = () => {
    drawing.current = null;
    setStrokes([]);
  };

  const confirm = () => {
    if (!armed || stamped) return;
    onSigned();
    setStamped(true);
    window.setTimeout(() => onOpenChange(false), UPDATE_NOTICE_STAMP_MS);
  };

  const stampDate = new Date().toLocaleDateString(
    lang === "ru" ? "ru-RU" : "en-GB",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        {/*
          Radix's Content, not the panel's DialogContent: that one paints the
          card background, the gradient and the rounded corners this dialog
          exists to shed. The focus trap, Esc and the scroll lock all still come
          from Radix, so closing behaves like every other dialog here.
        */}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-[50%] top-[50%] z-50 max-h-[96vh] w-[calc(100vw-1.5rem)] max-w-[560px] translate-x-[-50%] translate-y-[-50%] overflow-y-auto border shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          style={{ background: PAPER, borderColor: PAPER_EDGE, color: PAPER_INK }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("updateNotice.title")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center border text-lg leading-none focus:outline-none focus-visible:ring-2"
            style={{
              background: "rgb(255 255 255 / 0.78)",
              borderColor: "rgb(0 0 0 / 0.16)",
              color: PAPER_INK,
            }}
            aria-label={t("common.close")}
          >
            &times;
          </DialogPrimitive.Close>

          {/*
            The poster gives up height before anything else: on a phone in
            portrait the pad and the confirm band have to stay on screen, and
            `contain` over the paper ground crops nothing — the artwork's own
            margins are this same cream, so the letterboxing is invisible.
            A plain <img>, not next/image: it is one fixed asset with no layout
            to negotiate, and the optimiser would only add a round trip.
          */}
          <img
            src={`/update-notice-${lang}.jpg`}
            alt={t("updateNotice.posterAlt")}
            width={1200}
            height={896}
            className="block h-auto w-full object-contain"
            style={{ background: PAPER, maxHeight: "min(46vh, 420px)" }}
          />

          <div
            className="px-4 py-3 text-[13.5px] leading-snug"
            style={{ borderTop: `3px solid ${POSTER_RED}` }}
          >
            <b className="font-bold">
              {t("updateNotice.why", { version: MIN_AWG3_CLIENT_VERSION })}
            </b>{" "}
            <span>{t("updateNotice.looksFine")}</span>
          </div>

          <div className="flex flex-col gap-1.5 px-4 pb-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-bold uppercase tracking-[0.14em]">
                {t("updateNotice.signLabel")}
              </span>
              <span className="text-xs italic" style={{ color: PAPER_MUTED }}>
                {t("updateNotice.signHint")}
              </span>
            </div>

            <div
              className="relative h-[clamp(98px,15vh,132px)]"
              style={{
                background: PAD_PAPER,
                border: `1.5px solid ${PAD_RULE}`,
                boxShadow: "inset 0 2px 6px rgb(60 45 20 / 0.10)",
              }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-[34px] left-3.5 text-lg"
                style={{ color: PAD_RULE }}
              >
                ✗
              </span>
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-[30px] left-3.5 right-3.5"
                style={{ borderBottom: `1px dashed ${PAD_RULE}` }}
              />
              {/*
                `touch-action: none` is load-bearing, not styling: without it a
                phone treats the first drag as a page pan and the pad never sees
                a pointermove. `tabindex` keeps the pad in the tab order so its
                purpose is announced, with the checkbox below as the path for
                anyone who cannot draw.
              */}
              <canvas
                ref={canvasRef}
                tabIndex={0}
                role="img"
                aria-label={t("updateNotice.signLabel")}
                className="block h-full w-full cursor-crosshair touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
              />
              {stamped ? (
                <span
                  className="pointer-events-none absolute right-2 top-1/2 z-10 px-4 pb-1.5 pt-2 text-center uppercase motion-safe:animate-in motion-safe:zoom-in-90"
                  style={{
                    color: POSTER_RED,
                    border: `4px double ${POSTER_RED}`,
                    background: "rgb(251 249 241 / 0.62)",
                    mixBlendMode: "multiply",
                    transform: "translateY(-50%) rotate(-11deg)",
                  }}
                >
                  <b className="block text-[clamp(18px,4.6vw,26px)] font-bold leading-none tracking-[0.06em]">
                    {t("updateNotice.stamp")}
                  </b>
                  <span className="mt-0.5 block text-[10px] tracking-[0.2em]">
                    {stampDate}
                  </span>
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={clearPad}
                className="text-[12.5px] underline underline-offset-[3px]"
                style={{ color: PAPER_MUTED }}
              >
                {t("updateNotice.clear")}
              </button>
              <button
                type="button"
                onClick={() => setShowFallback((current) => !current)}
                aria-expanded={showFallback}
                className="text-[12.5px] underline underline-offset-[3px]"
                style={{ color: PAPER_MUTED }}
              >
                {t("updateNotice.cannotSign")}
              </button>
            </div>

            {/*
              The way through for a keyboard, a screen reader, or a trackpad
              somebody cannot draw on. It is a hole in the gate by construction
              — one click opens it — and that is the right trade: a gate nobody
              can pass without a mouse is not a gate, it is a lockout.
            */}
            {showFallback ? (
              <label
                className="flex items-center gap-2 px-2.5 py-2 text-[13px]"
                style={{ background: "#ece6d4", border: "1px solid #cfc4a6" }}
              >
                <input
                  type="checkbox"
                  autoComplete="off"
                  checked={cannotSign}
                  onChange={(event) => setCannotSign(event.target.checked)}
                  className="h-[17px] w-[17px]"
                  style={{ accentColor: POSTER_RED }}
                />
                {t("updateNotice.fallbackLabel")}
              </label>
            ) : null}
          </div>

          <div
            className="flex items-center justify-between gap-3 px-4 py-2.5"
            style={{ background: POSTER_RED }}
          >
            <button
              type="button"
              disabled={!armed || stamped}
              onClick={confirm}
              className="border-2 px-[18px] py-2 text-[15px] font-bold uppercase tracking-[0.1em] disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background: armed && !stamped ? PAPER : "transparent",
                borderColor: PAPER,
                color: armed && !stamped ? POSTER_RED : PAPER,
              }}
            >
              {t("updateNotice.agree")}
            </button>
            <span
              className="max-w-[22ch] text-xs"
              style={{ color: "rgb(255 255 255 / 0.88)" }}
            >
              {armed ? t("updateNotice.bandReady") : t("updateNotice.bandWaiting")}
            </span>
          </div>

          {/* The confirm button renames nothing but does change state while it
              holds focus, and assistive technology does not reliably re-read a
              control it is already on. In the DOM from the start, empty until
              there is something to say. */}
          <p role="status" aria-live="polite" className="sr-only">
            {armed ? t("updateNotice.bandReady") : ""}
          </p>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
