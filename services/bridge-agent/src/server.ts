import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { identity, status, type AgentContext } from "./status.js";
import {
  clockSkewNote,
  MAX_UPDATE_RECORD_BYTES,
  readUpdate,
  submitUpdate,
  updateRequestSchema,
  UUID,
} from "./update.js";

export type ServerOptions = {
  apiToken: string;
  context: AgentContext;
  /** Bounded operational lines (never secrets); defaults to none. */
  log?: (line: string) => void;
};

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant-time check: equal-length digests, so the token length does not leak either. */
const tokenMatches = (expected: Buffer, header: string | string[] | undefined): boolean => {
  if (typeof header !== "string") return false;
  const match = /^Bearer (.+)$/i.exec(header);
  return match?.[1] !== undefined && timingSafeEqual(expected, digest(match[1]));
};

const send = (res: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}): void => {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
};

const sendError = (res: ServerResponse, statusCode: number, code: string, headers?: Record<string, string>): void =>
  send(res, statusCode, { error: { code } }, headers);

class BodyError extends Error {}

/** Reads at most MAX_UPDATE_RECORD_BYTES; a larger or unparsable body is a 400, never a partial read. */
const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPDATE_RECORD_BYTES) throw new BodyError("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError("body is not JSON");
  }
};

export const createServer = (options: ServerOptions): Server => {
  const expected = digest(options.apiToken);
  const log = options.log ?? (() => {});
  const now = (): Date => options.context.now?.() ?? new Date();

  /**
   * `/v1/update`. The status codes are what the panel classifies on
   * (`classifyBridgeAgentUpdateSend/Read` in packages/contracts): 400/422 are
   * a refused intent, 409 a conflict, 2xx accepted (including `expired`), and
   * 404 on GET only when there is positively no record of the operation.
   * A spool record that exists but cannot be read is a 5xx, never a 404.
   */
  const handleUpdate = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const update = options.context.update;
    if (!update) return sendError(res, 404, "NOT_FOUND");
    if (req.method === "GET") {
      const operationId = url.searchParams.get("operationId") ?? "";
      if (!UUID.test(operationId)) return sendError(res, 400, "INVALID_REQUEST");
      const known = readUpdate(update.spool, operationId, now());
      return known ? send(res, 200, known) : sendError(res, 404, "UNKNOWN_OPERATION");
    }
    if (req.method !== "POST") return sendError(res, 405, "METHOD_NOT_ALLOWED", { allow: "GET, POST" });

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyError) return sendError(res, 400, "INVALID_REQUEST");
      throw error;
    }
    const parsed = updateRequestSchema.safeParse(body);
    if (!parsed.success) return sendError(res, 400, "INVALID_REQUEST");
    const request = parsed.data;
    if (request.imageRepository !== update.approvedRepository) {
      return sendError(res, 422, "REPOSITORY_NOT_APPROVED");
    }
    const at = now();
    const outcome = submitUpdate(update.spool, request, at);
    if (outcome.kind === "conflict") return sendError(res, 409, "OPERATION_CONFLICT");
    if (outcome.kind === "busy") return sendError(res, 409, "UPDATE_IN_PROGRESS");
    if (outcome.created) {
      log(`update ${request.operationId}: recorded (${outcome.status.state})`);
      const skew = clockSkewNote(request, at);
      if (skew) log(skew);
    }
    return send(res, outcome.created ? 202 : 200, outcome.status);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const isGet = req.method === "GET";

    // The container healthcheck: no auth, no data, no upstream call.
    if (path === "/healthz" && isGet) return send(res, 200, { ok: true });

    // Authenticate before routing so unknown paths do not reveal what exists.
    if (!tokenMatches(expected, req.headers.authorization)) {
      return sendError(res, 401, "UNAUTHORIZED", { "www-authenticate": "Bearer" });
    }
    if (path === "/v1/identity" || path === "/v1/status") {
      if (!isGet) return sendError(res, 405, "METHOD_NOT_ALLOWED", { allow: "GET" });
      return send(res, 200, path === "/v1/identity" ? identity(options.context) : await status(options.context));
    }
    if (path === "/v1/update") return handleUpdate(req, res, url);
    return sendError(res, 404, "NOT_FOUND");
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, "INTERNAL_ERROR");
      else res.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
};
