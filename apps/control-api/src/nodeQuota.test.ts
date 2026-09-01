import { describe, expect, it } from "vitest";
import {
  isNodeAvailable,
  nodeIdsWithExplicitLimit,
  resolveNodeKeyLimit,
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
    );
    expect(approval).toEqual({
      keyLimitOverride: 4,
      nodeKeyLimits: { [NODE_A]: 7, [NODE_B]: 1 },
      clearedNodeLimitCount: 0,
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

    const approval = resolveQuotaApproval(before, {
      requestedLimit: 7,
      nodeId: NODE_A,
    });
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
    );
    expect(approval).toEqual({
      keyLimitOverride: 9,
      nodeKeyLimits: null,
      clearedNodeLimitCount: 0,
    });
  });

  it("clears per-node limits that would shadow an every-server grant", () => {
    const before = context({
      keyLimitOverride: 2,
      nodeKeyLimits: { [NODE_A]: 1, [NODE_B]: 3 },
    });
    const approval = resolveQuotaApproval(before, {
      requestedLimit: 9,
      nodeId: null,
    });
    expect(approval).toEqual({
      keyLimitOverride: 9,
      nodeKeyLimits: null,
      clearedNodeLimitCount: 2,
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
    resolveQuotaApproval({ keyLimitOverride: null, nodeKeyLimits }, {
      requestedLimit: 5,
      nodeId: NODE_A,
    });
    expect(nodeKeyLimits).toEqual({ [NODE_A]: 1 });
  });
});
