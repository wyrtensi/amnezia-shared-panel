import type { WorkerRepository } from "./repository.js";
import {
  createCloudflareAccessClient,
  type CfAccessRule,
  type CloudflareAccessClient,
  type CloudflareConfig,
} from "./cloudflareApi.js";

/**
 * Cloudflare Access deactivation — foundation.
 *
 * When someone is removed from the Cloudflare Access application they can no
 * longer sign in, but their panel account stays `active` and their VPN keys
 * keep working (keys are independent of the login session). This module closes
 * that gap: an `AccessDirectory` reports the set of emails still allowed, and
 * the worker periodically disables + revokes anyone who has fallen out of it.
 *
 * The directory is a seam so the source of truth can vary. A static env
 * allowlist works today; the Cloudflare API adapter is a documented extension
 * point (it needs an API token + account/group id — see docs/CLOUDFLARE-ACCESS.md).
 */
export interface AccessDirectory {
  readonly name: string;
  /** Emails currently permitted to use the panel. */
  getAllowedEmails(): Promise<string[]>;
}

/** Directory backed by a static, comma/space/semicolon-separated env allowlist. */
export function createAllowlistDirectory(raw: string): AccessDirectory {
  const emails = raw
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return {
    name: "allowlist",
    getAllowedEmails: () => Promise.resolve(emails),
  };
}

/**
 * Cloudflare Access adapter — extension point. Listing the identities allowed
 * by an Access application requires an API token, the account id, and the
 * Access group / application id. Until those are provided it throws, so the
 * feature fails loudly instead of silently treating "no data" as "revoke
 * everyone". Complete the `getAllowedEmails` body once credentials exist.
 */
export function createCloudflareDirectory(config: {
  accountId?: string;
  apiToken?: string;
  groupId?: string;
}): AccessDirectory {
  return {
    name: "cloudflare",
    getAllowedEmails: () => {
      if (!config.accountId || !config.apiToken || !config.groupId) {
        return Promise.reject(
          new Error(
            "CloudflareAccessDirectory is not configured: set CF_ACCESS_ACCOUNT_ID, CF_API_TOKEN and CF_ACCESS_GROUP_ID.",
          ),
        );
      }
      // TODO(access): call the Cloudflare API to enumerate the emails allowed by
      // the Access application/group and return them. Documented in
      // docs/CLOUDFLARE-ACCESS.md. Left unimplemented on purpose so the feature
      // cannot silently deactivate accounts against unverified data.
      return Promise.reject(
        new Error(
          "CloudflareAccessDirectory lookup is not implemented yet — use ACCESS_DIRECTORY=allowlist or complete the adapter.",
        ),
      );
    },
  };
}

/**
 * Build the periodic task that reconciles panel accounts against the directory.
 * Safe by construction: an empty allowlist is treated as a lookup failure and
 * changes nothing (the repository enforces the same guard).
 */
export function createAccessReconciler(options: {
  repository: Pick<WorkerRepository, "reconcileAccess">;
  directory: AccessDirectory;
  log?: (message: string) => void;
}): () => Promise<void> {
  const { repository, directory, log = () => undefined } = options;
  return async () => {
    const allowed = await directory.getAllowedEmails();
    if (allowed.length === 0) {
      log(
        `access-reconcile: ${directory.name} returned no emails — skipping (safety guard).`,
      );
      return;
    }
    const result = await repository.reconcileAccess(allowed);
    if (result.deactivated.length > 0 || result.skippedAdmins.length > 0) {
      log(
        `access-reconcile: disabled ${result.deactivated.length} account(s); ` +
          `left ${result.skippedAdmins.length} admin(s) for manual review.`,
      );
    }
  };
}

/**
 * Panel → Access write-back: push the panel's active-user emails into the Access
 * application policy's `include` list, preserving every non-email rule (a
 * corporate `email_domain` rule, groups, etc.). Off unless the Cloudflare config
 * + token are set. An empty active-user set is a no-op (never wipe the allowlist).
 */
export function createAccessWriteback(options: {
  repository: {
    getCloudflareConfig: () => Promise<CloudflareConfig | null>;
    listActiveUserEmails: () => Promise<string[]>;
  };
  createClient?: (config: CloudflareConfig) => CloudflareAccessClient;
  // Emails that must never be removed from the allowlist (e.g. bootstrap
  // admins) even if they aren't active panel users — avoids self-lockout.
  bootstrapAdminEmails?: string[];
  log?: (message: string) => void;
}): () => Promise<void> {
  const {
    repository,
    createClient = createCloudflareAccessClient,
    bootstrapAdminEmails = [],
    log = () => undefined,
  } = options;
  const pinned = bootstrapAdminEmails
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return async () => {
    const config = await repository.getCloudflareConfig();
    if (!config) {
      log("access-writeback: Cloudflare not configured — skipping.");
      return;
    }
    const active = (await repository.listActiveUserEmails())
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    // Never drop bootstrap admins from the allowlist.
    const emails = [...new Set([...active, ...pinned])];
    if (emails.length === 0) {
      log("access-writeback: no active users — skipping (safety guard).");
      return;
    }
    const client = createClient(config);
    const policy = await client.getPolicy();
    const include = Array.isArray(policy.include) ? policy.include : [];
    const preserved = include.filter((rule) => !rule.email?.email);
    const currentEmails = new Set(
      include
        .map((rule) => rule.email?.email?.toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );
    const desired = new Set(emails);
    const unchanged =
      currentEmails.size === desired.size &&
      [...desired].every((email) => currentEmails.has(email));
    if (unchanged) return;
    const nextInclude: CfAccessRule[] = [
      ...preserved,
      ...emails.map((email) => ({ email: { email } })),
    ];
    // Send the FULL policy back (name + decision + preserved exclude/require) —
    // Cloudflare rejects a bare {include} fragment.
    await client.updatePolicy({ ...policy, include: nextInclude });
    log(`access-writeback: synced ${emails.length} email(s) to the Access policy.`);
  };
}
