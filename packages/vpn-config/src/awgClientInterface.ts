import { AWG_CLIENT_PARAMETER_NAMES, awgClientParameterScope, type AwgClientParameter } from "@amnezia/contracts";
import {
  decodeVpnLink,
  encodeVpnPayload,
  writeAwgLastConfig,
  type AmneziaContainerAwg,
  type AmneziaPayload,
  type AwgLastConfig,
} from "./codec.js";
import { locateAwgConfig } from "./awgEndpoint.js";
import { awgClientProfileV1Schema, profileOrder } from "./awgClientProfile.js";

const J_KEYS = ["Jc", "Jmin", "Jmax"] as const;
const I_KEYS = ["I1", "I2", "I3", "I4", "I5"] as const;
/** How many leading signature packets a profile may reorder. */
const REORDERABLE_I = 3;

type JKey = (typeof J_KEYS)[number];
type ConfLine = { index: number; value: string };

type Awg31InterfaceView = AwgLastConfig & {
  payload: AmneziaPayload;
  awg: AmneziaContainerAwg;
  lines: string[];
  confLines: Map<string, ConfLine>;
  interfaceEnd: number;
};

/** A config whose existing junk and signature fields can be safely reordered. */
type Awg31View = Awg31InterfaceView & {
  j: Record<JKey, number>;
  /** I1-I5 in order, "" for an empty slot. */
  i: string[];
};

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
 * Find the requested fields and the insertion point inside `[Interface]`.
 * Repeated fields make the config ambiguous.
 */
const readInterfaceLines = (
  lines: string[],
  wanted: Iterable<string>,
  exactCase: boolean,
): { fields: Map<string, ConfLine>; end: number } | null => {
  const normalize = (name: string) => exactCase ? name : name.toLowerCase();
  const interfaceName = normalize("Interface");
  const fieldNames = new Map([...wanted].map((name) => [normalize(name), name]));
  const found = new Map<string, ConfLine>();
  let section = "";
  let sawInterface = false;
  let end = lines.length;
  for (const [index, raw] of lines.entries()) {
    // CRLF configs keep their "\r"; `.` would not match it.
    const line = raw.replace(/\r$/, "");
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      if (section === interfaceName) end = index;
      section = normalize(header[1]?.trim() ?? "");
      if (section === interfaceName) {
        if (sawInterface) return null;
        sawInterface = true;
      }
      continue;
    }
    if (section !== interfaceName) continue;
    const field = /^\s*([A-Za-z0-9]+)\s*=(.*)$/.exec(line);
    const name = fieldNames.get(normalize(field?.[1] ?? ""));
    if (!name) continue;
    if (found.has(name)) return null;
    found.set(name, { index, value: (field?.[2] ?? "").trim() });
  }
  if (!sawInterface) return null;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return { fields: found, end };
};

const readAwg31Interface = (
  vpnLink: string,
  fields: Iterable<string>,
  strictClientProfile: boolean,
): Awg31InterfaceView | null => {
  let payload: AmneziaPayload;
  try {
    payload = decodeVpnLink(vpnLink);
  } catch {
    return null;
  }
  const result = locateAwgConfig(payload);
  if (result.kind !== "awg31") return null;
  const { containerIndex, lastConfig, form, lines } = result.located;
  const container = payload.containers?.[containerIndex];
  const awg = container?.awg;
  if (!awg) return null;
  if (
    strictClientProfile && (
      form === "object" ||
      typeof payload.defaultContainer !== "string" ||
      container.container !== payload.defaultContainer
    )
  ) {
    return null;
  }
  const conf = readInterfaceLines(lines, fields, strictClientProfile);
  if (!conf) return null;
  return {
    payload,
    awg,
    lastConfig,
    form: strictClientProfile ? "json-indent2" : form,
    lines,
    confLines: conf.fields,
    interfaceEnd: conf.end,
  };
};

/** Validate the three copies of the existing J and I settings for the saved overlay. */
const readAwg31 = (vpnLink: string): Awg31View | null => {
  const view = readAwg31Interface(vpnLink, [...J_KEYS, ...I_KEYS], true);
  if (!view) return null;
  const { awg, lastConfig, confLines } = view;

  const j = {} as Record<JKey, number>;
  for (const key of J_KEYS) {
    const outer = toCount(awg[key]);
    const inner = toCount(lastConfig[key]);
    const value = toCount(confLines.get(key)?.value);
    if (outer === null || outer !== inner || outer !== value) return null;
    j[key] = outer;
  }

  const i: string[] = [];
  for (const key of I_KEYS) {
    const outer = toSlot(awg[key]);
    const inner = toSlot(lastConfig[key]);
    const value = confLines.get(key)?.value ?? "";
    if (outer === null || outer !== inner || outer !== value) return null;
    i.push(outer);
  }

  return { ...view, j, i };
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

/**
 * The whitelisted client Interface parameters of an AWG 3.1 artifact, as the
 * embedded config (the copy the client runs, and the one a profile and MTU are
 * written to) carries them, in display order. A parameter the config does not
 * carry has a null value. Keys, addresses and endpoints are never read.
 * Null for an ambiguous or non-3.1 artifact. Reading does not require the
 * stricter saved-overlay layout or matching redundant JSON parameter copies.
 */
export const readAwg31ClientParameters = (vpnLink: string): AwgClientParameter[] | null => {
  const view = readAwg31Interface(vpnLink, AWG_CLIENT_PARAMETER_NAMES, false);
  if (!view) return null;
  return AWG_CLIENT_PARAMETER_NAMES.map((name) => ({
    name,
    value: view.confLines.get(name)?.value || null,
    scope: awgClientParameterScope(name),
  }));
};

export class AwgClientConfigError extends Error {}
export class AwgClientProfileError extends AwgClientConfigError {}

/** Write a value back with the type the field already had. */
const sameType = (previous: unknown, value: string): unknown =>
  typeof previous === "number" && /^\d+$/.test(value) ? Number(value) : value;

const writeAwg31Interface = (
  view: Awg31InterfaceView,
  updates: ReadonlyMap<string, string | null>,
): string => {
  const inserted: string[] = [];
  const removed = new Set<number>();
  const carriageReturn = view.lines[0]?.endsWith("\r") ? "\r" : "";
  for (const [name, value] of updates) {
    const jsonKey = name === "MTU" ? "mtu" : name;
    const line = view.confLines.get(name);
    if (value === null) {
      delete view.awg[jsonKey];
      delete view.lastConfig[jsonKey];
    } else {
      // The node emits MTU only in last_config and the embedded config.
      if (name !== "MTU" || Object.hasOwn(view.awg, jsonKey)) {
        view.awg[jsonKey] = sameType(view.awg[jsonKey], value);
      }
      view.lastConfig[jsonKey] = sameType(view.lastConfig[jsonKey], value);
    }
    if (!value) {
      if (line) removed.add(line.index);
    } else if (line) {
      view.lines[line.index] = (view.lines[line.index] ?? "").replace(
        /^([^\S\r]*[A-Za-z0-9]+[^\S\r]*=[^\S\r]*).*?(\s*)$/,
        (_match, head: string, tail: string) => `${head}${value}${tail}`,
      );
    } else {
      inserted.push(`${name} = ${value}${carriageReturn}`);
    }
  }
  const interfaceLines = view.lines.slice(0, view.interfaceEnd)
    .filter((_, index) => !removed.has(index));
  view.lastConfig.config = [...interfaceLines, ...inserted, ...view.lines.slice(view.interfaceEnd)].join("\n");
  writeAwgLastConfig(view.awg, view.form, view.lastConfig);
  return encodeVpnPayload(view.payload);
};

/** Apply client-only fields to a valid AWG 3.1 artifact. */
export const rewriteAwg31ClientInterface = (
  vpnLink: string,
  updates: ReadonlyMap<string, string | null>,
): string => {
  const view = readAwg31Interface(vpnLink, updates.keys(), false);
  if (!view) throw new AwgClientConfigError("AWG generator settings require a valid AWG 3.1 config");
  return writeAwg31Interface(view, updates);
};

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
    throw new AwgClientProfileError("The saved AWG client profile is invalid");
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

  return writeAwg31Interface(view, next);
};
