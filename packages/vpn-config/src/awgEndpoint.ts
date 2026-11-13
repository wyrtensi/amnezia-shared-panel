import {
  decodeVpnLink,
  encodeVpnPayload,
  type AmneziaContainer,
  type AmneziaPayload,
} from "./codec.js";

/**
 * AWG endpoint projection for node-issued vpn:// artifacts.
 *
 * The node agent writes the protocol marker `awg.protocol_version`: "3.1" for
 * AmneziaWG 3.1, "2" for both native AWG 2 and the AWG3 service's 2.0 fallback
 * (the two cannot be told apart, and need not be: both stay on the direct
 * path). The legacy AWG layout carries no marker. Only the marker decides the
 * kind; the parser here is independent of the I/J client-profile validator.
 *
 * Error messages never carry artifact content: configs hold private keys.
 */

export type AwgEndpoint = { host: string; port: number };

export type AwgArtifactKind =
  /** One AWG container marked protocol_version "3.1" with one peer endpoint. */
  | "awg31"
  /** One AWG container marked protocol_version "2": native AWG 2 or the AWG3 2.0 fallback. */
  | "awg20"
  /** Not decodable, no AWG container, no recognised marker or an unreadable config. */
  | "unknown"
  /** Several AWG containers, or not exactly one [Peer] section with one parseable Endpoint. */
  | "ambiguous";

export type AwgArtifactInspection =
  | { kind: "awg31"; endpoint: AwgEndpoint }
  | { kind: "awg20" | "unknown" | "ambiguous"; endpoint?: undefined };

export type AwgEndpointRenderErrorCode =
  | "UNSUPPORTED_ARTIFACT"
  | "UNSUPPORTED_PROTOCOL"
  | "AMBIGUOUS_ARTIFACT"
  | "INVALID_ENDPOINT";

export class AwgEndpointRenderError extends Error {
  readonly code: AwgEndpointRenderErrorCode;

  constructor(code: AwgEndpointRenderErrorCode, message: string) {
    super(message);
    this.name = "AwgEndpointRenderError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How `awg.last_config` is stored: a JSON text (what the node writes) or an object. */
type LastConfigForm = "json-indent2" | "json-compact" | "object";

type Located = {
  container: AmneziaContainer;
  awg: Record<string, unknown>;
  lastConfig: Record<string, unknown>;
  form: LastConfigForm;
  lines: string[];
  /** Index of the single Endpoint line in `lines`. */
  endpointLine: number;
  endpoint: AwgEndpoint;
};

type Analysis =
  | { kind: "awg31"; located: Located }
  | { kind: "awg20" }
  | { kind: "unknown" }
  | { kind: "ambiguous" };

const parsePort = (text: string): number | null => {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
};

/** `host:port`, `[v6]:port`. A bare IPv6 without brackets is not an endpoint. */
const parseEndpointValue = (value: string): AwgEndpoint | null => {
  const text = value.trim();
  const bracket = /^\[([^\]\s]+)\]:(\d+)$/.exec(text);
  if (bracket) {
    const port = parsePort(bracket[2] ?? "");
    return port === null ? null : { host: bracket[1] ?? "", port };
  }
  const split = /^([^\s:[\]]+):(\d+)$/.exec(text);
  if (!split) return null;
  const port = parsePort(split[2] ?? "");
  return port === null ? null : { host: split[1] ?? "", port };
};

/**
 * The only Endpoint line of the only [Peer] section, or null when the config
 * has no such unambiguous line.
 */
const findPeerEndpoint = (
  lines: string[],
): { index: number; endpoint: AwgEndpoint } | null => {
  let section = "";
  let peerSections = 0;
  const found: number[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = (header[1] ?? "").trim().toLowerCase();
      if (section === "peer") peerSections += 1;
      continue;
    }
    if (section === "peer" && /^\s*Endpoint\s*=/i.test(line)) found.push(index);
  }
  if (peerSections !== 1 || found.length !== 1) return null;
  const index = found[0] as number;
  const value = /^\s*Endpoint\s*=(.*)$/i.exec((lines[index] ?? "").replace(/\r$/, ""))?.[1];
  const endpoint = parseEndpointValue(value ?? "");
  return endpoint ? { index, endpoint } : null;
};

const analyze = (payload: AmneziaPayload): Analysis => {
  if (!isRecord(payload) || !Array.isArray(payload.containers)) return { kind: "unknown" };
  const awgContainers = payload.containers.filter(
    (container) => isRecord(container) && container.awg !== undefined,
  );
  if (awgContainers.length === 0) return { kind: "unknown" };
  if (awgContainers.length > 1) return { kind: "ambiguous" };

  const container = awgContainers[0] as AmneziaContainer;
  const awg = container.awg;
  if (!isRecord(awg)) return { kind: "unknown" };
  if (awg.protocol_version === "2") return { kind: "awg20" };
  if (awg.protocol_version !== "3.1") return { kind: "unknown" };

  let lastConfig: unknown;
  let form: LastConfigForm;
  if (typeof awg.last_config === "string") {
    try {
      lastConfig = JSON.parse(awg.last_config);
    } catch {
      return { kind: "unknown" };
    }
    if (JSON.stringify(lastConfig, null, 2) === awg.last_config) form = "json-indent2";
    else if (JSON.stringify(lastConfig) === awg.last_config) form = "json-compact";
    else form = "json-indent2";
  } else if (isRecord(awg.last_config)) {
    lastConfig = awg.last_config;
    form = "object";
  } else {
    return { kind: "unknown" };
  }
  if (!isRecord(lastConfig) || typeof lastConfig.config !== "string") return { kind: "unknown" };

  const lines = lastConfig.config.split("\n");
  const peer = findPeerEndpoint(lines);
  if (!peer) return { kind: "ambiguous" };
  return {
    kind: "awg31",
    located: {
      container,
      awg,
      lastConfig,
      form,
      lines,
      endpointLine: peer.index,
      endpoint: peer.endpoint,
    },
  };
};

/** Classify a decoded artifact and read its peer endpoint (AWG 3.1 only). */
export const inspectAwgArtifact = (decoded: AmneziaPayload): AwgArtifactInspection => {
  const analysis = analyze(decoded);
  if (analysis.kind === "awg31") {
    const { host, port } = analysis.located.endpoint;
    return { kind: "awg31", endpoint: { host, port } };
  }
  return { kind: analysis.kind };
};

/** Same as `inspectAwgArtifact` for a vpn:// link; an undecodable link is `unknown`. */
export const inspectAwgVpnLink = (vpnLink: string): AwgArtifactInspection => {
  let decoded: AmneziaPayload;
  try {
    decoded = decodeVpnLink(vpnLink);
  } catch {
    return { kind: "unknown" };
  }
  return inspectAwgArtifact(decoded);
};

const validateEndpoint = (endpoint: AwgEndpoint): void => {
  const { host, port } = endpoint;
  // Hostnames, IPv4 and bracketed IPv6 only; anything with whitespace, quotes or
  // line breaks could inject lines into the embedded config.
  const hostOk =
    typeof host === "string" &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[A-Za-z0-9._-]+$|^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]+$/.test(host);
  if (!hostOk || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AwgEndpointRenderError("INVALID_ENDPOINT", "AWG endpoint host or port is invalid");
  }
};

const formatEndpoint = ({ host, port }: AwgEndpoint): string =>
  host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;

/**
 * Return a new artifact whose endpoint is `endpoint`; the input is not mutated.
 *
 * Exactly five values change: top-level `hostName`, the nested `last_config`
 * `hostName` and `port` (number), `awg.port` (string) and the value of the one
 * `Endpoint` line in `[Peer]`. Everything else, including key order and the
 * formatting of the stored `last_config` JSON text, is kept.
 *
 * Throws `AwgEndpointRenderError`: `UNSUPPORTED_ARTIFACT` (unknown),
 * `UNSUPPORTED_PROTOCOL` (2.0), `AMBIGUOUS_ARTIFACT`, `INVALID_ENDPOINT`.
 */
export const renderAwgEndpoint = (
  decoded: AmneziaPayload,
  endpoint: AwgEndpoint,
): AmneziaPayload => {
  validateEndpoint(endpoint);
  const analysis = analyze(decoded);
  if (analysis.kind === "unknown") {
    throw new AwgEndpointRenderError("UNSUPPORTED_ARTIFACT", "VPN artifact is not a readable AWG artifact");
  }
  if (analysis.kind === "awg20") {
    throw new AwgEndpointRenderError("UNSUPPORTED_PROTOCOL", "Only AWG 3.1 artifacts can be re-pointed");
  }
  if (analysis.kind === "ambiguous") {
    throw new AwgEndpointRenderError("AMBIGUOUS_ARTIFACT", "VPN artifact has no single AWG endpoint");
  }

  const { lastConfig, lines, endpointLine, form } = analysis.located;
  const next = structuredClone(decoded);
  const nextContainer = (next.containers as AmneziaContainer[])[
    (decoded.containers as AmneziaContainer[]).indexOf(analysis.located.container)
  ] as AmneziaContainer;
  const nextAwg = nextContainer.awg as Record<string, unknown>;

  lines[endpointLine] = (lines[endpointLine] ?? "").replace(
    /^(\s*Endpoint\s*=\s*).*?(\s*)$/i,
    (_match, head: string, tail: string) => `${head}${formatEndpoint(endpoint)}${tail}`,
  );
  const nextLast = structuredClone(lastConfig);
  nextLast.config = lines.join("\n");
  nextLast.hostName = endpoint.host;
  nextLast.port = endpoint.port;

  next.hostName = endpoint.host;
  nextAwg.port = String(endpoint.port);
  nextAwg.last_config =
    form === "object"
      ? nextLast
      : form === "json-compact"
        ? JSON.stringify(nextLast)
        : JSON.stringify(nextLast, null, 2);
  return next;
};

/** Same as `renderAwgEndpoint` for a vpn:// link: decodes, renders and re-encodes. */
export const renderAwgEndpointVpnLink = (vpnLink: string, endpoint: AwgEndpoint): string => {
  let decoded: AmneziaPayload;
  try {
    decoded = decodeVpnLink(vpnLink);
  } catch {
    throw new AwgEndpointRenderError("UNSUPPORTED_ARTIFACT", "VPN artifact is not a readable AWG artifact");
  }
  return encodeVpnPayload(renderAwgEndpoint(decoded, endpoint));
};
