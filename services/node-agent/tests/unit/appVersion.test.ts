import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APP_VERSION } from "@/constants/appVersion";

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
