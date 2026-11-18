import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isLoopbackAddress, loadConfig, parseFrpsUrl, parseListen } from "../src/config.js";

const BRIDGE_ID = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-agent-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, content: string, mode = 0o600): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  BRIDGE_ID,
  BRIDGE_AGENT_API_TOKEN_FILE: file("token", `${"a".repeat(40)}\n`),
  BRIDGE_FRPS_DASHBOARD_ENV_FILE: file("dashboard.env", "FRPS_DASHBOARD_USER=amnezia-bridge\nFRPS_DASHBOARD_PASSWORD=pw123\n"),
  BRIDGE_APPLIED_CONTROL_PORT: "7000",
  BRIDGE_APPLIED_UDP_START: "41000",
  BRIDGE_APPLIED_UDP_END: "41031",
  ...extra,
});

describe("loopback binding", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "[::1]"])("accepts %s", (host) => {
    expect(isLoopbackAddress(host)).toBe(true);
  });

  it.each(["0.0.0.0", "::", "10.0.0.5", "203.0.113.10", "localhost", "example.com", ""])("refuses %s", (host) => {
    expect(isLoopbackAddress(host)).toBe(false);
  });

  it("defaults to 127.0.0.1:7600 and parses host:port", () => {
    expect(parseListen(undefined)).toEqual({ host: "127.0.0.1", port: 7600 });
    expect(parseListen("[::1]:8000")).toEqual({ host: "::1", port: 8000 });
  });

  it.each(["0.0.0.0:7600", "[::]:7600", "192.168.1.1:7600", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:99999"])(
    "refuses BRIDGE_AGENT_LISTEN=%s at startup",
    (value) => {
      expect(() => parseListen(value)).toThrow();
      expect(() => loadConfig(env({ BRIDGE_AGENT_LISTEN: value }))).toThrow();
    },
  );

  it("only accepts a loopback http frps URL", () => {
    expect(parseFrpsUrl(undefined)).toBe("http://127.0.0.1:7500");
    expect(() => parseFrpsUrl("http://10.0.0.1:7500")).toThrow(/loopback/);
    expect(() => parseFrpsUrl("https://127.0.0.1:7500")).toThrow(/http/);
    expect(() => parseFrpsUrl("nonsense")).toThrow();
  });
});

describe("loadConfig", () => {
  it("loads a complete configuration", () => {
    const config = loadConfig(env());
    expect(config.bridgeId).toBe(BRIDGE_ID);
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 7600 });
    expect(config.apiToken).toBe("a".repeat(40));
    expect(config.frps).toMatchObject({ baseUrl: "http://127.0.0.1:7500", user: "amnezia-bridge", password: "pw123", timeoutMs: 3000 });
    expect(config.applied).toEqual({ controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 });
  });

  it("refuses to start without BRIDGE_ID or with a non-UUID", () => {
    expect(() => loadConfig(env({ BRIDGE_ID: undefined }))).toThrow(/BRIDGE_ID/);
    expect(() => loadConfig(env({ BRIDGE_ID: "not-a-uuid" }))).toThrow(/BRIDGE_ID/);
  });

  it("refuses to start without a token file, with a missing file, or with a short token", () => {
    expect(() => loadConfig(env({ BRIDGE_AGENT_API_TOKEN_FILE: undefined }))).toThrow(/TOKEN_FILE/);
    expect(() => loadConfig(env({ BRIDGE_AGENT_API_TOKEN_FILE: join(dir, "missing") }))).toThrow(/cannot read/);
    expect(() => loadConfig(env({ BRIDGE_AGENT_API_TOKEN_FILE: file("short", "abc") }))).toThrow(/at least 32/);
  });

  it("refuses a group/world-readable token or credentials file without echoing contents", () => {
    const loose = file("loose", "a".repeat(40), 0o644);
    expect(() => loadConfig(env({ BRIDGE_AGENT_API_TOKEN_FILE: loose }))).toThrow(/chmod 600/);
    const looseCreds = file("loose.env", "FRPS_DASHBOARD_USER=u\nFRPS_DASHBOARD_PASSWORD=pw\n", 0o644);
    expect(() => loadConfig(env({ BRIDGE_FRPS_DASHBOARD_ENV_FILE: looseCreds }))).toThrow(/chmod 600/);
  });

  it("refuses incomplete dashboard credentials", () => {
    const partial = file("partial.env", "FRPS_DASHBOARD_USER=u\n");
    expect(() => loadConfig(env({ BRIDGE_FRPS_DASHBOARD_ENV_FILE: partial }))).toThrow(/FRPS_DASHBOARD_PASSWORD/);
  });

  it("requires valid applied ports with start <= end", () => {
    expect(() => loadConfig(env({ BRIDGE_APPLIED_CONTROL_PORT: undefined }))).toThrow(/CONTROL_PORT/);
    expect(() => loadConfig(env({ BRIDGE_APPLIED_UDP_START: "41040" }))).toThrow(/START/);
    expect(() => loadConfig(env({ BRIDGE_APPLIED_UDP_END: "70000" }))).toThrow(/UDP_END/);
  });

  it("error messages never contain secret values", () => {
    const secret = "s3cr3t-token-value-s3cr3t-token-value";
    const path = file("loose2", secret, 0o644);
    try {
      loadConfig(env({ BRIDGE_AGENT_API_TOKEN_FILE: path }));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
