import { describe, expect, it, vi } from "vitest";
import { assertBridgeJobsEnabled, resolveBridgeConfig } from "./bridgeConfig.js";
import { ApiError } from "./service.js";

describe("resolveBridgeConfig", () => {
  it("defaults to jobs disabled, a five-minute stale window and the tunnel host", () => {
    expect(resolveBridgeConfig({})).toEqual({
      jobsEnabled: false,
      observationStaleMs: 300_000,
      managementHosts: ["host.docker.internal"],
      agentImageRepository: undefined,
    });
  });

  it("refuses a bridge-agent repository that is malformed or equals the node-agent's, and logs why", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const value of ["docker.io/o/bridge-agent", "ghcr.io/o/r/node-agent", "ghcr.io/o/bridge-agent-x", "ghcr.io/bridge-agent"]) {
      expect(resolveBridgeConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: value }).agentImageRepository, value).toBeUndefined();
    }
    expect(
      resolveBridgeConfig({
        BRIDGE_AGENT_IMAGE_REPOSITORY: "ghcr.io/o/r/bridge-agent",
        NODE_AGENT_UPDATE_REPO: "ghcr.io/o/r/bridge-agent",
      }).agentImageRepository,
    ).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("must differ from NODE_AGENT_UPDATE_REPO"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ghcr.io/<owner>/<repo>/bridge-agent"));
    log.mockRestore();
  });

  it("reads the approved bridge-agent repository, trimmed, empty meaning unset", () => {
    expect(
      resolveBridgeConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: " ghcr.io/o/r/bridge-agent " })
        .agentImageRepository,
    ).toBe("ghcr.io/o/r/bridge-agent");
    expect(resolveBridgeConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: "  " }).agentImageRepository).toBeUndefined();
  });

  it("reads the allowed management hosts and refuses malformed entries", () => {
    expect(
      resolveBridgeConfig({ VPN_BRIDGE_MANAGEMENT_HOSTS: " Host.Docker.Internal , 172.17.0.1 " })
        .managementHosts,
    ).toEqual(["host.docker.internal", "172.17.0.1"]);
    expect(
      resolveBridgeConfig({ VPN_BRIDGE_MANAGEMENT_HOSTS: "host.docker.internal:7605" })
        .managementHosts,
    ).toEqual(["host.docker.internal:7605"]);
    expect(() =>
      resolveBridgeConfig({ VPN_BRIDGE_MANAGEMENT_HOSTS: "http://evil.example" }),
    ).toThrow(/VPN_BRIDGE_MANAGEMENT_HOSTS/);
  });

  it("enables jobs only for the exact value true", () => {
    expect(resolveBridgeConfig({ VPN_BRIDGE_JOBS_ENABLED: "true" }).jobsEnabled).toBe(true);
    for (const value of ["", "false", "1", "yes", "TRUE"]) {
      expect(resolveBridgeConfig({ VPN_BRIDGE_JOBS_ENABLED: value }).jobsEnabled).toBe(false);
    }
  });

  it("reads a positive stale window and refuses anything else", () => {
    expect(
      resolveBridgeConfig({ VPN_BRIDGE_OBSERVATION_STALE_MS: "60000" }).observationStaleMs,
    ).toBe(60_000);
    for (const value of ["0", "-5", "1.5", "five"]) {
      expect(() => resolveBridgeConfig({ VPN_BRIDGE_OBSERVATION_STALE_MS: value })).toThrow(
        /VPN_BRIDGE_OBSERVATION_STALE_MS/,
      );
    }
  });
});

describe("assertBridgeJobsEnabled", () => {
  it("throws the typed BRIDGE_JOBS_DISABLED while the gate is closed", () => {
    expect(() => assertBridgeJobsEnabled({ jobsEnabled: true })).not.toThrow();
    let caught: unknown;
    try {
      assertBridgeJobsEnabled({ jobsEnabled: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ statusCode: 409, code: "BRIDGE_JOBS_DISABLED" });
  });
});
