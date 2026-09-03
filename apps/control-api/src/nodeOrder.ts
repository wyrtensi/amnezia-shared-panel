/**
 * Deterministic order for every node list a user sees (dashboard, key wizard,
 * quota-request target). The underlying SELECT has no ORDER BY and node rows
 * are rewritten by every telemetry poll, so heap order changes between
 * requests; sorting here keeps the list still across refetches.
 */
export type OrderableNode = { id: string; name: string };

// A fixed locale: the order must not depend on the host's environment.
const nameCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Returns a new array ordered by display name, then id. Never mutates input. */
export const orderNodesForUsers = <T extends OrderableNode>(
  rows: readonly T[],
): T[] =>
  [...rows].sort(
    (a, b) => nameCollator.compare(a.name, b.name) || compareIds(a.id, b.id),
  );
