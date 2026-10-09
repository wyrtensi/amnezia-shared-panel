import { describe, expect, it, vi } from "vitest";
import {
  CpuSampler,
  CpuStat,
  cpuUsageBetween,
  parseProcStat,
} from "@/helpers/cpuUsage";

// A two-core capture in the shape a 5.x/6.x kernel writes it. guest and
// guest_nice trail the eight fields that matter; they are already counted inside
// user and nice, so adding them would count that time twice.
const STAT_A = [
  "cpu  1000 50 400 8000 2000 10 40 0 0 0",
  "cpu0 500 25 200 4000 1000 5 20 0 0 0",
  "cpu1 500 25 200 4000 1000 5 20 0 0 0",
  "intr 123456 0 0 0",
  "ctxt 987654",
  "btime 1788000000",
  "processes 4242",
  "",
].join("\n");

// One second later: cpu0 was busy, cpu1 sat in iowait, and the hypervisor stole
// a little from both.
const STAT_B = [
  "cpu  1080 50 420 8040 2050 10 40 10 0 0",
  "cpu0 570 25 210 4010 1000 5 20 10 0 0",
  "cpu1 510 25 210 4030 1050 5 20 0 0 0",
  "intr 123999 0 0 0",
  "",
].join("\n");

describe("parseProcStat", () => {
  it("reads the aggregate line and every core", () => {
    const stat = parseProcStat(STAT_A);

    expect(stat?.total).toEqual({
      user: 1000,
      nice: 50,
      system: 400,
      idle: 8000,
      iowait: 2000,
      irq: 10,
      softirq: 40,
      steal: 0,
    });
    expect(stat?.cores).toHaveLength(2);
    expect(stat?.cores[1]?.iowait).toBe(1000);
  });

  it("accepts an old kernel that writes fewer than eight fields", () => {
    // Pre-2.6.11 kernels stop before steal. A missing counter is a counter that
    // never moves, not a reason to lose the whole reading.
    const stat = parseProcStat("cpu  10 0 5 100 2\ncpu0 10 0 5 100 2\n");
    expect(stat?.total.steal).toBe(0);
    expect(stat?.total.iowait).toBe(2);
  });

  it("refuses a file with no aggregate line", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("intr 1 2 3\nctxt 4\n")).toBeNull();
  });

  it("refuses an aggregate line that is not numbers", () => {
    expect(parseProcStat("cpu  a b c d\n")).toBeNull();
    expect(parseProcStat("cpu\n")).toBeNull();
  });

  it("drops a core line it cannot read rather than the whole file", () => {
    const stat = parseProcStat("cpu  10 0 5 100\ncpu0 x y\ncpu1 5 0 2 50\n");
    expect(stat?.cores).toHaveLength(1);
  });
});

describe("cpuUsageBetween", () => {
  const a = parseProcStat(STAT_A) as CpuStat;
  const b = parseProcStat(STAT_B) as CpuStat;

  it("splits busy time from iowait and steal", () => {
    // Aggregate deltas: user 80, system 20, idle 40, iowait 50, steal 10 = 200.
    // Busy is user + system = 100 of 200; iowait and steal are not busy - they
    // are exactly what made load average read 40-90 % on a host doing 15 %.
    expect(cpuUsageBetween(a, b)).toEqual({
      usedPercent: 50,
      iowaitPercent: 25,
      stealPercent: 5,
      perCorePercent: [
        // cpu0: user 70 + system 10 of 100 (idle 10, steal 10)
        80,
        // cpu1: user 10 + system 10 of 100 (idle 30, iowait 50)
        20,
      ],
    });
  });

  it("rounds to a tenth", () => {
    const prev = parseProcStat("cpu  0 0 0 0\n") as CpuStat;
    const cur = parseProcStat("cpu  1 0 0 2\n") as CpuStat;
    expect(cpuUsageBetween(prev, cur).usedPercent).toBe(33.3);
  });

  it("reports zero, not NaN, when no time passed", () => {
    expect(cpuUsageBetween(a, a)).toEqual({
      usedPercent: 0,
      iowaitPercent: 0,
      stealPercent: 0,
      perCorePercent: [0, 0],
    });
  });

  it("clamps a counter that went backwards", () => {
    // A counter reset (or a buggy hypervisor) must not paint a negative bar.
    const prev = parseProcStat("cpu  100 0 0 100\n") as CpuStat;
    const cur = parseProcStat("cpu  50 0 0 200\n") as CpuStat;
    const usage = cpuUsageBetween(prev, cur);
    expect(usage.usedPercent).toBeGreaterThanOrEqual(0);
    expect(usage.usedPercent).toBeLessThanOrEqual(100);
  });

  it("gives no per-core figures when a core came or went in between", () => {
    const oneCore = parseProcStat(
      "cpu  1000 50 400 8000 2000 10 40 0\ncpu0 1000 50 400 8000 2000 10 40 0\n",
    ) as CpuStat;
    const usage = cpuUsageBetween(oneCore, b);
    expect(usage.perCorePercent).toEqual([]);
    expect(usage.usedPercent).not.toBeNull();
  });
});

describe("CpuSampler", () => {
  const createSampler = (
    readings: Array<string | Error>,
    startMs = 1_000_000,
  ) => {
    let nowMs = startMs;
    const readStat = vi.fn(async () => {
      const next = readings.shift();
      if (next === undefined) throw new Error("no more readings");
      if (next instanceof Error) throw next;
      return next;
    });
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
    });
    const sampler = new CpuSampler({
      readStat,
      sleep,
      now: () => nowMs,
    });
    return {
      sampler,
      readStat,
      sleep,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  };

  it("takes two readings half a second apart on the first call", async () => {
    const { sampler, readStat, sleep } = createSampler([STAT_A, STAT_B]);

    const sample = await sampler.sample();

    expect(readStat).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(sample).toEqual({
      usedPercent: 50,
      iowaitPercent: 25,
      stealPercent: 5,
      perCorePercent: [80, 20],
      windowSec: 0.5,
    });
  });

  it("diffs against the stored reading on the next call", async () => {
    // The panel polls once a minute, so the second figure is the average over
    // that minute rather than over whatever half second the request landed in.
    const { sampler, readStat, sleep, advance } = createSampler([
      STAT_A,
      STAT_A,
      STAT_B,
    ]);
    await sampler.sample();
    advance(60_000);

    const sample = await sampler.sample();

    expect(readStat).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sample.usedPercent).toBe(50);
    expect(sample.windowSec).toBe(60);
  });

  it("starts over when the stored reading is too old to describe now", async () => {
    const { sampler, readStat, sleep, advance } = createSampler([
      STAT_A,
      STAT_A,
      STAT_A,
      STAT_B,
    ]);
    await sampler.sample();
    advance(11 * 60_000);

    const sample = await sampler.sample();

    expect(readStat).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sample.windowSec).toBe(0.5);
    expect(sample.usedPercent).toBe(50);
  });

  it("reports nulls, never a failure, when /proc/stat cannot be read", async () => {
    const { sampler } = createSampler([new Error("ENOENT")]);

    await expect(sampler.sample()).resolves.toEqual({
      usedPercent: null,
      iowaitPercent: null,
      stealPercent: null,
      perCorePercent: null,
      windowSec: null,
    });
  });

  it("reports nulls when /proc/stat is not in a shape it knows", async () => {
    const { sampler } = createSampler(["garbage", "garbage"]);

    const sample = await sampler.sample();

    expect(sample.usedPercent).toBeNull();
    expect(sample.perCorePercent).toBeNull();
  });

  it("recovers on the next call after a failed reading", async () => {
    const { sampler } = createSampler([new Error("EIO"), STAT_A, STAT_B]);
    await sampler.sample();

    const sample = await sampler.sample();

    expect(sample.usedPercent).toBe(50);
  });
});
