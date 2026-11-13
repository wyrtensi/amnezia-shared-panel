import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import { ConfigError, extractConf, parseClientConfig, withEndpoint } from "./config.js";
import type { Exec } from "./exec.js";
import { errorCode, type HttpGet } from "./levels.js";
import { realClock, Tunnel } from "./tunnel.js";
import {
  notAttempted,
  type LevelResult,
  type RunRequest,
  type RunState,
  type RunTarget,
  type TargetLevels,
  type TargetResult,
} from "./types.js";

export type RunDeps = {
  exec: Exec;
  httpGet: HttpGet;
  ping: (host: string) => Promise<LevelResult>;
  tcpBanner: (host: string) => Promise<LevelResult>;
  /** Where stripped configs are written (a tmpfs in the container). */
  tmpDir: string;
  now(): Date;
  /** Resolve an endpoint hostname to one address. */
  lookup?: (host: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  handshakeTimeoutMs?: number;
  /** Progress lines. Never receives config content. */
  log?: (line: string) => void;
};

const CONTROL_TIMEOUT_MS = 10_000;
const EGRESS_TIMEOUT_MS = 10_000;
const MAX_DETAIL = 200;

const defaultLookup = async (host: string): Promise<string> =>
  (await dnsLookup(host, { order: "ipv4first" })).address;

const emptyLevels = (): TargetLevels => ({
  ping: notAttempted(),
  tcp: notAttempted(),
  handshake: notAttempted(),
  http: notAttempted(),
});

const bounded = (text: string): string => text.slice(0, MAX_DETAIL);

/** Whole, non-negative milliseconds (the wire schema's latencyMs). */
const elapsed = (deps: RunDeps, startedMs: number): number =>
  Math.max(0, Math.round(deps.now().getTime() - startedMs));

const checkControl = async (url: string, deps: RunDeps): Promise<LevelResult> => {
  const started = deps.now().getTime();
  try {
    const { status } = await deps.httpGet(url, { timeoutMs: CONTROL_TIMEOUT_MS });
    const ok = status >= 200 && status < 400;
    return { ok, detail: `HTTP ${status}`, latencyMs: ok ? elapsed(deps, started) : null };
  } catch (error) {
    return { ok: false, detail: errorCode(error), latencyMs: null };
  }
};

const checkEgress = async (
  url: string,
  localAddress: string,
  expected: string | null,
  deps: RunDeps,
): Promise<{ level: LevelResult; egressIp: string | null }> => {
  const started = deps.now().getTime();
  try {
    const { status, body } = await deps.httpGet(url, { localAddress, timeoutMs: EGRESS_TIMEOUT_MS });
    const latencyMs = elapsed(deps, started);
    const text = body.trim();
    const egressIp = isIP(text) ? text : null;
    if (status < 200 || status >= 300) {
      return { level: { ok: false, detail: `HTTP ${status}`, latencyMs }, egressIp };
    }
    // The body is only echoed when it is an address: a block page is not ours to store.
    if (!egressIp) return { level: { ok: false, detail: "egress response is not an IP", latencyMs }, egressIp };
    // An answer at all is the proof: the socket is bound to the tunnel address,
    // and table 200 sends that address nowhere but the tunnel. A node may leave
    // through another address of its own, so a different IP is a note, not a
    // failure.
    // `expected` is null for a bridged path with no known origin exit IP:
    // the observed address is reported and not compared.
    if (expected !== null && egressIp !== expected) {
      return {
        level: { ok: true, detail: `egress ${egressIp} differs from ${expected}`, latencyMs },
        egressIp,
      };
    }
    return { level: { ok: true, detail: null, latencyMs }, egressIp };
  } catch (error) {
    return { level: { ok: false, detail: errorCode(error), latencyMs: null }, egressIp: null };
  }
};

const runTarget = async (
  target: RunTarget,
  egressUrl: string,
  deps: RunDeps,
): Promise<TargetResult> => {
  const result: TargetResult = {
    targetId: target.targetId,
    protocol: target.protocol,
    status: "done",
    detail: null,
    endpointHost: null,
    egressIp: null,
    levels: emptyLevels(),
  };
  const fail = (detail: string): TargetResult => ({ ...result, status: "error", detail: bounded(detail) });

  let cfg;
  try {
    cfg = parseClientConfig(extractConf(target.config));
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    return fail("config could not be read");
  }
  result.endpointHost = cfg.endpointHost;

  // Resolved once, so ping, tcp, the tunnel and the egress comparison all
  // talk about the same address.
  let endpointIp = cfg.endpointHost;
  if (!isIP(endpointIp)) {
    try {
      endpointIp = await (deps.lookup ?? defaultLookup)(cfg.endpointHost);
    } catch (error) {
      return fail(`endpoint lookup failed: ${errorCode(error)}`);
    }
  }

  const [ping, tcp] = await Promise.all([deps.ping(endpointIp), deps.tcpBanner(endpointIp)]);
  result.levels.ping = ping;
  result.levels.tcp = tcp;

  const confPath = join(deps.tmpDir, `probe-${randomUUID()}.conf`);
  const tunnel = new Tunnel(deps.exec, "awgp0", 200, {
    now: () => deps.now().getTime(),
    sleep: deps.sleep ?? realClock.sleep,
  });
  try {
    await writeFile(confPath, withEndpoint(cfg.stripped, endpointIp, cfg.endpointPort), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await tunnel.up(cfg, confPath);
    } catch (error) {
      return fail(`tunnel setup failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
    result.levels.handshake = await tunnel.waitHandshake(deps.handshakeTimeoutMs ?? 15_000);
    if (result.levels.handshake.ok) {
      // The panel's known public IP; a value that is not an address falls
      // back to the endpoint, as when none was sent. Explicit null compares
      // nothing.
      const expected =
        target.expectedEgressIp === null
          ? null
          : target.expectedEgressIp && isIP(target.expectedEgressIp)
            ? target.expectedEgressIp
            : endpointIp;
      const egress = await checkEgress(egressUrl, cfg.address, expected, deps);
      result.levels.http = egress.level;
      result.egressIp = egress.egressIp;
    }
    return result;
  } catch (error) {
    return fail(`probe failure: ${errorCode(error)}`);
  } finally {
    await tunnel.down();
    await rm(confPath, { force: true }).catch(() => {});
  }
};

const snapshot = (state: RunState): RunState => structuredClone(state);

/**
 * One run: the control first, then every target in turn. Sequential on
 * purpose: two nodes can hand out the same tunnel address, and one interface
 * at a time keeps them from clashing.
 */
export const runAll = async (
  req: RunRequest,
  deps: RunDeps,
  onProgress?: (state: RunState) => void,
): Promise<RunState> => {
  const log = deps.log ?? (() => {});
  const state: RunState = {
    runId: req.runId,
    startedAt: deps.now().toISOString(),
    finishedAt: null,
    control: notAttempted(),
    results: [],
  };
  state.control = await checkControl(req.control.url, deps);
  log(`run ${req.runId}: control ${state.control.ok ? "ok" : "failed"} (${state.control.detail})`);
  onProgress?.(snapshot(state));

  for (const target of req.targets) {
    let result: TargetResult;
    if (!state.control.ok) {
      // Nothing can be concluded about a node when the vantage point itself is offline.
      result = {
        targetId: target.targetId,
        protocol: target.protocol,
        status: "error",
        detail: "control target failed",
        endpointHost: null,
        egressIp: null,
        levels: emptyLevels(),
      };
    } else {
      result = await runTarget(target, req.egress.url, deps);
      const { levels } = result;
      log(
        `run ${req.runId}: ${target.targetId}/${target.protocol} ${result.status}` +
          ` handshake=${String(levels.handshake.ok)} http=${String(levels.http.ok)}` +
          (result.detail ? ` (${result.detail})` : ""),
      );
    }
    state.results.push(result);
    if (state.control.ok) onProgress?.(snapshot(state));
  }

  state.finishedAt = deps.now().toISOString();
  onProgress?.(snapshot(state));
  return state;
};
