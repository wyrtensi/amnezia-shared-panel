/**
 * Run `fn` over `items` with at most `limit` promises in flight, keeping the
 * input order in the results.
 *
 * The telemetry poll currently fans out to every node at once. That is fine at
 * six nodes and is not fine at sixty: each node costs four HTTP requests and a
 * response held in memory, inside a worker that runs in a 160 MiB cgroup on a
 * host shared with the panel. Bounding it trades a little wall-clock for a
 * predictable ceiling.
 *
 * `fn` is expected to handle its own failures. This helper rejects if it does
 * not, which is deliberate: silently swallowing a rejection here would hide a
 * bug in the caller rather than in one node.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  // One lane per slot, each pulling the next index until the list is done.
  // Chunking would idle a lane whenever one item in a chunk is slow.
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(lanes);
  return results;
};
