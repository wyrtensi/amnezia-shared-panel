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

/**
 * The Android robot's head, filling the box: antennae, dome, two eye holes.
 * Head-only on purpose — the earlier head-plus-body version merged into a
 * single blob at 24px, which is the size that actually ships.
 */
export const AndroidMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <path d="M6.6 3.6 8.9 7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    <path d="M17.4 3.6 15.1 7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 17.6a9 9 0 0 1 18 0v.4H3v-.4Zm5.6-3.1a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3Zm6.8 0a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3Z"
    />
  </svg>
);

// The Apple mark, drawn once. It is the recognisable element, so it stays LARGE
// in both marks: an earlier version shrank it to sit inside a device outline,
// which left roughly 10px of apple at the shipped size — unreadable. D9 still
// holds (ios and macos must not look alike), so macos adds a laptop base under
// a full-size mark instead of boxing it in.
const APPLE_PATH =
  "M16.1 12.6c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2.1 2.5 2 1-.1 1.4-.6 2.6-.6s1.5.6 2.6.6c1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.2-.8-2.2-3ZM14.2 6.6c.5-.7.9-1.6.8-2.6-.8 0-1.8.5-2.4 1.2-.5.6-.9 1.6-.8 2.5 .9.1 1.9-.4 2.4-1.1Z";

/** The Apple mark alone, filling the box: iPhone / iPad. */
export const IosMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <g transform="translate(12 12.2) scale(1.22) translate(-11.4 -12.3)">
      <path d={APPLE_PATH} />
    </g>
  </svg>
);

/** The Apple mark over a laptop base: macOS / MacBook. */
export const MacosMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <g transform="translate(12 9.6) scale(0.92) translate(-11.4 -12.3)">
      <path d={APPLE_PATH} />
    </g>
    <path d="M1.6 19.6h20.8l-1 1.9a1 1 0 0 1-.9.5H3.5a1 1 0 0 1-.9-.5l-1-1.9Z" />
  </svg>
);

/** The Windows flag: four panes in perspective. */
export const WindowsMark = ({ className }: { className?: string }) => (
  <svg {...markProps} className={className}>
    <path d="M2.6 5.9 10.7 4.6v7.5H2.6V5.9Zm9.5-1.5L21.4 3v9.1h-9.3V4.4ZM2.6 13.4h8.1v7.5L2.6 19.6v-6.2Zm9.5 0h9.3v9.1l-9.3-1.4v-7.7Z" />
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
    <path d="M8.4 19c-.7 1-1.9 1.6-3 2-.7.3-.9 1-.3 1.4 1 .6 2.9.6 4.1-.2.8-.6 1.1-1.6 1.1-2.6L8.4 19Zm7.2 0-1.9.6c0 1 .3 2 1.1 2.6 1.2.8 3.1.8 4.1.2.6-.4.4-1.1-.3-1.4-1.1-.4-2.3-1-3-2Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 1.2c-2.5 0-4.3 2-4.3 4.4 0 .8.1 1.4.3 1.9C6 8.9 5.1 11.1 4.9 13.7c-.2 1.9-.8 3.3-1.5 4.6-.6 1 0 2.1 1.1 2.3.7.1 1.3-.1 1.8-.6 1 1.8 3 2.8 5.7 2.8s4.7-1 5.7-2.8c.5.5 1.1.7 1.8.6 1.1-.2 1.7-1.3 1.1-2.3-.7-1.3-1.3-2.7-1.5-4.6-.2-2.6-1.1-4.8-3.1-6.2.2-.5.3-1.1.3-1.9 0-2.4-1.8-4.4-4.3-4.4Zm-2 3.1c.75 0 1.3.8 1.3 1.8s-.55 1.8-1.3 1.8-1.3-.8-1.3-1.8.55-1.8 1.3-1.8Zm4 0c.75 0 1.3.8 1.3 1.8s-.55 1.8-1.3 1.8-1.3-.8-1.3-1.8.55-1.8 1.3-1.8Zm-2 3.3c1.2 0 2.1.7 2.1 1.5S13.2 10.6 12 10.6s-2.1-.7-2.1-1.5.9-1.5 2.1-1.5Zm0 4.2c2.3 0 4 2.3 4 5.2s-1.7 4.7-4 4.7-4-1.9-4-4.7 1.7-5.2 4-5.2Z"
    />
  </svg>
);
