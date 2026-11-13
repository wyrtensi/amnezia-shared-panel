import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import type { AppliedPorts } from "./types.js";
import { REPOSITORY, spoolOf, type UpdateSpool } from "./update.js";

export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_LISTEN = "127.0.0.1:7600";
export const DEFAULT_FRPS_URL = "http://127.0.0.1:7500";
export const DEFAULT_DASHBOARD_ENV_FILE = "/etc/amnezia-bridge/frp/dashboard.env";
export const DEFAULT_FRPS_TIMEOUT_MS = 3000;
export const DEFAULT_FRPS_MAX_BYTES = 1024 * 1024;
export const DEFAULT_UPDATE_SPOOL_DIR = "/var/lib/amnezia-bridge/update";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Config = {
  bridgeId: string;
  listen: { host: string; port: number };
  apiToken: string;
  frps: {
    baseUrl: string;
    user: string;
    password: string;
    timeoutMs: number;
    maxBytes: number;
  };
  applied: AppliedPorts;
  /** Null when no approved repository is configured: no `update.v1`, no `/v1/update`. */
  update: { approvedRepository: string; spool: UpdateSpool } | null;
};

/** True for an IP literal in 127.0.0.0/8 or `::1`. Host names are not accepted: they resolve elsewhere. */
export const isLoopbackAddress = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return bare.startsWith("127.");
  if (family === 6) return bare === "::1";
  return false;
};

/** `host:port` (IPv6 as `[::1]:port`); the host must be a loopback literal. */
export const parseListen = (value: string | undefined): { host: string; port: number } => {
  const text = value?.trim() || DEFAULT_LISTEN;
  const colon = text.lastIndexOf(":");
  const host = colon > 0 ? text.slice(0, colon).replace(/^\[|\]$/g, "") : "";
  const portText = colon > 0 ? text.slice(colon + 1) : "";
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("BRIDGE_AGENT_LISTEN must be host:port");
  }
  if (!isLoopbackAddress(host)) {
    throw new Error("BRIDGE_AGENT_LISTEN must be a loopback address (127.0.0.0/8 or ::1)");
  }
  return { host, port };
};

export const parseFrpsUrl = (value: string | undefined): string => {
  const text = value?.trim() || DEFAULT_FRPS_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("BRIDGE_FRPS_URL is not a URL");
  }
  if (url.protocol !== "http:") throw new Error("BRIDGE_FRPS_URL must be http");
  if (!isLoopbackAddress(url.hostname)) throw new Error("BRIDGE_FRPS_URL must point at a loopback address");
  return `http://${url.host}`;
};

const readFileValue = (path: string, what: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(`cannot read the ${what} file (${typeof code === "string" ? code : "error"})`);
  }
};

/** Refuse a credential file readable by group or others. The value never appears in an error. */
const assertProtected = (path: string, what: string): void => {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return; // the read that follows reports the failure
  }
  if ((mode & 0o077) !== 0) throw new Error(`the ${what} file must not be accessible by group or others (chmod 600)`);
};

export const loadApiToken = (path: string): string => {
  assertProtected(path, "API token");
  const token = readFileValue(path, "API token").trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`the API token must contain at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return token;
};

/** Reads `FRPS_DASHBOARD_USER` / `FRPS_DASHBOARD_PASSWORD` from the installer's `KEY=VALUE` env file. */
export const loadDashboardCredentials = (path: string): { user: string; password: string } => {
  assertProtected(path, "frps dashboard credentials");
  const values = new Map<string, string>();
  for (const line of readFileValue(path, "frps dashboard credentials").split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  const user = values.get("FRPS_DASHBOARD_USER");
  const password = values.get("FRPS_DASHBOARD_PASSWORD");
  if (!user || !password) {
    throw new Error("the frps dashboard credentials file must define FRPS_DASHBOARD_USER and FRPS_DASHBOARD_PASSWORD");
  }
  return { user, password };
};

const port = (env: NodeJS.ProcessEnv, name: string): number => {
  const text = env[name]?.trim() ?? "";
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port (1-65535)`);
  return value;
};

const positiveInt = (env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number => {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer 1-${max}`);
  return value;
};

/**
 * Updates are on only with an approved repository. Its spool must then be
 * usable: requests writable (the one read-write mount), results readable (a
 * read-only mount the host updater writes).
 */
export const loadUpdateConfig = (env: NodeJS.ProcessEnv): Config["update"] => {
  const approvedRepository = env.BRIDGE_AGENT_IMAGE_REPOSITORY?.trim() ?? "";
  if (!approvedRepository) return null;
  if (!REPOSITORY.test(approvedRepository)) {
    throw new Error("BRIDGE_AGENT_IMAGE_REPOSITORY must be a bare repository name (no tag or digest)");
  }
  const spoolDir = env.BRIDGE_UPDATE_SPOOL_DIR?.trim() || DEFAULT_UPDATE_SPOOL_DIR;
  if (!isAbsolute(spoolDir)) throw new Error("BRIDGE_UPDATE_SPOOL_DIR must be an absolute path");
  const spool = spoolOf(spoolDir);
  try {
    accessSync(spool.requestsDir, constants.W_OK | constants.X_OK);
    accessSync(spool.resultsDir, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error("the update spool is not usable: <spool>/requests must be writable and <spool>/results readable");
  }
  return { approvedRepository, spool };
};

/** Throws a secret-free Error describing the first invalid setting. */
export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const bridgeId = env.BRIDGE_ID?.trim() ?? "";
  if (!UUID.test(bridgeId)) throw new Error("BRIDGE_ID must be a lowercase UUID");

  const tokenFile = env.BRIDGE_AGENT_API_TOKEN_FILE?.trim();
  if (!tokenFile) throw new Error("BRIDGE_AGENT_API_TOKEN_FILE is required");

  const applied: AppliedPorts = {
    controlTcpPort: port(env, "BRIDGE_APPLIED_CONTROL_PORT"),
    udpPortStart: port(env, "BRIDGE_APPLIED_UDP_START"),
    udpPortEnd: port(env, "BRIDGE_APPLIED_UDP_END"),
  };
  if (applied.udpPortStart > applied.udpPortEnd) {
    throw new Error("BRIDGE_APPLIED_UDP_START must not exceed BRIDGE_APPLIED_UDP_END");
  }

  const listen = parseListen(env.BRIDGE_AGENT_LISTEN);
  const baseUrl = parseFrpsUrl(env.BRIDGE_FRPS_URL);
  const apiToken = loadApiToken(tokenFile);
  const credentials = loadDashboardCredentials(
    env.BRIDGE_FRPS_DASHBOARD_ENV_FILE?.trim() || DEFAULT_DASHBOARD_ENV_FILE,
  );

  return {
    bridgeId,
    listen,
    apiToken,
    frps: {
      baseUrl,
      ...credentials,
      timeoutMs: positiveInt(env, "BRIDGE_FRPS_TIMEOUT_MS", DEFAULT_FRPS_TIMEOUT_MS, 60_000),
      maxBytes: positiveInt(env, "BRIDGE_FRPS_MAX_BYTES", DEFAULT_FRPS_MAX_BYTES, 16 * 1024 * 1024),
    },
    applied,
    update: loadUpdateConfig(env),
  };
};
