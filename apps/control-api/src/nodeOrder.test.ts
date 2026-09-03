import { describe, expect, it } from "vitest";
import { orderNodesForUsers } from "./nodeOrder.js";

const node = (id: string, name: string) => ({ id, name, extra: `${id}-x` });

describe("orderNodesForUsers", () => {
  it("orders by display name, case-insensitively and numerically", () => {
    const rows = [
      node("b0000000-0000-4000-8000-000000000002", "server 10"),
      node("a0000000-0000-4000-8000-000000000001", "Server 2"),
      node("c0000000-0000-4000-8000-000000000003", "amsterdam"),
    ];
    expect(orderNodesForUsers(rows).map((row) => row.name)).toEqual([
      "amsterdam",
      "Server 2",
      "server 10",
    ]);
  });

  it("breaks name ties by id so equal names never swap between calls", () => {
    const rows = [
      node("b0000000-0000-4000-8000-000000000002", "Same"),
      node("a0000000-0000-4000-8000-000000000001", "same"),
    ];
    expect(orderNodesForUsers(rows).map((row) => row.id)).toEqual([
      "a0000000-0000-4000-8000-000000000001",
      "b0000000-0000-4000-8000-000000000002",
    ]);
  });

  it("is independent of the input order and does not mutate it", () => {
    const rows = [
      node("c0000000-0000-4000-8000-000000000003", "c"),
      node("a0000000-0000-4000-8000-000000000001", "a"),
      node("b0000000-0000-4000-8000-000000000002", "b"),
    ];
    const snapshot = [...rows];
    const forward = orderNodesForUsers(rows);
    const backward = orderNodesForUsers([...rows].reverse());
    expect(forward).toEqual(backward);
    expect(rows).toEqual(snapshot);
    // Extra fields on the rows survive untouched.
    expect(forward[0]?.extra).toBe("a0000000-0000-4000-8000-000000000001-x");
  });
});
