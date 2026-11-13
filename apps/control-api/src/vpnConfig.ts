import type { RouteProfile } from "@amnezia/contracts";
import {
  decodeVpnLink,
  encodeVpnPayload,
  type AmneziaContainerAwg,
  type AmneziaPayload,
} from "@amnezia/vpn-config";

import { awgClientProfileV1Schema, profileOrder } from "./awgClientProfile.js";

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

export {
  decodeVpnLink,
  encodeVpnPayload,
  type AmneziaContainer,
  type AmneziaContainerAwg,
  type AmneziaPayload,
} from "@amnezia/vpn-config";

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

const J_KEYS = ["Jc", "Jmin", "Jmax"] as const;
const I_KEYS = ["I1", "I2", "I3", "I4", "I5"] as const;
/** How many leading signature packets a profile may reorder. */
const REORDERABLE_I = 3;

type JKey = (typeof J_KEYS)[number];
type ConfLine = { index: number; value: string };

/** One eligible AWG 3.1 artifact, parsed once and kept in its three places. */
type Awg31View = {
  payload: AmneziaPayload;
  awg: AmneziaContainerAwg;
  lastConfig: Record<string, unknown>;
  lines: string[];
  confLines: Map<string, ConfLine>;
  j: Record<JKey, number>;
  /** I1-I5 in order, "" for an empty slot. */
  i: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toCount = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return null;
};

/** A JSON I slot: a missing key and an empty string both mean "not set". */
const toSlot = (value: unknown): string | null => {
  if (value === undefined) return "";
  return typeof value === "string" ? value.trim() : null;
};

/**
 * The `Jc/Jmin/Jmax/I1-I5` lines of the `[Interface]` section, by exact field
 * name. A repeated field makes the config ambiguous, so it returns null.
 */
const readInterfaceLines = (lines: string[]): Map<string, ConfLine> | null => {
  const wanted = new Set<string>([...J_KEYS, ...I_KEYS]);
  const found = new Map<string, ConfLine>();
  let section = "";
  for (const [index, raw] of lines.entries()) {
    // CRLF configs keep their "\r"; `.` would not match it.
    const line = raw.replace(/\r$/, "");
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1]?.trim() ?? "";
      continue;
    }
    if (section !== "Interface") continue;
    const field = /^\s*([A-Za-z0-9]+)\s*=(.*)$/.exec(line);
    const name = field?.[1];
    if (!name || !wanted.has(name)) continue;
    if (found.has(name)) return null;
    found.set(name, { index, value: (field[2] ?? "").trim() });
  }
  return found;
};

/**
 * Parse an artifact that a client profile can apply to, or return null.
 *
 * Eligible means: exactly one AWG container, it is the default one, it says
 * `protocol_version: "3.1"`, and its outer params, `last_config` and the
 * embedded `[Interface]` agree on `Jc/Jmin/Jmax` and on every I slot. An
 * empty JSON slot and a missing conf line are the same thing: the node drops
 * empty lines from the text but keeps the empty keys.
 */
const readAwg31 = (vpnLink: string): Awg31View | null => {
  let payload: AmneziaPayload;
  try {
    payload = decodeVpnLink(vpnLink);
  } catch {
    return null;
  }
  if (!Array.isArray(payload.containers)) return null;
  const awgContainers = payload.containers.filter(
    (container) => isRecord(container) && container.awg !== undefined,
  );
  const container = awgContainers.length === 1 ? awgContainers[0] : undefined;
  const awg = container?.awg;
  if (
    !container ||
    !isRecord(awg) ||
    typeof awg.last_config !== "string" ||
    typeof payload.defaultContainer !== "string" ||
    container.container !== payload.defaultContainer ||
    awg.protocol_version !== "3.1"
  ) {
    return null;
  }

  let lastConfig: unknown;
  try {
    lastConfig = JSON.parse(awg.last_config);
  } catch {
    return null;
  }
  if (!isRecord(lastConfig) || typeof lastConfig.config !== "string") return null;

  const lines = lastConfig.config.split("\n");
  const confLines = readInterfaceLines(lines);
  if (!confLines) return null;

  const j = {} as Record<JKey, number>;
  for (const key of J_KEYS) {
    const outer = toCount(awg[key]);
    const inner = toCount(lastConfig[key]);
    const conf = toCount(confLines.get(key)?.value);
    if (outer === null || outer !== inner || outer !== conf) return null;
    j[key] = outer;
  }

  const i: string[] = [];
  for (const key of I_KEYS) {
    const outer = toSlot(awg[key]);
    const inner = toSlot(lastConfig[key]);
    const conf = confLines.get(key)?.value ?? "";
    if (outer === null || outer !== inner || outer !== conf) return null;
    i.push(outer);
  }

  return { payload, awg, lastConfig, lines, confLines, j, i };
};

/**
 * The effective junk parameters of an artifact a client profile can apply
 * to, or null when it cannot: a 2.0 artifact, an unmarked one, an ambiguous
 * container layout, or a 3.1 one whose three copies disagree.
 */
export const inspectAwg31ClientConfig = (
  vpnLink: string,
): { jc: number; jmin: number; jmax: number } | null => {
  const view = readAwg31(vpnLink);
  return view ? { jc: view.j.Jc, jmin: view.j.Jmin, jmax: view.j.Jmax } : null;
};

/** Write a value back with the type the field already had. */
const sameType = (previous: unknown, value: string): unknown =>
  typeof previous === "number" ? Number(value) : value;

/**
 * Apply a saved client profile to the node-issued artifact.
 *
 * Only `Jc/Jmin/Jmax` and the order of the populated `I1-I3` change, in the
 * outer params, `last_config` and the embedded `[Interface]` alike. A single
 * I entry, a set with gaps, or one that uses I4/I5 keeps its order. An
 * artifact the profile cannot apply to comes back byte for byte, whatever the
 * profile says, so a saved profile never makes a working key unexportable.
 */
export const applyAwgClientProfile = (
  vpnLink: string,
  profile: unknown,
): string => {
  const view = readAwg31(vpnLink);
  if (!view) return vpnLink;
  const parsed = awgClientProfileV1Schema.safeParse(profile);
  if (!parsed.success) {
    // Says nothing about the stored value: it may sit next to a config body.
    throw new Error("The saved AWG client profile is invalid");
  }
  const { jc, jmin, jmax, cpsOrder } = parsed.data;

  const next = new Map<string, string>([
    ["Jc", String(jc)],
    ["Jmin", String(jmin)],
    ["Jmax", String(jmax)],
  ]);
  const populated = view.i.filter((slot) => slot !== "").length;
  const prefix = view.i.slice(0, populated).every((slot) => slot !== "");
  if (prefix && populated >= 2 && populated <= REORDERABLE_I) {
    const order = profileOrder(cpsOrder, populated);
    for (const [position, from] of order.entries()) {
      const key = I_KEYS[position];
      const value = view.i[from];
      if (key && value !== undefined) next.set(key, value);
    }
  }

  for (const [key, value] of next) {
    view.awg[key] = sameType(view.awg[key], value);
    view.lastConfig[key] = sameType(view.lastConfig[key], value);
    const line = view.confLines.get(key);
    if (line) {
      view.lines[line.index] = (view.lines[line.index] ?? "").replace(
        /^(\s*[A-Za-z0-9]+\s*=\s*).*?(\s*)$/,
        (_match, head: string, tail: string) => `${head}${value}${tail}`,
      );
    }
  }
  view.lastConfig.config = view.lines.join("\n");
  view.awg.last_config = JSON.stringify(view.lastConfig, null, 2);
  return encodeVpnPayload(view.payload);
};
