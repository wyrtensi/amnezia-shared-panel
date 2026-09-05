import { describe, expect, it } from "vitest";
import { versionHref, versionLabel } from "./version-link";

const repo = "https://github.com/wyrtensi/amnezia-shared-panel";

describe("versionHref", () => {
  it("points a tagged build at that release", () => {
    expect(
      versionHref({ version: "v0.9.24", commit: "abc1234", repositoryUrl: repo }),
    ).toBe(`${repo}/releases/tag/v0.9.24`);
  });

  it("accepts a tag without the leading v", () => {
    expect(versionHref({ version: "0.9.24", repositoryUrl: repo })).toBe(
      `${repo}/releases/tag/0.9.24`,
    );
  });

  it("points a dev build at its commit — there is no release to open", () => {
    expect(
      versionHref({ version: "dev", commit: "abc1234def", repositoryUrl: repo }),
    ).toBe(`${repo}/commit/abc1234def`);
  });

  it("points a locally built image at its commit, not at a release that does not exist", () => {
    // scripts/deploy.sh stamps the short sha as the version; there is no tag
    // behind it, so a /releases/tag/ link would 404.
    expect(
      versionHref({ version: "abc1234", commit: "abc1234", repositoryUrl: repo }),
    ).toBe(`${repo}/commit/abc1234`);
  });

  it("falls back to the repository root when neither a tag nor a commit is known", () => {
    expect(versionHref({ version: "dev", commit: null, repositoryUrl: repo })).toBe(
      repo,
    );
  });

  it("tolerates a trailing slash on the stamped repository", () => {
    expect(versionHref({ version: "v1.0.0", repositoryUrl: `${repo}/` })).toBe(
      `${repo}/releases/tag/v1.0.0`,
    );
  });

  it("links nowhere when the build carries no repository", () => {
    // An older panel serves no repositoryUrl; guessing an owner would send the
    // operator to someone else's code.
    expect(versionHref({ version: "v1.0.0", commit: "abc1234" })).toBeNull();
    expect(versionHref({ version: "v1.0.0", repositoryUrl: "  " })).toBeNull();
  });
});

describe("versionLabel", () => {
  it("names a build by its tag", () => {
    expect(versionLabel({ version: "v0.9.24", commit: "abc1234def" })).toBe(
      "v0.9.24",
    );
  });

  it("names a dev build by its short commit", () => {
    expect(versionLabel({ version: "dev", commit: "abc1234def56" })).toBe(
      "abc1234",
    );
  });

  it("stays 'dev' when there is nothing else to show", () => {
    expect(versionLabel({ version: "dev", commit: null })).toBe("dev");
    expect(versionLabel({})).toBe("dev");
  });
});
