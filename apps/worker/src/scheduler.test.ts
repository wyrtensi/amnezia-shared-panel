import { describe, expect, it, vi } from "vitest";
import { runPeriodicTask } from "./scheduler.js";

describe("periodic worker scheduler", () => {
  it("runs immediately and waits the configured interval between attempts", async () => {
    const controller = new AbortController();
    const task = vi.fn(() => Promise.resolve());
    const wait = vi.fn((_milliseconds: number) => {
      controller.abort();
      return Promise.resolve();
    });

    await runPeriodicTask({
      task,
      intervalMs: 60_000,
      signal: controller.signal,
      wait,
    });

    expect(task).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(60_000, controller.signal);
  });
});
