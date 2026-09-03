/**
 * Platform marks, vendored as inline SVG.
 *
 * Operator decision (T14, D9): the device cards show the real platform marks
 * rather than generic device glyphs, "recoloured to our interface".
 * `lucide-react` ships no vendor logos — its `apple` icon is a piece of fruit —
 * so the marks live here.
 *
 * Three properties every mark in this file must keep:
 *
 * - **Inline, never fetched.** No remote URL and no `<img>`: a card glyph is not
 *   worth a network request, and the panel must paint correctly offline.
 * - **`fill="currentColor"`, no brand colour.** The mark inherits the card's
 *   text colour, so light and dark themes need no second asset. That is what
 *   "красить их в наш интерфейс" asks for.
 * - **`aria-hidden`.** The mark is decorative; the card's own label is the
 *   accessible name, so a screen reader is not told the platform twice.
 *
 * These are trademarks. Using a mark to identify the platform it belongs to is
 * the ordinary case and monochrome renderings are what vendor brand guidelines
 * generally provide for. Each mark is its own component so that if that ever
 * has to change, the swap is one function here and nothing else moves.
 *
 * The path data is drawn for this panel, not copied from a vendor asset: these
 * are recognisable monochrome renderings at 24x24, tuned to stay legible at the
 * 28px the key card uses.
 */
import type { ComponentType, SVGProps } from "react";

/**
 * The shape both the vendored marks and the `lucide-react` fallbacks satisfy,
 * so `DEVICE_ICON` can hold either and the call sites stay `<Icon />`.
 */
export type PlatformMark = ComponentType<{ className?: string }>;

const markProps = {
  viewBox: "0 0 24 24",
  fill: "currentColor",
  width: 24,
  height: 24,
  "aria-hidden": true,
  focusable: "false",
} satisfies SVGProps<SVGSVGElement>;

/** The Android robot: domed head with antennae and eyes, over the body. */
export const AndroidMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 13a8 8 0 0 1 16 0v.6H4V13Zm5.2-2.2a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Zm5.6 0a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"
    />
    <path d="M7.4 4.6 8.8 6.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    <path d="M16.6 4.6 15.2 6.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    <rect x="4" y="14.6" width="16" height="5.2" rx="1.6" />
  </svg>
);

// The Apple mark, drawn once and placed on a different device outline for ios
// and macos. D9: the two must not look alike, or the pair reads as one option
// split in two — the brand says whose, the outline says which.
const APPLE_PATH =
  "M16.1 12.6c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2.1 2.5 2 1-.1 1.4-.6 2.6-.6s1.5.6 2.6.6c1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.2-.8-2.2-3ZM14.2 6.6c.5-.7.9-1.6.8-2.6-.8 0-1.8.5-2.4 1.2-.5.6-.9 1.6-.8 2.5 .9.1 1.9-.4 2.4-1.1Z";

/** The Apple mark on a phone: iPhone / iPad. */
export const IosMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <g transform="translate(12 11.2) scale(0.42) translate(-12 -12)">
      <path d={APPLE_PATH} />
    </g>
  </svg>
);

/** The Apple mark on a laptop: macOS / MacBook. */
export const MacosMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <rect x="4.5" y="4.5" width="15" height="11" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M2.5 18.5h19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <g transform="translate(12 9.6) scale(0.36) translate(-12 -12)">
      <path d={APPLE_PATH} />
    </g>
  </svg>
);

/** The Windows flag: four panes in perspective. */
export const WindowsMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <path d="M3.2 6.1 10.4 5v6.6H3.2V6.1Zm8.4-1.3L20.8 3.5v8.1h-9.2V4.8ZM3.2 12.8h7.2v6.6l-7.2-1.1v-5.5Zm8.4 0h9.2v8.1l-9.2-1.3v-6.8Z" />
  </svg>
);

/**
 * Tux. The feet are a separate path drawn first; the body is one even-odd
 * silhouette whose holes are the belly, the two eyes and the beak — that
 * two-tone reading is what makes it a penguin rather than a blob at small
 * sizes.
 */
export const LinuxMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <path d="M8.7 19.2c-.6.9-1.7 1.4-2.7 1.8-.6.2-.8.9-.3 1.2.9.5 2.6.5 3.7-.2.7-.5 1-1.4 1-2.3l-1.7-.5Zm6.6 0 -1.7.5c0 .9.3 1.8 1 2.3 1.1.7 2.8.7 3.7.2.5-.3.3-1-.3-1.2-1-.4-2.1-.9-2.7-1.8Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 1.6c-2.2 0-3.9 1.8-3.9 4 0 .7.1 1.2.3 1.7C6.7 8.6 5.9 10.6 5.7 13c-.2 1.7-.7 3-1.4 4.2-.5.9 0 1.9 1 2.1.6.1 1.2-.1 1.6-.5.9 1.6 2.7 2.5 5.1 2.5s4.2-.9 5.1-2.5c.4.4 1 .6 1.6.5 1-.2 1.5-1.2 1-2.1-.7-1.2-1.2-2.5-1.4-4.2-.2-2.4-1-4.4-2.7-5.7.2-.5.3-1 .3-1.7 0-2.2-1.7-4-3.9-4Zm-1.6 2.8c.6 0 1 .6 1 1.4s-.4 1.4-1 1.4-1-.6-1-1.4.4-1.4 1-1.4Zm3.2 0c.6 0 1 .6 1 1.4s-.4 1.4-1 1.4-1-.6-1-1.4.4-1.4 1-1.4Zm-1.6 2.7c1 0 1.8.6 1.8 1.3S12.9 9.7 12 9.7s-1.8-.6-1.8-1.3.8-1.3 1.8-1.3Zm0 3.9c2 0 3.5 2 3.5 4.6s-1.5 4.2-3.5 4.2-3.5-1.7-3.5-4.2 1.5-4.6 3.5-4.6Z"
    />
  </svg>
);
