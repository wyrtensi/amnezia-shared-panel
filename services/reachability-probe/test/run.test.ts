import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAll, type RunDeps } from "../src/run.js";
import type { LevelResult, RunRequest, RunState } from "../src/types.js";
import { fakeClock, isHandshakePoll, recordingExec, type ExecCall } from "./fakes.js";

const conf = (address: string, endpoint: string, allowed = "0.0.0.0/0"): string => `[Interface]
Address = ${address}/32
DNS = 1.1.1.1
MTU = 1280
PrivateKey = cHJpdmF0ZS1rZXktZml4dHVyZQ=
Jc = 4

[Peer]
PublicKey = cHVibGljLWtleS1maXh0dXJl
AllowedIPs = ${allowed}
Endpoint = ${endpoint}
PersistentKeepalive = 25
`;

const OK: LevelResult = { ok: true, detail: null, latencyMs: 5 };

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "probe-run-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const request = (targets: RunRequest["targets"]): RunRequest => ({
  runId: "run-1",
  control: { url: "https://control.example.test/" },
  egress: { url: "https://egress.example.test/" },
  targets,
});

type Overrides = Partial<RunDeps> & {
  respond?: (call: ExecCall) => { code?: number; stdout?: string; stderr?: string };
  egressBody?: string;
};

const setup = (overrides: Overrides = {}) => {
  const clock = fakeClock();
  const fake = recordingExec(
    overrides.respond ??
      ((call) => (isHandshakePoll(call) ? { stdout: "cHVibGlj\t1700000000\n" } : {})),
  );
  const httpGet = vi.fn(async (url: string, _opts: { localAddress?: string; timeoutMs: number }) =>
    url.includes("control")
      ? { status: 200, body: "ok" }
      : { status: 200, body: `${overrides.egressBody ?? "192.0.2.10"}\n` },
  );
  const ping = vi.fn(async (_host: string) => OK);
  const tcpBanner = vi.fn(async (_host: string) => ({ ...OK, detail: "SSH-2.0-OpenSSH" }));
  const deps: RunDeps = {
    exec: fake.exec,
    httpGet,
    ping,
    tcpBanner,
    tmpDir,
    now: clock.date,
    sleep: clock.sleep,
    lookup: vi.fn(async () => {
      throw new Error("lookup must not be called for an IP endpoint");
    }),
    ...overrides,
  };
  return { deps, fake, httpGet, ping, tcpBanner, clock };
};

const levelsNull = {
  ping: { ok: null, detail: null, latencyMs: null },
  tcp: { ok: null, detail: null, latencyMs: null },
  handshake: { ok: null, detail: null, latencyMs: null },
  http: { ok: null, detail: null, latencyMs: null },
};

describe("runAll", () => {
  it("runs every level for a healthy target", async () => {
    const { deps, httpGet } = setup();
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.runId).toBe("run-1");
    expect(state.finishedAt).not.toBeNull();
    expect(state.control.ok).toBe(true);
    expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({
      targetId: "node-a",
      protocol: "amneziawg3",
      status: "done",
      detail: null,
      endpointHost: "192.0.2.10",
      egressIp: "192.0.2.10",
      levels: {
        ping: { ok: true },
        tcp: { ok: true },
        handshake: { ok: true },
        http: { ok: true, detail: null },
      },
    });
    expect(httpGet).toHaveBeenCalledWith("https://control.example.test/", expect.not.objectContaining({ localAddress: expect.anything() }));
  });

  it("control failure skips every target", async () => {
    const { deps, fake, ping, tcpBanner } = setup({
      httpGet: vi.fn(async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      }),
    });
    const state = await runAll(
      request([
        { targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") },
        { targetId: "node-b", protocol: "amneziawg3", config: conf("10.90.0.8", "192.0.2.11:51890") },
      ]),
      deps,
    );
    expect(state.control).toMatchObject({ ok: false, detail: "ENOTFOUND" });
    expect(state.results).toEqual([
      { targetId: "node-a", protocol: "amneziawg3", status: "error", detail: "control target failed", endpointHost: null, egressIp: null, levels: levelsNull },
      { targetId: "node-b", protocol: "amneziawg3", status: "error", detail: "control target failed", endpointHost: null, egressIp: null, levels: levelsNull },
    ]);
    expect(fake.calls).toEqual([]);
    expect(ping).not.toHaveBeenCalled();
    expect(tcpBanner).not.toHaveBeenCalled();
  });

  it("control answering 5xx counts as a failed control", async () => {
    const { deps } = setup({ httpGet: vi.fn(async () => ({ status: 503, body: "" })) });
    const state = await runAll(request([]), deps);
    expect(state.control).toMatchObject({ ok: false, detail: "HTTP 503" });
  });

  it("http level passes when body IP equals expectedEgressIp", async () => {
    const { deps, httpGet } = setup({ egressBody: "198.51.100.20" });
    const state = await runAll(
      request([
        {
          targetId: "node-a",
          protocol: "amneziawg3",
          config: conf("10.90.0.7", "192.0.2.10:51890"),
          expectedEgressIp: "198.51.100.20",
        },
      ]),
      deps,
    );
    expect(state.results[0]?.levels.http).toMatchObject({ ok: true, detail: null });
    expect(state.results[0]?.egressIp).toBe("198.51.100.20");
    expect(httpGet).toHaveBeenCalledWith("https://egress.example.test/", expect.objectContaining({ localAddress: "10.90.0.7" }));
  });

  it("http level falls back to the endpoint IP when expectedEgressIp is absent", async () => {
    const { deps } = setup({ egressBody: "192.0.2.10" });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.results[0]?.levels.http.ok).toBe(true);
  });

  it("http level fails with the mismatch in detail otherwise", async () => {
    const { deps } = setup({ egressBody: "198.51.100.9" });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.results[0]?.status).toBe("done");
    expect(state.results[0]?.levels.http).toMatchObject({ ok: false, detail: "egress 198.51.100.9 != 192.0.2.10" });
    expect(state.results[0]?.egressIp).toBe("198.51.100.9");
  });

  it("http level fails without echoing a body that is not an IP", async () => {
    const { deps } = setup({ egressBody: "<html>blocked page</html>" });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.results[0]?.levels.http).toMatchObject({ ok: false, detail: "egress response is not an IP" });
    expect(state.results[0]?.egressIp).toBeNull();
  });

  it("http level fails on a request error with its code", async () => {
    const { deps } = setup({
      httpGet: vi.fn(async (url: string) => {
        if (url.includes("control")) return { status: 200, body: "" };
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }),
    });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.results[0]?.levels.http).toMatchObject({ ok: false, detail: "ECONNRESET", latencyMs: null });
  });

  it("http level is skipped (ok:null) when handshake failed", async () => {
    const { deps, httpGet } = setup({
      respond: (call) => (isHandshakePoll(call) ? { stdout: "cHVibGlj\t0\n" } : {}),
    });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.results[0]?.status).toBe("done");
    expect(state.results[0]?.levels.handshake).toMatchObject({ ok: false, detail: "no handshake in 15s" });
    expect(state.results[0]?.levels.http).toEqual({ ok: null, detail: null, latencyMs: null });
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it("bad config yields status:\"error\" with the ConfigError reason; next target still runs", async () => {
    const { deps } = setup();
    const state = await runAll(
      request([
        { targetId: "node-a", protocol: "amneziawg3", config: "[Interface]\nPrivateKey = SENTINEL\n" },
        { targetId: "node-b", protocol: "amneziawg3", config: conf("10.90.0.8", "192.0.2.10:51890") },
      ]),
      deps,
    );
    expect(state.results[0]).toEqual({
      targetId: "node-a",
      protocol: "amneziawg3",
      status: "error",
      detail: "config must have exactly one [Peer]",
      endpointHost: null,
      egressIp: null,
      levels: levelsNull,
    });
    expect(state.results[1]?.status).toBe("done");
    expect(state.results[1]?.levels.http.ok).toBe(true);
  });

  it("a tunnel that cannot be set up is an error, keeps ping/tcp and tears down", async () => {
    const { deps, fake } = setup({
      respond: (call) => (call.cmd === "amneziawg-go" ? { code: 1, stderr: "tun: no such device" } : {}),
    });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") }]),
      deps,
    );
    expect(state.results[0]).toMatchObject({
      status: "error",
      detail: "tunnel setup failed: amneziawg-go failed (exit 1)",
      levels: { ping: { ok: true }, tcp: { ok: true }, handshake: { ok: null }, http: { ok: null } },
    });
    expect(fake.lines()).toContain("ip link delete awgp0");
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("conf file is written 0600 and deleted after the target", async () => {
    const seen: { mode: number; content: string }[] = [];
    const { deps } = setup({
      respond: (call) => {
        if (call.cmd === "awg" && call.args[0] === "setconf") {
          const path = call.args[2]!;
          expect(path.startsWith(tmpDir)).toBe(true);
          seen.push({ mode: statSync(path).mode & 0o777, content: readFileSync(path, "utf8") });
        }
        return isHandshakePoll(call) ? { stdout: "cHVibGlj\t1700000000\n" } : {};
      },
    });
    await runAll(
      request([
        { targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890", "10.0.0.0/8") },
      ]),
      deps,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe(0o600);
    expect(seen[0]?.content).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(seen[0]?.content).not.toMatch(/^(Address|DNS|MTU)\s*=/m);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("endpoint hostname is resolved once and the IP used for ping/tcp/compare", async () => {
    const lookup = vi.fn(async (_host: string) => "192.0.2.44");
    let written = "";
    const { deps, ping, tcpBanner } = setup({
      lookup,
      egressBody: "192.0.2.44",
      respond: (call) => {
        if (call.cmd === "awg" && call.args[0] === "setconf") written = readFileSync(call.args[2]!, "utf8");
        return isHandshakePoll(call) ? { stdout: "cHVibGlj\t1700000000\n" } : {};
      },
    });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "node-a.example.test:51890") }]),
      deps,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("node-a.example.test");
    expect(ping).toHaveBeenCalledWith("192.0.2.44");
    expect(tcpBanner).toHaveBeenCalledWith("192.0.2.44");
    expect(written).toContain("Endpoint = 192.0.2.44:51890");
    expect(state.results[0]).toMatchObject({
      endpointHost: "node-a.example.test",
      levels: { http: { ok: true } },
    });
  });

  it("an endpoint that does not resolve is an error", async () => {
    const { deps, fake } = setup({
      lookup: vi.fn(async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND node-a.example.test"), { code: "ENOTFOUND" });
      }),
    });
    const state = await runAll(
      request([{ targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "node-a.example.test:51890") }]),
      deps,
    );
    expect(state.results[0]).toMatchObject({
      status: "error",
      detail: "endpoint lookup failed: ENOTFOUND",
      endpointHost: "node-a.example.test",
    });
    expect(fake.calls).toEqual([]);
  });

  it("reports progress with partial results, and the state never carries configs", async () => {
    const snapshots: RunState[] = [];
    const { deps } = setup();
    const state = await runAll(
      request([
        { targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") },
        { targetId: "node-b", protocol: "amneziawg3", config: conf("10.90.0.8", "192.0.2.10:51890") },
      ]),
      deps,
      (snapshot) => snapshots.push(snapshot),
    );
    expect(snapshots.map((s) => s.results.length)).toEqual([0, 1, 2, 2]);
    expect(snapshots.slice(0, 3).every((s) => s.finishedAt === null)).toBe(true);
    expect(snapshots.at(-1)).toEqual(state);
    expect(JSON.stringify(snapshots)).not.toContain("PrivateKey");
  });

  it("brings the tunnel down after every target", async () => {
    const { deps, fake } = setup();
    await runAll(
      request([
        { targetId: "node-a", protocol: "amneziawg3", config: conf("10.90.0.7", "192.0.2.10:51890") },
        { targetId: "node-b", protocol: "amneziawg2", config: conf("10.90.0.7", "192.0.2.10:51890") },
      ]),
      deps,
    );
    const lines = fake.lines();
    const ups = lines.flatMap((line, i) => (line === "amneziawg-go awgp0" ? [i] : []));
    const downs = lines.flatMap((line, i) => (line === "ip link delete awgp0" ? [i] : []));
    expect(ups).toHaveLength(2);
    expect(downs).toHaveLength(2);
    expect(downs[0]).toBeLessThan(ups[1]!);
  });
});
