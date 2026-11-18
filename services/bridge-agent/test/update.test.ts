import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadUpdateConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { spoolOf, type UpdateSpool } from "../src/update.js";

const TOKEN = "t".repeat(40);
const BRIDGE_ID = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const REPO = "ghcr.io/example/panel/bridge-agent";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const OP = "0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
const OP2 = "1c7a0b63-4d2e-4f8b-8c99-2a3b4c5d6e7f";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const NOT_AFTER = "2026-11-13T12:02:00.000Z";

let root: string;
let spool: UpdateSpool;
let clock: number;
let logs: string[];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-agent-update-"));
  spool = spoolOf(root);
  mkdirSync(spool.requestsDir);
  mkdirSync(spool.resultsDir);
  clock = T0;
  logs = [];
});
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

const boot = async (update: { approvedRepository: string; spool: UpdateSpool } | null = { approvedRepository: REPO, spool }) => {
  const server: Server = createServer({
    apiToken: TOKEN,
    context: {
      bridgeId: BRIDGE_ID,
      agentVersion: "0.2.0",
      applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
      frps: { baseUrl: "http://127.0.0.1:1", user: "u", password: "p", timeoutMs: 100, maxBytes: 1024 },
      update,
      now: () => new Date(clock),
    },
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const auth = { authorization: `Bearer ${TOKEN}` };
// Response bodies are asserted field by field; the shapes are what is under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const intent = (extra: Record<string, unknown> = {}) => ({
  operationId: OP,
  imageRepository: REPO,
  imageDigest: DIGEST,
  notAfter: NOT_AFTER,
  ...extra,
});
const post = (base: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}/v1/update`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (base: string, operationId: string, headers: Record<string, string> = auth) =>
  fetch(`${base}/v1/update?operationId=${encodeURIComponent(operationId)}`, { headers });

const requestFile = (id = OP) => join(spool.requestsDir, `${id}.json`);
const writeResult = (id: string, body: Record<string, unknown>) =>
  writeFileSync(join(spool.resultsDir, `${id}.json`), `${JSON.stringify({ operationId: id, ...body })}\n`);
const hostResult = (id: string, state: string, extra: Record<string, unknown> = {}) =>
  writeResult(id, {
    imageRepository: REPO,
    imageDigest: DIGEST,
    notAfter: NOT_AFTER,
    state,
    updatedAt: "2026-11-13T12:00:30Z",
    ...extra,
  });

describe("capability", () => {
  it("identity reports update.v1 only when updates are configured", async () => {
    const on = await boot();
    expect((await json(await fetch(`${on}/v1/identity`, { headers: auth }))).capabilities).toEqual(["status.v1", "update.v1"]);
    const off = await boot(null);
    expect((await json(await fetch(`${off}/v1/identity`, { headers: auth }))).capabilities).toEqual(["status.v1"]);
    // Without the capability the route does not exist (the panel reads 404 as unsupported).
    expect((await post(off, intent())).status).toBe(404);
  });

  it("needs the bearer token on both methods", async () => {
    const base = await boot();
    expect((await post(base, intent(), {})).status).toBe(401);
    expect((await get(base, OP, {})).status).toBe(401);
    expect(readdirSync(spool.requestsDir)).toEqual([]);
  });

  it("other methods are 405, never 404", async () => {
    const base = await boot();
    const res = await fetch(`${base}/v1/update`, { method: "PUT", headers: auth });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});

describe("POST /v1/update", () => {
  it("records a new intent atomically and answers 202 queued", async () => {
    const base = await boot();
    const res = await post(base, intent());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ operationId: OP, state: "queued", updatedAt: "2026-11-13T12:00:00.000Z" });
    // Only the final file remains: the temp file was renamed, not left behind.
    expect(readdirSync(spool.requestsDir)).toEqual([`${OP}.json`]);
    expect(JSON.parse(readFileSync(requestFile(), "utf8"))).toEqual({ ...intent(), receivedAt: "2026-11-13T12:00:00.000Z" });
    expect(statSync(requestFile()).mode & 0o777).toBe(0o600);
    expect(logs).toEqual([`update ${OP}: recorded (queued)`]);
  });

  it("a replay of the same intent returns its known state and rewrites nothing", async () => {
    const base = await boot();
    await post(base, intent());
    const before = statSync(requestFile());
    clock += 5_000;
    const replay = await post(base, intent());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ operationId: OP, state: "queued", updatedAt: "2026-11-13T12:00:00.000Z" });
    const after = statSync(requestFile());
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);

    // After the host took it over, the replay reports the host's state.
    hostResult(OP, "replacing");
    const later = await post(base, intent());
    expect(later.status).toBe(200);
    expect(await later.json()).toEqual({ operationId: OP, state: "replacing", updatedAt: "2026-11-13T12:00:30Z" });
  });

  it("the same id with another intent is 409 OPERATION_CONFLICT, also after the host consumed the request", async () => {
    const base = await boot();
    await post(base, intent());
    const conflict = await post(base, intent({ imageDigest: OTHER_DIGEST }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "OPERATION_CONFLICT" } });
    expect((await post(base, intent({ notAfter: "2026-11-13T12:03:00.000Z" }))).status).toBe(409);

    // The host keeps the intent in its result, so the check survives the request file.
    rmSync(requestFile());
    hostResult(OP, "succeeded");
    expect((await post(base, intent({ imageDigest: OTHER_DIGEST }))).status).toBe(409);
    expect((await post(base, intent())).status).toBe(200);
  });

  it("refuses a second operation while one is queued or running on the host", async () => {
    const base = await boot();
    await post(base, intent());
    const busy = await post(base, intent({ operationId: OP2 }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: { code: "UPDATE_IN_PROGRESS" } });

    // Claimed and running on the host: still busy.
    hostResult(OP, "health_check");
    rmSync(requestFile());
    expect((await post(base, intent({ operationId: OP2 }))).status).toBe(409);

    // Terminal: the slot is free.
    hostResult(OP, "rolled_back", { errorCode: "HEALTH_FRPS_UNREACHABLE" });
    expect((await post(base, intent({ operationId: OP2 }))).status).toBe(202);
  });

  it("an unclaimed request past its notAfter no longer blocks another operation", async () => {
    const base = await boot();
    await post(base, intent());
    clock = Date.parse(NOT_AFTER);
    const next = await post(base, intent({ operationId: OP2, notAfter: "2026-11-13T12:05:00.000Z" }));
    expect(next.status).toBe(202);
  });

  it("an intent that arrives at or after notAfter is recorded and answered expired", async () => {
    const base = await boot();
    clock = Date.parse(NOT_AFTER);
    const late = await post(base, intent());
    expect(late.status).toBe(202);
    expect(await late.json()).toEqual({ operationId: OP, state: "expired", updatedAt: NOT_AFTER });
    // Recorded, so a later GET and a replay agree.
    expect((await json(await get(base, OP))).state).toBe("expired");
    expect(await (await post(base, intent())).json()).toMatchObject({ state: "expired" });
  });

  it("accepts any UTC ISO time the panel's contract allows (fractions up to nanoseconds)", async () => {
    const base = await boot();
    const res = await post(base, intent({ notAfter: "2026-11-13T12:02:00.123456789Z" }));
    expect(res.status).toBe(202);
    expect((await json(await post(base, intent({ notAfter: "2026-11-13T12:02:00.123Z" })))).state).toBe("queued");
  });

  it("logs a bounded clock-skew note when notAfter is far from local time", async () => {
    const base = await boot();
    await post(base, intent({ notAfter: "2026-11-13T13:00:00.000Z" }));
    expect(logs).toContain(
      `update ${OP}: notAfter is 3600s from local time (expected 0..120s); check the clocks of the panel and this bridge`,
    );
    clock = Date.parse("2026-11-13T12:10:00.000Z");
    await post(base, intent({ operationId: OP2, notAfter: NOT_AFTER }));
    expect(logs.some((line) => line.includes(`update ${OP2}: notAfter is -480s`))).toBe(true);
    expect(logs.every((line) => line.length < 200)).toBe(true);
  });

  it("an unapproved repository is 422 and writes nothing", async () => {
    const base = await boot();
    const res = await post(base, intent({ imageRepository: "ghcr.io/evil/panel/bridge-agent" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "REPOSITORY_NOT_APPROVED" } });
    expect(readdirSync(spool.requestsDir)).toEqual([]);
  });

  it.each([
    ["a tag", { imageDigest: "1.2.3" }],
    ["a short digest", { imageDigest: `sha256:${"a".repeat(63)}` }],
    ["an uppercase digest", { imageDigest: `sha256:${"A".repeat(64)}` }],
    ["a repository with a digest", { imageRepository: `${REPO}@${DIGEST}` }],
    ["a non-uuid id", { operationId: "../../etc/passwd" }],
    ["an uppercase uuid", { operationId: OP.toUpperCase() }],
    ["a missing notAfter", { notAfter: undefined }],
    ["a notAfter with an offset", { notAfter: "2026-11-13T14:02:00+02:00" }],
    ["a non-date notAfter", { notAfter: "2026-13-45T99:99:99Z" }],
  ])("%s is 400 INVALID_REQUEST", async (_name, extra) => {
    const base = await boot();
    const res = await post(base, intent(extra));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
    expect(readdirSync(spool.requestsDir)).toEqual([]);
  });

  it("a malformed or oversized body is 400", async () => {
    const base = await boot();
    expect((await post(base, "{not json")).status).toBe(400);
    expect((await post(base, JSON.stringify({ ...intent(), pad: "x".repeat(5000) }))).status).toBe(400);
    expect(readdirSync(spool.requestsDir)).toEqual([]);
  });

  it("an unwritable spool is a 500 (retried by the panel), never an accepted intent", async () => {
    const base = await boot();
    rmSync(spool.requestsDir, { recursive: true });
    const res = await post(base, intent());
    expect(res.status).toBe(500);
  });
});

describe("GET /v1/update", () => {
  it("reports the host's result verbatim, with its bounded error code", async () => {
    const base = await boot();
    hostResult(OP, "rollback_failed", { errorCode: "ROLLBACK_VERIFICATION_FAILED" });
    const res = await get(base, OP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      operationId: OP,
      state: "rollback_failed",
      updatedAt: "2026-11-13T12:00:30Z",
      errorCode: "ROLLBACK_VERIFICATION_FAILED",
    });
  });

  it("a claimed operation is never turned into expired by the agent's clock", async () => {
    const base = await boot();
    await post(base, intent());
    hostResult(OP, "queued");
    clock = Date.parse("2026-11-13T13:00:00.000Z");
    expect((await json(await get(base, OP))).state).toBe("queued");
  });

  it("an unclaimed request is queued before notAfter and expired from then on", async () => {
    const base = await boot();
    await post(base, intent());
    clock = Date.parse(NOT_AFTER) - 1;
    expect((await json(await get(base, OP))).state).toBe("queued");
    clock = Date.parse(NOT_AFTER);
    expect(await (await get(base, OP)).json()).toEqual({ operationId: OP, state: "expired", updatedAt: NOT_AFTER });
  });

  it("a host-refused request without intent fields is still reported", async () => {
    const base = await boot();
    writeResult(OP, { state: "failed", updatedAt: "2026-11-13T12:00:30Z", errorCode: "REQUEST_INVALID" });
    expect(await (await get(base, OP)).json()).toEqual({
      operationId: OP,
      state: "failed",
      updatedAt: "2026-11-13T12:00:30Z",
      errorCode: "REQUEST_INVALID",
    });
  });

  it("an unknown operation is 404 with a typed body, distinct from a missing route", async () => {
    const base = await boot();
    const res = await get(base, OP);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "UNKNOWN_OPERATION" } });
  });

  it("a bad or missing operationId is 400", async () => {
    const base = await boot();
    expect((await get(base, "nope")).status).toBe(400);
    expect((await fetch(`${base}/v1/update`, { headers: auth })).status).toBe(400);
  });

  it.each([
    ["for another operation", () => writeResult(OP, { operationId: OP2, state: "succeeded", updatedAt: "x" })],
    ["with an unknown state", () => hostResult(OP, "rebooting")],
    ["with a free-text error", () => hostResult(OP, "failed", { errorCode: "docker said: no" })],
    ["that is not JSON", () => writeFileSync(join(spool.resultsDir, `${OP}.json`), "garbage")],
    ["that is oversized", () => hostResult(OP, "failed", { pad: "x".repeat(5000) })],
    ["that is a symlink", () => {
      writeFileSync(join(root, "elsewhere.json"), JSON.stringify({ operationId: OP, state: "succeeded", updatedAt: "x" }));
      symlinkSync(join(root, "elsewhere.json"), join(spool.resultsDir, `${OP}.json`));
    }],
  ])("a result %s is a 500, never a 404 or a made-up state", async (_name, plant) => {
    const base = await boot();
    plant();
    const res = await get(base, OP);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL_ERROR" } });
  });
});

describe("update configuration", () => {
  it("is off without an approved repository", () => {
    expect(loadUpdateConfig({})).toBeNull();
    expect(loadUpdateConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: "  " })).toBeNull();
  });

  it("needs a bare repository and an absolute spool path", () => {
    expect(() => loadUpdateConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: `${REPO}@${DIGEST}`, BRIDGE_UPDATE_SPOOL_DIR: root })).toThrow(/bare repository/);
    expect(() => loadUpdateConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: REPO, BRIDGE_UPDATE_SPOOL_DIR: "relative" })).toThrow(/absolute/);
  });

  it("refuses a spool without writable requests or readable results", () => {
    expect(loadUpdateConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: REPO, BRIDGE_UPDATE_SPOOL_DIR: root })).toEqual({
      approvedRepository: REPO,
      spool,
    });
    rmSync(spool.resultsDir, { recursive: true });
    expect(() => loadUpdateConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: REPO, BRIDGE_UPDATE_SPOOL_DIR: root })).toThrow(/not usable/);
    mkdirSync(spool.resultsDir);
    // A non-root test run cannot write a 0500 directory (root in the container would be refused by the read-only mount).
    if (process.getuid?.() !== 0) {
      chmodSync(spool.requestsDir, 0o500);
      expect(() => loadUpdateConfig({ BRIDGE_AGENT_IMAGE_REPOSITORY: REPO, BRIDGE_UPDATE_SPOOL_DIR: root })).toThrow(/not usable/);
      chmodSync(spool.requestsDir, 0o700);
    }
  });
});
