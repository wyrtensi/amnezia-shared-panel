import { describe, expect, it, vi } from "vitest";
import {
  abortableWait,
  FAILED_RESOLVE_WAIT_MS,
  runPeriodicTask,
} from "./scheduler.js";

/** The longest a loop can be told to wait: `ruleFetchIntervalSec`'s ceiling. */
const A_WEEK_MS = 604_800_000;

/**
 * Resolves to "settled" if `promise` finishes promptly, "still waiting"
 * otherwise. Every other test in this file stubs `wait`, so a wait that never
 * resolves would hang the run rather than fail it; this turns it into an
 * assertion that names what went wrong.
 */
const settlesPromptly = (promise: Promise<unknown>): Promise<string> =>
  Promise.race([
    promise.then(() => "settled"),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("still waiting"), 100);
    }),
  ]);

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

  it("stops when the signal aborts while the period is being resolved", async () => {
    // The shutdown path, with the REAL abortableWait: SIGTERM lands after the
    // loop's own `signal.aborted` check and while the resolver is still asking
    // the database for the period. Every other test here stubs `wait`, which is
    // exactly why a wait that ignored an already-aborted signal went unnoticed:
    // the loop would sleep out a full period -- up to a week -- so Promise.all
    // over the loops never resolved, the pool was never closed, and docker
    // SIGKILLed the container with an outbox job still claimed.
    const controller = new AbortController();

    const outcome = await settlesPromptly(
      runPeriodicTask({
        task: () => Promise.resolve(),
        // Aborting inside the resolver puts the signal in exactly the state the
        // window produces: aborted, with the await already past the loop's check.
        intervalMs: async () => {
          controller.abort();
          await Promise.resolve();
          return A_WEEK_MS;
        },
        signal: controller.signal,
      }),
    );

    expect(outcome).toBe("settled");
  });
});

describe("abortableWait", () => {
  it("resolves at once when the signal has already aborted", async () => {
    // A listener attached to an already-aborted signal never fires, so checking
    // `signal.aborted` before subscribing is the whole fix. Asserted on the
    // real helper rather than through a loop, because both loops depend on it:
    // runPeriodicTask around the period lookup, runWorker around claimJob().
    const controller = new AbortController();
    controller.abort();

    const outcome = await settlesPromptly(
      abortableWait(A_WEEK_MS, controller.signal),
    );

    expect(outcome).toBe("settled");
  });

  it("still resolves when the signal aborts during the wait", async () => {
    const controller = new AbortController();
    const waiting = settlesPromptly(abortableWait(A_WEEK_MS, controller.signal));
    controller.abort();

    expect(await waiting).toBe("settled");
  });

  it("waits out a period nobody aborted", async () => {
    const controller = new AbortController();

    expect(await settlesPromptly(abortableWait(5, controller.signal))).toBe(
      "settled",
    );
    expect(
      await settlesPromptly(abortableWait(A_WEEK_MS, controller.signal)),
    ).toBe("still waiting");
    controller.abort();
  });
});
