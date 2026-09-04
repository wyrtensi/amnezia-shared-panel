/**
 * Helpers for the admin's "Server order" editor. Pure and free of React so
 * they can be unit-tested directly.
 *
 * The fallback for nodes the admin has not positioned MUST match
 * `apps/control-api/src/nodeOrder.ts` (display name via a fixed "en" collator,
 * then id) — that file is the authority; this one only previews the same rule
 * while the admin edits. The editor always saves a full explicit order for
 * every node it shows, so the fallback stops mattering after the first save.
 *
 * Recommending is modelled here as a COUNT from the top, because the control
 * API only accepts a recommended set that is a prefix of the order. The count
 * never leaves the editor: it is resolved back to ids on save. Ticking a row
 * therefore cannot recommend it where it stands — `recommendNode` moves it into
 * the prefix instead, and `unrecommendNode` moves it out, so the tick reads as
 * "recommend this server" rather than "recommend these first N servers".
 */
export type OrderableNode = { id: string; name: string };

const nameCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The full, explicit order to show (and to save): every current node exactly
 * once — saved positions first in their saved order, then the rest by name.
 * Saved ids whose node no longer exists are dropped.
 */
export const materializeNodeOrder = (
  nodes: readonly OrderableNode[],
  order: readonly string[] = [],
): string[] => {
  const known = new Set(nodes.map((node) => node.id));
  const positioned: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    positioned.push(id);
  }
  const rest = nodes
    .filter((node) => !seen.has(node.id))
    .sort(
      (a, b) => nameCollator.compare(a.name, b.name) || compareIds(a.id, b.id),
    )
    .map((node) => node.id);
  return [...positioned, ...rest];
};

/** Moves one id one slot up (-1) or down (+1). No-op at the edges. */
export const moveNodeInOrder = (
  orderedIds: readonly string[],
  id: string,
  delta: -1 | 1,
): string[] => {
  const from = orderedIds.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= orderedIds.length) return [...orderedIds];
  const next = [...orderedIds];
  const moved = next[from];
  const displaced = next[to];
  if (moved === undefined || displaced === undefined) return next;
  next[from] = displaced;
  next[to] = moved;
  return next;
};

/**
 * Moves one id to an absolute position, which is what a drag produces (the
 * up/down buttons move by one; a drag can cross the whole list). The target is
 * clamped, and an unknown id is a no-op, so a drop that lands outside the list
 * or on a row that vanished mid-drag cannot corrupt the order.
 */
export const moveNodeToIndex = (
  orderedIds: readonly string[],
  id: string,
  targetIndex: number,
): string[] => {
  const from = orderedIds.indexOf(id);
  if (from < 0) return [...orderedIds];
  const to = Math.max(0, Math.min(targetIndex, orderedIds.length - 1));
  if (to === from) return [...orderedIds];
  const next = [...orderedIds];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
};

/**
 * How many rows from the top are recommended. The API guarantees the saved set
 * IS a prefix, so this normally just counts it; the walk exists so a row that
 * somehow violates the invariant (a hand-edited database) shows up as the
 * longest honest prefix instead of breaking the editor.
 */
export const recommendedCountFromIds = (
  orderedIds: readonly string[],
  recommendedIds: readonly string[],
): number => {
  const recommended = new Set(recommendedIds);
  let count = 0;
  while (count < orderedIds.length && recommended.has(orderedIds[count]!)) {
    count += 1;
  }
  return count;
};

/** The ids to save as recommended for a given count, clamped to the list. */
export const recommendedPrefix = (
  orderedIds: readonly string[],
  count: number,
): string[] =>
  orderedIds.slice(0, Math.max(0, Math.min(count, orderedIds.length)));

/** A full order together with the recommended ids it resolves to. */
export type NodeOrderChange = {
  nodeOrder: string[];
  recommendedNodeIds: string[];
};

const settle = (orderedIds: readonly string[], count: number): NodeOrderChange => ({
  nodeOrder: [...orderedIds],
  recommendedNodeIds: recommendedPrefix(orderedIds, count),
});

/**
 * Recommends one node by RAISING it to the bottom of the recommended block —
 * the reading an operator expects from a checkbox. Everything the node passed
 * closes up behind it and keeps whatever recommendation it had, so ticking row
 * 4 no longer recommends rows 1-3 along with it.
 *
 * Ticking a node that is already recommended, or an id that is not in the list
 * (a row that vanished under the click), changes nothing.
 */
export const recommendNode = (
  orderedIds: readonly string[],
  count: number,
  id: string,
): NodeOrderChange => {
  const from = orderedIds.indexOf(id);
  if (from < 0 || from < count) return settle(orderedIds, count);
  return settle(moveNodeToIndex(orderedIds, id, count), count + 1);
};

/**
 * Unrecommends one node by dropping it just BELOW the shrunken prefix, so the
 * nodes that were recommended alongside it stay recommended and the unticked
 * node keeps the best position it can. Unticking the last recommended row moves
 * nothing — it is already where it needs to be.
 */
export const unrecommendNode = (
  orderedIds: readonly string[],
  count: number,
  id: string,
): NodeOrderChange => {
  const from = orderedIds.indexOf(id);
  if (from < 0 || from >= count) return settle(orderedIds, count);
  const nextCount = count - 1;
  return settle(moveNodeToIndex(orderedIds, id, nextCount), nextCount);
};
