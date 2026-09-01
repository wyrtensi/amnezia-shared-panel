import type { GlobalRouteProfile } from "@amnezia/contracts";
import type { RulePayload } from "./vpnConfig.js";

export type RouteExtras = {
  cidrs?: string[] | null;
  domains?: string[] | null;
} | null;

/**
 * Every suffix of a hostname that could act as its parent zone, longest first:
 * "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"].
 */
const domainSuffixes = (domain: string): string[] => {
  const labels = domain.split(".");
  const suffixes: string[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    suffixes.push(labels.slice(index).join("."));
  }
  return suffixes;
};

/**
 * A domain is excluded when it matches an excluded entry exactly, or when any of
 * its parent zones is excluded — excluding "example.com" also drops
 * "a.b.example.com". Sibling names that merely end with the same characters
 * ("notexample.com") are NOT affected, because matching is label-wise.
 */
export const isDomainExcluded = (
  domain: string,
  excluded: ReadonlySet<string>,
): boolean => {
  if (excluded.size === 0) return false;
  return domainSuffixes(domain.toLowerCase()).some((suffix) =>
    excluded.has(suffix),
  );
};

/**
 * Build the route payload actually exported for a key, in this order:
 *
 *   1. the active feed payload for the profile;
 *   2. minus the admin's global exclusions (CIDR: exact match; domain: exact
 *      match or any parent suffix);
 *   3. plus the admin's global additions;
 *   4. plus the owner's own custom routes.
 *
 * Step 4 runs after the exclusions on purpose: a user who adds an excluded
 * entry to their personal list opts back into it.
 */
export const mergeRoutePayload = (input: {
  base: RulePayload;
  global?: GlobalRouteProfile | null;
  userExtra?: RouteExtras;
}): RulePayload => {
  const excludedCidrs = new Set(input.global?.exclude.cidrs ?? []);
  const excludedDomains = new Set(
    (input.global?.exclude.domains ?? []).map((domain) => domain.toLowerCase()),
  );

  const cidrs = new Set(
    input.base.cidrs.filter((cidr) => !excludedCidrs.has(cidr)),
  );
  const domains = new Set(
    input.base.domains.filter(
      (domain) => !isDomainExcluded(domain, excludedDomains),
    ),
  );

  for (const cidr of input.global?.add.cidrs ?? []) cidrs.add(cidr);
  for (const domain of input.global?.add.domains ?? []) domains.add(domain);

  for (const cidr of input.userExtra?.cidrs ?? []) cidrs.add(cidr);
  for (const domain of input.userExtra?.domains ?? []) domains.add(domain);

  return { cidrs: [...cidrs], domains: [...domains] };
};
