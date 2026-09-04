import { describe, expect, it } from "vitest";
import { DEVICE_TYPE_ORDER, deviceTypeSchema } from "@amnezia/contracts";
import { deviceTypeLabel, isDeviceType } from "./device-type";
import { messages } from "./i18n/messages";

const ru = (key: string): string =>
  (messages.ru as Record<string, string>)[key] ?? key;

describe("device type labels", () => {
  it("has a card label for every device type, in both languages", () => {
    for (const device of deviceTypeSchema.options) {
      for (const lang of ["ru", "en"] as const) {
        const dict = messages[lang] as Record<string, string>;
        expect(dict[`device.${device}`], `${lang}/device.${device}`).toBeTruthy();
      }
    }
  });

  it("has a suggested-name base for every offered platform, in both languages", () => {
    for (const device of DEVICE_TYPE_ORDER) {
      // "other" deliberately falls back to the neutral device.base.
      if (device === "other") continue;
      for (const lang of ["ru", "en"] as const) {
        const dict = messages[lang] as Record<string, string>;
        expect(
          dict[`device.name.${device}`],
          `${lang}/device.name.${device}`,
        ).toBeTruthy();
      }
    }
  });

  it("keeps no message for a retired device type", () => {
    for (const retired of ["desktop", "laptop", "iphone", "phone", "tablet"]) {
      for (const lang of ["ru", "en"] as const) {
        const dict = messages[lang] as Record<string, string>;
        expect(dict[`device.${retired}`], `${lang}/${retired}`).toBeUndefined();
      }
    }
  });

  it("labels the combined Apple mobile option as both devices, and names iOS", () => {
    // No separator between the two device names: the card stacks them on their
    // own lines, where a slash just dangles at the end of the first one. The
    // platform is spelled out because "iPhone / iPad" does not tell someone
    // whose device runs iPadOS, or who is looking for the word from the guide.
    expect(deviceTypeLabel(ru, "ios")).toBe("iPhone iPad (iOS)");
  });

  it("keeps the platform on the same line as iPad", () => {
    // A normal space here breaks "(iOS)" onto a third line of its own on the
    // narrow device card. The non-breaking space is load-bearing, not a typo.
    for (const lang of ["ru", "en"] as const) {
      const dict = messages[lang] as Record<string, string>;
      expect(dict["device.ios"], lang).toContain("iPad (iOS)");
    }
  });

  it("shows a value this build does not know verbatim, not as a message key", () => {
    // A browser tab left open across a deploy can receive anything.
    expect(isDeviceType("laptop")).toBe(false);
    expect(deviceTypeLabel(ru, "laptop")).toBe("laptop");
    expect(deviceTypeLabel(ru, "quantum-toaster")).toBe("quantum-toaster");
  });

  it("recognises every current device type", () => {
    for (const device of deviceTypeSchema.options) {
      expect(isDeviceType(device), device).toBe(true);
    }
  });
});
