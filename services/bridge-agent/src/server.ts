import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { identity, status, type AgentContext } from "./status.js";

export type ServerOptions = {
  apiToken: string;
  context: AgentContext;
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

export const createServer = (options: ServerOptions): Server => {
  const expected = digest(options.apiToken);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
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
