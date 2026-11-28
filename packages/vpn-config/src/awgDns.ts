import {
  decodeVpnLink,
  encodeVpnPayload,
  readAwgLastConfig,
  writeAwgLastConfig,
  type AmneziaContainerAwg,
} from "./codec.js";

const STRICT_IPV4_RE = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

const normalizeIpv4 = (raw: string): string => {
  const trimmed = raw.trim();
  if (!STRICT_IPV4_RE.test(trimmed)) {
    throw new Error(`Invalid IPv4 DNS address: ${raw}`);
  }
  const octets = trimmed.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    throw new Error(`Invalid IPv4 DNS address: ${raw}`);
  }
  return trimmed;
};

const rewriteInterfaceDns = (conf: string, dnsValue: string): string => {
  const eol = conf.includes("\r\n") ? "\r\n" : "\n";
  const lines = conf.split(/\r?\n/);
  let section = "";
  let sawInterface = false;
  let interfaceEnd = lines.length;
  const dnsLineIndices: number[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine);
    if (header) {
      if (section === "interface") {
        interfaceEnd = index;
      }
      section = (header[1] ?? "").trim().toLowerCase();
      if (section === "interface") {
        sawInterface = true;
      }
      continue;
    }
    if (section === "interface" && /^\s*DNS\s*=/i.test(rawLine)) {
      dnsLineIndices.push(index);
    }
  }

  const nextLine = `DNS = ${dnsValue}`;
  if (dnsLineIndices.length > 0) {
    lines[dnsLineIndices[0]!] = nextLine;
    for (let i = dnsLineIndices.length - 1; i >= 1; i -= 1) {
      lines.splice(dnsLineIndices[i]!, 1);
    }
  } else if (sawInterface) {
    let insertAt = interfaceEnd;
    while (insertAt > 0 && lines[insertAt - 1]?.trim() === "") {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, nextLine);
  }
  return lines.join(eol);
};

/**
 * Rewrite DNS resolvers across both the outer Amnezia JSON (`payload.dns1`/`dns2`)
 * and the embedded WireGuard `[Interface] DNS = ...` + `lastConfig.dns1`/`dns2`.
 *
 * Call BEFORE `applyRouteProfileToVpnLink` so split-tunnel `ru_blacklist` keys
 * automatically include the updated DNS resolver `/32` routes in `AllowedIPs`.
 */
export const applyDnsToVpnLink = (
  vpnLink: string,
  dnsPrimary: string,
  dnsSecondary?: string | null,
): string => {
  const primary = normalizeIpv4(dnsPrimary);
  const secondaryRaw = (dnsSecondary ?? "").trim();
  const secondary =
    secondaryRaw && normalizeIpv4(secondaryRaw) !== primary
      ? secondaryRaw
      : null;

  const payload = decodeVpnLink(vpnLink);
  payload.dns1 = primary;
  payload.dns2 = secondary ?? "";

  const awgContainer = payload.containers?.find(
    (container) => container.awg?.last_config !== undefined,
  );
  const awg: AmneziaContainerAwg | undefined = awgContainer?.awg;
  if (awg) {
    const decoded = readAwgLastConfig(awg.last_config);
    if (decoded) {
      const { form, lastConfig } = decoded;
      lastConfig.dns1 = primary;
      lastConfig.dns2 = secondary ?? "";
      if (typeof lastConfig.config === "string") {
        const dnsHeaderValue = secondary ? `${primary}, ${secondary}` : primary;
        lastConfig.config = rewriteInterfaceDns(lastConfig.config, dnsHeaderValue);
      }
      writeAwgLastConfig(awg, form, lastConfig);
    }
  }

  return encodeVpnPayload(payload);
};
