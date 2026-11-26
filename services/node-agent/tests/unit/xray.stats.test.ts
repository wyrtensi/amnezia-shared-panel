import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type XrayConfig = Record<string, unknown>;

const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/xray/setup_xray_stats.py", import.meta.url),
);

const PYTHON_BIN = (["python3", "python"] as const).find(
  (bin) => spawnSync(bin, ["--version"]).status === 0,
);

const API_RULE = {
  type: "field",
  inboundTag: ["api"],
  outboundTag: "api",
};

let workDir = "";
let configPath = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xray-stats-"));
  configPath = join(workDir, "server.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const runScript = (config: XrayConfig | string) => {
  if (!PYTHON_BIN) throw new Error("Python interpreter unavailable");
  writeFileSync(
    configPath,
    typeof config === "string" ? config : JSON.stringify(config),
  );

  const result = spawnSync(PYTHON_BIN, [SCRIPT_PATH, configPath], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    config: readFileSync(configPath, "utf8"),
  };
};

const getRules = (rawConfig: string): unknown[] =>
  (JSON.parse(rawConfig) as { routing: { rules: unknown[] } }).routing.rules;

describe.skipIf(!PYTHON_BIN)("setup_xray_stats.py", () => {
  it("adds the api routing rule when routing is missing or null", () => {
    for (const routing of [undefined, null]) {
      const { status, stdout, config } = runScript({
        inbounds: [{ port: 443, protocol: "vless" }],
        outbounds: [{ protocol: "freedom", tag: "direct" }],
        routing,
      });

      expect(status).toBe(0);
      expect(stdout).toBe("changed");
      expect(getRules(config)).toEqual([API_RULE]);
    }
  });

  it("places the api routing rule before existing rules and preserves domainStrategy", () => {
    const existingRule = {
      type: "field",
      outboundTag: "direct",
      ip: ["geoip:private"],
    };
    const { config } = runScript({
      routing: { domainStrategy: "AsIs", rules: [existingRule] },
    });

    expect(getRules(config)).toEqual([API_RULE, existingRule]);
    expect(
      (JSON.parse(config) as { routing: { domainStrategy: string } }).routing
        .domainStrategy,
    ).toBe("AsIs");
  });

  it("enables StatsService, dokodemo-door api inbound on 127.0.0.1:10085, and traffic policies", () => {
    const parsed = JSON.parse(runScript({}).config) as {
      api: unknown;
      stats: unknown;
      inbounds: unknown[];
      policy: { levels: Record<string, unknown>; system: unknown };
    };

    expect(parsed.api).toEqual({ tag: "api", services: ["StatsService"] });
    expect(parsed.stats).toEqual({});
    expect(parsed.inbounds).toEqual([
      expect.objectContaining({
        port: 10085,
        tag: "api",
        listen: "127.0.0.1",
        protocol: "dokodemo-door",
      }),
    ]);
    expect(parsed.policy.levels["0"]).toMatchObject({
      statsUserUplink: true,
      statsUserDownlink: true,
    });
    expect(parsed.policy.system).toMatchObject({
      statsInboundUplink: true,
      statsInboundDownlink: true,
    });
  });

  it("is idempotent and leaves already-configured server.json unchanged", () => {
    const first = runScript({ inbounds: [{ port: 443, protocol: "vless" }] });
    const second = runScript(first.config);

    expect(second.status).toBe(0);
    expect(second.stdout).toBe("unchanged");
    expect(second.config).toBe(first.config);
    expect(getRules(second.config)).toEqual([API_RULE]);
  });

  it("refuses to overwrite malformed JSON and exits with status 2", () => {
    const { status, config } = runScript("{broken");

    expect(status).toBe(2);
    expect(config).toBe("{broken");
  });
});
