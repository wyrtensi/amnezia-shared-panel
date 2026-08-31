import { describe, expect, it, vi } from "vitest";
import {
  createAccessReconciler,
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
