import { deflateSync, inflateSync } from "node:zlib";
import type { RouteProfile } from "@amnezia/contracts";

/**
 * The most routes a profile may put in AllowedIPs.
 *
 * Measured on a device: a 6712-route config crossed Binder as a 941 096-byte
 * parcel — 94% of the ~1 MB a transaction gets, and it connected. Past the
 * limit the client drops the message and the profile never connects, with no
 * error anywhere, so 6800 is close to the edge by design: it is the largest
 * list observed to work, not a safe distance from it.
 *
 * That is why crossing WARN_TUNNEL_ROUTES is logged. There is no margin left
 * to absorb a feed that grows again, and the log line is the only warning
 * anyone gets before keys start coming out as full tunnels.
 *
 * Feeds grow, and a blacklist has no lever to shorten itself — dropping
 * entries would send that traffic outside the tunnel, which is the failure
 * the profile exists to prevent. So a profile that still cannot fit degrades
 * to the full tunnel rather than shipping a config that silently refuses to
 * connect.
 */
export const MAX_TUNNEL_ROUTES = 6800;

/**
 * Where a profile stops having comfortable headroom, and every export starts
 * saying so in the log. Below this a feed can still grow without anyone having
 * to act; above it, the next growth is what turns keys into full tunnels.
 */
export const WARN_TUNNEL_ROUTES = 5500;

/**
 * The route budget is invisible until a key stops working, so every crossing
 * says so on stdout — the same place the rest of the service reports itself.
 * Nothing here carries a key, a user or an address: only counts, which is what
 * an operator needs to decide whether a feed has outgrown the client.
 */
const warnRouteBudget = (message: string): void => {
  console.warn(`[routes] ${message}`);
};

export type RulePayload = {
  cidrs: string[];
  domains: string[];
};

/**
 * What a routed export actually needs: prefixes. Deliberately narrower than
 * `RulePayload` — the feed still carries a domain half, and this type is where
 * that half stops, because nothing downstream of here can route a name.
 */
export type TunnelRoutes = {
  cidrs: string[];
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
 * connection (the vpn:// payload's `description`). The name itself is composed
 * per key by `composeKeyDisplayName` so a user with several keys can tell their
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
 * Apply a routing profile to a vpn:// link: for non-full-tunnel profiles the
 * peer AllowedIPs is replaced with the rule CIDRs (plus DNS). Addresses are the
 * whole of what an exported key can steer on — see the note on `TunnelRoutes`.
 */
export const applyRouteProfileToVpnLink = (
  vpnLink: string,
  profile: RouteProfile,
  rulePayload?: TunnelRoutes,
): string => {
  if (profile === "full_tunnel" || !rulePayload) {
    return vpnLink;
  }

  // A rule set with no CIDRs cannot steer a WireGuard peer: AllowedIPs takes
  // prefixes and nothing else. Applying such a payload would leave AllowedIPs
  // holding the DNS servers alone, so the key would tunnel its resolver and
  // send every other packet in the clear. A feed that failed must degrade to
  // the full tunnel it started from instead.
  if ((rulePayload.cidrs?.length ?? 0) === 0) {
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

  // ru_blacklist lists what belongs in the tunnel, so its CIDRs are AllowedIPs
  // as they stand, and the DNS servers have to be named or they would not be
  // routed at all.
  const combinedCidrs = [
    ...new Set([...(rulePayload.cidrs || []), ...dnsCidrs]),
  ].filter(Boolean);

  // Feeds grow, and a blacklist has no lever to shorten itself: dropping
  // entries would send that traffic outside the tunnel, which is the failure
  // the profile exists to prevent. So an oversized one degrades to the full
  // tunnel instead of becoming a config the Android client discards on arrival.
  if (combinedCidrs.length > MAX_TUNNEL_ROUTES) {
    warnRouteBudget(
      `${profile}: ${combinedCidrs.length} routes exceed the ${MAX_TUNNEL_ROUTES} the Android client can accept; key exported as a full tunnel`,
    );
    return vpnLink;
  }
  if (combinedCidrs.length > WARN_TUNNEL_ROUTES) {
    warnRouteBudget(
      `${profile}: ${combinedCidrs.length} routes, past the ${WARN_TUNNEL_ROUTES} headroom mark and approaching the ${MAX_TUNNEL_ROUTES} ceiling; shrink the feed before it starts exporting full tunnels`,
    );
  }

  // An empty AllowedIPs would produce a config that routes nothing at all.
  // A feed that covers the whole space says "tunnel nothing", which the panel
  // has no way to express - leave the full-tunnel link rather than ship a
  // config the client cannot use.
  if (combinedCidrs.length === 0) {
    return vpnLink;
  }

  const allowedIpsString = combinedCidrs.join(", ");

  // Rewrite the embedded WireGuard config text
  const updatedConfigText = rawConfigText.replace(
    /^\s*AllowedIPs\s*=.*$/mi,
    `AllowedIPs = ${allowedIpsString}`,
  );

  // allowed_ips is the field the official client reads, and it is the only
  // routing this export can express. The payload used to carry the rule's
  // domains alongside it in `split_tunnel_sites`/`sites`; the AmneziaVPN client
  // reads neither, so writing them only made the key look like it did something
  // it never did. Site-based split tunnelling lives on the client's own
  // settings page, and that page is switched off for any key whose AllowedIPs
  // is narrower than the whole address space — every key that reaches here.
  lastConfig.allowed_ips = combinedCidrs;
  lastConfig.config = updatedConfigText;

  container.awg.last_config = JSON.stringify(lastConfig, null, 2);

  return encodeVpnPayload(payload);
};
