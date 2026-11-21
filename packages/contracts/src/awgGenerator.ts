import { z } from "zod";

export const AWG_GENERATOR_PRESETS = [
  "issued",
  "dns_response",
  "dns_response_random_ttl",
  "dns_response_randomized",
  "dns_query",
  "stun",
  "no_i",
  "randomized",
  "amnezia_default",
  "dns_query_aaaa",
  "dns_query_aaaa_full",
  "dns_query_https",
  "dns_query_https_full",
  "dns_query_burst",
  "dns_query_burst_full",
  "dns_query_stun",
  "dns_query_stun_full",
  "stun_dns_response",
  "stun_dns_response_full",
  "noise",
  "noise_full",
  "custom",
] as const;

export const awgGeneratorPresetSchema = z.enum(AWG_GENERATOR_PRESETS);
export type AwgGeneratorPreset = z.infer<typeof awgGeneratorPresetSchema>;

export const AWG_GENERATOR_I_MODES = [
  "issued",
  "dns_response",
  "dns_response_random_ttl",
  "dns_response_random",
  "dns_query",
  "dns_query_aaaa",
  "dns_query_https",
  "dns_query_stun",
  "stun_dns_response",
  "stun",
  "mixed",
  "noise",
  "none",
] as const;

const DEFAULT_CLIENT_MTU = 1280;
const defaultParameters = {
  jcMin: 3,
  jcMax: 10,
  jminMin: 40,
  jminMax: 100,
  jmaxGapMin: 30,
  jmaxGapMax: 200,
  iMode: "issued",
  iCount: 1,
  contentPaddingAddition: null,
  timings: null,
} as const;
/**
 * The junk-packet ranges of the presets that draw J, and the ranges a fixed
 * preset widens to when every key draws its own values.
 */
export const AWG_GENERATOR_STANDARD_J = {
  jcMin: defaultParameters.jcMin,
  jcMax: defaultParameters.jcMax,
  jminMin: defaultParameters.jminMin,
  jminMax: defaultParameters.jminMax,
  jmaxGapMin: defaultParameters.jmaxGapMin,
  jmaxGapMax: defaultParameters.jmaxGapMax,
} as const;

const dnsParameters = {
  ...defaultParameters,
  jcMin: 4,
  jcMax: 4,
  jminMax: 40,
  jmaxGapMax: 30,
} as const;
const fixedPresets = {
  issued: defaultParameters,
  dns_response: { ...dnsParameters, iMode: "dns_response" },
  dns_response_random_ttl: { ...dnsParameters, iMode: "dns_response_random_ttl" },
} as const;

/** Presets whose J and signature fields cannot be edited without Custom. */
export const AWG_GENERATOR_FIXED_PRESETS: readonly AwgGeneratorPreset[] = Object.keys(fixedPresets) as AwgGeneratorPreset[];

const integer = (min: number, max: number) => z.number().int().min(min).max(max);

const range = (min: number, max: number) => z
  .strictObject({ min: integer(min, max), max: integer(min, max) })
  .refine((value) => value.min <= value.max, {
    message: "The upper bound must be at least the lower bound",
    path: ["max"],
  });

const timingRange = range(1, 65_535);

const timingsSchema = z.strictObject({
  rekeyAfterTime: timingRange,
  rekeyTimeout: timingRange,
  rejectAfterTime: range(180, 65_535),
  keepaliveTimeout: timingRange,
  maxHandshakeAttempts: timingRange,
}).refine((value) => value.rejectAfterTime.min > value.rekeyAfterTime.max, {
  message: "RejectAfterTime must exceed RekeyAfterTime",
  path: ["rejectAfterTime", "min"],
}).refine((value) => value.rejectAfterTime.min > value.keepaliveTimeout.max + value.rekeyTimeout.max, {
  message: "RejectAfterTime must exceed KeepaliveTimeout plus RekeyTimeout",
  path: ["rejectAfterTime", "min"],
});

export const awgGeneratorSettingsSchema = z.strictObject({
  preset: awgGeneratorPresetSchema,
  mtu: integer(1280, 1420).default(DEFAULT_CLIENT_MTU),
  jcMin: integer(0, 16),
  jcMax: integer(0, 16),
  jminMin: integer(1, 500),
  jminMax: integer(1, 500),
  jmaxGapMin: integer(1, 500),
  jmaxGapMax: integer(1, 500),
  iMode: z.enum(AWG_GENERATOR_I_MODES).default(defaultParameters.iMode),
  iCount: integer(1, 5).default(defaultParameters.iCount),
  contentPaddingAddition: range(0, 100).nullable().default(null),
  timings: timingsSchema.nullable().default(null),
  // On: every key draws its own values in the preset's style. Off: every key
  // of the node or address gets the same set. Absent (settings saved before
  // the switch): ranges are drawn per key and fixed presets stay fixed.
  randomizeKeys: z.boolean().optional(),
}).refine((value) => !(value.preset === "custom" && value.randomizeKeys === true), {
  message: "The custom preset gives every key the same values",
  path: ["randomizeKeys"],
}).refine((value) => value.jcMin <= value.jcMax, {
  message: "Jc maximum must be at least Jc minimum",
  path: ["jcMax"],
}).refine((value) => value.jminMin <= value.jminMax, {
  message: "Jmin maximum must be at least Jmin minimum",
  path: ["jminMax"],
}).refine((value) => value.jmaxGapMin <= value.jmaxGapMax, {
  message: "Jmax gap maximum must be at least its minimum",
  path: ["jmaxGapMax"],
}).superRefine((value, context) => {
  if (!(value.preset in fixedPresets)) return;
  const fixed = fixedPresets[value.preset as keyof typeof fixedPresets];
  const fields = Object.keys(fixed) as Array<keyof typeof fixed>;
  for (const field of fields) {
    if (value[field] !== fixed[field]) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Select the custom preset to change this setting",
      });
    }
  }
});

export type AwgGeneratorSettings = z.infer<typeof awgGeneratorSettingsSchema>;

export const nodeGeneratorMetadataSchema = z.object({
  awgGenerator: awgGeneratorSettingsSchema.nullish(),
});
export type NodeGeneratorMetadata = z.infer<typeof nodeGeneratorMetadataSchema>;

export const adminKeyConfigMetadataSchema = z.object({
  createdAt: z.iso.datetime(),
  configUpdatedAt: z.iso.datetime().nullable(),
});
export type AdminKeyConfigMetadata = z.infer<typeof adminKeyConfigMetadataSchema>;

export type AwgGeneratorPresetDescription = {
  id: AwgGeneratorPreset;
  description: string;
  settings: AwgGeneratorSettings;
};

export const awgGeneratorPresets = (): AwgGeneratorPresetDescription[] => {
  const base = {
    ...defaultParameters,
    mtu: DEFAULT_CLIENT_MTU,
    randomizeKeys: true,
  };
  // CPA and Interface timing ranges of the "randomized" geometry, shared by
  // every "full" preset.
  const full = {
    contentPaddingAddition: { min: 1, max: 39 },
    timings: {
      rekeyAfterTime: { min: 95, max: 150 },
      rekeyTimeout: { min: 4, max: 8 },
      rejectAfterTime: { min: 200, max: 260 },
      keepaliveTimeout: { min: 8, max: 18 },
      maxHandshakeAttempts: { min: 12, max: 20 },
    },
  };
  // One signature shape in two levels: J ranges only, and J + CPA + timings.
  const pair = (
    id: AwgGeneratorPreset,
    iMode: AwgGeneratorSettings["iMode"],
    iCount: number,
    shape: string,
  ): AwgGeneratorPresetDescription[] => [
    {
      id,
      description: `${shape} before the handshake with randomized J ranges, without CPA or custom timers.`,
      settings: { ...base, preset: id, iMode, iCount },
    },
    {
      id: `${id}_full` as AwgGeneratorPreset,
      description: `${shape} before the handshake with randomized J ranges, CPA 1-39 and Interface timing ranges.`,
      settings: { ...base, ...full, preset: `${id}_full` as AwgGeneratorPreset, iMode, iCount },
    },
  ];
  return [
    {
      id: "issued",
      description: "Keep the issued client profile and set its MTU.",
      settings: { ...fixedPresets.issued, mtu: DEFAULT_CLIENT_MTU, preset: "issued" },
    },
    {
      id: "dns_response",
      description: "Send a 44-byte DNS response with the legacy TTL before the handshake.",
      settings: { ...fixedPresets.dns_response, mtu: DEFAULT_CLIENT_MTU, randomizeKeys: true, preset: "dns_response" },
    },
    {
      id: "dns_response_random_ttl",
      description: "Send the DNS response with a randomized TTL before the handshake.",
      settings: { ...fixedPresets.dns_response_random_ttl, mtu: DEFAULT_CLIENT_MTU, randomizeKeys: true, preset: "dns_response_random_ttl" },
    },
    {
      id: "dns_response_randomized",
      description: "Send a valid DNS A-response with randomized domain, TTL window, IPv4 answer and J ranges, without CPA or custom timers.",
      settings: {
        ...base,
        preset: "dns_response_randomized",
        iMode: "dns_response_random",
        iCount: 1,
      },
    },
    {
      id: "dns_query",
      description: "Send a single randomized DNS A-query before the handshake, without CPA or custom timers.",
      settings: {
        ...base,
        preset: "dns_query",
        iMode: "dns_query",
        iCount: 1,
      },
    },
    {
      id: "stun",
      description: "Send a single 32-byte STUN Binding Request before the handshake, without CPA or custom timers.",
      settings: {
        ...base,
        preset: "stun",
        iMode: "stun",
        iCount: 1,
      },
    },
    {
      id: "no_i",
      description: "Omit I1-I5 signature packets and send only randomized J junk packets, without CPA or custom timers.",
      settings: {
        ...base,
        preset: "no_i",
        iMode: "none",
        iCount: 1,
      },
    },
    {
      id: "randomized",
      description: "Node geometry profile: randomized J ranges, shuffled DNS/STUN/noise burst, CPA 1-39 and Interface timing ranges.",
      settings: {
        ...base,
        ...full,
        preset: "randomized",
        iMode: "mixed",
        iCount: 3,
      },
    },
    {
      id: "amnezia_default",
      description: "Stock AmneziaVPN 5 profile: J 4-6 / 10 / 50, DNS response with random TTL, CPA 10-100 and timing ranges.",
      settings: {
        ...base,
        preset: "amnezia_default",
        jcMin: 4,
        jcMax: 6,
        jminMin: 10,
        jminMax: 10,
        jmaxGapMin: 40,
        jmaxGapMax: 40,
        iMode: "dns_response_random_ttl",
        iCount: 1,
        contentPaddingAddition: { min: 10, max: 100 },
        timings: {
          rekeyAfterTime: { min: 100, max: 120 },
          rekeyTimeout: { min: 3, max: 7 },
          rejectAfterTime: { min: 180, max: 210 },
          keepaliveTimeout: { min: 5, max: 15 },
          maxHandshakeAttempts: { min: 15, max: 20 },
        },
      },
    },
    ...pair("dns_query_aaaa", "dns_query_aaaa", 1, "Send a randomized DNS AAAA query"),
    ...pair("dns_query_https", "dns_query_https", 1, "Send a randomized DNS HTTPS (type 65) query"),
    ...pair("dns_query_burst", "dns_query", 3, "Send three randomized DNS A queries"),
    ...pair("dns_query_stun", "dns_query_stun", 2, "Send a randomized DNS A query and a STUN Binding Request"),
    ...pair("stun_dns_response", "stun_dns_response", 2, "Send a STUN Binding Request and a DNS response with a random TTL"),
    ...pair("noise", "noise", 3, "Send three random-length noise packets"),
    {
      id: "custom",
      description: "Set client MTU, junk packets, signature packets, padding and timers.",
      settings: { ...base, preset: "custom", randomizeKeys: false },
    },
  ];
};
