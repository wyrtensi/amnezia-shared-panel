import { describe, expect, it } from "vitest";

import { cliInstallVideoEmbed, describeVideoTarget } from "./installVideo.js";

// The same table the contracts suite runs against its own copy. If these
// diverge, one of the two implementations has drifted.
const DRIVE_VIEW =
  "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/view?usp=sharing";
const DRIVE_PREVIEW =
  "https://drive.google.com/file/d/1ExampleDriveFileIdForTests/preview";

describe("cliInstallVideoEmbed", () => {
  it("turns a Drive share link into its embeddable preview", () => {
    expect(cliInstallVideoEmbed(DRIVE_VIEW)).toEqual({
      kind: "drive",
      src: DRIVE_PREVIEW,
    });
  });

  it("accepts the older open?id= share shape", () => {
    expect(
      cliInstallVideoEmbed(
        "https://drive.google.com/open?id=1ExampleDriveFileIdForTests",
      ),
    ).toEqual({ kind: "drive", src: DRIVE_PREVIEW });
  });

  it("keeps a self-hosted file as a direct video", () => {
    expect(cliInstallVideoEmbed("https://cdn.example.com/guide.mp4")).toEqual({
      kind: "file",
      src: "https://cdn.example.com/guide.mp4",
    });
  });

  it("is null for anything the panel cannot play", () => {
    expect(cliInstallVideoEmbed(null)).toBeNull();
    expect(cliInstallVideoEmbed("")).toBeNull();
    expect(cliInstallVideoEmbed("not a url")).toBeNull();
    expect(cliInstallVideoEmbed("javascript:alert(1)")).toBeNull();
    expect(
      cliInstallVideoEmbed("https://drive.google.com/drive/my-drive"),
    ).toBeNull();
  });
});

describe("describeVideoTarget", () => {
  it("names the Drive preview it will embed", () => {
    expect(describeVideoTarget("ios", DRIVE_VIEW)).toContain("Google Drive");
    expect(describeVideoTarget("ios", DRIVE_VIEW)).toContain(DRIVE_PREVIEW);
  });

  it("says when a value was cleared", () => {
    expect(describeVideoTarget("android", null)).toBe("android: cleared");
  });

  it("flags a value the panel could not play", () => {
    expect(describeVideoTarget("desktop", "not a url")).toContain(
      "NOT PLAYABLE",
    );
  });
});
