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

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Two-way Cloudflare Access sync (the "2 side" policy editor).
 *
 * A single task reconciles the panel's active-user set against the Access
 * policy's `include` email list in BOTH directions, using a stored baseline
 * (the set last synced) to tell the two kinds of "active in panel, absent from
 * Cloudflare" apart:
 *
 *   - added in the PANEL (not in the baseline) → push it to Cloudflare, never
 *     disable — this protects a freshly-added user before the write-back runs;
 *   - removed in CLOUDFLARE (in the baseline, now gone) → disable that panel
 *     user and revoke their keys.
 *
 * The panel is the source of truth for ADDING users: an unknown email added
 * directly in the Cloudflare policy is not turned into a panel account (there is
 * nothing to create) — the write-back reasserts the panel's set, so add users in
 * the panel. Removing a user in Cloudflare IS honoured (disable). Non-email
 * rules (email_domain, groups, ...) are always preserved. Safe by construction:
 * unconfigured or "no active users" are no-ops that never wipe the allowlist.
 */
export function createAccessSync(options: {
  repository: {
    getCloudflareConfig: () => Promise<CloudflareConfig | null>;
    listActiveUserEmails: () => Promise<string[]>;
    getAccessSyncBaseline: () => Promise<string[]>;
    setAccessSyncBaseline: (emails: string[]) => Promise<void>;
    deactivateByEmail: (
      emails: string[],
    ) => Promise<{ deactivated: string[]; skippedAdmins: string[] }>;
  };
  createClient?: (config: CloudflareConfig) => CloudflareAccessClient;
  // Emails that must never be removed from Cloudflare or disabled (bootstrap
  // admins) even if they are not active panel users — avoids self-lockout.
  bootstrapAdminEmails?: string[];
  log?: (message: string) => void;
}): () => Promise<void> {
  const {
    repository,
    createClient = createCloudflareAccessClient,
    bootstrapAdminEmails = [],
    log = () => undefined,
  } = options;
  const pinned = bootstrapAdminEmails.map(normalizeEmail).filter(Boolean);
  const pinnedSet = new Set(pinned);

  return async () => {
    const config = await repository.getCloudflareConfig();
    if (!config) {
      log("access-sync: Cloudflare not configured — skipping.");
      return;
    }

    const client = createClient(config);
    const policy = await client.getPolicy();
    const include = Array.isArray(policy.include) ? policy.include : [];
    // Rules the panel never writes: everything that is not an email rule.
    const nonEmailRules = include.filter((rule) => !rule.email?.email);
    const cfEmails = new Set(
      include
        .map((rule) => rule.email?.email?.toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );

    const activeSet = new Set(
      (await repository.listActiveUserEmails()).map(normalizeEmail).filter(Boolean),
    );
    const baseline = (await repository.getAccessSyncBaseline()).map(normalizeEmail);

    // CF → panel: emails that were synced before (in the baseline) and are still
    // active panel users, but have since been removed from the Cloudflare policy.
    // Disable them (targeted — never touches a concurrently-added user). Pinned
    // bootstrap admins are exempt.
    //
    // Safety guard (mirrors reconcileAccess's empty-allowlist guard): if the
    // policy include has ZERO email rules, treat it as an anomaly, NOT as "every
    // synced user was removed". This happens when access is granted by a
    // surviving `email_domain`/group rule (kept in `nonEmailRules`) rather than
    // explicit emails — disabling everyone there would be catastrophic.
    const cfRemoved =
      cfEmails.size === 0
        ? []
        : baseline.filter(
            (email) =>
              activeSet.has(email) &&
              !cfEmails.has(email) &&
              !pinnedSet.has(email),
          );
    if (cfEmails.size === 0 && nonEmailRules.length > 0) {
      log(
        "access-sync: policy grants access via non-email rules only (no email include) — skipping CF→panel disable.",
      );
    }
    if (cfRemoved.length > 0) {
      const result = await repository.deactivateByEmail(cfRemoved);
      if (result.deactivated.length > 0 || result.skippedAdmins.length > 0) {
        log(
          `access-sync: disabled ${result.deactivated.length} account(s) removed from Cloudflare; ` +
            `left ${result.skippedAdmins.length} admin(s) for manual review.`,
        );
      }
    }

    // panel → CF: the desired allowlist is the active users AFTER the disable
    // step (re-read so freshly-disabled accounts drop out) plus pinned admins.
    const desired = [
      ...new Set([
        ...(await repository.listActiveUserEmails())
          .map(normalizeEmail)
          .filter(Boolean),
        ...pinned,
      ]),
    ];
    if (desired.length === 0) {
      log("access-sync: no active users — skipping write-back (safety guard).");
      return; // Keep the old baseline; never treat "empty" as "remove everyone".
    }

    const desiredSet = new Set(desired);
    // Ownership: the panel may only delete email rules it put there itself, and
    // the baseline is the record of exactly that. An email rule that is neither
    // in the baseline nor in the desired set was added by someone else (by hand
    // in the dashboard, by another tool) and is preserved verbatim, keeping any
    // fields this client does not model.
    const owned = new Set(baseline);
    const ruleEmail = (rule: CfAccessRule): string | undefined =>
      rule.email?.email?.toLowerCase();
    const foreignRules = include.filter((rule) => {
      const email = ruleEmail(rule);
      if (!email) return false;
      return !owned.has(email) && !desiredSet.has(email);
    });
    const foreignEmails = foreignRules
      .map(ruleEmail)
      .filter((email): email is string => Boolean(email));
    // In sync when the email set the policy would end up with already matches
    // the one it has. Compared as sets, because foreign rules keep their place.
    const nextEmails = new Set([...foreignEmails, ...desired]);
    const cfInSync =
      nextEmails.size === cfEmails.size &&
      [...nextEmails].every((email) => cfEmails.has(email));
    if (!cfInSync) {
      const nextInclude: CfAccessRule[] = [
        ...nonEmailRules,
        ...foreignRules,
        ...desired.map((email) => ({ email: { email } })),
      ];
      await client.updatePolicy({ ...policy, include: nextInclude });
      log(`access-sync: pushed ${desired.length} email(s) to the Access policy.`);
    }

    // Record what Cloudflare now reflects so the next run can diff against it.
    await repository.setAccessSyncBaseline(desired);
  };
}
