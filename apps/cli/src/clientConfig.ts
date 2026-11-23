import {
  awgClientMtuSchema,
  awgGeneratorPresets,
  awgGeneratorSettingsSchema,
  DEVICE_TYPE_ORDER,
  setAwgClientConfigRequestSchema,
  setUserClientConfigRequestSchema,
  type AdminClientParameters,
  type AwgConfigLevel,
  type AwgDeviceRules,
  type AwgGeneratorPreset,
  type AwgGeneratorSettings,
  type CreateKeyRequest,
  type ResolvedAwgClientSettings,
  type SetAwgClientConfigRequest,
  type SetUserClientConfigRequest,
  type UpdateNodeRequest,
} from "@amnezia/contracts";
import { flagOf, parseBoolFlag, validateFlags } from "./args.js";

export const CONFIG_LEVELS = ["node", "address", "user", "key"] as const;
export type ConfigLevel = typeof CONFIG_LEVELS[number];
type RuleDevice = typeof DEVICE_TYPE_ORDER[number];
export type ConfigView = AwgConfigLevel & { awgDeviceRules?: AwgDeviceRules | null };

const presets = awgGeneratorPresets();
const acronym = /^(dns|ttl|stun|aaaa|https)$/i;
function presetLabel(id: AwgGeneratorPreset): string {
  if (id === "issued") return "As issued by the node";
  if (id === "amnezia_default") return "AmneziaVPN default";
  if (id === "no_i") return "No signature packets";
  const words = id.replace(/_full$/, "").split("_");
  const name = words.map((word, index) =>
    acronym.test(word) ? word.toUpperCase() : index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word
  ).join(" ");
  return id.endsWith("_full") ? `${name} + CPA and timings` : name;
}

export function presetRows(): Array<Record<string, string>> {
  return presets.map(({ id, description }) => ({ id, label: presetLabel(id), description }));
}

function settingsForPreset(id: string): AwgGeneratorSettings {
  const preset = presets.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown preset "${id}". Run config-presets for valid preset ids.`);
  return awgGeneratorSettingsSchema.parse(preset.settings);
}

function parseMtu(raw: string): number {
  const parsed = awgClientMtuSchema.safeParse(/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  if (!parsed.success) throw new Error("--mtu requires an integer in 1280..1420");
  return parsed.data;
}

export function keyCreationSettings(args: string[], protocol: string | undefined): Pick<CreateKeyRequest, "awgGenerator" | "awgMtu"> {
  validateFlags(args, ["preset", "mtu"], [], true);
  const preset = flagOf(args, "preset");
  const mtu = flagOf(args, "mtu");
  if ((preset !== undefined || mtu !== undefined) && protocol && protocol !== "awg3") {
    throw new Error("--preset and --mtu require an AWG 3.1 key (--protocol=awg3)");
  }
  return {
    ...(preset !== undefined ? { awgGenerator: settingsForPreset(preset) } : {}),
    ...(mtu !== undefined ? { awgMtu: parseMtu(mtu) } : {}),
  };
}

export type ConfigChange = {
  fields: SetAwgClientConfigRequest;
  settingsFile?: string;
  randomize?: boolean;
  device?: RuleDevice;
  clear: boolean;
};

export function parseConfigChange(level: ConfigLevel, args: string[]): ConfigChange {
  validateFlags(args, ["preset", "profile", "randomize", "mtu", "settings-file", "device"], ["clear"]);
  const preset = flagOf(args, "preset");
  const profile = flagOf(args, "profile");
  const randomize = flagOf(args, "randomize");
  const mtu = flagOf(args, "mtu");
  const settingsFile = flagOf(args, "settings-file");
  const deviceFlag = flagOf(args, "device");
  const clear = args.includes("--clear");
  if (deviceFlag && level !== "address" && level !== "user") {
    throw new Error("--device is only valid for address and user settings");
  }
  const device = DEVICE_TYPE_ORDER.find((type) => type === deviceFlag);
  if (deviceFlag && !device) throw new Error(`--device must be one of ${DEVICE_TYPE_ORDER.join(", ")}`);
  if (clear && !device) throw new Error("--clear requires --device");
  if (clear && [preset, profile, settingsFile, randomize, mtu].some((value) => value !== undefined)) {
    throw new Error("--clear cannot be combined with profile, randomization or MTU options");
  }
  if (preset !== undefined && profile !== undefined) {
    throw new Error("Use either --preset or --profile=inherit");
  }
  if (profile !== undefined && profile !== "inherit") throw new Error("--profile must be inherit");
  if (settingsFile !== undefined && [preset, profile, randomize].some((value) => value !== undefined)) {
    throw new Error("--settings-file cannot be combined with --preset, --profile or --randomize");
  }
  if (profile === "inherit" && randomize !== undefined) {
    throw new Error("--randomize cannot be combined with --profile=inherit");
  }
  if (!clear && [preset, profile, settingsFile, randomize, mtu].every((value) => value === undefined)) {
    throw new Error("Supply a profile, --randomize or an MTU, or use --device with --clear");
  }
  return {
    fields: {
      ...(preset !== undefined ? { awgGenerator: settingsForPreset(preset) } : {}),
      ...(profile === "inherit" ? { awgGenerator: null } : {}),
      ...(mtu !== undefined ? { awgMtu: mtu === "inherit" ? null : parseMtu(mtu) } : {}),
    },
    device,
    settingsFile,
    randomize: randomize !== undefined ? parseBoolFlag("randomize", randomize) : undefined,
    clear,
  };
}

export function parseSettingsFile(text: string): AwgGeneratorSettings {
  let input: unknown;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("--settings-file must contain valid JSON");
  }
  const settings = awgGeneratorSettingsSchema.safeParse(input);
  if (!settings.success) {
    const issue = settings.error.issues[0]!;
    throw new Error(`--settings-file: ${issue.path.join(".") || "settings"}: ${issue.message}`);
  }
  if (settings.data.preset !== "custom") throw new Error('--settings-file requires "preset": "custom"');
  return settings.data;
}

export function buildConfigFields(change: ConfigChange, current?: ConfigView): SetUserClientConfigRequest {
  if (change.device && !current) throw new Error("The current device rules must be read before updating them");
  const rules = { ...current?.awgDeviceRules };
  const rule = change.device ? rules[change.device] : undefined;
  const fields = { ...change.fields };
  if (change.randomize !== undefined) {
    const profile = fields.awgGenerator ?? (change.device ? rule?.awgGenerator : current?.awgGenerator);
    if (!profile) throw new Error("--randomize requires --preset or a profile already set at this level");
    if (profile.preset === "issued") throw new Error("--randomize requires a generated profile");
    fields.awgGenerator = { ...profile, randomizeKeys: change.randomize };
  }
  if (!change.device) return setAwgClientConfigRequestSchema.parse(fields);

  const { device } = change;
  const awgGenerator = fields.awgGenerator === undefined ? rule?.awgGenerator ?? null : fields.awgGenerator;
  const awgMtu = fields.awgMtu === undefined ? rule?.awgMtu ?? null : fields.awgMtu;
  if (change.clear || (awgGenerator === null && awgMtu === null)) {
    delete rules[device];
  } else {
    rules[device] = { awgGenerator, awgMtu };
  }
  const body = {
    awgDeviceRules: Object.keys(rules).length > 0 ? rules : null,
  };
  // Validate the replacement without normalizing untouched rules in the request.
  setUserClientConfigRequestSchema.parse(body);
  return body;
}

export type ConfigSetRequest =
  | { method: "PATCH"; path: string; body: UpdateNodeRequest }
  | { method: "POST"; path: string; body: SetUserClientConfigRequest };

export function configSetRequest(
  level: ConfigLevel,
  id: string,
  fields: SetUserClientConfigRequest,
  nodeId?: string,
): ConfigSetRequest {
  if (level === "address") {
    if (!nodeId) throw new Error("Address update requires its node id");
    return {
      method: "PATCH",
      path: `/api/admin/nodes/${nodeId}`,
      body: { publicEndpoint: { action: "update", id, ...fields } },
    };
  }
  if (level === "node") {
    return { method: "PATCH", path: `/api/admin/nodes/${id}`, body: fields };
  }
  return { method: "POST", path: `/api/admin/${level}s/${id}/set-config`, body: fields };
}

function effectiveLines(settings: Pick<AdminClientParameters["settings"], "preset" | "profileFrom" | "mtu" | "mtuFrom">): string[] {
  return [
    `Effective profile: ${settings.preset ?? "as issued"} (${settings.profileFrom ?? "node-issued config"})`,
    `Effective MTU: ${settings.mtu} (${settings.mtuFrom})`,
  ];
}

export function formatConfigShow(
  level: ConfigLevel,
  id: string,
  view: ConfigView,
  resolved?: ResolvedAwgClientSettings | null,
): string {
  const lines = [
    `${level} ${id}`,
    `Profile: ${view.awgGenerator?.preset ?? "inherit"}`,
    `MTU: ${view.awgMtu ?? "inherit"}`,
  ];
  if (view.awgGenerator) lines.push(`Profile settings: ${JSON.stringify(view.awgGenerator)}`);
  if (level === "address" || level === "user") {
    lines.push(`Device rules: ${view.awgDeviceRules && Object.keys(view.awgDeviceRules).length > 0
      ? JSON.stringify(view.awgDeviceRules, null, 2)
      : "(none)"}`);
  }
  if (resolved) {
    lines.push(...effectiveLines({
      ...resolved,
      preset: resolved.awgGenerator?.preset ?? null,
    }));
  }
  return lines.join("\n");
}

export function parameterTable(parameters: AdminClientParameters): {
  summary: string;
  rows: Array<Record<string, string>>;
} {
  const issued = new Map(parameters.issued.map(({ name, value }) => [name, value]));
  return {
    summary: effectiveLines(parameters.settings).join("\n"),
    rows: parameters.exported.map(({ name, scope, value }) => {
      const original = issued.get(name) ?? null;
      return { parameter: name, scope, exported: value ?? "-", issued: original === value ? "" : original ?? "-" };
    }),
  };
}
