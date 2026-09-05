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
  "install.fileConfFallback",
  "install.sitesTitle",
  "install.sitesBody",
  "install.sitesWhere",
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
    "install.fileConfFallback",
    "install.fixAmneziaDns",
    "install.fixUpdate",
    "install.sitesTitle",
    "install.sitesBody",
    "install.sitesWhere",
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
  //
  // Raised again from 3000 to 3200 when route rules became addresses-only. The
  // guide now has to name the one way a rule by site name still works — a
  // full-traffic key plus the client's own settings page — because the panel no
  // longer offers even the appearance of it. That is a new question the guide
  // did not have to answer before, and it earns its own short section rather
  // than a clause bolted onto another one. Most of the room was paid for by
  // deleting the .vpn domain warning, which described a difference between the
  // file and the clipboard that no longer exists.
  it("keeps the detailed view from growing without limit either", () => {
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      const total = installKeys(dict).reduce(
        (sum, key) => sum + (dict[key] ?? "").length,
        0,
      );
      expect(total, `${lang} install copy`).toBeLessThanOrEqual(3200);
    }
  });

  it("keeps the install reminder out of this budget on purpose", () => {
    // The reminder dialog's keys are `installReminder.*`, which do NOT start
    // with "install." and are measured by their own budget at the bottom of
    // this file. Asserted rather than left implicit: the two prefixes are one
    // character apart, and a rename either way would silently move copy from
    // one budget to the other.
    expect(
      installKeys(messages.ru).some((key) => key.includes("Reminder")),
    ).toBe(false);
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

/**
 * The step between "key created" and the guide. Its own dictionary block and
 * its own budget: it is not the guide, and a dialog somebody has to read before
 * the only enabled button lights up has to stay short enough to be read.
 */
describe("install reminder messages", () => {
  const PREFIX = "installReminder.";
  const reminderKeys = (dict: Record<string, string>) =>
    Object.keys(dict)
      .filter((key) => key.startsWith(PREFIX))
      .sort();

  // Every key the dialog renders, so deleting one fails here rather than
  // showing a raw key to a user mid-warning.
  const REQUIRED = [
    "installReminder.title",
    "installReminder.desc",
    "installReminder.headline",
    "installReminder.mandatory",
    "installReminder.why",
    "installReminder.looksFine",
    "installReminder.confirm",
    "installReminder.confirmAgain",
    "installReminder.doubt",
    "installReminder.next",
    "installReminder.challenge",
    "installReminder.nextHint",
  ];

  it("offers no soft exit", () => {
    // The operator's instruction: «Позже» is gone and stays gone. A dialog
    // dismissed approvingly without being read is the third state the
    // two-step confirmation exists to close off; the ✕ and Esc remain.
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      expect(dict, `${lang} still has a Later button`).not.toHaveProperty(
        "installReminder.later",
      );
      for (const key of reminderKeys(dict)) {
        expect(dict[key], `${lang}:${key}`).not.toMatch(/Позже|\bLater\b/);
      }
    }
  });

  it("exists in both languages with the same key set", () => {
    const ru = reminderKeys(messages.ru);
    const en = reminderKeys(messages.en);
    expect(ru.length).toBeGreaterThan(0);
    expect(en).toEqual(ru);
  });

  it("covers every string the dialog renders", () => {
    for (const key of REQUIRED) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });

  it("contains no emoji, no URLs and no bare version numbers", () => {
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      for (const key of reminderKeys(dict)) {
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

  it("interpolates the client floor rather than naming a version", () => {
    // The dialog exists to say WHY an old client cannot use the key just
    // issued, and the floor is that reason. It comes from
    // MIN_AWG3_CLIENT_VERSION, like every other place that states it.
    expect(messages.ru["installReminder.why"]).toContain("{version}");
    expect(messages.en["installReminder.why"]).toContain("{version}");
  });

  it("stays short enough that somebody reads it before ticking the box", () => {
    // A budget, like the guide's above. This dialog interrupts a user who has
    // just finished a form; the moment it grows into a page it gets dismissed
    // unread, which is the exact failure it was built to prevent. Raise it
    // deliberately and with a reason, or not at all.
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      const total = reminderKeys(dict).reduce(
        (sum, key) => sum + (dict[key] ?? "").length,
        0,
      );
      expect(total, `${lang} install reminder copy`).toBeLessThanOrEqual(900);
    }
  });
});
