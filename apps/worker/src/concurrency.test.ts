import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` tasks at once and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;

    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n * 10;
    });

    expect(result).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, (n: number) => Promise.resolve(n))).toEqual(
      [],
    );
    expect(await mapWithConcurrency([1], 4, (n) => Promise.resolve(n + 1))).toEqual([
      2,
    ]);
  });

  it("keeps the order even when the slow item is first", async () => {
    // Lanes finish out of order by design; the result array must not.
    const result = await mapWithConcurrency([50, 1, 1, 1], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(result).toEqual([50, 1, 1, 1]);
  });

  it("starts the next item as soon as a lane frees up", async () => {
    // The point of lanes over chunks: one slow item must not idle the others.
    // Six 10 ms items in two lanes is ~30 ms if lanes pull, and ~60 ms if the
    // second lane waits for the first to drain.
    const started = performance.now();
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(performance.now() - started).toBeLessThan(55);
  });

  it("rejects rather than hiding a caller that does not handle its own errors", async () => {
    // Swallowing here would hide a bug in the caller instead of in one node.
    await expect(
      mapWithConcurrency([1, 2], 2, (n) =>
        n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n),
      ),
    ).rejects.toThrow("boom");
  });
});
