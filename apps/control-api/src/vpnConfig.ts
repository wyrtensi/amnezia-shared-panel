import { deflateSync, inflateSync } from "node:zlib";
import type { RouteProfile } from "@amnezia/contracts";

export type RulePayload = {
  cidrs: string[];
  domains: string[];
};

export type AmneziaContainerAwg = {
  last_config?: string;
  [key: string]: unknown;
};

export type AmneziaContainer = {
  container?: string;
  awg?: AmneziaContainerAwg;
  [key: string]: unknown;
};

export type AmneziaPayload = {
  containers?: AmneziaContainer[];
  defaultContainer?: string;
  description?: string;
  dns1?: string;
  dns2?: string;
  hostName?: string;
  [key: string]: unknown;
};

export const encodeVpnPayload = (payload: AmneziaPayload): string => {
  const raw = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length, 0);
  return `vpn://${Buffer.concat([header, deflateSync(raw)]).toString("base64url")}`;
};

export const decodeVpnLink = (vpnLink: string): AmneziaPayload => {
  if (!vpnLink.startsWith("vpn://")) {
    throw new Error("VPN config must start with vpn://");
  }
  const payload = Buffer.from(vpnLink.slice("vpn://".length), "base64url");
  if (payload.byteLength < 5) {
    throw new Error("VPN config payload is too short");
  }
  const expectedLength = payload.readUInt32BE(0);
  const raw = inflateSync(payload.subarray(4));
  if (raw.byteLength !== expectedLength) {
    throw new Error("VPN config payload length does not match its header");
  }
  return JSON.parse(raw.toString("utf8")) as AmneziaPayload;
};

export const extractConfFromVpnLink = (vpnLink: string): string => {
  const payload = decodeVpnLink(vpnLink);
  const lastConfigRaw = payload.containers?.find(
    (container) => typeof container.awg?.last_config === "string",
  )?.awg?.last_config;
  if (!lastConfigRaw) {
    throw new Error("VPN payload does not contain an embedded config");
  }
  const lastConfig = JSON.parse(lastConfigRaw) as { config?: unknown };
  if (typeof lastConfig.config !== "string" || !lastConfig.config.trim()) {
    throw new Error("VPN payload does not contain an embedded config");
  }
  return lastConfig.config;
};

/**
 * Set the human-readable server name the AmneziaVPN client shows for this
 * connection (the vpn:// payload's `description`). We label it
 * "<node public name> #<keyNumber>" so a user with several keys can tell their
 * connections apart in the client. No-op-safe: a link that cannot be decoded is
 * returned unchanged.
 */
export const setVpnDescription = (vpnLink: string, description: string): string => {
  if (!description) return vpnLink;
  try {
    const payload = decodeVpnLink(vpnLink);
    payload.description = description;
    return encodeVpnPayload(payload);
  } catch {
    return vpnLink;
  }
};

/**
 * Union a base rule payload with a user's custom extras, de-duplicating. Layers
 * per-user routes on top of a split-tunnel profile's base feed at export time.
 * Returns the base object unchanged when there are no extras.
 */
export const mergeRulePayload = (
  base: RulePayload,
  extra?: { cidrs?: string[]; domains?: string[] } | null,
): RulePayload => {
  const extraCidrs = extra?.cidrs ?? [];
  const extraDomains = extra?.domains ?? [];
  if (extraCidrs.length === 0 && extraDomains.length === 0) return base;
  return {
    cidrs: [...new Set([...base.cidrs, ...extraCidrs])],
    domains: [...new Set([...base.domains, ...extraDomains])],
  };
};

/**
 * Apply a routing profile to a vpn:// link. For non-full-tunnel profiles the
 * peer AllowedIPs is replaced with the rule CIDRs (plus DNS), and the domain
 * list is recorded for AmneziaVPN's native .conf export.
 */
export const applyRouteProfileToVpnLink = (
  vpnLink: string,
  profile: RouteProfile,
  rulePayload?: RulePayload,
): string => {
  if (profile === "full_tunnel" || !rulePayload) {
    return vpnLink;
  }

  const payload = decodeVpnLink(vpnLink);
  const container = payload.containers?.find(
    (c) => typeof c.awg?.last_config === "string",
  );
  if (!container?.awg?.last_config) {
    return vpnLink;
  }

  const lastConfig = JSON.parse(container.awg.last_config) as Record<string, unknown>;
  const rawConfigText = typeof lastConfig.config === "string" ? lastConfig.config : "";

  // Build the WireGuard AllowedIPs list: unique rule CIDRs plus the DNS servers
  const dnsServers = [
    typeof payload.dns1 === "string" ? payload.dns1 : "1.1.1.1",
    typeof payload.dns2 === "string" ? payload.dns2 : "1.0.0.1",
  ].filter(Boolean);

  const dnsCidrs = dnsServers.map((ip) => (ip.includes("/") ? ip : `${ip}/32`));
  const combinedCidrs = [
    ...new Set([...(rulePayload.cidrs || []), ...dnsCidrs]),
  ].filter(Boolean);

  const allowedIpsString = combinedCidrs.join(", ");

  // Rewrite the embedded WireGuard config text
  const updatedConfigText = rawConfigText.replace(
    /^\s*AllowedIPs\s*=.*$/mi,
    `AllowedIPs = ${allowedIpsString}`,
  );

  // Update the embedded last_config. allowed_ips is the field the official
  // client reads; the domain fields are kept for the native .conf export.
  lastConfig.allowed_ips = combinedCidrs;
  lastConfig.config = updatedConfigText;
  if (rulePayload.domains && rulePayload.domains.length > 0) {
    lastConfig.split_tunnel_sites = rulePayload.domains.map((d) => ({
      hostname: d,
      ip: "",
    }));
    lastConfig.sites = rulePayload.domains;
  }

  container.awg.last_config = JSON.stringify(lastConfig, null, 2);

  return encodeVpnPayload(payload);
};
