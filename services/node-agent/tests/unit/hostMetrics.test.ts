import { describe, expect, it } from "vitest";

import {
  countDumpPeers,
  parseCgroupPids,
  parseListenPort,
  parseMemInfo,
} from "@/helpers/hostMetrics";

describe("parseMemInfo", () => {
  it("converts MemAvailable and swap from kB to bytes", () => {
    expect(
      parseMemInfo(
        "MemTotal:         984064 kB\n" +
          "MemFree:           98304 kB\n" +
          "MemAvailable:     344800 kB\n" +
          "SwapTotal:       1048572 kB\n" +
          "SwapFree:         555000 kB\n",
      ),
    ).toEqual({
      availableBytes: 344800 * 1024,
      swapTotalBytes: 1048572 * 1024,
      swapFreeBytes: 555000 * 1024,
    });
  });

  it("returns nulls for missing keys", () => {
    // MemAvailable is what the kernel says is actually usable, and it is the
    // number the deploy gate reads. MemFree is not a substitute and must not be
    // silently used in its place, so a kernel that does not report it yields
    // null rather than a plausible wrong answer.
    expect(parseMemInfo("MemTotal:        984064 kB\n")).toEqual({
      availableBytes: null,
      swapTotalBytes: null,
      swapFreeBytes: null,
    });
    expect(parseMemInfo("")).toEqual({
      availableBytes: null,
      swapTotalBytes: null,
      swapFreeBytes: null,
    });
  });

  it("does not match a key that merely ends with the one asked for", () => {
    // "SwapCached" and "MemAvailable" both contain shorter key names; a loose
    // regex would report the wrong line as the answer.
    expect(parseMemInfo("SwapCached:        42 kB\n").swapTotalBytes).toBeNull();
    expect(parseMemInfo("CmaTotal:          42 kB\n").swapTotalBytes).toBeNull();
  });
});

describe("parseCgroupPids", () => {
  it("reads current and max", () => {
    expect(parseCgroupPids("12\n", "128\n")).toEqual({
      pidsCurrent: 12,
      pidsMax: 128,
    });
  });

  it("maps an unlimited cgroup to null", () => {
    // "max" is cgroup v2 for "no limit". Reporting it as a number would put a
    // meaningless ceiling on the chart the operator uses to spot a task leak.
    expect(parseCgroupPids("12\n", "max\n")).toEqual({
      pidsCurrent: 12,
      pidsMax: null,
    });
  });

  it("treats unreadable values as unknown rather than zero", () => {
    expect(parseCgroupPids("", "")).toEqual({
      pidsCurrent: null,
      pidsMax: null,
    });
    expect(parseCgroupPids("nonsense", "-1")).toEqual({
      pidsCurrent: null,
      pidsMax: null,
    });
  });
});

describe("countDumpPeers", () => {
  it("ignores the interface line", () => {
    // `wg show <iface> dump` prints the interface first, then one line per
    // peer. Counting lines without dropping the first reports one phantom peer
    // on every node, including an empty one.
    expect(
      countDumpPeers(
        "priv\tpub\t51890\toff\n" +
          "peer1\t(none)\t1.2.3.4:5\t10.90.0.2/32\t0\t0\t0\t25\n" +
          "peer2\t(none)\t(none)\t10.90.0.3/32\t0\t0\t0\t25\n",
      ),
    ).toBe(2);
  });

  it("reports zero for an interface with no peers and for no output at all", () => {
    expect(countDumpPeers("priv\tpub\t51890\toff\n")).toBe(0);
    expect(countDumpPeers("")).toBe(0);
    expect(countDumpPeers("\n\n")).toBe(0);
  });
});

describe("parseListenPort", () => {
  it("finds the interface port", () => {
    expect(parseListenPort("[Interface]\nListenPort = 51890\n")).toBe(51890);
    expect(parseListenPort("[Interface]\nListenPort=51889\n")).toBe(51889);
  });

  it("returns null when there is no usable port", () => {
    expect(parseListenPort("[Interface]\n")).toBeNull();
    expect(parseListenPort("ListenPort = 0\n")).toBeNull();
    expect(parseListenPort("ListenPort = 70000\n")).toBeNull();
    expect(parseListenPort("")).toBeNull();
  });

  it("takes the interface's port, not a peer's endpoint port", () => {
    // A config has one [Interface] and many [Peer] sections; only the first
    // ListenPort is the port this node listens on.
    expect(
      parseListenPort(
        "[Interface]\nListenPort = 51890\n\n[Peer]\nEndpoint = 1.2.3.4:51820\n",
      ),
    ).toBe(51890);
  });
});
