import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./key-help-dialog.tsx", import.meta.url)),
  "utf8",
);

// The five steps carry mock tiles, badges and profile callouts — pictures that
// out-draw a hairline divider, so a reader could not see where one step ended.
// Each step body is a recess now, matching the connect guide. What is pinned is
// what would silently regress: the fill cannot carry it (--dialog-gradient
// crosses --well partway down the sheet, measured in install-guide-dialog.tsx),
// so the border and the inset shadow have to be there, at full strength.
describe("form steps sit in a recess", () => {
  const body = source.match(
    /<div className="space-y-2 [^"]*">\s*\n\s*\{children\}/,
  )?.[0];

  it("draws each step body as a bounded panel", () => {
    expect(body).toBeTruthy();
    expect(body).toContain("bg-well");
    expect(body).toContain("shadow-[var(--inset-shadow)]");
    expect(body).toContain("rounded-xl");
  });

  it("keeps the border at full strength, not the in-card /60", () => {
    expect(body).toContain("border ");
    expect(body).not.toContain("border-border/60");
  });

  // Two boundary systems saying the same thing read as clutter, and the
  // hairline is the weaker of the two.
  it("drops the dividers the panels replace", () => {
    expect(source).not.toContain("divide-y");
    expect(source).toContain('<ol className="space-y-2.5">');
  });

  // The body text is muted on a recess: 8.6:1 in dark, past AA. It must stay
  // muted-foreground rather than drifting to a dimmer token on the darker fill.
  it("keeps the body at muted-foreground", () => {
    expect(body).toContain("text-muted-foreground");
  });
});
