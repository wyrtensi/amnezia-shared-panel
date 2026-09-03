import QRCode from "qrcode";

/**
 * Error-correction levels we are willing to use for a key QR, strongest first.
 * "H" is deliberately absent: on the production AWG 3.1 payload it costs six
 * more symbol versions than "Q" and buys redundancy a screen never needs.
 *
 * Changing the level does NOT change the encoded payload — the decoded
 * `vpn://` link is byte-identical at every level. Only the amount of
 * redundancy packed around it changes, and with it the symbol's density.
 */
export const QR_ECC_ORDER = ["Q", "M", "L"] as const;

export type QrErrorCorrectionLevel = (typeof QR_ECC_ORDER)[number];

/** Symbol size, in data modules per side, for each level that can encode a payload. */
export type QrModuleCounts = Partial<Record<QrErrorCorrectionLevel, number>>;

/**
 * ISO/IEC 18004 requires a four-module quiet zone on every side. This matters
 * most for the downloadable PNG: it is forwarded through messengers and lands
 * directly on a chat background with no padded wrapper to stand in for it.
 */
export const QR_QUIET_ZONE_MODULES = 4;

/**
 * Largest symbol (data modules per side) we consider comfortably scannable.
 *
 * The camera-app failure was a phone scanning a PC screen, so the budget is
 * derived from the least generous *common* one: a 13.3" 1920x1080 laptop with
 * OS scaling off (0.153 mm per CSS px), full screen, scanned at ~30 cm by a
 * camera analysing a 1280 px preview (~3.35 camera px/mm), against a practical
 * decode floor of 3 camera px per module. A maximised browser leaves ~937 CSS px
 * of viewport height there, so the full-screen code is 86vh = 806 CSS px:
 *   121 total modules (this payload at L) -> 1.019 mm -> 3.41 camera px/module
 *   128 total modules (this budget's worst case)  -> 0.963 mm -> 3.23
 *   137 total modules (what ECC M would cost it)  -> 0.900 mm -> 3.01, no margin
 * So ~129 data modules is the hard ceiling for that display, which is exactly
 * where M sits for this payload: M is out of budget, not merely denser.
 *
 * Measured on the real 1153-char AWG 3.1 full-tunnel link: ECC Q -> 149
 * modules, M -> 129, L -> 113. 120 is therefore the cut that puts the real
 * payload on the scannable side while short payloads (a 55-char link -> Q at
 * 41 modules) keep the stronger level for free. An AmneziaVPN chunk frame
 * (1158 chars) measures the same 113 modules and lands on L for the same
 * reason.
 */
export const QR_MAX_MODULES = 120;

/**
 * Upper bound for the PNG edge. The emitted image is always an exact integer
 * multiple of the module count, so it is at most this wide, never exactly.
 */
export const QR_TARGET_PNG_WIDTH = 1024;

export type QrRenderParams = {
  errorCorrectionLevel: QrErrorCorrectionLevel;
  margin: number;
  scale: number;
};

/**
 * Pick the error-correction level and the integer pixel scale for a symbol of a
 * known size. Pure: it takes measured module counts, so it can be unit-tested
 * against the numbers a real payload produces without generating an image.
 *
 * `scale` (integer pixels per module) is used instead of the library's `width`
 * option on purpose. `width` divides the target by the module count and samples
 * with `Math.floor` at that fractional scale, which makes some module columns a
 * pixel narrower than their neighbours — measured as 6 px x46 / 7 px x103 on the
 * production payload. An integer scale makes every module identical.
 */
export const chooseQrRenderParams = (
  counts: QrModuleCounts,
  options: { maxModules?: number; targetWidth?: number } = {},
): QrRenderParams => {
  const maxModules = options.maxModules ?? QR_MAX_MODULES;
  const targetWidth = options.targetWidth ?? QR_TARGET_PNG_WIDTH;

  const candidates = QR_ECC_ORDER.map((level) => ({
    level,
    modules: counts[level],
  })).filter(
    (
      candidate,
    ): candidate is { level: QrErrorCorrectionLevel; modules: number } =>
      typeof candidate.modules === "number",
  );
  if (candidates.length === 0) {
    throw new Error("No error-correction level can hold this payload");
  }

  // Strongest level that still fits the density budget; otherwise the smallest
  // symbol we can build at all (an oversized payload is better shown dense than
  // refused — the caller decides whether it is usable).
  const chosen =
    candidates.find((candidate) => candidate.modules <= maxModules) ??
    candidates.reduce((best, candidate) =>
      candidate.modules < best.modules ? candidate : best,
    );

  const totalModules = chosen.modules + QR_QUIET_ZONE_MODULES * 2;
  return {
    errorCorrectionLevel: chosen.level,
    margin: QR_QUIET_ZONE_MODULES,
    scale: Math.max(1, Math.floor(targetWidth / totalModules)),
  };
};

/**
 * Measure the symbol size this payload produces at each usable level. A level
 * that cannot hold the payload is simply absent from the result.
 */
export const measureQrModules = (payload: string): QrModuleCounts => {
  const counts: QrModuleCounts = {};
  for (const level of QR_ECC_ORDER) {
    try {
      counts[level] = QRCode.create(payload, {
        errorCorrectionLevel: level,
      }).modules.size;
    } catch {
      // This level cannot encode the payload; a weaker one still might.
    }
  }
  return counts;
};

export type RenderedQr =
  | {
      kind: "png";
      contentType: "image/png";
      body: Buffer;
      params: QrRenderParams;
    }
  | {
      kind: "svg";
      contentType: "image/svg+xml; charset=utf-8";
      body: string;
      params: QrRenderParams;
    };

/**
 * Render one QR symbol. The SVG form is what the panel displays: it carries no
 * intrinsic width, so CSS alone decides how big it renders and nothing is ever
 * resampled. The raster form was being generated at 1024 px and downscaled 2.2x
 * by the browser to fit the config dialog, which softened every module edge on
 * top of an already-too-dense symbol. The PNG form stays for download and the
 * CLI.
 *
 * `payload` is whatever text the symbol must carry — the `vpn://` link for a
 * camera app, or one base64url AmneziaVPN chunk frame for the app's own
 * scanner. This function does not know or care which.
 */
export const renderKeyQr = async (
  payload: string,
  kind: "png" | "svg",
): Promise<RenderedQr> => {
  const params = chooseQrRenderParams(measureQrModules(payload));
  if (kind === "svg") {
    const body = await QRCode.toString(payload, {
      type: "svg",
      errorCorrectionLevel: params.errorCorrectionLevel,
      margin: params.margin,
    });
    return {
      kind: "svg",
      contentType: "image/svg+xml; charset=utf-8",
      body,
      params,
    };
  }
  const body = await QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: params.errorCorrectionLevel,
    margin: params.margin,
    scale: params.scale,
  });
  return { kind: "png", contentType: "image/png", body, params };
};
