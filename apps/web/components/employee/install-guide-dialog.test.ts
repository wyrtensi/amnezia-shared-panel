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
  // paragraph that recommends a split-profile key file must never stand
  // without its iOS exception. Both are cheap to break in an edit and
  // invisible in review, so they are pinned here.
  it("always warns that route profiles do not filter on iOS", () => {
    expect(source).toContain("install.iosProfileWarning");
  });

  // The file section is rendered only for desktop and Android, so an iOS
  // exception inside it was advice about a device the reader is not holding.
  // iOS keeps its own warning in step 1, which the test above pins.
  it("does not discuss iPhones inside the file section", () => {
    expect(source).not.toContain("install.fileIosWarning");
  });

  // The file the guide teaches is .vpn: it is the only download the client's
  // importer accepts without renaming the connection to "Server 1". A rewrite
  // that quietly puts the .conf steps back would undo the whole point, and
  // reads the same in a diff, so the key names are pinned.
  it("teaches the .vpn file and keeps .conf as the fallback", () => {
    expect(source).toContain("install.fileStep1");
    expect(source).toContain("install.fileConfFallback");
    expect(source).not.toContain("install.confStep1");
  });
});

// The guide is organised by audience, but the API still returns a flat list of
// platforms. If a platform is added to the contract and not assigned to an
// audience, it simply stops being offered — no error, no empty state, just a
// download nobody can reach. Pinned here.
describe("guide audiences", () => {
  it("assigns every client platform to exactly one audience", async () => {
    const { AUDIENCE_PLATFORMS } = await import("./install-guide-dialog");
    const { CLIENT_PLATFORMS, GUIDE_AUDIENCES } = await import(
      "@amnezia/contracts"
    );
    // The audience list is the contract's — the portal policy carries a video
    // per audience — so the UI map must cover exactly it, no more, no less.
    expect(Object.keys(AUDIENCE_PLATFORMS).sort()).toEqual(
      [...GUIDE_AUDIENCES].sort(),
    );
    const assigned = Object.values(AUDIENCE_PLATFORMS).flat();
    expect([...assigned].sort()).toEqual([...CLIENT_PLATFORMS].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });
});

// A key card opens the guide on its own device, so this map decides which
// instruction a user is shown without being asked. A device that quietly
// resolves to the wrong audience — or to none, sending a known device back to
// the chooser — is invisible in review.
describe("guideAudienceForDevice", () => {
  it("routes every known device type", async () => {
    const { guideAudienceForDevice } = await import("./install-guide-dialog");
    const { deviceTypeSchema } = await import("@amnezia/contracts");
    const routed = Object.fromEntries(
      deviceTypeSchema.options.map((device) => [
        device,
        guideAudienceForDevice(device),
      ]),
    );
    expect(routed).toEqual({
      windows: "desktop",
      macos: "desktop",
      linux: "desktop",
      android: "android",
      ios: "ios",
      // Neither names a platform, so the chooser stays: guessing here would
      // hand a user an instruction for a device they do not have.
      other: null,
      unspecified: null,
    });
  });

  it("falls back to the chooser for a device this build does not know", async () => {
    const { guideAudienceForDevice } = await import("./install-guide-dialog");
    // A tab left open across a deploy receives whatever the new API sends.
    expect(guideAudienceForDevice("holodeck")).toBeNull();
  });
});
