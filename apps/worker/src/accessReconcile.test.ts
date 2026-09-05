import { describe, expect, it, vi } from "vitest";
import {
  createAccessReconciler,
  createAccessSync,
  createAccessWriteback,
  createAllowlistDirectory,
  createCloudflareDirectory,
} from "./accessReconcile.js";
import type { CfAccessRule } from "./cloudflareApi.js";

const CF_CONFIG = {
  accountId: "acc",
  appId: "app",
  policyId: "pol",
  apiToken: "tok",
};

describe("createAllowlistDirectory", () => {
  it("parses and normalises a mixed-separator allowlist", async () => {
    const directory = createAllowlistDirectory(
      "  Alice@Example.com, bob@example.com;carol@example.com \n dave@example.com",
    );
    await expect(directory.getAllowedEmails()).resolves.toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "dave@example.com",
    ]);
  });

  it("yields an empty list for blank input", async () => {
    await expect(
      createAllowlistDirectory("   ").getAllowedEmails(),
    ).resolves.toEqual([]);
  });
});

describe("createCloudflareDirectory", () => {
  it("rejects when credentials are missing", async () => {
    await expect(
      createCloudflareDirectory({}).getAllowedEmails(),
    ).rejects.toThrow(/not configured/i);
  });
});

describe("createAccessReconciler", () => {
  it("does not touch accounts when the directory is empty (safety guard)", async () => {
    const reconcileAccess = vi.fn(() =>
      Promise.resolve({ deactivated: [], skippedAdmins: [] }),
    );
    const reconcile = createAccessReconciler({
      repository: { reconcileAccess },
      directory: createAllowlistDirectory(""),
    });

    await reconcile();

    expect(reconcileAccess).not.toHaveBeenCalled();
  });

  it("reconciles panel accounts against a non-empty allowlist", async () => {
    const reconcileAccess = vi.fn(() =>
      Promise.resolve({ deactivated: ["gone@example.com"], skippedAdmins: [] }),
    );
    const logs: string[] = [];
    const reconcile = createAccessReconciler({
      repository: { reconcileAccess },
      directory: createAllowlistDirectory("keep@example.com"),
      log: (message) => logs.push(message),
    });

    await reconcile();

    expect(reconcileAccess).toHaveBeenCalledWith(["keep@example.com"]);
    expect(logs.join("\n")).toMatch(/disabled 1 account/);
  });

  it("propagates directory failures instead of deactivating", async () => {
    const reconcileAccess = vi.fn(() =>
      Promise.resolve({ deactivated: [], skippedAdmins: [] }),
    );
    const reconcile = createAccessReconciler({
      repository: { reconcileAccess },
      directory: createCloudflareDirectory({}),
    });

    await expect(reconcile()).rejects.toThrow(/not configured/i);
    expect(reconcileAccess).not.toHaveBeenCalled();
  });
});

describe("createAccessWriteback", () => {
  it("skips when Cloudflare is not configured", async () => {
    const updatePolicy = vi.fn(() => Promise.resolve());
    const writeback = createAccessWriteback({
      repository: {
        getCloudflareConfig: () => Promise.resolve(null),
        listActiveUserEmails: () => Promise.resolve(["a@x.io"]),
      },
      createClient: () => ({
        getPolicy: () => Promise.resolve({ id: "pol", include: [] }),
        updatePolicy,
      }),
    });
    await writeback();
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  it("never wipes the allowlist when the panel has no active users", async () => {
    const updatePolicy = vi.fn(() => Promise.resolve());
    const writeback = createAccessWriteback({
      repository: {
        getCloudflareConfig: () => Promise.resolve(CF_CONFIG),
        listActiveUserEmails: () => Promise.resolve([]),
      },
      createClient: () => ({
        getPolicy: () => Promise.resolve({ id: "pol", include: [] }),
        updatePolicy,
      }),
    });
    await writeback();
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  it("replaces email rules with active users but preserves other rules", async () => {
    const updatePolicy = vi.fn(() => Promise.resolve());
    const existing: CfAccessRule[] = [
      { email_domain: { domain: "company.tld" } },
      { email: { email: "gone@x.io" } },
    ];
    const writeback = createAccessWriteback({
      repository: {
        getCloudflareConfig: () => Promise.resolve(CF_CONFIG),
        listActiveUserEmails: () => Promise.resolve(["Keep@X.io", "new@x.io"]),
      },
      createClient: () => ({
        getPolicy: () =>
          Promise.resolve({
            id: "pol",
            name: "p",
            decision: "allow",
            include: existing,
            exclude: [{ email: { email: "block@x.io" } }],
            require: [],
          }),
        updatePolicy,
      }),
    });
    await writeback();
    // Full policy sent back (name/decision/exclude preserved), email rules replaced.
    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      name: "p",
      decision: "allow",
      include: [
        { email_domain: { domain: "company.tld" } },
        { email: { email: "keep@x.io" } },
        { email: { email: "new@x.io" } },
      ],
      exclude: [{ email: { email: "block@x.io" } }],
      require: [],
    });
  });

  it("never removes a bootstrap-admin email from the allowlist", async () => {
    const updatePolicy = vi.fn(() => Promise.resolve());
    const writeback = createAccessWriteback({
      repository: {
        getCloudflareConfig: () => Promise.resolve(CF_CONFIG),
        listActiveUserEmails: () => Promise.resolve(["user@x.io"]),
      },
      bootstrapAdminEmails: ["Admin@X.io"],
      createClient: () => ({
        getPolicy: () =>
          Promise.resolve({ id: "pol", include: [{ email: { email: "user@x.io" } }] }),
        updatePolicy,
      }),
    });
    await writeback();
    // Bootstrap admin (lower-cased) is unioned in after the active users and
    // never dropped, even though it was absent from the current allowlist.
    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [
        { email: { email: "user@x.io" } },
        { email: { email: "admin@x.io" } },
      ],
    });
  });

  it("is a no-op when the email set already matches", async () => {
    const updatePolicy = vi.fn(() => Promise.resolve());
    const writeback = createAccessWriteback({
      repository: {
        getCloudflareConfig: () => Promise.resolve(CF_CONFIG),
        listActiveUserEmails: () => Promise.resolve(["a@x.io"]),
      },
      createClient: () => ({
        getPolicy: () =>
          Promise.resolve({ id: "pol", include: [{ email: { email: "a@x.io" } }] }),
        updatePolicy,
      }),
    });
    await writeback();
    expect(updatePolicy).not.toHaveBeenCalled();
  });
});

describe("createAccessSync", () => {
  // A mock two-way-sync repository. `active` is mutable so deactivateByEmail can
  // drop disabled users, letting the write-back step re-read the reduced set.
  const makeRepo = (init: {
    config?: typeof CF_CONFIG | null;
    active: string[];
    baseline: string[];
  }) => {
    const active = new Set(init.active.map((email) => email.toLowerCase()));
    let baseline = [...init.baseline];
    const setAccessSyncBaseline = vi.fn((emails: string[]) => {
      baseline = [...emails];
      return Promise.resolve();
    });
    const deactivateByEmail = vi.fn((emails: string[]) => {
      const deactivated: string[] = [];
      for (const email of emails.map((value) => value.toLowerCase())) {
        if (active.has(email)) {
          active.delete(email);
          deactivated.push(email);
        }
      }
      return Promise.resolve({ deactivated, skippedAdmins: [] });
    });
    const repository = {
      getCloudflareConfig: () =>
        Promise.resolve(init.config === undefined ? CF_CONFIG : init.config),
      listActiveUserEmails: () => Promise.resolve([...active]),
      getAccessSyncBaseline: () => Promise.resolve(baseline),
      setAccessSyncBaseline,
      deactivateByEmail,
    };
    return {
      repository,
      deactivateByEmail,
      setAccessSyncBaseline,
      getBaseline: () => baseline,
    };
  };

  const clientWith = (include: CfAccessRule[], updatePolicy = vi.fn(() => Promise.resolve())) => ({
    updatePolicy,
    createClient: () => ({
      getPolicy: () => Promise.resolve({ id: "pol", include }),
      updatePolicy,
    }),
  });

  it("skips when Cloudflare is not configured", async () => {
    const { repository, deactivateByEmail } = makeRepo({
      config: null,
      active: ["a@x.io"],
      baseline: [],
    });
    const { createClient, updatePolicy } = clientWith([]);
    await createAccessSync({ repository, createClient })();
    expect(updatePolicy).not.toHaveBeenCalled();
    expect(deactivateByEmail).not.toHaveBeenCalled();
  });

  it("first run pushes active users to Cloudflare and records the baseline", async () => {
    const { repository, deactivateByEmail, getBaseline } = makeRepo({
      active: ["Keep@X.io"],
      baseline: [],
    });
    const { createClient, updatePolicy } = clientWith([]);
    await createAccessSync({ repository, createClient })();
    expect(deactivateByEmail).not.toHaveBeenCalled();
    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [{ email: { email: "keep@x.io" } }],
    });
    expect(getBaseline()).toEqual(["keep@x.io"]);
  });

  it("first run against an already-populated policy adopts nothing pre-existing", async () => {
    // The production day-one scenario: the baseline column starts empty, but
    // the Cloudflare policy already carries hand-added addresses (rail 1's
    // headline claim is that this exact case is safe). An empty baseline must
    // not be read as "the panel owns everything already there" — both
    // hand-added rules stay foreign, preserved verbatim, and only the active
    // panel user is appended.
    const { repository, getBaseline } = makeRepo({
      active: ["new@x.io"],
      baseline: [],
    });
    const { createClient, updatePolicy } = clientWith([
      { email: { email: "hand-added-1@gmail.com" } },
      { email: { email: "hand-added-2@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [
        { email: { email: "hand-added-1@gmail.com" } },
        { email: { email: "hand-added-2@gmail.com" } },
        { email: { email: "new@x.io" } },
      ],
    });
    // The baseline records only what the panel itself pushed, not the
    // pre-existing hand-added rules.
    expect(getBaseline()).toEqual(["new@x.io"]);
  });

  it("protects a panel-added user (not yet in Cloudflare) from being disabled", async () => {
    const { repository, deactivateByEmail } = makeRepo({
      active: ["keep@x.io", "new@x.io"],
      baseline: ["keep@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([{ email: { email: "keep@x.io" } }]);
    await createAccessSync({ repository, createClient })();
    // "new@x.io" is absent from CF but also absent from the baseline → a panel
    // add, not a CF removal: it must be pushed, never disabled.
    expect(deactivateByEmail).not.toHaveBeenCalled();
    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [{ email: { email: "keep@x.io" } }, { email: { email: "new@x.io" } }],
    });
  });

  it("disables a user removed from Cloudflare and drops them from the allowlist", async () => {
    const { repository, deactivateByEmail, getBaseline } = makeRepo({
      active: ["keep@x.io", "gone@x.io"],
      baseline: ["keep@x.io", "gone@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([{ email: { email: "keep@x.io" } }]);
    await createAccessSync({ repository, createClient })();
    // "gone@x.io" was synced before (baseline) and is now absent from CF → disable.
    expect(deactivateByEmail).toHaveBeenCalledWith(["gone@x.io"]);
    // CF already reflects [keep] after the disable, so no write-back needed.
    expect(updatePolicy).not.toHaveBeenCalled();
    expect(getBaseline()).toEqual(["keep@x.io"]);
  });

  it("never disables a pinned bootstrap admin removed from Cloudflare", async () => {
    const { repository, deactivateByEmail } = makeRepo({
      active: ["admin@x.io", "user@x.io"],
      baseline: ["admin@x.io", "user@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([{ email: { email: "user@x.io" } }]);
    await createAccessSync({
      repository,
      bootstrapAdminEmails: ["Admin@X.io"],
      createClient,
    })();
    expect(deactivateByEmail).not.toHaveBeenCalled();
    // The admin is re-added to the Cloudflare policy instead of being removed.
    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [{ email: { email: "admin@x.io" } }, { email: { email: "user@x.io" } }],
    });
  });

  it("does not disable users when the policy grants access via a non-email rule only", async () => {
    // The include has an email_domain rule but ZERO email rules → cfEmails is
    // empty. Treating that as "everyone was removed" would disable every user.
    const { repository, deactivateByEmail } = makeRepo({
      active: ["a@x.io"],
      baseline: ["a@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([
      { email_domain: { domain: "x.io" } },
    ]);
    await createAccessSync({ repository, createClient })();
    expect(deactivateByEmail).not.toHaveBeenCalled();
    // Panel users are still written back on top of the preserved domain rule.
    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [
        { email_domain: { domain: "x.io" } },
        { email: { email: "a@x.io" } },
      ],
    });
  });

  it("never wipes the allowlist when there are no active users", async () => {
    const { repository, setAccessSyncBaseline } = makeRepo({
      active: [],
      baseline: ["a@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([{ email: { email: "a@x.io" } }]);
    await createAccessSync({ repository, createClient })();
    expect(updatePolicy).not.toHaveBeenCalled();
    // Baseline is left intact so the next run does not treat "empty" as removals.
    expect(setAccessSyncBaseline).not.toHaveBeenCalled();
  });

  it("leaves an email rule the panel never added untouched", async () => {
    const { repository, getBaseline } = makeRepo({
      active: ["keep@x.io"],
      baseline: ["keep@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([
      { email: { email: "keep@x.io" } },
      { email: { email: "outsider@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    // The policy already holds exactly what it should: the panel's own email plus
    // a foreign one it must not touch. Nothing to write.
    expect(updatePolicy).not.toHaveBeenCalled();
    expect(getBaseline()).toEqual(["keep@x.io"]);
  });

  it("drops its own stale email while keeping a foreign one", async () => {
    const { repository } = makeRepo({
      active: ["keep@x.io"],
      baseline: ["keep@x.io", "gone@x.io"],
    });
    const { createClient, updatePolicy } = clientWith([
      { email: { email: "keep@x.io" } },
      { email: { email: "gone@x.io" } },
      { email: { email: "outsider@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [
        { email: { email: "outsider@gmail.com" } },
        { email: { email: "keep@x.io" } },
      ],
    });
  });

  it("keeps an unmodeled field on a foreign rule intact through the write-back", async () => {
    // The docs promise "keeping any fields this client does not model" for a
    // foreign rule. `foreignRule` is spliced back into `include` by reference
    // (not rebuilt from `desired`), so any field beyond `email` survives.
    const { repository } = makeRepo({
      active: ["keep@x.io"],
      baseline: ["keep@x.io", "gone@x.io"],
    });
    const foreignRule = {
      email: { email: "outsider@gmail.com" },
      approval_group: { id: "grp_123" },
    };
    const { createClient, updatePolicy } = clientWith([
      { email: { email: "keep@x.io" } },
      { email: { email: "gone@x.io" } },
      foreignRule,
    ]);

    await createAccessSync({ repository, createClient })();

    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [foreignRule, { email: { email: "keep@x.io" } }],
    });
  });

  it("claims a hand-added address that becomes an active panel user, dropping its extra fields", async () => {
    // The documented ownership-transfer behaviour: once a hand-added address is
    // also an active panel user, the panel claims the rule — it is dropped from
    // the foreign set, re-emitted as a bare {email:{email}} rule (any fields
    // this client does not model are lost), and the baseline records it as the
    // panel's own from then on. A second active user forces an actual
    // write-back here so the claim is visible in the emitted `include`, not
    // just inferred from the baseline.
    const { repository, getBaseline } = makeRepo({
      active: ["hand-added@company.tld", "new@x.io"],
      baseline: [],
    });
    const { createClient, updatePolicy } = clientWith([
      {
        email: { email: "hand-added@company.tld" },
        approval_group: { id: "grp_123" },
      },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [
        { email: { email: "hand-added@company.tld" } },
        { email: { email: "new@x.io" } },
      ],
    });
    expect(getBaseline()).toEqual(["hand-added@company.tld", "new@x.io"]);
  });

  it("does not disable a user still admitted by a surviving email_domain rule", async () => {
    const { repository, deactivateByEmail } = makeRepo({
      active: ["ivan@company.tld"],
      baseline: ["ivan@company.tld"],
    });
    // An admin removed the "redundant" corporate addresses, trusting the domain
    // rule to cover them. Gmail rules remain, so the empty-include guard is silent.
    const { createClient } = clientWith([
      { email_domain: { domain: "company.tld" } },
      { email: { email: "outside@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(deactivateByEmail).not.toHaveBeenCalled();
  });

  it("still disables a user no domain rule covers", async () => {
    const { repository, deactivateByEmail } = makeRepo({
      active: ["ivan@other.tld"],
      baseline: ["ivan@other.tld"],
    });
    const { createClient } = clientWith([
      { email_domain: { domain: "company.tld" } },
      { email: { email: "outside@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(deactivateByEmail).toHaveBeenCalledWith(["ivan@other.tld"]);
  });

  it("accepts the domain rule in '@company.tld' form, case-insensitively", async () => {
    // The Cloudflare dashboard shows "emails ending in @company.tld" and an
    // operator pasting that form (with the leading "@", any casing) must work
    // exactly like the bare-domain form Cloudflare stores internally.
    const { repository, deactivateByEmail } = makeRepo({
      active: ["ivan@Company.TLD"],
      baseline: ["ivan@company.tld"],
    });
    const { createClient } = clientWith([
      { email_domain: { domain: "@Company.TLD" } },
      { email: { email: "outside@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(deactivateByEmail).not.toHaveBeenCalled();
  });

  it("logs when an email_domain rule is present but no usable domain was parsed", async () => {
    const { repository } = makeRepo({
      active: ["ivan@company.tld"],
      baseline: ["ivan@company.tld"],
    });
    const logs: string[] = [];
    // The rule carries the "email_domain" key but no usable `domain` value —
    // the guard that is supposed to protect ivan@company.tld parses nothing
    // from it, so it must say so instead of failing silently.
    const { createClient } = clientWith([
      { email_domain: { domain: "" } },
      { email: { email: "outside@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient, log: (m) => logs.push(m) })();

    expect(logs.join("\n")).toMatch(/email_domain rule.*no usable domain/i);
  });

  it("still disables a person named in an exclude email rule despite a covering domain rule", async () => {
    // An operator removed ivan's explicit address AND excluded him by name —
    // the idiomatic Cloudflare way to carve one person out of a domain rule.
    // He is blocked at the edge; the old code (pre-branch) would have disabled
    // him. Rail 2 must not spare him just because the domain rule admits him.
    const { repository, deactivateByEmail } = makeRepo({
      active: ["ivan@company.tld"],
      baseline: ["ivan@company.tld"],
    });
    const policyWithExclude = {
      id: "pol",
      include: [
        { email_domain: { domain: "company.tld" } },
        { email: { email: "outside@gmail.com" } },
      ],
      exclude: [{ email: { email: "ivan@company.tld" } }],
    };
    const createClient = () => ({
      getPolicy: () => Promise.resolve(policyWithExclude),
      updatePolicy: vi.fn(() => Promise.resolve()),
    });

    await createAccessSync({ repository, createClient })();

    expect(deactivateByEmail).toHaveBeenCalledWith(["ivan@company.tld"]);
  });

  it("still disables a person whose domain is named in an exclude email_domain rule", async () => {
    // Cloudflare's "emails ending in" rule is an exact match on the domain
    // (not a subdomain suffix), so the only way `exclude` carves out a domain
    // is by naming that same exact domain — e.g. an operator overriding a
    // broad domain rule while allowlisting individual addresses within it
    // elsewhere. This exercises the `excludedDomains` path, not just
    // `excludedEmails` (covered by the test above).
    const { repository, deactivateByEmail } = makeRepo({
      active: ["ivan@company.tld"],
      baseline: ["ivan@company.tld"],
    });
    const policyWithExclude = {
      id: "pol",
      include: [
        { email_domain: { domain: "company.tld" } },
        { email: { email: "outside@gmail.com" } },
      ],
      exclude: [{ email_domain: { domain: "company.tld" } }],
    };
    const createClient = () => ({
      getPolicy: () => Promise.resolve(policyWithExclude),
      updatePolicy: vi.fn(() => Promise.resolve()),
    });

    await createAccessSync({ repository, createClient })();

    expect(deactivateByEmail).toHaveBeenCalledWith(["ivan@company.tld"]);
  });

  it("still spares a person the exclude rules do not name", async () => {
    // Pins the positive case alongside the two negative ones above: an exclude
    // list that does not mention this person at all must not affect coverage.
    const { repository, deactivateByEmail } = makeRepo({
      active: ["ivan@company.tld"],
      baseline: ["ivan@company.tld"],
    });
    const policyWithExclude = {
      id: "pol",
      include: [
        { email_domain: { domain: "company.tld" } },
        { email: { email: "outside@gmail.com" } },
      ],
      exclude: [{ email: { email: "someone-else@company.tld" } }],
    };
    const createClient = () => ({
      getPolicy: () => Promise.resolve(policyWithExclude),
      updatePolicy: vi.fn(() => Promise.resolve()),
    });

    await createAccessSync({ repository, createClient })();

    expect(deactivateByEmail).not.toHaveBeenCalled();
  });

  it("re-adds a domain-covered, spared user's address in the same run's write-back", async () => {
    // The documented "does not stick" behaviour: rail 2 stops the disable, but
    // the very same run's write-back still reasserts the panel's desired set —
    // including the address the operator just removed, because coverage by a
    // domain rule is not (yet) a reason to leave an active user's email out of
    // the panel's own PUT.
    const { repository } = makeRepo({
      active: ["ivan@company.tld"],
      baseline: ["ivan@company.tld"],
    });
    const { createClient, updatePolicy } = clientWith([
      { email_domain: { domain: "company.tld" } },
      { email: { email: "outside@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient })();

    expect(updatePolicy).toHaveBeenCalledWith({
      id: "pol",
      include: [
        { email_domain: { domain: "company.tld" } },
        { email: { email: "outside@gmail.com" } },
        { email: { email: "ivan@company.tld" } },
      ],
    });
  });

  it("aborts the run instead of disabling more accounts than the cap allows", async () => {
    const active = ["a@x.io", "b@x.io", "c@x.io"];
    const { repository, deactivateByEmail, setAccessSyncBaseline } = makeRepo({
      active,
      baseline: active,
    });
    const { createClient, updatePolicy } = clientWith([
      { email: { email: "outside@gmail.com" } },
    ]);
    const recordAccessSyncAborted = vi.fn(() => Promise.resolve());

    await createAccessSync({
      repository,
      createClient,
      maxDisablesPerRun: 2,
      recordAccessSyncAborted,
    })();

    expect(deactivateByEmail).not.toHaveBeenCalled();
    expect(updatePolicy).not.toHaveBeenCalled();
    expect(setAccessSyncBaseline).not.toHaveBeenCalled();
    expect(recordAccessSyncAborted).toHaveBeenCalledWith({
      candidates: active,
      limit: 2,
      activeCount: 3,
      overAbsoluteCap: true,
      overMajority: true,
    });
  });

  it("disables normally when the count is within the cap", async () => {
    // 2 removals out of a 5-person panel: within the absolute cap (2) and
    // comfortably under half the active users, so this pins the absolute-cap
    // boundary without also being an (unintended) majority removal — see the
    // majority-cap tests below for that case.
    const { repository, deactivateByEmail } = makeRepo({
      active: ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io"],
      baseline: ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io"],
    });
    const { createClient } = clientWith([
      { email: { email: "c@x.io" } },
      { email: { email: "d@x.io" } },
      { email: { email: "e@x.io" } },
      { email: { email: "outside@gmail.com" } },
    ]);

    await createAccessSync({ repository, createClient, maxDisablesPerRun: 2 })();

    expect(deactivateByEmail).toHaveBeenCalledWith(["a@x.io", "b@x.io"]);
  });

  it("applies no cap when maxDisablesPerRun is zero", async () => {
    const active = ["a@x.io", "b@x.io", "c@x.io"];
    const { repository, deactivateByEmail } = makeRepo({ active, baseline: active });
    const { createClient } = clientWith([{ email: { email: "outside@gmail.com" } }]);

    await createAccessSync({ repository, createClient, maxDisablesPerRun: 0 })();

    expect(deactivateByEmail).toHaveBeenCalledWith(active);
  });

  it("aborts a majority removal on a small panel even though it is under the absolute cap", async () => {
    // The motivating scenario: on a 5-user panel, removing all 5 is 5 <= 10 —
    // the absolute cap alone trips nothing. The majority guard must catch it.
    const active = ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io"];
    const { repository, deactivateByEmail } = makeRepo({ active, baseline: active });
    const { createClient, updatePolicy } = clientWith([
      { email: { email: "outside@gmail.com" } },
    ]);
    const recordAccessSyncAborted = vi.fn(() => Promise.resolve());

    await createAccessSync({ repository, createClient, recordAccessSyncAborted })();

    expect(deactivateByEmail).not.toHaveBeenCalled();
    expect(updatePolicy).not.toHaveBeenCalled();
    expect(recordAccessSyncAborted).toHaveBeenCalledWith({
      candidates: active,
      limit: 10,
      activeCount: 5,
      overAbsoluteCap: false,
      overMajority: true,
    });
  });

  it("still fires the absolute cap first on a large panel where the removal is not a majority", async () => {
    // 11 removals out of 100 users: over the default absolute cap (10) but
    // nowhere near half the panel (50) — the absolute half of the condition
    // must still fire on its own.
    const active = Array.from({ length: 100 }, (_, i) => `user${i}@x.io`);
    const removed = active.slice(0, 11);
    const remaining = active.slice(11);
    const { repository, deactivateByEmail } = makeRepo({ active, baseline: active });
    const { createClient } = clientWith([
      ...remaining.map((email) => ({ email: { email } })),
      { email: { email: "outside@gmail.com" } },
    ]);
    const recordAccessSyncAborted = vi.fn(() => Promise.resolve());

    await createAccessSync({ repository, createClient, recordAccessSyncAborted })();

    expect(deactivateByEmail).not.toHaveBeenCalled();
    expect(recordAccessSyncAborted).toHaveBeenCalledWith({
      candidates: removed,
      limit: 10,
      activeCount: 100,
      overAbsoluteCap: true,
      overMajority: false,
    });
  });

  it("with the cap set to 0, disables even a full-panel majority removal", async () => {
    // 0 is the documented escape hatch and must disable BOTH the absolute and
    // the majority condition — not just the absolute one.
    const active = ["a@x.io", "b@x.io"]; // removing both is 100% of the panel
    const { repository, deactivateByEmail } = makeRepo({ active, baseline: active });
    const { createClient } = clientWith([{ email: { email: "outside@gmail.com" } }]);

    await createAccessSync({ repository, createClient, maxDisablesPerRun: 0 })();

    expect(deactivateByEmail).toHaveBeenCalledWith(active);
  });

  describe("abort audit de-duplication", () => {
    // A client whose policy `include` can be swapped between calls to
    // `sync()`, so a single `createAccessSync` instance (and its closure
    // state) can be run repeatedly across a changing Cloudflare-side anomaly.
    const makeMutableClient = (initialInclude: CfAccessRule[]) => {
      let include = initialInclude;
      const updatePolicy = vi.fn(() => Promise.resolve());
      const createClient = () => ({
        getPolicy: () => Promise.resolve({ id: "pol", include }),
        updatePolicy,
      });
      return {
        createClient,
        updatePolicy,
        setInclude: (next: CfAccessRule[]) => {
          include = next;
        },
      };
    };

    it("writes only one audit row for repeated identical aborts", async () => {
      const active = ["a@x.io", "b@x.io", "c@x.io"];
      const { repository } = makeRepo({ active, baseline: active });
      const { createClient } = makeMutableClient([
        { email: { email: "outside@gmail.com" } },
      ]);
      const recordAccessSyncAborted = vi.fn(() => Promise.resolve());
      const sync = createAccessSync({
        repository,
        createClient,
        maxDisablesPerRun: 2,
        recordAccessSyncAborted,
      });

      await sync();
      await sync();
      await sync();

      expect(recordAccessSyncAborted).toHaveBeenCalledTimes(1);
      expect(recordAccessSyncAborted).toHaveBeenCalledWith({
        candidates: active,
        limit: 2,
        activeCount: 3,
        overAbsoluteCap: true,
        overMajority: true,
      });
    });

    it("writes another audit row when the candidate set changes", async () => {
      const active = ["a@x.io", "b@x.io", "c@x.io", "d@x.io"];
      const { repository } = makeRepo({ active, baseline: active });
      const { createClient, setInclude } = makeMutableClient([
        { email: { email: "outside@gmail.com" } },
      ]);
      const recordAccessSyncAborted = vi.fn(() => Promise.resolve());
      const sync = createAccessSync({
        repository,
        createClient,
        maxDisablesPerRun: 2,
        recordAccessSyncAborted,
      });

      await sync();
      // "a@x.io" is now covered by Cloudflare too, shrinking the candidate set
      // from 4 accounts to 3 — still over the cap, so the run aborts again,
      // but for a different set of accounts.
      setInclude([
        { email: { email: "outside@gmail.com" } },
        { email: { email: "a@x.io" } },
      ]);
      await sync();

      expect(recordAccessSyncAborted).toHaveBeenCalledTimes(2);
      expect(recordAccessSyncAborted).toHaveBeenNthCalledWith(1, {
        candidates: active,
        limit: 2,
        activeCount: 4,
        overAbsoluteCap: true,
        overMajority: true,
      });
      expect(recordAccessSyncAborted).toHaveBeenNthCalledWith(2, {
        candidates: ["b@x.io", "c@x.io", "d@x.io"],
        limit: 2,
        activeCount: 4,
        overAbsoluteCap: true,
        overMajority: true,
      });
    });

    it("writes an audit row again after a clean run recovers, even with the same candidates", async () => {
      const active = ["a@x.io", "b@x.io", "c@x.io"];
      const { repository } = makeRepo({ active, baseline: active });
      const badInclude: CfAccessRule[] = [{ email: { email: "outside@gmail.com" } }];
      const cleanInclude: CfAccessRule[] = [
        { email: { email: "outside@gmail.com" } },
        { email: { email: "a@x.io" } },
        { email: { email: "b@x.io" } },
        { email: { email: "c@x.io" } },
      ];
      const { createClient, setInclude } = makeMutableClient(badInclude);
      const recordAccessSyncAborted = vi.fn(() => Promise.resolve());
      const sync = createAccessSync({
        repository,
        createClient,
        maxDisablesPerRun: 2,
        recordAccessSyncAborted,
      });

      await sync(); // aborts: 3 candidates over the cap of 2
      setInclude(cleanInclude);
      await sync(); // clean run: Cloudflare now covers every candidate, nothing to disable
      setInclude(badInclude);
      await sync(); // the exact same anomaly recurs

      expect(recordAccessSyncAborted).toHaveBeenCalledTimes(2);
      expect(recordAccessSyncAborted).toHaveBeenNthCalledWith(1, {
        candidates: active,
        limit: 2,
        activeCount: 3,
        overAbsoluteCap: true,
        overMajority: true,
      });
      expect(recordAccessSyncAborted).toHaveBeenNthCalledWith(2, {
        candidates: active,
        limit: 2,
        activeCount: 3,
        overAbsoluteCap: true,
        overMajority: true,
      });
    });

    it("distinguishes a proportional abort from an absolute one in what it records", async () => {
      // Same candidate count (11) on two panels of very different sizes: on the
      // 100-user panel only the absolute cap fires, on the 15-user panel only
      // the majority guard does. The recorded metadata must say which.
      const activeLarge = Array.from({ length: 100 }, (_, i) => `user${i}@x.io`);
      const removedLarge = activeLarge.slice(0, 11);
      const remainingLarge = activeLarge.slice(11);
      const { repository: repoLarge } = makeRepo({
        active: activeLarge,
        baseline: activeLarge,
      });
      const { createClient: clientLarge } = clientWith([
        ...remainingLarge.map((email) => ({ email: { email } })),
        { email: { email: "outside@gmail.com" } },
      ]);
      const recordAbsolute = vi.fn(() => Promise.resolve());
      await createAccessSync({
        repository: repoLarge,
        createClient: clientLarge,
        recordAccessSyncAborted: recordAbsolute,
      })();
      expect(recordAbsolute).toHaveBeenCalledWith({
        candidates: removedLarge,
        limit: 10,
        activeCount: 100,
        overAbsoluteCap: true,
        overMajority: false,
      });

      const activeSmall = Array.from({ length: 15 }, (_, i) => `person${i}@x.io`);
      const removedSmall = activeSmall.slice(0, 11);
      const remainingSmall = activeSmall.slice(11);
      const { repository: repoSmall } = makeRepo({
        active: activeSmall,
        baseline: activeSmall,
      });
      const { createClient: clientSmall } = clientWith([
        ...remainingSmall.map((email) => ({ email: { email } })),
        { email: { email: "outside@gmail.com" } },
      ]);
      const recordProportional = vi.fn(() => Promise.resolve());
      await createAccessSync({
        repository: repoSmall,
        createClient: clientSmall,
        maxDisablesPerRun: 20,
        recordAccessSyncAborted: recordProportional,
      })();
      expect(recordProportional).toHaveBeenCalledWith({
        candidates: removedSmall,
        limit: 20,
        activeCount: 15,
        overAbsoluteCap: false,
        overMajority: true,
      });
    });
  });

  it("reports skipped when Cloudflare is not configured", async () => {
    const { repository } = makeRepo({ config: null, active: ["a@x.io"], baseline: [] });
    const { createClient } = clientWith([]);
    await expect(createAccessSync({ repository, createClient })()).resolves.toMatchObject({
      outcome: "skipped",
    });
  });

  it("reports skipped with its own detail when there are no active users to write back", async () => {
    // Same `outcome` string as the "not configured" case above, but the
    // processor must tell them apart: here the disable half has already run,
    // so "run cf-config" would be the wrong remedy.
    const { repository } = makeRepo({ active: [], baseline: ["a@x.io"] });
    const { createClient } = clientWith([{ email: { email: "a@x.io" } }]);
    const result = await createAccessSync({ repository, createClient })();
    expect(result.outcome).toBe("skipped");
    expect(result.detail).toMatch(/no active/i);
  });

  it("reports synced when it wrote the policy", async () => {
    const { repository } = makeRepo({ active: ["keep@x.io"], baseline: [] });
    const { createClient } = clientWith([]);
    await expect(createAccessSync({ repository, createClient })()).resolves.toMatchObject({
      outcome: "synced",
    });
  });

  it("reports unchanged when the policy already matched", async () => {
    const { repository } = makeRepo({ active: ["keep@x.io"], baseline: ["keep@x.io"] });
    const { createClient } = clientWith([{ email: { email: "keep@x.io" } }]);
    await expect(createAccessSync({ repository, createClient })()).resolves.toMatchObject({
      outcome: "unchanged",
    });
  });

  it("reports aborted, with the reason, when the blast-radius cap trips", async () => {
    const active = ["a@x.io", "b@x.io", "c@x.io"];
    const { repository } = makeRepo({ active, baseline: active });
    const { createClient } = clientWith([{ email: { email: "outside@gmail.com" } }]);
    const result = await createAccessSync({
      repository,
      createClient,
      maxDisablesPerRun: 2,
    })();
    expect(result.outcome).toBe("aborted");
    expect(result.detail).toMatch(/3 account\(s\)/);
  });
});
