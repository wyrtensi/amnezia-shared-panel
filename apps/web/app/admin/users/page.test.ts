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

describe("Internal name on the admin key row", () => {
  // The editor itself now lives in components/key-internal-name-dialog.tsx,
  // shared with an administrator's own key card; its own assertions moved with
  // it. What stays here is how this page uses it.
  it("opens the panel's own dialog rather than a browser prompt", () => {
    expect(source).toMatch(/<KeyInternalNameDialog\s/);
    expect(source).not.toContain("window.prompt(");
    expect(source).not.toContain("next.slice(0, 80)");
  });

  it("shows which key is being annotated, by device label and node", () => {
    expect(source).toMatch(
      /<KeyInternalNameDialog[\s\S]{0,400}deviceLabel=\{[\s\S]{0,200}nodeName=\{nodeName\}/,
    );
  });

  it("names the trigger on the key row instead of leaving a bare pencil", () => {
    expect(source).toMatch(/text=\{t\("users\.internalName"\)\}/);
    expect(source).toContain("users.internalNameEdit");
    expect(source).toContain("users.internalNameAdd");
  });

  it("gives a set note the shared frame rather than a third muted line", () => {
    // The same chip an administrator sees on their own key card. Two copies of
    // this markup would drift, and a muted italic subtitle is what the row
    // moved away from and must not drift back to.
    expect(source).not.toContain(
      'className="truncate text-xs italic text-muted-foreground/80"',
    );
    expect(source).toMatch(/<InternalNameChip>\{keyView\.internalName\}/);
  });

  it("carries every internal-name key in both languages", async () => {
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
      "users.internalNameFailed",
    ] as const;
    for (const key of keys) {
      expect(messages.ru[key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });
});

/**
 * The rule that makes it safe to write a real person's name in a key's
 * internal name.
 *
 * It used to read "never to the owner", and it was pinned by asserting that
 * the two owner-facing components never mention `internalName` at all. That
 * assertion is now wrong in the letter — an administrator does see the note on
 * their OWN key, in the ordinary panel, which is the point of having admin
 * rights — and it was never quite the invariant anyway: a component that
 * mentions the field is not by itself a leak, and one that does not mention it
 * is not by itself a guarantee.
 *
 * The invariant is that a NON-ADMIN never receives the field, and it is
 * enforced where it can actually be enforced — on the server.
 * `apps/control-api/src/keyView.ts` builds the owner-facing payload and leaves
 * `internalName` off it unless the caller is an administrator who owns the
 * key; `apps/control-api/src/keyView.test.ts` asserts on the SERIALIZED
 * response that a regular user's payload carries no such property, which is
 * the test that matters. What is pinned below is the half that lives in this
 * app: nothing owner-facing renders the note outside an administrator's own
 * view, and nothing owner-facing reintroduces it by a route the server gate
 * does not cover.
 */
describe("A regular user never sees a key's internal name", () => {
  const ownerFacing = (file: string): string =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  it("renders it on the key card only behind the caller's admin role", () => {
    const card = ownerFacing("../../../components/employee/key-card.tsx");
    // Every use of the note on the card hangs off this one flag, and the flag
    // reads the role the server sent. Rendering `keyView.internalName` outside
    // it — in a tooltip, a title attribute, a filter — would put an operator's
    // note about a person on that person's own screen.
    expect(card).toContain('const isAdmin = me.role === "admin";');
    expect(card).toMatch(/\{isAdmin \? \([\s\S]{0,1600}InternalNameChip/);
    for (const match of card.matchAll(/keyView\.internalName/g)) {
      const gatesBefore = (
        card.slice(0, match.index).match(/\{isAdmin (\?|&&)/g) ?? []
      ).length;
      expect(
        gatesBefore,
        `keyView.internalName at index ${match.index} is not behind the admin gate`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the note out of the owner-facing dashboard's own rendering", () => {
    // The dashboard hands the card a WRITER — the admin endpoint, which
    // answers 403 to anyone else — and renders the note nowhere itself.
    const dashboard = ownerFacing(
      "../../../components/employee/employee-dashboard.tsx",
    );
    expect(dashboard).toContain("set-internal-name");
    expect(dashboard).not.toMatch(/key\.internalName|keyView\.internalName/);
  });

  it("does not carry the note into a config download", () => {
    // A config file is a thing people forward. The download dialog composes a
    // name from the device label and the node and must not reach for the note;
    // control-api's `findKeyConfig` does not select the column at all (pinned
    // in postgresRepository.integration.test.ts).
    const config = ownerFacing(
      "../../../components/employee/config-download-dialog.tsx",
    );
    expect(config).not.toContain("internalName");
  });

  it("states the narrowed rule in both languages", async () => {
    // The callout in the editor is where an operator decides whether a real
    // name is safe to type. It has to say that a regular user gets nothing —
    // not the older absolute "the owner never sees this", which is no longer
    // true and would be read as a promise the panel does not keep.
    const { messages } = await import("@/lib/i18n/messages");
    expect(messages.ru["users.internalNamePrivate"]).toContain(
      "Обычный пользователь",
    );
    expect(messages.en["users.internalNamePrivate"]).toContain(
      "A regular user never receives this",
    );
    expect(messages.en["users.internalNamePrivate"]).not.toContain(
      "The key's owner is never shown this",
    );
  });
});

