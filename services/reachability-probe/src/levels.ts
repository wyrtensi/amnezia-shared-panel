import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIPv4, type Socket } from "node:net";

import type { Exec } from "./exec.js";
import type { LevelResult } from "./types.js";

/** At most this much of a response body is kept; the rest is not read. */
export const MAX_BODY_BYTES = 4096;

const MAX_DETAIL = 80;

/** A printable, bounded copy of something a remote end sent. */
const printable = (text: string, max = MAX_DETAIL): string =>
  text.replace(/[^\x20-\x7e]/g, "?").slice(0, max);

/** The short code of a socket or DNS error, else a bounded message. */
export const errorCode = (error: unknown): string => {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return printable(message, 120);
  }
  return "error";
};

/** ICMP echo to the endpoint. Informational: many hosts drop ping. */
export const pingLevel = async (exec: Exec, host: string): Promise<LevelResult> => {
  const result = await exec("ping", ["-c", "3", "-W", "2", "-q", host], { timeoutMs: 15_000 });
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(result.stdout);
  const rtt = /=\s*[\d.]+\/([\d.]+)\//.exec(result.stdout);
  const detail = counts
    ? `${counts[2]}/${counts[1]} received`
    : printable(result.stderr.split("\n")[0] ?? "") || `exit ${result.code}`;
  if (result.code !== 0) return { ok: false, detail, latencyMs: null };
  return { ok: true, detail, latencyMs: rtt ? Math.round(Number(rtt[1])) : null };
};

type Connect = (options: { host: string; port: number }) => Socket;

/**
 * Connect to the endpoint host on TCP and read the first line. An SSH banner
 * means the host is up and TCP to it gets through. Informational only.
 */
export const tcpBannerLevel = (
  host: string,
  port = 22,
  timeoutMs = 5000,
  connect: Connect = netConnect,
): Promise<LevelResult> =>
  new Promise((resolve) => {
    const started = Date.now();
    let buffer = "";
    let settled = false;
    const socket = connect({ host, port });
    const finish = (result: LevelResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const evaluate = (line: string) => {
      const banner = printable(line.replace(/\r$/, ""));
      finish({ ok: banner.startsWith("SSH-"), detail: banner, latencyMs: Math.max(0, Date.now() - started) });
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "timeout", latencyMs: null }), timeoutMs);
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) evaluate(buffer.slice(0, newline));
      else if (buffer.length >= 255) evaluate(buffer);
    });
    socket.on("close", () => {
      if (buffer) evaluate(buffer);
      else finish({ ok: false, detail: "closed", latencyMs: null });
    });
    socket.on("error", (error) => finish({ ok: false, detail: errorCode(error), latencyMs: null }));
  });

export type HttpGet = (
  url: string,
  opts: { localAddress?: string; timeoutMs: number },
) => Promise<{ status: number; body: string }>;

/**
 * GET a URL, optionally from a given source address (the tunnel address, which
 * the source rule sends through the tunnel). No redirects, no connection reuse,
 * body capped at MAX_BODY_BYTES, one deadline for the whole exchange.
 */
export const httpGet: HttpGet = (url, opts) =>
  new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("invalid url"));
      return;
    }
    const request =
      parsed.protocol === "https:" ? httpsRequest : parsed.protocol === "http:" ? httpRequest : null;
    if (!request) {
      reject(new Error("unsupported url scheme"));
      return;
    }
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    let status = 0;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (error) reject(error);
      else resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
    };
    const req = request(
      parsed,
      {
        method: "GET",
        // A pooled socket could outlive the tunnel it was bound to.
        agent: false,
        localAddress: opts.localAddress,
        // An AAAA answer cannot be reached from an IPv4 source address.
        family: opts.localAddress && isIPv4(opts.localAddress) ? 4 : undefined,
        headers: { "user-agent": "reachability-probe", accept: "*/*" },
      },
      (res) => {
        status = res.statusCode ?? 0;
        res.on("data", (chunk: Buffer) => {
          const room = MAX_BODY_BYTES - size;
          if (room > 0) {
            const part = chunk.subarray(0, room);
            chunks.push(part);
            size += part.length;
          }
          if (size >= MAX_BODY_BYTES) settle(null);
        });
        res.on("end", () => settle(null));
        res.on("error", (error) => settle(error));
      },
    );
    const timer = setTimeout(
      () => settle(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
      opts.timeoutMs,
    );
    req.on("error", (error) => settle(error));
    req.end();
  });
