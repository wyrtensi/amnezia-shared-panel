import {
  decodeVpnLink,
  encodeVpnPayload,
  type AmneziaContainer,
  type AmneziaPayload,
} from "./codec.js";

/**
 * Deterministic ULA addressing and export projection for the per-node IPv6
 * active-reject stub (`prohibit 2000::/3` -> ICMPv6 Administratively Prohibited).
 *
 * Uses a dedicated ULA /64 distinct from the future full-IPv6 NAT66 subnet
 * (`fd6b:7c2e:4a91:90::/64`) so nodes can enable the stub now and cleanly switch
 * it off or migrate later without address overlap.
 */
export const DEFAULT_IPV6_REJECT_STUB_PREFIX = "fd6b:7c2e:4a91:9f::/64";
export const DEFAULT_AWG3_SERVER_IPV4_CIDR = "10.90.0.1/22";

const IPV6_HOST_MASK = (1n << 64n) - 1n;
const ULA_PREFIX_SHIFT = 120n;
const ULA_LOCAL_BYTE = 0xfdn;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseIpv4 = (raw: string): number | null => {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
};

const parseIpv4Cidr = (
  raw: string,
): { address: number; prefixLength: number; network: number; broadcast: number } | null => {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash !== raw.lastIndexOf("/")) return null;
  const addressPart = raw.slice(0, slash);
  const prefixPart = raw.slice(slash + 1);
  if (!/^(0|[1-9]\d?)$/.test(prefixPart)) return null;
  const prefixLength = Number(prefixPart);
  if (prefixLength < 8 || prefixLength > 30) return null;
  const address = parseIpv4(addressPart);
  if (address === null) return null;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (address & mask) >>> 0;
  const hostMask = (~mask) >>> 0;
  const broadcast = (network | hostMask) >>> 0;
  return { address, prefixLength, network, broadcast };
};

export const parseIpv6 = (raw: string): bigint | null => {
  if (!raw || raw.includes("%") || raw.includes(".") || /\s/.test(raw)) {
    return null;
  }
  const doubleColonIndex = raw.indexOf("::");
  if (doubleColonIndex !== -1 && raw.indexOf("::", doubleColonIndex + 1) !== -1) {
    return null;
  }

  let hextets: string[];
  if (doubleColonIndex === -1) {
    hextets = raw.split(":");
    if (hextets.length !== 8) return null;
  } else {
    const leftText = raw.slice(0, doubleColonIndex);
    const rightText = raw.slice(doubleColonIndex + 2);
    const left = leftText === "" ? [] : leftText.split(":");
    const right = rightText === "" ? [] : rightText.split(":");
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    hextets = [...left, ...Array<string>(missing).fill("0"), ...right];
  }

  let value = 0n;
  for (const part of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return value;
};

/** Format a 128-bit IPv6 address in canonical RFC 5952 compressed form. */
export const formatIpv6 = (value: bigint): string => {
  const hextets: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    hextets.push(Number((value >> shift) & 0xffffn));
  }

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < hextets.length; i += 1) {
    if (hextets[i] === 0) {
      if (runStart === -1) runStart = i;
      runLength += 1;
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }

  if (bestLength < 2) {
    return hextets.map((part) => part.toString(16)).join(":");
  }

  const left = hextets
    .slice(0, bestStart)
    .map((part) => part.toString(16))
    .join(":");
  const right = hextets
    .slice(bestStart + bestLength)
    .map((part) => part.toString(16))
    .join(":");
  return `${left}::${right}`;
};

/**
 * Validate and normalize an RFC 4193 locally assigned ULA /64 prefix (`fd00::/8`).
 * Requires exact `/64` length and zero host bits; returns canonical RFC 5952 CIDR.
 */
export const normalizeUla64Prefix = (raw: string): string | null => {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash !== trimmed.lastIndexOf("/")) return null;
  if (trimmed.slice(slash + 1) !== "64") return null;

  const address = parseIpv6(trimmed.slice(0, slash));
  if (address === null) return null;
  if (address >> ULA_PREFIX_SHIFT !== ULA_LOCAL_BYTE) return null;
  if ((address & IPV6_HOST_MASK) !== 0n) return null;
  return `${formatIpv6(address)}/64`;
};

export const isValidUla64Prefix = (raw: string): boolean => normalizeUla64Prefix(raw) !== null;

const parseUlaPrefixBase = (ula64Prefix: string): bigint | null => {
  const normalized = normalizeUla64Prefix(ula64Prefix);
  if (!normalized) return null;
  return parseIpv6(normalized.slice(0, -3));
};

/** Derive the server's `::1` interface address inside the stub ULA /64. */
export const deriveStubServerIpv6 = (
  ula64Prefix: string = DEFAULT_IPV6_REJECT_STUB_PREFIX,
): string | null => {
  const base = parseUlaPrefixBase(ula64Prefix);
  if (base === null) return null;
  return formatIpv6(base + 1n);
};

/**
 * Deterministically map an AWG 3.1 peer IPv4 lease (inside `10.90.0.1/22`) to a
 * unique peer IPv6 address inside the stub ULA /64 (`<prefix>::<offset>`).
 */
export const deriveStubPeerIpv6 = (
  peerIpv4: string,
  serverIpv4Cidr: string = DEFAULT_AWG3_SERVER_IPV4_CIDR,
  ula64Prefix: string = DEFAULT_IPV6_REJECT_STUB_PREFIX,
): string | null => {
  const base = parseUlaPrefixBase(ula64Prefix);
  if (base === null) return null;
  const server = parseIpv4Cidr(serverIpv4Cidr.trim());
  if (!server) return null;

  const barePeer = peerIpv4.trim().replace(/\/32$/, "");
  const peerAddress = parseIpv4(barePeer);
  if (peerAddress === null) return null;
  if (
    peerAddress <= server.network ||
    peerAddress >= server.broadcast ||
    peerAddress === server.address
  ) {
    return null;
  }

  const offset = BigInt(peerAddress - server.network);
  // Reserve ::0 (subnet-router anycast) and ::1 (server interface).
  if (offset < 2n) return null;
  return formatIpv6(base + offset);
};

type LastConfigForm = "json-indent2" | "json-compact" | "object";

type LocatedAwg31 = {
  containerIndex: number;
  lastConfig: Record<string, unknown>;
  form: LastConfigForm;
  lines: string[];
};

const sectionHeader = /^\s*\[([^\]]+)\]\s*$/;

const locateAwg31 = (payload: AmneziaPayload): LocatedAwg31 | null => {
  if (!isRecord(payload) || !Array.isArray(payload.containers)) return null;
  const awgContainers = payload.containers.filter(
    (container) => isRecord(container) && container.awg !== undefined,
  );
  if (awgContainers.length !== 1) return null;

  const container = awgContainers[0] as AmneziaContainer;
  const awg = container.awg;
  if (!isRecord(awg) || awg.protocol_version !== "3.1") return null;

  let lastConfig: unknown;
  let form: LastConfigForm;
  if (typeof awg.last_config === "string") {
    try {
      lastConfig = JSON.parse(awg.last_config);
    } catch {
      return null;
    }
    if (JSON.stringify(lastConfig, null, 2) === awg.last_config) form = "json-indent2";
    else if (JSON.stringify(lastConfig) === awg.last_config) form = "json-compact";
    else form = "json-indent2";
  } else if (isRecord(awg.last_config)) {
    lastConfig = awg.last_config;
    form = "object";
  } else {
    return null;
  }

  if (!isRecord(lastConfig) || typeof lastConfig.config !== "string") return null;
  return {
    containerIndex: payload.containers.indexOf(container),
    lastConfig,
    form,
    lines: lastConfig.config.split("\n"),
  };
};

const writeLastConfig = (
  awg: Record<string, unknown>,
  form: LastConfigForm,
  lastConfig: Record<string, unknown>,
): void => {
  awg.last_config =
    form === "object"
      ? lastConfig
      : form === "json-compact"
        ? JSON.stringify(lastConfig)
        : JSON.stringify(lastConfig, null, 2);
};

const findInterfaceAddressLine = (lines: string[]): number => {
  let section = "";
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    const header = sectionHeader.exec(line);
    if (header) {
      section = (header[1] ?? "").trim().toLowerCase();
      continue;
    }
    if (section === "interface" && /^\s*Address\s*=/i.test(line)) {
      return index;
    }
  }
  return -1;
};

const extractFirstIpv4 = (raw: string): string | null => {
  for (const token of raw.split(",")) {
    const bare = token.trim().split("/")[0]?.trim() ?? "";
    if (parseIpv4(bare) !== null) {
      return bare;
    }
  }
  return null;
};

/** Read the peer's base IPv4 address from an AWG 3.1 `vpn://` artifact. */
export const readBaseClientIpv4 = (vpnLink: string): string | null => {
  let payload: AmneziaPayload;
  try {
    payload = decodeVpnLink(vpnLink);
  } catch {
    return null;
  }
  const located = locateAwg31(payload);
  if (!located) return null;

  if (typeof located.lastConfig.client_ip === "string") {
    const fromClientIp = extractFirstIpv4(located.lastConfig.client_ip);
    if (fromClientIp) return fromClientIp;
  }

  const addressIndex = findInterfaceAddressLine(located.lines);
  if (addressIndex >= 0) {
    const rawLine = (located.lines[addressIndex] ?? "").replace(/\r$/, "");
    const value = /^\s*Address\s*=(.*)$/i.exec(rawLine)?.[1] ?? "";
    return extractFirstIpv4(value);
  }
  return null;
};

export type WithIpv6RejectStubOptions = {
  /**
   * When true (iOS/Android `vpn://`), also writes `"<ipv4>, <ipv6>"` to
   * `last_config.client_ip`. Keep false when projecting `.conf` or desktop
   * artifacts so desktop AmneziaVPN clients are never handed comma-separated `client_ip`.
   */
  includeClientIp: boolean;
};

/**
 * Project a peer ULA IPv6 address onto an AWG 3.1 `vpn://` artifact for export.
 *
 * - Updates `[Interface] Address = <v4>/32, <v6>/128` idempotently.
 * - Optionally updates `last_config.client_ip` (`includeClientIp: true`).
 * - Leaves AWG 2.0, legacy, unreadable, or non-IPv4 artifacts untouched.
 */
export const withIpv6RejectStubAddress = (
  vpnLink: string,
  ipv6Address: string,
  options: WithIpv6RejectStubOptions,
): string => {
  const bareIpv6 = ipv6Address.trim().replace(/\/128$/, "");
  const parsedIpv6 = parseIpv6(bareIpv6);
  if (parsedIpv6 === null) return vpnLink;
  const canonicalIpv6 = formatIpv6(parsedIpv6);

  let payload: AmneziaPayload;
  try {
    payload = decodeVpnLink(vpnLink);
  } catch {
    return vpnLink;
  }
  const located = locateAwg31(payload);
  if (!located) return vpnLink;

  const addressIndex = findInterfaceAddressLine(located.lines);
  if (addressIndex < 0) return vpnLink;

  const rawAddressLine = located.lines[addressIndex] ?? "";
  const hasCrlf = rawAddressLine.endsWith("\r");
  const strippedAddressLine = rawAddressLine.replace(/\r$/, "");
  const match = /^(\s*Address\s*=\s*)(.*)$/i.exec(strippedAddressLine);
  if (!match) return vpnLink;

  const existingTokens = (match[2] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ipv4Tokens = existingTokens.filter((entry) => {
    const host = entry.split("/")[0]?.trim() ?? "";
    return parseIpv4(host) !== null;
  });
  if (ipv4Tokens.length === 0) return vpnLink;

  const baseIpv4 =
    (typeof located.lastConfig.client_ip === "string"
      ? extractFirstIpv4(located.lastConfig.client_ip)
      : null) ?? extractFirstIpv4(ipv4Tokens[0] ?? "");
  if (!baseIpv4) return vpnLink;

  const nextAddressLine = `${match[1]}${[...ipv4Tokens, `${canonicalIpv6}/128`].join(", ")}${
    hasCrlf ? "\r" : ""
  }`;
  const nextClientIp = options.includeClientIp
    ? `${baseIpv4}, ${canonicalIpv6}`
    : typeof located.lastConfig.client_ip === "string"
      ? baseIpv4
      : located.lastConfig.client_ip;

  if (
    located.lines[addressIndex] === nextAddressLine &&
    located.lastConfig.client_ip === nextClientIp
  ) {
    return vpnLink;
  }

  const nextLines = [...located.lines];
  nextLines[addressIndex] = nextAddressLine;

  const nextLastConfig: Record<string, unknown> = {
    ...located.lastConfig,
    config: nextLines.join("\n"),
  };
  if (nextClientIp !== undefined) {
    nextLastConfig.client_ip = nextClientIp;
  }

  const awg = payload.containers?.[located.containerIndex]?.awg;
  if (!awg) return vpnLink;
  writeLastConfig(awg, located.form, nextLastConfig);
  return encodeVpnPayload(payload);
};
