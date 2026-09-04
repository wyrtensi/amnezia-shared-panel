import { describe, expect, it } from "vitest";
import {
  selectDueChecks,
  toCheckRequests,
  toResultRows,
  type NodeServiceCheck,
  type PreviousResult,
} from "./serviceChecks.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const check: NodeServiceCheck = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Google Flow",
  probe: { kind: "http", url: "https://labs.google/fx/tools/flow/" },
  assertions: [
    { type: "statusIn", statuses: [200] },
    { type: "finalUrlOmits", value: "unsupported-country" },
  ],
  intervalSec: 43_200,
  enabled: true,
  // Deliberately BEFORE every `checkedAt` used below. `nextDueAt` is only the
  // "run now" marker and the due rule fires when it is newer than the last
  // result - a fixture value of 09:59 would have made the run-now branch fire in
  // every case here and silently masked the period and retry tests. The two
  // run-now cases override it explicitly.
  nextDueAt: new Date("2026-09-02T08:00:00.000Z"),
};

// Scheduling is per (node, check): this is what THIS node last recorded.
const previous = (
  over: Partial<PreviousResult> = {},
): Map<string, PreviousResult> =>
  new Map([
    [
      check.id,
      {
        status: "ok" as const,
        checkedAt: new Date("2026-09-02T09:00:00.000Z"),
        failingSince: null,
        ...over,
      },
    ],
  ]);

describe("selectDueChecks", () => {
  it("treats a check this node has never run as due", () => {
    // A node added five minutes ago must not wait twelve hours for its first
    // reading; this is the case the per-node schedule exists for.
    expect(selectDueChecks([check], new Map(), now)).toHaveLength(1);
  });

  it("skips a disabled check even when it is due", () => {
    expect(
      selectDueChecks([{ ...check, enabled: false }], new Map(), now),
    ).toEqual([]);
  });

  it("skips a check measured an hour ago when the period is twelve", () => {
    expect(selectDueChecks([check], previous(), now)).toEqual([]);
  });

  it("takes a check whose last measurement is older than the period", () => {
    expect(
      selectDueChecks(
        [check],
        previous({ checkedAt: new Date("2026-09-01T21:00:00.000Z") }),
        now,
      ),
    ).toHaveLength(1);
  });

  it("retries an error after five minutes instead of waiting the full period", () => {
    // "error" means nothing was measured. Waiting twelve hours to find out
    // whether a two-second DNS blip is over is the bug this prevents.
    const sixMinutesAgo = new Date("2026-09-02T09:54:00.000Z");
    expect(
      selectDueChecks(
        [check],
        previous({
          status: "error",
          checkedAt: sixMinutesAgo,
          failingSince: sixMinutesAgo,
        }),
        now,
      ),
    ).toHaveLength(1);
  });

  it("does not retry a failed check early - that was a real measurement", () => {
    const sixMinutesAgo = new Date("2026-09-02T09:54:00.000Z");
    expect(
      selectDueChecks(
        [check],
        previous({
          status: "failed",
          checkedAt: sixMinutesAgo,
          failingSince: sixMinutesAgo,
        }),
        now,
      ),
    ).toEqual([]);
  });

  it("stops fast-retrying after an hour of continuous errors", () => {
    const sixMinutesAgo = new Date("2026-09-02T09:54:00.000Z");
    const twoHoursAgo = new Date("2026-09-02T08:00:00.000Z");
    expect(
      selectDueChecks(
        [check],
        previous({
          status: "error",
          checkedAt: sixMinutesAgo,
          failingSince: twoHoursAgo,
        }),
        now,
      ),
    ).toEqual([]);
  });

  it("runs once more when the admin pressed Run now after the last result", () => {
    expect(
      selectDueChecks(
        [{ ...check, nextDueAt: new Date("2026-09-02T09:30:00.000Z") }],
        previous({ checkedAt: new Date("2026-09-02T09:00:00.000Z") }),
        now,
      ),
    ).toHaveLength(1);
  });

  it("does not run again for a Run now that predates the last result", () => {
    expect(
      selectDueChecks(
        [{ ...check, nextDueAt: new Date("2026-09-02T08:00:00.000Z") }],
        previous({ checkedAt: new Date("2026-09-02T09:00:00.000Z") }),
        now,
      ),
    ).toEqual([]);
  });

  it("uses each check's own interval, not one shared period", () => {
    // The 12-hour default belongs to a check, per check. Two checks with
    // different periods and identical last-run times must not come due
    // together, or the "one shared knob" that was ruled out has crept back in
    // through the scheduler.
    const tenMinutesAgo = new Date("2026-09-02T09:50:00.000Z");
    const slow = { ...check, intervalSec: 43_200 };
    const fast = {
      ...check,
      id: "22222222-2222-4222-8222-222222222222",
      intervalSec: 300,
    };
    const seen = new Map<string, PreviousResult>([
      [slow.id, { status: "ok", checkedAt: tenMinutesAgo, failingSince: null }],
      [fast.id, { status: "ok", checkedAt: tenMinutesAgo, failingSince: null }],
    ]);
    expect(selectDueChecks([slow, fast], seen, now).map((c) => c.id)).toEqual([
      fast.id,
    ]);
  });

  it("cannot run more often than the telemetry tick, and says so", () => {
    // A check period below TELEMETRY_POLL_SEC is rounded up in practice,
    // because dispatch only happens on a tick. This is a property of the
    // CALLER, not of selectDueChecks: at 60 s the check is due whenever a tick
    // finds it older than 60 s, and the poller simply calls once a minute.
    // Asserted so nobody reads the rounding as drift and "fixes" it.
    const fifteenSecondsAgo = new Date("2026-09-02T09:59:45.000Z");
    expect(
      selectDueChecks(
        [{ ...check, intervalSec: 60 }],
        previous({ checkedAt: fifteenSecondsAgo }),
        now,
      ),
    ).toEqual([]);
  });
});

describe("toCheckRequests", () => {
  it("sends the stored definition verbatim", () => {
    // The worker is a courier here. If it reshaped a probe or an assertion, a
    // rule added to the contract and the agent would still need a worker
    // release before any node could run it - which is the coupling the open set
    // exists to remove.
    expect(toCheckRequests([check])).toEqual([
      { id: check.id, probe: check.probe, assertions: check.assertions },
    ]);
  });
});

describe("toResultRows", () => {
  const failed = {
    id: check.id,
    status: "failed" as const,
    httpStatus: 200,
    latencyMs: 412,
    finalUrl: "https://labs.google/fx/tools/flow/unsupported-country",
    detail: 'final URL contains "unsupported-country"',
  };

  it("opens failingSince on the first failure", () => {
    const [row] = toResultRows("node-1", [failed], new Map(), now);
    expect(row?.failingSince).toEqual(now);
  });

  it("carries the observed final url into the row", () => {
    const [row] = toResultRows("node-1", [failed], new Map(), now);
    expect(row?.finalUrl).toBe(
      "https://labs.google/fx/tools/flow/unsupported-country",
    );
  });

  it("truncates an absurdly long final url to the column width", () => {
    const long = `https://example.test/${"a".repeat(900)}`;
    const [row] = toResultRows(
      "node-1",
      [{ ...failed, finalUrl: long }],
      new Map(),
      now,
    );
    expect(row?.finalUrl?.length).toBe(500);
  });

  it("carries the original failingSince forward while it stays broken", () => {
    // An operator needs "broken since 08:00", not "broken since the last tick".
    const since = new Date("2026-09-02T08:00:00.000Z");
    const seen = new Map<string, PreviousResult>([
      [check.id, { status: "failed", checkedAt: since, failingSince: since }],
    ]);
    const [row] = toResultRows("node-1", [failed], seen, now);
    expect(row?.failingSince).toEqual(since);
  });

  it("clears failingSince when the service recovers", () => {
    const since = new Date("2026-09-02T08:00:00.000Z");
    const seen = new Map<string, PreviousResult>([
      [check.id, { status: "failed", checkedAt: since, failingSince: since }],
    ]);
    const [row] = toResultRows(
      "node-1",
      [{ ...failed, status: "ok", detail: null }],
      seen,
      now,
    );
    expect(row?.failingSince).toBeNull();
    expect(row?.status).toBe("ok");
  });

  it("keeps failingSince across a status change from failed to error", () => {
    // A node that cannot reach the service at all is still an outage window.
    const since = new Date("2026-09-02T08:00:00.000Z");
    const seen = new Map<string, PreviousResult>([
      [check.id, { status: "failed", checkedAt: since, failingSince: since }],
    ]);
    const [row] = toResultRows(
      "node-1",
      [{ ...failed, status: "error" }],
      seen,
      now,
    );
    expect(row?.failingSince).toEqual(since);
  });

  it("falls back to the previous checkedAt when failingSince was never set", () => {
    // A row written before this column existed, or by a path that did not set
    // it. "Since the last tick" would be wrong in the direction that hides an
    // old outage; the previous reading is the earliest defensible answer.
    const since = new Date("2026-09-02T08:00:00.000Z");
    const seen = new Map<string, PreviousResult>([
      [check.id, { status: "failed", checkedAt: since, failingSince: null }],
    ]);
    const [row] = toResultRows("node-1", [failed], seen, now);
    expect(row?.failingSince).toEqual(since);
  });
});
