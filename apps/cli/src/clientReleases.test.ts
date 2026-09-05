import { describe, expect, it } from "vitest";
import {
  CLIENT_RELEASE_COLUMNS,
  clientReleaseRows,
  clientReleaseSummary,
  formatBytes,
  formatVersionLine,
  type CliClientRelease,
} from "./clientReleases.js";

const RESOLVED: CliClientRelease = {
  version: "5.0.1.5",
  releaseUrl: "https://example.invalid/releases/tag/5.0.1.5",
  publishedAt: "2026-08-21T14:47:49.000Z",
  fallback: false,
  resolvedAt: "2026-09-02T09:00:00.000Z",
  downloads: [
    {
      platform: "windows",
      primary: {
        url: "https://example.invalid/AmneziaVPN_5.0.1.5_windows_x64.exe",
        kind: "installer",
        fileName: "AmneziaVPN_5.0.1.5_windows_x64.exe",
        sizeBytes: 91_991_200,
      },
      alternate: null,
    },
    {
      platform: "android",
      primary: {
        url: "https://example.invalid/play?id=org.amnezia.vpn",
        kind: "store",
        fileName: null,
        sizeBytes: null,
      },
      alternate: {
        url: "https://example.invalid/AmneziaVPN_5.0.1.5_android11%2B_arm64-v8a.apk",
        kind: "installer",
        fileName: "AmneziaVPN_5.0.1.5_android11+_arm64-v8a.apk",
        sizeBytes: 75_586_403,
      },
    },
  ],
};

const FALLBACK: CliClientRelease = {
  version: null,
  releaseUrl: "https://example.invalid/releases/latest",
  publishedAt: null,
  fallback: true,
  resolvedAt: "2026-09-02T09:00:00.000Z",
  downloads: [
    {
      platform: "windows",
      primary: {
        url: "https://example.invalid/releases/latest",
        kind: "releasePage",
        fileName: null,
        sizeBytes: null,
      },
      alternate: null,
    },
  ],
};

describe("formatBytes", () => {
  it("renders a download size and a dash for an unknown one", () => {
    expect(formatBytes(91_991_200)).toBe("87.7 MB");
    expect(formatBytes(null)).toBe("-");
  });
});

describe("clientReleaseRows", () => {
  it("emits one row per platform, plus a row for an alternate download", () => {
    const rows = clientReleaseRows(RESOLVED);
    expect(rows.map((row) => row.platform)).toEqual([
      "windows",
      "android",
      "android",
    ]);
    // The alternate is marked so an operator can tell it from the main route.
    expect(rows[2]?.role).toBe("alternate");
    expect(rows[0]?.role).toBe("primary");
  });

  it("shows the file name and size of an installer", () => {
    const [windows] = clientReleaseRows(RESOLVED);
    expect(windows?.kind).toBe("installer");
    expect(windows?.file).toBe("AmneziaVPN_5.0.1.5_windows_x64.exe");
    expect(windows?.size).toBe("87.7 MB");
  });

  it("leaves file and size blank for a store link", () => {
    const android = clientReleaseRows(RESOLVED)[1];
    expect(android?.kind).toBe("store");
    expect(android?.file).toBe("-");
    expect(android?.size).toBe("-");
  });

  it("declares every column it fills", () => {
    for (const row of clientReleaseRows(RESOLVED)) {
      for (const column of CLIENT_RELEASE_COLUMNS) {
        expect(row, `missing column ${column}`).toHaveProperty(column);
      }
    }
  });
});

describe("clientReleaseSummary", () => {
  it("reports the resolved version and when it was resolved", () => {
    const summary = clientReleaseSummary(RESOLVED);
    expect(summary).toContain("5.0.1.5");
    expect(summary).toContain("2026-09-02");
    expect(summary).not.toMatch(/fallback/i);
  });

  it("says plainly when the panel is serving the offline fallback", () => {
    const summary = clientReleaseSummary(FALLBACK);
    // The operator has to be able to see this without reading --json.
    expect(summary).toMatch(/fallback/i);
    expect(summary).toContain("unknown");
  });
});

describe("formatVersionLine", () => {
  it("shows the running panel and the client floor it advertises", () => {
    expect(
      formatVersionLine({
        version: "1.2.3",
        commit: "abc1234",
        minAwg3ClientVersion: "5.0.1.5",
        repositoryUrl: "https://github.com/wyrtensi/amnezia-shared-panel",
      }),
    ).toBe(
      "version: 1.2.3   commit: abc1234   awg3-client-floor: 5.0.1.5   repo: https://github.com/wyrtensi/amnezia-shared-panel",
    );
  });

  it("renders a missing field as ? rather than undefined", () => {
    // Matches the existing `?? "?"` idiom at main.ts:830, and covers a panel
    // older than this change, whose /version has no floor at all.
    expect(formatVersionLine({})).toBe(
      "version: ?   commit: ?   awg3-client-floor: ?   repo: ?",
    );
  });
});
