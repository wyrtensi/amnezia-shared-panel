export const DEFAULT_IPV6_REJECT_STUB_PREFIX = "fd6b:7c2e:4a91:9f::/64";
export const DEFAULT_AWG3_SERVER_IPV4_CIDR = "10.90.0.1/22";
export const IPV6_REJECT_PROBE_TARGET = "2001:4860:4860::8888";

const IPV6_HOST_MASK = (1n << 64n) - 1n;
const ULA_PREFIX_SHIFT = 120n;
const ULA_LOCAL_BYTE = 0xfdn;

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
): {
  address: number;
  prefixLength: number;
  network: number;
  broadcast: number;
} | null => {
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

const parseUlaPrefixBase = (ula64Prefix: string): bigint | null => {
  const normalized = normalizeUla64Prefix(ula64Prefix);
  if (!normalized) return null;
  return parseIpv6(normalized.slice(0, -3));
};

export const deriveStubServerIpv6 = (
  ula64Prefix: string = DEFAULT_IPV6_REJECT_STUB_PREFIX,
): string | null => {
  const base = parseUlaPrefixBase(ula64Prefix);
  if (base === null) return null;
  return formatIpv6(base + 1n);
};

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
  if (offset < 2n) return null;
  return formatIpv6(base + offset);
};

export type PersistedIpv6RejectStubEnv = {
  enabled: boolean;
  prefix: string | null;
};

export const parseIpv6RejectStubEnv = (
  raw: string,
): PersistedIpv6RejectStubEnv => {
  let enabled = false;
  let prefix: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "ENABLED") {
      enabled = value === "1";
    } else if (key === "PREFIX") {
      prefix = normalizeUla64Prefix(value);
    }
  }

  return { enabled, prefix };
};

export const formatIpv6RejectStubEnv = (
  enabled: boolean,
  prefix: string,
): string => {
  const normalized = normalizeUla64Prefix(prefix);
  if (!normalized) {
    throw new Error("Invalid IPv6 ULA /64 prefix");
  }
  const serverIpv6 = enabled ? (deriveStubServerIpv6(normalized) ?? "") : "";
  return [
    `ENABLED=${enabled ? "1" : "0"}`,
    `PREFIX=${normalized}`,
    `SERVER_IPV6=${serverIpv6}`,
    "",
  ].join("\n");
};

export const extractServerIpv4Cidr = (wgConfig: string): string => {
  const match = wgConfig.match(
    /^\s*Address\s*=\s*([0-9]+(?:\.[0-9]+){3}\/\d+)/im,
  );
  return match?.[1]?.trim() || DEFAULT_AWG3_SERVER_IPV4_CIDR;
};

/**
 * Rewrite active [Peer] AllowedIPs entries in `awg0.conf` when toggling the
 * IPv6 active-reject stub ON or OFF. Disabled peers (`0.0.0.0/32`) stay intact.
 */
export const rewriteAwg3PeersForIpv6RejectStub = (
  wgConfig: string,
  options: { enabled: boolean; prefix: string },
): { config: string; changed: boolean } => {
  if (!wgConfig) return { config: wgConfig, changed: false };
  const normalizedPrefix = normalizeUla64Prefix(options.prefix);
  if (!normalizedPrefix) {
    throw new Error("Invalid IPv6 ULA /64 prefix");
  }

  const serverCidr = extractServerIpv4Cidr(wgConfig);
  const sections = wgConfig.split("[Peer]");
  let changed = false;

  const updated = sections.map((section, index) => {
    // Index 0 is the [Interface] section before the first [Peer].
    if (index === 0) return section;

    return section.replace(
      /^(\s*AllowedIPs\s*=\s*)([^\r\n]+)(\r?)$/im,
      (full, head: string, value: string, cr: string) => {
        const tokens = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (tokens.length === 1 && tokens[0] === "0.0.0.0/32") {
          return full;
        }

        const ipv4Token = tokens.find((token) => {
          const [host, mask] = token.split("/");
          return mask === "32" && host !== "0.0.0.0" && parseIpv4(host) !== null;
        });
        if (!ipv4Token) return full;

        const bareIpv4 = ipv4Token.split("/")[0];
        let nextValue: string;
        if (options.enabled) {
          const peerIpv6 = deriveStubPeerIpv6(
            bareIpv4,
            serverCidr,
            normalizedPrefix,
          );
          if (!peerIpv6) return full;
          nextValue = `${bareIpv4}/32, ${peerIpv6}/128`;
        } else {
          nextValue = `${bareIpv4}/32`;
        }

        const nextLine = `${head}${nextValue}${cr}`;
        if (nextLine !== full) {
          changed = true;
        }
        return nextLine;
      },
    );
  });

  return {
    config: changed ? updated.join("[Peer]") : wgConfig,
    changed,
  };
};
