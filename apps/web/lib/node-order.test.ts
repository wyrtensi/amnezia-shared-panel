import { describe, expect, it } from "vitest";
import {
  materializeNodeOrder,
  moveNodeInOrder,
  moveNodeToIndex,
  recommendedCountFromIds,
  recommendedPrefix,
} from "./node-order";

const nodes = [
  { id: "a", name: "alpha" },
  { id: "b", name: "bravo" },
  { id: "c", name: "charlie" },
];

describe("materializeNodeOrder", () => {
  it("puts saved positions first, in the saved order", () => {
    expect(materializeNodeOrder(nodes, ["c", "a"])).toEqual(["c", "a", "b"]);
  });

  it("sorts unsaved nodes by name — nothing else lifts them", () => {
    expect(materializeNodeOrder(nodes, [])).toEqual(["a", "b", "c"]);
  });

  it("drops saved ids whose node is gone and keeps every current node once", () => {
    const result = materializeNodeOrder(nodes, ["zz", "b", "b"]);
    expect(result).toEqual(["b", "a", "c"]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("returns an empty list for an empty fleet", () => {
    expect(materializeNodeOrder([], ["a"])).toEqual([]);
  });
});

describe("moveNodeInOrder", () => {
  it("swaps a node with its neighbour", () => {
    expect(moveNodeInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveNodeInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the edges and for an unknown id", () => {
    expect(moveNodeInOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveNodeInOrder(["a", "b"], "b", 1)).toEqual(["a", "b"]);
    expect(moveNodeInOrder(["a", "b"], "zz", -1)).toEqual(["a", "b"]);
  });

  it("never mutates the input", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    moveNodeInOrder(input, "a", 1);
    expect(input).toEqual(snapshot);
  });
});

describe("recommendedCountFromIds", () => {
  it("counts the saved recommendations as a prefix length", () => {
    expect(recommendedCountFromIds(["a", "b", "c"], ["a", "b"])).toBe(2);
    expect(recommendedCountFromIds(["a", "b", "c"], [])).toBe(0);
    expect(recommendedCountFromIds(["a", "b"], ["a", "b"])).toBe(2);
  });

  it("ignores the sequence the ids were saved in", () => {
    // The API stores them in order sequence, but the editor must not depend
    // on that.
    expect(recommendedCountFromIds(["a", "b", "c"], ["b", "a"])).toBe(2);
  });

  it("stops at the first unrecommended row, so a broken row cannot spread", () => {
    // Only reachable from a hand-edited database: "c" is recommended but "b"
    // is not. The editor shows the longest honest prefix instead of throwing.
    expect(recommendedCountFromIds(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(recommendedCountFromIds(["a", "b"], ["zz"])).toBe(0);
  });
});

describe("recommendedPrefix", () => {
  it("takes the first n ids", () => {
    expect(recommendedPrefix(["a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(recommendedPrefix(["a", "b", "c"], 0)).toEqual([]);
  });

  it("clamps out-of-range counts instead of producing holes", () => {
    expect(recommendedPrefix(["a", "b"], 9)).toEqual(["a", "b"]);
    expect(recommendedPrefix(["a", "b"], -3)).toEqual([]);
  });
});

describe("moveNodeToIndex", () => {
  it("moves a row to an absolute position, in both directions", () => {
    // What a drag produces: the row lands where it was dropped, and the rows
    // it passed close up behind it.
    expect(moveNodeToIndex(["a", "b", "c", "d"], "d", 0)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
    expect(moveNodeToIndex(["a", "b", "c", "d"], "a", 3)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  it("clamps a drop outside the list instead of leaving a hole", () => {
    expect(moveNodeToIndex(["a", "b"], "a", 9)).toEqual(["b", "a"]);
    expect(moveNodeToIndex(["a", "b"], "b", -4)).toEqual(["b", "a"]);
  });

  it("is a no-op for the same position and for an unknown id", () => {
    expect(moveNodeToIndex(["a", "b"], "a", 0)).toEqual(["a", "b"]);
    // A row that vanished mid-drag must not corrupt the order.
    expect(moveNodeToIndex(["a", "b"], "zz", 0)).toEqual(["a", "b"]);
  });

  it("never mutates the input", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    moveNodeToIndex(input, "c", 0);
    expect(input).toEqual(snapshot);
  });
});
