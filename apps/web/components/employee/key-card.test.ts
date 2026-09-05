import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { messages } from "@/lib/i18n/messages";

const source = readFileSync(
  fileURLToPath(new URL("./key-card.tsx", import.meta.url)),
  "utf8",
);

// The action row is the part of the card that breaks first on a phone, and it
// breaks invisibly: on a desktop viewport every arrangement looks fine. Both
// properties that keep it usable at 375px are pinned here.
describe("key card action row", () => {
  it("wraps instead of pushing buttons out of reach", () => {
    expect(source).toContain("flex flex-wrap items-center gap-1.5 border-t");
  });

  it("uses no full-size button in the row", () => {
    expect(source).not.toMatch(/size="lg"/);
  });
});

describe("QR button", () => {
  // It sits beside Copy, the row's primary (`variant="default"`, which paints
  // `bg-primary`). Borrowing the same token instead of a literal colour is
  // what keeps the two readable as a pair in both themes; a pinned hex would
  // be wrong in one of them.
  it("borders itself in the primary colour, not a literal one", () => {
    expect(source).toContain('className="border border-primary"');
    expect(source).not.toMatch(/border-\[#/);
  });

  // Icon-only, it read as a stray glyph rather than an action. The label is
  // what makes it a sibling of Copy.
  it("carries a visible label next to the icon", () => {
    expect(source).toContain('{t("keyCard.qrShort")}');
    expect(source).not.toContain('className="w-8 px-0"');
  });

  it("keeps the full wording for screen readers and the tooltip", () => {
    expect(source).toContain('aria-label={t("keyCard.showQr")}');
    expect(source).toContain('{t("keyCard.qrAndLink")}');
  });
});

describe("rules-updated callout", () => {
  // `rulesOutdated` is computed per route profile, so the card knows which
  // profile moved. Dropping the variable would put the copy back to a generic
  // "rules changed" that never says why this key is the one showing it.
  it("names the key's own route profile", () => {
    expect(source).toContain('t("keyCard.rulesUpdatedBody", {');
    expect(source).toContain("ROUTE_LABEL[keyView.routeProfile]");
  });

  it("offers the reissue in both languages without demanding it", () => {
    for (const lang of ["ru", "en"] as const) {
      const body = (messages[lang] as Record<string, string>)[
        "keyCard.rulesUpdatedBody"
      ];
      expect(body, `${lang} body`).toContain("{profile}");
      // Nothing has broken: the key keeps running on the rules it was issued
      // with. Copy that says otherwise sends people to support over a
      // non-event, which is what this callout used to do.
      expect(body, `${lang} body`).not.toMatch(
        /перестанет работать|stop working/i,
      );
    }
  });
});
