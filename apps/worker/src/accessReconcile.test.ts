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
    });
  });

  it("disables normally when the count is within the cap", async () => {
    const { repository, deactivateByEmail } = makeRepo({
      active: ["a@x.io", "b@x.io"],
      baseline: ["a@x.io", "b@x.io"],
    });
    const { createClient } = clientWith([{ email: { email: "outside@gmail.com" } }]);

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
});
