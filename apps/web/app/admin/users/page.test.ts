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

describe("Access domains dialog", () => {
  it("renders the honest summary of who can sign in", () => {
    expect(source).toContain("users.accessWhoTitle");
    expect(source).toContain("users.accessWhoSummary");
  });

  it("renders the identity-provider hint on the editor", () => {
    expect(source).toContain("users.accessDomainsHint");
  });

  it("lives behind a toolbar button rather than an always-open card", () => {
    // The editor is configuration an admin visits, not a card standing open on
    // every trip to the Users page. Pinned here because a later edit could
    // quietly move it back inline and nothing would fail.
    expect(source).toContain("users.accessDomainsBtn");
    expect(source).toMatch(/<AccessDomainsDialog\s/);
    expect(source).not.toMatch(/<AccessDomainsCard\s/);
  });

  it("gives every domain a row, not a pill, and says so when there are none", () => {
    // The list is the subject of the dialog: one row per domain in a scrolling
    // frame, with a count above it, and an empty list that still explains who
    // gets in. A later edit collapsing this back into wrapped pills would not
    // fail any type check.
    expect(source).toMatch(/<ul className="max-h-64 divide-y/);
    expect(source).toContain("users.accessDomainsCount");
    expect(source).toContain("users.accessDomainsRemoveBtn");
    expect(source).toContain("users.accessDomainsEmpty");
    expect(source).not.toContain("rounded-md bg-muted px-2 py-0.5 font-mono");
  });

  it("folds the who-can-sign-in answer below the list without losing a word of it", () => {
    // The callout's content is deliberate and stays whole; it just moved into
    // a disclosure under the list instead of five lines above the controls.
    expect(source).toMatch(/<details[\s\S]{0,1200}users\.accessWhoSummary/);
    expect(source).toMatch(
      /users\.accessDomainsCount[\s\S]{0,4000}users\.accessWhoSummary/,
    );
  });

  it("routes a row removal through the confirmation, never straight to the list", () => {
    // Remove on a row must only arm the confirmation dialog. A direct
    // setList filter here would drop the domain with one click, and the cost
    // (people on that domain with no panel account lose their only route in)
    // would never be shown.
    expect(source).toMatch(/onClick=\{\(\) => setPendingRemoval\(domain\)\}/);
    expect(source).toContain("users.accessDomainRemoveTitle");
    expect(source).toContain("users.accessDomainRemoveWhat");
    expect(source).toContain("users.accessDomainRemoveKeeps");
    expect(source).toContain("users.accessDomainRemoveCost");
    expect(source).toContain("users.accessDomainRemoveConfirm");
  });

  it("validates a typed domain inline before it becomes a chip", () => {
    expect(source).toMatch(/validateAccessDomain\(entry, list\)/);
    expect(source).toMatch(/role="alert"/);
  });

  it("saves only the domain field, never the rest of the policy row", () => {
    // A payload built from `{ ...policy }` would repost every read-only
    // computed field (cfApiTokenSet, etc.) alongside the edit; this pins the
    // save to the single-field object literal instead.
    expect(source).toMatch(
      /action\("portal-policy",\s*"global",\s*"update",\s*\{\s*cfAccessAllowedDomains:\s*next,\s*\}\s*\)/,
    );
  });

  it("guards a policy row without the domains field so the card cannot throw on list.length", () => {
    // A mixed-version deploy can hand back a portal-policy row from before
    // this field existed (`policy.cfAccessAllowedDomains` undefined); without
    // the `?? []` here, `React.useState<string[]>(domains)` would seed `list`
    // as `undefined` and `list.length` below would throw.
    expect(source).toMatch(/domains=\{policy\.cfAccessAllowedDomains \?\? \[\]\}/);
  });

  it("gates the editor on Cloudflare actually being configured", () => {
    expect(source).toContain("configured={isAccessConfigured(policy)}");
    expect(source).toContain("users.accessDomainsDisabledTitle");
    expect(source).toContain("users.accessDomainsDisabledSummary");
    expect(source).toContain("users.accessDomainsDisabledHint");
    expect(source).toContain("users.accessDomainsDisabledLink");
    // The save button must stay disabled on an unconfigured panel even if a
    // draft edit makes it look "dirty" — a save there would arm a background
    // job that can never reach Cloudflare.
    expect(source).toMatch(/disabled=\{!configured \|\| !dirty \|\| saving\}/);
  });
});

describe("isAccessConfigured", () => {
  const base = {
    cfAccessAccountId: "acc",
    cfAccessAppId: "app",
    cfAccessPolicyId: "pol",
    cfApiTokenSet: true,
  };

  it("is true only once every field the write-back needs is set", async () => {
    const { isAccessConfigured } = await import("./page");
    expect(isAccessConfigured(base)).toBe(true);
  });

  it.each([
    "cfAccessAccountId",
    "cfAccessAppId",
    "cfAccessPolicyId",
    "cfApiTokenSet",
  ] as const)("is false when %s is missing", async (field) => {
    const { isAccessConfigured } = await import("./page");
    expect(
      isAccessConfigured({
        ...base,
        [field]: field === "cfApiTokenSet" ? false : null,
      }),
    ).toBe(false);
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

  it("recognises the '@' form as the same domain already in the list", async () => {
    // The server normalizes both spellings to "company.tld" and de-dupes them
    // anyway; catching it here stops two chips that look different but mean
    // one rule from ever appearing in the draft.
    const { addAccessDomain } = await import("./page");
    expect(addAccessDomain(["company.tld"], "@company.tld")).toEqual([
      "company.tld",
    ]);
    expect(addAccessDomain(["@company.tld"], "company.tld")).toEqual([
      "@company.tld",
    ]);
  });
});

describe("validateAccessDomain", () => {
  it("accepts a plain domain and the dashboard's '@' form", async () => {
    const { validateAccessDomain } = await import("./page");
    expect(validateAccessDomain("company.tld", [])).toEqual({ ok: true });
    expect(validateAccessDomain("@company.tld", [])).toEqual({ ok: true });
  });

  it("maps the contract's 'that is an address' refusal to its own message", async () => {
    // This pins the map in page.tsx against accessDomainSchema's wording: if
    // the contract rewords the refusal, the panel would silently fall back to
    // the generic message and this fails instead.
    const { validateAccessDomain } = await import("./page");
    expect(validateAccessDomain("someone@company.tld", [])).toEqual({
      ok: false,
      messageKey: "users.accessDomainErrEmail",
    });
  });

  it("maps the contract's 'not a domain name' refusal to its own message", async () => {
    const { validateAccessDomain } = await import("./page");
    expect(validateAccessDomain("tld", [])).toEqual({
      ok: false,
      messageKey: "users.accessDomainErrHostname",
    });
  });

  it("refuses a domain the draft already holds, whatever it was typed as", async () => {
    const { validateAccessDomain } = await import("./page");
    expect(validateAccessDomain("@COMPANY.TLD", ["company.tld"])).toEqual({
      ok: false,
      messageKey: "users.accessDomainErrDuplicate",
    });
  });
});

describe("Access domain messages", () => {
  it("carries every new key in both languages", async () => {
    const { messages } = await import("@/lib/i18n/messages");
    const keys = [
      "users.accessDomainsBtn",
      "users.accessDomainsCount",
      "users.accessDomainsDesc",
      "users.accessDomainsEmpty",
      "users.accessDomainsRemoveBtn",
      "users.accessDomainErrEmail",
      "users.accessDomainErrHostname",
      "users.accessDomainErrDuplicate",
      "users.accessDomainErrGeneric",
      "users.accessDomainRemoveTitle",
      "users.accessDomainRemoveWhat",
      "users.accessDomainRemoveKeepsTitle",
      "users.accessDomainRemoveKeeps",
      "users.accessDomainRemoveCostTitle",
      "users.accessDomainRemoveCost",
      "users.accessDomainRemoveConfirm",
    ] as const;
    for (const key of keys) {
      expect(messages.ru[key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });

  it("keeps the confirmation honest about what a removal does not do", () => {
    // The one claim that must never soften into "users may lose access": the
    // sync re-emits every active user's own email rule in the same PUT, so a
    // removal disables nobody and revokes no keys (accessReconcile.ts, and
    // docs/CLOUDFLARE-ACCESS.md "Removing a domain disables nobody").
    expect(source).toContain("users.accessDomainRemoveKeepsTitle");
    expect(source).toContain("users.accessDomainRemoveCostTitle");
  });
});

describe("internalNameOutcome", () => {
  it("saves a typed note", async () => {
    const { internalNameOutcome } = await import("./page");
    expect(internalNameOutcome("kochkina, replaced 04.09", null)).toEqual({
      action: "save",
      internalName: "kochkina, replaced 04.09",
    });
  });

  it("treats an emptied field as a deliberate clear, not as nothing", async () => {
    // The `window.prompt` this replaced distinguished "" from `null`; the
    // dialog has to keep the two apart itself, because clearing a note is an
    // edit the API records and cancelling is not.
    const { internalNameOutcome } = await import("./page");
    expect(internalNameOutcome("", "kochkina")).toEqual({
      action: "clear",
      internalName: "",
    });
    expect(internalNameOutcome("   ", "kochkina")).toEqual({
      action: "clear",
      internalName: "",
    });
  });

  it("posts nothing when the draft ends up as what the key already had", async () => {
    // Cancel, and equally an editor opened only to read the note: neither may
    // write an audit event saying the note was changed.
    const { internalNameOutcome } = await import("./page");
    expect(internalNameOutcome("kochkina", "kochkina").action).toBe("none");
    expect(internalNameOutcome(" kochkina ", "kochkina").action).toBe("none");
    expect(internalNameOutcome("", null).action).toBe("none");
    expect(internalNameOutcome("", "").action).toBe("none");
  });

  it("caps the note at the column's own 80 characters", async () => {
    // varchar(80) in migration 0026 and `.max(80)` in the contract. A longer
    // note is refused by the API, so it must never leave the dialog.
    const { internalNameOutcome, INTERNAL_NAME_MAX } = await import("./page");
    expect(INTERNAL_NAME_MAX).toBe(80);
    const outcome = internalNameOutcome("x".repeat(120), null);
    expect(outcome.action).toBe("save");
    expect(outcome.internalName).toHaveLength(80);
  });
});

describe("Internal name dialog", () => {
  it("replaces the browser prompt with the panel's own dialog", () => {
    // The defect this fixes: a grey system box with no room to say who sees
    // the field. A later edit reaching for window.prompt again would look
    // harmless and lose the whole explanation.
    expect(source).toMatch(/<KeyInternalNameDialog\s/);
    expect(source).not.toContain("window.prompt(");
    expect(source).not.toContain("next.slice(0, 80)");
  });

  it("says what the field is for and that only administrators see it", () => {
    expect(source).toContain("users.internalNameDesc");
    expect(source).toContain("users.internalNamePrivateTitle");
    expect(source).toContain("users.internalNamePrivate");
  });

  it("shows which key is being annotated, by device label and node", () => {
    expect(source).toContain("users.internalNameFor");
    expect(source).toMatch(
      /<KeyInternalNameDialog[\s\S]{0,400}deviceLabel=\{[\s\S]{0,200}nodeName=\{nodeName\}/,
    );
  });

  it("shows the 80-character cap rather than truncating in silence", () => {
    expect(source).toContain("maxLength={INTERNAL_NAME_MAX}");
    expect(source).toContain("users.internalNameCapped");
    expect(source).toMatch(/\{draft\.length\} \/ \{INTERNAL_NAME_MAX\}/);
  });

  it("keeps save, clear and cancel as three separate answers", () => {
    // Cancel closes and posts nothing; Clear posts the empty string, which the
    // API stores as NULL; Save posts the draft. Routing all three through
    // internalNameOutcome is what keeps "cleared" from collapsing into
    // "unchanged".
    expect(source).toMatch(/onClick=\{\(\) => void submit\(""\)\}/);
    expect(source).toMatch(/onClick=\{\(\) => void submit\(draft\)\}/);
    expect(source).toMatch(
      /variant="outline" disabled=\{saving\} onClick=\{onClose\}/,
    );
    expect(source).toContain("users.internalNameClear");
    expect(source).toMatch(/if \(decided\.action === "none"\) \{/);
  });

  it("names the trigger on the key row instead of leaving a bare pencil", () => {
    expect(source).toMatch(/text=\{t\("users\.internalName"\)\}/);
    expect(source).toContain("users.internalNameEdit");
    expect(source).toContain("users.internalNameAdd");
  });

  it("gives a set note a frame on the row rather than a third muted line", () => {
    expect(source).not.toContain(
      'className="truncate text-xs italic text-muted-foreground/80"',
    );
    expect(source).toMatch(/<NotebookPen className="size-3 shrink-0/);
  });

  it("never offers the note to the key's owner", () => {
    // The rule that makes a real person's name safe in this field. The editor
    // lives on the admin Users page only; nothing here may start rendering it
    // from the employee-facing key list.
    for (const file of [
      "../../../components/employee/key-card.tsx",
      "../../../components/employee/employee-dashboard.tsx",
    ]) {
      const owner = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8",
      );
      expect(owner).not.toContain("internalName");
    }
  });

  it("carries every new key in both languages", async () => {
    const { messages } = await import("@/lib/i18n/messages");
    const keys = [
      "users.internalNameTitle",
      "users.internalNameDesc",
      "users.internalNamePrivateTitle",
      "users.internalNamePrivate",
      "users.internalNameFor",
      "users.internalNamePlaceholder",
      "users.internalNameHint",
      "users.internalNameCapped",
      "users.internalNameClear",
      "users.internalNameEdit",
      "users.internalNameAdd",
    ] as const;
    for (const key of keys) {
      expect(messages.ru[key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });
});
