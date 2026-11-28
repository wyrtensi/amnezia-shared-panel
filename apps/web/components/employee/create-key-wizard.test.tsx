import { describe, expect, it } from "vitest";
import type { NodeView } from "@/lib/types";
import { buildFlatServerOptions } from "./create-key-wizard";
import { formatQuotaNodeLabel } from "./quota-request-dialog";

const node = (over: Partial<NodeView> = {}): NodeView => ({
  id: "n-1",
  name: "Amsterdam",
  protocol: "awg3",
  maxPeers: 100,
  ...over,
});

describe("buildFlatServerOptions", () => {
  it("flattens multi-variant publicEndpoints into standalone flat server options", () => {
    const options = buildFlatServerOptions([
      node({
        id: "n-1",
        name: "Amsterdam",
        recommended: false,
        publicEndpoints: [
          {
            id: "ep-1",
            ordinal: 1,
            name: "Amsterdam v1",
            recommended: true,
            reachability: { state: "ok", since: null },
          },
          {
            id: "ep-2",
            ordinal: 2,
            name: "Amsterdam v2",
            reachability: { state: "blocked", since: "2026-11-25T10:00:00.000Z" },
          },
        ],
      }),
      node({ id: "n-2", name: "Legacy Frankfurt" }),
    ]);

    expect(options).toEqual([
      {
        key: "ep:ep-1",
        nodeId: "n-1",
        endpointId: "ep-1",
        name: "Amsterdam v1",
        recommended: true,
        reachability: { state: "ok", since: null },
      },
      {
        key: "ep:ep-2",
        nodeId: "n-1",
        endpointId: "ep-2",
        name: "Amsterdam v2",
        recommended: false,
        reachability: { state: "blocked", since: "2026-11-25T10:00:00.000Z" },
      },
      {
        key: "node:n-2",
        nodeId: "n-2",
        endpointId: null,
        name: "Legacy Frankfurt",
        recommended: false,
        reachability: undefined,
      },
    ]);
  });
});

describe("formatQuotaNodeLabel", () => {
  it("groups multi-variant servers cleanly while preserving distinct names", () => {
    expect(
      formatQuotaNodeLabel(
        node({
          publicEndpoints: [
            { id: "1", ordinal: 1, name: "Amsterdam v1" },
            { id: "2", ordinal: 2, name: "Amsterdam v2" },
          ],
        }),
      ),
    ).toBe("Amsterdam (v1, v2)");

    expect(
      formatQuotaNodeLabel(
        node({
          publicEndpoints: [
            { id: "1", ordinal: 1, name: "Amsterdam" },
            { id: "2", ordinal: 2, name: "Rotterdam" },
          ],
        }),
      ),
    ).toBe("Amsterdam, Rotterdam");

    expect(formatQuotaNodeLabel(node({ name: "Berlin" }))).toBe("Berlin");
  });
});
