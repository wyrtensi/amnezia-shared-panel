import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import type { WytunnelInstanceStatus, WytunnelTelemetry } from "./types.js";

export const DEFAULT_WYTUNNEL_RUN_DIR = "/run/amnezia-wytunnel";
export const DEFAULT_WYTUNNEL_TIMEOUT_MS = 1000;
const SOCKET_RE = /^client-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sock$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_META_BYTES = 4096;

type RawMeta = {
  remotePort?: unknown;
  startedAt?: unknown;
};

type RawMetrics = {
  version?: unknown;
  mode?: unknown;
  ebpfMode?: unknown;
  uptimeSec?: unknown;
  activeSessions?: unknown;
  healthyStreams?: unknown;
  targetStreams?: unknown;
  drainingStreams?: unknown;
  poolRttMs?: unknown;
  rxPackets?: unknown;
  txPackets?: unknown;
  fecRecovered?: unknown;
  fecLostGroups?: unknown;
  keepaliveResets?: unknown;
  failoversTotal?: unknown;
  rotationsTotal?: unknown;
};

const nonNegInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

const nonNegNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

const readMeta = (runDir: string, routeId: string): { remotePort: number | null; startedAt: string | null } => {
  let fd: number | null = null;
  try {
    fd = openSync(join(runDir, `client-${routeId}.meta.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_META_BYTES) {
      return { remotePort: null, startedAt: null };
    }
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    const raw = JSON.parse(buf.subarray(0, n).toString("utf8")) as RawMeta;
    const remotePort =
      typeof raw.remotePort === "number" && Number.isInteger(raw.remotePort) && raw.remotePort >= 1 && raw.remotePort <= 65535
        ? raw.remotePort
        : null;
    const startedAt = typeof raw.startedAt === "string" && raw.startedAt.length > 0 ? raw.startedAt : null;
    return { remotePort, startedAt };
  } catch {
    return { remotePort: null, startedAt: null };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error on read-only metadata fd.
      }
    }
  }
};

const queryUnixSocketJson = (socketPath: string, timeoutMs: number): Promise<RawMetrics> =>
  new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const req = httpRequest(
      {
        socketPath,
        path: "/status",
        method: "GET",
        headers: { host: "localhost", accept: "application/json" },
        signal,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`status ${res.statusCode ?? 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RawMetrics;
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

const markerFor = (routeId: string, remotePort: number | null, startedAt: string | null, version: string | null): string =>
  createHash("sha256")
    .update(`wytunnel:${routeId}:${remotePort ?? 0}:${startedAt ?? ""}:${version ?? ""}`)
    .digest("hex")
    .slice(0, 32);

const parseTelemetry = (raw: RawMetrics): WytunnelTelemetry => ({
  ...(typeof raw.version === "string" && raw.version.length <= 64 ? { version: raw.version } : {}),
  ...(raw.mode === "pool" || raw.mode === "direct" ? { mode: raw.mode } : {}),
  ...(raw.ebpfMode === "nic" || raw.ebpfMode === "userspace_fallback" ? { ebpfMode: raw.ebpfMode } : {}),
  ...(nonNegInt(raw.uptimeSec) !== undefined ? { uptimeSec: nonNegInt(raw.uptimeSec) } : {}),
  ...(nonNegInt(raw.activeSessions) !== undefined ? { activeSessions: nonNegInt(raw.activeSessions) } : {}),
  ...(nonNegInt(raw.healthyStreams) !== undefined ? { healthyStreams: nonNegInt(raw.healthyStreams) } : {}),
  ...(nonNegInt(raw.targetStreams) !== undefined ? { targetStreams: nonNegInt(raw.targetStreams) } : {}),
  ...(nonNegInt(raw.drainingStreams) !== undefined ? { drainingStreams: nonNegInt(raw.drainingStreams) } : {}),
  ...(raw.poolRttMs === null
    ? { poolRttMs: null }
    : nonNegNum(raw.poolRttMs) !== undefined
      ? { poolRttMs: nonNegNum(raw.poolRttMs) }
      : {}),
  ...(nonNegInt(raw.rxPackets) !== undefined ? { rxPackets: nonNegInt(raw.rxPackets) } : {}),
  ...(nonNegInt(raw.txPackets) !== undefined ? { txPackets: nonNegInt(raw.txPackets) } : {}),
  ...(nonNegInt(raw.fecRecovered) !== undefined ? { fecRecovered: nonNegInt(raw.fecRecovered) } : {}),
  ...(nonNegInt(raw.fecLostGroups) !== undefined ? { fecLostGroups: nonNegInt(raw.fecLostGroups) } : {}),
  ...(nonNegInt(raw.keepaliveResets) !== undefined ? { keepaliveResets: nonNegInt(raw.keepaliveResets) } : {}),
  ...(nonNegInt(raw.failoversTotal) !== undefined ? { failoversTotal: nonNegInt(raw.failoversTotal) } : {}),
  ...(nonNegInt(raw.rotationsTotal) !== undefined ? { rotationsTotal: nonNegInt(raw.rotationsTotal) } : {}),
});

/**
 * Discovers local WyTunnel client status sockets (`client-<routeUuid>.sock`) in
 * `runDir`, queries each with a bounded wall-clock timeout, and returns normalized
 * status entries. Returns `undefined` when `runDir` does not exist (`ENOENT`/`ENOTDIR`)
 * so unmounted/misconfigured hosts stay Unknown rather than marking routes offline.
 */
export const readWytunnelInstances = async (
  runDir: string = DEFAULT_WYTUNNEL_RUN_DIR,
  timeoutMs: number = DEFAULT_WYTUNNEL_TIMEOUT_MS,
): Promise<WytunnelInstanceStatus[] | undefined> => {
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    return undefined;
  }

  const routeSockets: Array<{ routeId: string; socketPath: string }> = [];
  for (const name of names) {
    const match = SOCKET_RE.exec(name);
    if (match?.[1]) {
      const socketPath = join(runDir, name);
      try {
        if (lstatSync(socketPath).isSocket()) {
          routeSockets.push({ routeId: match[1], socketPath });
        }
      } catch {
        // Ignore transient unlinked sockets.
      }
    }
  }
  routeSockets.sort((a, b) => a.routeId.localeCompare(b.routeId));

  const results = await Promise.all(
    routeSockets.map(async ({ routeId, socketPath }): Promise<WytunnelInstanceStatus> => {
      const meta = readMeta(runDir, routeId);
      try {
        const raw = await queryUnixSocketJson(socketPath, timeoutMs);
        const telemetry = parseTelemetry(raw);
        const target = telemetry.targetStreams ?? 0;
        const healthy = telemetry.healthyStreams ?? 0;
        // Fail closed: require either an explicit healthy pool stream or an explicit direct mode response.
        const online =
          telemetry.mode === "pool" || target > 0
            ? healthy > 0
            : telemetry.mode === "direct";
        return {
          routeId,
          remotePort: meta.remotePort,
          online,
          registrationMarker: online
            ? markerFor(routeId, meta.remotePort, meta.startedAt, telemetry.version ?? null)
            : null,
          telemetry,
        };
      } catch {
        return {
          routeId,
          remotePort: meta.remotePort,
          online: false,
          registrationMarker: null,
        };
      }
    }),
  );

  return results;
};
