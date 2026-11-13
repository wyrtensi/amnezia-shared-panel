import { createHash } from "node:crypto";
import { request } from "node:http";

import { z } from "zod";

import type { ErrorCode, ProxyStatus } from "./types.js";

/** An upstream failure carrying only a code from the fixed enum; never response text. */
export class FrpsError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export type FrpsClientOptions = {
  baseUrl: string;
  user: string;
  password: string;
  timeoutMs: number;
  maxBytes: number;
};

/**
 * Response models of frp v0.72.0 (server/http/model/types.go: ServerInfoResp,
 * GetProxyInfoResp, ProxyStatsInfo, UDPOutConf). Only the fields the agent
 * reports are listed; zod strips the rest, so nothing else can leak through.
 */
const serverInfoSchema = z.object({ version: z.string().min(1).max(64) });

const proxySchema = z.object({
  name: z.string().min(1).max(200),
  // Null once frps no longer holds the proxy (status "offline").
  conf: z
    .object({
      type: z.string().optional(),
      remotePort: z.number().int().min(0).max(65535).optional(),
    })
    .nullable(),
  clientID: z.string().max(200).optional(),
  lastStartTime: z.string().max(100),
  status: z.enum(["online", "offline"]),
});

const proxyListSchema = z.object({ proxies: z.array(proxySchema) });

/**
 * Stable opaque id of one observed registration. frps assigns `clientID` per
 * frpc client and stamps `lastStartTime` ("MM-DD HH:MM:SS", no year, second
 * resolution) each time the proxy registers, so a re-registration changes it
 * (apart from two registrations in the same wall-clock second). The raw
 * clientID is never exposed.
 */
export const registrationMarker = (clientId: string | undefined, lastStartTime: string): string | null => {
  if (!clientId || !lastStartTime) return null;
  return createHash("sha256").update(`${clientId}\n${lastStartTime}`, "utf8").digest("hex").slice(0, 32);
};

const get = (options: FrpsClientOptions, path: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const authorization = `Basic ${Buffer.from(`${options.user}:${options.password}`, "utf8").toString("base64")}`;
    const req = request(
      `${options.baseUrl}${path}`,
      { method: "GET", headers: { authorization, accept: "application/json" }, timeout: options.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) {
          res.resume();
          reject(new FrpsError("FRPS_AUTH_FAILED", "frps rejected the dashboard credentials"));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new FrpsError("FRPS_HTTP_ERROR", `frps answered HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            reject(new FrpsError("FRPS_MALFORMED_RESPONSE", "frps response exceeds the size limit"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new FrpsError("FRPS_MALFORMED_RESPONSE", "frps response is not JSON"));
          }
        });
        res.on("error", () => reject(new FrpsError("FRPS_UNREACHABLE", "frps connection broke")));
      },
    );
    req.on("timeout", () => {
      reject(new FrpsError("FRPS_TIMEOUT", "frps did not answer in time"));
      req.destroy();
    });
    // After a timeout or size rejection the first reject wins; this only maps genuine socket errors.
    req.on("error", () => reject(new FrpsError("FRPS_UNREACHABLE", "frps is not reachable")));
    req.end();
  });

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) throw new FrpsError("FRPS_MALFORMED_RESPONSE", "frps response does not match the pinned model");
  return result.data;
};

export const fetchServerVersion = async (options: FrpsClientOptions): Promise<string> =>
  parse(serverInfoSchema, await get(options, "/api/serverinfo")).version;

export const fetchUdpProxies = async (options: FrpsClientOptions): Promise<ProxyStatus[]> => {
  const { proxies } = parse(proxyListSchema, await get(options, "/api/proxy/udp"));
  return proxies
    .filter((proxy) => proxy.conf === null || proxy.conf.type === undefined || proxy.conf.type === "udp")
    .map((proxy) => ({
      proxyId: proxy.name,
      remotePort: proxy.conf?.remotePort ?? null,
      online: proxy.status === "online",
      registrationMarker: registrationMarker(proxy.clientID, proxy.lastStartTime),
    }));
};
