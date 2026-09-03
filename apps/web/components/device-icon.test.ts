import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { deviceTypeSchema, DEVICE_TYPE_ORDER } from "@amnezia/contracts";

import { DEVICE_ICON, deviceIconFor } from "./device-icon";
import * as marks from "./icons/platform-marks";

// Deliberately a .ts file using createElement rather than a .tsx one: apps/web
// sets `jsx: "preserve"` because Next does the transform, and vitest has no Next
// in front of it, so a .tsx test would need extra build config for no gain here.

describe("DEVICE_ICON", () => {
  it("has a glyph for every device type the contract defines, and each renders", () => {
    // Not a typeof check: the lucide fallbacks are forwardRef objects, not plain
    // functions. What matters is that every entry actually renders an svg.
    for (const device of deviceTypeSchema.options) {
      const html = renderToStaticMarkup(createElement(DEVICE_ICON[device]));
      expect(html, device).toContain("<svg");
    }
  });

  it("gives every offered platform its own distinct glyph", () => {
    // D9: ios and macos in particular must not look alike — an identical Apple
    // mark on both would read as one option split in two.
    const glyphs = DEVICE_TYPE_ORDER.map((device) => DEVICE_ICON[device]);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("falls back to the neutral glyph for a value it does not know", () => {
    expect(deviceIconFor("nintendo-switch")).toBe(DEVICE_ICON.other);
    // Retired values reach this the same way: an old key row, never a crash.
    expect(deviceIconFor("laptop")).toBe(DEVICE_ICON.other);
  });

  it("resolves a known value to its own glyph", () => {
    expect(deviceIconFor("linux")).toBe(DEVICE_ICON.linux);
  });
});

describe("the vendored platform marks", () => {
  const vendored = [
    ["AndroidMark", marks.AndroidMark],
    ["IosMark", marks.IosMark],
    ["MacosMark", marks.MacosMark],
    ["WindowsMark", marks.WindowsMark],
    ["LinuxMark", marks.LinuxMark],
  ] as const;

  for (const [name, Mark] of vendored) {
    const render = (className?: string) =>
      renderToStaticMarkup(createElement(Mark, className ? { className } : {}));

    it(`${name} recolours to the interface and is hidden from screen readers`, () => {
      const html = render();
      // "красить их в наш интерфейс": the mark inherits the card's text colour,
      // so one asset serves both themes.
      expect(html).toContain('fill="currentColor"');
      expect(html).toContain('aria-hidden="true"');
      // The card's label is the accessible name; the glyph must not add a second.
      expect(html).not.toContain("<title");
    });

    it(`${name} hard-codes no brand colour and fetches nothing`, () => {
      const html = render();
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toMatch(/rgb\(|url\(|<image/i);
    });

    it(`${name} passes className through, so the key card can size it`, () => {
      expect(render("size-7")).toContain('class="size-7"');
    });
  }
});
