import { describe, expect, it } from "vitest";

import { messages } from "./i18n/messages";
import { keyDelivery } from "./key-delivery";

describe("keyDelivery", () => {
  it("hands the full tunnel over as a link", () => {
    expect(keyDelivery("full_tunnel")).toEqual({
      linkUsable: true,
      reasonKey: null,
    });
  });

  it("makes the blocked-only profile a file-only key", () => {
    expect(keyDelivery("ru_blacklist")).toEqual({
      linkUsable: false,
      reasonKey: "config.fileOnlyWhy",
    });
  });

  // A profile this build has never heard of still carries a rule feed — that
  // is the only reason a profile other than the full tunnel exists — so the
  // safe default is the file, not a link that silently arrives truncated.
  it("treats an unknown profile as file-only", () => {
    expect(keyDelivery("something_new").linkUsable).toBe(false);
  });

  it("only ever returns reason keys that exist in both languages", () => {
    const keys = new Set<string>();
    for (const profile of ["full_tunnel", "ru_blacklist", "something_new"]) {
      const { reasonKey } = keyDelivery(profile);
      if (reasonKey) keys.add(reasonKey);
    }
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(messages.ru, key).toHaveProperty(key);
      expect(messages.en, key).toHaveProperty(key);
    }
  });
});
