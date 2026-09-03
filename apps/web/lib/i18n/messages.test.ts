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
  "install.apkStep4",
  "install.apkDownload",
  "install.apkOtherBuilds",
  "install.addTitle",
  "install.addStep1",
  "install.addStep2",
  "install.addStep3",
  "install.addStep4",
  "install.addResult",
  "install.confTitle",
  "install.confBody",
  "install.confSplitBest",
  "install.confIosWarning",
  "install.confAmneziaTitle",
  "install.confAmneziaStep1",
  "install.confAmneziaStep2",
  "install.confAmneziaStep3",
  "install.confOtherTitle",
  "install.confOtherBody",
  "install.confStockWarning",
  "install.confDomainsWarning",
  "install.fixTitle",
  "install.fixServer",
  "install.fixFullTunnel",
  "install.fixUpdate",
  "install.checkUpdates",
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

  it("interpolates the client floor instead of hardcoding it", () => {
    expect(messages.ru["wizard.awg3Hint"]).toContain("{version}");
    expect(messages.en["wizard.awg3Hint"]).toContain("{version}");
    expect(messages.ru["install.versionNote"]).toContain("{version}");
    expect(messages.en["install.versionNote"]).toContain("{version}");
    expect(messages.ru["install.latestVersion"]).toContain("{version}");
    expect(messages.en["install.latestVersion"]).toContain("{version}");
  });
});
