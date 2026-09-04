import { describe, expect, it } from "vitest";
import {
  materializeNodeOrder,
  moveNodeInOrder,
  moveNodeToIndex,
  recommendedCountFromIds,
  recommendedPrefix,
  recommendNode,
  unrecommendNode,
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

describe("recommendNode", () => {
  it("raises a node into the recommended prefix instead of recommending everything above it", () => {
    const order = ["a", "b", "c", "d"];
    const next = recommendNode(order, 1, "c");
    expect(next.nodeOrder).toEqual(["a", "c", "b", "d"]);
    expect(next.recommendedNodeIds).toEqual(["a", "c"]);
  });

  it("recommends the top row without moving anything", () => {
    const next = recommendNode(["a", "b", "c"], 0, "a");
    expect(next.nodeOrder).toEqual(["a", "b", "c"]);
    expect(next.recommendedNodeIds).toEqual(["a"]);
  });

  it("promotes the last row all the way to the top when nothing is recommended", () => {
    const next = recommendNode(["a", "b", "c"], 0, "c");
    expect(next.nodeOrder).toEqual(["c", "a", "b"]);
    expect(next.recommendedNodeIds).toEqual(["c"]);
  });

  it("is a no-op for a row that is already recommended", () => {
    const next = recommendNode(["a", "b", "c"], 2, "b");
    expect(next.nodeOrder).toEqual(["a", "b", "c"]);
    expect(next.recommendedNodeIds).toEqual(["a", "b"]);
  });

  it("is a no-op for an unknown id, and keeps the prefix honest", () => {
    const next = recommendNode(["a", "b"], 1, "zz");
    expect(next.nodeOrder).toEqual(["a", "b"]);
    expect(next.recommendedNodeIds).toEqual(["a"]);
  });

  it("never mutates the input", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    recommendNode(input, 0, "c");
    expect(input).toEqual(snapshot);
  });
});

describe("unrecommendNode", () => {
  it("drops one node out of the prefix and leaves the rest recommended", () => {
    const next = unrecommendNode(["a", "b", "c", "d"], 3, "a");
    // "a" lands directly under the shrunken prefix, not at the bottom.
    expect(next.nodeOrder).toEqual(["b", "c", "a", "d"]);
    expect(next.recommendedNodeIds).toEqual(["b", "c"]);
  });

  it("keeps the last recommended row in place when it is the one unticked", () => {
    const next = unrecommendNode(["a", "b", "c", "d"], 3, "c");
    expect(next.nodeOrder).toEqual(["a", "b", "c", "d"]);
    expect(next.recommendedNodeIds).toEqual(["a", "b"]);
  });

  it("is a no-op for a row that is not recommended", () => {
    const next = unrecommendNode(["a", "b", "c"], 1, "c");
    expect(next.nodeOrder).toEqual(["a", "b", "c"]);
    expect(next.recommendedNodeIds).toEqual(["a"]);
  });

  it("is a no-op for an unknown id", () => {
    const next = unrecommendNode(["a", "b"], 2, "zz");
    expect(next.nodeOrder).toEqual(["a", "b"]);
    expect(next.recommendedNodeIds).toEqual(["a", "b"]);
  });

  it("never mutates the input", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    unrecommendNode(input, 2, "a");
    expect(input).toEqual(snapshot);
  });
});
