import { describe, expect, it } from "vitest";

import {
  auditCategoryOf,
  auditRowMatches,
  auditScopeOf,
  type AuditFilter,
} from "./audit-filter";

const row = (over: Partial<Parameters<typeof auditRowMatches>[0]> = {}) => ({
  actorType: "user",
  targetType: "vpn_key",
  haystack: "someone created a key",
  ...over,
});

const filter = (over: Partial<AuditFilter> = {}): AuditFilter => ({
  scope: "all",
  category: null,
  query: "",
  ...over,
});

describe("auditCategoryOf", () => {
  // The whole reason this function exists. Measured on a live panel: 113
  // `vpn_key` rows beside 34 `keys`, 24 `user` beside 12 `users` — the same
  // subjects under a domain name and a REST name, because `admin.<resource>`
  // events write the resource. Two chips for one subject would be worse than
  // no facet, so both spellings must land on the same value.
  it("folds the domain and REST spellings of one subject together", () => {
    expect(auditCategoryOf("vpn_key")).toBe(auditCategoryOf("keys"));
    expect(auditCategoryOf("user")).toBe(auditCategoryOf("users"));
    expect(auditCategoryOf("node")).toBe(auditCategoryOf("nodes"));
    expect(auditCategoryOf("portal_policy")).toBe(
      auditCategoryOf("portal-policy"),
    );
    expect(auditCategoryOf("quota_request")).toBe(
      auditCategoryOf("quota-requests"),
    );
  });

  // The table is append-only and a build older than the rows it reads is the
  // normal state right after a deploy — an unknown target must not vanish.
  it("keeps an unrecognised target visible under other", () => {
    expect(auditCategoryOf("something_new")).toBe("other");
  });
});

describe("auditScopeOf", () => {
  it("reads the actor column rather than guessing from the action", () => {
    expect(auditScopeOf("system")).toBe("system");
    expect(auditScopeOf("user")).toBe("people");
    expect(auditScopeOf("admin")).toBe("people");
  });
});

describe("auditRowMatches", () => {
  it("passes everything when no facet is set", () => {
    expect(auditRowMatches(row(), filter())).toBe(true);
  });

  it("separates the panel's own work from a person's", () => {
    expect(auditRowMatches(row(), filter({ scope: "system" }))).toBe(false);
    expect(auditRowMatches(row(), filter({ scope: "people" }))).toBe(true);
    expect(
      auditRowMatches(row({ actorType: "system" }), filter({ scope: "system" })),
    ).toBe(true);
  });

  it("filters by category across both spellings", () => {
    for (const targetType of ["vpn_key", "keys"]) {
      expect(
        auditRowMatches(row({ targetType }), filter({ category: "keys" })),
      ).toBe(true);
    }
    expect(
      auditRowMatches(row({ targetType: "node" }), filter({ category: "keys" })),
    ).toBe(false);
  });

  // Each facet answers a different question, so a row has to satisfy all of
  // them — a category that matches must not rescue a row the scope excluded.
  it("ands the facets together", () => {
    expect(
      auditRowMatches(
        row({ actorType: "system", targetType: "vpn_key" }),
        filter({ scope: "people", category: "keys" }),
      ),
    ).toBe(false);
  });

  it("matches the free text case-insensitively and ignores padding", () => {
    expect(auditRowMatches(row(), filter({ query: "  CREATED " }))).toBe(true);
    expect(auditRowMatches(row(), filter({ query: "revoked" }))).toBe(false);
  });
});
