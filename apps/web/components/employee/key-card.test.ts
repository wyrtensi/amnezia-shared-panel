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

describe(".conf fallback", () => {
  // `.conf` cannot carry the connection name -- the client renames every
  // imported one to "Server N" -- so the card must offer one obvious way to
  // get the key and keep this one findable only by someone looking for it.
  it("is the only download not drawn as a button", () => {
    expect(source).toMatch(/format="\.conf"[\s\S]{0,200}?quiet/);
    expect(source).not.toMatch(/format="\.conf"[\s\S]{0,200}?variant=/);
  });

  it("carries no fill, no border and no glyph in the quiet dress", () => {
    expect(source).toContain('quiet ? "link" : "secondary"');
    expect(source).toContain("{quiet ? null : <Download");
  });

  it("comes after the .vpn download", () => {
    expect(source.indexOf('format=".vpn"')).toBeLessThan(
      source.indexOf('format=".conf"'),
    );
  });

  // Quieter to the eye only. The tooltip and the `aria-label` still say the
  // whole phrase, and the policy flag still decides on its own whether the
  // link exists -- demoting it must not make it depend on the QR flag that
  // gates the download dialog.
  it("keeps the full wording and its own policy flag", () => {
    expect(source).toContain('label={t("common.downloadConf")}');
    expect(source).toMatch(/me\.policy\.allowConfDownload \?/);
    expect(source).not.toMatch(
      /allowQrDownload[\s\S]{0,200}?format="\.conf"/,
    );
  });
});

describe("internal name on an administrator's own key", () => {
  // An administrator seeing the operator note on their own key is a new
  // PLACEMENT, not a new capability: same field, same 80-character editor,
  // same admin endpoint that has always written it. A second dialog here would
  // be a second copy of the callout explaining who can read the field, and
  // that explanation is the part that must not drift.
  it("reuses the shared editor rather than inventing a second one", () => {
    expect(source).toContain(
      'from "@/components/key-internal-name-dialog"',
    );
    expect(source).toMatch(/<KeyInternalNameDialog\s/);
    expect(source).not.toContain("window.prompt(");
    expect(source).not.toContain("INTERNAL_NAME_MAX");
  });

  it("draws the note in the shared frame, not as a muted subtitle", () => {
    expect(source).toMatch(/<InternalNameChip>\{keyView\.internalName\}/);
    expect(source).not.toMatch(/italic[^"]*text-muted-foreground/);
  });

  it("reuses the admin row's wording for the trigger", () => {
    // Same three strings PR #82 shipped: the field's name on the button, and
    // add/edit on the tooltip and the `aria-label`.
    expect(source).toContain('{t("users.internalName")}');
    expect(source).toContain('t("users.internalNameEdit")');
    expect(source).toContain('t("users.internalNameAdd")');
  });

  it("writes through the role-gated admin endpoint, not an owner route", () => {
    // The card only asks; the dashboard posts. There is deliberately no
    // owner-facing writer for this field — `/api/keys` cannot set it, and the
    // admin endpoint answers 403 to a regular user whatever a browser sends.
    const dashboard = readFileSync(
      fileURLToPath(new URL("./employee-dashboard.tsx", import.meta.url)),
      "utf8",
    );
    expect(dashboard).toContain(
      "`/api/admin/keys/${keyId}/set-internal-name`",
    );
    expect(source).not.toContain("set-internal-name");
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
