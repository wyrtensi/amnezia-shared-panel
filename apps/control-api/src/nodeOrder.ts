/**
 * Deterministic order for every node list a user sees (dashboard, key wizard,
 * quota-request target). The underlying SELECT has no ORDER BY and node rows
 * are rewritten by every telemetry poll, so heap order changes between
 * requests; sorting here keeps the list still across refetches.
 */
export type OrderableNode = {
  id: string;
  name: string;
  // Present on raw node rows (the key auto-pick); absent once `listNodes` has
  // already collapsed it into `name` for the user payload.
  publicName?: string | null;
};

// Sorts after every hand-positioned node. Number.MAX_SAFE_INTEGER, not
// Infinity: the ranks are subtracted, and Infinity - Infinity is NaN, which
// would make the comparator lie.
const UNPOSITIONED = Number.MAX_SAFE_INTEGER;

// A fixed locale: the order must not depend on the host's environment.
const nameCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const displayName = (row: OrderableNode): string => row.publicName ?? row.name;

/**
 * Returns a new array, ordered by: the admin's manual position, then the
 * display name, then the id. The id makes the key total, so the result never
 * depends on the input order or on sort stability. Never mutates input. Ids in
 * `order` that match no row are ignored, and a row missing from `order` simply
 * lands in the unpositioned tail - so hiding a node closes the gap instead of
 * leaving a hole.
 *
 * `recommendedNodeIds` is deliberately NOT an input. Being recommended is a
 * badge and must never move a server (operator decision, 2026-09-02); the
 * recommended nodes lead the list only because the control API refuses to
 * store a recommended set that is not a prefix of `order`.
 */
export const orderNodesForUsers = <T extends OrderableNode>(
  rows: readonly T[],
  order: readonly string[] = [],
): T[] => {
  // One pass to build the id -> position map; the sort then costs O(1) per
  // comparison instead of an indexOf scan.
  const position = new Map<string, number>();
  order.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  const rank = (row: T): number => position.get(row.id) ?? UNPOSITIONED;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      nameCollator.compare(displayName(a), displayName(b)) ||
      compareIds(a.id, b.id),
  );
};
