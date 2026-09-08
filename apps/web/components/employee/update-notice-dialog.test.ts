import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { messages } from "@/lib/i18n/messages";

/**
 * Read as source, not rendered.
 *
 * This dialog is a Radix portal wrapped around a `<canvas>`: the portal renders
 * nothing outside a browser, and this repo's vitest runs on
 * `environment: "node"` with no DOM at all — a canvas there has no context to
 * draw on and no box to measure. What is worth pinning here is not the pixels
 * but the handful of properties that are invisible when they break, so they are
 * asserted against the file. The rule the dialog actually enforces is pure and
 * lives in `lib/update-notice.ts`, where it is tested by running it.
 */
const source = readFileSync(
  fileURLToPath(new URL("./update-notice-dialog.tsx", import.meta.url)),
  "utf8",
);

describe("the signature pad", () => {
  // The single most breakable line in the file. Without it a phone treats the
  // first drag as a page pan, the pad never sees a pointermove, and the confirm
  // button can never arm — on a desktop, where every test gets run, it looks
  // perfect.
  it("takes the pointer away from the page's own scrolling", () => {
    expect(source).toContain("touch-none");
  });

  it("captures the pointer so a stroke can leave the pad", () => {
    expect(source).toContain("setPointerCapture");
  });

  it("sizes its backing store in device pixels", () => {
    // A phone at dpr 3 otherwise draws a signature at a third of the resolution
    // it displays at, which reads as a smeared line.
    expect(source).toContain("window.devicePixelRatio");
    expect(source).toContain("ctx.setTransform(dpr, 0, 0, dpr, 0, 0)");
  });

  it("is reachable from a keyboard and offers a way past", () => {
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain('t("updateNotice.fallbackLabel")');
  });
});

describe("the confirm handler", () => {
  /**
   * The order here is the whole design, and getting it wrong fails silently in
   * exactly one browser.
   *
   * Behind this dialog is a clipboard write or a file download, and both need
   * the click's user activation. Running the stamp first and the action from
   * the dismissal timer would read better and would break Safari, where the
   * activation is gone a tick later.
   */
  it("runs the held-back action before it paints anything", () => {
    const confirm = source.slice(
      source.indexOf("const confirm = () => {"),
      source.indexOf("const stampDate"),
    );
    expect(confirm).toContain("onSigned();");
    expect(confirm.indexOf("onSigned();")).toBeLessThan(
      confirm.indexOf("setStamped(true)"),
    );
    // And the close is the only thing on a timer.
    expect(confirm).toMatch(/setTimeout\(\(\) => onOpenChange\(false\)/);
  });

  it("cannot be pressed twice into a double download", () => {
    expect(source).toContain("if (!armed || stamped) return;");
    expect(source).toContain("disabled={!armed || stamped}");
  });
});

describe("the sheet's own dress", () => {
  /**
   * The one surface in the panel that ignores the theme, on purpose: it is a
   * printed notice, and a notice that restyled itself with the UI around it
   * would stop reading as one. Square for the same reason — everything else
   * here is rounded.
   */
  it("paints itself from fixed colours rather than theme tokens", () => {
    expect(source).toContain('const PAPER = "#f4f0e3"');
    expect(source).toContain('const POSTER_RED = "#cc2b26"');
    expect(source).not.toContain("bg-card");
    expect(source).not.toContain("bg-background");
    expect(source).not.toContain("text-muted-foreground");
  });

  it("keeps every corner square", () => {
    // Read out of the class strings rather than off the whole file: the word
    // also appears in the prose above explaining why there is none of it here.
    const classNames = [...source.matchAll(/className="([^"]*)"/g)].map(
      (match) => match[1]!,
    );
    expect(classNames.length).toBeGreaterThan(5);
    for (const value of classNames) {
      expect(value, value).not.toMatch(/\brounded(-[a-z0-9]+)?\b/);
    }
  });

  it("does not borrow the panel's DialogContent", () => {
    // That component is what paints the card, the gradient and the radius this
    // dialog exists to shed; the Radix primitive keeps the focus trap and Esc.
    expect(source).toContain("DialogPrimitive.Content");
    expect(source).not.toContain("<DialogContent");
  });
});

describe("the poster", () => {
  it("is swapped by language rather than translated", () => {
    expect(source).toContain("`/update-notice-${lang}.jpg`");
  });

  it("gives up height before the pad and the confirm band do", () => {
    // On a phone in portrait the whole sheet has to fit: a poster that kept its
    // aspect ratio would push the button people came for off the screen.
    expect(source).toContain("object-contain");
    expect(source).toContain("maxHeight");
  });

  it("carries an alt text in both languages", () => {
    for (const lang of ["ru", "en"] as const) {
      expect(messages[lang]["updateNotice.posterAlt"]).toBeTruthy();
    }
  });
});

describe("wording", () => {
  it("names the client floor from the contract, not from prose", () => {
    expect(source).toContain("MIN_AWG3_CLIENT_VERSION");
    expect(messages.ru["updateNotice.why"]).toContain("{version}");
    expect(messages.en["updateNotice.why"]).toContain("{version}");
  });

  it("translates every key it uses", () => {
    const used = [...source.matchAll(/t\("(updateNotice\.[^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(used.length).toBeGreaterThan(5);
    for (const key of used) {
      for (const lang of ["ru", "en"] as const) {
        expect(messages[lang][key as keyof (typeof messages)["ru"]], `${lang} ${key}`).toBeTruthy();
      }
    }
  });
});
