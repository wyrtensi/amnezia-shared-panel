import { lookup as dnsLookup } from "node:dns/promises";
import * as https from "node:https";
import type { BridgePanelDnsStatus } from "@amnezia/contracts";

const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 2_500;

export type PanelDnsLookup = (hostname: string) => Promise<readonly string[]>;
export type PanelHttpsProbe = (ipv4: string, hostname: string) => Promise<boolean>;

export type BridgePanelDnsOptions = {
  env?: Record<string, string | undefined>;
  lookupIpv4?: PanelDnsLookup;
  probeHttps?: PanelHttpsProbe;
  cacheTtlMs?: number;
  now?: () => Date;
};

const normalizeHostname = (raw: string): string | null => {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (candidate.includes("://")) {
    try {
      candidate = new URL(candidate).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    candidate = candidate.replace(/\/.*$/, "").replace(/:\d+$/, "");
  }
  if (!HOSTNAME_RE.test(candidate) || IPV4_RE.test(candidate)) return null;
  return candidate;
};

/**
 * Fallback candidate panel hostnames derived from deployment configuration
 * when a bridge does not yet have its own `panelDnsHostname` stored.
 */
export const candidatePanelHostnames = (
  env: Record<string, string | undefined> = process.env,
): string[] => {
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const host = normalizeHostname(raw);
    if (host) seen.add(host);
  };

  for (const part of (env.PANEL_BRIDGE_DOMAINS ?? "").split(",")) {
    add(part);
  }

  const publicHost = env.PANEL_PUBLIC_URL ? normalizeHostname(env.PANEL_PUBLIC_URL) : null;
  if (publicHost) {
    seen.add(publicHost);
    const labels = publicHost.split(".");
    if (labels.length >= 3) {
      const parent = labels.slice(1).join(".");
      for (const prefix of ["me", "panel", "bridge", "link"]) {
        seen.add(`${prefix}.${parent}`);
      }
    }
  }

  return [...seen];
};

const defaultLookupIpv4 =
  (timeoutMs: number): PanelDnsLookup =>
  async (hostname: string): Promise<readonly string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        dnsLookup(hostname, { family: 4, all: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("DNS_TIMEOUT")), timeoutMs);
        }),
      ]);
      return records.map((entry) => entry.address);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

/**
 * Connect directly to the registered public bridge IPv4 on TCP 443 with TLS
 * SNI set to `hostname` and verify `/login` responds with HTTP 200..399.
 */
const defaultProbeHttps =
  (timeoutMs: number): PanelHttpsProbe =>
  (ipv4: string, hostname: string): Promise<boolean> =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: ipv4,
          port: 443,
          servername: hostname,
          method: "GET",
          path: "/login",
          headers: {
            host: hostname,
            "user-agent": "amnezia-panel-dns-check/1.0",
          },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          const code = res.statusCode ?? 0;
          resolve(code >= 200 && code < 400);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });

export const createBridgePanelDnsChecker = (options: BridgePanelDnsOptions = {}) => {
  const env = options.env ?? process.env;
  const lookup = options.lookupIpv4 ?? defaultLookupIpv4(DEFAULT_TIMEOUT_MS);
  const probe = options.probeHttps ?? defaultProbeHttps(DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());

  const cache = new Map<string, { status: BridgePanelDnsStatus; expiresAt: number }>();
  const inFlight = new Map<string, Promise<BridgePanelDnsStatus>>();

  const evaluate = async (
    publicIpv4: string,
    configuredHostname: string | null,
  ): Promise<BridgePanelDnsStatus> => {
    const checkedAt = now().toISOString();
    if (configuredHostname) {
      const addresses = await lookup(configuredHostname);
      if (!addresses.includes(publicIpv4)) {
        return {
          state: "dns_mismatch",
          hostname: configuredHostname,
          checkedAt: now().toISOString(),
        };
      }
      const httpsOk = await probe(publicIpv4, configuredHostname);
      return {
        state: httpsOk ? "active" : "https_unreachable",
        hostname: configuredHostname,
        checkedAt: now().toISOString(),
      };
    }

    const candidates = candidatePanelHostnames(env);
    if (candidates.length === 0) {
      return { state: "unconfigured", hostname: null, checkedAt: null };
    }
    const resolutions = await Promise.all(
      candidates.map(async (hostname) => ({
        hostname,
        addresses: await lookup(hostname),
      })),
    );
    const matched = resolutions.find((entry) => entry.addresses.includes(publicIpv4));
    if (!matched) {
      return { state: "unconfigured", hostname: null, checkedAt };
    }
    const httpsOk = await probe(publicIpv4, matched.hostname);
    return {
      state: httpsOk ? "active" : "https_unreachable",
      hostname: matched.hostname,
      checkedAt: now().toISOString(),
    };
  };

  return async (
    publicIpv4: string,
    configuredHostname?: string | null,
  ): Promise<BridgePanelDnsStatus | undefined> => {
    const normalized = configuredHostname ? normalizeHostname(configuredHostname) : null;
    const candidates = candidatePanelHostnames(env);
    if (!normalized && candidates.length === 0) return undefined;

    const cacheKey = `${publicIpv4}:${normalized ?? ""}`;
    const timestamp = now().getTime();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > timestamp) {
      return cached.status;
    }
    let pending = inFlight.get(cacheKey);
    if (!pending) {
      pending = evaluate(publicIpv4, normalized).finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, pending);
    }
    const status = await pending;
    cache.set(cacheKey, { status, expiresAt: now().getTime() + cacheTtlMs });
    return status;
  };
};
