import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APP_VERSION, extractVersion } from "@/constants/appVersion";

describe("APP_VERSION", () => {
  // Read from package.json rather than hard-coded here on purpose: a literal in
  // this test would be a third copy of the version, and the whole point of the
  // helper is that there is only one.
  it("is the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("looks like a semantic version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("extractVersion", () => {
  // Exercise the validation logic directly with a fabricated object instead
  // of mangling the real package.json, per the guard's contract: a missing or
  // non-string "version" must fail loudly rather than produce `undefined`.
  it("returns the version when it is a non-empty string", () => {
    expect(extractVersion({ version: "1.2.3" }, "/fake/package.json")).toBe(
      "1.2.3",
    );
  });

  it("throws naming the source path when version is missing", () => {
    expect(() => extractVersion({}, "/fake/package.json")).toThrow(
      /\/fake\/package\.json/,
    );
  });

  it("throws when version is not a string", () => {
    expect(() =>
      extractVersion({ version: 123 }, "/fake/package.json"),
    ).toThrow(/version/);
  });

  it("throws when version is an empty string", () => {
    expect(() =>
      extractVersion({ version: "" }, "/fake/package.json"),
    ).toThrow(/version/);
  });

  it("throws when the parsed value is not an object", () => {
    expect(() => extractVersion(null, "/fake/package.json")).toThrow(
      /version/,
    );
  });
});
