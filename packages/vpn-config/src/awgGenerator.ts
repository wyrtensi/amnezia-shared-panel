import { createHash } from "node:crypto";

import {
  AWG_GENERATOR_FIXED_PRESETS,
  AWG_GENERATOR_STANDARD_J,
  awgGeneratorSettingsSchema,
  type AwgGeneratorSettings,
  type ProtocolKind,
} from "@amnezia/contracts";

import { profileOrder, profileRevision } from "./awgClientProfile.js";
import { applyAwgClientProfile, AwgClientConfigError, rewriteAwg31ClientInterface } from "./awgClientInterface.js";
import { inspectAwgVpnConfig, withAwg31TunnelMtu } from "./awgEndpoint.js";

type Seed = { keyId: string; profileRevision: number };
type Draw = (label: string, min: number, max: number) => number;

// The 44-byte DNS response used by the legacy node profile. AWG draws the
// two-byte transaction ID on each send. The variant also draws the low TTL byte.
const DNS_RESPONSE_HEAD = "858000010001000000000669636c6f756403636f6d0000010001c00c000100010000";
const DNS_RESPONSE_TAIL = "00044d583737";
const STUN_REQUEST = "<b 0x0001><b 0x000c><b 0x2112a442><r 12><b 0x8022><b 0x0008><rc 8>";

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

// QTYPE A (1), AAAA (28) or HTTPS (65), class IN.
const dnsQuery = (labelLength: number, qtype = "0001"): string =>
  `<r 2><b 0x0100><b 0x00010000><b 0x00000000><b 0x${hexByte(labelLength)}><rc ${labelLength}><b 0x03636f6d00><b 0x${qtype}><b 0x0001>`;

// Valid RFC 1035 / RFC 2181 DNS A-response: random TXID (<r 2>), random label
// length (3-12) and characters (<rc N>) under .com, compression pointer 0xc00c
// to offset 12, positive TTL in [256, 32767] with a random low byte (<r 1>)
// per handshake attempt, and a random 4-byte IPv4 answer (<r 4>).
const dnsResponseRandom = (labelLength: number, ttlHighByte: number): string =>
  `<r 2><b 0x81800001000100000000><b 0x${hexByte(labelLength)}><rc ${labelLength}><b 0x03636f6d0000010001c00c000100010000${hexByte(ttlHighByte)}><r 1><b 0x0004><r 4>`;

const noise = (length: number): string => `<r ${length}>`;
const dnsResponseRandomTtl = (ttl: number): string =>
  `<r 2><b 0x${DNS_RESPONSE_HEAD}${hexByte(ttl)}><r 1><b 0x${DNS_RESPONSE_TAIL}>`;

const signaturePackets = (
  settings: AwgGeneratorSettings,
  draw: Draw,
): string[] | null => {
  const { iMode, iCount, preset } = settings;
  if (iMode === "issued") return null;
  if (iMode === "none") return [];
  // Keep backward compatibility with earlier persisted "randomized" configs
  // that stored `iMode: "dns_query"` to request the shuffled burst.
  if (iMode === "mixed" || (preset === "randomized" && iMode === "dns_query")) {
    const templates = [dnsQuery(draw("dns-label", 3, 12)), STUN_REQUEST, noise(draw("noise", 48, 220))];
    const order = profileOrder(draw("signature-order", 0, 5), templates.length);
    return Array.from({ length: iCount }, (_, slot) =>
      templates[order[slot] ?? -1] ?? noise(draw(`noise-${slot}`, 48, 220)));
  }
  return Array.from({ length: iCount }, (_, slot) => {
    switch (iMode) {
      case "dns_response":
        return `<r 2><b 0x${DNS_RESPONSE_HEAD}105a${DNS_RESPONSE_TAIL}>`;
      case "dns_response_random_ttl":
        return dnsResponseRandomTtl(draw(`ttl-${slot}`, 15, 17));
      case "dns_response_random":
        return dnsResponseRandom(
          draw(`dns-resp-label-${slot}`, 3, 12),
          draw(`dns-resp-ttl-${slot}`, 1, 127),
        );
      case "dns_query":
        return dnsQuery(draw(`dns-label-${slot}`, 3, 12));
      case "dns_query_aaaa":
        return dnsQuery(draw(`dns-label-${slot}`, 3, 12), "001c");
      case "dns_query_https":
        return dnsQuery(draw(`dns-label-${slot}`, 3, 12), "0041");
      // Pairs alternate their two packets over the configured slots.
      case "dns_query_stun":
        return slot % 2 === 0 ? dnsQuery(draw(`dns-label-${slot}`, 3, 12)) : STUN_REQUEST;
      case "stun_dns_response":
        return slot % 2 === 0 ? STUN_REQUEST : dnsResponseRandomTtl(draw(`ttl-${slot}`, 15, 17));
      case "stun":
        return STUN_REQUEST;
      case "noise":
        return noise(draw(`noise-${slot}`, 48, 220));
    }
  });
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
  const { randomizeKeys, ...shape } = parsed.data;
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
  const draw: Draw = (label, min, max) => {
    const span = max - min + 1;
    // Start at a key- and profile-specific value and advance within the range
    // on each revision, including when the range offers only two values.
    const start = hashNumber(profileSeed, label) % span;
    return min + (start + revision % span) % span;
  };

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
