import { describe, expect, it } from "vitest";
import {
  EGRESS_AUTO_ROTATE_COOLDOWN_MS,
  formatEgressAutoRotateNotice,
  selectAutoRotateExitIp,
  shouldTriggerEgressAutoRotate,
  type AutoRotateExitRecord,
} from "./egressAutoRotate.js";

const makeExit = (over: Partial<AutoRotateExitRecord> & { id: string; ipv4: string }): AutoRotateExitRecord => ({
  label: null,
  enabled: true,
  hostState: "active",
  ...over,
});

describe("shouldTriggerEgressAutoRotate", () => {
  const now = new Date("2026-11-28T10:00:00Z");

  it("triggers when an endpoint outage alert opens in routed mode", () => {
    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: false,
        nodeEgressMode: "routed",
        endpoint: { enabled: true, egressAutoRotateEnabled: true, egressAutoRotatedAt: null },
        outcome: { status: "failed", state: { consecutiveFailures: 2, alertedAt: now } },
        failThreshold: 2,
        now,
      }),
    ).toBe(true);
  });

  it("does not trigger on mass failures, masquerade mode, disabled flag, or below threshold", () => {
    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: true,
        nodeEgressMode: "routed",
        endpoint: { enabled: true, egressAutoRotateEnabled: true, egressAutoRotatedAt: null },
        outcome: { status: "failed", state: { consecutiveFailures: 2, alertedAt: now } },
        failThreshold: 2,
        now,
      }),
    ).toBe(false);

    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: false,
        nodeEgressMode: "masquerade",
        endpoint: { enabled: true, egressAutoRotateEnabled: true, egressAutoRotatedAt: null },
        outcome: { status: "failed", state: { consecutiveFailures: 2, alertedAt: now } },
        failThreshold: 2,
        now,
      }),
    ).toBe(false);

    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: false,
        nodeEgressMode: "routed",
        endpoint: { enabled: true, egressAutoRotateEnabled: false, egressAutoRotatedAt: null },
        outcome: { status: "failed", state: { consecutiveFailures: 2, alertedAt: now } },
        failThreshold: 2,
        now,
      }),
    ).toBe(false);

    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: false,
        nodeEgressMode: "routed",
        endpoint: { enabled: true, egressAutoRotateEnabled: true, egressAutoRotatedAt: null },
        outcome: { status: "failed", state: { consecutiveFailures: 1, alertedAt: null } },
        failThreshold: 2,
        now,
      }),
    ).toBe(false);
  });

  it("supports chained rotation after cooldown when an ongoing incident fails again", () => {
    const earlierAlert = new Date(now.getTime() - 10 * 60_000);
    const withinCooldown = new Date(now.getTime() - 10_000);
    const pastCooldown = new Date(now.getTime() - EGRESS_AUTO_ROTATE_COOLDOWN_MS - 1_000);

    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: false,
        nodeEgressMode: "routed",
        endpoint: { enabled: true, egressAutoRotateEnabled: true, egressAutoRotatedAt: withinCooldown },
        outcome: { status: "failed", state: { consecutiveFailures: 2, alertedAt: earlierAlert } },
        failThreshold: 2,
        now,
      }),
    ).toBe(false);

    expect(
      shouldTriggerEgressAutoRotate({
        massFailure: false,
        nodeEgressMode: "routed",
        endpoint: { enabled: true, egressAutoRotateEnabled: true, egressAutoRotatedAt: pastCooldown },
        outcome: { status: "failed", state: { consecutiveFailures: 2, alertedAt: earlierAlert } },
        failThreshold: 2,
        now,
      }),
    ).toBe(true);
  });
});

describe("selectAutoRotateExitIp", () => {
  const exit1 = makeExit({ id: "ex-1", ipv4: "198.51.100.1", label: "Primary" });
  const exit2 = makeExit({ id: "ex-2", ipv4: "198.51.100.2", label: "Backup A" });
  const exit3 = makeExit({ id: "ex-3", ipv4: "198.51.100.3", label: "Backup B" });
  const exitBadHost = makeExit({ id: "ex-bad", ipv4: "198.51.100.4", hostState: "missing_ip" });
  const exitDisabled = makeExit({ id: "ex-off", ipv4: "198.51.100.5", enabled: false });
  const nodeExits = [exit1, exit2, exit3, exitBadHost, exitDisabled];

  it("picks round-robin starting after the current Exit IP", () => {
    const res = selectAutoRotateExitIp({
      endpoint: {
        id: "ep-1",
        address: "192.0.2.10",
        egressIpId: "ex-2",
        egressAutoRotatePoolIds: ["ex-1", "ex-2", "ex-3"],
      },
      nodeEgressDefaultIpId: "ex-1",
      nodeExits,
      occupiedSiblingExitIds: new Set(),
      failingExitCheckIds: new Set(),
      unhealthyEndpointExitIds: new Set(),
    });
    expect(res).toEqual({ previousExit: exit2, nextExit: exit3 });

    const wrap = selectAutoRotateExitIp({
      endpoint: {
        id: "ep-1",
        address: "192.0.2.10",
        egressIpId: "ex-3",
        egressAutoRotatePoolIds: ["ex-1", "ex-2", "ex-3"],
      },
      nodeEgressDefaultIpId: "ex-1",
      nodeExits,
      occupiedSiblingExitIds: new Set(),
      failingExitCheckIds: new Set(),
      unhealthyEndpointExitIds: new Set(),
    });
    expect(wrap).toEqual({ previousExit: exit3, nextExit: exit1 });
  });

  it("skips disabled, non-active, sibling-occupied, and unhealthy exits while preferring check-passing exits", () => {
    const res = selectAutoRotateExitIp({
      endpoint: {
        id: "ep-1",
        address: "192.0.2.10",
        egressIpId: "ex-1",
        egressAutoRotatePoolIds: ["ex-1", "ex-bad", "ex-off", "ex-2", "ex-3"],
      },
      nodeEgressDefaultIpId: "ex-1",
      nodeExits,
      occupiedSiblingExitIds: new Set(["ex-2"]),
      failingExitCheckIds: new Set(),
      unhealthyEndpointExitIds: new Set(),
    });
    expect(res).toEqual({ previousExit: exit1, nextExit: exit3 });

    const preferCleanChecks = selectAutoRotateExitIp({
      endpoint: {
        id: "ep-1",
        address: "192.0.2.10",
        egressIpId: "ex-1",
        egressAutoRotatePoolIds: ["ex-1", "ex-2", "ex-3"],
      },
      nodeEgressDefaultIpId: "ex-1",
      nodeExits,
      occupiedSiblingExitIds: new Set(),
      failingExitCheckIds: new Set(["ex-2"]),
      unhealthyEndpointExitIds: new Set(),
    });
    expect(preferCleanChecks).toEqual({ previousExit: exit1, nextExit: exit3 });

    const fallbackToFailingChecks = selectAutoRotateExitIp({
      endpoint: {
        id: "ep-1",
        address: "192.0.2.10",
        egressIpId: "ex-1",
        egressAutoRotatePoolIds: ["ex-1", "ex-2"],
      },
      nodeEgressDefaultIpId: "ex-1",
      nodeExits,
      occupiedSiblingExitIds: new Set(),
      failingExitCheckIds: new Set(["ex-2"]),
      unhealthyEndpointExitIds: new Set(),
    });
    expect(fallbackToFailingChecks).toEqual({ previousExit: exit1, nextExit: exit2 });
  });

  it("returns null when all pool exits are occupied or unhealthy", () => {
    expect(
      selectAutoRotateExitIp({
        endpoint: {
          id: "ep-1",
          address: "192.0.2.10",
          egressIpId: "ex-1",
          egressAutoRotatePoolIds: ["ex-1", "ex-2", "ex-3"],
        },
        nodeEgressDefaultIpId: "ex-1",
        nodeExits,
        occupiedSiblingExitIds: new Set(["ex-2"]),
        failingExitCheckIds: new Set(),
        unhealthyEndpointExitIds: new Set(["ex-3"]),
      }),
    ).toBeNull();
  });

  it("formats notification text clearly", () => {
    expect(
      formatEgressAutoRotateNotice({
        nodeName: "de-01",
        endpointName: "DE Main",
        address: "192.0.2.10",
        previousExit: exit1,
        nextExit: exit2,
      }),
    ).toBe("🔄 Авторотация Exit IP: de-01 — DE Main (192.0.2.10)\n198.51.100.1 (Primary) → 198.51.100.2 (Backup A)");
  });
});
