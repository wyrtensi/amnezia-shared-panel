import { isIP, isIPv4 } from "node:net";
import { inflateSync } from "node:zlib";

/**
 * A config the probe cannot use. The message is a short fixed reason and must
 * never quote config content: a config line can be a private key.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type ParsedClientConfig = {
  /** First IPv4 of the Address line, without the mask. */
  address: string;
  mtu: number | null;
  endpointHost: string;
  endpointPort: number;
  /** What `awg setconf` accepts: no interface-only keys, full-tunnel AllowedIPs. */
  stripped: string;
};

const VPN_PREFIX = "vpn://";

/** Keys `wg-quick` understands but `awg setconf` rejects. */
const INTERFACE_ONLY_KEYS = new Set([
  "address",
  "dns",
  "mtu",
  "table",
  "preup",
  "postup",
  "predown",
  "postdown",
  "saveconfig",
]);

/**
 * The probe needs the egress request to go through the tunnel whatever the
 * stored key's route profile is, so a split-tunnel config is widened here.
 */
const FULL_TUNNEL_ALLOWED_IPS = "AllowedIPs = 0.0.0.0/0, ::/0";

/** Decode an AmneziaVPN `vpn://` link: base64url, 4-byte BE length, zlib, JSON. */
export const decodeVpnLink = (link: string): unknown => {
  const trimmed = link.trim();
  if (!trimmed.startsWith(VPN_PREFIX)) {
    throw new ConfigError("link must start with vpn://");
  }
  const payload = Buffer.from(trimmed.slice(VPN_PREFIX.length), "base64url");
  if (payload.byteLength < 5) {
    throw new ConfigError("vpn:// payload is too short");
  }
  const expectedLength = payload.readUInt32BE(0);
  let raw: Buffer;
  try {
    raw = inflateSync(payload.subarray(4));
  } catch {
    throw new ConfigError("vpn:// payload is not valid zlib data");
  }
  if (raw.byteLength !== expectedLength) {
    throw new ConfigError("vpn:// payload length does not match its header");
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new ConfigError("vpn:// payload is not valid JSON");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Return the plain AWG config from a `vpn://` link, or raw conf text as is. */
export const extractConf = (input: string): string => {
  if (!input.trim().startsWith(VPN_PREFIX)) return input;
  const payload = decodeVpnLink(input);
  const containers = isRecord(payload) && Array.isArray(payload.containers) ? payload.containers : [];
  for (const container of containers) {
    if (!isRecord(container) || !isRecord(container.awg)) continue;
    const lastConfig = container.awg.last_config;
    if (typeof lastConfig !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastConfig);
    } catch {
      throw new ConfigError("vpn:// last_config is not valid JSON");
    }
    if (isRecord(parsed) && typeof parsed.config === "string" && parsed.config.trim()) {
      return parsed.config;
    }
  }
  throw new ConfigError("vpn:// payload does not contain an embedded config");
};

type Line =
  | { kind: "section"; name: string; text: string }
  | { kind: "pair"; key: string; value: string; text: string }
  | { kind: "other"; text: string };

const splitLines = (conf: string): Line[] =>
  conf.split(/\r?\n/).map((text): Line => {
    const trimmed = text.trim();
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) return { kind: "section", name: section[1]!.trim().toLowerCase(), text: trimmed };
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !trimmed.startsWith("#")) {
      return {
        kind: "pair",
        key: trimmed.slice(0, eq).trim().toLowerCase(),
        value: trimmed.slice(eq + 1).trim(),
        text: trimmed,
      };
    }
    return { kind: "other", text: trimmed };
  });

const parseEndpoint = (value: string): { host: string; port: number } => {
  let host: string;
  let portText: string;
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (bracketed) {
    host = bracketed[1]!;
    portText = bracketed[2]!;
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0) throw new ConfigError("peer Endpoint has no port");
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
    if (host.includes(":")) throw new ConfigError("peer Endpoint IPv6 host must be bracketed");
  }
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("peer Endpoint port is invalid");
  }
  if (!host || host.length > 253 || /\s/.test(host)) {
    throw new ConfigError("peer Endpoint host is invalid");
  }
  return { host, port };
};

const formatEndpoint = (host: string, port: number): string =>
  isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;

/** Read what the probe needs from a client config and build the `setconf` copy. */
export const parseClientConfig = (conf: string): ParsedClientConfig => {
  const lines = splitLines(conf);
  let section: string | null = null;
  let sawInterface = false;
  let peers = 0;
  const addresses: string[] = [];
  let mtu: number | null = null;
  let endpoint: { host: string; port: number } | null = null;
  const kept: string[] = [];

  for (const line of lines) {
    if (line.kind === "section") {
      section = line.name;
      if (section === "interface") sawInterface = true;
      kept.push(line.text);
      if (section === "peer") {
        peers += 1;
        kept.push(FULL_TUNNEL_ALLOWED_IPS);
      }
      continue;
    }
    if (line.kind === "other") {
      // Comments and blank lines carry nothing awg needs.
      if (line.text === "" && kept.at(-1) !== "") kept.push("");
      continue;
    }
    if (section === "interface") {
      if (line.key === "address") addresses.push(...line.value.split(","));
      if (line.key === "mtu") {
        const value = /^\d+$/.test(line.value) ? Number(line.value) : NaN;
        if (!Number.isInteger(value) || value < 576 || value > 9000) {
          throw new ConfigError("MTU is invalid");
        }
        mtu = value;
      }
    }
    if (section === "peer" && line.key === "endpoint" && endpoint === null) {
      endpoint = parseEndpoint(line.value);
    }
    if (INTERFACE_ONLY_KEYS.has(line.key)) continue;
    if (section === "peer" && line.key === "allowedips") continue;
    kept.push(line.text);
  }

  if (!sawInterface) throw new ConfigError("config has no [Interface] section");
  if (peers !== 1) throw new ConfigError("config must have exactly one [Peer]");
  if (addresses.length === 0) throw new ConfigError("config has no Address");
  const address = addresses
    .map((entry) => entry.trim().split("/")[0]!.trim())
    .find((entry) => isIPv4(entry));
  if (!address) throw new ConfigError("Address has no IPv4");
  if (!endpoint) throw new ConfigError("config has no peer Endpoint");

  return {
    address,
    mtu,
    endpointHost: endpoint.host,
    endpointPort: endpoint.port,
    stripped: `${kept.join("\n").trim()}\n`,
  };
};

/**
 * Pin the peer endpoint to an already resolved address, so `awg setconf` does
 * no DNS of its own and the tunnel goes where ping and tcp went.
 */
export const withEndpoint = (stripped: string, host: string, port: number): string =>
  stripped
    .split("\n")
    .map((line) =>
      /^\s*endpoint\s*=/i.test(line) ? `Endpoint = ${formatEndpoint(host, port)}` : line,
    )
    .join("\n");
