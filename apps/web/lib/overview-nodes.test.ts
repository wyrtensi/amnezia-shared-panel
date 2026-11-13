import { describe, expect, it } from "vitest";
import { nodesHealthyValue } from "./overview-nodes";

describe("nodesHealthyValue", () => {
  const bridges = {
    count: 2,
    items: [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        name: "A",
        managementStatus: "ok" as const,
        lastObservedAt: null,
        activeRoutes: 1,
        verifiedActiveRoutes: 1,
      },
    ],
  };

  it("counts VPN nodes only, whatever bridges the overview carries", () => {
    const nodes = { total: 3, enabled: 3, healthy: 2 };
    expect(nodesHealthyValue({ nodes }, 9)).toBe("2/3");
    expect(nodesHealthyValue({ nodes, bridges } as never, 9)).toBe("2/3");
  });

  it("falls back to the loaded node list when the overview has no counters", () => {
    expect(nodesHealthyValue({ bridges } as never, 4)).toBe("4");
    expect(nodesHealthyValue(null, 4)).toBe("4");
  });
});
