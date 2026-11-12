import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { ProbeLevels } from "@amnezia/contracts";

import {
  buildWidgetData,
  cutBytes,
  peopleMinutes,
  serializeWidgetData,
  widgetCaption,
  widgetVersion,
  WIDGET_DATA_MAX_BYTES,
  type WidgetInput,
  type WidgetNode,
} from "./reachabilityWidget.js";
import { PEOPLE_CELL_JS, REACHABILITY_WIDGET_HTML } from "./reachabilityWidgetHtml.js";

const lv = (ok: boolean | null, latencyMs: number | null = null) => ({
  ok,
  detail: null,
  latencyMs,
});
const levels = (ping: boolean | null, rest: boolean | null, ms: number | null = null): ProbeLevels => ({
  ping: lv(ping, ms),
  tcp: lv(rest),
  handshake: lv(rest),
  http: lv(rest === false ? null : rest),
});

const node = (name: string, over: Partial<WidgetNode> = {}): WidgetNode => ({
  name,
  status: "ok",
  levels: levels(true, true, 65),
  failingSince: null,
  online: 1,
  lastPersonHandshakeAt: null,
  ...over,
});

const input = (over: Partial<WidgetInput> = {}): WidgetInput => ({
  label: "Testland",
  timeZone: "Europe/Belgrade",
  checkedAt: new Date("2026-11-10T14:51:00Z"),
  nextAt: new Date("2026-11-10T15:51:00Z"),
  staleLimitSec: 10_800,
  stale: false,
  mass: false,
  nodes: [],
  ...over,
});

const since = new Date("2026-11-10T14:46:00Z");

describe("buildWidgetData", () => {
  it("puts failed nodes first, then unmeasured, then ok, each by name", () => {
    const data = buildWidgetData(
      input({
        nodes: [
          node("Server name 6", { levels: levels(false, true) }),
          node("Server name 1"),
          node("Server name 5", { status: "failed", levels: levels(false, false), failingSince: since }),
          node("Server name 4", { status: "error", levels: null }),
          node("Server name 3", { status: "failed", levels: levels(false, false), failingSince: since }),
        ],
      }),
    );
    expect(data.n.map((row) => row[0])).toEqual(["Server name 3", "Server name 5", "Server name 4", "Server name 1", "Server name 6"]);
    expect(data.k).toBe(2);
    expect(data.t).toBe(5);
  });

  it("encodes levels, ping latency, online and the failing-since time", () => {
    const data = buildWidgetData(
      input({
        nodes: [
          node("Server name 3", { status: "failed", levels: levels(false, false), failingSince: since, online: 0 }),
          node("Server name 1", { online: 3 }),
          node("Server name 6", { levels: levels(false, true) }),
          node("Server name 4", { status: "error", levels: null, online: 0 }),
        ],
      }),
    );
    // Belgrade is UTC+1 in November.
    expect(data.n[0]).toEqual(["Server name 3", "000-", "0", "", "10.11 15:46"]);
    expect(data.n[1]).toEqual(["Server name 4", "----", "0", ""]);
    expect(data.n[2]).toEqual(["Server name 1", "1111", "3", ""]);
    expect(data.n[3]).toEqual(["Server name 6", "0111", "1", ""]);
    expect(data).toMatchObject({ ct: "10.11 15:51", nt: "16:51", s: 0, m: 0, x: 0 });
    expect(data.c).toBe(Math.floor(Date.parse("2026-11-10T14:51:00Z") / 1000));
  });

  it("carries the stale and mass flags and the stale limit", () => {
    expect(buildWidgetData(input({ stale: true, mass: true, staleLimitSec: 9_000 }))).toMatchObject({
      s: 1,
      m: 1,
      sl: 9_000,
    });
    expect(buildWidgetData(input({ checkedAt: null, nextAt: null }))).toMatchObject({
      c: null,
      ct: null,
      nt: null,
    });
  });

  it("fits 1024 bytes with 12 failed nodes with long Cyrillic names", () => {
    const nodes = Array.from({ length: 12 }, (_, i) =>
      node(`Очень длинное имя сервера номер ${i} в Амстердаме, основной`, {
        status: "failed",
        levels: levels(false, false),
        failingSince: since,
        online: 123,
        // The widest value: five digits of minutes.
        lastPersonHandshakeAt: new Date("2026-10-01T00:00:00Z"),
      }),
    );
    const data = buildWidgetData(input({ label: "Длинная подпись точки проверки", nodes }));
    const bytes = Buffer.byteLength(serializeWidgetData(data));
    expect(bytes).toBeLessThanOrEqual(WIDGET_DATA_MAX_BYTES);
    expect(data.n).toHaveLength(12);
    expect(data.x).toBe(0);
    expect(Number(data.n[0]?.[3])).toBeGreaterThan(10_000);
  });

  it("drops trailing rows, counted, only when even short names do not fit", () => {
    const nodes = Array.from({ length: 60 }, (_, i) => node(`узел-${String(i).padStart(2, "0")}`));
    const data = buildWidgetData(input({ nodes }));
    expect(Buffer.byteLength(serializeWidgetData(data))).toBeLessThanOrEqual(WIDGET_DATA_MAX_BYTES);
    expect(data.x).toBeGreaterThan(0);
    expect(data.n.length + data.x).toBe(60);
    expect(data.t).toBe(60);
  });
});

describe("cutBytes", () => {
  it("cuts on a character boundary and marks the cut", () => {
    expect(cutBytes("Server name 1", 40)).toBe("Server name 1");
    const cut = cutBytes("ЖЖЖЖЖЖЖЖЖЖ", 9);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(9);
    expect(cut).toBe("ЖЖЖ…");
  });
});

describe("widget HTML", () => {
  it("stays within the Bot API limits with room to spare", () => {
    const bytes = Buffer.byteLength(REACHABILITY_WIDGET_HTML);
    expect(bytes).toBeLessThanOrEqual(32_768);
    expect(deflateSync(Buffer.from(REACHABILITY_WIDGET_HTML), { level: 9 }).length).toBeLessThanOrEqual(3_500);
  });

  it("puts node names in as text, never as markup", () => {
    expect(REACHABILITY_WIDGET_HTML).not.toContain("innerHTML");
    expect(REACHABILITY_WIDGET_HTML).toContain("createTextNode(n[0])");
  });

  // Telegram does not honour <col> widths and split the row evenly, leaving a
  // name two letters. The name cell now takes all free width; the figures
  // shrink to their content.
  it("keeps a row on one line, gives the name the free width, cuts it with an ellipsis", () => {
    expect(REACHABILITY_WIDGET_HTML).not.toContain("<col");
    expect(REACHABILITY_WIDGET_HTML).toMatch(/th,td\{width:1%;white-space:nowrap\}/);
    expect(REACHABILITY_WIDGET_HTML).toMatch(/td:first-child\{[^}]*width:100%;max-width:0/);
    expect(REACHABILITY_WIDGET_HTML).toMatch(/\.nm\{[^}]*text-overflow:ellipsis/);
  });
});

describe("widget version", () => {
  it("changes with the caption", () => {
    expect(widgetCaption("Testland")).toBe("VPN из Testland");
    expect(widgetVersion("a")).toMatch(/^[0-9a-f]{16}$/);
    expect(widgetVersion("a")).not.toBe(widgetVersion("b"));
  });
});

describe("people column", () => {
  // The exact source the widget runs, in a sandbox of its own.
  const P = runInNewContext(`${PEOPLE_CELL_JS};P`) as (m: number | null) => [string, string];

  it("counts minutes from a person's last handshake to the check", () => {
    const checkedAt = new Date("2026-11-10T14:51:00Z");
    expect(peopleMinutes(new Date("2026-11-10T09:51:30Z"), checkedAt)).toBe(299);
    expect(peopleMinutes(new Date("2026-11-08T22:10:00Z"), checkedAt)).toBe(2441);
    // A handshake that landed after the check is "just now", not negative.
    expect(peopleMinutes(new Date("2026-11-10T14:52:00Z"), checkedAt)).toBe(0);
    expect(peopleMinutes(null, checkedAt)).toBeNull();
    expect(peopleMinutes(new Date(), null)).toBeNull();
    const data = buildWidgetData(
      input({ nodes: [node("Server name 5", { lastPersonHandshakeAt: new Date("2026-11-10T14:46:00Z") })] }),
    );
    expect(data.v).toBe(4);
    expect(data.n[0]).toEqual(["Server name 5", "1111", "1", "5"]);
  });

  it.each([
    [0, "<1ч", ""],
    [59, "<1ч", ""],
    [60, "1ч", ""],
    [300, "5ч", ""],
    [1439, "23ч", ""],
    [1440, "1.0д", ""],
    [1441, "1.0д", "wy"],
    [1584, "1.1д", "wy"],
    [2629, "1.8д", "wy"],
    [2880, "2.0д", "wy"],
    [2881, "2.0д", "no"],
    [17_856, "12.4д", "no"],
  ])("shows %i minutes as %s", (minutes, text, tone) => {
    expect(P(minutes)).toEqual([text, tone]);
  });

  it("shows a grey dash where no person has ever connected", () => {
    expect(P(null)).toEqual(["-", "na"]);
  });

  it("is drawn by the widget: its column, the age since the check, and the new version", () => {
    expect(REACHABILITY_WIDGET_HTML).toContain(PEOPLE_CELL_JS);
    expect(REACHABILITY_WIDGET_HTML).toContain("<th>люди</th>");
    expect(REACHABILITY_WIDGET_HTML).toContain("+n[3]+Math.floor(age/60)");
    expect(REACHABILITY_WIDGET_HTML).toContain("d.v!==4");
    expect(REACHABILITY_WIDGET_HTML.match(/<th>/g)).toHaveLength(6);
    expect(REACHABILITY_WIDGET_HTML).not.toContain("<th>ping</th>");
    expect(REACHABILITY_WIDGET_HTML).toContain(".wy{color:");
  });
});

describe("numbers in chat_data", () => {
  // Telegram read `[...,0,2663]` as one decimal and drew 0.2663 under "онл.":
  // two bare numbers side by side in an array must never be sent.
  it("never puts two bare numbers next to each other", () => {
    const data = buildWidgetData(
      input({
        nodes: [
          node("Server name 3", { online: 0, lastPersonHandshakeAt: new Date("2026-11-08T22:10:00Z") }),
          node("Server name 5", { online: 2, levels: levels(true, true, 52), lastPersonHandshakeAt: since }),
          node("Server name 7", { status: "failed", levels: levels(false, false), failingSince: since, online: 1 }),
        ],
      }),
    );
    for (const row of data.n) for (const field of row) expect(typeof field).toBe("string");
    const outsideStrings = serializeWidgetData(data).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(outsideStrings).not.toMatch(/[0-9.]\s*,\s*-?[0-9]/);
  });
});
