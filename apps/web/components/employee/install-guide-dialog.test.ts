import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AGENTS.md keeps business logic out of apps/web, and a panel user may have no
// route to GitHub — so every download URL must arrive from
// GET /api/client-releases, never from this file. Guarded here because a
// hardcoded link is easy to add and invisible in review.
const source = readFileSync(
  fileURLToPath(new URL("./install-guide-dialog.tsx", import.meta.url)),
  "utf8",
);

describe("install guide dialog source", () => {
  it("contains no hardcoded link", () => {
    expect(source).not.toMatch(/https?:\/\//);
  });

  it("contains no hardcoded client version", () => {
    expect(source).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("reads the release from the control API", () => {
    expect(source).toContain("/api/client-releases");
  });

  // D8: on iOS a route-profile key connects but filters nothing, and the user
  // cannot see that. The install section must always carry the warning, and the
  // paragraph that recommends a split-profile .conf must never stand without
  // its iOS exception. Both are cheap to break in an edit and invisible in
  // review, so they are pinned here.
  it("always warns that route profiles do not filter on iOS", () => {
    expect(source).toContain("install.iosProfileWarning");
  });

  it("keeps the iOS exception directly under the split-tunnel recommendation", () => {
    const best = source.indexOf("install.confSplitBest");
    const warning = source.indexOf("install.confIosWarning");
    expect(best).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(best);
    // Nothing but the intervening comment and one Callout wrapper between them.
    expect(source.slice(best, warning)).not.toContain("GuideSection");
  });
});
