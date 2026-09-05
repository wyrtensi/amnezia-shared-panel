import type { GlobalRouteProfile } from "@amnezia/contracts";
import type { RulePayload, TunnelRoutes } from "./vpnConfig.js";

export type RouteExtras = {
  cidrs?: string[] | null;
} | null;

/**
 * Build the address list actually exported for a key, in this order:
 *
 *   1. the active feed payload's CIDRs for the profile;
 *   2. minus the admin's global exclusions (exact match);
 *   3. plus the admin's global additions;
 *   4. plus the owner's own custom routes.
 *
 * Step 4 runs after the exclusions on purpose: a user who adds an excluded
 * entry to their personal list opts back into it.
 *
 * Only addresses take part. The feed's domain half is dropped here rather than
 * carried to the export, because an exported key routes on AllowedIPs and a
 * name never becomes a prefix — see `ROUTE_DOMAINS_UNSUPPORTED` in the
 * contracts for the whole of that reasoning. Rows written before route rules
 * became addresses-only may still hold domains; they are ignored, not applied.
 */
export const mergeRoutePayload = (input: {
  base: RulePayload;
  global?: GlobalRouteProfile | null;
  userExtra?: RouteExtras;
}): TunnelRoutes => {
  const excludedCidrs = new Set(input.global?.exclude.cidrs ?? []);

  const cidrs = new Set(
    input.base.cidrs.filter((cidr) => !excludedCidrs.has(cidr)),
  );

  for (const cidr of input.global?.add.cidrs ?? []) cidrs.add(cidr);
  for (const cidr of input.userExtra?.cidrs ?? []) cidrs.add(cidr);

  return { cidrs: [...cidrs] };
};
