import { describe, expect, it } from "vitest";

import type { ProbeLevel, ProbeTargetResult } from "@amnezia/contracts";

import {
  alertClock,
  applyExpectedEgress,
  classifyTarget,
  formatAddressesDown,
  formatAddressesUp,
  formatDown,
  formatStale,
  ingestRun,
  nodeStatus,
  OBSOLETE_DETAIL,
  reachabilityTargetId,
  staleTransition,
  type AddressState,
  type BridgePath,
  type NodeState,
  type ReachabilityTarget,
  type TargetAddress,
} from "./reachability.js";

const LABEL = "Testland";
const pass: ProbeLevel = { ok: true, detail: null, latencyMs: 10 };
const fail: ProbeLevel = { ok: false, detail: "timeout", latencyMs: null };
const skip: ProbeLevel = { ok: null, detail: null, latencyMs: null };

const target = (
  name: string,
  protocol: "awg3" | "awg2" = "awg3",
  extra: Partial<ReachabilityTarget> = {},
): ReachabilityTarget => ({
  targetId: reachabilityTargetId(name, protocol, extra.endpointRevision ?? 0),
  nodeId: `id-${name}`,
  nodeName: name,
  publicIp: name === "node-a" ? "192.0.2.10" : "192.0.2.11",
  protocol,
  endpointRevision: 0,
  bridgePath: null,
  unavailableReason: null,
  ...extra,
});

const result = (
  t: ReachabilityTarget,
  levels: Partial<Record<"ping" | "tcp" | "handshake" | "http", ProbeLevel>>,
  extra: Partial<ProbeTargetResult> = {},
): ProbeTargetResult => ({
  targetId: t.targetId,
  protocol: t.protocol,
  status: "done",
  detail: null,
  endpointHost: t.publicIp,
  egressIp: levels.http?.ok ? t.publicIp : null,
  levels: { ping: skip, tcp: skip, handshake: skip, http: skip, ...levels },
  ...extra,
});

const up = (t: ReachabilityTarget) =>
  result(t, { ping: pass, tcp: pass, handshake: pass, http: pass });
const down = (t: ReachabilityTarget) =>
  result(t, { ping: fail, tcp: fail, handshake: fail, http: skip });

const A = target("node-a");
const B = target("node-b");
const C = target("node-c");

const BRIDGE: BridgePath = { bridgeId: "bridge-1", bridgeName: "bridge-a", host: "203.0.113.50", port: 41000 };
const address = (id: string, ip: string, ordinal = 1): TargetAddress => ({
  id, ordinal, address: ip, name: `name-${id}`, checkedAt: null,
});
let addressTargetSerial = 0;
/** An AWG 3 address target: direct to its one address unless a bridge path is given. */
const addressTarget = (
  name: string,
  addresses: TargetAddress[],
  extra: Partial<ReachabilityTarget> = {},
): ReachabilityTarget => {
  addressTargetSerial += 1;
  const via = extra.bridgePath ?? null;
  return {
    ...target(name),
    targetId: `${reachabilityTargetId(`id-${name}`, "awg3", 0)}:${via ? "bridge" : "direct"}:${addressTargetSerial}`,
    publicIp: via ? via.host : (addresses[0]?.address ?? null),
    addresses,
    ...extra,
  };
};

type Run = { targets: ReachabilityTarget[]; results: ProbeTargetResult[]; controlOk?: boolean };

/** Feed runs one after another, carrying state, and collect every notice. */
const simulate = (runs: Run[], start = new Date("2026-01-01T10:00:00Z")) => {
  let previous = new Map<string, NodeState>();
  const previousAddresses = new Map<string, AddressState>();
  const notices: { run: number; dedupKey: string; text: string }[] = [];
  const states: Map<string, NodeState>[] = [];
  runs.forEach((run, index) => {
    const now = new Date(start.getTime() + index * 3_600_000);
    const out = ingestRun({
      runId: `run-${index}`,
      now,
      label: LABEL,
      failThreshold: 2,
      controlOk: run.controlOk ?? true,
      targets: run.targets,
      results: run.results,
      previous,
      previousAddresses: new Map(previousAddresses),
    });
    for (const notice of out.notices) notices.push({ run: index, ...notice });
    previous = new Map(out.states);
    for (const { endpointId, state } of out.addressOutcomes) previousAddresses.set(endpointId, state);
    states.push(previous);
  });
  return { notices, states };
};

describe("classifyTarget", () => {
  it("ok needs handshake and http", () => {
    expect(classifyTarget(A, up(A), true).status).toBe("ok");
    expect(
      classifyTarget(A, result(A, { handshake: pass, http: fail }), true).status,
    ).toBe("failed");
  });

  it("failed when the handshake fails with the control ok", () => {
    const outcome = classifyTarget(A, down(A), true);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toBe("no handshake");
  });

  it("error when the control failed", () => {
    const outcome = classifyTarget(A, down(A), false);
    expect(outcome.status).toBe("error");
    expect(outcome.detail).toBe("control target failed");
  });

  it("error when the probe returned no result for the target", () => {
    expect(classifyTarget(A, undefined, true)).toMatchObject({
      status: "error",
      detail: "probe returned no result",
    });
  });

  it("error when the target has no usable key", () => {
    const noKey = target("node-a", "awg3", { unavailableReason: "service key is provisioning" });
    expect(classifyTarget(noKey, undefined, true)).toMatchObject({
      status: "error",
      detail: "service key is provisioning",
    });
  });

  it("error when the probe could not set the target up", () => {
    expect(
      classifyTarget(A, result(A, {}, { status: "error", detail: "bad config" }), true),
    ).toMatchObject({ status: "error", detail: "bad config" });
  });
});

describe("nodeStatus", () => {
  const o = (status: "ok" | "failed" | "error") => ({ ...classifyTarget(A, up(A), true), status });
  it("any ok wins, then any failed, else error", () => {
    expect(nodeStatus([o("failed"), o("ok")])).toBe("ok");
    expect(nodeStatus([o("failed"), o("failed")])).toBe("failed");
    expect(nodeStatus([o("error"), o("failed")])).toBe("error");
    expect(nodeStatus([o("error"), o("error")])).toBe("error");
    expect(nodeStatus([])).toBe("error");
  });
});

describe("ingestRun: one alert per incident", () => {
  it("one failed run does not alert at threshold 2", () => {
    const { notices } = simulate([{ targets: [A, B], results: [down(A), up(B)] }]);
    expect(notices).toEqual([]);
  });

  it("the second consecutive failed run alerts once, the third sends nothing", () => {
    const run = { targets: [A, B], results: [down(A), up(B)] };
    const { notices } = simulate([run, run, run]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ run: 1 });
    expect(notices[0]?.text).toBe(
      "node-a (192.0.2.10) недоступен из Testland\n" +
        "handshake: нет, tcp/22: нет, ping: нет\n" +
        "с 2026-01-01 10:00 UTC",
    );
    expect(notices[0]?.dedupKey).toBe(
      "notify.reachability:down:id-node-a:2026-01-01T11:00:00.000Z",
    );
  });

  it("ok after an alerted incident sends one recovery and resets counters", () => {
    const bad = { targets: [A, B], results: [down(A), up(B)] };
    const good = { targets: [A, B], results: [up(A), up(B)] };
    const { notices, states } = simulate([bad, bad, good, good]);
    expect(notices.map((n) => n.run)).toEqual([1, 2]);
    expect(notices[1]?.text).toBe("node-a (192.0.2.10) снова доступен из Testland");
    expect(notices[1]?.dedupKey).toBe(
      "notify.reachability:up:id-node-a:2026-01-01T11:00:00.000Z",
    );
    expect(states[2]?.get("id-node-a")).toMatchObject({
      status: "ok",
      consecutiveFailures: 0,
      failingSince: null,
      alertedAt: null,
      alertKind: null,
    });
  });

  it("ok without an open incident sends nothing", () => {
    const { notices } = simulate([
      { targets: [A, B], results: [down(A), up(B)] },
      { targets: [A, B], results: [up(A), up(B)] },
    ]);
    expect(notices).toEqual([]);
  });

  it("error leaves the counter, failingSince and the incident untouched", () => {
    const bad = { targets: [A, B], results: [down(A), up(B)] };
    const lost = { targets: [A, B], results: [up(B)] };
    const { notices, states } = simulate([bad, lost, bad]);
    expect(states[1]?.get("id-node-a")).toMatchObject({
      status: "error",
      consecutiveFailures: 1,
      failingSince: new Date("2026-01-01T10:00:00Z"),
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.run).toBe(2);
  });

  it("error does not close an open incident", () => {
    const bad = { targets: [A, B], results: [down(A), up(B)] };
    const lost = { targets: [A, B], results: [up(B)] };
    const { notices, states } = simulate([bad, bad, lost]);
    expect(notices).toHaveLength(1);
    expect(states[2]?.get("id-node-a")?.alertedAt).toEqual(
      new Date("2026-01-01T11:00:00Z"),
    );
  });

  it("control failure: every node is error and nothing is sent", () => {
    const bad = { targets: [A, B], results: [down(A), down(B)] };
    const { notices, states } = simulate([
      { ...bad, controlOk: false },
      { ...bad, controlOk: false },
      { ...bad, controlOk: false },
    ]);
    expect(notices).toEqual([]);
    expect(states[2]?.get("id-node-a")).toMatchObject({
      status: "error",
      consecutiveFailures: 0,
    });
  });

  it("failingSince is set on the first failure and carried", () => {
    const bad = { targets: [A, B], results: [down(A), up(B)] };
    const { states } = simulate([bad, bad, bad]);
    expect(states[2]?.get("id-node-a")?.failingSince).toEqual(
      new Date("2026-01-01T10:00:00Z"),
    );
  });

  it("two incidents on the same node get distinct dedup keys", () => {
    const bad = { targets: [A, B], results: [down(A), up(B)] };
    const good = { targets: [A, B], results: [up(A), up(B)] };
    const { notices } = simulate([bad, bad, good, bad, bad]);
    const downs = notices.filter((n) => n.dedupKey.includes(":down:"));
    expect(downs).toHaveLength(2);
    expect(new Set(downs.map((n) => n.dedupKey)).size).toBe(2);
  });

  it("a node is ok when any of its protocols is ok", () => {
    const A2 = target("node-a", "awg2");
    const { notices, states } = simulate([
      { targets: [A, A2, B], results: [down(A), up(A2), up(B)] },
      { targets: [A, A2, B], results: [down(A), up(A2), up(B)] },
    ]);
    expect(notices).toEqual([]);
    expect(states[1]?.get("id-node-a")?.status).toBe("ok");
  });

  it("the down message uses the levels of the failing protocol", () => {
    const tcpUp = result(A, { ping: fail, tcp: pass, handshake: fail });
    const { notices } = simulate([
      { targets: [A, B], results: [tcpUp, up(B)] },
      { targets: [A, B], results: [tcpUp, up(B)] },
    ]);
    expect(notices[0]?.text).toContain("handshake: нет, tcp/22: да, ping: нет");
  });

  it("an unknown public IP reads as ?", () => {
    const noIp = target("node-a", "awg3", { publicIp: null });
    const { notices } = simulate([
      { targets: [noIp, B], results: [down(noIp), up(B)] },
      { targets: [noIp, B], results: [down(noIp), up(B)] },
    ]);
    expect(notices[0]?.text.startsWith("node-a (?) недоступен из Testland")).toBe(true);
  });
});

describe("ingestRun: every node failing at once", () => {
  const allDown = { targets: [A, B, C], results: [down(A), down(B), down(C)] };

  it("sends one combined message instead of one per node", () => {
    const { notices, states } = simulate([allDown, allDown]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe(
      "Проверка из Testland: не ответил ни один из 3: node-a, node-b, node-c. " +
        "Возможно, сломалась сама проверка.",
    );
    expect(notices[0]?.dedupKey).toBe("notify.reachability:mass-down:run-1");
    expect(states[1]?.get("id-node-b")?.alertKind).toBe("mass");
  });

  it.each([
    { endpointHost: "192.0.2.20", massFailure: false, savedStatus: ["ok"], alertKinds: ["down", "down"] },
    { endpointHost: "192.0.2.21", massFailure: true, savedStatus: [], alertKinds: ["mass-down"] },
  ])("uses direct success for the mass verdict only when it measured the configured address ($endpointHost)", ({
    endpointHost, massFailure, savedStatus, alertKinds,
  }) => {
    const secondary = addressTarget("node-c", [address("backup", "192.0.2.20")]);
    const out = ingestRun({
      runId: "run-1",
      now: new Date("2026-01-01T10:00:00Z"),
      label: LABEL,
      failThreshold: 1,
      controlOk: true,
      targets: [A, B, secondary],
      results: [down(A), down(B), { ...up(secondary), endpointHost }],
      previous: new Map(),
      previousAddresses: new Map(),
    });

    expect(out.states.get(A.nodeId)?.status).toBe("failed");
    expect(out.states.get(B.nodeId)?.status).toBe("failed");
    expect(out.addressOutcomes.map(({ status }) => status)).toEqual(savedStatus);
    expect(out.massFailure).toBe(massFailure);
    expect(out.notices.map(({ dedupKey }) => dedupKey.split(":")[1])).toEqual(alertKinds);
  });

  it("needs at least two attempted nodes", () => {
    const { notices } = simulate([
      { targets: [A], results: [down(A)] },
      { targets: [A], results: [down(A)] },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.dedupKey).toContain(":down:id-node-a:");
  });

  it("a handshake anywhere means it is not a probe failure", () => {
    const httpOnly = result(B, { handshake: pass, http: fail });
    const run = { targets: [A, B, C], results: [down(A), httpOnly, down(C)] };
    const { notices } = simulate([run, run]);
    expect(notices).toHaveLength(3);
    expect(notices.every((n) => n.dedupKey.includes(":down:"))).toBe(true);
  });

  it("an egress check failing on every tunnel is a probe failure too", () => {
    const egressDown = (t: ReachabilityTarget) =>
      result(t, { ping: pass, tcp: pass, handshake: pass, http: fail });
    const run = { targets: [A, B, C], results: [egressDown(A), egressDown(B), egressDown(C)] };
    const { notices } = simulate([run, run]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.dedupKey).toBe("notify.reachability:mass-down:run-1");
  });

  it("a node with one protocol unmeasured is unknown, not unavailable", () => {
    const A2 = target("node-a", "awg2", { unavailableReason: "service key failed: x" });
    const run = { targets: [A, A2, B], results: [down(A), up(B)] };
    const { notices, states } = simulate([run, run]);
    expect(notices).toEqual([]);
    expect(states[1]?.get("id-node-a")?.status).toBe("error");
  });

  it("does not list a node whose incident is already open", () => {
    const aDown = { targets: [A, B, C], results: [down(A), up(B), up(C)] };
    const { notices } = simulate([aDown, aDown, allDown, allDown]);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toContain("не ответил ни один из 2: node-b, node-c");
  });

  it("nodes recovering together send one combined recovery", () => {
    const allUp = { targets: [A, B, C], results: [up(A), up(B), up(C)] };
    const { notices } = simulate([allDown, allDown, allUp]);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toBe("Проверка из Testland: снова доступны node-a, node-b, node-c");
    expect(notices[1]?.dedupKey).toBe("notify.reachability:mass-up:run-2");
  });

  it("a single node of a mass incident recovers with its own message", () => {
    const aUp = { targets: [A, B, C], results: [up(A), down(B), down(C)] };
    const { notices } = simulate([allDown, allDown, aUp]);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toBe("node-a (192.0.2.10) снова доступен из Testland");
  });
});

describe("staleTransition", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const base = {
    label: LABEL,
    staleAfterSec: 10_800,
    intervalSec: 3_600,
    since,
    lastResultAt: new Date("2026-01-01T01:00:00Z"),
    staleAlertedAt: null as Date | null,
    ingestedNow: false,
  };

  it("does nothing while results are fresh", () => {
    expect(staleTransition({ ...base, now: new Date("2026-01-01T03:59:00Z") })).toEqual({
      staleAlertedAt: null,
      notices: [],
    });
  });

  it("sends one message when the probe goes silent", () => {
    const now = new Date("2026-01-01T04:00:01Z");
    const out = staleTransition({ ...base, now });
    expect(out.staleAlertedAt).toEqual(now);
    expect(out.notices).toEqual([
      {
        dedupKey: "notify.reachability:stale:2026-01-01T04:00:01.000Z",
        text: "Проверка из Testland не присылает результатов с 2026-01-01 01:00 UTC",
      },
    ]);
    const again = staleTransition({
      ...base,
      now: new Date("2026-01-01T05:00:00Z"),
      staleAlertedAt: now,
    });
    expect(again).toEqual({ staleAlertedAt: now, notices: [] });
  });

  it("measures from when monitoring started before the first result", () => {
    const out = staleTransition({
      ...base,
      lastResultAt: null,
      now: new Date("2026-01-01T03:00:01Z"),
    });
    expect(out.notices[0]?.text).toContain("с 2026-01-01 00:00 UTC");
  });

  it("an ingested run closes the stale incident with one message", () => {
    const alertedAt = new Date("2026-01-01T04:00:01Z");
    const out = staleTransition({
      ...base,
      now: new Date("2026-01-01T06:00:00Z"),
      staleAlertedAt: alertedAt,
      ingestedNow: true,
    });
    expect(out).toEqual({
      staleAlertedAt: null,
      notices: [
        {
          dedupKey: "notify.reachability:stale-back:2026-01-01T04:00:01.000Z",
          text: "Проверка из Testland снова работает",
        },
      ],
    });
  });
});

describe("alert times", () => {
  const at = new Date("2026-11-10T14:46:00Z");

  it("are UTC without a zone, exactly as before", () => {
    expect(alertClock(at)).toBe("2026-11-10 14:46 UTC");
    expect(formatStale(LABEL, at)).toBe(
      "Проверка из Testland не присылает результатов с 2026-11-10 14:46 UTC",
    );
    expect(formatDown({ nodeName: "node-a", publicIp: "192.0.2.10" }, LABEL, null, at)).toContain(
      "с 2026-11-10 14:46 UTC",
    );
  });

  it("follow the configured zone, named after the time", () => {
    expect(alertClock(at, "Europe/Belgrade")).toBe("2026-11-10 15:46 Europe/Belgrade");
    // Across midnight and daylight saving: July is UTC+2 there.
    expect(alertClock(new Date("2026-07-01T22:30:00Z"), "Europe/Belgrade")).toBe(
      "2026-07-02 00:30 Europe/Belgrade",
    );
    expect(formatStale(LABEL, at, "Europe/Belgrade")).toContain("с 2026-11-10 15:46 Europe/Belgrade");
  });

  it("reach the unavailable message and the stale message", () => {
    const first = ingestRun({
      runId: "r1",
      now: new Date("2026-01-01T10:00:00Z"),
      label: LABEL,
      timeZone: "Europe/Belgrade",
      failThreshold: 1,
      controlOk: true,
      targets: [A, B],
      results: [down(A), up(B)],
      previous: new Map(),
      previousAddresses: new Map(),
    });
    expect(first.notices[0]?.text).toContain("с 2026-01-01 11:00 Europe/Belgrade");

    const stale = staleTransition({
      now: new Date("2026-01-01T04:00:01Z"),
      label: LABEL,
      timeZone: "Europe/Belgrade",
      staleAfterSec: 10_800,
      intervalSec: 3_600,
      lastResultAt: new Date("2026-01-01T01:00:00Z"),
      since: new Date("2025-12-31T00:00:00Z"),
      staleAlertedAt: null,
      ingestedNow: false,
    });
    expect(stale.notices[0]?.text).toContain("с 2026-01-01 02:00 Europe/Belgrade");
  });
});

describe("ingestRun: endpoint revisions and bridged nodes", () => {
  const bridge: BridgePath = { bridgeName: "Bridge-1", host: "203.0.113.50", port: 41000 };
  // node-a after a Direct -> bridge switch: revision 1, AWG 3.1 via the bridge.
  const A3 = target("node-a", "awg3", { endpointRevision: 1, bridgePath: bridge });
  const A2 = target("node-a", "awg2", { endpointRevision: 1, bridgePath: bridge });
  // The same targets as dispatched before the switch (revision 0, Direct).
  const oldA3 = target("node-a", "awg3");

  it("a result for an earlier endpoint revision is unknown: not stored, not counted, no alert", () => {
    const { notices, states } = simulate([
      { targets: [A3, B], results: [down(oldA3), up(B)] },
      { targets: [A3, B], results: [down(oldA3), up(B)] },
    ]);
    expect(notices).toEqual([]);
    expect(states[1]?.get("id-node-a")).toMatchObject({
      status: "error",
      consecutiveFailures: 0,
      alertedAt: null,
    });
    const out = ingestRun({
      runId: "r",
      now: new Date(),
      label: LABEL,
      failThreshold: 1,
      controlOk: true,
      targets: [A3],
      results: [down(oldA3)],
      previous: new Map(),
      previousAddresses: new Map(),
    });
    expect(out.outcomes).toEqual([
      expect.objectContaining({ protocol: "awg3", status: "error", detail: OBSOLETE_DETAIL, obsolete: true }),
    ]);
    expect(out.notices).toEqual([]);
  });

  it("an obsolete AWG 3.1 result keeps a failed AWG 2 on a Direct node unknown, not failed", () => {
    // node-a went bridge -> Direct (revision 2) while a revision-1 run was out.
    const direct3 = target("node-a", "awg3", { endpointRevision: 2 });
    const direct2 = target("node-a", "awg2", { endpointRevision: 2 });
    const bridged3 = target("node-a", "awg3", { endpointRevision: 1, bridgePath: bridge });
    const { notices, states } = simulate([
      { targets: [direct3, direct2, B], results: [down(bridged3), down(direct2), up(B)] },
      { targets: [direct3, direct2, B], results: [down(bridged3), down(direct2), up(B)] },
    ]);
    expect(notices).toEqual([]);
    expect(states[1]?.get("id-node-a")).toMatchObject({ status: "error", consecutiveFailures: 0 });
  });

  it("keeps the direct AWG 2 evidence of a run whose AWG 3.1 result is obsolete", () => {
    const out = ingestRun({
      runId: "r",
      now: new Date(),
      label: LABEL,
      failThreshold: 2,
      controlOk: true,
      targets: [A3, A2],
      // AWG 2 has no revision in its id: the switch did not change its path.
      results: [down(oldA3), up(A2)],
      previous: new Map(),
      previousAddresses: new Map(),
    });
    const stored = out.outcomes.filter((o) => !o.obsolete);
    expect(stored).toEqual([expect.objectContaining({ protocol: "awg2", status: "ok" })]);
  });

  it("judges a bridged node on its AWG 3.1 path alone and names the bridge in the alert", () => {
    const { notices, states } = simulate([
      { targets: [A3, A2, B], results: [down(A3), up(A2), up(B)] },
      { targets: [A3, A2, B], results: [down(A3), up(A2), up(B)] },
      { targets: [A3, A2, B], results: [up(A3), up(A2), up(B)] },
    ]);
    expect(states[1]?.get("id-node-a")?.status).toBe("failed");
    expect(notices.map((n) => [n.run, n.text.split("\n")[0]])).toEqual([
      [1, "node-a (192.0.2.10) через мост Bridge-1 (203.0.113.50:41000) недоступен из Testland"],
      [2, "node-a (192.0.2.10) через мост Bridge-1 (203.0.113.50:41000) снова доступен из Testland"],
    ]);
  });

  it("a working bridge keeps a bridged node ok when its direct AWG 2 fails", () => {
    const { notices, states } = simulate([
      { targets: [A3, A2, B], results: [up(A3), down(A2), up(B)] },
      { targets: [A3, A2, B], results: [up(A3), down(A2), up(B)] },
    ]);
    expect(notices).toEqual([]);
    expect(states[1]?.get("id-node-a")?.status).toBe("ok");
  });

  it("a bridged AWG 3.1 path the probe could not measure is unknown and never alerts", () => {
    const unmeasured = { ...A3, unavailableReason: "bridged path not measured" };
    const { notices, states } = simulate([
      { targets: [unmeasured, A2, B], results: [up(A2), up(B)] },
      { targets: [unmeasured, A2, B], results: [up(A2), up(B)] },
    ]);
    expect(notices).toEqual([]);
    // Not ok on the strength of AWG 2: the bridged path is unknown.
    expect(states[1]?.get("id-node-a")?.status).toBe("error");
  });

  it("an AWG 3.1 id without a revision (a pre-revision worker's run) matches revision 0", () => {
    const legacy = { ...up(oldA3), targetId: "node-a:awg3" };
    const out = ingestRun({
      runId: "r",
      now: new Date(),
      label: LABEL,
      failThreshold: 2,
      controlOk: true,
      targets: [oldA3],
      results: [legacy],
      previous: new Map(),
      previousAddresses: new Map(),
    });
    expect(out.outcomes).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(oldA3.targetId).toBe("node-a:awg3:r0");
  });

  it("writes a bridged group's verdict to each of its addresses and keeps direct addresses independent", () => {
    const bridged = addressTarget("node-a", [address("ep-bridged-1", "192.0.2.10"), address("ep-bridged-2", "192.0.2.12")], {
      bridgePath: BRIDGE,
    });
    const direct = addressTarget("node-a", [address("ep-direct", "198.51.100.20")], { nodeBridged: true });
    const diagnostic = {
      ...addressTarget("node-a", [address("ep-bridged-1", "192.0.2.10")], { bridgePath: BRIDGE }),
      targetId: "id-node-a:awg3:r0:direct:diag",
      diagnostic: true as const,
    };
    const out = ingestRun({
      runId: "r-mixed",
      now: new Date(),
      label: LABEL,
      failThreshold: 2,
      controlOk: true,
      targets: [bridged, direct, diagnostic],
      results: [
        up(bridged),
        { ...down(direct), endpointHost: "198.51.100.20" },
        { ...down(diagnostic), endpointHost: "192.0.2.10" },
      ],
      previous: new Map(),
      previousAddresses: new Map(),
    });
    expect(out.addressOutcomes.map(({ endpointId, status }) => [endpointId, status])).toEqual([
      ["ep-bridged-1", "ok"],
      ["ep-bridged-2", "ok"],
      ["ep-direct", "failed"],
    ]);
  });

});

describe("ingestRun per address", () => {
  const now = new Date("2026-01-01T10:00:00Z");
  const run = (
    targets: ReachabilityTarget[],
    results: ProbeTargetResult[],
    previousAddresses = new Map<string, AddressState>(),
    previous = new Map<string, NodeState>(),
  ) => ingestRun({
    runId: "run-1", now, label: LABEL, failThreshold: 1, controlOk: true,
    targets, results, previous, previousAddresses,
  });
  const alerted = (kind: "node" | "mass" = "node"): AddressState => ({
    consecutiveFailures: 1, failingSince: new Date("2026-01-01T09:00:00Z"), alertedAt: new Date("2026-01-01T09:00:00Z"), alertKind: kind,
  });

  it("opens one message for two addresses of a node failing in the same run", () => {
    const first = addressTarget("node-a", [address("ep-1", "192.0.2.10", 1)]);
    const second = addressTarget("node-a", [address("ep-2", "192.0.2.20", 2)]);
    const other = addressTarget("node-b", [address("ep-3", "192.0.2.30")]);
    const out = run([first, second, other], [down(first), down(second), up(other)]);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]?.text).toContain("node-a: недоступны адреса из Testland");
    expect(out.notices[0]?.text).toContain("name-ep-1 (192.0.2.10)");
    expect(out.notices[0]?.text).toContain("name-ep-2 (192.0.2.20)");
    expect(out.addressOutcomes.filter(({ state }) => state.alertedAt !== null).map(({ endpointId }) => endpointId))
      .toEqual(["ep-1", "ep-2"]);
  });

  it("names the bridge for a bridged address", () => {
    const bridged = addressTarget("node-a", [address("ep-1", "192.0.2.10")], { bridgePath: BRIDGE });
    const other = addressTarget("node-b", [address("ep-2", "192.0.2.30")]);
    const out = run([bridged, other], [down(bridged), up(other)]);
    expect(out.notices.map(({ text }) => text.split("\n")[0])).toEqual([
      "Адрес name-ep-1 (192.0.2.10) через мост bridge-a (203.0.113.50:41000) недоступен из Testland",
    ]);
  });

  it("keeps the node summary available while one address answers", () => {
    const first = addressTarget("node-a", [address("ep-1", "192.0.2.10", 1)]);
    const second = addressTarget("node-a", [address("ep-2", "192.0.2.20", 2)]);
    const out = run([first, second], [down(first), up(second)]);
    expect(out.states.get("id-node-a")?.status).toBe("ok");
    expect(out.notices.map(({ text }) => text.split("\n")[0])).toEqual([
      "Адрес name-ep-1 (192.0.2.10) недоступен из Testland",
    ]);
  });

  it("never opens a node incident on an address node and closes an old one once", () => {
    const only = addressTarget("node-a", [address("ep-1", "192.0.2.10")]);
    const other = addressTarget("node-b", [address("ep-2", "192.0.2.30")]);
    const failed = run([only, other], [down(only), up(other)]);
    expect(failed.states.get("id-node-a")).toMatchObject({ status: "failed", alertedAt: null });
    expect(failed.notices.map(({ dedupKey }) => dedupKey.split(":")[1])).toEqual(["addresses-down"]);

    const old: NodeState = {
      status: "failed", consecutiveFailures: 3, failingSince: new Date("2026-01-01T08:00:00Z"),
      alertedAt: new Date("2026-01-01T08:30:00Z"), alertKind: "node", checkedAt: new Date("2026-01-01T09:00:00Z"), detail: null,
    };
    const back = run([only], [up(only)], new Map(), new Map([["id-node-a", old]]));
    expect(back.states.get("id-node-a")).toMatchObject({ status: "ok", alertedAt: null });
    expect(back.notices.map(({ text }) => text)).toEqual(["node-a (192.0.2.10) снова доступен из Testland"]);
  });

  it("sends one combined message in a mass run and none per address", () => {
    const first = addressTarget("node-a", [address("ep-1", "192.0.2.10")]);
    const second = addressTarget("node-b", [address("ep-2", "192.0.2.20")]);
    const out = run([first, second], [down(first), down(second)]);
    expect(out.massFailure).toBe(true);
    expect(out.notices.map(({ dedupKey }) => dedupKey.split(":")[1])).toEqual(["mass-down"]);
    expect(out.notices[0]?.text).toContain("name-ep-1 (192.0.2.10), name-ep-2 (192.0.2.20)");
    expect(out.addressOutcomes.map(({ state }) => state.alertKind)).toEqual(["mass", "mass"]);
  });

  it("combines the recovery of two mass incidents", () => {
    const first = addressTarget("node-a", [address("ep-1", "192.0.2.10")]);
    const second = addressTarget("node-b", [address("ep-2", "192.0.2.20")]);
    const out = run(
      [first, second],
      [up(first), up(second)],
      new Map([["ep-1", alerted("mass")], ["ep-2", alerted("mass")]]),
    );
    expect(out.notices.map(({ dedupKey }) => dedupKey.split(":")[1])).toEqual(["mass-up"]);
    expect(out.addressOutcomes.map(({ state }) => state.alertedAt)).toEqual([null, null]);
  });

  it("error keeps an address incident as it was", () => {
    const only = addressTarget("node-a", [address("ep-1", "192.0.2.10")]);
    const previous = alerted();
    const out = run([only], [{ ...down(only), status: "error", detail: "probe error" }], new Map([["ep-1", previous]]));
    expect(out.addressOutcomes).toEqual([expect.objectContaining({ endpointId: "ep-1", status: "error", state: previous })]);
    expect(out.notices).toEqual([]);
  });

  it("stores the path row as AWG 3 when the node's AWG 2 target comes first", () => {
    const awg2 = target("node-a", "awg2");
    const direct = addressTarget("node-a", [address("ep-1", "192.0.2.10")], { nodeBridged: true });
    const out = run([awg2, direct], [up(awg2), up(direct)]);
    expect(out.outcomes.map(({ protocol, status, detail }) => [protocol, status, detail])).toEqual([
      ["awg2", "ok", null],
      ["awg3", "error", "no address uses the bridge"],
    ]);

    const deferred = addressTarget("node-a", [address("ep-1", "192.0.2.10")]);
    const kept = run([awg2, deferred], [up(awg2)]);
    expect(kept.outcomes.map(({ protocol, obsolete }) => [protocol, obsolete === true])).toEqual([
      ["awg2", false],
      ["awg3", true],
    ]);
  });

  it("writes nothing for an address whose target returned no result", () => {
    const measured = addressTarget("node-a", [address("ep-1", "192.0.2.10", 1)]);
    const deferred = addressTarget("node-a", [address("ep-2", "192.0.2.20", 2)]);
    const out = run([measured, deferred], [up(measured)]);
    expect(out.addressOutcomes.map(({ endpointId }) => endpointId)).toEqual(["ep-1"]);
  });

  it("reports an unsendable address target as unknown for its addresses", () => {
    const unsupported = addressTarget("node-a", [address("ep-1", "192.0.2.10")], {
      bridgePath: BRIDGE, unavailableReason: "bridged path not measured",
    });
    const out = run([unsupported], []);
    expect(out.addressOutcomes).toEqual([
      expect.objectContaining({ endpointId: "ep-1", status: "error", detail: "bridged path not measured" }),
    ]);
  });

  it("path row: a bridged node takes the best bridged group, never a direct address", () => {
    const bridged = addressTarget("node-a", [address("ep-1", "192.0.2.10", 1)], { bridgePath: BRIDGE });
    const direct = addressTarget("node-a", [address("ep-2", "192.0.2.20", 2)], { nodeBridged: true });
    const out = run([bridged, direct], [down(bridged), up(direct)]);
    const awg3 = out.outcomes.filter((outcome) => outcome.protocol === "awg3");
    expect(awg3).toEqual([expect.objectContaining({ nodeId: "id-node-a", status: "failed" })]);

    const onlyDirect = run([direct], [up(direct)]);
    expect(onlyDirect.outcomes).toEqual([
      expect.objectContaining({ nodeId: "id-node-a", status: "error", detail: "no address uses the bridge" }),
    ]);
  });

  it("path row: a direct node takes its best address", () => {
    const first = addressTarget("node-a", [address("ep-1", "192.0.2.10", 1)]);
    const second = addressTarget("node-a", [address("ep-2", "192.0.2.20", 2)]);
    const out = run([first, second], [down(first), up(second)]);
    expect(out.outcomes).toEqual([expect.objectContaining({ nodeId: "id-node-a", protocol: "awg3", status: "ok" })]);
  });

  it("verifies expectedEgressIp per address, downgrades mismatches, and formats entry → exit alerts", () => {
    const matchedAddr: TargetAddress = {
      ...address("ep-ok", "192.0.2.10", 1),
      expectedEgressIp: "198.51.100.20",
    };
    const mismatchedAddr: TargetAddress = {
      ...address("ep-mismatch", "192.0.2.11", 2),
      expectedEgressIp: "198.51.100.30",
    };
    const tOk = addressTarget("node-a", [matchedAddr]);
    const tMismatch = addressTarget("node-b", [mismatchedAddr]);

    const resOk = { ...up(tOk), egressIp: "198.51.100.20" };
    const resMismatch = { ...up(tMismatch), egressIp: "198.51.100.99" };
    const sim = simulate(
      [
        { targets: [tOk, tMismatch], results: [resOk, resMismatch] },
        { targets: [tOk, tMismatch], results: [resOk, resMismatch] },
      ],
      new Date("2026-01-01T10:00:00Z"),
    );

    expect(sim.states[0]?.get("id-node-a")?.status).toBe("ok");
    expect(sim.states[0]?.get("id-node-b")?.status).toBe("failed");

    const single = ingestRun({
      runId: "run-egress",
      now: new Date("2026-01-01T10:00:00Z"),
      label: LABEL,
      failThreshold: 1,
      controlOk: true,
      targets: [tOk, tMismatch],
      results: [resOk, resMismatch],
      previous: new Map(),
      previousAddresses: new Map(),
    });
    expect(single.addressOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpointId: "ep-ok",
          status: "ok",
          observedEgressIp: "198.51.100.20",
          egressMatch: true,
        }),
        expect.objectContaining({
          endpointId: "ep-mismatch",
          status: "failed",
          observedEgressIp: "198.51.100.99",
          egressMatch: false,
          detail: "egress mismatch: expected 198.51.100.30, got 198.51.100.99",
        }),
      ]),
    );
    const mismatchOutcome = single.addressOutcomes.find((o) => o.endpointId === "ep-mismatch");
    expect(mismatchOutcome?.levels?.handshake).toEqual(pass);
    expect(mismatchOutcome?.levels?.http).toMatchObject({
      ok: false,
      detail: "egress mismatch: expected 198.51.100.30, got 198.51.100.99",
    });
    expect(single.massFailure).toBe(false);
    expect(single.notices[0]?.text).toContain("name-ep-mismatch (192.0.2.11 → 198.51.100.30)");
    expect(single.notices[0]?.text).toContain("egress mismatch: expected 198.51.100.30, got 198.51.100.99");

    const sameText = formatAddressesDown(
      "node-a",
      [
        {
          name: "direct",
          address: "198.51.100.10",
          expectedEgressIp: "198.51.100.10",
          detail: "no handshake",
          bridgePath: null,
          levels: null,
          since: new Date("2026-01-01T10:00:00Z"),
        },
      ],
      LABEL,
    );
    expect(sameText).toContain("direct (198.51.100.10)");
    expect(sameText).not.toContain("→");

    const upText = formatAddressesUp(
      "node-b",
      [
        {
          name: "de-entry",
          address: "192.0.2.11",
          expectedEgressIp: "198.51.100.30",
          bridgePath: null,
        },
      ],
      LABEL,
    );
    expect(upText).toContain("de-entry (192.0.2.11 → 198.51.100.30)");

    const applied = applyExpectedEgress(classifyTarget(tOk, { ...up(tOk), egressIp: null }, true), "198.51.100.20");
    expect(applied.outcome.status).toBe("failed");
    expect(applied.egressMatch).toBe(false);
  });
});
