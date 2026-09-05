import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Task 5 (panel-managed Access domains): the Users page carries an honest
// summary of who can sign in, because control-api never reads the Cloudflare
// Access policy — groups, `everyone`, and hand-added rules are invisible to
// it. Both the "what the panel cannot see" clause and the "the identity
// provider still gates admission" clause are easy to soften away in a later
// edit and would not fail any type check, so they are pinned by source
// inspection rather than trusted to survive.
const source = readFileSync(
  fileURLToPath(new URL("./page.tsx", import.meta.url)),
  "utf8",
);

describe("Access domains card", () => {
  it("renders the honest summary of who can sign in", () => {
    expect(source).toContain("users.accessWhoTitle");
    expect(source).toContain("users.accessWhoSummary");
  });

  it("renders the identity-provider hint on the editor", () => {
    expect(source).toContain("users.accessDomainsHint");
  });

  it("saves only the domain field, never the rest of the policy row", () => {
    // A payload built from `{ ...policy }` would repost every read-only
    // computed field (cfApiTokenSet, etc.) alongside the edit; this pins the
    // save to the single-field object literal instead.
    expect(source).toMatch(
      /action\("portal-policy",\s*"global",\s*"update",\s*\{\s*cfAccessAllowedDomains:\s*next,\s*\}\s*\)/,
    );
  });
});

describe("Domain filter", () => {
  it("narrows the same list the status filter and search box narrow", () => {
    // One filter pipeline, not a second mechanism: the domain predicate sits
    // inside the same `.filter().filter()` chain that already combines the
    // status filter and the search text.
    expect(source).toMatch(
      /matchesFilter\(entry, filter\)[\s\S]{0,400}activeDomain[\s\S]{0,400}needle/,
    );
  });

  it("offers only domains present among the loaded users, not free text", () => {
    expect(source).toMatch(/domainOptions = React\.useMemo/);
    expect(source).toMatch(/emailDomain\(entry\.user\.email\)/);
  });
});

describe("emailDomain", () => {
  it("lowercases and returns the part after the last '@'", async () => {
    const { emailDomain } = await import("./page");
    expect(emailDomain("User@Company.TLD")).toBe("company.tld");
  });

  it("returns an empty string when there is no '@'", async () => {
    const { emailDomain } = await import("./page");
    expect(emailDomain("not-an-email")).toBe("");
  });
});

describe("resolveDomainFilter", () => {
  it("keeps a selection that is still among the available domains", async () => {
    const { resolveDomainFilter } = await import("./page");
    expect(resolveDomainFilter("a.com", ["a.com", "b.com"])).toBe("a.com");
  });

  it("always keeps the 'all' sentinel, even with no domains loaded", async () => {
    const { resolveDomainFilter } = await import("./page");
    expect(resolveDomainFilter("all", [])).toBe("all");
  });

  it("falls back to 'all' once the selected domain is no longer present", async () => {
    // A domain the operator narrowed to can vanish from the loaded users
    // (renamed, offboarded) between renders; falling back to "all" here is
    // what keeps the list from silently showing nobody.
    const { resolveDomainFilter } = await import("./page");
    expect(resolveDomainFilter("gone.com", ["a.com", "b.com"])).toBe("all");
  });
});

describe("addAccessDomain", () => {
  it("appends a new domain", async () => {
    const { addAccessDomain } = await import("./page");
    expect(addAccessDomain(["a.com"], "b.com")).toEqual(["a.com", "b.com"]);
  });

  it("de-dupes case-insensitively without altering the stored casing", async () => {
    const { addAccessDomain } = await import("./page");
    expect(addAccessDomain(["company.tld"], "COMPANY.TLD")).toEqual([
      "company.tld",
    ]);
  });

  it("leaves a leading '@' untouched — the server normalizes it", async () => {
    const { addAccessDomain } = await import("./page");
    expect(addAccessDomain([], "@company.tld")).toEqual(["@company.tld"]);
  });

  it("starts from an empty list", async () => {
    const { addAccessDomain } = await import("./page");
    expect(addAccessDomain([], "company.tld")).toEqual(["company.tld"]);
  });
});
