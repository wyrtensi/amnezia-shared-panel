import { createHash } from "node:crypto";

import {
  AWG_GENERATOR_FIXED_PRESETS,
  AWG_GENERATOR_STANDARD_J,
  awgGeneratorSettingsSchema,
  type AwgGeneratorSettings,
  type ProtocolKind,
} from "@amnezia/contracts";

import { profileRevision } from "./awgClientProfile.js";
import { applyAwgClientProfile, AwgClientConfigError, rewriteAwg31ClientInterface } from "./awgClientInterface.js";
import { inspectAwgVpnConfig, withAwg31TunnelMtu } from "./awgEndpoint.js";

type Seed = { keyId: string; profileRevision: number };
type Draw = (label: string, min: number, max: number) => number;

// The 44-byte DNS response used by the legacy node profile. AWG draws the
// two-byte transaction ID on each send. The variant also draws the low TTL byte.
const DNS_RESPONSE_HEAD = "858000010001000000000669636c6f756403636f6d0000010001c00c000100010000";
const DNS_RESPONSE_TAIL = "00044d583737";

const TIMING_FIELDS = {
  rekeyAfterTime: "RekeyAfterTime",
  rekeyTimeout: "RekeyTimeout",
  rejectAfterTime: "RejectAfterTime",
  keepaliveTimeout: "KeepaliveTimeout",
  maxHandshakeAttempts: "MaxHandshakeAttempts",
} as const;

const hashNumber = (seed: string, label: string): number =>
  createHash("sha256").update(JSON.stringify([seed, label])).digest().readUInt32BE();

const hexByte = (byte: number): string => byte.toString(16).padStart(2, "0");

const hex16 = (value: number): string => value.toString(16).padStart(4, "0");
const asciiHex = (text: string): string => [...text].map((char) => hexByte(char.charCodeAt(0))).join("");

// Top-level domains a query or response names; one per key and slot.
const TLDS = ["com", "net", "org", "io", "info", "ru", "de", "app", "dev", "co"] as const;
// First octets of public unicast IPv4 space (no private, loopback, shared,
// link-local, documentation, benchmarking, multicast or reserved ranges).
const PUBLIC_FIRST_OCTETS = [
  5, 23, 31, 37, 45, 46, 51, 62, 77, 78, 80, 81, 82, 85, 87, 88, 89, 91, 93, 94, 95,
  104, 109, 128, 130, 135, 141, 142, 146, 151, 152, 157, 176, 178, 185, 188, 193, 194,
  195, 212, 213, 217,
] as const;
// EDNS0 UDP payload sizes resolvers commonly advertise.
const EDNS_UDP_SIZES = [512, 1232, 1400, 4096] as const;

/**
 * A query name of 1-3 random labels (0-2 subdomains) under a drawn
 * top-level domain. AWG redraws the letters on every handshake; the shape
 * is the key's.
 */
const dnsName = (draw: Draw, prefix: string): string => {
  const count = draw(`${prefix}-labels`, 1, 3);
  let name = "";
  for (let index = 0; index < count; index += 1) {
    const length = index === count - 1 ? draw(`${prefix}-label-${index}`, 3, 12) : draw(`${prefix}-label-${index}`, 1, 10);
    name += `<b 0x${hexByte(length)}><rc ${length}>`;
  }
  const tld = TLDS[draw(`${prefix}-tld`, 0, TLDS.length - 1)] ?? "com";
  return `${name}<b 0x${hexByte(tld.length)}${asciiHex(tld)}00>`;
};

/** An RFC 6891 OPT record (root name, type 41, no options), or none: the key's choice. */
const ednsOpt = (draw: Draw, prefix: string): string | null => {
  if (draw(`${prefix}-edns`, 0, 1) === 0) return null;
  const size = EDNS_UDP_SIZES[draw(`${prefix}-edns-size`, 0, EDNS_UDP_SIZES.length - 1)] ?? 1232;
  const flags = draw(`${prefix}-edns-do`, 0, 1) === 1 ? "8000" : "0000";
  return `<b 0x000029${hex16(size)}0000${flags}0000>`;
};

// A valid RFC 1035 query, class IN, QTYPE A (1), AAAA (28) or HTTPS (65).
const dnsQuery = (draw: Draw, prefix: string, qtype = "0001"): string => {
  const opt = ednsOpt(draw, prefix);
  return `<r 2><b 0x010000010000000000${opt ? "01" : "00"}>${dnsName(draw, prefix)}<b 0x${qtype}0001>${opt ?? ""}`;
};

// A valid RFC 1035 / 2181 A response: the same name rules, a 0xc00c pointer
// to the question, a positive TTL in [256, 32767] with a low byte AWG draws
// per handshake, and an IPv4 answer under a public first octet.
const dnsResponseRandom = (draw: Draw, prefix: string): string => {
  const opt = ednsOpt(draw, prefix);
  const ttlHigh = draw(`${prefix}-ttl`, 1, 127);
  const octet = PUBLIC_FIRST_OCTETS[draw(`${prefix}-octet`, 0, PUBLIC_FIRST_OCTETS.length - 1)] ?? 85;
  return `<r 2><b 0x818000010001000000${opt ? "01" : "00"}>${dnsName(draw, prefix)}<b 0x00010001>` +
    `<b 0xc00c000100010000${hexByte(ttlHigh)}><r 1><b 0x0004${hexByte(octet)}><r 3>${opt ?? ""}`;
};

/**
 * A valid RFC 5389 Binding Request of 20-44 bytes: no attributes, or a
 * SOFTWARE of 4-16 letters, CHANGE-REQUEST, PRIORITY and ICE-CONTROLLING in
 * combinations that fit. No FINGERPRINT: it is a CRC over the transaction ID
 * AWG redraws on every handshake, so it could never be right.
 */
const stunRequest = (draw: Draw, prefix: string): string => {
  const attributes: string[] = [];
  let length = 0;
  const software = [0, 4, 8, 12, 16][draw(`${prefix}-software`, 0, 4)] ?? 0;
  if (software > 0) {
    attributes.push(`<b 0x8022${hex16(software)}><rc ${software}>`);
    length += 4 + software;
  }
  const extras = [
    { size: 8, template: `<b 0x00030004000000${["00", "02", "04", "06"][draw(`${prefix}-change`, 0, 3)] ?? "00"}>` },
    { size: 8, template: "<b 0x00240004><r 4>" },
    { size: 12, template: "<b 0x802a0008><r 8>" },
  ];
  extras.forEach((extra, index) => {
    if (draw(`${prefix}-attribute-${index}`, 0, 1) === 1 && length + extra.size <= 24) {
      attributes.push(extra.template);
      length += extra.size;
    }
  });
  return `<b 0x0001${hex16(length)}2112a442><r 12>${attributes.join("")}`;
};

const noise = (length: number): string => `<r ${length}>`;
// The legacy fixed DNS response, kept only by the presets named after it.
const dnsResponseRandomTtl = (ttl: number): string =>
  `<r 2><b 0x${DNS_RESPONSE_HEAD}${hexByte(ttl)}><r 1><b 0x${DNS_RESPONSE_TAIL}>`;

const signaturePackets = (
  settings: AwgGeneratorSettings,
  draw: Draw,
): string[] | null => {
  const { iMode, iCount } = settings;
  if (iMode === "issued") return null;
  if (iMode === "none") return [];
  if (iMode === "mixed") {
    return mixedPackets(draw, iCount, "mix");
  }
  return Array.from({ length: iCount }, (_, slot) => {
    switch (iMode) {
      case "dns_response":
        return `<r 2><b 0x${DNS_RESPONSE_HEAD}105a${DNS_RESPONSE_TAIL}>`;
      case "dns_response_random_ttl":
        return dnsResponseRandomTtl(draw(`ttl-${slot}`, 15, 17));
      case "dns_response_random":
        return dnsResponseRandom(draw, `dns-response-${slot}`);
      case "dns_query":
        return dnsQuery(draw, `dns-${slot}`);
      case "dns_query_aaaa":
        return dnsQuery(draw, `dns-${slot}`, "001c");
      case "dns_query_https":
        return dnsQuery(draw, `dns-${slot}`, "0041");
      // Pairs alternate their two packets over the configured slots.
      case "dns_query_stun":
        return slot % 2 === 0 ? dnsQuery(draw, `dns-${slot}`) : stunRequest(draw, `stun-${slot}`);
      case "stun_dns_response":
        return slot % 2 === 0 ? stunRequest(draw, `stun-${slot}`) : dnsResponseRandom(draw, `dns-response-${slot}`);
      case "stun":
        return stunRequest(draw, `stun-${slot}`);
      case "noise":
        return noise(draw(`noise-${slot}`, 48, 220));
    }
  });
};

/**
 * DNS query, STUN request, random DNS response and noise in a per-key order;
 * the first `count` of them, then more noise if more slots are asked for.
 */
const mixedPackets = (draw: Draw, count: number, prefix: string): string[] => {
  const templates = [
    dnsQuery(draw, `${prefix}-dns`),
    stunRequest(draw, `${prefix}-stun`),
    noise(draw(`${prefix}-noise`, 48, 220)),
    dnsResponseRandom(draw, `${prefix}-dns-response`),
  ];
  for (let index = templates.length - 1; index > 0; index -= 1) {
    const other = draw(`${prefix}-order-${index}`, 0, index);
    [templates[index], templates[other]] = [templates[other] as string, templates[index] as string];
  }
  return Array.from({ length: count }, (_, slot) => templates[slot] ?? noise(draw(`${prefix}-noise-${slot}`, 48, 220)));
};

const formatRange = (range: { min: number; max: number } | null): string | null =>
  range && range.max > 0 ? `${range.min}-${range.max}` : null;

/**
 * Project a saved generator profile onto an already issued client artifact.
 * `mtu` is the MTU resolved apart from the profile; without it the profile's
 * stored MTU applies. The draws never depend on it.
 */
export const applyAwgGeneratorSettings = (
  vpnLink: string,
  settings: unknown,
  seed: Seed,
  mtu?: number,
): string => {
  const parsed = awgGeneratorSettingsSchema.safeParse(settings);
  if (!parsed.success) throw new AwgClientConfigError("The saved AWG generator settings are invalid");

  // The switch is not part of the seed: settings saved before it and the
  // same settings with it on draw exactly the same values.
  const { randomizeKeys, ...stored } = parsed.data;
  // Older randomized settings stored `iMode: "dns_query"` for the mixed burst;
  // they draw exactly what "mixed" draws.
  const shape = stored.preset === "randomized" && stored.iMode === "dns_query"
    ? { ...stored, iMode: "mixed" as const }
    : stored;
  const updates = new Map<string, string | null>();
  if (shape.preset === "issued") {
    return withAwg31TunnelMtu(rewriteAwg31ClientInterface(vpnLink, updates), mtu ?? shape.mtu);
  }

  // On: a fixed preset keeps its packets and widens J so keys differ.
  const profile = randomizeKeys === true && AWG_GENERATOR_FIXED_PRESETS.includes(shape.preset)
    ? { ...shape, ...AWG_GENERATOR_STANDARD_J }
    : shape;
  // Off: one draw for every key of the node or address, unmoved by refreshes.
  const shared = randomizeKeys === false;
  const profileSeed = JSON.stringify(shared ? ["shared", shape] : [seed.keyId, shape]);
  const revision = shared ? 0 : seed.profileRevision;
  // Every value is drawn on its own from the key, the settings and the
  // revision, so a refresh redraws each one independently instead of moving
  // them all by one. A refresh that happens to draw the same config moves on
  // to the next revision (defaultService.nextClientProfile).
  const draw: Draw = (label, min, max) =>
    min + hashNumber(JSON.stringify([profileSeed, revision]), label) % (max - min + 1);

  const jmin = draw("jmin", profile.jminMin, profile.jminMax);
  updates.set("Jc", String(draw("jc", profile.jcMin, profile.jcMax)));
  updates.set("Jmin", String(jmin));
  updates.set("Jmax", String(jmin + draw("jmax-gap", profile.jmaxGapMin, profile.jmaxGapMax)));

  const slots = signaturePackets(profile, draw);
  if (slots) {
    for (let index = 0; index < 5; index += 1) {
      updates.set(`I${index + 1}`, slots[index] ?? "");
    }
  }

  updates.set("ContentPaddingAddition", formatRange(profile.contentPaddingAddition));
  for (const key of Object.keys(TIMING_FIELDS) as (keyof typeof TIMING_FIELDS)[]) {
    updates.set(TIMING_FIELDS[key], formatRange(profile.timings?.[key] ?? null));
  }
  return withAwg31TunnelMtu(rewriteAwg31ClientInterface(vpnLink, updates), mtu ?? profile.mtu);
};

/** Apply the effective AWG settings shared by exports and synthetic probe peers. */
export const projectAwgClientConfig = (
  vpnLink: string,
  options: {
    protocol: ProtocolKind;
    keyId: string;
    clientProfile: unknown;
    generator: AwgGeneratorSettings | null | undefined;
    /** The resolved client MTU (`resolveAwgClientSettings`); 1280 when absent and no profile. */
    mtu?: number;
  },
): string => {
  const { protocol, keyId, clientProfile, generator, mtu } = options;
  if (protocol !== "awg3") return vpnLink;
  const profiled = clientProfile == null ? vpnLink : applyAwgClientProfile(vpnLink, clientProfile);
  return generator && inspectAwgVpnConfig(profiled) === "awg31"
    ? applyAwgGeneratorSettings(profiled, generator, { keyId, profileRevision: profileRevision(clientProfile) }, mtu)
    : withAwg31TunnelMtu(profiled, mtu);
};
