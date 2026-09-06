import { describe, expect, it } from "vitest";

import { messages } from "@/lib/i18n/messages";
import {
  needsCameraWarning,
  qrRecoveryTargets,
  type QrAudience,
} from "./config-download-dialog";

const ALL_AUDIENCES: QrAudience[] = ["app", "awg", "camera"];

// Which tool a given audience's recovery link claims to open a code for,
// independent of the dialog's own copy — used below to check the offered
// destination is never the very tool that could not read the code.
const TOOL_FOR: Record<QrAudience, string> = {
  app: "config.qrSwitchToApp",
  awg: "config.qrSwitchToAwg",
  camera: "config.qrSwitchToCamera",
};

describe("qrRecoveryTargets", () => {
  it("offers exactly the other two tools, never the tab already open", () => {
    // Regression for the finding: a two-way toggle used to send every
    // non-frame tab -- "awg" included -- to "app", the chunk envelope, which
    // AmneziaWG cannot read either. Each tab must now offer BOTH remaining
    // tools by name, so there is always a correct destination for whichever
    // one the user is actually holding.
    expect(qrRecoveryTargets("app")).toEqual(["awg", "camera"]);
    expect(qrRecoveryTargets("awg")).toEqual(["app", "camera"]);
    expect(qrRecoveryTargets("camera")).toEqual(["app", "awg"]);
  });

  it("never sends a tab to a code its own tool cannot read", () => {
    for (const current of ALL_AUDIENCES) {
      const targets = qrRecoveryTargets(current);
      // Never a same-tab no-op link.
      expect(targets).not.toContain(current);
      // Always both of the alternatives, so the AmneziaWG user described in
      // the finding lands on a code AmneziaWG (or the in-app scanner, or the
      // camera -- whichever is not the current tab) can actually read.
      expect(targets.sort()).toEqual(
        ALL_AUDIENCES.filter((audience) => audience !== current).sort(),
      );
    }
  });

  it("each offered destination names a distinct tool with real copy in both locales", () => {
    for (const current of ALL_AUDIENCES) {
      for (const target of qrRecoveryTargets(current)) {
        const key = TOOL_FOR[target];
        expect(messages.ru, `ru missing ${key}`).toHaveProperty(key);
        expect(messages.en, `en missing ${key}`).toHaveProperty(key);
        const ru = (messages.ru as Record<string, string | undefined>)[key] ?? "";
        const en = (messages.en as Record<string, string | undefined>)[key] ?? "";
        expect(ru.length).toBeGreaterThan(0);
        expect(en.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("needsCameraWarning", () => {
  it("warns on both app-only codes and not on the camera's own code", () => {
    // `app` (chunk envelope) and `awg` (plain WireGuard config) are each
    // useless to a plain camera app -- illegible or merely inert text. Only
    // `camera`'s own `vpn://` code is genuinely meant for a camera app, so it
    // is the one audience that needs no warning.
    expect(needsCameraWarning("app")).toBe(true);
    expect(needsCameraWarning("awg")).toBe(true);
    expect(needsCameraWarning("camera")).toBe(false);
  });
});

describe("Default VPN QR claims", () => {
  // The operator has not seen QR scanning work in a shipped Default VPN
  // build and there may be different builds in the wild, so the dialog must
  // not promise it either way. Regression for a promise that used to live in
  // config.qrHintApp / config.qrSwitchToApp ("... AmneziaVPN or Default
  // VPN)... tap Add -> Scan QR code ..."). qrFrames.ts records the discrepancy
  // between this and its source analysis; this file must not repeat the claim.
  it("never names Default VPN in the app-tab scan instructions", () => {
    for (const lang of ["ru", "en"] as const) {
      expect(messages[lang]["config.qrHintApp"]).not.toMatch(/Default ?VPN/i);
      expect(messages[lang]["config.qrSwitchToApp"]).not.toMatch(
        /Default ?VPN/i,
      );
    }
  });
});

describe("config.qrAwgWarning", () => {
  it("exists in both locales with wording distinct from the app warning", () => {
    // The finding: awg's warning was the unused "same reason as camera"
    // placeholder. It now has to be its own real copy, not a reuse of
    // config.qrAppWarning's text.
    expect(messages.ru).toHaveProperty("config.qrAwgWarning");
    expect(messages.en).toHaveProperty("config.qrAwgWarning");
    expect(messages.ru["config.qrAwgWarning"]).not.toBe(
      messages.ru["config.qrAppWarning"],
    );
    expect(messages.en["config.qrAwgWarning"]).not.toBe(
      messages.en["config.qrAppWarning"],
    );
  });
});
