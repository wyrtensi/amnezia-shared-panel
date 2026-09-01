import { describe, expect, it } from "vitest";
import { toRulesRefreshStatus, type RulesRefreshJobRow } from "./rulesRefresh.js";

const row = (overrides: Partial<RulesRefreshJobRow> = {}): RulesRefreshJobRow => ({
  status: "pending",
  payload: { requestedAt: "2026-09-01T10:00:00.000Z" },
  availableAt: new Date("2026-09-01T10:00:00.000Z"),
  completedAt: null,
  lastError: null,
  ...overrides,
});

describe("toRulesRefreshStatus", () => {
  it("reports idle when nobody has asked for a check yet", () => {
    expect(toRulesRefreshStatus(null)).toEqual({
      status: "idle",
      queuedAt: null,
      completedAt: null,
      lastError: null,
    });
  });

  it("reports a queued run with the moment it was requested", () => {
    expect(toRulesRefreshStatus(row())).toEqual({
      status: "pending",
      queuedAt: "2026-09-01T10:00:00.000Z",
      completedAt: null,
      lastError: null,
    });
  });

  it("keeps the request time even after a retry pushed availableAt forward", () => {
    const status = toRulesRefreshStatus(
      row({
        availableAt: new Date("2026-09-01T10:05:00.000Z"),
        lastError: "Rule source https://feed failed with status 502",
      }),
    );
    expect(status.queuedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(status.lastError).toBe(
      "Rule source https://feed failed with status 502",
    );
  });

  it("treats a finished run as a success even when no new version appeared", () => {
    // An unchanged feed is a no-op by design: "checked, nothing new" must read
    // as completed, never as a failure.
    expect(
      toRulesRefreshStatus(
        row({
          status: "completed",
          completedAt: new Date("2026-09-01T10:00:04.000Z"),
        }),
      ),
    ).toEqual({
      status: "completed",
      queuedAt: "2026-09-01T10:00:00.000Z",
      completedAt: "2026-09-01T10:00:04.000Z",
      lastError: null,
    });
  });

  it("falls back to availableAt when the payload carries no request time", () => {
    expect(toRulesRefreshStatus(row({ payload: {} })).queuedAt).toBe(
      "2026-09-01T10:00:00.000Z",
    );
  });
});
