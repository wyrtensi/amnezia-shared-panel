import { describe, expect, it } from "vitest";
import {
  QR_MAX_MODULES,
  QR_QUIET_ZONE_MODULES,
  chooseQrRenderParams,
  measureQrModules,
  renderKeyQr,
} from "./qrRender.js";

// A realistic AWG 3.1 full-tunnel link is `vpn://` + ~1147 base64url chars.
// Mixed case forces QR byte mode, exactly like the real payload; an all-"A"
// string would be encoded in alphanumeric mode and measure far too small.
const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const fakeVpnLink = (chars: number): string =>
  `vpn://${Array.from({ length: chars }, (_, i) => BASE64URL[(i * 29 + 7) % 64]).join("")}`;

describe("chooseQrRenderParams", () => {
  it("drops to L when the real payload is too dense at Q and M", () => {
    // Measured for the production 1153-char link: Q -> 149, M -> 129, L -> 113.
    expect(chooseQrRenderParams({ Q: 149, M: 129, L: 113 })).toEqual({
      errorCorrectionLevel: "L",
      margin: 4,
      scale: 8, // floor(1024 / (113 + 8))
    });
  });

  it("keeps M when M fits the module budget", () => {
    // Measured for an 806-char link: Q -> 129, M -> 109, L -> 97.
    expect(chooseQrRenderParams({ Q: 129, M: 109, L: 97 })).toEqual({
      errorCorrectionLevel: "M",
      margin: 4,
      scale: 8, // floor(1024 / (109 + 8))
    });
  });

  it("keeps the strongest level for a short payload", () => {
    // A short link, small enough that Q still fits the budget.
    expect(chooseQrRenderParams({ Q: 41, M: 37, L: 33 })).toEqual({
      errorCorrectionLevel: "Q",
      margin: 4,
      scale: 20, // floor(1024 / (41 + 8))
    });
  });

  it("falls back to the smallest available symbol when nothing fits the budget", () => {
    // Measured for a 2906-char link: Q and M cannot encode it at all, L -> 177.
    expect(chooseQrRenderParams({ L: 177 })).toEqual({
      errorCorrectionLevel: "L",
      margin: 4,
      scale: 5, // floor(1024 / (177 + 8))
    });
  });

  it("refuses when no level can hold the payload", () => {
    expect(() => chooseQrRenderParams({})).toThrowError(
      "No error-correction level can hold this payload",
    );
  });

  it("never returns a scale below 1", () => {
    expect(chooseQrRenderParams({ L: 177 }, { targetWidth: 32 }).scale).toBe(1);
  });
});

describe("measureQrModules", () => {
  it("measures a realistic full-tunnel payload at every usable level", () => {
    expect(measureQrModules(fakeVpnLink(1147))).toEqual({
      Q: 149,
      M: 129,
      L: 113,
    });
  });

  it("reports only the levels that can hold an oversized payload", () => {
    expect(measureQrModules(fakeVpnLink(2900))).toEqual({ L: 177 });
  });

  it("returns nothing for a payload past QR byte-mode capacity", () => {
    expect(measureQrModules(fakeVpnLink(2950))).toEqual({});
  });
});

describe("renderKeyQr", () => {
  it("emits a PNG whose edge is an exact integer multiple of the module count", async () => {
    const rendered = await renderKeyQr(fakeVpnLink(1147), "png");

    expect(rendered.kind).toBe("png");
    expect(rendered.contentType).toBe("image/png");
    expect(rendered.params).toEqual({
      errorCorrectionLevel: "L",
      margin: 4,
      scale: 8,
    });
    // PNG IHDR carries width at byte offset 16 and height at 20.
    const body = rendered.body as Buffer;
    const totalModules = 113 + QR_QUIET_ZONE_MODULES * 2;
    expect(body.readUInt32BE(16)).toBe(totalModules * 8);
    expect(body.readUInt32BE(20)).toBe(totalModules * 8);
  });

  it("gives the downloadable PNG a quiet zone that survives a chat bubble", async () => {
    // The PNG is forwarded through messengers, where it sits directly on the
    // chat background with no padded wrapper around it, so the four-module
    // quiet zone has to be baked into the image itself.
    const rendered = await renderKeyQr(fakeVpnLink(1147), "png");

    expect(rendered.params.margin).toBe(4);
    const edge = (rendered.body as Buffer).readUInt32BE(16);
    const quietZonePx = rendered.params.margin * rendered.params.scale;
    expect(quietZonePx).toBe(32);
    // 113 data modules at 8 px, plus 32 px of white on each side.
    expect(edge).toBe(113 * 8 + quietZonePx * 2);
  });

  it("emits a resolution-independent SVG on an opaque white ground", async () => {
    const rendered = await renderKeyQr(fakeVpnLink(1147), "svg");

    expect(rendered.contentType).toBe("image/svg+xml; charset=utf-8");
    const body = rendered.body as string;
    // 113 data modules + a 4-module quiet zone on each side.
    expect(body).toContain(`viewBox="0 0 121 121"`);
    expect(body).toContain('shape-rendering="crispEdges"');
    // A scanner must never see an inverted or tinted symbol.
    expect(body).toContain('fill="#ffffff"');
    expect(body).toContain('stroke="#000000"');
    // No intrinsic width/height, so CSS alone decides how big it renders --
    // this is what lets the zoom slider and the full-screen view work without
    // any resampling.
    expect(body).not.toMatch(/<svg[^>]*\swidth=/);
  });

  it("keeps the quiet zone at the four modules the QR spec requires", async () => {
    const rendered = await renderKeyQr(fakeVpnLink(1147), "svg");

    expect(rendered.params.margin).toBe(QR_QUIET_ZONE_MODULES);
    expect(QR_QUIET_ZONE_MODULES).toBe(4);
  });

  it("rejects a payload no level can encode", async () => {
    await expect(renderKeyQr(fakeVpnLink(2950), "png")).rejects.toThrowError(
      "No error-correction level can hold this payload",
    );
  });

  it("keeps the module budget below the density that failed in production", () => {
    expect(QR_MAX_MODULES).toBeLessThan(149);
  });
});
