import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadApiKey, parseListen } from "../src/env.js";
import { createServer, type Runner } from "../src/server.js";
import type { RunRequest, RunState } from "../src/types.js";

const API_KEY = "k".repeat(40);
const SENTINEL = "SENTINEL-CONFIG-0f9e8d7c";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** A runner the test finishes by hand, reporting one partial result first. */
const controlledRunner = () => {
  const done = deferred<void>();
  const seen: RunRequest[] = [];
  const runner: Runner = async (req, onProgress) => {
    seen.push(req);
    const partial: RunState = {
      runId: req.runId,
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: null,
      control: { ok: true, detail: "HTTP 200", latencyMs: 30 },
      results: [
        {
          targetId: req.targets[0]?.targetId ?? "none",
          protocol: "amneziawg3",
          status: "done",
          detail: null,
          endpointHost: "192.0.2.10",
          egressIp: "192.0.2.10",
          levels: {
            ping: { ok: true, detail: "3/3 received", latencyMs: 20 },
            tcp: { ok: true, detail: "SSH-2.0-OpenSSH", latencyMs: 21 },
            handshake: { ok: true, detail: null, latencyMs: 500 },
            http: { ok: true, detail: null, latencyMs: 90 },
          },
        },
      ],
    };
    onProgress(partial);
    await done.promise;
    return { ...partial, finishedAt: "2026-11-10T10:01:00.000Z" };
  };
  return { runner, finish: () => done.resolve(), seen };
};

const start = async (runner: Runner) => {
  const server = createServer({ apiKey: API_KEY, runner });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bodies: string[] = [];
  const call = async (
    method: string,
    path: string,
    opts: { key?: string | null; body?: unknown; raw?: string } = {},
  ) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = opts.key === undefined ? API_KEY : opts.key;
    if (key !== null) headers["x-api-key"] = key;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, json: text ? (JSON.parse(text) as unknown) : null };
  };
  return { call, bodies };
};

const validRun = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  runId: "1b4e28ba-2fa1-4d2a-883f-0016d3cca427",
  control: { url: "https://control.example.test/" },
  egress: { url: "http://egress.example.test/" },
  targets: [
    {
      targetId: "node-a",
      protocol: "amneziawg3",
      config: `[Interface]\nPrivateKey = ${SENTINEL}\n`,
      expectedEgressIp: "192.0.2.10",
    },
  ],
  ...overrides,
});

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
};

describe("expectedEgressIp parsing", () => {
  it("keeps explicit null, a string and an omitted field apart", async () => {
    const { runner, seen, finish } = controlledRunner();
    const { call } = await start(runner);
    const base = validRun();
    const target = base.targets[0] as RunRequest["targets"][number];
    const { expectedEgressIp: _omitted, ...withoutField } = target;
    const res = await call("POST", "/runs", {
      body: {
        ...base,
        targets: [
          { ...target, targetId: "str" },
          { ...target, targetId: "null", expectedEgressIp: null },
          { ...withoutField, targetId: "omitted" },
        ],
      },
    });
    expect(res.status).toBe(202);
    await waitFor(async () => seen.length === 1);
    const targets = seen[0]?.targets ?? [];
    expect(targets[0]?.expectedEgressIp).toBe("192.0.2.10");
    expect(targets[1]).toHaveProperty("expectedEgressIp", null);
    expect(targets[2]).not.toHaveProperty("expectedEgressIp");
    finish();
  });

  it("rejects a non-string, non-null value", async () => {
    const { call } = await start(controlledRunner().runner);
    const base = validRun();
    const target = base.targets[0] as RunRequest["targets"][number];
    const res = await call("POST", "/runs", {
      body: { ...base, targets: [{ ...target, expectedEgressIp: 5 }] },
    });
    expect(res.status).toBe(400);
  });
});

describe("capabilities", () => {
  it("needs the key", async () => {
    const { call } = await start(controlledRunner().runner);
    expect((await call("GET", "/capabilities", { key: null })).status).toBe(401);
    expect((await call("GET", "/capabilities", { key: "x".repeat(40) })).status).toBe(401);
  });

  it("reports the API version and bridge-measurement", async () => {
    const { call } = await start(controlledRunner().runner);
    const res = await call("GET", "/capabilities");
    expect(res).toMatchObject({
      status: 200,
      json: { apiVersion: 1, capabilities: ["bridge-measurement"] },
    });
  });

  it("is read-only", async () => {
    const { call } = await start(controlledRunner().runner);
    expect((await call("POST", "/capabilities", { body: {} })).status).toBe(405);
  });
});

describe("auth", () => {
  it("/healthz answers without a key", async () => {
    const { call } = await start(controlledRunner().runner);
    const res = await call("GET", "/healthz", { key: null });
    expect(res).toMatchObject({ status: 200, json: { ok: true } });
  });

  it("every other route needs the key", async () => {
    const { call } = await start(controlledRunner().runner);
    for (const [method, path] of [
      ["GET", "/runs/latest"],
      ["POST", "/runs"],
      ["GET", "/nope"],
    ] as const) {
      const body = method === "POST" ? validRun() : undefined;
      expect((await call(method, path, { key: null, body })).status).toBe(401);
      expect((await call(method, path, { key: "wrong", body })).status).toBe(401);
      expect((await call(method, path, { key: `${API_KEY}x`, body })).status).toBe(401);
    }
  });

  it("unknown routes are 404 with the key", async () => {
    const { call } = await start(controlledRunner().runner);
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("DELETE", "/runs")).status).toBe(405);
  });

  it("refuses to be created with a short key", () => {
    expect(() => createServer({ apiKey: "short", runner: controlledRunner().runner })).toThrow(/32/);
  });
});

describe("POST /runs", () => {
  const invalid: [string, (run: RunRequest) => unknown][] = [
    ["missing runId", ({ runId: _r, ...rest }) => rest],
    ["missing targets", ({ targets: _t, ...rest }) => rest],
    ["targets not an array", (run) => ({ ...run, targets: "node-a" })],
    ["missing control", ({ control: _c, ...rest }) => rest],
    ["non-http control url", (run) => ({ ...run, control: { url: "file:///etc/passwd" } })],
    ["bad egress url", (run) => ({ ...run, egress: { url: "not a url" } })],
    [
      "more than 500 targets",
      (run) => ({ ...run, targets: Array.from({ length: 501 }, () => run.targets[0]) }),
    ],
    [
      "config over 16 KiB",
      (run) => ({ ...run, targets: [{ ...run.targets[0], config: SENTINEL + "x".repeat(16 * 1024) }] }),
    ],
    ["empty config", (run) => ({ ...run, targets: [{ ...run.targets[0], config: "" }] })],
    ["missing targetId", (run) => ({ ...run, targets: [{ ...run.targets[0], targetId: undefined }] })],
    [
      "expectedEgressIp over 64 chars",
      (run) => ({ ...run, targets: [{ ...run.targets[0], expectedEgressIp: SENTINEL.repeat(3) }] }),
    ],
    ["runId over 100 chars", (run) => ({ ...run, runId: "r".repeat(101) })],
    [
      "protocol over 20 chars",
      (run) => ({ ...run, targets: [{ ...run.targets[0], protocol: "p".repeat(21) }] }),
    ],
  ];

  it.each(invalid)("400 on %s", async (_name, mutate) => {
    const { runner, seen } = controlledRunner();
    const { call, bodies } = await start(runner);
    const res = await call("POST", "/runs", { body: mutate(validRun()) });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
    expect(bodies.join("\n")).not.toContain(SENTINEL);
  });

  it("400 on a body that is not JSON", async () => {
    const { call } = await start(controlledRunner().runner);
    expect((await call("POST", "/runs", { raw: "{nope" })).status).toBe(400);
  });

  it("accepts exactly 500 targets and a 16 KiB config", async () => {
    const { call } = await start(controlledRunner().runner);
    const run = validRun();
    const target = { ...run.targets[0]!, config: "x".repeat(16 * 1024) };
    const res = await call("POST", "/runs", {
      body: { ...run, targets: Array.from({ length: 500 }, () => target) },
    });
    expect(res.status).toBe(202);
  });

  it("202 {runId}, and 409 while a run is in progress", async () => {
    const { runner, finish, seen } = controlledRunner();
    const { call } = await start(runner);
    const first = await call("POST", "/runs", { body: validRun() });
    expect(first).toMatchObject({ status: 202, json: { runId: validRun().runId } });
    expect(seen[0]?.targets[0]?.config).toContain(SENTINEL);
    const second = await call("POST", "/runs", { body: { ...validRun(), runId: "second" } });
    expect(second.status).toBe(409);
    finish();
    await waitFor(async () => ((await call("GET", "/runs/latest")).json as RunState).finishedAt !== null);
    expect((await call("POST", "/runs", { body: { ...validRun(), runId: "third" } })).status).toBe(202);
  });

  it("a runner that throws still finishes the run", async () => {
    const runner: Runner = async () => {
      throw new Error("boom");
    };
    const { call } = await start(runner);
    expect((await call("POST", "/runs", { body: validRun() })).status).toBe(202);
    await waitFor(async () => ((await call("GET", "/runs/latest")).json as RunState).finishedAt !== null);
    const latest = (await call("GET", "/runs/latest")).json as RunState;
    expect(latest.runId).toBe(validRun().runId);
    expect(latest.results).toEqual([]);
    expect((await call("POST", "/runs", { body: { ...validRun(), runId: "next" } })).status).toBe(202);
  });
});

describe("GET /runs/latest", () => {
  it("404 before any run; partial during; full after; never the configs", async () => {
    const { runner, finish } = controlledRunner();
    const { call, bodies } = await start(runner);
    expect((await call("GET", "/runs/latest")).status).toBe(404);

    await call("POST", "/runs", { body: validRun() });
    const during = await call("GET", "/runs/latest");
    expect(during.status).toBe(200);
    expect(during.json).toMatchObject({
      runId: validRun().runId,
      finishedAt: null,
      results: [{ targetId: "node-a", status: "done" }],
    });

    finish();
    await waitFor(async () => ((await call("GET", "/runs/latest")).json as RunState).finishedAt !== null);
    const after = await call("GET", "/runs/latest");
    expect(after.json).toMatchObject({
      runId: validRun().runId,
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: "2026-11-10T10:01:00.000Z",
      control: { ok: true },
      results: [{ targetId: "node-a", levels: { handshake: { ok: true }, http: { ok: true } } }],
    });

    expect(bodies.join("\n")).not.toContain(SENTINEL);
  });
});

describe("env", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("parses PROBE_LISTEN", () => {
    expect(parseListen(undefined)).toEqual({ host: "0.0.0.0", port: 4002 });
    expect(parseListen("127.0.0.1:5000")).toEqual({ host: "127.0.0.1", port: 5000 });
    expect(() => parseListen("127.0.0.1")).toThrow();
    expect(() => parseListen("127.0.0.1:70000")).toThrow();
  });

  it("loads the API key and refuses one under 32 chars", () => {
    dir = mkdtempSync(join(tmpdir(), "probe-env-"));
    const good = join(dir, "good");
    const bad = join(dir, "bad");
    writeFileSync(good, `${API_KEY}\n`);
    writeFileSync(bad, "short\n");
    expect(loadApiKey(good)).toBe(API_KEY);
    expect(() => loadApiKey(bad)).toThrow(/32/);
    expect(() => loadApiKey(join(dir, "missing"))).toThrow();
  });
});
