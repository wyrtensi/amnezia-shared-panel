import { describe, expect, it } from "vitest";

import type { ProbeLevel, ProbeTargetResult } from "@amnezia/contracts";

import {
  alertClock,
  classifyTarget,
  formatDown,
  formatStale,
  ingestRun,
  nodeStatus,
  staleTransition,
  type NodeState,
  type ReachabilityTarget,
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
  targetId: `${name}:${protocol}`,
  nodeId: `id-${name}`,
  nodeName: name,
  publicIp: name === "node-a" ? "192.0.2.10" : "192.0.2.11",
  protocol,
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

type Run = { targets: ReachabilityTarget[]; results: ProbeTargetResult[]; controlOk?: boolean };

/** Feed runs one after another, carrying state, and collect every notice. */
const simulate = (runs: Run[], start = new Date("2026-01-01T10:00:00Z")) => {
  let previous = new Map<string, NodeState>();
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
    });
    for (const notice of out.notices) notices.push({ run: index, ...notice });
    previous = new Map(out.states);
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
      "Проверка из Testland: ни одна нода не ответила (3): node-a, node-b, node-c. " +
        "Возможно, сломалась сама проверка.",
    );
    expect(notices[0]?.dedupKey).toBe("notify.reachability:mass-down:run-1");
    expect(states[1]?.get("id-node-b")?.alertKind).toBe("mass");
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
    expect(notices[1]?.text).toContain("(2): node-b, node-c");
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
