import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { ProbeLevels } from "@amnezia/contracts";

import {
  buildWidgetData,
  clockDayTime,
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
          node("us-utah", { levels: levels(false, true) }),
          node("amster3"),
          node("london2", { status: "failed", levels: levels(false, false), failingSince: since }),
          node("kz2", { status: "error", levels: null }),
          node("amster5", { status: "failed", levels: levels(false, false), failingSince: since }),
        ],
      }),
    );
    expect(data.n.map((row) => row[0])).toEqual(["amster5", "london2", "kz2", "amster3", "us-utah"]);
    expect(data.k).toBe(2);
    expect(data.t).toBe(5);
  });

  it("encodes levels, ping latency, online and the failing-since time", () => {
    const data = buildWidgetData(
      input({
        nodes: [
          node("amster5", { status: "failed", levels: levels(false, false), failingSince: since, online: 0 }),
          node("amster3", { online: 3 }),
          node("us-utah", { levels: levels(false, true) }),
          node("kz2", { status: "error", levels: null, online: 0 }),
        ],
      }),
    );
    // Belgrade is UTC+1 in November.
    expect(data.n[0]).toEqual(["amster5", "000-", null, 0, null, "10.11 15:46"]);
    expect(data.n[1]).toEqual(["kz2", "----", null, 0, null]);
    expect(data.n[2]).toEqual(["amster3", "1111", 65, 3, null]);
    expect(data.n[3]).toEqual(["us-utah", "0111", null, 1, null]);
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

  it("formats clock times in the configured zone", () => {
    const at = new Date("2026-07-01T23:30:00Z");
    expect(clockDayTime(at, "UTC")).toBe("01.07 23:30");
    expect(clockDayTime(at, "Europe/Belgrade")).toBe("02.07 01:30");
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
    expect(data.n[0]?.[4]).toBeGreaterThan(10_000);
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
    expect(cutBytes("amster3", 40)).toBe("amster3");
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

  it("keeps a row on one line: fixed columns, no wrapping, names cut with an ellipsis", () => {
    expect(REACHABILITY_WIDGET_HTML).toContain("table-layout:fixed");
    expect(REACHABILITY_WIDGET_HTML).toMatch(/td\{[^}]*white-space:nowrap/);
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
      input({ nodes: [node("london2", { lastPersonHandshakeAt: new Date("2026-11-10T14:46:00Z") })] }),
    );
    expect(data.v).toBe(2);
    expect(data.n[0]).toEqual(["london2", "1111", 65, 1, 5]);
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
    expect(REACHABILITY_WIDGET_HTML).toContain("n[4]+Math.floor(age/60)");
    expect(REACHABILITY_WIDGET_HTML).toContain("d.v!==2");
    expect(REACHABILITY_WIDGET_HTML.match(/<col[ >]/g)).toHaveLength(7);
    expect(REACHABILITY_WIDGET_HTML).toContain(".wy{color:");
  });
});
