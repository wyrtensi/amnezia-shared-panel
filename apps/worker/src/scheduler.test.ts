import { describe, expect, it, vi } from "vitest";
import { FAILED_RESOLVE_WAIT_MS, runPeriodicTask } from "./scheduler.js";

/**
 * Stop the loop after `cycles` waits, recording every period it waited.
 * A periodic task never returns on its own, so every test needs one of these.
 */
const stopAfter = (controller: AbortController, cycles: number) => {
  const waited: number[] = [];
  const wait = vi.fn((milliseconds: number) => {
    waited.push(milliseconds);
    if (waited.length >= cycles) controller.abort();
    return Promise.resolve();
  });
  return { waited, wait };
};

describe("periodic worker scheduler", () => {
  it("runs immediately and waits the configured interval between attempts", async () => {
    const controller = new AbortController();
    const task = vi.fn(() => Promise.resolve());
    const { wait } = stopAfter(controller, 1);

    await runPeriodicTask({
      task,
      intervalMs: 60_000,
      signal: controller.signal,
      wait,
    });

    expect(task).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(60_000, controller.signal);
  });

  it("asks a resolver for the period before every wait, so an edit takes effect", async () => {
    // The point of the resolver form: an admin who changes the period mid-run
    // gets the new one on the next cycle, without the container restarting.
    const controller = new AbortController();
    let period = 60_000;
    const { waited, wait } = stopAfter(controller, 3);

    await runPeriodicTask({
      task: () => {
        // Changed while the loop is running, exactly as a saved policy would.
        if (waited.length === 1) period = 300_000;
        return Promise.resolve();
      },
      intervalMs: () => period,
      signal: controller.signal,
      wait,
    });

    expect(waited).toEqual([60_000, 300_000, 300_000]);
  });

  it("keeps the last good period when the resolver throws", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    let fail = false;
    const { waited, wait } = stopAfter(controller, 2);

    await runPeriodicTask({
      task: () => {
        fail = true;
        return Promise.resolve();
      },
      intervalMs: () => {
        if (fail && waited.length === 1) throw new Error("no database");
        return 45_000;
      },
      signal: controller.signal,
      wait,
      onError,
    });

    expect(waited).toEqual([45_000, 45_000]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a period and keeps the last good one",
    async (bad) => {
      // A zero or negative period would busy-loop against whatever the task
      // talks to; NaN would wait forever. Neither is an acceptable way for a
      // bad stored value to express itself.
      const controller = new AbortController();
      const onError = vi.fn();
      const { waited, wait } = stopAfter(controller, 2);

      await runPeriodicTask({
        task: () => Promise.resolve(),
        intervalMs: () => (waited.length === 1 ? bad : 45_000),
        signal: controller.signal,
        wait,
        onError,
      });

      expect(waited).toEqual([45_000, 45_000]);
      expect(onError).toHaveBeenCalledOnce();
    },
  );

  it("waits a conservative minute when the very first resolve fails", async () => {
    const controller = new AbortController();
    const { waited, wait } = stopAfter(controller, 1);

    await runPeriodicTask({
      task: () => Promise.resolve(),
      intervalMs: () => {
        throw new Error("no database yet");
      },
      signal: controller.signal,
      wait,
      onError: () => undefined,
    });

    expect(waited).toEqual([FAILED_RESOLVE_WAIT_MS]);
  });

  it("still runs one task at a time", async () => {
    // The single-executor property every caller relies on: resolving the period
    // between cycles must not overlap two runs of the task.
    const controller = new AbortController();
    let running = 0;
    let overlapped = false;
    const { wait } = stopAfter(controller, 3);

    await runPeriodicTask({
      task: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await Promise.resolve();
        running -= 1;
      },
      intervalMs: () => Promise.resolve(1_000),
      signal: controller.signal,
      wait,
    });

    expect(overlapped).toBe(false);
  });
});
