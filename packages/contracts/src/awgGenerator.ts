import { z } from "zod";

export const AWG_GENERATOR_PRESETS = [
  "issued",
  "dns_response",
  "dns_response_random_ttl",
  "randomized",
  "custom",
] as const;

export const awgGeneratorPresetSchema = z.enum(AWG_GENERATOR_PRESETS);
export type AwgGeneratorPreset = z.infer<typeof awgGeneratorPresetSchema>;

export const AWG_GENERATOR_I_MODES = [
  "issued",
  "dns_response",
  "dns_response_random_ttl",
  "dns_query",
  "noise",
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
  if (value.preset === "custom" || value.preset === "randomized") return;
  const fixed = fixedPresets[value.preset];
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
  };
  return [
    {
      id: "issued",
      description: "Keep the issued client profile and set its MTU.",
      settings: { ...fixedPresets.issued, mtu: DEFAULT_CLIENT_MTU, preset: "issued" },
    },
    {
      id: "dns_response",
      description: "Send a 44-byte DNS response with the legacy TTL before the handshake.",
      settings: { ...fixedPresets.dns_response, mtu: DEFAULT_CLIENT_MTU, preset: "dns_response" },
    },
    {
      id: "dns_response_random_ttl",
      description: "Send the DNS response with a randomized TTL before the handshake.",
      settings: { ...fixedPresets.dns_response_random_ttl, mtu: DEFAULT_CLIENT_MTU, preset: "dns_response_random_ttl" },
    },
    {
      id: "randomized",
      description: "Draw junk packet settings and shuffle DNS, STUN and noise signatures.",
      settings: {
        ...base,
        preset: "randomized",
        iMode: "dns_query",
        iCount: 3,
        contentPaddingAddition: { min: 1, max: 39 },
        timings: {
          rekeyAfterTime: { min: 95, max: 150 },
          rekeyTimeout: { min: 4, max: 8 },
          rejectAfterTime: { min: 200, max: 260 },
          keepaliveTimeout: { min: 8, max: 18 },
          maxHandshakeAttempts: { min: 12, max: 20 },
        },
      },
    },
    {
      id: "custom",
      description: "Set client MTU, junk packets, signature packets, padding and timers.",
      settings: { ...base, preset: "custom" },
    },
  ];
};
