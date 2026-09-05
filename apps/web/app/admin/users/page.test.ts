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
