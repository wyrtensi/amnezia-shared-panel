import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { messages } from "@/lib/i18n/messages";
import { InstallerBusyNote } from "./install-guide-dialog";

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

  // AmneziaWG is a third, separate iOS app and must sit at the bottom of this
  // audience's extended content -- after the AmneziaVPN alternative and the
  // route-profile warning -- rather than silently replacing either. Pinned so
  // a future edit that drops or reorders it is caught here, not in review.
  it("offers AmneziaWG as a further iOS alternative, at the bottom", () => {
    expect(source).toContain("ios?.secondAlternate");
    expect(source).toContain("install.iosAmneziaWgOpen");
    const profileWarningAt = source.indexOf("install.iosProfileWarning");
    const amneziaWgAt = source.indexOf("install.iosAmneziaWgTitle");
    expect(profileWarningAt).toBeGreaterThan(-1);
    expect(amneziaWgAt).toBeGreaterThan(profileWarningAt);
  });

  // The operator has not seen QR scanning work in a shipped Default VPN build.
  // Nothing in this file may claim it can -- see qrFrames.ts, which records the
  // discrepancy between that observation and the source analysis.
  it("never claims Default VPN can scan a QR code", () => {
    expect(source).not.toMatch(/Default ?VPN.*scan/i);
    expect(source).not.toMatch(/scan.*Default ?VPN/i);
  });
});

// A desktop AmneziaVPN keeps running beside the clock after its window is
// closed, so the installer refuses and Retry on its own shows the same box
// again. The note that says so is not a second way to do something that already
// worked -- its reader cannot install at all -- so the three things that would
// quietly take it away from them are pinned: the detailed switch, an audience
// with no desktop installer, and a disclosure to open.
describe("the installer-busy note", () => {
  const desktopBranch = source.match(
    /audience === "desktop" \? \(([\s\S]*?)\) : null\}/,
  )?.[1];

  it("is shown to the desktop audience", () => {
    expect(desktopBranch).toBeTruthy();
    expect(desktopBranch).toContain("<InstallerBusyNote />");
  });

  it("stays in the simple view", () => {
    expect(desktopBranch).not.toContain("advanced");
  });

  it("is drawn open rather than as a disclosure", () => {
    // Rendered, not read off the file: "no <details>" is exactly the kind of
    // claim a source-text assertion can pass while the browser disagrees.
    //
    // Every other block in this guide that folds away is a second route to
    // something that already worked. This one is the only route left for a
    // reader who is looking at a warning and cannot install, and a summary row
    // they have to guess is worth opening sits squarely in the way of the one
    // thing they came for: the picture of their own window.
    const html = renderToStaticMarkup(createElement(InstallerBusyNote));
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).toContain(messages.ru["install.busyTitle"]);
    // Both captures and all three steps are in the markup from the start.
    expect(html.match(/<img/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html.match(/<li>/g)?.length).toBe(3);
  });

  const shots = [...source.matchAll(/"(\/install-[a-z-]+\.webp)"/g)]
    .map((match) => match[1])
    .filter((shot): shot is string => shot !== undefined);

  it("ships every screenshot it points at", () => {
    // A path with no file behind it renders as alt text and nothing else --
    // silent in review, silent in the browser console, and the note is then
    // three steps about a window the reader cannot match against their screen.
    expect(shots.length).toBeGreaterThanOrEqual(4);
    for (const shot of shots) {
      const path = fileURLToPath(new URL(`../../public${shot}`, import.meta.url));
      expect(existsSync(path), `${shot} is missing from apps/web/public`).toBe(
        true,
      );
    }
  });

  it("gives the two languages the same set of captures", () => {
    // Adding a capture -- another theme, another window -- for one language and
    // forgetting the other leaves half the readers matching an English window
    // against a Russian screen, which is the failure this note exists to avoid.
    const forLang = (lang: string) =>
      shots
        .filter((shot) => shot.includes(`-${lang}`))
        .map((shot) => shot.replace(`-${lang}`, "-LANG"))
        .sort();
    expect(forLang("ru").length).toBeGreaterThanOrEqual(2);
    expect(forLang("en")).toEqual(forLang("ru"));
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

// The three steps used to be separated by vertical rhythm and an 8px indent,
// which is not a boundary in a dialog long enough to scroll. Each step body is
// now a recess. What is pinned is the part that would silently regress: the
// fill cannot carry it, because --dialog-gradient crosses --well partway down
// the sheet (measured in the component's own comment), so the border and the
// inset shadow have to be there and the border has to be full strength.
describe("numbered steps sit in a recess", () => {
  const body = source.match(
    /<div className="space-y-2\.5 [^"]*">\s*\n\s*\{children\}/,
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

  it("drops the indent the panel replaces", () => {
    expect(body).not.toContain("pl-8");
  });
});
