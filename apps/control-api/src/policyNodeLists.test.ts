import { describe, expect, it } from "vitest";
import { checkRecommendedPrefix, dedupeNodeIds } from "./policyNodeLists.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("dedupeNodeIds", () => {
  it("keeps the first occurrence in place", () => {
    expect(dedupeNodeIds([id(2), id(1), id(2)])).toEqual([id(2), id(1)]);
  });
});

describe("checkRecommendedPrefix", () => {
  it("accepts the empty recommended set against any order", () => {
    expect(checkRecommendedPrefix([], [])).toEqual({ ok: true, canonical: [] });
    expect(checkRecommendedPrefix([], [id(1), id(2)])).toEqual({
      ok: true,
      canonical: [],
    });
  });

  it("accepts a true prefix and canonicalizes it into order sequence", () => {
    // Sent out of order on purpose: the check is on the SET, the stored form
    // follows the order.
    expect(
      checkRecommendedPrefix([id(2), id(1)], [id(1), id(2), id(3)]),
    ).toEqual({ ok: true, canonical: [id(1), id(2)] });
  });

  it("accepts recommending the whole order", () => {
    expect(checkRecommendedPrefix([id(1), id(2)], [id(1), id(2)])).toEqual({
      ok: true,
      canonical: [id(1), id(2)],
    });
  });

  it("rejects a node that sits behind an unrecommended one, naming it", () => {
    // id(3) is at position 3 while position 2 is not recommended.
    expect(
      checkRecommendedPrefix([id(1), id(3)], [id(1), id(2), id(3)]),
    ).toEqual({
      ok: false,
      nodeId: id(3),
      reason: "behind",
      position: 3,
    });
  });

  it("rejects a node that is not in the order at all", () => {
    expect(checkRecommendedPrefix([id(9)], [id(1), id(2)])).toEqual({
      ok: false,
      nodeId: id(9),
      reason: "unpositioned",
      position: null,
    });
  });

  it("rejects anything recommended while the order is empty", () => {
    // The state right after the migration: nothing is positioned, so nothing
    // can be recommended.
    expect(checkRecommendedPrefix([id(1)], [])).toEqual({
      ok: false,
      nodeId: id(1),
      reason: "unpositioned",
      position: null,
    });
  });

  it("reports the offending node closest to the top first", () => {
    // Both id(2) and id(4) are out of place; the message should name the one
    // the admin will fix first.
    const result = checkRecommendedPrefix(
      [id(2), id(4)],
      [id(1), id(2), id(3), id(4)],
    );
    expect(result).toMatchObject({ ok: false, nodeId: id(2), position: 2 });
  });
});
