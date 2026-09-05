import { describe, expect, it } from "vitest";

import { messages } from "./messages";

const INSTALL_PREFIX = "install.";
const EMOJI = /\p{Extended_Pictographic}/u;
const URL_LITERAL = /https?:\/\//;
const VERSION_LITERAL = /\d+\.\d+\.\d+/;

const installKeys = (dict: Record<string, string>) =>
  Object.keys(dict)
    .filter((key) => key.startsWith(INSTALL_PREFIX))
    .sort();

// Every key the install guide renders. Kept explicit so deleting a string that
// the dialog still uses fails here instead of showing the raw key to a user.
const REQUIRED = [
  "install.button",
  "install.title",
  "install.desc",
  "install.opensNewTab",
  "install.latestVersion",
  "install.linksUnavailable",
  "install.linksStale",
  "install.installTitle",
  "install.platform.windows",
  "install.platform.macos",
  "install.platform.android",
  "install.platform.ios",
  "install.pickFile",
  "install.desktopNote",
  "install.iosNote",
  "install.iosProfileWarning",
  "install.versionNote",
  "install.apkTitle",
  "install.apkIntro",
  "install.apkStep1",
  "install.apkStep2",
  "install.apkStep3",
  "install.apkDownload",
  "install.apkOtherBuilds",
  "install.addTitle",
  "install.addStep1",
  "install.addStep2",
  "install.addStep3",
  "install.fileTitle",
  "install.fileBody",
  "install.fileSplitBest",
  "install.fileStep1",
  "install.fileStep2",
  "install.fileStep3",
  "install.fileHow",
  "install.fileDomainsWarning",
  "install.fileConfFallback",
  "install.longKeyFile",
  "install.fixTitle",
  "install.fixServer",
  "install.fixFullTunnel",
  "install.fixUpdate",
];

describe("install guide messages", () => {
  it("exist in both languages with the same key set", () => {
    const ru = installKeys(messages.ru);
    const en = installKeys(messages.en);
    expect(ru.length).toBeGreaterThan(0);
    expect(en).toEqual(ru);
  });

  it("cover every string the dialog renders", () => {
    for (const key of REQUIRED) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });

  it("contain no emoji, no URLs and no bare version numbers", () => {
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      for (const key of installKeys(dict)) {
        const value = dict[key] ?? "";
        expect(value.trim().length, `${lang}:${key} is empty`).toBeGreaterThan(0);
        expect(value, `${lang}:${key} contains an emoji`).not.toMatch(EMOJI);
        expect(value, `${lang}:${key} inlines a URL`).not.toMatch(URL_LITERAL);
        expect(value, `${lang}:${key} inlines a version`).not.toMatch(
          VERSION_LITERAL,
        );
      }
    }
  });

  // Everything the guide shows only in its detailed view. The budget below is
  // about the SIMPLE view — the one a stuck user is handed — so these are
  // subtracted from it. Listed by hand because there is no marker in the string
  // itself; the test right after this one is what stops the list going stale.
  const DETAILED_ONLY = [
    "install.apkTitle",
    "install.apkIntro",
    "install.apkStep1",
    "install.apkStep2",
    "install.apkStep3",
    "install.apkDownload",
    "install.apkOtherBuilds",
    "install.latestVersion",
    "install.versionNote",
    "install.fileTitle",
    "install.fileBody",
    "install.fileSplitBest",
    "install.fileStep1",
    "install.fileStep2",
    "install.fileStep3",
    "install.routesWhy",
    "install.routesWhenNot",
    "install.fileHow",
    "install.fileDomainsWarning",
    "install.fileConfFallback",
    "install.fixAmneziaDns",
    "install.fixUpdate",
  ];

  // A renamed or deleted key would silently shrink the measured set and let the
  // simple view grow unnoticed, which is the one thing the budget exists to
  // prevent.
  it("has a detailed-only list that still matches the strings", () => {
    for (const key of DETAILED_ONLY) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });

  // The guide was rewritten from documentation into three steps because the
  // audience does not read documentation: the old version ran to roughly 5000
  // characters a locale. This is a budget, not a style rule — raise it
  // deliberately and with a reason, or the guide grows back one paragraph at a
  // time and stops being read again.
  it("keeps the simple view short enough that someone reads it", () => {
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      const total = installKeys(dict)
        .filter((key) => !DETAILED_ONLY.includes(key))
        .reduce((sum, key) => sum + (dict[key] ?? "").length, 0);
      expect(total, `${lang} simple install copy`).toBeLessThanOrEqual(2200);
    }
  });

  // The detailed view is opt-in, so it gets room the simple one does not — but
  // not unlimited room: "put it behind the switch" is otherwise a licence to
  // write anything.
  //
  // Raised from 2900 to 3000 when the file section moved from `.conf` to
  // `.vpn`: `.conf` did not disappear, it became a fallback that has to say
  // what it is still good for, and that paragraph is copy the guide did not
  // carry before. The rest of the section was trimmed to pay for most of it.
  it("keeps the detailed view from growing without limit either", () => {
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      const total = installKeys(dict).reduce(
        (sum, key) => sum + (dict[key] ?? "").length,
        0,
      );
      expect(total, `${lang} install copy`).toBeLessThanOrEqual(3000);
    }
  });

  it("interpolates the client floor instead of hardcoding it", () => {
    expect(messages.ru["wizard.awg3Hint"]).toContain("{version}");
    expect(messages.en["wizard.awg3Hint"]).toContain("{version}");
    expect(messages.ru["install.versionNote"]).toContain("{version}");
    expect(messages.en["install.versionNote"]).toContain("{version}");
    expect(messages.ru["install.latestVersion"]).toContain("{version}");
    expect(messages.en["install.latestVersion"]).toContain("{version}");
  });
});
