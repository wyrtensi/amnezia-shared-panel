import type { UserNodeReachability } from "@/lib/types";

/**
 * What the key card's status badge shows: the key's own state, except that an
 * active key on a server the probe finds blocked reads "blocked". Every other
 * state (provisioning, failed, disabled, ...) is about the key itself and
 * wins; an `unknown` verdict changes nothing.
 */
export const keyBadgeState = (
  keyState: string,
  nodeReachability: UserNodeReachability | undefined,
): string =>
  keyState === "active" && nodeReachability?.state === "blocked" ? "blocked" : keyState;

/**
 * Blocked servers first, everything else in the order the API sent (the
 * admin's order). Stable, and never reorders within either group.
 */
export const blockedFirst = <T extends { reachability?: UserNodeReachability }>(
  nodes: readonly T[],
): T[] => [
  ...nodes.filter((node) => node.reachability?.state === "blocked"),
  ...nodes.filter((node) => node.reachability?.state !== "blocked"),
];
