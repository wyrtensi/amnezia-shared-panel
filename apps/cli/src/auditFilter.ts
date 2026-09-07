/**
 * Structural copy of `auditCategoryOf` / `auditScopeOf` from @amnezia/contracts.
 *
 * The CLI declares no runtime dependencies on purpose (the same trade-off
 * `deviceProfiles.ts` makes for the route-profile list and `args.ts` for
 * `normalizeAccessDomain`), so it re-states the mapping rather than importing
 * it. `auditFilter.test.ts` cross-checks both halves against the contract, so
 * the copy cannot drift silently.
 *
 * Why the mapping exists at all: `audit_events.target_type` carries two
 * vocabularies for the same subjects — a domain event writes the entity name
 * (`vpn_key`, `user`), an `admin.<resource>.<verb>` event writes the REST
 * resource name (`keys`, `users`). A filter that did not fold them would ask
 * the operator to know which of the two spellings a given action happened to
 * use.
 */
const CATEGORY_BY_TARGET: Record<string, string> = {
  vpn_key: "keys",
  keys: "keys",
  user: "users",
  users: "users",
  node: "nodes",
  nodes: "nodes",
  portal_policy: "policy",
  "portal-policy": "policy",
  route_rule: "rules",
  rule_version: "rules",
  rules: "rules",
  access_policy: "access",
  "access-sync": "access",
  service_check: "checks",
  "service-checks": "checks",
  quota_request: "quota",
  "quota-requests": "quota",
};

export const AUDIT_CATEGORIES = [
  "keys",
  "users",
  "nodes",
  "policy",
  "rules",
  "access",
  "checks",
  "quota",
  "other",
];

export function cliAuditCategoryOf(targetType: string): string {
  return CATEGORY_BY_TARGET[targetType] ?? "other";
}

export function cliAuditScopeOf(actorType: string): string {
  return actorType === "system" ? "system" : "people";
}

/**
 * Whether one event survives the given filters. Both are optional and both are
 * ANDed — they answer different questions, so a match on one must not rescue a
 * row the other excluded.
 */
export function auditEventMatches(
  event: { actorType: string; targetType: string },
  filter: { actor?: string; category?: string },
): boolean {
  if (filter.actor && cliAuditScopeOf(event.actorType) !== filter.actor) {
    return false;
  }
  if (filter.category && cliAuditCategoryOf(event.targetType) !== filter.category) {
    return false;
  }
  return true;
}
