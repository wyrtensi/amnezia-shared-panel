/**
 * Canonical form and cross-field validation for the portal policy's node-id
 * lists.
 *
 * The rule the operator asked for: only the servers at the TOP of the manual
 * order may be recommended. Formally, `recommendedNodeIds` must be exactly the
 * first N entries of `nodeOrder`. A node with no position in `nodeOrder` is in
 * no prefix of it, so it can never be recommended — including every node while
 * `nodeOrder` is still empty.
 *
 * This is deliberately NOT an ordering concern: `nodeOrder.ts` never sees the
 * recommended set. Recommended servers appear first because a non-prefix set
 * cannot be stored, not because the comparator lifts them.
 */

/** Drops duplicates while keeping the FIRST occurrence in place (positional). */
export const dedupeNodeIds = (ids: readonly string[]): string[] => [
  ...new Set(ids),
];

export type RecommendedPrefixCheck =
  | { ok: true; canonical: string[] }
  | {
      ok: false;
      /** The node the admin has to move or un-recommend. */
      nodeId: string;
      /** "behind" = positioned, but not in the top N. */
      reason: "behind" | "unpositioned";
      /** 1-based position in the order, or null when it has none. */
      position: number | null;
    };

/**
 * Checks the recommended SET against the order (input may be in any sequence)
 * and returns the canonical stored form, `order.slice(0, k)`. On failure it
 * names the offending node nearest the top of the order, because that is the
 * one the admin fixes first.
 */
export const checkRecommendedPrefix = (
  recommended: readonly string[],
  order: readonly string[],
): RecommendedPrefixCheck => {
  const wanted = new Set(recommended);
  if (wanted.size === 0) return { ok: true, canonical: [] };
  // Walk the order from the top: everything up to the last recommended id must
  // itself be recommended.
  const canonical: string[] = [];
  for (const id of order) {
    if (!wanted.has(id)) break;
    canonical.push(id);
    wanted.delete(id);
  }
  if (wanted.size === 0) return { ok: true, canonical };
  // Something is left over: either it sits further down the order, or it is
  // not in the order at all. The scan runs top-down, so the first hit IS the
  // one closest to the top.
  const behind = order.findIndex((id) => wanted.has(id));
  if (behind >= 0) {
    return {
      ok: false,
      nodeId: order[behind]!,
      reason: "behind",
      position: behind + 1,
    };
  }
  // Deterministic choice among ids that have no position at all: the first one
  // as the caller listed them.
  const unpositioned = recommended.find((id) => wanted.has(id));
  return {
    ok: false,
    nodeId: unpositioned ?? [...wanted][0]!,
    reason: "unpositioned",
    position: null,
  };
};
