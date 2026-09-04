/**
 * Pure parsers for the host facts the panel wants but the process cannot get
 * from `os`: what the kernel actually considers available memory, the cgroup
 * task budget, and what each AWG interface is really doing.
 *
 * They are separated from the I/O deliberately - every one of them reads a file
 * format that differs between kernels and container runtimes, and a parser with
 * no I/O can be tested against a real capture instead of against the CI
 * runner's own kernel.
 */

/**
 * `MemAvailable: 344800 kB` -> bytes. Anchored on the whole key, because
 * "SwapCached" and "CmaTotal" end with key names of their own and a loose match
 * would report the wrong line as the answer.
 */
const kbLine = (raw: string, key: string): number | null => {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB\\s*$`, "m").exec(raw);
  return match?.[1] ? Number(match[1]) * 1024 : null;
};

export type MemInfo = {
  availableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
};

/**
 * `MemAvailable` and nothing else: it is the kernel's own estimate of what a
 * new allocation can actually get, and it is the number the node's deploy gate
 * reads. `MemFree` is a different and much smaller quantity on any host with a
 * page cache, so a kernel that does not report MemAvailable yields null rather
 * than a plausible wrong answer.
 */
export const parseMemInfo = (raw: string): MemInfo => ({
  availableBytes: kbLine(raw, "MemAvailable"),
  swapTotalBytes: kbLine(raw, "SwapTotal"),
  swapFreeBytes: kbLine(raw, "SwapFree"),
});

const toCount = (raw: string): number | null => {
  const value = raw.trim();
  // cgroup v2 writes "max" for "no limit". A number there would put a
  // meaningless ceiling on the chart used to spot a task leak.
  if (value === "" || value === "max") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * The cgroup task budget. On a small host this is what runs out first: a
 * container that cannot fork still serves requests and still reports low memory
 * use, so nothing about the failure points at the real cause.
 */
export const parseCgroupPids = (
  current: string,
  max: string,
): { pidsCurrent: number | null; pidsMax: number | null } => ({
  pidsCurrent: toCount(current),
  pidsMax: toCount(max),
});

/**
 * Peers in `wg show <iface> dump`. The first line describes the interface
 * itself, so counting lines without dropping it reports one phantom peer on
 * every node - including on an empty one.
 */
export const countDumpPeers = (dump: string): number =>
  Math.max(
    0,
    dump.split("\n").filter((line) => line.trim().length > 0).length - 1,
  );

/** The first `ListenPort = N`, which is the interface's; a peer's endpoint port is not it. */
export const parseListenPort = (wgConfig: string): number | null => {
  const match = /^[ \t]*ListenPort[ \t]*=[ \t]*(\d+)[ \t]*$/m.exec(wgConfig);
  const port = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
};
