import { createHash } from "node:crypto";
import { request } from "node:https";
import { isIPv4 } from "node:net";

import type { LevelResult } from "./types.js";

const MAX_DOWNLOAD_BYTES = 256 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;

type DownloadFixture = { url: URL; bytes: number; sha256: string };

/** The fixture is host configuration, never taken from a probe run request. */
export const parseDownloadFixture = (env: NodeJS.ProcessEnv): DownloadFixture | undefined => {
  const urlText = env.PROBE_DOWNLOAD_URL?.trim();
  const bytesText = env.PROBE_DOWNLOAD_BYTES?.trim();
  const sha256 = env.PROBE_DOWNLOAD_SHA256?.trim().toLowerCase();
  if (!urlText && !bytesText && !sha256) return undefined;

  const url = urlText ? URL.parse(urlText) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid PROBE_DOWNLOAD_URL: expected HTTPS without credentials, query or fragment");
  }
  const bytes = bytesText && /^\d+$/.test(bytesText) ? Number(bytesText) : 0;
  if (bytes < 1 || bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`invalid PROBE_DOWNLOAD_BYTES: expected 1–${MAX_DOWNLOAD_BYTES} bytes`);
  }
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("invalid PROBE_DOWNLOAD_SHA256: expected a hexadecimal SHA-256 digest");
  }
  return { url, bytes, sha256 };
};

const failure = (detail: string): LevelResult => ({ ok: false, detail, latencyMs: null });

/** Verify a complete file without buffering its body or following redirects. */
export const downloadLevel = (fixture: DownloadFixture, localAddress: string): Promise<LevelResult> =>
  new Promise<LevelResult>((resolve) => {
    const started = performance.now();
    const hash = createHash("sha256");
    let received = 0;
    let settled = false;

    const finish = (level: LevelResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(level);
    };

    const req = request(fixture.url, {
      method: "GET",
      agent: false,
      localAddress,
      family: isIPv4(localAddress) ? 4 : 6,
      headers: { "user-agent": "reachability-probe", "accept-encoding": "identity" },
    }, (res) => {
      const incomplete = () => finish(failure("incomplete download"));
      res.on("error", incomplete);
      res.on("close", () => { if (!res.complete) incomplete(); });
      if (res.statusCode !== 200) {
        finish(failure(`HTTP ${res.statusCode ?? 0}`));
        return;
      }
      const encoding = res.headers["content-encoding"];
      if (encoding && encoding.toLowerCase() !== "identity") {
        finish(failure("unexpected download encoding"));
        return;
      }
      const length = res.headers["content-length"];
      if (length !== undefined && Number(length) !== fixture.bytes) {
        finish(failure("download size differs"));
        return;
      }
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > fixture.bytes) finish(failure("download size differs"));
        else hash.update(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        if (!res.complete) incomplete();
        else if (received !== fixture.bytes) finish(failure("download size differs"));
        else if (hash.digest("hex") !== fixture.sha256) finish(failure("download checksum differs"));
        else {
          finish({
            ok: true,
            detail: `${received} bytes verified`,
            latencyMs: Math.round(performance.now() - started),
          });
        }
      });
    });
    const timer = setTimeout(() => finish(failure("download timeout")), DOWNLOAD_TIMEOUT_MS);
    req.on("error", () => finish(failure("download request failed")));
    req.end();
  }).catch(() => failure("download request failed"));
