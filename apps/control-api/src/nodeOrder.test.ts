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

  it("follows the manual order, whatever the names say", () => {
    const rows = [
      node("a0000000-0000-4000-8000-000000000001", "alpha"),
      node("b0000000-0000-4000-8000-000000000002", "bravo"),
      node("c0000000-0000-4000-8000-000000000003", "charlie"),
    ];
    // The admin put charlie at the top and alpha at the bottom.
    const ordered = orderNodesForUsers(rows, [
      "c0000000-0000-4000-8000-000000000003",
      "b0000000-0000-4000-8000-000000000002",
      "a0000000-0000-4000-8000-000000000001",
    ]);
    expect(ordered.map((row) => row.name)).toEqual([
      "charlie",
      "bravo",
      "alpha",
    ]);
  });

  it("depends on nothing but the rows and the order", () => {
    // The only inputs are the rows and the order: there is no recommended
    // parameter to pass, so no badge can move a node. An empty order therefore
    // gives plain name order, whatever the policy marks as recommended.
    const rows = [
      node("b0000000-0000-4000-8000-000000000002", "bravo"),
      node("a0000000-0000-4000-8000-000000000001", "alpha"),
    ];
    expect(orderNodesForUsers(rows, []).map((row) => row.name)).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(orderNodesForUsers(rows)).toEqual(orderNodesForUsers(rows, []));
  });

  it("sorts nodes with no manual position after the positioned ones, by name", () => {
    const rows = [
      node("a0000000-0000-4000-8000-000000000001", "alpha"), // unpositioned
      node("b0000000-0000-4000-8000-000000000002", "bravo"), // unpositioned
      node("c0000000-0000-4000-8000-000000000003", "charlie"), // positioned
    ];
    expect(
      orderNodesForUsers(rows, [
        "c0000000-0000-4000-8000-000000000003",
      ]).map((row) => row.name),
    ).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("closes the gap when a node in the middle of the manual order is missing", () => {
    const order = [
      "a0000000-0000-4000-8000-000000000001",
      "b0000000-0000-4000-8000-000000000002",
      "c0000000-0000-4000-8000-000000000003",
    ];
    // "bravo" is hidden from this user (or deleted): the rest keeps its order
    // and no hole appears.
    const rows = [
      node("c0000000-0000-4000-8000-000000000003", "charlie"),
      node("a0000000-0000-4000-8000-000000000001", "alpha"),
    ];
    expect(orderNodesForUsers(rows, order).map((row) => row.name)).toEqual([
      "alpha",
      "charlie",
    ]);
  });

  it("ignores ids in the manual order that match no row, and stays total", () => {
    const rows = [
      node("b0000000-0000-4000-8000-000000000002", "bravo"),
      node("a0000000-0000-4000-8000-000000000001", "alpha"),
    ];
    const ghostOrder = ["ffffffff-0000-4000-8000-000000000000"];
    const ordered = orderNodesForUsers(rows, ghostOrder);
    expect(ordered.map((row) => row.name)).toEqual(["alpha", "bravo"]);
    // Same input in the other order gives the same result: the key is total.
    expect(orderNodesForUsers([...rows].reverse(), ghostOrder)).toEqual(ordered);
  });

  it("sorts on the public name when there is one", () => {
    const rows = [
      {
        id: "a0000000-0000-4000-8000-000000000001",
        name: "zzz",
        publicName: "alpha",
      },
      {
        id: "b0000000-0000-4000-8000-000000000002",
        name: "aaa",
        publicName: null,
      },
    ];
    expect(orderNodesForUsers(rows).map((row) => row.id)).toEqual([
      "b0000000-0000-4000-8000-000000000002", // "aaa"
      "a0000000-0000-4000-8000-000000000001", // "alpha"
    ]);
  });

});
