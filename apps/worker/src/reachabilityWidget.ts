import { createHash } from "node:crypto";

import type { ProbeLevel, ProbeLevels, ReachabilityStatus } from "@amnezia/contracts";

import { REACHABILITY_WIDGET_HTML } from "./reachabilityWidgetHtml.js";

/**
 * The Telegram status widget: what goes into its `chat_data`. Pure. The HTML
 * (reachabilityWidgetHtml.ts) only draws this data; every decision about
 * order, colour inputs and clock times is made here.
 *
 * Wire format, version 2 (short keys: the whole thing must fit 1024 bytes):
 *   v   2
 *   l   label
 *   k   nodes with status ok        t   nodes counted in the heading
 *   c   last check, epoch seconds, or null
 *   ct  last check as a clock time  nt  next check as a clock time
 *   sl  seconds after `c` when the data reads as stale
 *   s   1 when stale now            m   1 when the newest run was a mass failure
 *   n   rows: [name, levels, pingMs, online, people, since?]
 *       levels = 4 chars for ping, tcp, handshake, http: "1" ok, "0" failed,
 *       "-" not run
 *       people = minutes from a person's last handshake on the node to `c`,
 *       or null when no person has ever connected there; the widget adds the
 *       time since `c` itself, so the age keeps counting between runs
 *   x   rows left out to fit the size limit
 */

export const WIDGET_DATA_MAX_BYTES = 1024;
/** Names are cut to this many UTF-8 bytes first, then shorter if needed. */
const NAME_MAX_BYTES = 40;
const NAME_MIN_BYTES = 8;

export type WidgetNode = {
  name: string;
  status: ReachabilityStatus;
  levels: ProbeLevels | null;
  failingSince: Date | null;
  online: number;
  /** The newest handshake of a person's key on the node, revoked keys included. */
  lastPersonHandshakeAt: Date | null;
};

export type WidgetInput = {
  label: string;
  timeZone: string;
  checkedAt: Date | null;
  nextAt: Date | null;
  /** Seconds after the check when the data reads as stale. */
  staleLimitSec: number;
  stale: boolean;
  mass: boolean;
  nodes: readonly WidgetNode[];
};

type Row =
  | [string, string, number | null, number, number | null]
  | [string, string, number | null, number, number | null, string];

export type WidgetData = {
  v: 2;
  l: string;
  k: number;
  t: number;
  c: number | null;
  ct: string | null;
  nt: string | null;
  sl: number;
  s: 0 | 1;
  m: 0 | 1;
  n: Row[];
  x: number;
};

const parts = (date: Date, timeZone: string) => {
  const map = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return map;
};

/** "10.11 15:46" in the given zone. */
export const clockDayTime = (date: Date, timeZone: string): string => {
  const p = parts(date, timeZone);
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
};

/** "15:46" in the given zone. */
export const clockTime = (date: Date, timeZone: string): string => {
  const p = parts(date, timeZone);
  return `${p.hour}:${p.minute}`;
};

const mark = (level: ProbeLevel | undefined): string =>
  level?.ok === true ? "1" : level?.ok === false ? "0" : "-";

const levelFlags = (levels: ProbeLevels | null): string =>
  levels
    ? mark(levels.ping) + mark(levels.tcp) + mark(levels.handshake) + mark(levels.http)
    : "----";

const rank = (node: WidgetNode) => (node.status === "failed" ? 0 : node.status === "error" ? 1 : 2);

/** Failed first, then not measured, then ok; each by name. */
export const orderNodes = (nodes: readonly WidgetNode[]): WidgetNode[] =>
  [...nodes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

/** Cut to at most `max` UTF-8 bytes on a character boundary, marking the cut. */
export const cutBytes = (text: string, max: number): string => {
  if (Buffer.byteLength(text) <= max) return text;
  let out = "";
  for (const char of text) {
    if (Buffer.byteLength(out + char) + Buffer.byteLength("…") > max) break;
    out += char;
  }
  return `${out}…`;
};

const byteSize = (data: WidgetData) => Buffer.byteLength(JSON.stringify(data));

/**
 * Minutes from a person's last handshake to the check, never negative. Null
 * when nobody has connected, or when there is no check to count from.
 */
export const peopleMinutes = (handshakeAt: Date | null, checkedAt: Date | null): number | null =>
  handshakeAt && checkedAt
    ? Math.max(0, Math.floor((checkedAt.getTime() - handshakeAt.getTime()) / 60_000))
    : null;

export const buildWidgetData = (input: WidgetInput): WidgetData => {
  const ordered = orderNodes(input.nodes);
  const rowsAt = (nameBytes: number): Row[] =>
    ordered.map((node) => {
      const ping = node.levels?.ping;
      const row: Row = [
        cutBytes(node.name, nameBytes),
        levelFlags(node.levels),
        ping?.ok === true ? (ping.latencyMs ?? null) : null,
        node.online,
        peopleMinutes(node.lastPersonHandshakeAt, input.checkedAt),
      ];
      return node.status === "failed" && node.failingSince
        ? [...row, clockDayTime(node.failingSince, input.timeZone)]
        : row;
    });

  const data: WidgetData = {
    v: 2,
    l: cutBytes(input.label, 80),
    k: input.nodes.filter((node) => node.status === "ok").length,
    t: input.nodes.length,
    c: input.checkedAt ? Math.floor(input.checkedAt.getTime() / 1000) : null,
    ct: input.checkedAt ? clockDayTime(input.checkedAt, input.timeZone) : null,
    nt: input.nextAt ? clockTime(input.nextAt, input.timeZone) : null,
    sl: input.staleLimitSec,
    s: input.stale ? 1 : 0,
    m: input.mass ? 1 : 0,
    n: rowsAt(NAME_MAX_BYTES),
    x: 0,
  };
  // Shorter names first; when even the shortest do not fit, the last rows
  // (ok nodes, by the order above) are left out and counted.
  for (let bytes = NAME_MAX_BYTES; byteSize(data) > WIDGET_DATA_MAX_BYTES; bytes -= 4) {
    if (bytes < NAME_MIN_BYTES) {
      while (data.n.length > 0 && byteSize(data) > WIDGET_DATA_MAX_BYTES) {
        data.n.pop();
        data.x += 1;
      }
      break;
    }
    data.n = rowsAt(bytes);
  }
  return data;
};

export const serializeWidgetData = (data: WidgetData): string => JSON.stringify(data);

/** The caption: the chat list, notifications and apps without widgets show it. */
export const widgetCaption = (label: string): string => `VPN из ${label}`;

/**
 * Identifies what a sent widget carries that cannot be edited later. A new
 * value means a new message.
 */
export const widgetVersion = (caption: string): string =>
  createHash("sha256")
    .update(REACHABILITY_WIDGET_HTML)
    .update("\0")
    .update(caption)
    .digest("hex")
    .slice(0, 16);
