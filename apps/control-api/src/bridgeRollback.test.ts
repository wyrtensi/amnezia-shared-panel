import { describe, expect, it } from "vitest";

import { bridgeRollbackVerdict } from "./bridgeRollback.js";

const zero = { jobsEnabled: false, activeAssignments: 0, outstandingAgentUpdates: 0, pendingJobs: 0 };

describe("bridgeRollbackVerdict", () => {
  it("is ready with the gate off and nothing left", () => {
    expect(bridgeRollbackVerdict(zero)).toEqual({ readyForPreBridgeRollback: true, blockingReasons: [] });
  });

  it("the gate alone blocks, with its reason", () => {
    expect(bridgeRollbackVerdict({ ...zero, jobsEnabled: true })).toEqual({
      readyForPreBridgeRollback: false,
      blockingReasons: ["BRIDGE_JOBS_ENABLED"],
    });
  });

  it.each([
    ["activeAssignments", "ACTIVE_ASSIGNMENTS"],
    ["outstandingAgentUpdates", "OUTSTANDING_AGENT_UPDATES"],
    ["pendingJobs", "PENDING_BRIDGE_JOBS"],
  ] as const)("a non-zero %s blocks with %s", (field, reason) => {
    expect(bridgeRollbackVerdict({ ...zero, [field]: 1 })).toEqual({
      readyForPreBridgeRollback: false,
      blockingReasons: [reason],
    });
  });

  it("lists every reason when everything blocks", () => {
    expect(
      bridgeRollbackVerdict({ jobsEnabled: true, activeAssignments: 2, outstandingAgentUpdates: 1, pendingJobs: 3 })
        .blockingReasons,
    ).toEqual(["BRIDGE_JOBS_ENABLED", "ACTIVE_ASSIGNMENTS", "OUTSTANDING_AGENT_UPDATES", "PENDING_BRIDGE_JOBS"]);
  });
});
