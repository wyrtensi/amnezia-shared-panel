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

/**
 * What one sync run did. The outbox handler needs this to tell a run that acted
 * from one that deliberately refused to: a refusal must not finish the job as a
 * success (see the "no acting run is a success" rule in the plan).
 */
export type AccessSyncOutcome = {
  outcome: "skipped" | "aborted" | "synced" | "unchanged";
  /** Human-readable reason, present for `aborted`. */
  detail?: string;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Domains admitted by the policy's `email_domain` ("emails ending in") rules.
 * Cloudflare stores the bare domain, but the dashboard shows it with a leading
 * "@" and operators paste it that way, so both forms are accepted (and a
 * doubled "@@" typo is stripped too — `replace` with a `+` quantifier, not a
 * single `@`).
 */
const domainAllowlist = (rules: CfAccessRule[]): Set<string> =>
  new Set(
    rules
      .map(
        (rule) =>
          (rule as { email_domain?: { domain?: string } }).email_domain?.domain,
      )
      .filter((domain): domain is string => Boolean(domain))
      .map((domain) => domain.trim().toLowerCase().replace(/^@+/, ""))
      .filter(Boolean),
  );

/**
 * The domain half of an email address: everything after the LAST "@", not the
 * second "@"-delimited segment — an address with a literal "@" in its local
 * part (rare, but RFC-legal when quoted) would otherwise yield the wrong
 * domain. Worker-local; `apps/control-api` has its own copy of this
 * extraction for a different code path (the panel signup allowlist gate) and
 * is intentionally left alone here.
 */
const domainOf = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
};

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
 * An unknown email added directly in the Cloudflare policy IS turned into a
 * panel account: Cloudflare already gated that identity at the edge, so
 * `resolveIdentity` (`apps/control-api/src/postgresRepository.ts`) skips the
 * panel's own allowlist gate for the `cloudflare-access` login provider and
 * auto-provisions the account on that person's first request. Ownership
 * (below) then keeps the hand-added rule in the policy indefinitely — this is
 * the standing trust model, not a narrow race: membership in the Access
 * policy is equivalent to being granted a panel account. Removing a user in
 * Cloudflare IS honoured (disable). Non-email rules (email_domain, groups,
 * ...) are always preserved. Safe by construction: unconfigured or "no active
 * users" are no-ops that never wipe the allowlist.
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
  // Blast-radius cap. A run that would disable more accounts than this, OR more
  // than half of the active panel, stops and reports instead of acting: rails 1
  // and 2 cover the known ways the disable set can be wrong, and this covers the
  // unknown ones — including a majority removal on a small panel that would
  // never reach the absolute count. 0 disables both halves of the cap.
  maxDisablesPerRun?: number;
  /** Called instead of disabling when the cap is exceeded. */
  recordAccessSyncAborted?: (details: {
    candidates: string[];
    limit: number;
    // The active-user count at abort time, and which half of the cap actually
    // fired — a proportional abort (overMajority) can hold with candidates
    // under `limit`, which reads as self-contradictory in the audit log
    // unless the row also says so.
    activeCount: number;
    overAbsoluteCap: boolean;
    overMajority: boolean;
  }) => Promise<void>;
  log?: (message: string) => void;
}): () => Promise<AccessSyncOutcome> {
  const {
    repository,
    createClient = createCloudflareAccessClient,
    bootstrapAdminEmails = [],
    maxDisablesPerRun = 10,
    recordAccessSyncAborted,
    log = () => undefined,
  } = options;
  const pinned = bootstrapAdminEmails.map(normalizeEmail).filter(Boolean);
  const pinnedSet = new Set(pinned);
  // The candidate set (normalised: trimmed, lower-cased, sorted) the most
  // recent abort recorded an audit row for. `null` means either nothing has
  // aborted yet, or the last run completed without aborting. Kept in the
  // closure so a repeated identical abort writes only one row, while a
  // changed candidate set — or a recurrence after a clean run — writes again.
  let lastAbortedCandidates: string[] | null = null;
  const sortedCandidates = (candidates: string[]): string[] =>
    [...candidates].map(normalizeEmail).sort();
  const sameCandidates = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((email, index) => email === b[index]);

  return async () => {
    const config = await repository.getCloudflareConfig();
    if (!config) {
      log("access-sync: Cloudflare not configured — skipping.");
      // This run did not abort (it never got far enough to check), so forget
      // any previously recorded abort — see the closure comment above.
      lastAbortedCandidates = null;
      return { outcome: "skipped" };
    }

    const client = createClient(config);
    const policy = await client.getPolicy();
    const include = Array.isArray(policy.include) ? policy.include : [];
    const exclude = Array.isArray(policy.exclude) ? policy.exclude : [];
    // Rules the panel never writes: everything that is not an email rule.
    const nonEmailRules = include.filter((rule) => !rule.email?.email);
    const cfEmails = new Set(
      include
        .map((rule) => rule.email?.email)
        .filter((value): value is string => Boolean(value))
        .map(normalizeEmail),
    );

    // A person the policy still admits through a domain rule has not been
    // "removed in Cloudflare" — treating them as removed would disable them and
    // revoke every key they own. Guards the common tidy-up where an admin drops
    // the explicit corporate addresses because a domain rule already covers them.
    //
    // `include` alone is not the whole story: `exclude` is the idiomatic
    // Cloudflare way to carve someone back out of a domain rule, either by
    // their exact address or by naming that same domain again in an
    // `email_domain` exclude rule (matching is exact, not by sub-domain, so
    // this is how the whole domain gets carved back out). A person named in
    // `exclude` is blocked at the edge already — judging them "covered" here
    // would spare them from the disable, and the write-back would re-add
    // their address, undoing the operator's exclusion.
    // `require` (AND-conditions) is intentionally NOT evaluated — a known
    // limitation, documented in docs/CLOUDFLARE-ACCESS.md, not silent coverage.
    const allowedDomains = domainAllowlist(nonEmailRules);
    if (
      nonEmailRules.some((rule) => "email_domain" in rule) &&
      allowedDomains.size === 0
    ) {
      // The whole point of this guard is to protect people a domain rule
      // still admits. If the rule is there but nothing usable was parsed from
      // it (a blank `domain`, an unexpected shape), the guard silently
      // protects no one — say so, rather than leaving an operator who thinks
      // the domain rule has their back with no signal at all.
      log(
        "access-sync: the policy has an email_domain rule but no usable domain " +
          "was parsed from it — the domain-cover guard is not protecting anyone.",
      );
    }
    const excludedEmails = new Set(
      exclude
        .map((rule) => rule.email?.email)
        .filter((value): value is string => Boolean(value))
        .map(normalizeEmail),
    );
    const excludedDomains = domainAllowlist(exclude);
    const coveredByDomain = (email: string): boolean => {
      const domain = domainOf(email);
      if (!allowedDomains.has(domain)) return false;
      if (excludedEmails.has(email) || excludedDomains.has(domain)) return false;
      return true;
    };

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
              !pinnedSet.has(email) &&
              !coveredByDomain(email),
          );
    if (cfEmails.size === 0 && nonEmailRules.length > 0) {
      log(
        "access-sync: policy grants access via non-email rules only (no email include) — skipping CF→panel disable.",
      );
    }
    // Blast-radius cap: the absolute count, OR more than half of the active
    // panel — whichever trips first. The absolute cap alone protects a large
    // panel; on a small one, an operator removing "only" a handful can still
    // be removing everyone (5 <= 10 trips nothing on a 5-user panel), so a
    // run that would disable a majority of active users aborts even when the
    // raw count sits under the absolute cap. 0 disables BOTH halves — the
    // documented escape hatch for a genuine mass offboarding.
    const overAbsoluteCap = cfRemoved.length > maxDisablesPerRun;
    const overMajority = cfRemoved.length > Math.ceil(activeSet.size / 2);
    if (maxDisablesPerRun > 0 && (overAbsoluteCap || overMajority)) {
      // Abort the whole run, not just the disable half: the write-back would
      // otherwise re-assert the emails an operator has just removed, silently
      // undoing a deliberate change. Leaving the baseline untouched means the
      // next run sees the same anomaly rather than adopting it.
      //
      // Name whichever condition(s) actually fired, and give advice that
      // fits: `overMajority` ignores ACCESS_SYNC_MAX_DISABLES entirely except
      // at the 0 escape hatch, so "raise the limit" is wrong advice whenever
      // it fired — telling an operator to raise a knob that cannot help.
      const reasons = [
        overAbsoluteCap ? `over the limit of ${maxDisablesPerRun}` : null,
        overMajority ? `over half of ${activeSet.size} active user(s)` : null,
      ].filter((reason): reason is string => reason !== null);
      const advice = overMajority
        ? "Set ACCESS_SYNC_MAX_DISABLES=0 to proceed."
        : "Raise ACCESS_SYNC_MAX_DISABLES to proceed.";
      // Built once so the log line and the job's failure reason cannot drift apart.
      const abortReason =
        `${cfRemoved.length} account(s) would be disabled, ` +
        `${reasons.join(" and ")} — aborting the run and recording it. ${advice}`;
      log(`access-sync: ${abortReason}`);
      // The log line above fires on every run (the high-frequency channel);
      // the audit row is the notification, so write it only when the
      // candidate set actually changed since the last recorded abort —
      // otherwise an unattended anomaly writes one row per interval forever
      // and crowds real history out of the audit view's 500-row window.
      const candidates = sortedCandidates(cfRemoved);
      if (!lastAbortedCandidates || !sameCandidates(candidates, lastAbortedCandidates)) {
        await recordAccessSyncAborted?.({
          candidates: cfRemoved,
          limit: maxDisablesPerRun,
          activeCount: activeSet.size,
          overAbsoluteCap,
          overMajority,
        });
      }
      lastAbortedCandidates = candidates;
      return { outcome: "aborted", detail: abortReason };
    }
    // This run did not take the abort branch above (the only abort exit in
    // this function), so forget any previously recorded abort: a recurrence
    // after this clean run must write a fresh audit row, not read as silence.
    lastAbortedCandidates = null;
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
      // Keep the old baseline; never treat "empty" as "remove everyone".
      return { outcome: "skipped" };
    }

    const desiredSet = new Set(desired);
    // Ownership: the panel may only delete email rules it put there itself, and
    // the baseline is the record of exactly that. An email rule that is neither
    // in the baseline nor in the desired set was added by someone else (by hand
    // in the dashboard, by another tool) and is preserved verbatim, keeping any
    // fields this client does not model.
    const owned = new Set(baseline);
    const ruleEmail = (rule: CfAccessRule): string | undefined => {
      const email = rule.email?.email;
      return email ? normalizeEmail(email) : undefined;
    };
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
    return { outcome: cfInSync ? "unchanged" : "synced" };
  };
}
