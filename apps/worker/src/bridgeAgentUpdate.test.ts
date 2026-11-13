import { describe, expect, it } from "vitest";

import type {
  BridgeAgentUpdateReadOutcome,
  BridgeAgentUpdateSendOutcome,
  BridgeAgentUpdateState,
} from "@amnezia/contracts";

import { deliveryChange, nextChange } from "./bridgeAgentUpdate.js";
import type { BridgeUpdateOperation } from "./bridgeUpdateRepository.js";

const T0 = new Date("2026-11-13T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);
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
  notAfter: at(120),
  sendAttemptedAt: T0,
  sentAt: T0,
  acknowledgedAt: null,
  contactLostSince: null,
  acknowledgementOverdueSince: null,
  ...extra,
});

type AgentState = Extract<BridgeAgentUpdateReadOutcome, { kind: "status" }>["status"]["state"];
const status = (state: AgentState, errorCode?: string): BridgeAgentUpdateReadOutcome => ({
  kind: "status",
  status: { operationId: OP, state, updatedAt: T0.toISOString(), ...(errorCode ? { errorCode } : {}) },
});
const noContact: BridgeAgentUpdateReadOutcome = { kind: "no_contact", errorCode: "AGENT_UNREACHABLE" };

describe("bridge-agent update transitions", () => {
  it("maps the agent's states onto the panel's", () => {
    expect(nextChange(operation("sent"), status("picked_up"), at(10))).toMatchObject({
      state: "acknowledged",
      acknowledgedAt: at(10),
      finishedAt: null,
    });
    for (const agentState of ["staging", "replacing", "health_check"] as const) {
      expect(nextChange(operation("acknowledged"), status(agentState), at(20))).toMatchObject({
        state: "running",
        agentState,
      });
    }
    expect(
      nextChange(operation("running"), status("rolled_back", "HEALTH_GATE_FAILED"), at(30)),
    ).toMatchObject({ state: "rolled_back", errorCode: "HEALTH_GATE_FAILED", finishedAt: at(30) });
  });

  it("never moves an operation backwards", () => {
    expect(nextChange(operation("running"), status("picked_up"), at(10))).toEqual({
      lastCheckedAt: at(10),
      contactLostSince: null,
    });
  });

  it("clears the lost-contact observation when the agent answers", () => {
    const lost = operation("running", { contactLostSince: at(5) });
    expect(nextChange(lost, status("health_check"), at(40))).toMatchObject({ contactLostSince: null });
  });

  it("no answer is only an observation, in every outstanding state, and keeps its first time", () => {
    for (const state of ["queued", "sent", "acknowledged", "running"] as const) {
      const first = nextChange(operation(state), noContact, at(9_000));
      expect(first).toMatchObject({ contactLostSince: at(9_000), errorCode: "AGENT_UNREACHABLE" });
      expect(first?.state).toBeUndefined();
      expect(first?.finishedAt).toBeUndefined();
      expect(
        nextChange(operation(state, { contactLostSince: at(100) }), noContact, at(9_500)),
      ).toMatchObject({ contactLostSince: at(100) });
    }
  });

  it("expired is only believed for an unstarted intent", () => {
    for (const state of ["acknowledged", "running"] as const) {
      const change = nextChange(operation(state), status("expired"), at(130));
      expect(change).toMatchObject({ errorCode: "AGENT_UNEXPECTED_STATE" });
      expect(change?.state).toBeUndefined();
      expect(change?.finishedAt).toBeUndefined();
    }
    expect(nextChange(operation("queued"), status("expired"), at(130))).toMatchObject({
      state: "pickup_timeout",
    });
  });

  it("pickup_timeout only comes from the agent confirming expired, and finishes the operation", () => {
    expect(nextChange(operation("sent"), status("expired"), at(130))).toMatchObject({
      state: "pickup_timeout",
      agentState: "expired",
      errorCode: "UPDATE_NOT_ACKNOWLEDGED",
      finishedAt: at(130),
    });
  });

  it("a reachable agent that still says queued past notAfter keeps the operation outstanding and flags it overdue", () => {
    expect(nextChange(operation("sent"), status("queued"), at(60))).toMatchObject({
      state: "sent",
      acknowledgementOverdueSince: null,
      finishedAt: null,
    });
    const overdue = nextChange(operation("sent"), status("queued"), at(130));
    expect(overdue).toMatchObject({
      state: "sent",
      acknowledgementOverdueSince: at(130),
      finishedAt: null,
    });
    // The first overdue time is kept; a later pickup clears the observation.
    expect(
      nextChange(operation("sent", { acknowledgementOverdueSince: at(130) }), status("queued"), at(200))
        ?.acknowledgementOverdueSince,
    ).toEqual(at(130));
    expect(
      nextChange(operation("sent", { acknowledgementOverdueSince: at(130) }), status("picked_up"), at(210)),
    ).toMatchObject({ state: "acknowledged", acknowledgementOverdueSince: null });
  });

  it("an operation the agent does not know is failed, except a queued one, which is re-sent", () => {
    for (const state of ["sent", "acknowledged", "running"] as const) {
      expect(nextChange(operation(state), { kind: "unknown_operation" }, at(50))).toMatchObject({
        state: "failed",
        errorCode: "UPDATE_UNKNOWN_TO_AGENT",
      });
    }
    // A queued one is re-sent only while in date (decided by the tracker);
    // past notAfter the agent's 404 ends it.
    expect(nextChange(operation("queued"), { kind: "unknown_operation" }, at(150))).toMatchObject({
      state: "failed",
      errorCode: "UPDATE_UNKNOWN_TO_AGENT",
    });
  });

  it("an answer for another operation changes nothing but the observed code", () => {
    expect(nextChange(operation("sent"), { kind: "mismatch" }, at(10))).toEqual({
      errorCode: "AGENT_OPERATION_MISMATCH",
      lastCheckedAt: at(10),
    });
  });
});

describe("bridge-agent update delivery", () => {
  const queued = operation("queued", { sendAttemptedAt: null, sentAt: null });
  const accepted = (state: AgentState): BridgeAgentUpdateSendOutcome => ({
    kind: "accepted",
    status: { operationId: OP, state, updatedAt: "x" },
  });

  it("an accepted POST moves the operation to sent; an expired answer ends it as pickup_timeout", () => {
    expect(deliveryChange(queued, accepted("queued"), at(5))).toMatchObject({
      state: "sent",
      sentAt: at(5),
      sendAttemptedAt: at(5),
    });
    expect(deliveryChange(queued, accepted("expired"), at(500))).toMatchObject({
      state: "pickup_timeout",
      finishedAt: at(500),
    });
  });

  it("a refusal fails the operation; an ambiguous answer only records an attempt and lost contact", () => {
    expect(
      deliveryChange(queued, { kind: "rejected", errorCode: "AGENT_UPDATE_UNSUPPORTED" }, at(5)),
    ).toMatchObject({ state: "failed", errorCode: "AGENT_UPDATE_UNSUPPORTED" });
    const ambiguous = deliveryChange(queued, { kind: "retry", errorCode: "AGENT_TIMEOUT" }, at(9_000));
    expect(ambiguous).toMatchObject({
      sendAttemptedAt: at(9_000),
      contactLostSince: at(9_000),
      errorCode: "AGENT_TIMEOUT",
    });
    expect(ambiguous.state).toBeUndefined();
    expect(ambiguous.finishedAt).toBeUndefined();
  });
});
