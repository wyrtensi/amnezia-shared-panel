import fs from "fs/promises";

/**
 * Real CPU utilisation from `/proc/stat`, as a share of every core.
 *
 * Load average is not this number. It counts tasks waiting on disk as well as
 * tasks running, so on a small VPS with slow storage it is dominated by iowait:
 * a host doing 15 % of real work read as 40-90 % "load / cores". These counters
 * separate busy time from iowait and steal, which is the split an operator
 * needs to tell a busy node from a node starved by its disk or its hypervisor.
 *
 * The parsing and the arithmetic are pure so they can be tested against a
 * captured file; the I/O and the clock live in `CpuSampler`, injected.
 */

/** The eight jiffy counters that add up to a CPU's wall time. */
export type CpuTimes = {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
};

export type CpuStat = { total: CpuTimes; cores: CpuTimes[] };

export type CpuUsage = {
  usedPercent: number;
  iowaitPercent: number;
  stealPercent: number;
  perCorePercent: number[];
};

export type CpuSample = {
  [K in keyof CpuUsage]: CpuUsage[K] | null;
} & { windowSec: number | null };

const FIELDS = [
  "user",
  "nice",
  "system",
  "idle",
  "iowait",
  "irq",
  "softirq",
  "steal",
] as const satisfies ReadonlyArray<keyof CpuTimes>;

/**
 * One `cpu` / `cpuN` line's counters. guest and guest_nice are deliberately
 * ignored: the kernel already counts them inside user and nice, so adding them
 * would count that time twice. A kernel that stops before steal (or iowait) has
 * a counter that never moves, which is zero, not a reason to lose the line.
 */
const parseTimes = (fields: string[]): CpuTimes | null => {
  // user nice system idle are present on every kernel this could run on.
  if (fields.length < 4) return null;
  const values = FIELDS.map((_, index) => Number(fields[index] ?? "0"));
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
    return null;
  }
  return Object.fromEntries(
    FIELDS.map((name, index) => [name, values[index]]),
  ) as CpuTimes;
};

/**
 * The aggregate `cpu` line and every `cpuN` line, in file order. Null when the
 * aggregate line is missing or unreadable; a single unreadable core line is
 * dropped rather than costing the whole reading.
 */
export const parseProcStat = (raw: string): CpuStat | null => {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];

  for (const line of raw.split("\n")) {
    const [name, ...fields] = line.trim().split(/\s+/);
    if (name === "cpu") {
      total = parseTimes(fields);
      if (!total) return null;
    } else if (name && /^cpu\d+$/.test(name)) {
      const times = parseTimes(fields);
      if (times) cores.push(times);
    }
  }

  return total ? { total, cores } : null;
};

const roundPercent = (part: number, whole: number): number => {
  if (!(whole > 0)) return 0;
  const percent = Math.round((part / whole) * 1000) / 10;
  return Math.min(100, Math.max(0, percent));
};

type Shares = { used: number; iowait: number; steal: number };

/**
 * Busy, iowait and steal as percentages of the time that passed on one CPU.
 * Each delta is clamped at zero: a counter that went backwards (a reset, a
 * buggy hypervisor) must not paint a negative bar.
 */
const sharesBetween = (prev: CpuTimes, cur: CpuTimes): Shares => {
  const delta = (name: keyof CpuTimes) => Math.max(0, cur[name] - prev[name]);
  const total = FIELDS.reduce((sum, name) => sum + delta(name), 0);
  const used = total - delta("idle") - delta("iowait") - delta("steal");
  return {
    used: roundPercent(used, total),
    iowait: roundPercent(delta("iowait"), total),
    steal: roundPercent(delta("steal"), total),
  };
};

/**
 * Utilisation between two readings. When the core count differs between them
 * (CPU hotplug) the per-core figures cannot be paired up honestly, so there are
 * none; the aggregate still stands.
 */
export const cpuUsageBetween = (prev: CpuStat, cur: CpuStat): CpuUsage => {
  const total = sharesBetween(prev.total, cur.total);
  const perCorePercent =
    prev.cores.length === cur.cores.length
      ? cur.cores.map((core, index) =>
          sharesBetween(prev.cores[index] as CpuTimes, core).used,
        )
      : [];
  return {
    usedPercent: total.used,
    iowaitPercent: total.iowait,
    stealPercent: total.steal,
    perCorePercent,
  };
};

/** How long the fresh pair of readings is spread over when there is no history. */
export const CPU_SAMPLE_GAP_MS = 500;

/**
 * Past this age the stored reading describes a different afternoon, not the
 * last poll interval, and a fresh pair is taken instead.
 */
export const CPU_SAMPLE_MAX_AGE_MS = 10 * 60 * 1000;

const EMPTY_SAMPLE: CpuSample = {
  usedPercent: null,
  iowaitPercent: null,
  stealPercent: null,
  perCorePercent: null,
  windowSec: null,
};

export type CpuSamplerDeps = {
  readStat: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: CpuSamplerDeps = {
  readStat: () => fs.readFile("/proc/stat", "utf-8"),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * CPU utilisation averaged over the gap between two `/proc/stat` readings.
 *
 * It keeps the previous reading, so a panel polling once a minute gets the
 * average over that minute rather than over whatever half second its request
 * landed in. With no usable previous reading it takes two, half a second apart.
 * Never throws: a node whose /proc cannot be read reports nulls, and the rest
 * of its metrics still go out.
 */
export class CpuSampler {
  private previous: { stat: CpuStat; atMs: number } | null = null;

  private readonly deps: CpuSamplerDeps;

  constructor(deps: Partial<CpuSamplerDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  private async read(): Promise<{ stat: CpuStat; atMs: number } | null> {
    try {
      const stat = parseProcStat(await this.deps.readStat());
      return stat ? { stat, atMs: this.deps.now() } : null;
    } catch {
      return null;
    }
  }

  async sample(): Promise<CpuSample> {
    const current = await this.read();
    if (!current) {
      this.previous = null;
      return EMPTY_SAMPLE;
    }

    let start = this.previous;
    let end = current;
    if (!start || current.atMs - start.atMs > CPU_SAMPLE_MAX_AGE_MS) {
      await this.deps.sleep(CPU_SAMPLE_GAP_MS);
      const second = await this.read();
      if (!second) {
        this.previous = null;
        return EMPTY_SAMPLE;
      }
      start = current;
      end = second;
    }

    this.previous = end;
    const windowSec = Math.round((end.atMs - start.atMs) / 100) / 10;
    return { ...cpuUsageBetween(start.stat, end.stat), windowSec };
  }
}
