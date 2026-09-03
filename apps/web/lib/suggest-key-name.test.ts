import { describe, expect, it } from "vitest";
import { DEVICE_TYPE_ORDER } from "@amnezia/contracts";
import { suggestKeyName } from "./suggest-key-name";
import { messages } from "./i18n/messages";

const en = (key: string): string =>
  (messages.en as Record<string, string>)[key] ?? key;
const ru = (key: string): string =>
  (messages.ru as Record<string, string>)[key] ?? key;

describe("suggestKeyName", () => {
  it("names each platform with something a person would actually type", () => {
    expect(suggestKeyName("android", [], en)).toBe("Android");
    expect(suggestKeyName("ios", [], en)).toBe("iPhone");
    expect(suggestKeyName("macos", [], en)).toBe("Mac");
    expect(suggestKeyName("windows", [], en)).toBe("PC");
    expect(suggestKeyName("linux", [], en)).toBe("Linux");
  });

  it("localises the base name", () => {
    expect(suggestKeyName("windows", [], ru)).toBe("ПК");
    expect(suggestKeyName("other", [], ru)).toBe("Устройство");
  });

  it("falls back to a neutral word for the generic types", () => {
    expect(suggestKeyName("other", [], en)).toBe("Device");
    expect(suggestKeyName("unspecified", [], en)).toBe("Device");
  });

  // The card label is "iPhone / iPad"; a key called "iPhone / iPad 2" would be
  // the old one-namespace design leaking into the name.
  it("never suggests a card label or a raw message key", () => {
    for (const device of DEVICE_TYPE_ORDER) {
      const suggestion = suggestKeyName(device, [], en);
      expect(suggestion, device).not.toMatch(/^device\./);
      expect(suggestion, device).not.toContain("/");
    }
  });

  it("counts up past names that are already taken, case-insensitively", () => {
    expect(suggestKeyName("ios", ["iPhone"], en)).toBe("iPhone 2");
    expect(suggestKeyName("ios", ["iphone", "IPHONE 2"], en)).toBe("iPhone 3");
    expect(suggestKeyName("ios", ["  iPhone  "], en)).toBe("iPhone 2");
  });
});
