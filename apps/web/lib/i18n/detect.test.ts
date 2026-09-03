import { describe, expect, it } from "vitest";
import { detectLang, isLang, resolveInitialLang } from "./detect";

describe("isLang", () => {
  it("accepts exactly the supported codes", () => {
    expect(isLang("ru")).toBe(true);
    expect(isLang("en")).toBe(true);
  });

  it("rejects anything else, including case variants and non-strings", () => {
    expect(isLang("EN")).toBe(false);
    expect(isLang("en-US")).toBe(false);
    expect(isLang("fr")).toBe(false);
    expect(isLang("")).toBe(false);
    expect(isLang(null)).toBe(false);
    expect(isLang(undefined)).toBe(false);
    expect(isLang(42)).toBe(false);
  });
});

describe("detectLang", () => {
  it("matches a bare code", () => {
    expect(detectLang(["en"])).toBe("en");
    expect(detectLang(["ru"])).toBe("ru");
  });

  it("matches on the primary subtag of a region tag", () => {
    expect(detectLang(["en-US"])).toBe("en");
    expect(detectLang(["ru-RU"])).toBe("ru");
    expect(detectLang(["en-GB", "en"])).toBe("en");
  });

  it("is case-insensitive on the tag", () => {
    expect(detectLang(["EN-us"])).toBe("en");
    expect(detectLang(["Ru"])).toBe("ru");
  });

  it("takes the first supported entry in preference order", () => {
    expect(detectLang(["de-DE", "en-US", "ru"])).toBe("en");
    expect(detectLang(["ru", "en-US"])).toBe("ru");
    expect(detectLang(["fr-FR", "ru-RU", "en"])).toBe("ru");
  });

  it("returns null when nothing is supported", () => {
    expect(detectLang(["de-DE", "fr"])).toBeNull();
    expect(detectLang([])).toBeNull();
    expect(detectLang([""])).toBeNull();
  });

  it("does not match by prefix of the primary subtag", () => {
    // "english" or "rus" are not BCP-47 primary subtags we ship.
    expect(detectLang(["english"])).toBeNull();
    expect(detectLang(["rus"])).toBeNull();
  });

  it.each([
    ["Ukrainian", "uk-UA"],
    ["Belarusian", "be-BY"],
    ["Kazakh", "kk-KZ"],
  ])("maps %s to Russian", (_name, tag) => {
    // The panel ships no UI in these; Russian is the nearer of the two it does
    // ship. Operator's decision, 2026-09-02.
    expect(detectLang([tag])).toBe("ru");
  });

  it("prefers a shipped language over an alias earlier in the list", () => {
    // A visitor who lists English above Ukrainian wants English.
    expect(detectLang(["en-US", "uk-UA"])).toBe("en");
    // ...and the alias still wins over a language we do not ship at all.
    expect(detectLang(["de-DE", "kk-KZ", "en"])).toBe("ru");
  });
});

describe("resolveInitialLang", () => {
  it("prefers a valid stored choice over the browser", () => {
    expect(resolveInitialLang("ru", ["en-US"], "ru")).toEqual({
      lang: "ru",
      source: "stored",
    });
    expect(resolveInitialLang("en", ["ru-RU"], "ru")).toEqual({
      lang: "en",
      source: "stored",
    });
  });

  it("follows the browser when nothing is stored", () => {
    expect(resolveInitialLang(null, ["en-US", "en"], "ru")).toEqual({
      lang: "en",
      source: "browser",
    });
    expect(resolveInitialLang(null, ["ru-RU"], "ru")).toEqual({
      lang: "ru",
      source: "browser",
    });
  });

  it("treats an invalid stored value as nothing stored", () => {
    expect(resolveInitialLang("fr", ["en-US"], "ru")).toEqual({
      lang: "en",
      source: "browser",
    });
    expect(resolveInitialLang("", ["en-US"], "ru")).toEqual({
      lang: "en",
      source: "browser",
    });
  });

  it("falls back to English when neither storage nor the browser decide", () => {
    // DETECTION_FALLBACK is "en" (operator's decision): a browser that lists
    // no language we ship or alias gets the international one, not Russian.
    expect(resolveInitialLang(null, ["de-DE"], "en")).toEqual({
      lang: "en",
      source: "fallback",
    });
    expect(resolveInitialLang(null, [], "en")).toEqual({
      lang: "en",
      source: "fallback",
    });
  });

  it("honours the fallback it is given", () => {
    // The fallback is a parameter, not a constant, so the caller decides.
    expect(resolveInitialLang(null, ["de-DE"], "ru")).toEqual({
      lang: "ru",
      source: "fallback",
    });
  });

  it("treats an aliased browser language as a browser match, so it persists", () => {
    // source "browser" is what makes the provider write to localStorage; an
    // aliased hit must persist like any other, or every visit re-detects.
    expect(resolveInitialLang(null, ["uk-UA"], "en")).toEqual({
      lang: "ru",
      source: "browser",
    });
  });
});

// browserLanguages() lives in the provider (it touches `navigator`), but the
// shapes it can hand this module are worth pinning here: an engine with no
// `navigator.languages` reports no preference, and that must resolve rather
// than throw.
describe("an engine that reports no preference", () => {
  it("falls back rather than failing", () => {
    expect(detectLang([])).toBeNull();
    expect(resolveInitialLang(null, [], "en")).toEqual({
      lang: "en",
      source: "fallback",
    });
  });

  it("still lets a stored choice win", () => {
    expect(resolveInitialLang("ru", [], "en")).toEqual({
      lang: "ru",
      source: "stored",
    });
  });
});
