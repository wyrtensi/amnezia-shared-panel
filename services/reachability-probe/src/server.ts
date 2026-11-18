import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { MIN_API_KEY_LENGTH } from "./env.js";
import { notAttempted, PROBE_API_VERSION, PROBE_CAPABILITIES, type RunRequest, type RunState, type RunTarget } from "./types.js";

export type Runner = (req: RunRequest, onProgress: (state: RunState) => void) => Promise<RunState>;

export type ServerOptions = {
  apiKey: string;
  runner: Runner;
  now?: () => Date;
  /** Never receives request bodies or configs. */
  log?: (line: string) => void;
};

export const MAX_TARGETS = 500;
export const MAX_CONFIG_BYTES = 16 * 1024;
// Field limits match probeRunRequestSchema in @amnezia/contracts.
const MAX_RUN_ID_LENGTH = 100;
const MAX_TARGET_ID_LENGTH = 200;
const MAX_PROTOCOL_LENGTH = 20;
const MAX_EXPECTED_IP_LENGTH = 64;
const MAX_URL_LENGTH = 2048;
/** 500 configs at the limit plus JSON overhead. */
const MAX_BODY_BYTES = 9 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant-time key check: equal-length digests, so length leaks nothing either. */
const keyMatches = (expected: Buffer, provided: string | string[] | undefined): boolean =>
  typeof provided === "string" && timingSafeEqual(expected, digest(provided));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const httpUrl = (value: unknown, field: string): string => {
  const url = isRecord(value) ? value.url : undefined;
  if (!boundedString(url, MAX_URL_LENGTH)) throw new HttpError(400, `${field}.url is required`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `${field}.url is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `${field}.url must be http or https`);
  }
  return url;
};

/** Validate a run request. Messages name fields only, never their values. */
export const parseRunRequest = (body: unknown): RunRequest => {
  if (!isRecord(body)) throw new HttpError(400, "body must be an object");
  if (!boundedString(body.runId, MAX_RUN_ID_LENGTH)) throw new HttpError(400, "runId is required");
  const control = httpUrl(body.control, "control");
  const egress = httpUrl(body.egress, "egress");
  if (!Array.isArray(body.targets)) throw new HttpError(400, "targets must be an array");
  if (body.targets.length > MAX_TARGETS) {
    throw new HttpError(400, `at most ${MAX_TARGETS} targets`);
  }
  const targets = body.targets.map((raw: unknown, index): RunTarget => {
    const at = `targets[${index}]`;
    if (!isRecord(raw)) throw new HttpError(400, `${at} must be an object`);
    if (!boundedString(raw.targetId, MAX_TARGET_ID_LENGTH)) {
      throw new HttpError(400, `${at}.targetId is required`);
    }
    if (!boundedString(raw.protocol, MAX_PROTOCOL_LENGTH)) {
      throw new HttpError(400, `${at}.protocol is required`);
    }
    if (typeof raw.config !== "string" || raw.config.trim() === "") {
      throw new HttpError(400, `${at}.config is required`);
    }
    if (Buffer.byteLength(raw.config, "utf8") > MAX_CONFIG_BYTES) {
      throw new HttpError(400, `${at}.config is larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    const target: RunTarget = { targetId: raw.targetId, protocol: raw.protocol, config: raw.config };
    if (raw.expectedEgressIp === null) {
      // Explicit null is kept: it is not the same as omitted (see RunTarget).
      target.expectedEgressIp = null;
    } else if (raw.expectedEgressIp !== undefined) {
      const expected = raw.expectedEgressIp;
      if (typeof expected !== "string" || expected.length > MAX_EXPECTED_IP_LENGTH) {
        throw new HttpError(400, `${at}.expectedEgressIp must be a string of at most 64 chars`);
      }
      target.expectedEgressIp = expected;
    }
    return target;
  });
  return { runId: body.runId, control: { url: control }, egress: { url: egress }, targets };
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, "body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
};

/**
 * The probe API. A run is asynchronous: POST /runs starts it and returns at
 * once, GET /runs/latest shows it as it goes. Only the latest run is kept, in
 * memory; configs live only inside the running runner.
 */
export const createServer = (options: ServerOptions): Server => {
  if (options.apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(`the API key must contain at least ${MIN_API_KEY_LENGTH} characters`);
  }
  const expectedKey = digest(options.apiKey);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  let latest: RunState | null = null;
  let running = false;

  const startRun = (request: RunRequest): void => {
    running = true;
    latest = {
      runId: request.runId,
      startedAt: now().toISOString(),
      finishedAt: null,
      control: notAttempted(),
      results: [],
    };
    log(`run ${request.runId}: started with ${request.targets.length} targets`);
    options
      .runner(request, (state) => {
        if (latest?.runId === request.runId) latest = state;
      })
      .then(
        (state) => {
          latest = state;
          log(`run ${request.runId}: finished`);
        },
        (error: unknown) => {
          if (latest) latest = { ...latest, finishedAt: now().toISOString() };
          log(`run ${request.runId}: runner failed: ${error instanceof Error ? error.name : "error"}`);
        },
      )
      .finally(() => {
        running = false;
      });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://probe").pathname;
    if (path === "/healthz" && req.method === "GET") {
      send(res, 200, { ok: true });
      return;
    }
    if (!keyMatches(expectedKey, req.headers["x-api-key"])) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    if (path === "/capabilities") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      send(res, 200, { apiVersion: PROBE_API_VERSION, capabilities: [...PROBE_CAPABILITIES] });
      return;
    }
    if (path === "/runs") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "body is not JSON");
      }
      const request = parseRunRequest(body);
      if (running) {
        send(res, 409, { error: "a run is in progress", runId: latest?.runId ?? null });
        return;
      }
      startRun(request);
      send(res, 202, { runId: request.runId });
      return;
    }
    if (path === "/runs/latest") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (!latest) throw new HttpError(404, "no run yet");
      send(res, 200, latest);
      return;
    }
    throw new HttpError(404, "not found");
  };

  return createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
        if (error.status === 413) req.destroy();
        return;
      }
      log(`request failed: ${error instanceof Error ? error.name : "error"}`);
      send(res, 500, { error: "internal error" });
    });
  });
};
