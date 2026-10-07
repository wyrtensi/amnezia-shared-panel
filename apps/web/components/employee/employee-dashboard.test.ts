import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./employee-dashboard.tsx", import.meta.url)),
  "utf8",
);

// The parsing and the writing of `?help=…&os=…` are unit-tested in
// lib/help-links.test.ts. What only exists here is the wiring, and each of
// these three has a failure mode that looks fine in a diff.
describe("help deep links", () => {
  // Both dialogs live inside a page that is still resolving who the visitor is.
  // Opening on mount would flash the guide over an unauthenticated frame.
  it("waits for the profile before opening anything", () => {
    expect(source).toMatch(/if \(!me \|\| linkRead\) return;/);
    expect(source).toContain("readHelpLink(window.location.search)");
  });

  // A push would make closing the dialog walk the back button through every
  // device group the reader clicked on the way.
  it("replaces history rather than pushing it", () => {
    expect(source).toContain("window.history.replaceState");
    expect(source).not.toContain("window.history.pushState");
  });

  // The sync effect must see every piece of state a link can carry, or the bar
  // stops matching the screen the moment the reader changes the device group.
  it("syncs the address bar with the open dialog and its device group", () => {
    expect(source).toContain(
      "}, [linkRead, showGuide, showKeyHelp, guideAudience]);",
    );
    expect(source).toContain("onAudienceChange={setGuideAudience}");
  });
});

// The "rules updated" callout is cleared by the server on any owner download,
// but this list only reloads while a key is provisioning. Both of these keep
// the card from showing the callout after the very download it asked for.
describe("rules-updated callout after a download", () => {
  it("clears the flag on the card the key was fetched from", () => {
    expect(source).toMatch(
      /onConfigDelivered=\{\(\) =>\s*setKeys\(\(current\) => markRulesDelivered\(current, key\.id\)\)/,
    );
  });

  // Opening the dialog is not a download: a file-only key fetches nothing until
  // a file is taken, so clearing the flag on the guard hid the callout only
  // until the dialog closed and the list brought it back.
  it("does not clear the flag merely for opening a guarded action", () => {
    expect(source).not.toMatch(/guardKeyAccess\(\(deferred\)[\s\S]{0,120}markRulesDelivered/);
  });

  it("resyncs with the server when the config dialog closes", () => {
    expect(source).toMatch(/setConfigTarget\(null\);[\s\S]{0,200}void load\(true\);/);
  });
});
