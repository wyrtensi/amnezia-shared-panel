import { describe, expect, it } from "vitest";

import type { BridgeAgentUpdateReadOutcome, BridgeAgentUpdateState } from "@amnezia/contracts";

import { nextChange } from "./bridgeAgentUpdate.js";
import type { BridgeUpdateOperation } from "./bridgeUpdateRepository.js";

const T0 = new Date("2026-11-13T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);
const DEADLINE = 120_000;
const OP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

const operation = (
  state: BridgeAgentUpdateState,
  extra: Partial<BridgeUpdateOperation> = {},
): BridgeUpdateOperation => ({
  id: OP,
  bridgeId: "6f1d2c1e-7d0f-4a8e-9f0a-3c3d5e8b1a01",
  imageRepository: "ghcr.io/example/amnezia/bridge-agent",
  imageDigest: `sha256:${"a".repeat(64)}`,
  state,
  requestedAt: T0,
  sentAt: T0,
  acknowledgedAt: null,
  contactLostSince: null,
  ...extra,
});

const status = (
  state: Extract<BridgeAgentUpdateReadOutcome, { kind: "status" }>["status"]["state"],
  errorCode?: string,
): BridgeAgentUpdateReadOutcome => ({
  kind: "status",
  status: { operationId: OP, state, updatedAt: T0.toISOString(), ...(errorCode ? { errorCode } : {}) },
});

describe("bridge-agent update transitions", () => {
  it("maps the agent's states onto the panel's", () => {
    expect(nextChange(operation("sent"), status("picked_up"), at(10), DEADLINE)).toMatchObject({
      state: "acknowledged",
      acknowledgedAt: at(10),
      finishedAt: null,
    });
    for (const agentState of ["staging", "replacing", "health_check"] as const) {
      expect(nextChange(operation("acknowledged"), status(agentState), at(20), DEADLINE)).toMatchObject({
        state: "running",
        agentState,
      });
    }
    expect(nextChange(operation("running"), status("rolled_back", "HEALTH_GATE_FAILED"), at(30), DEADLINE)).toMatchObject({
      state: "rolled_back",
      errorCode: "HEALTH_GATE_FAILED",
      finishedAt: at(30),
    });
  });

  it("never moves an operation backwards", () => {
    expect(nextChange(operation("running"), status("picked_up"), at(10), DEADLINE)).toEqual({
      lastCheckedAt: at(10),
    });
  });

  it("clears the lost-contact observation when the agent answers", () => {
    const lost = operation("running", { contactLostSince: at(5) });
    expect(nextChange(lost, status("health_check"), at(40), DEADLINE)).toMatchObject({
      contactLostSince: null,
    });
  });

  it("lost contact after the host started is an observation that keeps its first time", () => {
    const noContact: BridgeAgentUpdateReadOutcome = { kind: "no_contact", errorCode: "AGENT_UNREACHABLE" };
    expect(nextChange(operation("running"), noContact, at(500), DEADLINE)).toMatchObject({
      contactLostSince: at(500),
    });
    expect(
      nextChange(operation("running", { contactLostSince: at(100) }), noContact, at(600), DEADLINE),
    ).toMatchObject({ contactLostSince: at(100) });
    // No state change: only the host's own terminal result ends it.
    expect(nextChange(operation("running"), noContact, at(9_000), DEADLINE)?.state).toBeUndefined();
  });

  it("lost contact before any pickup is not contact_lost and times out after the deadline", () => {
    const noContact: BridgeAgentUpdateReadOutcome = { kind: "no_contact", errorCode: "AGENT_TIMEOUT" };
    const early = nextChange(operation("sent"), noContact, at(60), DEADLINE);
    expect(early).toEqual({ errorCode: "AGENT_TIMEOUT", lastCheckedAt: at(60) });
    expect(nextChange(operation("sent"), noContact, at(121), DEADLINE)).toMatchObject({
      state: "pickup_timeout",
      errorCode: "UPDATE_NOT_ACKNOWLEDGED",
    });
  });

  it("the deadline runs from the send time, from the request time while undelivered", () => {
    const queuedAgent = status("queued");
    expect(
      nextChange(operation("sent", { sentAt: at(100) }), queuedAgent, at(200), DEADLINE),
    ).toMatchObject({ state: "sent" });
    expect(
      nextChange(operation("sent", { sentAt: at(100) }), queuedAgent, at(221), DEADLINE),
    ).toMatchObject({ state: "pickup_timeout" });
  });

  it("a running operation never times out as unacknowledged", () => {
    expect(
      nextChange(operation("running"), { kind: "unknown_operation" }, at(9_000), DEADLINE),
    ).toEqual({ errorCode: "AGENT_OPERATION_UNKNOWN", lastCheckedAt: at(9_000) });
  });

  it("a pickup_timeout operation only moves on a report that the host started", () => {
    const late = operation("pickup_timeout");
    expect(nextChange(late, status("queued"), at(500), DEADLINE)).toBeNull();
    expect(nextChange(late, { kind: "no_contact", errorCode: "AGENT_UNREACHABLE" }, at(500), DEADLINE)).toBeNull();
    expect(nextChange(late, { kind: "unknown_operation" }, at(500), DEADLINE)).toBeNull();
    expect(nextChange(late, status("replacing"), at(500), DEADLINE)).toMatchObject({
      state: "running",
      finishedAt: null,
      acknowledgedAt: at(500),
    });
  });

  it("an answer for another operation changes nothing but the observed code", () => {
    expect(nextChange(operation("sent"), { kind: "mismatch" }, at(10), DEADLINE)).toEqual({
      errorCode: "AGENT_OPERATION_MISMATCH",
      lastCheckedAt: at(10),
    });
  });
});
