import { describe, expect, it } from "vitest";
import {
  hasRoomForKey,
  isNodeAvailable,
  nodeIdsWithExplicitLimit,
  resolveNodeKeyLimit,
  resolvePoolKeyLimit,
  resolveQuotaApproval,
  type NodeQuotaContext,
} from "./nodeQuota.js";

const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";

const context = (overrides: Partial<NodeQuotaContext> = {}): NodeQuotaContext => ({
  defaultKeyLimit: 5,
  keyLimitOverride: null,
  nodeKeyLimits: null,
  ...overrides,
});

describe("resolveNodeKeyLimit", () => {
  it("falls back to the global default when nothing is overridden", () => {
    expect(resolveNodeKeyLimit(context(), NODE_A)).toBe(5);
  });

  it("prefers the user override over the global default", () => {
    expect(resolveNodeKeyLimit(context({ keyLimitOverride: 8 }), NODE_A)).toBe(8);
  });

  it("prefers the per-node limit over the user override", () => {
    const resolved = resolveNodeKeyLimit(
      context({ keyLimitOverride: 8, nodeKeyLimits: { [NODE_A]: 2 } }),
      NODE_A,
    );
    expect(resolved).toBe(2);
  });

  it("applies the per-node limit only to its own node", () => {
    const ctx = context({
      keyLimitOverride: 8,
      nodeKeyLimits: { [NODE_A]: 2 },
    });
    expect(resolveNodeKeyLimit(ctx, NODE_A)).toBe(2);
    expect(resolveNodeKeyLimit(ctx, NODE_B)).toBe(8);
  });

  it("treats zero as a real limit at every level, not as 'unset'", () => {
    expect(
      resolveNodeKeyLimit(
        context({ keyLimitOverride: 8, nodeKeyLimits: { [NODE_A]: 0 } }),
        NODE_A,
      ),
    ).toBe(0);
    expect(resolveNodeKeyLimit(context({ keyLimitOverride: 0 }), NODE_A)).toBe(0);
  });

  it("ignores an undefined user override and an absent node entry", () => {
    const resolved = resolveNodeKeyLimit(
      context({ keyLimitOverride: undefined, nodeKeyLimits: { [NODE_B]: 1 } }),
      NODE_A,
    );
    expect(resolved).toBe(5);
  });
});

describe("isNodeAvailable", () => {
  it("allows every node when the policy sets no list", () => {
    expect(isNodeAvailable(null, NODE_A)).toBe(true);
    expect(isNodeAvailable(undefined, NODE_A)).toBe(true);
  });

  it("rejects a node the user is not allowed to use", () => {
    expect(isNodeAvailable([NODE_B], NODE_A)).toBe(false);
  });

  it("accepts a node that is on the allow list", () => {
    expect(isNodeAvailable([NODE_A, NODE_B], NODE_A)).toBe(true);
  });

  it("rejects every node for an empty list, which is not the same as null", () => {
    expect(isNodeAvailable([], NODE_A)).toBe(false);
  });

  it("keeps a per-node limit from making an unavailable node usable", () => {
    const ctx = context({ nodeKeyLimits: { [NODE_A]: 3 } });
    expect(resolveNodeKeyLimit(ctx, NODE_A)).toBe(3);
    expect(isNodeAvailable([NODE_B], NODE_A)).toBe(false);
  });
});

describe("nodeIdsWithExplicitLimit", () => {
  it("is empty when the user has no per-node limits", () => {
    expect(nodeIdsWithExplicitLimit(null)).toEqual([]);
    expect(nodeIdsWithExplicitLimit(undefined)).toEqual([]);
  });

  it("lists every configured node, including ones limited to zero", () => {
    expect(
      nodeIdsWithExplicitLimit({ [NODE_A]: 0, [NODE_B]: 4 }).sort(),
    ).toEqual([NODE_A, NODE_B].sort());
  });
});

describe("resolveQuotaApproval", () => {
  it("grants a per-server request on that server only", () => {
    const approval = resolveQuotaApproval(
      { keyLimitOverride: 4, nodeKeyLimits: { [NODE_B]: 1 } },
      { requestedLimit: 7, nodeId: NODE_A },
      "per_node",
    );
    expect(approval).toEqual({
      keyLimitOverride: 4,
      nodeKeyLimits: { [NODE_A]: 7, [NODE_B]: 1 },
      clearedNodeLimitCount: 0,
      targetCoerced: false,
    });
  });

  it("makes the granted per-node number actually hold on that server", () => {
    // The whole point of F8: the user ran out of room on a server that carried
    // an explicit per-node limit, so the grant has to land there.
    const before = context({
      keyLimitOverride: 4,
      nodeKeyLimits: { [NODE_A]: 1 },
    });
    expect(resolveNodeKeyLimit(before, NODE_A)).toBe(1);

    const approval = resolveQuotaApproval(
      before,
      { requestedLimit: 7, nodeId: NODE_A },
      "per_node",
    );
    const after = context({
      keyLimitOverride: approval.keyLimitOverride,
      nodeKeyLimits: approval.nodeKeyLimits,
    });
    expect(resolveNodeKeyLimit(after, NODE_A)).toBe(7);
    // Every other server keeps the untouched flat override.
    expect(resolveNodeKeyLimit(after, NODE_B)).toBe(4);
  });

  it("raises the flat override for an every-server request", () => {
    const approval = resolveQuotaApproval(
      { keyLimitOverride: null, nodeKeyLimits: null },
      { requestedLimit: 9, nodeId: null },
      "per_node",
    );
    expect(approval).toEqual({
      keyLimitOverride: 9,
      nodeKeyLimits: null,
      clearedNodeLimitCount: 0,
      targetCoerced: false,
    });
  });

  it("clears per-node limits that would shadow an every-server grant", () => {
    const before = context({
      keyLimitOverride: 2,
      nodeKeyLimits: { [NODE_A]: 1, [NODE_B]: 3 },
    });
    const approval = resolveQuotaApproval(
      before,
      { requestedLimit: 9, nodeId: null },
      "per_node",
    );
    expect(approval).toEqual({
      keyLimitOverride: 9,
      nodeKeyLimits: null,
      clearedNodeLimitCount: 2,
      targetCoerced: false,
    });

    const after = context({
      keyLimitOverride: approval.keyLimitOverride,
      nodeKeyLimits: approval.nodeKeyLimits,
    });
    expect(resolveNodeKeyLimit(after, NODE_A)).toBe(9);
    expect(resolveNodeKeyLimit(after, NODE_B)).toBe(9);
  });

  it("never touches the source map, so a rollback cannot see a mutation", () => {
    const nodeKeyLimits = { [NODE_A]: 1 };
    resolveQuotaApproval(
      { keyLimitOverride: null, nodeKeyLimits },
      { requestedLimit: 5, nodeId: NODE_A },
      "per_node",
    );
    expect(nodeKeyLimits).toEqual({ [NODE_A]: 1 });
  });
});

describe("resolvePoolKeyLimit", () => {
  it("is the flat override, else the global default, and ignores per-node entries", () => {
    expect(resolvePoolKeyLimit(context())).toBe(5);
    expect(resolvePoolKeyLimit(context({ keyLimitOverride: 8 }))).toBe(8);
    expect(
      resolvePoolKeyLimit(
        context({ keyLimitOverride: 8, nodeKeyLimits: { [NODE_A]: 1 } }),
      ),
    ).toBe(8);
    expect(resolvePoolKeyLimit(context({ keyLimitOverride: 0 }))).toBe(0);
  });
});

describe("hasRoomForKey", () => {
  it("per-node mode compares the keys on that node with that node's limit", () => {
    const ctx = context({ keyLimitOverride: 3, nodeKeyLimits: { [NODE_A]: 1 } });
    expect(
      hasRoomForKey(ctx, "per_node", NODE_A, { keysOnNode: 0, keysTotal: 9 }),
    ).toBe(true);
    expect(
      hasRoomForKey(ctx, "per_node", NODE_A, { keysOnNode: 1, keysTotal: 1 }),
    ).toBe(false);
    expect(
      hasRoomForKey(ctx, "per_node", NODE_B, { keysOnNode: 2, keysTotal: 9 }),
    ).toBe(true);
  });

  it("global mode compares the total across every node with the pool", () => {
    const ctx = context({ keyLimitOverride: 3, nodeKeyLimits: { [NODE_A]: 1 } });
    // The dormant per-node limit of 1 on A does not block a second key there.
    expect(
      hasRoomForKey(ctx, "global", NODE_A, { keysOnNode: 1, keysTotal: 2 }),
    ).toBe(true);
    // A full pool blocks every node, even one with no keys.
    expect(
      hasRoomForKey(ctx, "global", NODE_B, { keysOnNode: 0, keysTotal: 3 }),
    ).toBe(false);
  });

  it("treats a pool of zero as no keys anywhere", () => {
    expect(
      hasRoomForKey(context({ keyLimitOverride: 0 }), "global", NODE_A, {
        keysOnNode: 0,
        keysTotal: 0,
      }),
    ).toBe(false);
  });
});

describe("resolveQuotaApproval in global mode", () => {
  it("raises the pool for an every-server request and keeps per-node entries dormant", () => {
    const approval = resolveQuotaApproval(
      { keyLimitOverride: 2, nodeKeyLimits: { [NODE_A]: 1 } },
      { requestedLimit: 9, nodeId: null },
      "global",
    );
    expect(approval).toEqual({
      keyLimitOverride: 9,
      nodeKeyLimits: { [NODE_A]: 1 },
      clearedNodeLimitCount: 0,
      targetCoerced: false,
    });
  });

  it("coerces a legacy per-server request into a pool raise and says so", () => {
    const approval = resolveQuotaApproval(
      { keyLimitOverride: 4, nodeKeyLimits: null },
      { requestedLimit: 7, nodeId: NODE_A },
      "global",
    );
    expect(approval).toEqual({
      keyLimitOverride: 7,
      nodeKeyLimits: null,
      clearedNodeLimitCount: 0,
      targetCoerced: true,
    });
    expect(
      resolvePoolKeyLimit(
        context({
          keyLimitOverride: approval.keyLimitOverride,
          nodeKeyLimits: approval.nodeKeyLimits,
        }),
      ),
    ).toBe(7);
  });
});
