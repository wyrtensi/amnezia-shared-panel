import { describe, expect, it, vi } from "vitest";
import {
  candidatePanelHostnames,
  createBridgePanelDnsChecker,
} from "./bridgePanelDns.js";

describe("candidatePanelHostnames", () => {
  it("derives sibling bridge hostnames from PANEL_PUBLIC_URL and merges PANEL_BRIDGE_DOMAINS", () => {
    const hosts = candidatePanelHostnames({
      PANEL_PUBLIC_URL: "https://link.panel.example.test",
      PANEL_BRIDGE_DOMAINS: "custom.example.test, https://alt.example.test/login",
    });

    expect(hosts).toEqual([
      "custom.example.test",
      "alt.example.test",
      "link.panel.example.test",
      "me.panel.example.test",
      "panel.panel.example.test",
      "bridge.panel.example.test",
    ]);
  });

  it("ignores IPv4 literals and single-label localhost", () => {
    expect(
      candidatePanelHostnames({
        PANEL_PUBLIC_URL: "http://127.0.0.1:3000",
        PANEL_BRIDGE_DOMAINS: "localhost, 203.0.113.10",
      }),
    ).toEqual([]);
  });
});

describe("createBridgePanelDnsChecker", () => {
  it("returns undefined without network calls when no panel domain is configured", async () => {
    const lookupIpv4 = vi.fn();
    const probeHttps = vi.fn();
    const check = createBridgePanelDnsChecker({
      env: {},
      lookupIpv4,
      probeHttps,
    });

    await expect(check("203.0.113.10")).resolves.toBeUndefined();
    expect(lookupIpv4).not.toHaveBeenCalled();
    expect(probeHttps).not.toHaveBeenCalled();
  });

  it("reports active when a candidate domain resolves to the bridge IPv4 and answers HTTPS", async () => {
    const lookupIpv4 = vi.fn(async (host: string) =>
      host === "me.example.test" ? ["203.0.113.10"] : ["198.51.100.20"],
    );
    const probeHttps = vi.fn(async () => true);
    const check = createBridgePanelDnsChecker({
      env: { PANEL_PUBLIC_URL: "https://link.example.test" },
      lookupIpv4,
      probeHttps,
      now: () => new Date("2026-11-19T00:00:00.000Z"),
    });

    await expect(check("203.0.113.10")).resolves.toEqual({
      state: "active",
      hostname: "me.example.test",
      checkedAt: "2026-11-19T00:00:00.000Z",
    });
    expect(probeHttps).toHaveBeenCalledWith("203.0.113.10", "me.example.test");
  });

  it("reports https_unreachable when DNS points at the bridge IPv4 but HTTPS forwarding fails", async () => {
    const check = createBridgePanelDnsChecker({
      env: { PANEL_PUBLIC_URL: "https://link.example.test" },
      lookupIpv4: async (host) => (host === "me.example.test" ? ["203.0.113.10"] : []),
      probeHttps: async () => false,
      now: () => new Date("2026-11-19T00:00:00.000Z"),
    });

    await expect(check("203.0.113.10")).resolves.toEqual({
      state: "https_unreachable",
      hostname: "me.example.test",
      checkedAt: "2026-11-19T00:00:00.000Z",
    });
  });

  it("reports unconfigured when no candidate domain resolves to the bridge IPv4", async () => {
    const probeHttps = vi.fn(async () => true);
    const check = createBridgePanelDnsChecker({
      env: { PANEL_PUBLIC_URL: "https://link.example.test" },
      lookupIpv4: async () => ["198.51.100.20"],
      probeHttps,
      now: () => new Date("2026-11-19T00:00:00.000Z"),
    });

    await expect(check("203.0.113.10")).resolves.toEqual({
      state: "unconfigured",
      hostname: null,
      checkedAt: "2026-11-19T00:00:00.000Z",
    });
    expect(probeHttps).not.toHaveBeenCalled();
  });
});
